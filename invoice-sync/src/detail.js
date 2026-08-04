// The fetch boundary (spec §6.1).
//
// The invoice detail response carries carrier cost, negotiated discounts (e.g. "DISCOUNT 94.00%"),
// and per-shipment gross profit. "Build the Stripe payload by explicit assignment" is necessary and
// NOT sufficient: it leaves those fields sitting in scope, one careless edit away from a customer.
//
// So the narrowing happens HERE, the moment the response lands. Nothing downstream — not the
// mapper, not the logger, not an error handler — is ever handed an object that contains them.
//
// THE BOUNDARY IS AN ALLOWLIST, NOT A DENYLIST. Listing known-bad fields only excludes the hazards
// that existed when the list was written; a field Primus adds next quarter passes a denylist
// unnoticed and reaches Stripe. Every narrowed object is therefore sealed against an exported
// field list — exact key-set equality, enforced at runtime, not merely asserted in a test.
//
// Rules for editing this file:
//   * Build by explicit assignment. NEVER spread the source object.
//   * Adding a field means adding it to the *_FIELDS constant too — otherwise narrowing throws.
//     That is the point: widening the boundary is a deliberate, visible act.
//   * If you cannot say why a customer may see a field, leave it out.

import { findRecord, describeShape } from './envelope.js';

// ── the allowlists ───────────────────────────────────────────────────────────────────────────
// Single source of truth, imported by BOTH the narrowing code below and the tests. A test that
// declared its own copy would only prove the code agrees with the test, not that either is right.

export const CUSTOMER_INFO_FIELDS = Object.freeze([
  'customerId', 'customerName', 'customerCode', 'creditStatus',
]);

export const BREAKDOWN_LINE_FIELDS = Object.freeze([
  'code', 'description', 'qty', 'rate', 'total',
]);

export const STATUS_FIELDS = Object.freeze([
  'generated', 'sent', 'paid',
]);

export const SHIPMENT_FIELDS = Object.freeze([
  'BOLId', 'BOLNumber', 'carrierPRO', 'shipperName', 'consigneeName', 'totalWeight', 'totalPieces',
]);

export const DETAIL_FIELDS = Object.freeze([
  'invoiceId', 'invoiceNumber', 'ARCode', 'total', 'invoiceTermsCode', 'issueDate',
  'invoiceDueDate', 'invoiceRemarks', 'status', 'shipment', 'customerInfo', 'invoiceBreakdown',
  '_sourceKeys',
]);

/**
 * Hazards this boundary exists to keep out. Kept for documentation — it names WHY the allowlist is
 * strict — but it is NOT the enforcement mechanism. Enforcement is key-set equality above.
 */
export const BANNED_FIELDS = Object.freeze([
  'costBreakdown',        // carrier cost
  'payableBreakdown',     // carrier payables
  'profitSummary',        // cost, sell, profit, GP%
  'invoiceInternalRemarks',
]);

/**
 * Seal an object against its allowlist: the key set must match EXACTLY.
 *
 * The two failure directions get distinct messages on purpose — "a field leaked out" and "the
 * narrowing stopped producing a field" are different bugs with different urgency, and a shared
 * message would make them indistinguishable in a failing test run.
 *
 * @throws on any extra key, and separately on any missing key.
 */
export function assertExactKeys(obj, allowlist, what) {
  const keys = Object.keys(obj);
  const allow = new Set(allowlist);

  const extra = keys.filter(k => !allow.has(k)).sort();
  if (extra.length) {
    throw new Error(`${what}: key(s) not on the allowlist: ${extra.join(', ')}`);
  }

  const present = new Set(keys);
  const missing = allowlist.filter(k => !present.has(k)).sort();
  if (missing.length) {
    throw new Error(`${what}: allowlist key(s) missing: ${missing.join(', ')}`);
  }

  return obj;
}

// ── narrowing ────────────────────────────────────────────────────────────────────────────────

/**
 * customerInfo, narrowed.
 *
 * `customerId` is a stable Primus-internal customer key. NOTE: it is NOT the portal's
 * `primusCustomerId` — verified 2026-08-03, Haynes returns 646664 where the portal stores
 * 1123086640. Carried through as-is; nothing here translates between the two.
 * `customerCode` is the ARCode and must agree with the list response; a disagreement means the
 * two responses describe different customers and is never reconciled by guessing.
 */
export function narrowCustomerInfo(ci) {
  if (!ci || typeof ci !== 'object') return null;
  return assertExactKeys({
    customerId: ci.customerId ?? null,
    customerName: ci.customerName ?? null,
    customerCode: ci.customerCode ?? null,
    creditStatus: ci.creditStatus ?? null,
  }, CUSTOMER_INFO_FIELDS, 'customerInfo');
}

/**
 * One invoiceBreakdown line, narrowed. Amounts stay raw; §5.1 decides what becomes a Stripe line.
 *
 * TRAP FOR §5.1 — two doors, and the zero-line rule has to close both.
 *
 * 1. NULL. `null == 0` is false but `null >= 0` is true, so a null total classifies as a
 *    zero-dollar line under one comparison and a priced line under the other, and BOTH read as
 *    reasonable code.
 *
 * 2. STRING. Line amounts are NOT confirmed to be numbers (never observed live as of 2026-08-03),
 *    and Primus type consistency is unverified. If a total ever arrives as a string, `"0" == 0`
 *    and `"0.00" == 0` are both true — accidentally correct — but `"$0.00" == 0` is false, so a
 *    formatted zero silently becomes a PRICED line on a customer's invoice.
 *
 * So §5.1 must, in this order: reject null/undefined, then TYPE-CHECK, then normalise through the
 * same `toCents()` used by the poll (it strips `$` and commas), then compare on integer cents.
 * Never `total == 0` against a raw field value.
 *
 * Note `''` is already caught upstream: an empty-string total is a REQUIRED-value violation and
 * quarantines the invoice before §5.1 sees it. That ordering is load-bearing — `'' == 0` is true,
 * so an empty string reaching a coercion-based rule would read as a zero-dollar line.
 */
export function narrowBreakdownLine(l) {
  if (!l || typeof l !== 'object') return null;
  return assertExactKeys({
    code: l.code ?? null,
    description: l.description ?? null,
    qty: l.qty ?? null,
    rate: l.rate ?? null,
    total: l.total ?? null,
  }, BREAKDOWN_LINE_FIELDS, 'invoiceBreakdown line');
}

/**
 * Narrow a full invoice detail response.
 *
 * @param {object} body the raw response (or its `data` envelope)
 * @returns {object} a new object whose key set equals DETAIL_FIELDS exactly
 */
export function narrowInvoiceDetail(body) {
  // Located by content, not position: the detail endpoint nests the invoice at data.results
  // (verified live 2026-08-03), and reading the wrong level silently yields a record of nulls
  // rather than an error.
  const d = findRecord(body, 'invoiceId');
  if (!d || typeof d !== 'object') throw new Error(`Unrecognised Primus invoice detail envelope: ${describeShape(body)}`);

  const sh = d.shipment || {};

  const status = assertExactKeys({
    generated: !!(d.status && d.status.generated),
    sent: !!(d.status && d.status.sent),
    paid: !!(d.status && d.status.paid),
  }, STATUS_FIELDS, 'status');

  const shipment = assertExactKeys({
    BOLId: sh.BOLId ?? null,
    BOLNumber: sh.BOLNumber ?? null,
    carrierPRO: sh.carrierPRO ?? null,
    shipperName: sh.shipperName ?? null,
    consigneeName: sh.consigneeName ?? null,
    totalWeight: sh.totalWeight ?? null,
    totalPieces: sh.totalPieces ?? null,
  }, SHIPMENT_FIELDS, 'shipment');

  return assertExactKeys({
    invoiceId: d.invoiceId ?? null,
    invoiceNumber: d.invoiceNumber ?? null,

    // ARCode is on the LIST response but NOT on the detail — confirmed by hasOwnProperty on the
    // raw record, 2026-08-03. Carried
    // through as whatever the detail says (normally null) and NOT derived from
    // customerInfo.customerCode: a second derivation path can only ever disagree silently, and the
    // §1 claim that the two are equal is an unverified assertion about Primus.
    //
    // The authoritative ARCode is the one CLAIMED from the list response and stored on the ledger
    // row. The mapper gates on that (src/mapper.js), which is why this is not a required value.
    ARCode: d.ARCode ?? null,
    total: d.total ?? null,
    invoiceTermsCode: d.invoiceTermsCode ?? null,
    issueDate: d.issueDate ?? null,
    invoiceDueDate: d.invoiceDueDate ?? null,

    // Customer-facing by policy, internal by habit — ops paste carrier cost and shorthand into it.
    // Carried through, but §6.2 gates it before it can ever reach a customer unreviewed.
    invoiceRemarks: d.invoiceRemarks ?? null,

    status,
    shipment,

    // Key names of the source record — diagnostic only, never a payload field. Envelope and field
    // naming have both already drifted from the documented shape once; this makes the next drift
    // legible instead of silently narrowing to nulls.
    _sourceKeys: describeShape(d),

    customerInfo: narrowCustomerInfo(d.customerInfo),
    invoiceBreakdown: Array.isArray(d.invoiceBreakdown)
      ? d.invoiceBreakdown.map(narrowBreakdownLine).filter(Boolean)
      : [],
  }, DETAIL_FIELDS, 'invoice detail');
}

// ── value-level requirements ─────────────────────────────────────────────────────────────────
//
// SEPARATE MECHANISM from assertExactKeys, deliberately. Those two guard different failures:
//
//   missing KEY   → structural. Narrowing assigns every key unconditionally with `?? null`, so a
//                   key can only vanish if someone edits this file. That is a code regression and
//                   it throws, everywhere, both directions. Unchanged.
//   null VALUE    → a data gap in Primus. Never throws. One bad record must not stop 1,749 good
//                   ones, so the invoice is quarantined and the run continues.
//
// Conflating them was the trap: "customer has no phone" is a null value, and no key-level rule
// would ever have caught it.

/** Fields whose NULL VALUE means: do not bill this invoice. Everything else is optional. */
export const REQUIRED_VALUES = Object.freeze({
  // ARCode deliberately ABSENT: the detail response does not carry it (verified live 2026-08-03).
  // It is required to bill, but sourced from the ledger's claimed value and gated in the mapper —
  // requiring it here would quarantine every invoice.
  detail: Object.freeze(['invoiceId', 'invoiceNumber', 'total', 'status', 'shipment', 'invoiceBreakdown']),
  status: Object.freeze(['generated', 'paid']),
  shipment: Object.freeze(['BOLNumber']),
  customerInfo: Object.freeze(['customerCode']),
  breakdownLine: Object.freeze(['description', 'total']),
});

/** Diagnostic fields that must never be assigned into a Stripe object. Import, don't remember. */
export const NON_PAYLOAD_FIELDS = Object.freeze(['_sourceKeys']);

/**
 * Missing means null, undefined, or empty string — NOT 0 and NOT false.
 *
 * A `total` of 0 is a real amount and a `generated` of false is a real answer. Treating either as
 * missing would quarantine correct records; this is the same coercion trap §5.1 has to avoid.
 */
export function isMissingValue(v) {
  return v === null || v === undefined || v === '';
}

/** Per-run counter. Created per run and threaded explicitly — a module global would accumulate
 *  across invocations in a warm isolate and silently inflate (spec §0.25). */
export function newValueSink() {
  return {
    records: 0,
    fields: Object.create(null),
    // Email-address drops get their OWN denominator. Drops happen once per customer resolution,
    // not once per invoice, so sharing `records` would produce a rate that looks precise and means
    // nothing.
    emailParses: 0,
    emailDrops: Object.create(null),
  };
}

/** "shipment.carrierPRO: 412/1750 (23.5%)" — a rate, so 1-in-1000 → 400-in-1000 is obvious. */
export function formatValueSink(sink) {
  const n = (sink && sink.records) || 0;
  return Object.entries((sink && sink.fields) || {})
    .sort((a, b) => b[1] - a[1])
    .map(([field, count]) => `${field}: ${count}/${n}${n ? ` (${((count / n) * 100).toFixed(1)}%)` : ''}`);
}

function countOptional(sink, path) {
  if (!sink) return;
  sink.fields[path] = (sink.fields[path] || 0) + 1;
}

/**
 * Record a discarded email token, by reason.
 *
 * "Dropped" and "never existed" are indistinguishable downstream: a typo like `ap@paylessrugs`
 * (no TLD) drops silently and the invoice quietly reaches one fewer person, with nothing anywhere
 * saying so. A rate moving from 0 to 40 is the signal.
 */
export function countEmailDrop(sink, reason) {
  if (!sink) return;
  sink.emailDrops[reason] = (sink.emailDrops[reason] || 0) + 1;
}

export function countEmailParse(sink) {
  if (!sink) return;
  sink.emailParses++;
}

/** "email.dropped.no_dotted_domain: 2/11 (18.2%)" — its own denominator, not the record count. */
export function formatEmailDrops(sink) {
  const n = (sink && sink.emailParses) || 0;
  return Object.entries((sink && sink.emailDrops) || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `email.dropped.${reason}: ${count}/${n}${n ? ` (${((count / n) * 100).toFixed(1)}%)` : ''}`);
}

/**
 * Audit a narrowed detail's VALUES. Never throws.
 *
 * @returns {{missingRequired: string[], ok: boolean}} missingRequired lists dotted paths; a
 *   non-empty list means quarantine this one invoice and carry on with the run.
 */
export function auditValues(narrowed, sink = null) {
  const missingRequired = [];
  if (sink) sink.records++;

  const scan = (obj, boundary, allowlist, prefix) => {
    if (!obj) return;
    const required = REQUIRED_VALUES[boundary] || [];
    for (const field of allowlist) {
      if (!isMissingValue(obj[field])) continue;
      const path = prefix ? `${prefix}.${field}` : field;
      if (required.includes(field)) missingRequired.push(path);
      else countOptional(sink, path);
    }
  };

  scan(narrowed, 'detail', DETAIL_FIELDS, '');
  scan(narrowed.status, 'status', STATUS_FIELDS, 'status');
  scan(narrowed.shipment, 'shipment', SHIPMENT_FIELDS, 'shipment');

  // customerInfo is OPTIONAL as a whole (demoted by §0.2 — ARCode is the customer key). Its own
  // required field only applies once the object exists.
  if (narrowed.customerInfo) scan(narrowed.customerInfo, 'customerInfo', CUSTOMER_INFO_FIELDS, 'customerInfo');

  // An EMPTY invoiceBreakdown is treated as missing. `isMissingValue([])` is false, so without
  // this the "invoiceBreakdown required" rule would be vacuous — an invoice with no lines has
  // nothing to bill.
  if (Array.isArray(narrowed.invoiceBreakdown) && narrowed.invoiceBreakdown.length === 0) {
    missingRequired.push('invoiceBreakdown[] (empty)');
  }
  (narrowed.invoiceBreakdown || []).forEach((line, i) => {
    scan(line, 'breakdownLine', BREAKDOWN_LINE_FIELDS, `invoiceBreakdown[${i}]`);
  });

  return { missingRequired, ok: missingRequired.length === 0 };
}

/**
 * Fetch and narrow in one step, so no caller ever holds the raw body.
 *
 * Deliberately not two exported functions: a `fetchDetail` that returned the raw object would be
 * the obvious thing to reach for, and the boundary would erode on the first hurried edit.
 */
export async function fetchInvoiceDetail(primus, invoiceId) {
  const body = await primus.get(`/invoice/${encodeURIComponent(invoiceId)}`);
  return narrowInvoiceDetail(body);
}
