// Spec §6.1 — the BOOKING narrowing boundary, and §5.3 aggregation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  narrowBooking, assertBookingClean, auditBookingValues, summariseFreight,
  BOOKING_FIELDS, BOOKING_PARTY_FIELDS, BOOKING_CARRIER_FIELDS,
  BOOKING_PICKUP_FIELDS, BOOKING_DELIVERY_FIELDS, BOOKING_FREIGHT_FIELDS,
  BOOKING_HOSTILE, COMMODITY_LIST_MAX,
} from '../src/booking.js';

/** The live BOL 160133377 record, including every hostile field it really carries. */
function rawBooking(over = {}) {
  return {
    data: {
      results: {
        BOLId: 1907194205,
        BOLNumber: '160133377',
        shipmentMode: 'LTL',
        totalWeight: 82,
        totalPieces: 1,
        freightInfo: [{ qty: 1, weight: 82, length: 97, width: 8, height: 8, class: 70,
                        volume: 3.59, STC: '', UN: '', UNPKGGroup: '', commodity: 'rug',
                        dimType: 'OTH', nmfc: '', hazmat: false, overrideClass: false }],
        trackingInformation: { pickupDateEstimated: '2026-06-22', deliveryDateActual: '2026-07-09 00:00:00',
                               lastStatusExternal: 'POD', lastStatusInternal: 'POD' },
        pickupInformation: { timeFrom: '09:00:00', timeTo: '14:00:00', appointmentNeeded: false },
        shipper: { id: 1385472288, name: 'Momeni Rugs', city: 'ADAIRSVILLE', state: 'GA', zipCode: '30103', phone: '(404) 767-5320' },
        consignee: { id: null, name: 'Megan Cappiello', city: 'BALDWIN PLACE', state: 'NY', zipCode: '10505', referenceNumber: '129320' },

        // ── every one of these is REAL on the live record, and detail.js's BANNED_FIELDS
        //    matches NOT ONE of their names.
        vendor: { id: 1747236260, name: 'Pilot Freight Services', SCAC: 'PAAF', cost: 273.57,
                  quoteNumber: '77935982', serviceLevel: 'Hd basic - signature release',
                  laneDistance: 916, rateType: 'GUARANTEED', PRO: '402052249' },
        accountingInformation: { costQuoteId: 1443678960, costQuoteNumber: 456477896, costQuoteAmount: 0,
                                 customerQuoteAmount: 300.93, GPEstimated: 9.09181, GPActual: 9.74313,
                                 profitUSDEstimated: 27.36, profitUSDActual: 29.32 },
        contactInformation: { office: { id: 0 }, controlUser: { id: 1463096523 } },
        ...over,
      },
    },
  };
}

// ── the seal ─────────────────────────────────────────────────────────────────────────────────

test('key sets equal their allowlists exactly, at every level', () => {
  const b = narrowBooking(rawBooking());
  assert.deepEqual(Object.keys(b).sort(), [...BOOKING_FIELDS].sort());
  assert.deepEqual(Object.keys(b.shipper).sort(), [...BOOKING_PARTY_FIELDS].sort());
  assert.deepEqual(Object.keys(b.consignee).sort(), [...BOOKING_PARTY_FIELDS].sort());
  assert.deepEqual(Object.keys(b.carrier).sort(), [...BOOKING_CARRIER_FIELDS].sort());
  assert.deepEqual(Object.keys(b.pickup).sort(), [...BOOKING_PICKUP_FIELDS].sort());
  assert.deepEqual(Object.keys(b.delivery).sort(), [...BOOKING_DELIVERY_FIELDS].sort());
  assert.deepEqual(Object.keys(b.freight[0]).sort(), [...BOOKING_FREIGHT_FIELDS].sort());
});

test('THE WORKED EXAMPLE — carrier cost and margin never cross the boundary', () => {
  // vendor.cost 273.57 against a 300.93 customer invoice IS the entire margin, and it sits one
  // property away from vendor.name, which §5.3 needs.
  //
  // Scanned WITHOUT _sourceKeys, deliberately. That field truthfully records the source record's
  // key NAMES — including "accountingInformation" — and a name is not a value. Blinding it would
  // destroy the drift detection it exists for. It never reaches Stripe: it is on
  // NON_PAYLOAD_FIELDS and assertPayloadClean rejects any key called _sourceKeys (pinned below).
  const { _sourceKeys, ...payloadBearing } = narrowBooking(rawBooking());
  const s = JSON.stringify(payloadBearing);
  for (const leak of ['273.57', '9.74313', '29.32', '27.36', '1443678960', '456477896',
                      'cost', 'GPActual', 'profitUSD', 'accountingInformation', 'laneDistance']) {
    assert.ok(!s.includes(leak), `booking leaked: ${leak}`);
  }
  assert.equal(narrowBooking(rawBooking()).carrier.name, 'Pilot Freight Services', 'but the name we need survives');
});

test('_sourceKeys stays truthful — names only, no VALUES', () => {
  const k = narrowBooking(rawBooking())._sourceKeys;
  assert.match(k, /accountingInformation/, 'it must still record the real shape');
  for (const value of ['273.57', '9.74313', '29.32', 'Pilot Freight', 'Megan']) {
    assert.ok(!k.includes(value), `_sourceKeys leaked a VALUE: ${value}`);
  }
});

test("detail.js's BANNED_FIELDS would have caught NONE of them", () => {
  // The reason this boundary needs its own list — and the reason both are allowlists.
  const detailBanned = ['costBreakdown', 'payableBreakdown', 'profitSummary', 'invoiceInternalRemarks'];
  const bookingHazards = ['vendor.cost', 'accountingInformation.GPActual', 'profitUSDActual', 'costQuoteAmount'];
  for (const h of bookingHazards) {
    assert.ok(!detailBanned.some(b => h.includes(b)), `${h} is not matched by any invoice-detail banned name`);
  }
});

test('an unknown field on the source never reaches the narrowed booking', () => {
  const b = narrowBooking(rawBooking({ someFieldPrimusAddsNextQuarter: 'carrier cost 273.57' }));
  assert.deepEqual(Object.keys(b).sort(), [...BOOKING_FIELDS].sort());
  assert.ok(!JSON.stringify(b).includes('273.57'));
});

test('NEGATIVE CONTROL — the scan CATCHES a planted hostile NAME', () => {
  // Asserting 273.57 is absent only proves the scan ran on clean data. This proves it fires.
  assert.throws(() => assertBookingClean({ carrier: { name: 'X', cost: 273.57 } }), /hostile field: cost/);
  assert.throws(() => assertBookingClean({ a: { accountingInformation: {} } }), /hostile field/);
  assert.doesNotThrow(() => assertBookingClean({ BOLNumber: '1', carrier: { name: 'X' } }));
});

test('NEGATIVE CONTROL — the scan CATCHES a planted hostile VALUE under an ALLOWED key', () => {
  // The case the seal CANNOT catch: a future edit writing `serviceLevel: v.cost`. The key is on
  // the allowlist, so assertExactKeys passes and a name-only scan passes. Only a VALUE scan fires.
  const source = rawBooking().data.results;
  const planted = { BOLNumber: '160133377', carrier: { name: 'Pilot Freight Services', serviceLevel: 273.57 } };
  assert.throws(() => assertBookingClean(planted, source), /hostile VALUE: 273\.57/);

  // And the margin percentage, planted somewhere equally innocent.
  assert.throws(() => assertBookingClean({ mode: '9.74313' }, source), /hostile VALUE: 9\.74313/);

  // Clean payload against the same source must NOT fire — otherwise the scan is just noise.
  assert.doesNotThrow(() => assertBookingClean(
    { BOLNumber: '160133377', carrier: { name: 'Pilot Freight Services', serviceLevel: 'Hd basic - signature release' } },
    source));
});

test('the VALUE scan is what narrowBooking actually runs — not an opt-in', () => {
  // narrowBooking passes the source through, so a real record is scanned both ways every time.
  assert.doesNotThrow(() => narrowBooking(rawBooking()));
  // A source whose carrier NAME is literally the cost value: narrowing copies it to an allowed key,
  // and the value scan is the only thing between that and a customer invoice.
  const evil = rawBooking();
  evil.data.results.vendor.name = '273.57';
  assert.throws(() => narrowBooking(evil), /hostile VALUE: 273\.57/);
});

test('the booking is located by content, not position', () => {
  assert.equal(narrowBooking(rawBooking()).BOLNumber, '160133377');
  assert.equal(narrowBooking(rawBooking().data.results).BOLNumber, '160133377', 'bare record too');
  assert.throws(() => narrowBooking({ data: { results: { message: 'not found' } } }), /Unrecognised Primus booking envelope/);
});

test('every allowlist is frozen', () => {
  for (const [n, l] of Object.entries({ BOOKING_FIELDS, BOOKING_PARTY_FIELDS, BOOKING_CARRIER_FIELDS,
    BOOKING_PICKUP_FIELDS, BOOKING_DELIVERY_FIELDS, BOOKING_FREIGHT_FIELDS, BOOKING_HOSTILE })) {
    assert.ok(Object.isFrozen(l), `${n} must be frozen`);
  }
});

// ── §5.3 aggregation ─────────────────────────────────────────────────────────────────────────

test('AGGREGATES across all items — BOL 160134786, the case that would have shipped wrong', () => {
  // Two real items: 64 lbs Class 70 and 112 lbs Class 85. Reading [0] alone would have printed
  // "82 lbs · Class 70" on a shipment that is 176 lbs across two classes.
  const f = summariseFreight([
    { qty: 1, weight: 64, class: 70, commodity: 'rug' },
    { qty: 1, weight: 112, class: 85, commodity: 'rug' },
  ]);
  assert.equal(f.pieces, 2);
  assert.equal(f.weight, 176);
  assert.equal(f.classLabel, '70, 85');
  assert.equal(f.commodityLabel, 'Rug', 'identical commodities dedupe to one');
});

test('lists are ASCENDING regardless of array order — identical freight renders identically', () => {
  const a = summariseFreight([{ class: 85, commodity: 'sofa' }, { class: 70, commodity: 'rug' }]);
  const b = summariseFreight([{ class: 70, commodity: 'rug' }, { class: 85, commodity: 'sofa' }]);
  assert.equal(a.classLabel, '70, 85');
  assert.equal(b.classLabel, '70, 85');
  assert.equal(a.commodityLabel, b.commodityLabel);
  assert.equal(a.commodityLabel, 'Rug, Sofa');
});

test('class sorts NUMERICALLY, not as strings', () => {
  // "100" < "70" lexically. A string sort would print "100, 70".
  assert.equal(summariseFreight([{ class: 100 }, { class: 70 }]).classLabel, '70, 100');
});

test('a long commodity list collapses to a count', () => {
  const many = ['rug', 'sofa', 'table', 'lamp'].map(c => ({ qty: 1, weight: 10, class: 70, commodity: c }));
  assert.equal(summariseFreight(many).commodityLabel, '4 items');
  assert.equal(COMMODITY_LIST_MAX, 3);
  const three = many.slice(0, 3);   // rug, sofa, table
  assert.equal(summariseFreight(three).commodityLabel, 'Rug, Sofa, Table', 'at the threshold it still lists, sorted');
});

test('single item reproduces the originally accepted shape exactly', () => {
  const f = summariseFreight(narrowBooking(rawBooking()).freight);
  assert.equal(f.pieces, 1);
  assert.equal(f.weight, 82);
  assert.equal(f.classLabel, '70');
  assert.equal(f.commodityLabel, 'Rug');
});

test('empty or absent freight aggregates to nothing rather than throwing', () => {
  for (const v of [[], null, undefined]) {
    const f = summariseFreight(v);
    assert.equal(f.pieces, 0);
    assert.equal(f.classLabel, null);
    assert.equal(f.commodityLabel, null);
  }
});

// ── value audit ──────────────────────────────────────────────────────────────────────────────

test('empty freight quarantines — the rule is UNTESTED against real data', () => {
  // 0 of 11 pilot bookings had empty or absent freightInfo, so this has never fired in anger.
  const a = auditBookingValues(narrowBooking(rawBooking({ freightInfo: [] })));
  assert.equal(a.ok, false);
  assert.ok(a.missingRequired.includes('freight[] (empty)'));

  const b = auditBookingValues(narrowBooking(rawBooking({ freightInfo: undefined })));
  assert.equal(b.ok, false);
});

test('a complete booking passes the audit', () => {
  assert.equal(auditBookingValues(narrowBooking(rawBooking())).ok, true);
});

test('hazmat is carried but nothing renders it', () => {
  const b = narrowBooking(rawBooking({
    freightInfo: [{ qty: 1, weight: 82, class: 70, commodity: 'paint', hazmat: true }],
  }));
  assert.equal(b.freight[0].hazmat, true);
  assert.equal(summariseFreight(b.freight).hazmat, true, 'visible to a future decision');
});

test('NEGATIVE: the value scan does NOT fire on booleans — the live false-positive', () => {
  // accountingInformation.insuranceIncluded is `false` on the live record. Stringified it is
  // "false" (5 chars) and matched the narrowed `hazmat: false`, rejecting EVERY booking in the
  // pilot set. A scan broad enough to reject legitimate data is its own failure.
  const src = rawBooking().data.results;
  src.accountingInformation.insuranceIncluded = false;
  assert.doesNotThrow(() => narrowBooking({ data: { results: src } }));
  assert.equal(narrowBooking({ data: { results: src } }).freight[0].hazmat, false);
});

test('and it STILL fires on the real hostile values after that fix', () => {
  // The boolean skip must not have widened into a general escape hatch.
  const source = rawBooking().data.results;
  assert.throws(() => assertBookingClean({ mode: '273.57' }, source), /hostile VALUE: 273\.57/);
  assert.throws(() => assertBookingClean({ mode: '9.74313' }, source), /hostile VALUE/);
  assert.throws(() => assertBookingClean({ mode: 'GUARANTEED' }, source), /hostile VALUE/);
});

test('commodity is TITLE-CASED at render, and the raw value is untouched', () => {
  // Primus mixes "Area Rug", "rug", "table" across one customer's invoices.
  const f = summariseFreight([{ qty: 1, weight: 10, class: 70, commodity: 'Area Rug' },
                              { qty: 1, weight: 10, class: 70, commodity: 'table' }]);
  assert.equal(f.commodityLabel, 'Area Rug, Table');
  assert.deepEqual(f.commodities, ['Area Rug', 'table'], 'raw values unchanged — render-only');
});

test('title-casing does not defeat the dedupe', () => {
  // "rug" and "Rug" are the same commodity. A case-SENSITIVE key would render "Rug, Rug" once
  // both were title-cased — the fix has to be in the dedupe, not in the label.
  assert.equal(summariseFreight([{ commodity: 'rug' }, { commodity: 'Rug' }]).commodityLabel, 'Rug');
  assert.equal(summariseFreight([{ commodity: 'AREA RUG' }, { commodity: 'area rug' }]).commodityLabel, 'Area Rug');
});
