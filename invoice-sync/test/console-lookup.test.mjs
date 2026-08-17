// PIECE (ii) — THE CUSTOMER RECORD LOOKUP (Phase 1, deliver-and-inform).
//
//     node --test invoice-sync/test/console-lookup.test.mjs
//
// NO NETWORK. The session is a stub honouring ConsoleSession's contract, so this file tests the
// ENVELOPE and the JOIN, not the transport — that is piece (i)'s file.
//
// ── WHAT THE CONSOLE ACTUALLY RETURNS FOR AN ID THAT DOES NOT EXIST (measured 2026-08-16) ────
//
//   valid record   → HTTP 200, success "true", NO message,      data = { id, accountingId, … }
//   unknown id     → HTTP 200, success "true", message "No results.", data = []
//
// THREE TRAPS IN ONE RESPONSE, and every test below exists for one of them:
//
//   1. `success` is the STRING "true" in BOTH cases. It says nothing about whether a record came
//      back, so validity can never be read from it.
//   2. The empty case is an empty ARRAY, and `typeof [] === 'object'` is TRUE. A guard written as
//      `typeof data === 'object'` admits the hollow record, whose every field is `undefined`.
//   3. HTTP 200 throughout. Nothing about the status distinguishes a real record from no record.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchCustomerRecord, narrowConsoleRecord, CONSOLE_RECORD_FIELDS, SHIPPING_LOCATION_ACTION,
  exceptionRefFor, SHAPE_DRIFT_REF,
} from '../src/console-lookup.js';
import { resolveRecipient, RECIPIENT_SOURCES } from '../src/recipient.js';
import { REFUSAL_REASONS, allow, refuse } from '../src/refusals.js';
import { Ledger } from '../src/ledger.js';
import { ANY_AR, freshDb } from './helpers.mjs';

// ── the real shapes ──────────────────────────────────────────────────────────────────────────

/** A live record (Bison, ARCode 2395 — billing override active), trimmed to what arrives. */
const BISON_RAW = Object.freeze({
  id: '123301', customerId: '17', accountingId: '2395', ARCode: '2395',
  name: 'Bison Office LLC',
  remitToSL: '0',
  email: 'shipping@bisoncommerce.com',
  billingEmail: 'accounting@bisoncommerce.com',
  accountingContacts: [],
  // Present on the real record and deliberately NOT wanted downstream:
  creditLimit: '50000', creditBalance: '12345.67', creditStatus: 'A',
  taxID: '12-3456789', EINNumber: '12-3456789', quickbooksListId: 'QB-9', idHashed: 'deadbeef',
  includeEmailPOD: '0', includeEmailBOL: '1', mergePDF: '0',
});

const ok = json => allow({ json });
/** The console's own "no such record" answer. Note `data` is an ARRAY. */
const noResults = () => ok({ success: 'true', message: 'No results.', data: [], readOnly: false });
const record = (over = {}) => ok({ success: 'true', data: { ...BISON_RAW, ...over }, readOnly: false });

/**
 * A session stub honouring ConsoleSession's contract: `post(action, params)` → allow({json}) or a
 * refusal. `calls` records what was asked for, which is where the JOIN KEY is proven.
 */
function fakeSession(handler) {
  const calls = [];
  return {
    calls,
    async post(action, params) {
      calls.push({ action, params });
      return typeof handler === 'function' ? handler(action, params) : handler;
    },
  };
}

const val = r => { assert.equal(r.ok, true, `expected success, got refusal ${r.reason}`); return r.value; };
const no = r => { assert.equal(r.ok, false, 'expected a refusal'); return r; };

// ── the request ──────────────────────────────────────────────────────────────────────────────

test('the request keys on the RECORD id and always sends getAccounting', async () => {
  const s = fakeSession(record());
  await fetchCustomerRecord(s, '123301');
  assert.deepEqual(s.calls, [{
    action: SHIPPING_LOCATION_ACTION,
    params: { recordId: '123301', getAccounting: 'true' },
  }]);
});

test('getAccounting is not optional — no caller can turn it off', async () => {
  // Without it the console omits `accountingContacts` entirely, which would silently skip the
  // FIRST rule of the recipient precedence. It is hardcoded here, not a parameter.
  const s = fakeSession(record());
  await fetchCustomerRecord(s, '123301', { getAccounting: 'false', recordId: '999' });
  assert.equal(s.calls[0].params.getAccounting, 'true');
  assert.equal(s.calls[0].params.recordId, '123301');
});

// ── CONSTRAINT 1: the join key ───────────────────────────────────────────────────────────────

test('JOIN KEY TRAP: the tenant-level customerId resolves to nothing, the record id resolves', async () => {
  // `customerId` is "17" on EVERY customer record — a tenant id, not a customer key. Measured:
  // asking for recordId=17 does NOT return another customer's data, it returns the HOLLOW record
  // (`data: []`, success "true", "No results."). That is the real failure mode, and it is
  // success-shaped, which is why it has to be refused here rather than trusted downstream.
  const s = fakeSession((_a, p) => (p.recordId === '123301' ? record() : noResults()));

  const wrong = no(await fetchCustomerRecord(s, BISON_RAW.customerId));   // '17'
  assert.equal(wrong.reason, REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED);
  assert.equal(wrong.detail.reason, 'no_record');

  const right = val(await fetchCustomerRecord(s, BISON_RAW.id));          // '123301'
  assert.equal(right.id, '123301');
  assert.equal(right.accountingId, '2395');
});

test('narrowing keeps the CONSOLE field names, so the committed resolver consumes it unchanged', () => {
  // Renaming to a house style (`arCode`, `remitToShippingLocation`) would have meant editing the
  // already-tested rule to match a new shape. The record also stays recognisable against the
  // console screen someone will have open while diagnosing.
  for (const f of ['remitToSL', 'billingEmail', 'email', 'accountingContacts', 'accountingId', 'ARCode']) {
    assert.ok(CONSOLE_RECORD_FIELDS.includes(f), `${f} must survive narrowing — the resolver reads it`);
  }
});

test('the returned record NEVER carries the tenant customerId field', async () => {
  // Keeping it would leave the wrong join key sitting in scope, one careless edit from being used.
  const rec = val(await fetchCustomerRecord(fakeSession(record()), '123301'));
  assert.ok(!('customerId' in rec), 'the tenant-level customerId must not survive narrowing');
});

test('a record whose id is not the one we asked for is REFUSED, never adopted', async () => {
  const s = fakeSession(record({ id: '999999' }));
  const r = no(await fetchCustomerRecord(s, '123301'));
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED);
  assert.equal(r.detail.reason, 'id_mismatch');
  // The wrong customer's addresses must not appear anywhere in the refusal.
  assert.ok(!JSON.stringify(r).includes('@'));
});

test('the id comparison is by value, not by type — "123301" and 123301 are the same record', async () => {
  const s = fakeSession(record({ id: 123301 }));
  assert.equal((await fetchCustomerRecord(s, '123301')).ok, true, 'a numeric id must not read as a mismatch');
});

// ── CONSTRAINT 2: shape drift is not "no record", and neither is an outage ────────────────────

test('data: [] refuses — and `typeof [] === "object"` is why this test exists', async () => {
  assert.equal(typeof [], 'object', 'the trap: a naive object check admits the hollow record');
  const r = no(await fetchCustomerRecord(fakeSession(noResults()), '123301'));
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED);
  assert.equal(r.detail.reason, 'no_record');
});

test('success:"true" carries no weight — it is "true" on the hollow record too', async () => {
  // Both of these say success "true". Validity comes from the record, never from the flag.
  assert.equal(noResults().value.json.success, 'true');
  assert.equal(record().value.json.success, 'true');
  assert.equal((await fetchCustomerRecord(fakeSession(noResults()), '123301')).ok, false);
});

test('a missing / null / non-object data refuses as shape drift', async () => {
  for (const data of [undefined, null, 'nope', 42]) {
    const r = no(await fetchCustomerRecord(fakeSession(ok({ success: 'true', data })), '123301'));
    assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, `data=${JSON.stringify(data)}`);
  }
});

test('a record with no id at all refuses', async () => {
  const raw = { ...BISON_RAW }; delete raw.id;
  const r = no(await fetchCustomerRecord(fakeSession(ok({ success: 'true', data: raw })), '123301'));
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED);
  assert.equal(r.detail.reason, 'id_missing');
});

test('A CONSOLE OUTAGE PASSES THROUGH UNCHANGED — it is not shape drift', async () => {
  // piece (i) already classified this. Re-labelling it here would send someone to read the
  // console's JSON when the console never answered.
  const outage = refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'request', status: 502 });
  const r = no(await fetchCustomerRecord(fakeSession(outage), '123301'));
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED);
  assert.equal(r.detail.stage, 'request');
  assert.equal(r.detail.status, 502);
});

// ── CONSTRAINT 3: absent accountingContacts is drift, NOT "no contacts" ──────────────────────

test('accountingContacts ABSENT refuses — it must never read as "this customer has none"', async () => {
  // The difference is a whole rule of the precedence. If absence read as empty, a customer with
  // accounting contacts would be invoiced at their shipping desk and nothing would say so.
  const raw = { ...BISON_RAW }; delete raw.accountingContacts;
  const r = no(await fetchCustomerRecord(fakeSession(ok({ success: 'true', data: raw })), '123301'));
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED);
  assert.equal(r.detail.reason, 'accounting_contacts_absent');
});

test('accountingContacts present but not an array refuses', async () => {
  for (const bad of [{}, 'ap@x.com', 0, null]) {
    const r = no(await fetchCustomerRecord(fakeSession(record({ accountingContacts: bad })), '123301'));
    assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, `accountingContacts=${JSON.stringify(bad)}`);
  }
});

test('accountingContacts: [] is VALID — it is the live case on every customer today', async () => {
  const rec = val(await fetchCustomerRecord(fakeSession(record({ accountingContacts: [] })), '123301'));
  assert.deepEqual(rec.accountingContacts, []);
});

test('contacts are narrowed to the address the rule reads', async () => {
  const rec = val(await fetchCustomerRecord(fakeSession(record({
    accountingContacts: [
      { firstName: 'Ada', lastName: 'AP', type: 'Accounting', phone: '(555) 000-0000', email: 'ap@x.com' },
    ],
  })), '123301'));
  assert.deepEqual(rec.accountingContacts, [{ email: 'ap@x.com' }]);
});

// ── narrowing ────────────────────────────────────────────────────────────────────────────────

test('the returned record is SEALED against its field list', async () => {
  const rec = val(await fetchCustomerRecord(fakeSession(record()), '123301'));
  assert.deepEqual(Object.keys(rec).sort(), [...CONSOLE_RECORD_FIELDS].sort());
});

test('credit, tax and QBO identifiers do not survive the boundary', async () => {
  const rec = val(await fetchCustomerRecord(fakeSession(record()), '123301'));
  for (const banned of ['creditLimit', 'creditBalance', 'creditStatus', 'taxID', 'EINNumber',
                        'quickbooksListId', 'idHashed']) {
    assert.ok(!(banned in rec), `${banned} reached the recipient path`);
  }
  assert.ok(!JSON.stringify(rec).includes('50000'), 'a credit limit leaked by value');
});

test('narrowConsoleRecord is callable on its own and refuses the same way', () => {
  assert.equal(narrowConsoleRecord({ success: 'true', data: [] }, '1').ok, false);
  assert.equal(narrowConsoleRecord({ success: 'true', data: BISON_RAW }, '123301').ok, true);
});

// ── the exception-queue split ────────────────────────────────────────────────────────────────
//
// ONE refusal reason, TWO triage classes. `exceptions` is keyed UNIQUE (mode, kind, ref) with a
// climbing seen_count, so the `ref` is what decides whether two failures share a queue row:
//
//   a PER-INVOICE data gap   → one row per customer record, so each bad id is separately visible
//   a SYSTEMIC shape drift   → ONE row for the whole event, so one upstream change does not write
//                              hundreds of rows and bury everything else in the queue
//
// The constraint already exists in schema.sql. What these tests pin is the ref discipline that
// makes it separate the two rather than blur them.

test('a per-invoice data gap is keyed PER RECORD', async () => {
  for (const reason of ['no_record', 'id_missing', 'id_mismatch']) {
    const r = refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, { reason, requested: '17' });
    assert.equal(exceptionRefFor(r), 'sl:17', reason);
  }
});

test('two different bad ids do NOT share a queue row', async () => {
  const a = refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, { reason: 'no_record', requested: '17' });
  const b = refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, { reason: 'no_record', requested: '99' });
  assert.notEqual(exceptionRefFor(a), exceptionRefFor(b),
    'a data gap on one customer must not hide a data gap on another');
});

test('shape drift is SYSTEMIC — every record collapses to one ref', async () => {
  const a = refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, { reason: 'accounting_contacts_absent', requested: '33717' });
  const b = refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, { reason: 'accounting_contacts_absent', requested: '123301' });
  assert.equal(exceptionRefFor(a), SHAPE_DRIFT_REF);
  assert.equal(exceptionRefFor(b), SHAPE_DRIFT_REF);
  assert.notEqual(SHAPE_DRIFT_REF, 'sl:33717', 'drift must not be keyed per record');
});

test('an outage is keyed per STAGE, not per invoice', async () => {
  // Same reasoning: one console outage is one queue row, and a login problem is separable from a
  // transport problem on triage.
  const a = refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'login', status: 500 });
  const b = refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'login', status: 500 });
  const c = refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'request', status: 502 });
  assert.equal(exceptionRefFor(a), exceptionRefFor(b));
  assert.notEqual(exceptionRefFor(a), exceptionRefFor(c));
  assert.match(exceptionRefFor(a), /^console:/);
});

test('the RULE\'s own refusals are keyed per ARCode', () => {
  // The record was read fine; its CONTENT is the problem, and the customer is the unit someone
  // acts on. Added when the wire (piece iii) began recording these — without a ref they could not
  // be filed at all.
  for (const reason of [REFUSAL_REASONS.NO_RECIPIENT, REFUSAL_REASONS.RECIPIENT_UNPARSEABLE,
                        REFUSAL_REASONS.RECIPIENT_SOURCE_UNKNOWN, REFUSAL_REASONS.NOT_ALLOWLISTED]) {
    assert.equal(exceptionRefFor(refuse(reason, { arCode: '2395' })), 'ar:2395', reason);
  }
});

test('a missing customer id on the invoice is keyed per INVOICE', () => {
  const r = refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED,
    { reason: 'customer_id_missing', invoiceId: 'I1' });
  assert.equal(exceptionRefFor(r), 'invoice:I1');
});

test('a refusal outside the closed set still throws rather than inventing a ref', () => {
  // The set widened when the wire landed; the PROPERTY did not. Anything this path cannot produce
  // must fail at the call site rather than be filed under a key nobody reads.
  for (const reason of [REFUSAL_REASONS.CREATE_IN_FLIGHT, REFUSAL_REASONS.ALREADY_MATERIALIZED,
                        REFUSAL_REASONS.NO_STRIPE_CUSTOMER]) {
    assert.throws(() => exceptionRefFor(refuse(reason)), /no exception ref/i, reason);
  }
  assert.throws(() => exceptionRefFor({ ok: true }), /no exception ref/i);
  assert.throws(() => exceptionRefFor(refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED,
    { reason: 'something_new' })), /no exception ref/i, 'an unknown detail.reason must not fall through');
});

test('AGAINST THE REAL TABLE: 40 drifting records make ONE row, 3 bad ids make THREE', async () => {
  // The proof that the ref discipline and the UNIQUE constraint actually compose. Without the
  // split, the 40 would be 40 rows and the 3 genuine data gaps would be lost among them.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);

  for (let i = 0; i < 40; i++) {
    const r = refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED,
      { reason: 'accounting_contacts_absent', requested: String(100000 + i) });
    await ledger.recordException(r.reason, exceptionRefFor(r), 'accountingContacts absent');
  }
  for (const id of ['17', '99', '1234']) {
    const r = refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, { reason: 'no_record', requested: id });
    await ledger.recordException(r.reason, exceptionRefFor(r), 'no such console record');
  }

  const rows = db.rows(
    `SELECT ref, seen_count FROM exceptions WHERE kind = '${REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED}' ORDER BY ref`
  );
  assert.equal(rows.length, 4, 'one systemic row plus three per-record rows');

  const drift = rows.find(r => r.ref === SHAPE_DRIFT_REF);
  assert.ok(drift, 'the systemic row is missing');
  assert.equal(drift.seen_count, 40, 'the drift row counts every record it hit');

  assert.deepEqual(rows.filter(r => r.ref !== SHAPE_DRIFT_REF).map(r => r.ref).sort(),
    ['sl:1234', 'sl:17', 'sl:99']);
});

// ── the whole point: it feeds the resolver ───────────────────────────────────────────────────

test('END TO END with piece (a): the narrowed record resolves to the billing address', async () => {
  const rec = val(await fetchCustomerRecord(fakeSession(record()), '123301'));
  const r = resolveRecipient(rec, ANY_AR);
  assert.equal(r.ok, true, `resolver refused: ${r.reason}`);
  assert.equal(r.value.source, RECIPIENT_SOURCES.BILLING_EMAIL);
  assert.deepEqual(r.value.to, ['accounting@bisoncommerce.com']);
});

test('END TO END: accounting contacts on the narrowed record still win', async () => {
  const rec = val(await fetchCustomerRecord(fakeSession(record({
    accountingContacts: [{ type: 'Accounting', email: 'ap@bisoncommerce.com' }],
  })), '123301'));
  const r = resolveRecipient(rec, ANY_AR);
  assert.equal(r.value.source, RECIPIENT_SOURCES.ACCOUNTING_CONTACTS);
  assert.deepEqual(r.value.to, ['ap@bisoncommerce.com']);
});

test('END TO END: the narrowed record still carries what the bound needs', async () => {
  // Narrowing must not drop the ARCode — the resolver refuses NOT_ALLOWLISTED without it, and a
  // record that cannot be bound is a record that cannot be sent to.
  const rec = val(await fetchCustomerRecord(fakeSession(record()), '123301'));
  const r = resolveRecipient(rec, { all: false, codes: new Set(['1234']) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSAL_REASONS.NOT_ALLOWLISTED);
});
