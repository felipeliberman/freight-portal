// The invoice LINK store — spec §8.878 (the identifier decision), §8.879.
//
// The token SELECTS an invoice. The portal SESSION authorises. A link on its own grants nothing
// beyond the possession tier, which is why it never needs to expire: TTL is not a security
// parameter here, and AR runs long enough that a link dying at 30 days would generate support calls
// rather than protect anything.
//
// SEPARATE DATABASE (schema-links.sql), read by the public Worker. Written only by this module, in
// invoice-sync. See that file for why the boundary is a boundary and not a convenience.

import { normalizeArCode, allowlistPredicate, isAllowlisted } from './arcode.js';

/**
 * 128 bits of CSPRNG output as 22 URL-safe characters.
 *
 * `crypto.getRandomValues` — the Web Crypto CSPRNG, present in Workers and in Node ≥19. **NAMED
 * DELIBERATELY**: "random" is the word that hides the difference between a CSPRNG and `Math.random`,
 * and a token minted from the latter is guessable by anyone who can watch a few issue.
 *
 * 128 bits is chosen so enumeration is not a threat model at all, rather than being merely
 * impractical — and 22 characters survives every mail client's line-wrapping intact.
 */
export function newToken() {
  const bytes = new Uint8Array(16);                    // 16 × 8 = 128 bits
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Exactly the possession tier (§8.878). Any read that widens this widens the unauthenticated tier. */
export const POSSESSION_FIELDS = Object.freeze([
  'token', 'primus_invoice_id', 'ar_code',
  'invoice_number', 'issue_date', 'due_date', 'total_cents', 'bol_number',
]);

/**
 * Resolve a token to the POSSESSION TIER. STANDALONE on purpose.
 *
 * The public Worker imports THIS and not the class, so the bundle it serves from a public route
 * contains no mint and no revoke — no write path at all. Minimal surface is not a slogan here: the
 * less code answering strangers, the less there is to be wrong about.
 *
 * Returns null for a REVOKED token and for an UNKNOWN one — deliberately the SAME answer, so the
 * caller cannot become an oracle for which tokens exist (§5.8: "not found" and "not yours" are one
 * message). A later change that distinguishes them will look like a kindness and is not one.
 */
export async function resolveToken(db, mode, token, allowlist) {
  if (!token) return null;
  // BELT AND BRACES. The mint refusing is the PRIMARY control; this is the second one, and it
  // covers the case the mint guard structurally cannot: a row that is ALREADY THERE. A backup
  // restored from before the bound narrowed, a manual insert, a future writer that forgets — none
  // of those pass through mint(), and all of them would otherwise be served to anyone with the URL.
  //
  // The bound is welded into the WHERE rather than filtered after the read, so an outside-the-bound
  // row is NOT ADDRESSABLE — not "fetched and then rejected". Same discipline as `mode`.
  //
  // It returns null, exactly as unknown and revoked do. A LOUD refusal would tell a stranger which
  // tokens exist (§5.8 — "not found" and "not yours" are one message).
  const bound = allowlistPredicate(allowlist);
  const row = await db
    .prepare(
      `SELECT ${POSSESSION_FIELDS.join(', ')} FROM invoice_link
        WHERE mode = ? AND token = ? AND revoked_at IS NULL AND ${bound.sql}`
    )
    .bind(mode, String(token), ...bound.params)
    .first();
  return row || null;
}

export class InvoiceLinks {
  /**
   * @param {D1Database} db    the LINKS database, not the ledger's
   * @param {'test'|'live'} mode  part of every key, so a test link can never satisfy a live lookup
   * @param {{all:boolean, codes:Set<string>}} allowlist  the pilot bound (§3.1), HELD HERE for the
   *   same reason `mode` is — see the note below on why this class did not have it.
   */
  constructor(db, mode, allowlist) {
    if (mode !== 'test' && mode !== 'live') {
      throw new Error(`InvoiceLinks requires an explicit mode, got ${mode}`);
    }
    // ── WHY THIS ARRIVED LATE, AND THE LARGER POINT (spec §8.882) ─────────────────────────────
    //
    // `Ledger` and `StripeCustomers` already held the bound in their constructors. This class was
    // written AFTER both and did not inherit it, because nothing made it: the rule lived in two
    // classes and in a spec paragraph, neither of which is a mechanism.
    //
    // THE ORDERING IT PRODUCED WAS BACKWARDS. Minting checked nothing, so a real customer's invoice
    // acquired a WORKING PUBLIC LINK, and the only trace of the refusal was `markLinkMinted`
    // returning false — the SAME value it returns for an already-stamped row. A boolean nobody
    // reads, and `resolveToken` served the link regardless.
    //
    // A RULE APPLIED TO TWO CLASSES IS NOT A RULE. The fourth class will need it too, so the test
    // named 'THE RULE, GENERALISED' enumerates every class holding an ARCode-scoped bound and
    // asserts each refuses to be built without one — it fails on the day the next class is added.
    if (!allowlist || typeof allowlist.all !== 'boolean' || !(allowlist.codes instanceof Set)) {
      throw new Error(
        'InvoiceLinks requires an explicit AR allowlist. It is never defaulted: an absent bound ' +
        'silently meaning "everything" is what lets a non-pilot customer acquire a public link (§3.1).'
      );
    }
    this.db = db;
    this.mode = mode;
    this.allowlist = allowlist;
  }

  /** The pilot bound as SQL, for welding into a WHERE. Mirrors Ledger.bound(). */
  bound(column = 'ar_code') { return allowlistPredicate(this.allowlist, column); }

  /**
   * Mint a link for an invoice. **IDEMPOTENT PER INVOICE.**
   *
   * A re-send must reach the SAME link. Two live links to one invoice would mean revoking a leaked
   * one still leaves the other open — so the active-unique index makes this true at the database,
   * and this method reads the existing row back rather than erroring.
   *
   * The snapshot is FROZEN at first mint. A later call with different figures — an invoice edited
   * after issuance (§4.4) — returns the ORIGINAL, because the possession page must render what the
   * customer was sent. Restating it would show them a number that never appeared in their email.
   *
   * @returns {{ok:true, token:string, created:boolean}} `created:false` means an existing link was
   *   reused, so a caller can tell the difference without a second query.
   */
  async mint({ primusInvoiceId, arCode, invoiceNumber = null, issueDate = null, dueDate = null,
               totalCents = null, bolNumber = null, now = Date.now() }) {
    if (!primusInvoiceId) throw new Error('mint() requires primusInvoiceId');
    const code = normalizeArCode(arCode);
    if (!code) throw new Error('mint() requires an arCode');

    // THE MINT REFUSES. It does not mint-then-fail-to-stamp.
    //
    // THROWS rather than returning a refusal, matching Ledger.claim: a silent refusal here would be
    // indistinguishable from "already minted", and the caller would carry on to send an email whose
    // link does not exist. The loud failure is the correct direction — this is the boundary that
    // keeps a real customer's invoice from acquiring a customer-facing link AT ALL.
    if (!isAllowlisted(this.allowlist, code)) {
      throw new Error(
        `mint() refused: ARCode ${JSON.stringify(code)} is outside AR_ALLOWLIST. A link is ` +
        `CUSTOMER-FACING and PUBLIC — minting one outside the pilot bound puts a real customer's ` +
        `invoice on the open internet (§3.1, §8.882).`
      );
    }

    const existing = await this._activeFor(primusInvoiceId);
    if (existing) return { ok: true, token: existing.token, created: false };

    const token = newToken();
    const res = await this.db
      .prepare(
        `INSERT INTO invoice_link
           (mode, token, primus_invoice_id, ar_code, invoice_number, issue_date, due_date,
            total_cents, bol_number, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`
      )
      .bind(this.mode, token, String(primusInvoiceId), code, invoiceNumber, issueDate, dueDate,
            totalCents, bolNumber, now)
      .run();

    if ((res.meta && res.meta.changes) === 1) return { ok: true, token, created: true };

    // The active-unique index refused it: another run minted between our read and our write. Read
    // the winner back rather than failing — the caller wants A link, not necessarily its own.
    const winner = await this._activeFor(primusInvoiceId);
    if (winner) return { ok: true, token: winner.token, created: false };
    throw new Error(`mint() failed for invoice ${primusInvoiceId} and no active link exists`);
  }

  /**
   * Resolve a token to the POSSESSION TIER and nothing else.
   *
   * Returns only the fields §8.878 permits without a session. A revoked or unknown token returns
   * null — the same answer, so the route cannot become an oracle for which tokens exist.
   */
  async resolve(token) {
    return resolveToken(this.db, this.mode, token, this.allowlist);
  }

  /** Kill ONE link without touching the invoice. A replacement can then be minted. */
  async revoke(token, now = Date.now()) {
    // Bound-scoped like everything else: a row outside the bound is not addressable, not merely
    // not-served. Revoking is a write, and writes are the side this bound exists to hold.
    const bound = this.bound();
    const res = await this.db
      .prepare(`UPDATE invoice_link SET revoked_at = ? WHERE mode = ? AND token = ? AND revoked_at IS NULL AND ${bound.sql}`)
      .bind(now, this.mode, String(token), ...bound.params)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  /** Diagnostic only. Nothing keys on it, and it must never gate access. */
  async touch(token, now = Date.now()) {
    const bound = this.bound();
    await this.db
      .prepare(`UPDATE invoice_link SET last_seen_at = ? WHERE mode = ? AND token = ? AND ${bound.sql}`)
      .bind(now, this.mode, String(token), ...bound.params)
      .run();
  }

  async _activeFor(primusInvoiceId) {
    // Bound-scoped for consistency. UNREACHABLE for an outside-bound code — mint() refuses before
    // this runs — but the discipline is that the bound is welded into the query, not remembered by
    // whoever calls it. That is the whole reason this class needed fixing.
    const bound = this.bound();
    return this.db
      .prepare(
        `SELECT token FROM invoice_link WHERE mode = ? AND primus_invoice_id = ? AND revoked_at IS NULL AND ${bound.sql}`
      )
      .bind(this.mode, String(primusInvoiceId), ...bound.params)
      .first();
  }
}
