// The Stripe CUSTOMER identity, keyed (mode, ar_code) — spec §4.2, §8.869.
//
// Deliberately the SAME discipline as `ledger`, not a second one invented for customers:
//
//     CLAIM THE ROW BEFORE CALLING STRIPE. ALWAYS.
//
// The failure this prevents is the customer orphan — a Stripe customer created outside the claim,
// which nothing holds a claim for and no re-run can re-find. It is quieter than the invoice orphan
// (no money moves, no mail is sent) and worse to clean up: duplicate customers on an account
// accumulate silently, and §0.2 already records what two identity systems cost this estate once.
//
// One row per customer, MANY ledger rows against it, joined at read time. There is no
// stripe_customer_id copy on `ledger` — see schema.sql for why that is deliberate.
//
// Belt and braces with the credential: the Task 2 restricted key carries Customers = READ, so the
// create this module claims for cannot execute at all during the pilot (spec §8.869). That is the
// stronger guarantee. This module is what makes the discipline survive the day it becomes Write.

/**
 * Every legal `stripe_customer.state`. ONE list, imported rather than remembered.
 *
 * Same reasoning as ledger.STRIPE_STATES: the column is free-text TEXT with no CHECK constraint,
 * so a typo writes silently and then matches no reader predicate.
 *
 *   intent   → row claimed, no Stripe call attempted yet
 *   creating → a create was ATTEMPTED and its outcome is unknown; MUST be reconciled by reading
 *              Stripe before any further create (see openCreating)
 *   created  → Stripe returned a customer and its id is attached
 *   failed   → the create errored; retryable, and the claim is still held
 */
export const STRIPE_CUSTOMER_STATES = Object.freeze(['intent', 'creating', 'created', 'failed']);

function assertState(state) {
  if (!STRIPE_CUSTOMER_STATES.includes(state)) {
    throw new Error(
      `Unknown stripe_customer state ${JSON.stringify(state)} — expected one of ` +
      `${STRIPE_CUSTOMER_STATES.join(', ')}. A misspelt state is written silently and then matches ` +
      `no reader, so this fails closed.`
    );
  }
  return state;
}

/**
 * Mode-namespaced idempotency key for the Stripe customer create.
 *
 * No version component, unlike the invoice key: an invoice is reissued at version+1 after a void
 * (§4.4), but a customer is never reissued — there is exactly one per (mode, ARCode) and the
 * uniqueness constraint says so.
 */
export function customerIdempotencyKey(mode, arCode) {
  return `${mode}-primus-ar-${String(arCode).trim().toUpperCase()}`;
}

export class StripeCustomers {
  /**
   * @param {D1Database} db
   * @param {'test'|'live'} mode  included in every key, so a test-mode row can never satisfy a
   *   live-mode lookup and suppress a live create
   */
  constructor(db, mode) {
    if (mode !== 'test' && mode !== 'live') {
      throw new Error(`StripeCustomers requires an explicit mode, got ${mode}`);
    }
    this.db = db;
    this.mode = mode;
  }

  /**
   * Claim an ARCode for customer creation. Call this BEFORE touching Stripe.
   *
   * @returns {{claimed:boolean, row:object}} claimed=false means the row already exists — either
   *   another run owns it, or it is already `created` and carries the id the caller wants. Not an
   *   error: re-seeing a customer is free, which is the whole point.
   */
  async claim({ arCode, qboDisplayName = null }) {
    if (arCode === null || arCode === undefined || String(arCode).trim() === '') {
      throw new Error('claim() requires an arCode');
    }
    const code = String(arCode).trim();
    const now = Date.now();
    const key = customerIdempotencyKey(this.mode, code);

    const res = await this.db
      .prepare(
        `INSERT INTO stripe_customer
           (mode, ar_code, state, idempotency_key, qbo_display_name, created_at, updated_at)
         VALUES (?, ?, 'intent', ?, ?, ?, ?)
         ON CONFLICT (mode, ar_code) DO NOTHING`
      )
      .bind(this.mode, code, key, qboDisplayName, now, now)
      .run();

    const inserted = (res.meta && res.meta.changes) === 1;
    const row = await this.get(code);
    return { claimed: inserted, row };
  }

  async get(arCode) {
    return this.db
      .prepare('SELECT * FROM stripe_customer WHERE mode = ? AND ar_code = ?')
      .bind(this.mode, String(arCode).trim())
      .first();
  }

  /**
   * The id, or null. This is the read side of the join a create path performs — and when it
   * returns null the create path must REFUSE, never create the customer itself (control 9).
   */
  async idFor(arCode) {
    const row = await this.get(arCode);
    return (row && row.stripe_customer_id) || null;
  }

  /**
   * intent|failed → creating. Call IMMEDIATELY BEFORE the Stripe create.
   *
   * This is what makes the orphan window visible instead of invisible. Without it, a row sitting
   * in `intent` is ambiguous — it cannot distinguish "we never called Stripe" from "we called and
   * lost the response", so a re-run has no way to know whether looking before creating is
   * necessary. With it, `intent` is safe to create and `creating` must be reconciled first.
   *
   * Refuses once an id is attached: a customer that exists is not being created again.
   */
  async markCreating(id) {
    const res = await this.db
      .prepare(
        `UPDATE stripe_customer SET state = 'creating', updated_at = ?
          WHERE id = ? AND mode = ? AND state IN ('intent', 'failed') AND stripe_customer_id IS NULL`
      )
      .bind(Date.now(), id, this.mode)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  /**
   * Attach the Stripe customer id. WRITE-ONCE PER ID, exactly as on the ledger.
   *
   * A different id is refused rather than overwritten — overwriting would strand the first customer
   * as an object no row references, which is the same defect the ledger carried until 3f9411e.
   * Re-attaching the SAME id succeeds: a benign retry is not a conflict.
   *
   * @returns {boolean} false means a DIFFERENT id is already attached; the caller must not treat
   *   its create as recorded.
   */
  async attach(id, stripeCustomerId) {
    if (!stripeCustomerId) throw new Error('attach() requires a stripeCustomerId');
    const res = await this.db
      .prepare(
        `UPDATE stripe_customer
            SET stripe_customer_id = ?, state = 'created', last_error = NULL, updated_at = ?
          WHERE id = ? AND mode = ?
            AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)`
      )
      .bind(stripeCustomerId, Date.now(), id, this.mode, stripeCustomerId)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  async setState(id, state) {
    assertState(state);
    const res = await this.db
      .prepare('UPDATE stripe_customer SET state = ?, updated_at = ? WHERE id = ? AND mode = ?')
      .bind(state, Date.now(), id, this.mode)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  async recordFailure(id, message) {
    const res = await this.db
      .prepare(`UPDATE stripe_customer SET state = 'failed', last_error = ?, updated_at = ?
                 WHERE id = ? AND mode = ?`)
      // Truncated, and callers must pass a message that never embeds an upstream body (spec §6.3).
      .bind(String(message).slice(0, 300), Date.now(), id, this.mode)
      .run();
    return (res.meta && res.meta.changes) === 1;
  }

  /**
   * Rows stuck in `creating` — the orphan candidates.
   *
   * `staleMs` exists so this never fights a run that is still going. A row that entered `creating`
   * seconds ago probably belongs to a live invocation; one older than the lease TTL cannot. The
   * default is deliberately LONGER than LEASE_TTL_MS (10 min), because sweeping a row out from
   * under a running create is how you get the second create this whole design exists to prevent.
   */
  async openCreating({ staleMs = 15 * 60 * 1000, now = Date.now(), limit = 100 } = {}) {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM stripe_customer
          WHERE mode = ? AND state = 'creating' AND updated_at <= ?
          ORDER BY updated_at ASC LIMIT ?`
      )
      .bind(this.mode, now - staleMs, limit)
      .all();
    return results || [];
  }
}
