// THE WIRE — an invoice in, the addresses it is emailed to out.
//
// Composition, deliberately containing no rule of its own:
//
//     invoice detail → customerInfo.customerId → console record → the precedence rule
//     (src/detail.js)                            (console-lookup)   (recipient.js)
//
// Every step is tested in its own file. What lives here is the joining, the per-run memo, and the
// one decision the joining forces: what to do when the invoice carries no customer id at all.
//
// ── THE MEMO, AND WHY IT IS NOT A CACHE ──────────────────────────────────────────────────────
//
// A window routinely holds several invoices for one customer, and each would otherwise be its own
// console read. The memo collapses those to one — and its lifetime is EXACTLY this object, which
// is exactly one run.
//
// That boundary is the whole design. A record cache with a TTL was considered and rejected: ops
// edit billing addresses (Bison's Remit-To moved twice in its own audit log), so a cached record
// means sending to a superseded address while `invoice_send.recipient_source` records where we
// think we read it — the one column that exists to answer "how did this reach the wrong person",
// made unanswerable. A memo bounded by the run has a worst-case staleness of the run's duration.
//
// REFUSALS ARE NOT MEMOISED. A console blip on the first invoice of a customer must not become
// that customer's answer for the rest of the run. The cost is one extra call per invoice on a
// genuinely broken record, which at pilot volume is nothing.

import { fetchCustomerRecord, exceptionRefFor } from './console-lookup.js';
import { resolveRecipient } from './recipient.js';
import { refuse, allow, REFUSAL_REASONS } from './refusals.js';

export class InvoiceRecipients {
  /**
   * @param {{post:Function}} session  a ConsoleSession (piece i)
   * @param {{all:boolean, codes:Set<string>}} allowlist  the pilot bound, REQUIRED — held here for
   *   the same reason Ledger holds it, and passed straight through to the rule.
   * @param {{ledger?:object, sink?:object}} [opts]
   *   `ledger` is OPTIONAL, and that is not the allowlist's situation: an absent bound silently
   *   means "everything" and is a safety property, whereas an absent ledger costs a queue row and
   *   nothing else. The live check (piece iv) resolves without one.
   */
  constructor(session, allowlist, { ledger = null, sink = null } = {}) {
    if (!allowlist || typeof allowlist.all !== 'boolean' || !(allowlist.codes instanceof Set)) {
      throw new Error(
        'InvoiceRecipients requires an explicit AR allowlist. It is never defaulted — see §3.1 ' +
        'and the Ledger constructor, which refuses for the same reason.'
      );
    }
    this.session = session;
    this.allowlist = allowlist;
    this.ledger = ledger;
    this.sink = sink;
    /** customerId → narrowed console record. Successes only. Dies with this object. */
    this._records = new Map();
  }

  /**
   * @param {object} detail  a narrowed invoice detail (src/detail.js)
   * @returns {Promise<{ok:true, value:{to:string[], source:string, dropped:string[],
   *   arCode:string|null, customerId:string}}|{ok:false, reason:string, detail:object}>}
   *
   * A refusal at ANY stage is returned as a refusal. There is no path that returns a partially
   * built recipient — the failure being guarded is not an exception, it is a `to` of `[undefined]`
   * that sends successfully to nobody and looks fine in the log.
   */
  async forInvoice(detail) {
    const customerId = String((detail && detail.customerInfo && detail.customerInfo.customerId) ?? '').trim();

    if (!customerId) {
      // `customerInfo` is optional on the detail (§0.2 demoted it to metadata), so this is a data
      // condition rather than a programming error — and there is nothing to look anything up with.
      return this._record(refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, {
        reason: 'customer_id_missing',
        invoiceId: String((detail && detail.invoiceId) ?? ''),
      }));
    }

    let record = this._records.get(customerId);
    if (!record) {
      const got = await fetchCustomerRecord(this.session, customerId);
      if (!got.ok) return this._record(got);
      record = got.value;
      this._records.set(customerId, record);
    }

    const resolved = resolveRecipient(record, this.allowlist, this.sink);
    if (!resolved.ok) return this._record(resolved);

    return allow({ ...resolved.value, customerId });
  }

  /**
   * File a refusal in the exception queue and hand it back unchanged.
   *
   * The ref comes from exceptionRefFor, so a per-invoice gap, a per-customer gap and a systemic
   * console change land under different keys and stay separable on triage.
   *
   * A recording failure NEVER changes the outcome. The refusal is what the caller acts on; losing
   * the queue row is a diagnostic loss, and turning it into a thrown error would take down a run
   * over bookkeeping.
   */
  async _record(refusal) {
    if (this.ledger) {
      try {
        await this.ledger.recordException(
          refusal.reason,
          exceptionRefFor(refusal),
          shortDetail(refusal.detail)
        );
      } catch { /* diagnostics must not decide outcomes */ }
    }
    return refusal;
  }
}

/**
 * Refusal detail → a short queue string.
 *
 * Every refusal detail on this path is already non-sensitive by construction — none of them
 * carries an email address (recipient.js asserts that, and console-lookup.js never puts a record
 * in one). Truncated anyway, on the §6.3 principle that an upstream body must never reach a log.
 */
function shortDetail(detail) {
  if (!detail) return null;
  return JSON.stringify(detail).slice(0, 300);
}
