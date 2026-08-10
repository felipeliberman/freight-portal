// The idempotency spine (spec §4.2 layer 1) plus the run lease and exception queue.
//
// This is the only thing standing between a cron with a wide overlapping window and double-billing
// a real customer, so the ordering rule matters more than anything else in this file:
//
//     CLAIM THE LEDGER ROW BEFORE CALLING STRIPE. ALWAYS.
//
// A row written after a successful create leaves a window where a concurrent run sees nothing and
// creates a second invoice. A row written first is rejected by the UNIQUE constraint, and the
// worst case becomes an orphaned 'intent' row — recoverable, and visible.
//
// Stripe Search cannot substitute for this: it is index-backed with up to ~1min of lag, so a
// just-created invoice is not findable and two runs 30s apart both see "no match".

import { normalizeArCode, allowlistPredicate, isAllowlisted } from './arcode.js';
import { REFUSAL_REASONS, refuse, allow } from './refusals.js';

/** Marks exception rows that are a DATA GAP in one record, not an operational failure. */
export const QUARANTINE_PREFIX = 'quarantine:';

/** Mode-namespaced idempotency key for the Stripe create (spec §4.2 layer 2). */
export function idempotencyKey(mode, primusInvoiceId, version) {
  return `${mode}-primus-inv-${primusInvoiceId}-v${version}`;
}

/**
 * Every legal `stripe_state`. ONE list, imported rather than remembered.
 *
 * `stripe_state` is free-text TEXT with no CHECK constraint (and SQLite cannot add one to an
 * existing table without a full rebuild), so a typo writes silently — and a typo'd state matches
 * NO reader predicate. It is invisible to openForReconcile, invisible to resolveClaimedCustomers,
 * and swept in by siblingsOfBol: a row that stalls forever with nothing reporting it.
 *
 * So the validation lives at the two PARAMETERISED writers. The literal writers (claim → 'intent',
 * recordFailure → 'failed', supersede → 'void') cannot be wrong and need nothing.
 *
 * 'creating' lands here with markCreating() below — the change that introduces it, per the rule
 * that this file must never run ahead of the code.
 */
export const STRIPE_STATES = Object.freeze([
  'intent', 'creating', 'draft', 'finalized', 'void', 'paid', 'uncollectible', 'failed',
]);

/** Throws rather than returning false: an unknown state is a programming error, not a data condition. */
function assertState(state) {
  if (!STRIPE_STATES.includes(state)) {
    throw new Error(
      `Unknown stripe_state ${JSON.stringify(state)} — expected one of ${STRIPE_STATES.join(', ')}. ` +
      `A misspelt state is written silently and then matches no reader, so this fails closed.`
    );
  }
  return state;
}

export class Ledger {
  /**
   * @param {D1Database} db
   * @param {'test'|'live'} mode  included in every key so test rows can never suppress a live create
   * @param {{all:boolean, codes:Set<string>}} allowlist  the pilot bound (spec §3.1), HELD HERE
   *   rather than remembered at each call site — for the same reason `mode` is. See
   *   allowlistPredicate() in arcode.js.
   */
  constructor(db, mode, allowlist) {
    if (mode !== 'test' && mode !== 'live') throw new Error(`Ledger requires an explicit mode, got ${mode}`);
    if (!allowlist || typeof allowlist.all !== 'boolean' || !(allowlist.codes instanceof Set)) {
      throw new Error(
        'Ledger requires an explicit AR allowlist. It is never defaulted: an absent bound silently ' +
        'meaning "everything" is precisely the misconfiguration that would blast the full book (§3.1).'
      );
    }
    this.db = db;
    this.mode = mode;
    this.allowlist = allowlist;
  }

  /**
   * The pilot bound as SQL, for welding into a WHERE clause.
   *
   * PUBLIC on purpose. resolveClaimedCustomers (customers.js) builds its own SQL and needs the same
   * bound; an underscore here would be a private name already crossing a module boundary — a public
   * contract lying about its status, which invites the next caller to duplicate it or reach past it.
   */
  bound(column = 'ar_code') { return allowlistPredicate(this.allowlist, column); }

  // ── claim ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Claim an invoice for materialization. Call this BEFORE touching Stripe.
   *
   * @returns {{claimed:boolean, row:object}} claimed=false means another run (or an earlier run)
   *   already owns this (invoice, version); `row` is the existing record. Not an error — the whole
   *   point of the overlapping window is that re-seeing an invoice is free.
   */
  async claim({ primusInvoiceId, primusInvoiceNumber = null, bolNumber = null, arCode = null, customerReference = null, version = 1, totalCents = null, issueDate = null, invoiceDueDate = null }) {
    if (!primusInvoiceId) throw new Error('claim() requires primusInvoiceId');
    // THROWS rather than returning claimed:false. A silent refusal here would be indistinguishable
    // from "already claimed", and the invoice would be suppressed forever with no signal — the
    // exact never-billed failure §3.1's ordering rule exists to prevent.
    if (!isAllowlisted(this.allowlist, arCode)) {
      throw new Error(
        `claim() refused: ARCode ${JSON.stringify(arCode)} is outside AR_ALLOWLIST. The poll filters ` +
        `before claiming (§3.1), so reaching here means a caller skipped the bound.`
      );
    }
    const now = Date.now();
    const key = idempotencyKey(this.mode, primusInvoiceId, version);

    // Stored in the CANONICAL form, because `ar_code` is a join key: stripe_customer is keyed on
    // (mode, ar_code) and there is no denormalised copy here, so the two columns must agree
    // character for character or the join silently misses (spec §4b). A blank normalises to NULL
    // rather than '' — an empty ARCode is not an ARCode, and '' would land it in
    // resolveClaimedCustomers' `ar_code IS NOT NULL` sweep, where it does not belong.
    const arCodeStored = arCode === null || arCode === undefined ? null : (normalizeArCode(arCode) || null);

    const res = await this.db
      .prepare(
        `INSERT INTO ledger
           (mode, primus_invoice_id, primus_invoice_number, bol_number, ar_code, customer_reference,
            issue_date, invoice_due_date,
            version, stripe_state, total_cents, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?, ?, ?)
         ON CONFLICT (mode, primus_invoice_id, version) DO NOTHING`
      )
      .bind(this.mode, String(primusInvoiceId), primusInvoiceNumber, bolNumber, arCodeStored, customerReference,
            issueDate, invoiceDueDate,
            version, totalCents, key, now, now)
      .run();

    const inserted = (res.meta && res.meta.changes) === 1;
    const row = await this.get(primusInvoiceId, version);
    return { claimed: inserted, row };
  }

  async get(primusInvoiceId, version = 1) {
    return this.db
      .prepare('SELECT * FROM ledger WHERE mode = ? AND primus_invoice_id = ? AND version = ?')
      .bind(this.mode, String(primusInvoiceId), version)
      .first();
  }

  /** Every version of one Primus invoice, oldest first. */
  async versionsOf(primusInvoiceId) {
    const { results } = await this.db
      .prepare('SELECT * FROM ledger WHERE mode = ? AND primus_invoice_id = ? ORDER BY version ASC')
      .bind(this.mode, String(primusInvoiceId))
      .all();
    return results || [];
  }

  /**
   * Everything already materialized against a BOL — the layer-3 guard (spec §4.2).
   *
   * This is the only defense against a Primus reissue that changes BOTH invoiceId and
   * invoiceNumber, where the ledger key and the Stripe idempotency key both miss. A hit does not
   * block; it forces explicit classification instead of a silent create.
   *
   * ── DELIBERATELY NOT ALLOWLIST-FILTERED. Do not "fix" this. ─────────────────────────────────
   * Every other query on this class carries the pilot bound. This one must not: it is a READ whose
   * only job is to force explicit classification, and a BOL collision can span an allowlisted and a
   * NON-allowlisted customer. Filtering would hide exactly that collision — narrowing a safety read
   * makes it blinder, and the caller would then create silently where it should have held.
   * The bound limits what we WRITE. It must not limit what we can SEE before writing.
   */
  async siblingsOfBol(bolNumber) {
    if (!bolNumber) return [];
    const { results } = await this.db
      .prepare(
        `SELECT * FROM ledger
          WHERE mode = ? AND bol_number = ? AND stripe_state NOT IN ('void', 'failed')
          ORDER BY created_at ASC`
      )
      .bind(this.mode, String(bolNumber))
      .all();
    return results || [];
  }

  /**
   * Rows the reconcile pass still has to chase (spec §3 pass 2).
   *
   * 'creating' is NOT here, and that exclusion is deliberate rather than an oversight: reconcile
   * asks "has this invoice been paid", which is meaningless for a row whose invoice may not exist.
   * Orphan candidates are a DIFFERENT question with a different answer, and they have their own
   * sweep — openCreating(). If 'creating' were added here it would be swept by the wrong logic and
   * silently marked as needing nothing.
   */
  async openForReconcile(limit = 200) {
    const bound = this.bound();
    const { results } = await this.db
      .prepare(
        // Deliberately includes 'draft' and 'uncollectible', not just 'finalized'. Sweeping only
        // open invoices silently strands everything in the other states.
        `SELECT * FROM ledger
          WHERE mode = ? AND stripe_state IN ('draft', 'finalized', 'uncollectible')
            AND ${bound.sql}
          ORDER BY updated_at ASC LIMIT ?`
      )
      .bind(this.mode, ...bound.params, limit)
      .all();
    return results || [];
  }

  /**
   * Rows stuck in `creating` — the orphan candidates openForReconcile deliberately excludes.
   *
   * `staleMs` keeps this from fighting a run still in progress: a row that entered `creating`
   * seconds ago probably belongs to a live invocation, one older than the lease TTL cannot. The
   * default is deliberately LONGER than LEASE_TTL_MS (10 min) — sweeping a row out from under a
   * running create is how a second create happens, which is the failure the ledger exists to stop.
   *
   * This returns CANDIDATES ONLY. Resolving them means reading Stripe (list, never search — §4.1),
   * and that half lands with the Stripe client.
   */
  async openCreating({ staleMs = 15 * 60 * 1000, now = Date.now(), limit = 100 } = {}) {
    const bound = this.bound();
    const { results } = await this.db
      .prepare(
        `SELECT * FROM ledger
          WHERE mode = ? AND stripe_state = 'creating' AND updated_at <= ?
            AND ${bound.sql}
          ORDER BY updated_at ASC LIMIT ?`
      )
      .bind(this.mode, now - staleMs, ...bound.params, limit)
      .all();
    return results || [];
  }

  // ── transitions ────────────────────────────────────────────────────────────────────────────

  /**
   * Attach the Stripe invoice to a claimed row once the create returns.
   *
   * WRITE-ONCE PER ID. The row accepts an id only when it holds none, or when it already holds the
   * SAME one. Before this guard the UPDATE was unconditional, so a retry after a lost ledger write
   * — or a second create — silently replaced the id, and the FIRST Stripe invoice became an object
   * no ledger row referenced. That is the orphan this whole mechanism exists to prevent,
   * manufactured by the code meant to record ids.
   *
   * Re-attaching the SAME id succeeds: a benign retry is not a conflict. A re-run that re-attaches
   * what it already attached must not start reporting failures on correct work.
   *
   * @returns {{ok:true}} on success, or a refusal:
   *   `already_materialized`         this row already carries a DIFFERENT id
   *   `invoice_id_already_claimed`   a DIFFERENT ROW already holds this id (control 6)
   *
   * The SAME mechanism as StripeCustomers.attach(), not merely the same vocabulary: two sibling
   * tables handling an identical condition by opposite philosophies would mean a caller cannot
   * learn one convention and rely on it.
   */
  async attachStripeInvoice(ledgerId, stripeInvoiceId, state = 'draft') {
    assertState(state);
    const bound = this.bound();
    if (!stripeInvoiceId) throw new Error('attachStripeInvoice requires a stripeInvoiceId');

    // Pre-check, so the ordinary collision never reaches the storage engine at all.
    const claimant = await this._holderOf(stripeInvoiceId);
    if (claimant && claimant.id !== ledgerId) {
      return refuse(REFUSAL_REASONS.INVOICE_ID_ALREADY_CLAIMED, { heldBy: claimant.primus_invoice_id });
    }

    let res;
    try {
      res = await this.db
        .prepare(
          `UPDATE ledger SET stripe_invoice_id = ?, stripe_state = ?, last_error = NULL, updated_at = ?
            WHERE id = ? AND mode = ? AND ${bound.sql}
              AND (stripe_invoice_id IS NULL OR stripe_invoice_id = ?)`
        )
        .bind(stripeInvoiceId, state, Date.now(), ledgerId, this.mode, ...bound.params, stripeInvoiceId)
        .run();
    } catch (err) {
      // THE NARROW CATCH — classified by RE-READING STATE, never by parsing the message. The
      // ledger_stripe_invoice_uniq violation and every other constraint on this table carry the
      // SAME SQLite code (2067), and D1 wraps messages differently from node:sqlite. The error
      // becomes a refusal ONLY when a read confirms a different row now holds this id; anything
      // else rethrows untouched. Identical to StripeCustomers.attach() on purpose.
      const holder = await this._holderOf(stripeInvoiceId);
      if (holder && holder.id !== ledgerId) {
        return refuse(REFUSAL_REASONS.INVOICE_ID_ALREADY_CLAIMED, { heldBy: holder.primus_invoice_id });
      }
      throw err;
    }

    if ((res.meta && res.meta.changes) === 1) return allow();
    return refuse(REFUSAL_REASONS.ALREADY_MATERIALIZED);
  }

  /**
   * Which row, if any, holds this Stripe invoice id in this mode.
   *
   * ── DELIBERATELY NOT BOUND-SCOPED. This is not an omission — do not "fix" it. ────────────────
   * Every other query on this class carries the pilot bound. This one must not: the unique index is
   * GLOBAL, so a collision with an out-of-bound row is still a collision. Bounding this read would
   * make the refusal miss precisely the case the 11 Payless rows exist to represent — a row outside
   * the pilot already holding the id we are about to claim.
   */
  async _holderOf(stripeInvoiceId) {
    return this.db
      .prepare('SELECT id, primus_invoice_id FROM ledger WHERE mode = ? AND stripe_invoice_id = ?')
      .bind(this.mode, stripeInvoiceId)
      .first();
  }

  /**
   * intent|failed → creating. Call IMMEDIATELY BEFORE the Stripe create.
   *
   * This is what turns the orphan window from invisible into queryable. Without it, a row in
   * `intent` is ambiguous — it cannot distinguish "we never called Stripe" from "we called and
   * lost the response" — so a re-run cannot know whether it is safe to create. With it:
   *
   *   intent   → never attempted → safe to create
   *   creating → attempted, outcome UNKNOWN → must read Stripe before creating anything
   *   anything else → known
   *
   * Refuses once an invoice id is attached: an invoice that exists is not being created again.
   */
  async markCreating(ledgerId) {
    const bound = this.bound();
    const res = await this.db
      .prepare(
        `UPDATE ledger SET stripe_state = 'creating', updated_at = ?
          WHERE id = ? AND mode = ? AND ${bound.sql} AND stripe_state IN ('intent', 'failed')
            AND stripe_invoice_id IS NULL`
      )
      .bind(Date.now(), ledgerId, this.mode, ...bound.params)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  async setState(ledgerId, state) {
    assertState(state);
    const bound = this.bound();
    const res = await this.db
      .prepare(`UPDATE ledger SET stripe_state = ?, updated_at = ? WHERE id = ? AND mode = ? AND ${bound.sql}`)
      .bind(state, Date.now(), ledgerId, this.mode, ...bound.params)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  /**
   * Classification is written ONCE (spec §4.3). A later run sees more BOL collisions and would
   * otherwise reclassify an invoice that has already been sent, so this refuses to overwrite.
   */
  async setClassification(ledgerId, classification) {
    const bound = this.bound();
    const res = await this.db
      .prepare(
        `UPDATE ledger SET classification = ?, updated_at = ?
          WHERE id = ? AND mode = ? AND ${bound.sql} AND classification IS NULL`
      )
      .bind(classification, Date.now(), ledgerId, this.mode, ...bound.params)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  /** @returns {boolean} false when the bound excludes this row — the caller learns nothing happened. */
  async recordFailure(ledgerId, message) {
    const bound = this.bound();
    const res = await this.db
      .prepare(`UPDATE ledger SET stripe_state = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND mode = ? AND ${bound.sql}`)
      // Truncated, and callers must pass a message that never embeds an upstream body (spec §6.3).
      .bind(String(message).slice(0, 300), Date.now(), ledgerId, this.mode, ...bound.params)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  /**
   * Stamp the first moment a poll saw this invoice paid (spec §4.6).
   *
   * Write-once by the `IS NULL` guard — a later poll must not overwrite it, because the value is
   * "when we first knew", not "when we last looked". Nothing reads this. It exists because it
   * cannot be backfilled: Primus keeps no paid timestamp, so the moment is otherwise lost.
   */
  async markPaidFirstSeen(ledgerId, at = Date.now()) {
    const bound = this.bound();
    const res = await this.db
      .prepare(
        `UPDATE ledger SET paid_first_seen_at = ?
          WHERE id = ? AND mode = ? AND ${bound.sql} AND paid_first_seen_at IS NULL`
      )
      .bind(at, ledgerId, this.mode, ...bound.params)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  /**
   * Stamp the moment a customer-facing link was first minted (spec §8.879).
   *
   * WRITE-ONCE by the `IS NULL` guard, and that is what makes it the reconciliation point: the mint
   * writes the LINKS database and then stamps here — two databases, no transaction. If the stamp
   * fails, a re-run finds the link already active, reads the token back, and re-stamps. The value is
   * "when we first minted", never "when we last looked".
   */
  async markLinkMinted(ledgerId, at = Date.now()) {
    const bound = this.bound();
    const res = await this.db
      .prepare(
        `UPDATE ledger SET link_minted_at = ?, updated_at = ?
          WHERE id = ? AND mode = ? AND ${bound.sql} AND link_minted_at IS NULL`
      )
      .bind(at, Date.now(), ledgerId, this.mode, ...bound.params)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  /** Void + reissue (spec §4.4): a finalized Stripe invoice cannot be edited. */
  /** @returns {boolean} false when the bound excludes this row. */
  async supersede(oldLedgerId, newLedgerId) {
    const bound = this.bound();
    const res = await this.db
      .prepare(`UPDATE ledger SET superseded_by = ?, stripe_state = 'void', updated_at = ? WHERE id = ? AND mode = ? AND ${bound.sql}`)
      .bind(newLedgerId, Date.now(), oldLedgerId, this.mode, ...bound.params)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  async nextVersion(primusInvoiceId) {
    const row = await this.db
      .prepare('SELECT MAX(version) AS v FROM ledger WHERE mode = ? AND primus_invoice_id = ?')
      .bind(this.mode, String(primusInvoiceId))
      .first();
    return ((row && row.v) || 0) + 1;
  }

  // ── exception queue ────────────────────────────────────────────────────────────────────────

  /**
   * Skip and record, never guess. An unmatched ARCode, an unknown document type, an ambiguous
   * classification: the invoice is left alone and a human decides.
   *
   * `detail` must be short and non-sensitive. Never pass a Primus detail object — costBreakdown /
   * payableBreakdown / profitSummary / invoiceInternalRemarks carry carrier cost and GP (§6.1).
   */
  async recordException(kind, ref, detail = null) {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO exceptions (mode, kind, ref, detail, seen_count, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (mode, kind, ref) DO UPDATE SET
           seen_count  = exceptions.seen_count + 1,
           last_seen_at = excluded.last_seen_at,
           detail      = COALESCE(excluded.detail, exceptions.detail),
           resolved_at = NULL`
      )
      .bind(this.mode, kind, String(ref), detail && String(detail).slice(0, 300), now, now)
      .run();
  }

  /**
   * Quarantine ONE invoice for a data gap, and carry on with the run.
   *
   * Distinct from recordException by an explicit `quarantine:` kind prefix. A data gap and a fetch
   * failure are different problems — one is Primus's data, the other is Primus being unreachable —
   * and reading one as the other has already cost a debugging round today (spec §0.25). The prefix
   * makes them separable by eye and by `kind LIKE 'quarantine:%'`.
   */
  async quarantine(primusInvoiceId, reason, detail) {
    return this.recordException(`${QUARANTINE_PREFIX}${reason}`, `invoice:${primusInvoiceId}`, detail);
  }

  async openQuarantines(limit = 100) {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM exceptions
          WHERE mode = ? AND resolved_at IS NULL AND kind LIKE ?
          ORDER BY last_seen_at DESC LIMIT ?`
      )
      .bind(this.mode, `${QUARANTINE_PREFIX}%`, limit)
      .all();
    return results || [];
  }

  async openExceptions(limit = 100) {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM exceptions WHERE mode = ? AND resolved_at IS NULL
          ORDER BY last_seen_at DESC LIMIT ?`
      )
      .bind(this.mode, limit)
      .all();
    return results || [];
  }

  // ── run lease ──────────────────────────────────────────────────────────────────────────────

  /**
   * A performance guard, not a correctness guard (spec §3). If the lease is ever wrong the ledger
   * still refuses the duplicate — which is why the lease is allowed to be this simple.
   *
   * Takeover on expiry is deliberate: a run killed by CPU limits never releases, and without an
   * expiry the sync would wedge until someone noticed.
   */
  async acquireLease(name, holder, ttlMs) {
    const now = Date.now();
    const key = `${this.mode}:${name}`;
    const res = await this.db
      .prepare(
        `INSERT INTO lease (name, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (name) DO UPDATE SET
           holder = excluded.holder, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
         WHERE lease.expires_at <= ?`
      )
      .bind(key, holder, now, now + ttlMs, now)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  async releaseLease(name, holder) {
    await this.db
      .prepare('DELETE FROM lease WHERE name = ? AND holder = ?')
      .bind(`${this.mode}:${name}`, holder)
      .run();
  }
}
