// Spec phase 4 — customer resolution, and the §6.1 fetch boundary it depends on.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger } from '../src/ledger.js';
import {
  displayNameMatchesArCode, pickQboCustomer, parseEmails, narrowQboCustomer,
  customerCacheKey, resolveCustomer, resolveClaimedCustomers,
} from '../src/customers.js';
import {
  narrowInvoiceDetail, narrowCustomerInfo, narrowBreakdownLine, assertExactKeys,
  DETAIL_FIELDS, CUSTOMER_INFO_FIELDS, BREAKDOWN_LINE_FIELDS, STATUS_FIELDS, SHIPMENT_FIELDS,
  REQUIRED_VALUES, NON_PAYLOAD_FIELDS, auditValues, isMissingValue,
  newValueSink, formatValueSink,
} from '../src/detail.js';
import { freshDb } from './helpers.mjs';

// ── the fetch boundary (§6.1) ────────────────────────────────────────────────────────────────

/** A detail response carrying every internal field, as the live API returns it. */
function rawDetail(over = {}) {
  return {
    data: {
      invoiceId: '1591052345',
      invoiceNumber: '140488.0',
      ARCode: '5406',
      total: 300.93,
      issueDate: '2026-07-15',
      invoiceDueDate: '2026-08-14',
      invoiceRemarks: 'Delivered to dock',
      status: { generated: true, sent: true, paid: false },
      shipment: { BOLNumber: '160133377', carrierPRO: 'PRO9', consigneeName: 'A Customer' },
      // 701567 is Payless's REAL customerInfo.customerId. Deliberately not 1123086640 — that is
      // the portal's primusCustomerId for a different customer entirely, and a different id space.
      customerInfo: { customerId: 701567, customerName: 'Payless Rugs', customerCode: '5406', creditStatus: 'OK' },
      invoiceBreakdown: [{ code: 'FRT', description: 'Freight', qty: 1, rate: 300.93, total: 300.93 }],

      // Everything below must never cross the boundary.
      costBreakdown: [{ code: 'CARRIER', description: 'DISCOUNT 94.00%', total: 41.2 }],
      payableBreakdown: [{ carrier: 'Some Carrier', amount: 41.2 }],
      profitSummary: { cost: 41.2, sell: 300.93, profit: 259.73, gpPercent: 86.3 },
      invoiceInternalRemarks: 'rebill customer, our cost was 41.20',
      ...over,
    },
  };
}

// ── key-set equality at every narrowing boundary ─────────────────────────────────────────────
//
// These replace an "are the four known-bad fields absent?" assertion. That was a denylist wearing
// an allowlist's clothes: a field Primus adds next quarter passes it and reaches Stripe.
//
// The allowlists are imported from src/detail.js — the SAME constants the narrowing code seals
// against. A local copy here would only prove the test agrees with itself.

test('the narrowed detail key set equals DETAIL_FIELDS exactly', () => {
  const n = narrowInvoiceDetail(rawDetail());
  assert.deepEqual(Object.keys(n).sort(), [...DETAIL_FIELDS].sort());
});

test('the narrowed status key set equals STATUS_FIELDS exactly', () => {
  const n = narrowInvoiceDetail(rawDetail());
  assert.deepEqual(Object.keys(n.status).sort(), [...STATUS_FIELDS].sort());
});

test('the narrowed shipment key set equals SHIPMENT_FIELDS exactly', () => {
  const n = narrowInvoiceDetail(rawDetail());
  assert.deepEqual(Object.keys(n.shipment).sort(), [...SHIPMENT_FIELDS].sort());
});

test('the narrowed customerInfo key set equals CUSTOMER_INFO_FIELDS exactly', () => {
  const n = narrowInvoiceDetail(rawDetail());
  assert.deepEqual(Object.keys(n.customerInfo).sort(), [...CUSTOMER_INFO_FIELDS].sort());
});

test('every narrowed breakdown line key set equals BREAKDOWN_LINE_FIELDS exactly', () => {
  const n = narrowInvoiceDetail(rawDetail({
    invoiceBreakdown: [
      { code: 'FRT', description: 'Freight', qty: 1, rate: 300.93, total: 300.93, carrierCost: 41.2 },
      { code: 'LFD', description: 'Liftgate', qty: 1, rate: 0, total: 0, marginPct: 86.3 },
    ],
  }));
  assert.equal(n.invoiceBreakdown.length, 2);
  for (const line of n.invoiceBreakdown) {
    assert.deepEqual(Object.keys(line).sort(), [...BREAKDOWN_LINE_FIELDS].sort());
  }
});

test('an unknown field on the source never reaches the narrowed object', () => {
  // The case a denylist misses entirely: a field nobody has heard of yet.
  const n = narrowInvoiceDetail(rawDetail({ someFieldPrimusAddsNextQuarter: 'carrier cost 41.20' }));
  assert.deepEqual(Object.keys(n).sort(), [...DETAIL_FIELDS].sort());
  assert.ok(!JSON.stringify(n).includes('carrier cost 41.20'));
});

// ── negative controls, both directions ───────────────────────────────────────────────────────

test('NEGATIVE: an extra key fails, naming it', () => {
  assert.throws(
    () => assertExactKeys({ code: 1, description: 2, qty: 3, rate: 4, total: 5, carrierCost: 41.2 },
      BREAKDOWN_LINE_FIELDS, 'invoiceBreakdown line'),
    /invoiceBreakdown line: key\(s\) not on the allowlist: carrierCost/
  );
});

test('NEGATIVE: a missing key fails with a DISTINCT message', () => {
  // Must be distinguishable from the extra-key failure in a test run: "a field leaked out" and
  // "the narrowing stopped producing a field" are different bugs.
  assert.throws(
    () => assertExactKeys({ code: 1, description: 2, qty: 3, rate: 4 },
      BREAKDOWN_LINE_FIELDS, 'invoiceBreakdown line'),
    /invoiceBreakdown line: allowlist key\(s\) missing: total/
  );
});

test('NEGATIVE: the two failure messages do not overlap', () => {
  const grab = fn => { try { fn(); return ''; } catch (e) { return e.message; } };
  const extra = grab(() => assertExactKeys({ generated: 1, sent: 1, paid: 1, refunded: 1 }, STATUS_FIELDS, 'status'));
  const missing = grab(() => assertExactKeys({ generated: 1, sent: 1 }, STATUS_FIELDS, 'status'));

  assert.match(extra, /not on the allowlist/);
  assert.match(missing, /allowlist key\(s\) missing/);
  assert.ok(!extra.includes('missing'), `extra-key message must not read as missing: ${extra}`);
  assert.ok(!missing.includes('not on the allowlist'), `missing-key message must not read as extra: ${missing}`);
});

test('POSITIVE: an exactly-matching key set passes', () => {
  const obj = { code: 1, description: 2, qty: 3, rate: 4, total: 5 };
  assert.equal(assertExactKeys(obj, BREAKDOWN_LINE_FIELDS, 'invoiceBreakdown line'), obj);
});

test('the seal is enforced at runtime, not only in tests', () => {
  // narrowBreakdownLine seals its own output, so a future edit that adds a field without adding it
  // to the constant throws in production rather than shipping quietly.
  const line = narrowBreakdownLine({ code: 'FRT', description: 'Freight', qty: 1, rate: 1, total: 1, costEach: 0.4 });
  assert.deepEqual(Object.keys(line).sort(), [...BREAKDOWN_LINE_FIELDS].sort());
});

test('the allowlists are frozen', () => {
  // A mutable allowlist could be widened at runtime by any importer, which would defeat the seal.
  for (const [name, list] of Object.entries({
    DETAIL_FIELDS, CUSTOMER_INFO_FIELDS, BREAKDOWN_LINE_FIELDS, STATUS_FIELDS, SHIPMENT_FIELDS,
  })) {
    assert.ok(Object.isFrozen(list), `${name} must be frozen`);
  }
});

// ── value-level rule: null values, separate from the key-level seal ──────────────────────────
//
// The two mechanisms guard different failures. Key-level throws on a code regression. Value-level
// never throws — one bad record must not stop 1,749 good ones.

test('a null REQUIRED value does NOT throw — it reports for quarantine', () => {
  const audit = auditValues(narrowInvoiceDetail(rawDetail({ invoiceNumber: null, total: null })));
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.missingRequired.sort(), ['invoiceNumber', 'total']);
});

test('a null OPTIONAL value does not throw and does not quarantine', () => {
  const audit = auditValues(narrowInvoiceDetail(rawDetail({ invoiceRemarks: null, invoiceTermsCode: null })));
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.missingRequired, []);
});

test('a null OPTIONAL value increments the counter', () => {
  const sink = newValueSink();
  auditValues(narrowInvoiceDetail(rawDetail({ invoiceRemarks: null })), sink);
  auditValues(narrowInvoiceDetail(rawDetail({ invoiceRemarks: null })), sink);
  auditValues(narrowInvoiceDetail(rawDetail()), sink);

  assert.equal(sink.records, 3);
  assert.equal(sink.fields.invoiceRemarks, 2);
});

test('the counter reports a RATE, so a 1-in-1000 → 400-in-1000 shift is obvious', () => {
  const sink = newValueSink();
  for (let i = 0; i < 4; i++) auditValues(narrowInvoiceDetail(rawDetail({ invoiceRemarks: null })), sink);
  for (let i = 0; i < 6; i++) auditValues(narrowInvoiceDetail(rawDetail()), sink);

  const lines = formatValueSink(sink);
  assert.ok(lines.some(l => l === 'invoiceRemarks: 4/10 (40.0%)'), lines.join(' | '));
});

test('an unknown key still throws even while null values do not', () => {
  // The two rules coexist: a leak fails closed, a data gap does not.
  assert.throws(() => assertExactKeys({ generated: 1, sent: 1, paid: 1, extra: 1 }, STATUS_FIELDS, 'status'),
    /not on the allowlist/);
  assert.equal(auditValues(narrowInvoiceDetail(rawDetail({ carrierPRO: null }))).ok, true);
});

test('0 and false are values, not missing', () => {
  // Coercion trap: treating either as absent would quarantine correct records.
  assert.equal(isMissingValue(0), false);
  assert.equal(isMissingValue(false), false);
  assert.equal(isMissingValue(null), true);
  assert.equal(isMissingValue(undefined), true);
  assert.equal(isMissingValue(''), true);

  const audit = auditValues(narrowInvoiceDetail(rawDetail({ total: 0, status: { generated: true, paid: false } })));
  assert.equal(audit.ok, true, 'a $0 total and paid:false must not quarantine');
});

test('a null line total is reported required — the §5.1 coercion trap', () => {
  // null == 0 is false but null >= 0 is true, so a null total classifies as zero-dollar under one
  // comparison and priced under the other, and both read as reasonable.
  assert.equal(null == 0, false);
  assert.equal(null >= 0, true);

  const audit = auditValues(narrowInvoiceDetail(rawDetail({
    invoiceBreakdown: [{ code: 'FRT', description: 'Freight', qty: 1, rate: null, total: null }],
  })));
  assert.equal(audit.ok, false);
  assert.ok(audit.missingRequired.includes('invoiceBreakdown[0].total'));
});

test('an empty invoiceBreakdown quarantines — otherwise the requirement is vacuous', () => {
  const audit = auditValues(narrowInvoiceDetail(rawDetail({ invoiceBreakdown: [] })));
  assert.equal(audit.ok, false);
  assert.ok(audit.missingRequired.includes('invoiceBreakdown[] (empty)'));
});

test('a missing customerInfo is optional as a whole, per the ARCode decision', () => {
  // §0.2 keys Stripe customers on ARCode, so customerInfo is metadata and its absence is not
  // grounds to withhold a bill.
  const audit = auditValues(narrowInvoiceDetail(rawDetail({ customerInfo: undefined })));
  assert.equal(audit.ok, true);
});

test('a null customerCode inside a present customerInfo IS required', () => {
  const audit = auditValues(narrowInvoiceDetail(rawDetail({ customerInfo: { customerId: 646664 } })));
  assert.equal(audit.ok, false);
  assert.ok(audit.missingRequired.includes('customerInfo.customerCode'));
});

test('every REQUIRED_VALUES entry is a real key on its allowlist', () => {
  // Guards a typo silently disabling a requirement — the rule would pass forever and never fire.
  const lists = {
    detail: DETAIL_FIELDS, status: STATUS_FIELDS, shipment: SHIPMENT_FIELDS,
    customerInfo: CUSTOMER_INFO_FIELDS, breakdownLine: BREAKDOWN_LINE_FIELDS,
  };
  for (const [boundary, required] of Object.entries(REQUIRED_VALUES)) {
    for (const f of required) {
      assert.ok(lists[boundary].includes(f), `REQUIRED_VALUES.${boundary} names "${f}", absent from its allowlist`);
    }
  }
});

test('REQUIRED_VALUES holds exactly 13 fields and is frozen', () => {
  // A COUNT, deliberately not a retyped copy of the list — a second copy would only prove the test
  // agrees with itself. This catches accidental widening without duplicating the source of truth.
  const total = Object.values(REQUIRED_VALUES).reduce((n, l) => n + l.length, 0);
  assert.equal(total, 13);
  assert.ok(Object.isFrozen(REQUIRED_VALUES));
  for (const [k, list] of Object.entries(REQUIRED_VALUES)) {
    assert.ok(Object.isFrozen(list), `REQUIRED_VALUES.${k} must be frozen`);
  }
});

test('_sourceKeys is declared non-payload', () => {
  assert.ok(NON_PAYLOAD_FIELDS.includes('_sourceKeys'));
  assert.ok(DETAIL_FIELDS.includes('_sourceKeys'), 'it is on the allowlist — the seal must expect it');
  assert.ok(Object.isFrozen(NON_PAYLOAD_FIELDS));
});

test('no margin figure survives narrowing, anywhere in the object', () => {
  // Belt and braces: a nested field added later could reintroduce cost data without tripping the
  // top-level key check above.
  const serialized = JSON.stringify(narrowInvoiceDetail(rawDetail()));
  for (const leak of ['DISCOUNT 94.00%', '86.3', '259.73', 'our cost was', 'Some Carrier']) {
    assert.ok(!serialized.includes(leak), `narrowed object leaked: ${leak}`);
  }
});

test('_sourceKeys carries key names only, never values', () => {
  // It is a diagnostic, and it sits on an object that phase 5 maps to a customer-facing invoice.
  // Key names are safe; a value from costBreakdown would not be.
  const k = narrowInvoiceDetail(rawDetail())._sourceKeys;
  assert.match(k, /^\{[a-zA-Z,]+\}$/, `expected key names only, got: ${k}`);
  for (const leak of ['94.00', '259.73', '41.2', 'Payless']) assert.ok(!k.includes(leak));
});

test('narrowing keeps what the invoice actually needs', () => {
  const n = narrowInvoiceDetail(rawDetail());
  assert.equal(n.invoiceId, '1591052345');
  assert.equal(n.ARCode, '5406');
  assert.equal(n.total, 300.93);
  assert.equal(n.shipment.BOLNumber, '160133377');
  assert.equal(n.customerInfo.customerId, 701567);
  assert.equal(n.invoiceBreakdown.length, 1);
  assert.equal(n.invoiceRemarks, 'Delivered to dock');
});

test('narrowing accepts a bare (un-enveloped) detail body', () => {
  assert.equal(narrowInvoiceDetail(rawDetail().data).invoiceId, '1591052345');
});

test('narrowing finds the invoice nested at data.results — the live detail shape', () => {
  // Verified live 2026-08-03: /invoice/{id} returns {data:{results:{…invoice…},message}}, one
  // level deeper than the list-endpoint field documentation implies.
  const nested = { data: { results: rawDetail().data, message: 'ok' } };
  const n = narrowInvoiceDetail(nested);
  assert.equal(n.invoiceId, '1591052345');
  assert.equal(n.customerInfo.customerId, 701567);
});

test('narrowing locates the record by content, not by position', () => {
  // Reading the wrong nesting level yields an object full of undefined, which narrows to a record
  // of nulls and reads as "a customer with no data" instead of failing. requireKey prevents that.
  const decoys = { data: { results: { message: 'ok', page: 1 }, data: rawDetail().data } };
  assert.equal(narrowInvoiceDetail(decoys).invoiceId, '1591052345');
});

test('narrowing throws when no record carries an invoiceId', () => {
  assert.throws(() => narrowInvoiceDetail({ data: { results: { message: 'not found' } } }),
    /Unrecognised Primus invoice detail envelope/);
});

test('narrowing never returns the source object itself', () => {
  // A returned reference would let a later mutation reach the banned fields.
  const raw = rawDetail();
  const n = narrowInvoiceDetail(raw);
  assert.notEqual(n, raw.data);
  assert.notEqual(n.customerInfo, raw.data.customerInfo);
  assert.notEqual(n.invoiceBreakdown[0], raw.data.invoiceBreakdown[0]);
});

test('status is coerced to real booleans', () => {
  const n = narrowInvoiceDetail(rawDetail({ status: { generated: 'yes', paid: 1 } }));
  assert.equal(n.status.generated, true);
  assert.equal(n.status.paid, true);
  assert.equal(n.status.sent, false);
});

test('a missing customerInfo narrows to null rather than throwing', () => {
  assert.equal(narrowCustomerInfo(undefined), null);
  assert.equal(narrowInvoiceDetail(rawDetail({ customerInfo: undefined })).customerInfo, null);
});

// ── DisplayName matching ─────────────────────────────────────────────────────────────────────

test('the ARCode suffix must match exactly, not merely end the string', () => {
  assert.equal(displayNameMatchesArCode('Payless Rugs-5406', '5406'), true);
  assert.equal(displayNameMatchesArCode('Bison Office LLC-2395', '2395'), true);

  // endsWith() would bill Acme for Payless's freight.
  assert.equal(displayNameMatchesArCode('Acme-15406', '5406'), false);
  assert.equal(displayNameMatchesArCode('Acme-54060', '5406'), false);
  assert.equal(displayNameMatchesArCode('Payless Rugs', '5406'), false);
  assert.equal(displayNameMatchesArCode('', '5406'), false);
  assert.equal(displayNameMatchesArCode('Acme-5406', null), false);
});

test('a hyphenated company name still matches on the final segment', () => {
  assert.equal(displayNameMatchesArCode('Smith-Jones Furniture-5406', '5406'), true);
});

test('matching tolerates case and surrounding whitespace', () => {
  assert.equal(displayNameMatchesArCode('Acme- ab12 ', 'AB12'), true);
});

// ── picking from a fuzzy search ──────────────────────────────────────────────────────────────

test('exactly one suffix match is chosen, extras ignored', () => {
  const r = pickQboCustomer(
    [{ DisplayName: 'Unrelated 5406 Holdings' }, { DisplayName: 'Payless Rugs-5406' }],
    '5406'
  );
  assert.equal(r.ok, true);
  assert.equal(r.record.DisplayName, 'Payless Rugs-5406');
});

test('no suffix match is a recorded failure, never the first result', () => {
  const r = pickQboCustomer([{ DisplayName: 'Some Other Co-9999' }], '5406');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_display_name_suffix');
});

test('two suffix matches are ambiguous, not a tie to break', () => {
  const r = pickQboCustomer([{ DisplayName: 'A-5406' }, { DisplayName: 'B-5406' }], '5406');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous');
});

test('an empty or non-array search result does not throw', () => {
  assert.equal(pickQboCustomer([], '5406').ok, false);
  assert.equal(pickQboCustomer(null, '5406').ok, false);
});

// ── emails ───────────────────────────────────────────────────────────────────────────────────

test('comma-separated addresses split into primary plus CC', () => {
  const e = parseEmails('nickz@paylessrugs.com,ap@paylessrugs.com');
  assert.equal(e.primary, 'nickz@paylessrugs.com');
  assert.deepEqual(e.cc, ['ap@paylessrugs.com']);
});

test('whitespace and junk entries are dropped', () => {
  const e = parseEmails(' a@x.com , , b@y.com ,notanemail');
  assert.equal(e.primary, 'a@x.com');
  assert.deepEqual(e.cc, ['b@y.com']);
});

test('a missing address yields no recipients', () => {
  for (const v of [null, undefined, '', '   ']) {
    const e = parseEmails(v);
    assert.equal(e.primary, null);
    assert.deepEqual(e.cc, []);
  }
});

test('the QBO record narrows to routing fields only', () => {
  const n = narrowQboCustomer({
    Id: '58', DisplayName: 'Payless Rugs-5406',
    PrimaryEmailAddr: { Address: 'a@x.com,b@y.com' },
    BillAddr: { Line1: '1 Main', City: 'LA', CountrySubDivisionCode: 'CA', PostalCode: '90001' },
    Balance: 1234.56, SalesTermRef: { value: '3' },
  });
  assert.equal(n.qboId, '58');
  assert.equal(n.primaryEmail, 'a@x.com');
  assert.deepEqual(n.ccEmails, ['b@y.com']);
  assert.equal(n.billAddr.state, 'CA');
  assert.equal(n.Balance, undefined, 'AR balance is not needed to send an invoice');
});

// ── resolution ───────────────────────────────────────────────────────────────────────────────

function fakeCustomerApi({ qboRows, detail, onCall } = {}) {
  const calls = [];
  return {
    calls,
    async get(path, params) {
      calls.push({ path, params });
      if (onCall) onCall(path, params);
      if (path === '/quickbooks/customers') return { data: { results: qboRows ?? [] } };
      if (path.startsWith('/invoice/')) return detail ?? rawDetail();
      throw new Error(`unexpected path ${path}`);
    },
  };
}

const QBO_OK = [{
  Id: '58', DisplayName: 'Payless Rugs-5406',
  PrimaryEmailAddr: { Address: 'nickz@paylessrugs.com,ap@paylessrugs.com' },
  BillAddr: { Line1: '1 Main', City: 'LA', CountrySubDivisionCode: 'CA', PostalCode: '90001' },
}];

test('a resolvable ARCode yields both halves of the join', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = fakeCustomerApi({ qboRows: QBO_OK });

  const r = await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1591052345' });
  assert.equal(r.displayName, 'Payless Rugs-5406');
  assert.equal(r.primaryEmail, 'nickz@paylessrugs.com');
  assert.deepEqual(r.ccEmails, ['ap@paylessrugs.com']);
  assert.equal(r.primusCustomerId, 701567);
  assert.equal((await ledger.openExceptions()).length, 0);
});

test('a resolved customer is cached and not re-fetched', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = fakeCustomerApi({ qboRows: QBO_OK });

  await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1' });
  const before = primus.calls.length;
  const again = await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1' });

  assert.equal(primus.calls.length, before, 'cache hit must issue no subrequests');
  assert.equal(again.primusCustomerId, 701567);
});

test('an expired cache entry is refetched', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = fakeCustomerApi({ qboRows: QBO_OK });

  const t0 = 1_000_000;
  await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1', now: t0 });
  const before = primus.calls.length;
  await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1', now: t0 + 25 * 3600 * 1000 });
  assert.ok(primus.calls.length > before);
});

test('an unmatched ARCode resolves to null and records an exception', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = fakeCustomerApi({ qboRows: [{ DisplayName: 'Someone Else-9999' }] });

  const r = await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1' });
  assert.equal(r, null, 'never guess at a match');
  const ex = await ledger.openExceptions();
  assert.equal(ex[0].kind, 'unmatched_ar_code');
  assert.match(ex[0].detail, /suffix/);
});

test('an ambiguous ARCode resolves to null', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = fakeCustomerApi({ qboRows: [{ DisplayName: 'A-5406' }, { DisplayName: 'B-5406' }] });
  assert.equal(await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1' }), null);
  assert.match((await ledger.openExceptions())[0].detail, /2 QBO customers/);
});

test('a QBO customer with no email cannot be billed', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = fakeCustomerApi({ qboRows: [{ Id: '1', DisplayName: 'Payless Rugs-5406' }] });
  assert.equal(await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1' }), null);
  assert.match((await ledger.openExceptions())[0].detail, /PrimaryEmailAddr/);
});

test('a list/detail customerCode disagreement is never reconciled by preference', async () => {
  // The two responses describe different customers. Picking either one would bill on an assumption
  // that has just been shown to be false.
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = fakeCustomerApi({
    qboRows: QBO_OK,
    detail: rawDetail({ customerInfo: { customerId: '999', customerCode: '2395' } }),
  });

  assert.equal(await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1' }), null);
  assert.match((await ledger.openExceptions())[0].detail, /customerCode 2395 != list ARCode 5406/);
});

test('a failed QBO lookup records the error without an upstream body', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = { async get() { throw new Error('Primus GET /quickbooks/customers failed: HTTP 503'); } };

  assert.equal(await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1' }), null);
  assert.match((await ledger.openExceptions())[0].detail, /HTTP 503/);
});

test('resolution is per distinct customer, not per invoice', async () => {
  // The subrequest budget (spec §3.2) does not survive per-invoice resolution at full-book scale.
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  for (const id of ['a', 'b', 'c', 'd']) {
    await ledger.claim({ primusInvoiceId: id, arCode: '5406', bolNumber: `B${id}`, totalCents: 100 });
  }
  const primus = fakeCustomerApi({ qboRows: QBO_OK });

  const s = await resolveClaimedCustomers({ primus, db, ledger });
  assert.equal(s.customers, 1);
  assert.equal(s.resolved, 1);
  assert.equal(s.withPrimusId, 1);
  assert.equal(s.detail[0].invoices, 4);
  assert.equal(primus.calls.length, 2, 'one QBO search + one detail call for four invoices');
});

test('the resolution summary carries identity only — no amounts', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  await ledger.claim({ primusInvoiceId: 'a', arCode: '5406', bolNumber: 'B1', totalCents: 123456 });
  const s = await resolveClaimedCustomers({ primus: fakeCustomerApi({ qboRows: QBO_OK }), db, ledger });

  const serialized = JSON.stringify(s);
  assert.ok(!serialized.includes('123456'), 'summary must not carry invoice amounts');
  assert.ok(!serialized.includes('@'), 'summary must not carry email addresses');
});

test('one unresolvable customer does not stop the others', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  await ledger.claim({ primusInvoiceId: 'a', arCode: '5406', bolNumber: 'B1', totalCents: 100 });
  await ledger.claim({ primusInvoiceId: 'b', arCode: '2395', bolNumber: 'B2', totalCents: 100 });

  const primus = {
    async get(path, params) {
      if (path === '/quickbooks/customers') {
        return { data: { results: params.name === '5406' ? QBO_OK : [{ DisplayName: 'Nope-0000' }] } };
      }
      return rawDetail();
    },
  };

  const s = await resolveClaimedCustomers({ primus, db, ledger });
  assert.equal(s.customers, 2);
  assert.equal(s.resolved, 1);
  assert.equal(s.unresolved, 1);
});

test('the live QBO envelope nests the array one level deeper than /invoice', async () => {
  // Observed 2026-08-03: {data:{results:{customers:[…]},message}} — /invoice puts the array at
  // data.results, this endpoint puts a container there.
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = {
    async get(path) {
      if (path === '/quickbooks/customers') return { data: { results: { customers: QBO_OK }, message: 'ok' } };
      return rawDetail();
    },
  };
  const r = await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1' });
  assert.equal(r.displayName, 'Payless Rugs-5406');
  assert.equal(r.primusCustomerId, 701567);
});

test('descending is refused when more than one property is an array', async () => {
  // Two candidate arrays is ambiguous. Better to fail the match than pick one.
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = {
    async get(path) {
      if (path === '/quickbooks/customers') return { data: { results: { customers: QBO_OK, vendors: [] } } };
      return rawDetail();
    },
  };
  assert.equal(await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1' }), null);
});

test('a single-record QBO search response resolves like a list', async () => {
  // Live shape 2026-08-03: /quickbooks/customers answers a one-hit search with an OBJECT at
  // data.results, not an array of one.
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = {
    async get(path) {
      if (path === '/quickbooks/customers') return { data: { results: QBO_OK[0], message: 'ok' } };
      return rawDetail();
    },
  };
  const r = await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1' });
  assert.equal(r.displayName, 'Payless Rugs-5406');
  assert.equal(r.primusCustomerId, 701567);
});

test('an unwrappable object fails the suffix check instead of billing someone', async () => {
  // Both envelope fallbacks (descend, or treat-as-single-record) are only safe because the
  // DisplayName match is strict. This pins that: an object that is neither a list container nor a
  // customer record must produce an exception, never a match.
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = {
    async get(path) {
      if (path === '/quickbooks/customers') return { data: { results: { status: 'ok', count: 0 } } };
      return rawDetail();
    },
  };
  assert.equal(await resolveCustomer({ primus, db, ledger, arCode: '5406', sampleInvoiceId: '1' }), null);
  assert.equal((await ledger.openExceptions())[0].kind, 'unmatched_ar_code');
});

test('the customer cache key is not mode-namespaced', () => {
  // Upstream QBO data is identical in test and live, and a customer record cannot suppress a live
  // create the way a ledger row can.
  assert.equal(customerCacheKey('5406'), 'qbo:ar:5406');
  assert.equal(customerCacheKey(' 5406 '), 'qbo:ar:5406');
});
