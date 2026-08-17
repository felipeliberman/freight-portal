// THE COMPOSITION — candidates → recipient → guard, in one pass.
//
//     node --test invoice-sync/test/send-pass.test.mjs
//
// NO NETWORK. Primus and the console session are stubs; the ledger is a real in-memory D1.
//
// Every part is tested in its own file. What is tested HERE is that they compose without losing
// anything between them — which is where three specific failures live:
//
//   1. ONE BAD INVOICE ENDING THE RUN. A console refusal on invoice 3 of 8 must not cost the
//      other 7. Each candidate is independent, and nothing that fails is consumed.
//   2. A REFUSAL BEING TREATED AS A SEND. An invoice we could not resolve must stay selectable
//      next run — first_sent_at untouched, no invoice_send row that would block a retry.
//   3. DRY RUN REACHING THE WIRE. The guard refuses, but the pass is what decides to call it at
//      all, and a transport handed to a dry run must still never be used.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSendPass } from '../src/send-pass.js';
import { Ledger } from '../src/ledger.js';
import { loadSendConfig } from '../src/send-guard.js';
import { checkArCode } from '../src/config.js';
import { REFUSAL_REASONS, allow, refuse } from '../src/refusals.js';
import { RECIPIENT_SOURCES } from '../src/recipient.js';
import { VERIFIED_RECIPIENTS } from '../src/mapper.js';
import { onlyAr, freshDb } from './helpers.mjs';

const PILOT = onlyAr('1234');
const INTERNAL = VERIFIED_RECIPIENTS[0];

const inv = (id, over = {}) => {
  const { status: s, ...rest } = over;
  return {
    invoiceId: id, invoiceNumber: `14${id}`, ARCode: '1234', total: 100,
    issueDate: '2026-08-17 10:00:00', invoiceDueDate: '2026-09-16',
    shipment: { BOLNumber: `BOL${id}`, consigneeReferenceNumber: `PO${id}` },
    ...rest,
    status: { generated: true, sent: false, paid: false, ...(s || {}) },
  };
};

/**
 * @param {Function} [custIdFor] invoiceId → customerInfo.customerId. Defaults to ONE customer for
 *   every invoice, which is the ordinary case and the one the recipient memo collapses. Tests
 *   about per-invoice behaviour must vary it — see the isolation test, where sharing a customer
 *   would mean the second invoice never reaches the console at all.
 */
function fakePrimus(rows, custIdFor = () => '33717') {
  return {
    async get(path, params = {}) {
      if (path === '/invoice') {
        return { data: { results: Number(params.page) === 1 ? rows : [] } };
      }
      // the invoice detail, for customerInfo.customerId
      const id = path.replace('/invoice/', '');
      return { data: { results: {
        invoiceId: id, invoiceNumber: `14${id}`, total: 100,
        status: { generated: true, sent: false, paid: false },
        shipment: { BOLNumber: `BOL${id}` },
        customerInfo: { customerId: custIdFor(id), customerName: 'F&L TEST', customerCode: '1234', creditStatus: null },
        invoiceBreakdown: [{ code: 'FRT', description: 'Freight', qty: 1, rate: 100, total: 100 }],
      } } };
    },
  };
}

/** A console record whose `id` matches what was asked for — console-lookup refuses a mismatch. */
const recordFor = id => allow({ json: { success: 'true', data: {
  id: String(id), customerId: '17', accountingId: '1234', ARCode: '1234',
  name: 'Freight and Logistics, Inc. - TEST',
  remitToSL: '1', email: 'felipe@freightandlogistics.com', billingEmail: '',
  accountingContacts: [],
} } });

/** A console session double. `handler` decides what each getShippingLocation returns. */
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

const RECORD = allow({ json: { success: 'true', data: {
  id: '33717', customerId: '17', accountingId: '1234', ARCode: '1234',
  name: 'Freight and Logistics, Inc. - TEST',
  remitToSL: '1', email: 'felipe@freightandlogistics.com', billingEmail: '',
  accountingContacts: [],
} } });

function fakeTransport() {
  const calls = [];
  return { calls, async send(e) { calls.push(e); return { ok: true, status: 202, messageId: 'msg_1' }; } };
}

const pass = (over = {}) => runSendPass({
  allowlist: PILOT, checkArCode,
  issuedFrom: '2026-08-10', issuedTo: '2026-08-17',
  sendFromDate: '2026-08-17', cap: 25,
  ...over,
});

// ── the dry run ──────────────────────────────────────────────────────────────────────────────

test('DRY RUN end to end: a reviewable list, and nothing sent', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const transport = fakeTransport();

  const r = await pass({
    primus: fakePrimus([inv('I1'), inv('I2')]), ledger,
    session: fakeSession(RECORD),
    sendConfig: loadSendConfig({ SEND_MODE: 'dryrun', INTERNAL_SEND_ADDRESS: INTERNAL }),
    transport,
  });

  assert.equal(r.candidates, 2);
  assert.equal(r.sent, 0);
  assert.equal(r.wouldSend, 2);
  assert.equal(transport.calls.length, 0, 'A DRY RUN REACHED THE WIRE');

  // The list is the whole point of the gate.
  assert.deepEqual(r.report.map(x => [x.invoiceNumber, x.to.join(','), x.source]), [
    ['14I1', 'felipe@freightandlogistics.com', RECIPIENT_SOURCES.MAIN_EMAIL],
    ['14I2', 'felipe@freightandlogistics.com', RECIPIENT_SOURCES.MAIN_EMAIL],
  ]);

  const rows = db.rows("SELECT outcome, recipient FROM invoice_send ORDER BY id");
  assert.equal(rows.length, 2);
  assert.ok(rows.every(x => x.outcome === 'refused'));
  assert.ok(rows.every(x => x.recipient === 'felipe@freightandlogistics.com'));
});

test('a dry run leaves every invoice selectable — nothing is consumed', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  await pass({
    primus: fakePrimus([inv('I1')]), ledger, session: fakeSession(RECORD),
    sendConfig: loadSendConfig({ SEND_MODE: 'dryrun', INTERNAL_SEND_ADDRESS: INTERNAL }),
  });
  assert.equal((await ledger.get('I1')).first_sent_at, null);
});

test('THE MEMO CROSSES THE COMPOSITION: two invoices, one customer, one console read', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const session = fakeSession(RECORD);
  await pass({
    primus: fakePrimus([inv('I1'), inv('I2')]), ledger, session,
    sendConfig: loadSendConfig({ SEND_MODE: 'dryrun', INTERNAL_SEND_ADDRESS: INTERNAL }),
  });
  assert.equal(session.calls.length, 1, 'the recipient memo did not survive the pass');
});

// ── isolation ────────────────────────────────────────────────────────────────────────────────

test('ONE BAD INVOICE DOES NOT END THE RUN', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);

  // TWO DIFFERENT CUSTOMERS, deliberately. Sharing one would mean the second invoice hits the
  // recipient memo and never reaches the console — the failure could not fire, and this test
  // would pass while proving nothing. (It did exactly that on the first attempt.)
  const session = fakeSession(recordId => (recordId === 'CI1'
    ? recordFor('CI1')
    : refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'request', status: 502 })));

  const r = await pass({
    primus: fakePrimus([inv('I1'), inv('I2')], id => `C${id}`), ledger, session,
    sendConfig: loadSendConfig({ SEND_MODE: 'dryrun', INTERNAL_SEND_ADDRESS: INTERNAL }),
  });

  assert.equal(r.candidates, 2);
  assert.equal(r.wouldSend, 1, 'the good invoice must still be processed');
  assert.equal(r.unresolved, 1);
  assert.deepEqual(r.report.map(x => x.invoiceNumber), ['14I1']);
});

test('AN UNRESOLVED RECIPIENT IS NOT A SEND — no row, no anchor, still selectable', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const r = await pass({
    primus: fakePrimus([inv('I1')]), ledger,
    session: fakeSession(refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'session' })),
    sendConfig: loadSendConfig({ SEND_MODE: 'dryrun', INTERNAL_SEND_ADDRESS: INTERNAL }),
  });

  assert.equal(r.unresolved, 1);
  assert.equal(r.wouldSend, 0);
  assert.equal(db.count('invoice_send'), 0, 'an invoice we could not address must leave no send row');
  assert.equal((await ledger.get('I1')).first_sent_at, null, 'and must remain selectable next run');
  assert.deepEqual(r.unresolvedDetail, [{ invoiceNumber: '14I1', reason: REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED }]);
});

test('a recipient the RULE refuses is reported with its own reason', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const blank = allow({ json: { success: 'true', data: {
    id: '33717', accountingId: '1234', ARCode: '1234', name: 'x',
    remitToSL: '1', email: '', billingEmail: '', accountingContacts: [],
  } } });

  const r = await pass({
    primus: fakePrimus([inv('I1')]), ledger, session: fakeSession(blank),
    sendConfig: loadSendConfig({ SEND_MODE: 'dryrun', INTERNAL_SEND_ADDRESS: INTERNAL }),
  });
  assert.equal(r.unresolvedDetail[0].reason, REFUSAL_REASONS.NO_RECIPIENT);
});

// ── sending modes ────────────────────────────────────────────────────────────────────────────

test('INTERNAL: the pass sends, to the internal address only', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const transport = fakeTransport();

  const r = await pass({
    primus: fakePrimus([inv('I1')]), ledger, session: fakeSession(RECORD),
    sendConfig: loadSendConfig({ SEND_MODE: 'internal', INTERNAL_SEND_ADDRESS: INTERNAL }),
    transport,
  });

  assert.equal(r.sent, 1);
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(transport.calls[0].to, [INTERNAL]);
  assert.ok((await ledger.get('I1')).first_sent_at > 0);
});

test('a second pass after a real send finds nothing — the loop is closed end to end', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const primus = fakePrimus([inv('I1')]);
  const cfg = loadSendConfig({ SEND_MODE: 'internal', INTERNAL_SEND_ADDRESS: INTERNAL });

  const first = await pass({ primus, ledger, session: fakeSession(RECORD), sendConfig: cfg, transport: fakeTransport() });
  assert.equal(first.sent, 1);

  // Primus still says red — it did not send. Only our own record stops the second pass.
  const second = await pass({ primus, ledger, session: fakeSession(RECORD), sendConfig: cfg, transport: fakeTransport() });
  assert.equal(second.candidates, 0, 'RED ALONE WOULD HAVE RE-SENT');
  assert.equal(second.sent, 0);
});

test('a send failure is counted and leaves the invoice retriable', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const transport = { async send() { return { ok: false, status: 502, error: 'upstream' }; } };

  const r = await pass({
    primus: fakePrimus([inv('I1')]), ledger, session: fakeSession(RECORD),
    sendConfig: loadSendConfig({ SEND_MODE: 'internal', INTERNAL_SEND_ADDRESS: INTERNAL }),
    transport,
  });

  assert.equal(r.sent, 0);
  assert.equal(r.failed, 1);
  assert.equal((await ledger.get('I1')).first_sent_at, null);
});

// ── the bound and the floor still hold through the composition ───────────────────────────────

test('the pilot bound survives the composition', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const session = fakeSession(RECORD);
  const r = await pass({
    primus: fakePrimus([inv('I1'), inv('OTHER', { ARCode: '2395' })]), ledger, session,
    sendConfig: loadSendConfig({ SEND_MODE: 'dryrun', INTERNAL_SEND_ADDRESS: INTERNAL }),
  });
  assert.equal(r.candidates, 1);
  assert.ok(!JSON.stringify(r.report).includes('2395'));
});

test('the floor survives the composition', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const r = await pass({
    primus: fakePrimus([inv('OLD', { issueDate: '2026-08-01 10:00:00' })]), ledger,
    session: fakeSession(RECORD),
    sendConfig: loadSendConfig({ SEND_MODE: 'dryrun', INTERNAL_SEND_ADDRESS: INTERNAL }),
  });
  assert.equal(r.candidates, 0);
  assert.equal(r.beforeFloor, 1);
});

test('with no candidates the console is never touched — the session stays lazy', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const session = fakeSession(RECORD);
  const r = await pass({
    primus: fakePrimus([inv('I1', { status: { sent: true } })]), ledger, session,
    sendConfig: loadSendConfig({ SEND_MODE: 'dryrun', INTERNAL_SEND_ADDRESS: INTERNAL }),
  });
  assert.equal(r.candidates, 0);
  assert.equal(session.calls.length, 0,
    'a quiet run must not establish a master console session it has no use for');
});
