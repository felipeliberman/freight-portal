// Spec phase 5 — narrowed Primus invoice → Stripe invoice object.
//
// THIS IS THE FIRST CODE THAT COULD PUT DATA IN FRONT OF A CUSTOMER. Everything before it read.
// So it builds by explicit assignment only, and then ASSERTS the result — it does not rely on the
// §6.1 narrowing having done its job upstream, because "the input was already safe" is exactly the
// assumption that stops being true the day someone passes a raw record in.
//
// It constructs an object and returns it. It does NOT call Stripe, hold a key, or import a client.

import { toCents } from './invoices.js';
import { auditValues, BANNED_FIELDS, NON_PAYLOAD_FIELDS } from './detail.js';

/** Stripe allows exactly 4 custom fields, 30 chars of name and 30 of value. */
const CUSTOM_FIELD_MAX = 30;

/**
 * The zero-line rule (spec §5.1), with BOTH coercion doors closed.
 *
 * Order is load-bearing and must not be rearranged:
 *   1. reject null/undefined  — `null == 0` is false but `null >= 0` is true
 *   2. type-check + normalise through toCents() — it strips `$` and commas, so a formatted
 *      `"$0.00"` becomes 0 instead of failing `== 0` and shipping as a PRICED line
 *   3. compare on INTEGER CENTS — never a float, never a raw field
 *
 * Live types as of 2026-08-03: line `total` and `rate` are numbers, `qty` is a string ("1.00").
 * The mixed typing on one object is why step 2 is not optional.
 */
export function classifyLine(line) {
  if (!line || line.total === null || line.total === undefined) {
    return { kind: 'unusable', cents: null, reason: 'null total' };
  }
  const cents = toCents(line.total);
  if (cents === null) {
    return { kind: 'unusable', cents: null, reason: `unparseable total ${JSON.stringify(line.total)}` };
  }
  // Integer comparison. No `== 0`, no `>= 0`, no float anywhere on this path.
  return { kind: cents === 0 ? 'zero' : 'billable', cents, reason: null };
}

/** Truncate to Stripe's custom-field limit without emitting an empty field. */
function customField(name, value) {
  const v = value === null || value === undefined ? '' : String(value).trim();
  if (!v) return null;
  return { name: String(name).slice(0, CUSTOM_FIELD_MAX), value: v.slice(0, CUSTOM_FIELD_MAX) };
}

/**
 * Primus `invoiceNumber` → the customer-visible Stripe invoice number.
 *
 * Stripe assigns its own number by default; this is what gets explicitly overridden (spec §0.1.1).
 * Payless AP has always matched on the Primus number. Stripe's internal number still exists
 * underneath — two numbers in reconciliation is expected, not a bug.
 *
 * Normalised because a JS number rendered onto an invoice must not carry a spurious decimal. Note
 * the `.0` seen earlier was OUR SQLite TEXT affinity, not Primus — Primus returns a number.
 */
export function customerVisibleNumber(invoiceNumber) {
  if (invoiceNumber === null || invoiceNumber === undefined) return null;
  const s = String(invoiceNumber).trim();
  if (!s) return null;
  return s.replace(/\.0+$/, '');
}

/**
 * Assert nothing from the banned set, and no diagnostic field, survives into the payload.
 *
 * Checks KEY NAMES recursively AND the serialised form, because a banned value could in principle
 * be copied under an innocent key. Throws — this is the irreversible direction, so it fails closed.
 */
export function assertPayloadClean(payload) {
  const forbidden = [...BANNED_FIELDS, ...NON_PAYLOAD_FIELDS];

  const walk = (v, path) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v)) {
      if (forbidden.includes(k)) {
        throw new Error(`Stripe payload carries a forbidden field: ${path}.${k}`);
      }
      walk(val, `${path}.${k}`);
    }
  };
  walk(payload, '$');
  return payload;
}

/**
 * Build the Stripe invoice object.
 *
 * @param {object} detail   a NARROWED invoice detail (src/detail.js)
 * @param {object} customer a resolved customer (src/customers.js)
 * @returns {{ok:boolean, payload?:object, quarantine?:{reason:string, fields:string[]}}}
 *
 * Returns a quarantine verdict rather than throwing when the invoice has null required values —
 * one bad record must not stop a run (spec §6.5).
 */
export function buildStripeInvoice(detail, customer, { customerReference = null, verifiedRecipients = null, valueSink = null } = {}) {
  const audit = auditValues(detail, valueSink);
  if (!audit.ok) {
    return {
      ok: false,
      quarantine: {
        reason: 'null_required_value',
        fields: audit.missingRequired,
      },
    };
  }

  // ARCode comes from the CLAIMED value on the ledger row — the one the list response carried and
  // that selected this invoice in the first place. NOT from the detail (which has no ARCode) and
  // NOT derived from customerInfo.customerCode: a second derivation path can only ever disagree
  // silently, and "the two are equal" is an unverified claim about Primus.
  //
  // No fallback. Absent means quarantine.
  const arCode = customer && customer.arCode;
  if (arCode === null || arCode === undefined || String(arCode).trim() === '') {
    return { ok: false, quarantine: { reason: 'missing_claimed_ar_code', fields: ['customer.arCode'] } };
  }

  const lines = [];
  const zeroDollarDescriptions = [];
  const unusable = [];

  for (const line of detail.invoiceBreakdown) {
    const verdict = classifyLine(line);
    if (verdict.kind === 'unusable') { unusable.push({ description: line.description, reason: verdict.reason }); continue; }
    if (verdict.kind === 'zero') {
      // §5.1: a $0 line NEVER becomes a Stripe line item, primary or rebill. A printed
      // "LIFTGATE — $0.00" contradicts you later if that accessorial gets rebilled.
      zeroDollarDescriptions.push(line.description);
      continue;
    }
    lines.push({
      description: line.description,
      amount_cents: verdict.cents,
      currency: 'usd',
      quantity: 1,   // Primus `qty` is a formatted STRING ("1.00"); the amount is already the total
    });
  }

  const number = customerVisibleNumber(detail.invoiceNumber);
  // Four slots, and the fourth is the CUSTOMER'S reference — not Carrier. Carrier is ours and
  // appears elsewhere; the reference is the only thing on the invoice that belongs to them, and
  // it is what their AP matches against internally. An AP clerk who cannot find their own number
  // on our invoice has been handed something harder to process than what it replaced.
  //
  // Claim-time value (ledger.customer_reference) — the LIST carries it, the detail does not.
  const custom_fields = [
    customField('BOL #', detail.shipment.BOLNumber),
    customField('PRO #', detail.shipment.carrierPRO),
    customField('Consignee', detail.shipment.consigneeName),
    customField('Your Ref #', customerReference),
  ].filter(Boolean);

  const payload = {
    // Reference only. The customer object is NOT created here and this function holds no Stripe key.
    customer_ref: {
      ar_code: String(arCode),
      qbo_display_name: customer.displayName,
      email: customer.primaryEmail,
      cc: customer.ccEmails,
      // Both ids on the customer, per §0.2 — a later surprise costs a metadata read, not a migration.
      metadata: {
        ar_code: String(arCode),
        primus_customer_id: customer.primusCustomerId === null || customer.primusCustomerId === undefined
          ? '' : String(customer.primusCustomerId),
      },
    },

    invoice: {
      // EXPLICIT OVERRIDE. Without this Stripe assigns its own number and Payless AP cannot match.
      number,
      currency: 'usd',
      collection_method: 'send_invoice',
      // Drafts only. Nothing auto-finalises, nothing auto-sends.
      auto_advance: false,
      due_date: detail.invoiceDueDate,
      metadata: {
        primus_invoice_id: String(detail.invoiceId),
        primus_invoice_number: number === null ? '' : number,
        bol_number: detail.shipment.BOLNumber === null ? '' : String(detail.shipment.BOLNumber),
        ar_code: String(arCode),
      },
      custom_fields,
    },

    lines,

    // Not lines. §5.1 keeps these off the invoice; where their descriptions go (folded into the
    // freight line on a primary, memo context on a rebill) is decided by the classifier, which is
    // §4.3 and NOT BUILT. Carried out here rather than guessed at.
    zero_dollar_descriptions: zeroDollarDescriptions,
  };

  if (unusable.length) payload._unusable_lines = unusable;

  // Recipient verification (spec §5.6). Unverified addresses do not block BUILDING — the payload
  // still needs reviewing — but they must block SENDING. assertSendable() is the hard gate.
  const unverified = unverifiedRecipients(payload.customer_ref, verifiedRecipients);
  if (unverified.length) {
    payload.send_blocked = { reason: 'unverified_recipient', addresses: unverified };
  }

  assertPayloadClean(payload);
  return { ok: true, payload };
}

/**
 * Which recipients are not on the verified list.
 *
 * FAILS CLOSED: a null or empty verified set means NOTHING is verified, so every recipient is
 * unverified. "No list configured" must never read as "everyone is fine."
 */
export function unverifiedRecipients(customerRef, verifiedRecipients) {
  const verified = new Set((verifiedRecipients || []).map(e => String(e).trim().toLowerCase()).filter(Boolean));
  const all = [customerRef.email, ...(customerRef.cc || [])].filter(Boolean);
  return all.filter(e => !verified.has(String(e).trim().toLowerCase()));
}

/**
 * THE HARD GATE. Any future send path must call this and must not catch it.
 *
 * A wrong or unconfirmed address delivers successfully and looks perfect — billing data leaving
 * our control with no error anywhere. So this throws rather than returning a flag, and the flag on
 * the payload exists only to make the same fact visible during review.
 */
export function assertSendable(payload) {
  if (payload && payload.send_blocked) {
    throw new Error(
      `Refusing to send: ${payload.send_blocked.reason} — ${(payload.send_blocked.addresses || []).join(', ')}`
    );
  }
  return payload;
}
