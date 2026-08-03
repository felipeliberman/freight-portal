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

/** Marks exception rows that are a DATA GAP in one record, not an operational failure. */
export const QUARANTINE_PREFIX = 'quarantine:';

/** Mode-namespaced idempotency key for the Stripe create (spec §4.2 layer 2). */
export function idempotencyKey(mode, primusInvoiceId, version) {
  return `${mode}-primus-inv-${primusInvoiceId}-v${version}`;
}

export class Ledger {
  /**
   * @param {D1Database} db
   * @param {'test'|'live'} mode  included in every key so test rows can never suppress a live create
   */
  constructor(db, mode) {
    if (mode !== 'test' && mode !== 'live') throw new Error(`Ledger requires an explicit mode, got ${mode}`);
    this.db = db;
    this.mode = mode;
  }

  // ── claim ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Claim an invoice for materialization. Call this BEFORE touching Stripe.
   *
   * @returns {{claimed:boolean, row:object}} claimed=false means another run (or an earlier run)
   *   already owns this (invoice, version); `row` is the existing record. Not an error — the whole
   *   point of the overlapping window is that re-seeing an invoice is free.
   */
  async claim({ primusInvoiceId, primusInvoiceNumber = null, bolNumber = null, arCode = null, version = 1, totalCents = null }) {
    if (!primusInvoiceId) throw new Error('claim() requires primusInvoiceId');
    const now = Date.now();
    const key = idempotencyKey(this.mode, primusInvoiceId, version);

    const res = await this.db
      .prepare(
        `INSERT INTO ledger
           (mode, primus_invoice_id, primus_invoice_number, bol_number, ar_code,
            version, stripe_state, total_cents, idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'intent', ?, ?, ?, ?)
         ON CONFLICT (mode, primus_invoice_id, version) DO NOTHING`
      )
      .bind(this.mode, String(primusInvoiceId), primusInvoiceNumber, bolNumber, arCode,
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

  /** Rows the reconcile pass still has to chase (spec §3 pass 2). */
  async openForReconcile(limit = 200) {
    const { results } = await this.db
      .prepare(
        // Deliberately includes 'draft' and 'uncollectible', not just 'finalized'. Sweeping only
        // open invoices silently strands everything in the other states.
        `SELECT * FROM ledger
          WHERE mode = ? AND stripe_state IN ('draft', 'finalized', 'uncollectible')
          ORDER BY updated_at ASC LIMIT ?`
      )
      .bind(this.mode, limit)
      .all();
    return results || [];
  }

  // ── transitions ────────────────────────────────────────────────────────────────────────────

  /** Attach the Stripe invoice to a claimed row once the create returns. */
  async attachStripeInvoice(ledgerId, stripeInvoiceId, state = 'draft') {
    await this.db
      .prepare(
        `UPDATE ledger SET stripe_invoice_id = ?, stripe_state = ?, last_error = NULL, updated_at = ?
          WHERE id = ? AND mode = ?`
      )
      .bind(stripeInvoiceId, state, Date.now(), ledgerId, this.mode)
      .run();
  }

  async setState(ledgerId, state) {
    await this.db
      .prepare('UPDATE ledger SET stripe_state = ?, updated_at = ? WHERE id = ? AND mode = ?')
      .bind(state, Date.now(), ledgerId, this.mode)
      .run();
  }

  /**
   * Classification is written ONCE (spec §4.3). A later run sees more BOL collisions and would
   * otherwise reclassify an invoice that has already been sent, so this refuses to overwrite.
   */
  async setClassification(ledgerId, classification) {
    const res = await this.db
      .prepare(
        `UPDATE ledger SET classification = ?, updated_at = ?
          WHERE id = ? AND mode = ? AND classification IS NULL`
      )
      .bind(classification, Date.now(), ledgerId, this.mode)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  async recordFailure(ledgerId, message) {
    await this.db
      .prepare(`UPDATE ledger SET stripe_state = 'failed', last_error = ?, updated_at = ? WHERE id = ? AND mode = ?`)
      // Truncated, and callers must pass a message that never embeds an upstream body (spec §6.3).
      .bind(String(message).slice(0, 300), Date.now(), ledgerId, this.mode)
      .run();
  }

  /** Void + reissue (spec §4.4): a finalized Stripe invoice cannot be edited. */
  async supersede(oldLedgerId, newLedgerId) {
    await this.db
      .prepare(`UPDATE ledger SET superseded_by = ?, stripe_state = 'void', updated_at = ? WHERE id = ? AND mode = ?`)
      .bind(newLedgerId, Date.now(), oldLedgerId, this.mode)
      .run();
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
