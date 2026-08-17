// PIECE (iii) — THE WIRE (Phase 1, deliver-and-inform).
//
//     node --test invoice-sync/test/invoice-recipient.test.mjs
//
// NO NETWORK. Composition only: invoice detail → customerInfo.customerId → console record →
// the precedence rule. Every part is already tested in its own file; what is tested HERE is the
// joining of them, which is where two specific things can go wrong:
//
//   1. THE MEMO. One customer can carry many invoices in a window. Without a per-run memo that is
//      one console call per invoice; with a memo that outlives the run it is a stale recipient.
//      The lifetime is exactly one invocation, and both halves of that are asserted.
//
//   2. PARTIAL RESULTS. A refusal at ANY stage must arrive as a refusal. The failure this guards
//      is not an exception — it is a half-built object with a `to` of `[undefined]`, which sends.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InvoiceRecipients } from '../src/invoice-recipient.js';
import { RECIPIENT_SOURCES } from '../src/recipient.js';
import { SHAPE_DRIFT_REF } from '../src/console-lookup.js';
import { REFUSAL_REASONS, allow, refuse } from '../src/refusals.js';
import { Ledger } from '../src/ledger.js';
import { newValueSink, formatEmailDrops } from '../src/detail.js';
import { ANY_AR, onlyAr, freshDb } from './helpers.mjs';

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────

/** A narrowed invoice detail, trimmed to what the wire reads. */
const invoice = (invoiceId, customerId) => ({
  invoiceId, invoiceNumber: `INV-${invoiceId}`,
  customerInfo: customerId === null ? null : { customerId, customerCode: '2395' },
});

const consoleRecord = (id, over = {}) => ({
  success: 'true',
  data: {
    id, customerId: '17', accountingId: '2395', ARCode: '2395', name: 'Bison Office LLC',
    remitToSL: '0', email: 'shipping@bisoncommerce.com', billingEmail: 'accounting@bisoncommerce.com',
    accountingContacts: [], ...over,
  },
});

/** A session stub. `calls` is the whole point — the memo is proven by counting them. */
function fakeSession(handler) {
  const calls = [];
  return {
    calls,
    async post(action, params) {
      calls.push({ action, recordId: params.recordId });
      return typeof handler === 'function' ? handler(params.recordId) : handler;
    },
  };
}

const val = r => { assert.equal(r.ok, true, `expected success, got refusal ${r.reason}`); return r.value; };
const no = r => { assert.equal(r.ok, false, 'expected a refusal'); return r; };

// ── the happy path ───────────────────────────────────────────────────────────────────────────

test('detail → customerId → record → the precedence rule', async () => {
  const s = fakeSession(allow({ json: consoleRecord('123301') }));
  const r = val(await new InvoiceRecipients(s, ANY_AR).forInvoice(invoice('I1', '123301')));

  assert.deepEqual(r.to, ['accounting@bisoncommerce.com']);
  assert.equal(r.source, RECIPIENT_SOURCES.BILLING_EMAIL);
  assert.equal(r.customerId, '123301');
  assert.equal(r.arCode, '2395');
  assert.deepEqual(s.calls, [{ action: 'getShippingLocation', recordId: '123301' }]);
});

// ── the memo ─────────────────────────────────────────────────────────────────────────────────

test('THE MEMO: the same customer twice in one run is ONE console call', async () => {
  const s = fakeSession(allow({ json: consoleRecord('123301') }));
  const rs = new InvoiceRecipients(s, ANY_AR);

  const a = val(await rs.forInvoice(invoice('I1', '123301')));
  const b = val(await rs.forInvoice(invoice('I2', '123301')));

  assert.equal(s.calls.length, 1, 'the second invoice must not re-read the console');
  assert.deepEqual(a.to, b.to);
  assert.equal(a.source, b.source);
});

test('different customers are fetched separately', async () => {
  const s = fakeSession(id => allow({ json: consoleRecord(id) }));
  const rs = new InvoiceRecipients(s, ANY_AR);
  await rs.forInvoice(invoice('I1', '123301'));
  await rs.forInvoice(invoice('I2', '646664'));
  await rs.forInvoice(invoice('I3', '123301'));
  assert.deepEqual(s.calls.map(c => c.recordId), ['123301', '646664']);
});

test('THE MEMO DIES WITH THE RUN — a new instance re-reads the console', async () => {
  // The whole reason a record cache was rejected: ops edit billing emails, and a memo that
  // outlived the invocation would send to a superseded address with nothing saying so.
  const s = fakeSession(allow({ json: consoleRecord('123301') }));
  await new InvoiceRecipients(s, ANY_AR).forInvoice(invoice('I1', '123301'));
  await new InvoiceRecipients(s, ANY_AR).forInvoice(invoice('I2', '123301'));
  assert.equal(s.calls.length, 2, 'a second run must not inherit the first run\'s record');
});

test('a REFUSAL is not memoised — a transient outage must not go sticky for the whole run', async () => {
  // Memoising the failure would make one blip permanent for every remaining invoice of that
  // customer. The cost of not memoising is one extra call per invoice on a genuinely broken
  // record, which at pilot volume is nothing.
  let attempt = 0;
  const s = fakeSession(() => (++attempt === 1
    ? refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'request', status: 502 })
    : allow({ json: consoleRecord('123301') })));
  const rs = new InvoiceRecipients(s, ANY_AR);

  no(await rs.forInvoice(invoice('I1', '123301')));
  const second = val(await rs.forInvoice(invoice('I2', '123301')));
  assert.deepEqual(second.to, ['accounting@bisoncommerce.com']);
  assert.equal(s.calls.length, 2);
});

// ── refusals propagate, never a partial recipient ────────────────────────────────────────────

test('a LOOKUP refusal propagates unchanged, with no recipient anywhere in it', async () => {
  const s = fakeSession(refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'session' }));
  const r = no(await new InvoiceRecipients(s, ANY_AR).forInvoice(invoice('I1', '123301')));
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED);
  assert.equal(r.detail.stage, 'session');
  assert.equal(r.value, undefined, 'a refusal must not carry a value');
  assert.ok(!JSON.stringify(r).includes('@'));
});

test('a RECORD refusal propagates unchanged', async () => {
  const s = fakeSession(allow({ json: { success: 'true', message: 'No results.', data: [] } }));
  const r = no(await new InvoiceRecipients(s, ANY_AR).forInvoice(invoice('I1', '999')));
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED);
  assert.equal(r.detail.reason, 'no_record');
});

test('a RULE refusal propagates — an unreadable remitToSL never becomes a guess', async () => {
  const s = fakeSession(allow({ json: consoleRecord('123301', { remitToSL: '' }) }));
  const r = no(await new InvoiceRecipients(s, ANY_AR).forInvoice(invoice('I1', '123301')));
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_SOURCE_UNKNOWN);
  assert.ok(!JSON.stringify(r).includes('@'), 'neither address may leak through the refusal');
});

test('an out-of-bound customer refuses, and the console was still only read once', async () => {
  const s = fakeSession(allow({ json: consoleRecord('123301') }));
  const r = no(await new InvoiceRecipients(s, onlyAr('1234')).forInvoice(invoice('I1', '123301')));
  assert.equal(r.reason, REFUSAL_REASONS.NOT_ALLOWLISTED);
  assert.ok(!JSON.stringify(r).includes('@'));
});

test('NO customerId ON THE INVOICE: refuses without touching the console', async () => {
  // customerInfo is optional on the detail (§0.2 demoted it), so this is a real data condition
  // rather than a programming error — and there is nothing to look up.
  const s = fakeSession(allow({ json: consoleRecord('123301') }));
  const rs = new InvoiceRecipients(s, ANY_AR);

  for (const detail of [invoice('I1', null), invoice('I2', undefined), invoice('I3', '')]) {
    const r = no(await rs.forInvoice(detail));
    assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED);
    assert.equal(r.detail.reason, 'customer_id_missing');
  }
  assert.equal(s.calls.length, 0, 'nothing to look up means nothing is looked up');
});

// ── the exception queue ──────────────────────────────────────────────────────────────────────

test('a refusal is recorded under the ref exceptionRefFor derives', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const s = fakeSession(allow({ json: { success: 'true', message: 'No results.', data: [] } }));

  await new InvoiceRecipients(s, ANY_AR, { ledger }).forInvoice(invoice('I1', '999'));

  const rows = db.rows('SELECT kind, ref, seen_count FROM exceptions');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED);
  assert.equal(rows[0].ref, 'sl:999');
});

test('systemic drift across many customers stays ONE queue row', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const s = fakeSession(id => allow({ json: consoleRecord(id, { accountingContacts: undefined }) }));
  const rs = new InvoiceRecipients(s, ANY_AR, { ledger });

  for (const id of ['1', '2', '3', '4']) await rs.forInvoice(invoice(`I${id}`, id));

  const rows = db.rows('SELECT ref, seen_count FROM exceptions');
  assert.equal(rows.length, 1, 'one upstream change is one row');
  assert.equal(rows[0].ref, SHAPE_DRIFT_REF);
  assert.equal(rows[0].seen_count, 4);
});

test('a successful resolution records NOTHING', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const s = fakeSession(allow({ json: consoleRecord('123301') }));
  await new InvoiceRecipients(s, ANY_AR, { ledger }).forInvoice(invoice('I1', '123301'));
  assert.equal(db.count('exceptions'), 0);
});

test('the ledger is OPTIONAL — resolution works without a queue', async () => {
  // Unlike the allowlist, an absent ledger is not a safety property: it costs a queue row, not a
  // bound. The live check (piece iv) resolves without one.
  const s = fakeSession(allow({ json: consoleRecord('123301') }));
  assert.equal((await new InvoiceRecipients(s, ANY_AR).forInvoice(invoice('I1', '123301'))).ok, true);
});

test('a recording failure never takes down a resolution', async () => {
  const brokenLedger = { recordException: async () => { throw new Error('D1 unavailable'); } };
  const s = fakeSession(allow({ json: { success: 'true', data: [] } }));
  const r = no(await new InvoiceRecipients(s, ANY_AR, { ledger: brokenLedger }).forInvoice(invoice('I1', '999')));
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, 'the refusal survives');
});

// ── threading ────────────────────────────────────────────────────────────────────────────────

test('the value sink is threaded through to the parser', async () => {
  const sink = newValueSink();
  const s = fakeSession(allow({ json: consoleRecord('123301', { billingEmail: 'ap@bison, accounting@bisoncommerce.com' }) }));
  const r = val(await new InvoiceRecipients(s, ANY_AR, { sink }).forInvoice(invoice('I1', '123301')));
  assert.deepEqual(r.to, ['accounting@bisoncommerce.com']);
  assert.ok(formatEmailDrops(sink).some(l => l.startsWith('email.dropped.no_dotted_domain')));
});

test('the allowlist is required here too', () => {
  assert.throws(() => new InvoiceRecipients(fakeSession(null)), /allowlist/i);
});
