// The invoice LINK store — spec §8.878 (the identifier decision), §8.879.
//
// The token SELECTS an invoice. The portal SESSION authorises. A link on its own grants nothing
// beyond the possession tier, which is why it never needs to expire: TTL is not a security
// parameter here, and AR runs long enough that a link dying at 30 days would generate support calls
// rather than protect anything.
//
// SEPARATE DATABASE (schema-links.sql), read by the public Worker. Written only by this module, in
// invoice-sync. See that file for why the boundary is a boundary and not a convenience.

import { normalizeArCode } from './arcode.js';

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
const POSSESSION_FIELDS = Object.freeze([
  'token', 'primus_invoice_id', 'ar_code',
  'invoice_number', 'issue_date', 'due_date', 'total_cents', 'bol_number',
]);

export class InvoiceLinks {
  /**
   * @param {D1Database} db    the LINKS database, not the ledger's
   * @param {'test'|'live'} mode  part of every key, so a test link can never satisfy a live lookup
   */
  constructor(db, mode) {
    if (mode !== 'test' && mode !== 'live') {
      throw new Error(`InvoiceLinks requires an explicit mode, got ${mode}`);
    }
    this.db = db;
    this.mode = mode;
  }

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
    if (!token) return null;
    const row = await this.db
      .prepare(
        `SELECT ${POSSESSION_FIELDS.join(', ')} FROM invoice_link
          WHERE mode = ? AND token = ? AND revoked_at IS NULL`
      )
      .bind(this.mode, String(token))
      .first();
    return row || null;
  }

  /** Kill ONE link without touching the invoice. A replacement can then be minted. */
  async revoke(token, now = Date.now()) {
    const res = await this.db
      .prepare('UPDATE invoice_link SET revoked_at = ? WHERE mode = ? AND token = ? AND revoked_at IS NULL')
      .bind(now, this.mode, String(token))
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  /** Diagnostic only. Nothing keys on it, and it must never gate access. */
  async touch(token, now = Date.now()) {
    await this.db
      .prepare('UPDATE invoice_link SET last_seen_at = ? WHERE mode = ? AND token = ?')
      .bind(now, this.mode, String(token))
      .run();
  }

  async _activeFor(primusInvoiceId) {
    return this.db
      .prepare(
        'SELECT token FROM invoice_link WHERE mode = ? AND primus_invoice_id = ? AND revoked_at IS NULL'
      )
      .bind(this.mode, String(primusInvoiceId))
      .first();
  }
}
