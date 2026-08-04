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
import { summariseFreight, BOOKING_HOSTILE } from './booking.js';

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

/**
 * Carrier names too long for a Stripe custom field, abbreviated the way the PORTAL already
 * abbreviates them — so the customer reads the SAME name on the invoice and in My Shipments.
 *
 * Source of truth for the one entry below: `portal.html`'s existing
 * `.replace('Metropolitan Warehouse & Delivery Corp','Metro W&D')`.
 *
 * Surveyed against live booking data 2026-08-04 (45 bookings, 9 distinct carrier names): exactly
 * ONE name exceeds 30 characters, and it is the most common carrier in the sample (21 of 45).
 * Keys are matched case-insensitively after whitespace collapse, so "Metropolitan Warehouse and
 * Delivery" and the "& ... Corp" spelling both land on the same abbreviation.
 */
const CARRIER_ABBREV = new Map([
  ['metropolitan warehouse & delivery corp', 'Metro W&D'],
  ['metropolitan warehouse and delivery corp', 'Metro W&D'],
  ['metropolitan warehouse & delivery', 'Metro W&D'],
  ['metropolitan warehouse and delivery', 'Metro W&D'],
]);

/**
 * Shorten to `max` WITHOUT cutting mid-word. A hard slice produced
 * "Metropolitan Warehouse & Deliv" on live output — a chopped word reads as a bug, where a
 * deliberate abbreviation reads as intent. Falls back to the last whole word plus an ellipsis.
 */
export function shortenForField(value, max = CUSTOM_FIELD_MAX) {
  const v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!v) return '';
  const abbrev = CARRIER_ABBREV.get(v.toLowerCase());
  if (abbrev) return abbrev;
  if (v.length <= max) return v;
  // Reserve one char for the ellipsis, then back off to a word boundary.
  const cut = v.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const stem = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[\s,·&-]+$/, '');
  return `${stem}…`;
}

/** Truncate to Stripe's custom-field limit without emitting an empty field. */
function customField(name, value) {
  const v = value === null || value === undefined ? '' : String(value).trim();
  if (!v) return null;
  return { name: String(name).slice(0, CUSTOM_FIELD_MAX), value: shortenForField(v, CUSTOM_FIELD_MAX) };
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
  // Includes the BOOKING's hostile names: detail.js's BANNED_FIELDS matches NOT ONE of them
  // (vendor.cost, GPActual, profitUSDActual...), which is the worked example for why the boundary
  // is an allowlist rather than a denylist.
  const forbidden = [...BANNED_FIELDS, ...NON_PAYLOAD_FIELDS, ...BOOKING_HOSTILE];

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

/** "ADAIRSVILLE" -> "Adairsville". Primus stores cities uppercase; an invoice should not shout. */
function titleCase(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s.toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

/** "2026-06-22" or "2026-07-09 00:00:00" -> "06/22/26". Null-safe; returns '' when unusable. */
function shortDate(v) {
  const m = String(v ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1].slice(2)}` : '';
}

/** "Megan Cappiello, Baldwin Place, NY" — name and place read as ONE thing, not two. */
function partyLabel(p) {
  if (!p) return '';
  const place = [titleCase(p.city), String(p.state ?? '').trim().toUpperCase()].filter(Boolean).join(', ');
  return [String(p.name ?? '').trim(), place].filter(Boolean).join(', ');
}

/** "Adairsville, GA" */
function placeLabel(p) {
  if (!p) return '';
  return [titleCase(p.city), String(p.state ?? '').trim().toUpperCase()].filter(Boolean).join(', ');
}

/**
 * §5.3 — the lane description. ENRICHES the single existing line; it does NOT add lines.
 *
 * Line items stay a faithful 1:1 mirror of invoiceBreakdown. The Primus line text leads, so the
 * mirror is visible. Everything after the em dash is shipment context from the booking join.
 *
 * Aggregated across ALL freight items (§5.3) — never element [0]. Stripe caps a line description
 * at 500 characters; the shape below sits far inside that, and legibility binds first.
 */
export function buildLineDescription(primusDescription, booking) {
  const head = String(primusDescription ?? '').trim() || 'Freight Charge';
  if (!booking) return head;

  const f = summariseFreight(booking.freight);
  const lane = [placeLabel(booking.shipper), placeLabel(booking.consignee)].filter(Boolean).join(' \u2192 ');
  const parts = [];
  if (booking.mode) parts.push(String(booking.mode));
  if (lane) parts.push(lane);
  if (f.pieces) parts.push(`${f.pieces} pc${f.pieces === 1 ? '' : 's'}${f.commodityLabel ? ' ' + f.commodityLabel : ''}`);
  if (f.weight) parts.push(`${f.weight} lbs`);
  if (f.classLabel) parts.push(`Class ${f.classLabel}`);
  const pu = shortDate(booking.pickup && booking.pickup.dateEstimated);
  if (pu) parts.push(`PU ${pu}`);

  return parts.length ? `${head} \u2014 ${parts.join(' \u00b7 ')}` : head;
}

/**
 * §5.4 — the footer. PDF-ONLY, so it carries what will not fit on the line and what a reader can
 * still get from the attached PDF.
 *
 * The CONSIGNEE NAME lives here by deliberate demotion (§5.4): it moved off a top-line custom field
 * when Carrier took that slot, which means it is absent from the email body and the hosted page.
 * Reversible in one field if that turns out to matter.
 */
export function buildFooter(booking) {
  if (!booking) return '';
  const lines = [];

  const c = booking.carrier || {};
  const carrierBits = [c.name && `Carrier: ${c.name}`, c.serviceLevel && `Service: ${c.serviceLevel}`].filter(Boolean);
  if (carrierBits.length) lines.push(carrierBits.join(' \u00b7 '));

  const pu = shortDate(booking.pickup && booking.pickup.dateEstimated);
  const win = booking.pickup && booking.pickup.timeFrom && booking.pickup.timeTo
    ? `${String(booking.pickup.timeFrom).slice(0, 5)}\u2013${String(booking.pickup.timeTo).slice(0, 5)}` : '';
  const dl = shortDate(booking.delivery && booking.delivery.dateActual);
  const when = [pu && `Pickup ${pu}${win ? ' ' + win : ''}`, dl && `Delivered ${dl}`].filter(Boolean);
  if (when.length) lines.push(when.join(' \u00b7 '));

  const who = [
    booking.shipper && partyLabel(booking.shipper) && `Shipper: ${partyLabel(booking.shipper)}`,
    booking.consignee && partyLabel(booking.consignee) && `Consignee: ${partyLabel(booking.consignee)}`,
  ].filter(Boolean);
  if (who.length) lines.push(who.join(' \u00b7 '));

  return lines.join('\n');
}

/**
 * §5.5 — the memo. Renders in the EMAIL BODY, the PDF, and the HOSTED PAGE; the footer is PDF-only,
 * which is why the dispute notice lives here and not there.
 *
 * THE DISPUTE NOTICE IS A REQUIRED ELEMENT, NOT COPY. Absent, the invoice is NOT sendable — a
 * missing notice forfeits the carrier dispute window and the contractual basis for payment in full.
 *
 * The authoritative wording is the OWNER'S to write (D7) and is NOT invented here. Until it is
 * supplied, the slot renders a visible placeholder and the payload is send-blocked. A placeholder
 * an AP clerk can see is honest; fabricated contractual language is not.
 */
export const DISPUTE_NOTICE_PENDING = '\u00ab DISPUTE NOTICE \u2014 PENDING OWNER WORDING (D7) \u00bb';

export function buildMemo({ disputeNotice = null, supportEmail, supportPhone, documentsUrl = null } = {}) {
  const notice = (disputeNotice && String(disputeNotice).trim()) || DISPUTE_NOTICE_PENDING;
  const lines = [notice, '', `Questions? ${supportEmail} \u00b7 ${supportPhone}`];
  if (documentsUrl) lines.push(`Shipment documents: ${documentsUrl}`);
  const memo = lines.join('\n');
  return { memo, noticeSupplied: notice !== DISPUTE_NOTICE_PENDING, length: memo.length };
}

export const MEMO_MAX = 500;

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
export function buildStripeInvoice(detail, customer, {
  customerReference = null, booking = null, classification = null, primaryInvoiceNumber = null,
  disputeNotice = null, documentsUrl = null,
  supportEmail = 'accounting@freightandlogistics.ai', supportPhone = '800-687-3713',
  verifiedRecipients = null, valueSink = null,
} = {}) {
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
      // §5.3 enriches this description with booking context; the LINE ITSELF stays a 1:1 mirror.
      description: buildLineDescription(line.description, booking),
      amount_cents: verdict.cents,
      currency: 'usd',
      quantity: 1,   // Primus `qty` is a formatted STRING ("1.00"); the amount is already the total
    });
  }

  // §5.1 — WHERE the zero-dollar descriptions go depends on the classification, and they are never
  // lines in either case. On a PRIMARY they fold onto the freight line as bare names (HOLD #5); on a REBILL
  // they move to memo context, because on a rebill the customer is scrutinising the line list and a
  // folded "includes" reads as though it were part of what they are being charged for now.
  let zeroDollarPlacement = 'unplaced';
  let rebillContext = null;
  if (zeroDollarDescriptions.length && lines.length) {
    if (classification === 'primary') {
      // BARE NAME ONLY — no "Incl." prefix. HELD BY THE OWNER, and the hold is still active.
      //
      // "Incl. RESIDENTIAL DELIVERY" asserts the accessorial was INCLUDED AT NO CHARGE. That is a
      // commercial claim, not a formatting choice, and it is not ours to make from a string: the
      // priced-or-included question (KNOWLEDGE.md §White Glove, "residential liftgate standard on
      // every white glove delivery") is unanswered. A $0 line in `invoiceBreakdown` means the line
      // carried no charge ON THIS INVOICE — which is NOT the same as the service being free, and a
      // later rebill of that same accessorial would contradict the word "Incl." in writing.
      //
      // The bare name states what is true and nothing more: the accessorial was on the shipment.
      // Do NOT restore the prefix until the owner answers priced-or-included. Spec §5.3.
      lines[0].description = `${lines[0].description} \u00b7 ${zeroDollarDescriptions.join(', ')}`;
      zeroDollarPlacement = 'folded-into-line';
    } else if (classification === 'rebill') {
      rebillContext = `Originally billed: ${zeroDollarDescriptions.join(', ')}`;
      zeroDollarPlacement = 'memo-context';
    }
    // classification null or 'hold' -> left UNPLACED. Guessing the placement is guessing whether
    // the customer is looking at an original bill or a supplemental one.
  }

  const number = customerVisibleNumber(detail.invoiceNumber);
  // Four slots, and the fourth is the CUSTOMER'S reference — not Carrier. Carrier is ours and
  // appears elsewhere; the reference is the only thing on the invoice that belongs to them, and
  // it is what their AP matches against internally. An AP clerk who cannot find their own number
  // on our invoice has been handed something harder to process than what it replaced.
  //
  // Claim-time value (ledger.customer_reference) — the LIST carries it, the detail does not.
  // Four slots. CARRIER displaces Consignee (decided 2026-08-03): the reader is an AP clerk, and
  // carrier is where claims and tracking start — the one field they cannot derive from anything
  // else in the email body or on the hosted page. The consignee's NAME is recoverable from the
  // attached PDF, and now lives in the footer; the carrier is recoverable from nowhere else.
  // The fourth slot stays the CUSTOMER's reference — the only field on the invoice that is theirs.
  //
  // THE FOURTH FIELD IS CONDITIONAL ON CLASSIFICATION (spec §5.31).
  // On a REBILL it points at the invoice being supplemented. `Your Ref #` is duplicated from the
  // primary, so on a rebill it tells the clerk nothing they do not already have on the invoice
  // they filed; the original invoice number is the ONLY thing on a rebill not recoverable from
  // anything else on the page. On a PRIMARY there is no original to point at, so `Your Ref #`
  // stays — swapping it there would lose the customer's own reference for nothing.
  //
  // Labelled "Original Invoice" so it reads as a POINTER, never as this invoice's own number.
  const originalPointer = classification === 'rebill' ? customerVisibleNumber(primaryInvoiceNumber) : null;
  const fourth = originalPointer
    ? customField('Original Invoice', originalPointer)
    // OMIT, not quarantine, when a rebill has no derivable original: the invoice is otherwise
    // complete and correct, and withholding a valid bill over a pointer field would be worse than
    // shipping it without one. Falls back to the customer's reference rather than an empty slot.
    : customField('Your Ref #', customerReference);

  const custom_fields = [
    customField('BOL #', detail.shipment.BOLNumber),
    customField('PRO #', detail.shipment.carrierPRO),
    customField('Carrier', booking && booking.carrier ? booking.carrier.name : null),
    fourth,
  ].filter(Boolean);

  const memoOut = buildMemo({ disputeNotice, supportEmail, supportPhone, documentsUrl });

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
      // §5.5 — renders in email, PDF and hosted page.
      description: memoOut.memo,
      // PDF-only surface (§5.4).
      footer: buildFooter(booking),
    },

    lines,

    // Not lines. §5.1 keeps these off the invoice; where their descriptions go (folded into the
    // freight line on a primary, memo context on a rebill) is decided by the classifier, which is
    // §4.3 and NOT BUILT. Carried out here rather than guessed at.
    zero_dollar_descriptions: zeroDollarDescriptions,
  };

  if (unusable.length) payload._unusable_lines = unusable;

  // EVERY reason, not just the last one. A single overwritten field hides the other blockers and
  // makes clearing one look like clearing all of them.
  const blockers = [];
  payload.classification = classification;
  payload.zero_dollar_placement = zeroDollarPlacement;
  if (rebillContext) payload.rebill_context = rebillContext;

  // §5.5 fails closed: a missing dispute notice blocks SENDING, exactly like an unverified
  // recipient. The payload still builds so it can be read.
  if (!memoOut.noticeSupplied) blockers.push({ reason: 'missing_dispute_notice', addresses: [] });
  if (memoOut.length > MEMO_MAX) blockers.push({ reason: 'memo_over_limit', addresses: [`${memoOut.length}/${MEMO_MAX}`] });

  // Recipient verification (spec §5.6). Unverified addresses do not block BUILDING — the payload
  // still needs reviewing — but they must block SENDING. assertSendable() is the hard gate.
  const unverified = unverifiedRecipients(payload.customer_ref, verifiedRecipients);
  if (unverified.length) blockers.push({ reason: 'unverified_recipient', addresses: unverified });

  if (blockers.length) {
    payload.send_blocked = {
      reason: blockers.map(b => b.reason).join(' + '),
      addresses: blockers.flatMap(b => b.addresses),
      all: blockers,
    };
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
