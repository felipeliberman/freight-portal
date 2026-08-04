// The BOOKING fetch boundary (spec §6.1) — a SECOND §6.1 boundary, with its own allowlists, its
// own seal, and its own hostile list.
//
// WHY IT CANNOT REUSE detail.js's BANNED_FIELDS — the worked example for allowlist-over-denylist:
//
//     $.vendor.cost                       273.57      <- carrier cost
//     $.vendor.name                       "Pilot Freight Services"   <- §5.3 needs this
//     $.accountingInformation.GPActual    9.74313     <- gross margin %
//     $.accountingInformation.profitUSDActual  29.32  <- margin in dollars
//
// The customer invoice for that shipment is $300.93. `vendor.cost` of $273.57 IS the entire margin,
// and it sits ONE PROPERTY AWAY from `vendor.name`, which the lane description needs. detail.js's
// BANNED_FIELDS — costBreakdown, payableBreakdown, profitSummary, invoiceInternalRemarks — matches
// NOT ONE of these names. A denylist written for the invoice detail is blind to every one of them.
//
// That is why the boundary is an allowlist: it does not need to know what the hazard is called.

import { findRecord, describeShape } from './envelope.js';

// ── allowlists ───────────────────────────────────────────────────────────────────────────────

export const BOOKING_PARTY_FIELDS = Object.freeze(['name', 'city', 'state']);
export const BOOKING_CARRIER_FIELDS = Object.freeze(['name', 'serviceLevel']);
export const BOOKING_PICKUP_FIELDS = Object.freeze(['dateEstimated', 'timeFrom', 'timeTo']);
export const BOOKING_DELIVERY_FIELDS = Object.freeze(['dateActual', 'status']);
export const BOOKING_FREIGHT_FIELDS = Object.freeze(['qty', 'weight', 'class', 'commodity', 'hazmat']);

export const BOOKING_FIELDS = Object.freeze([
  'BOLNumber', 'mode', 'totalWeight', 'totalPieces',
  'carrier', 'shipper', 'consignee', 'freight', 'pickup', 'delivery', '_sourceKeys',
]);

/**
 * Named for documentation and for the byte scan. NOT the enforcement mechanism — the allowlists
 * above are. Listed because naming the hazard is how the next reader understands why the seal is
 * strict, and because the byte scan needs concrete strings to look for.
 */
export const BOOKING_HOSTILE = Object.freeze([
  'accountingInformation', 'costQuoteId', 'costQuoteNumber', 'costQuoteAmount',
  'GPEstimated', 'GPActual', 'profitUSDEstimated', 'profitUSDActual',
  'cost', 'quoteNumber', 'laneDistance', 'rateType',
]);

/** Values whose NULL means: do not describe this shipment. */
export const BOOKING_REQUIRED_VALUES = Object.freeze({
  booking: Object.freeze(['BOLNumber', 'freight']),
});

function seal(obj, allowlist, what) {
  const keys = Object.keys(obj);
  const allow = new Set(allowlist);
  const extra = keys.filter(k => !allow.has(k)).sort();
  if (extra.length) throw new Error(`${what}: key(s) not on the allowlist: ${extra.join(', ')}`);
  const present = new Set(keys);
  const missing = allowlist.filter(k => !present.has(k)).sort();
  if (missing.length) throw new Error(`${what}: allowlist key(s) missing: ${missing.join(', ')}`);
  return obj;
}

function party(p) {
  const o = p || {};
  return seal({ name: o.name ?? null, city: o.city ?? null, state: o.state ?? null },
    BOOKING_PARTY_FIELDS, 'booking party');
}

/**
 * Narrow a booking record. Explicit assignment only — never a spread.
 *
 * Located by content (`BOLNumber`), not position, for the same reason as the invoice detail:
 * reading the wrong nesting level yields a record of nulls rather than an error.
 */
export function narrowBooking(body) {
  const d = findRecord(body, 'BOLNumber');
  if (!d || typeof d !== 'object') throw new Error(`Unrecognised Primus booking envelope: ${describeShape(body)}`);

  const v = d.vendor || {};
  const t = d.trackingInformation || {};
  const pu = d.pickupInformation || {};

  const carrier = seal({
    name: v.name ?? null,
    // serviceLevel and serviceLevelCode carry the same string on this tenant; take the readable one.
    serviceLevel: v.serviceLevel ?? null,
  }, BOOKING_CARRIER_FIELDS, 'booking carrier');

  const pickup = seal({
    dateEstimated: t.pickupDateEstimated ?? null,
    timeFrom: pu.timeFrom ?? null,
    timeTo: pu.timeTo ?? null,
  }, BOOKING_PICKUP_FIELDS, 'booking pickup');

  const delivery = seal({
    dateActual: t.deliveryDateActual ?? null,
    status: t.lastStatusExternal ?? null,
  }, BOOKING_DELIVERY_FIELDS, 'booking delivery');

  const freight = (Array.isArray(d.freightInfo) ? d.freightInfo : [])
    .filter(i => i && typeof i === 'object')
    .map(i => seal({
      qty: i.qty ?? null,
      weight: i.weight ?? null,
      class: i.class ?? null,
      commodity: i.commodity ?? null,
      // Present on every item observed (always false in the pilot set). Carried so a hazmat
      // shipment is visible to whoever decides whether to surface it; NOTHING renders it today.
      hazmat: !!i.hazmat,
    }, BOOKING_FREIGHT_FIELDS, 'booking freight item'));

  const out = seal({
    BOLNumber: d.BOLNumber ?? null,
    mode: d.shipmentMode ?? null,
    totalWeight: d.totalWeight ?? null,
    totalPieces: d.totalPieces ?? null,
    carrier,
    shipper: party(d.shipper),
    consignee: party(d.consignee),
    freight,
    pickup,
    delivery,
    _sourceKeys: describeShape(d),
  }, BOOKING_FIELDS, 'booking');

  // `d` passed so the scan learns the hostile VALUES from this record, not a hard-coded list.
  assertBookingClean(out, d);
  return out;
}

/** Every scalar under a hostile region of the SOURCE record — the actual values to keep out. */
function hostileValues(source) {
  const out = new Set();
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') return Object.values(v).forEach(walk);
    // BOOLEANS ARE NOT DATA. Skipping them by TYPE, before stringifying: on the live record
    // accountingInformation.insuranceIncluded is `false`, which stringifies to "false" (5 chars)
    // and then matched the narrowed `hazmat: false` — rejecting EVERY booking. A scan this broad
    // is a denial of service on legitimate data, which is its own kind of failure.
    if (typeof v === 'boolean') return;
    const s = String(v).trim();
    // Belt and braces for string-typed booleans and nulls, plus trivially-short values ("0", "")
    // that appear everywhere legitimately.
    if (s.length < 4) return;
    if (s === 'true' || s === 'false' || s === 'null' || s === 'undefined') return;
    out.add(s);
  };
  const src = source && typeof source === 'object' ? source : {};
  for (const [k, v] of Object.entries(src)) {
    if (BOOKING_HOSTILE.includes(k)) walk(v);
  }
  const vendor = src.vendor;
  if (vendor && typeof vendor === 'object') {
    for (const [k, v] of Object.entries(vendor)) {
      if (BOOKING_HOSTILE.includes(k)) walk(v);
    }
  }
  return out;
}

/**
 * Byte scan on the SERIALISED payload — names AND values.
 *
 * Serialised deliberately: a hostile value sitting somewhere the narrowing did not reach still
 * shows up in the bytes and nowhere else.
 *
 * NAMES alone are not enough. The seal already makes an unexpected KEY structurally impossible, so
 * the name scan is belt-and-braces. The case it CANNOT catch is a future edit assigning a hostile
 * VALUE to an ALLOWED key — `serviceLevel: v.cost` passes the seal and passes a name scan. That is
 * why `source` is passed: the values to exclude are read from the source's hostile regions rather
 * than hard-coded, so this works on every booking, not just the one it was written against.
 *
 * @param {object} narrowed the sealed output
 * @param {object} [source]  the raw record, used to learn which VALUES are hostile
 */
export function assertBookingClean(narrowed, source) {
  const s = JSON.stringify(narrowed);
  for (const k of BOOKING_HOSTILE) {
    if (s.includes(`"${k}"`)) throw new Error(`booking payload carries a hostile field: ${k}`);
  }
  if (source) {
    for (const v of hostileValues(source)) {
      if (s.includes(v)) throw new Error(`booking payload carries a hostile VALUE: ${v}`);
    }
  }
  return narrowed;
}

/** Audit booking VALUES. Never throws — quarantine is the caller's decision. */
export function auditBookingValues(narrowed) {
  const missingRequired = [];
  for (const f of BOOKING_REQUIRED_VALUES.booking) {
    const v = narrowed[f];
    if (v === null || v === undefined || v === '') missingRequired.push(f);
  }
  // An empty freight array cannot describe a shipment. UNTESTED against real data: 0 of 11 pilot
  // bookings had an empty or absent freightInfo, so this rule exists and has never fired.
  if (Array.isArray(narrowed.freight) && narrowed.freight.length === 0) {
    missingRequired.push('freight[] (empty)');
  }
  return { missingRequired, ok: missingRequired.length === 0 };
}

// ── aggregation (spec §5.3) ──────────────────────────────────────────────────────────────────

/** Deduped, ASCENDING. Order must not depend on array order, or identical freight renders two ways. */
function dedupeSorted(values, numeric) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    if (v === null || v === undefined || v === '') continue;
    const k = String(v).trim();
    if (!k) continue;
    // Case-INSENSITIVE for text: Primus writes "rug" and "Rug" for the same commodity, and a
    // case-sensitive key would render "Rug, Rug" once both are title-cased. First spelling wins.
    const key = numeric ? k : k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return numeric
    ? out.sort((a, b) => Number(a) - Number(b))
    : out.sort((a, b) => a.localeCompare(b));
}

/** "area RUG" -> "Area Rug". Render-only; never written back to the narrowed record. */
function titleCaseWords(v) {
  return String(v).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

/** Above this many distinct commodities the list is replaced by a count. */
export const COMMODITY_LIST_MAX = 3;

/**
 * Aggregate across ALL freight items — never element [0] alone.
 *
 * THE REASON, recorded because it would otherwise look like over-engineering: BOL 160134786 in the
 * pilot set has TWO items — 64 lbs Class 70 and 112 lbs Class 85. Reading [0] only would have
 * printed "82 lbs · Class 70" on a shipment that is actually 176 lbs across classes 70 and 85.
 * Wrong numbers on a customer invoice, and it would have passed every test we had.
 *
 * Weight and pieces SUM. Class does not average — there is no meaningful mean of 70 and 85 — so it
 * renders as a deduped ascending list. Commodity takes the same rule.
 */
export function summariseFreight(items) {
  const list = Array.isArray(items) ? items : [];
  const pieces = list.reduce((n, i) => n + (Number(i.qty) || 0), 0);
  const weight = list.reduce((n, i) => n + (Number(i.weight) || 0), 0);
  const classes = dedupeSorted(list.map(i => i.class), true);
  const commodities = dedupeSorted(list.map(i => i.commodity), false);
  return {
    pieces,
    weight,
    classes,
    commodities,
    // A long list stops informing and starts crowding the line.
    // TITLE-CASED AT RENDER ONLY — `commodities` above stays exactly as Primus returned it.
    // Primus mixes "Area Rug", "rug" and "table" on one customer's invoices; inconsistent casing
    // on a single document reads as carelessness. The faithful-mirror rule is untouched: it
    // protects amounts and the descriptions of CHARGES, and this is neither.
    commodityLabel: commodities.length === 0 ? null
      : commodities.length <= COMMODITY_LIST_MAX ? commodities.map(titleCaseWords).join(', ')
      : `${commodities.length} items`,
    classLabel: classes.length ? classes.join(', ') : null,
    hazmat: list.some(i => i.hazmat === true),
  };
}

export async function fetchBooking(primus, bolNumber) {
  const body = await primus.get(`/book/bolnumber/${encodeURIComponent(bolNumber)}`);
  return narrowBooking(body);
}
