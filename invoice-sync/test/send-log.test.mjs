// STEP 4 — THE SEND LOG (spec §8.883).
//
//     node --test invoice-sync/test/send-log.test.mjs
//
// ── RED BY ABSENCE, and labelled as such ─────────────────────────────────────────────────────
//
// Nothing is broken. `invoice_send` and `ledger.first_sent_at` do not exist yet, so every failure
// here is the shape of unwritten work — WEAKER evidence than a reproduced defect, and it is named
// rather than dressed up. These become real the moment the table exists and they still pass.
//
// ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────────────────────
//
// MINTED-BUT-NEVER-SENT MUST BE DETECTABLE. Without a send record, an invoice whose link was minted
// and whose email silently failed is INDISTINGUISHABLE from one delivered a month ago. There is no
// second path to fall back on: SendGrid's Activity Feed retains THREE DAYS (§8.875), so a send not
// logged at send time is unrecoverable in 72 hours.
//
// And C1's dispute clause starts a 3-business-day clock on OUR SEND DATE. A contractual window
// resting on a timestamp that evaporates before the window closes is worse than no clause.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger } from '../src/ledger.js';
import { freshDb, ANY_AR, onlyAr, whyRed } from './helpers.mjs';

const PILOT = onlyAr('1234');

async function seed(db, over = {}) {
  const ledger = new Ledger(db, 'test', ANY_AR);
  const { row } = await ledger.claim({
    primusInvoiceId: over.id || 'I1', primusInvoiceNumber: '141604',
    bolNumber: '160133693', arCode: over.arCode || '1234', totalCents: 27357,
  });
  return { ledger, row };
}

// ── the shape ────────────────────────────────────────────────────────────────────────────────

test('RED BY ABSENCE: the invoice_send table exists', async () => {
  const db = freshDb();
  const cols = db.rows("SELECT name FROM pragma_table_info('invoice_send')").map(r => r.name);
  assert.ok(cols.length, whyRed('the invoice_send table (spec §8.883)',
    'Schema approved 2026-08-10. Until it exists, a minted link that was never emailed is ' +
    'indistinguishable from one delivered a month ago, and SendGrid retention is 3 days.'));

  for (const c of ['mode', 'ledger_id', 'primus_invoice_id', 'token', 'recipient', 'recipient_source',
                   'attempted_at', 'sent_date', 'outcome', 'provider', 'provider_message_id',
                   'provider_status', 'error']) {
    assert.ok(cols.includes(c), `invoice_send is missing the ${c} column`);
  }
});

test('RED BY ABSENCE: ledger carries first_sent_at', async () => {
  const db = freshDb();
  const cols = db.rows("SELECT name FROM pragma_table_info('ledger')").map(r => r.name);
  assert.ok(cols.includes('first_sent_at'),
    whyRed('ledger.first_sent_at (spec §8.883)',
      'It anchors C1\'s 3-business-day dispute clock. Derived from the latest send instead, a ' +
      'resend in week three would silently move a customer\'s dispute deadline under them.'));
});

test('DELIBERATELY ABSENT: invoice_send has NO unique constraint — a resend is legitimate', async () => {
  const db = freshDb();
  const idx = db.rows("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='invoice_send'");
  const uniq = idx.filter(i => i.sql && /UNIQUE/i.test(i.sql));
  assert.deepEqual(uniq.map(i => i.name), [],
    'a UNIQUE index appeared on invoice_send. Preventing an ACCIDENTAL double-send is a ' +
    'claim-before-send guard in code; a constraint here would also block a LEGITIMATE resend.');
});

// ── recording an attempt ─────────────────────────────────────────────────────────────────────

test('RED BY ABSENCE: a successful send is recorded with its provider message id', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  assert.equal(typeof ledger.recordSend, 'function',
    whyRed('Ledger.recordSend (spec §8.883)', 'The write side of the send log.'));

  await ledger.recordSend({
    ledgerId: row.id, primusInvoiceId: 'I1', token: 'AbCdEfGhIjKlMnOpQrStUv',
    recipient: 'ap@example.com', recipientSource: 'qbo_cache',
    outcome: 'sent', provider: 'sendgrid', providerMessageId: 'msg_123', providerStatus: 202,
    at: Date.UTC(2026, 7, 10, 21, 24, 59),
  });

  const [rec] = db.rows('SELECT * FROM invoice_send');
  assert.equal(rec.outcome, 'sent');
  assert.equal(rec.recipient, 'ap@example.com');
  assert.equal(rec.recipient_source, 'qbo_cache');
  assert.equal(rec.provider_message_id, 'msg_123',
    'without the provider id there is no join to SendGrid\'s side and no way to chase a delivery');
});

test('RED BY ABSENCE: A FAILURE IS RECORDED TOO — a failed send is the one you must not lose', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  await ledger.recordSend({
    ledgerId: row.id, primusInvoiceId: 'I1', recipient: 'ap@example.com',
    outcome: 'failed', provider: 'sendgrid', providerStatus: 400, error: 'bad_request',
    at: Date.now(),
  });
  const [rec] = db.rows("SELECT * FROM invoice_send WHERE outcome = 'failed'");
  assert.ok(rec, 'a failed send left no record — the invoice looks unsent AND unattempted');
  assert.equal(rec.error, 'bad_request');
  assert.equal(rec.first_sent_at ?? null, null, 'a failure must not be treated as a send');
});

test('RED BY ABSENCE: a FAILED send does NOT stamp first_sent_at', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  await ledger.recordSend({ ledgerId: row.id, primusInvoiceId: 'I1', recipient: 'a@b.com',
    outcome: 'failed', at: Date.now() });
  const [l] = db.rows(`SELECT first_sent_at FROM ledger WHERE id = ${row.id}`);
  assert.equal(l.first_sent_at, null,
    'a failed attempt started the dispute clock. The clause runs from a send, not from a try.');
});

test('RED BY ABSENCE: an unknown outcome THROWS — a misspelt value matches no reader', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  await assert.rejects(
    () => ledger.recordSend({ ledgerId: row.id, primusInvoiceId: 'I1', recipient: 'a@b.com',
      outcome: 'delivered', at: Date.now() }),
    /outcome/i,
    'same failure shape as stripe_state: a typo is written silently and then matches no reader');
});

// ── first_sent_at is WRITE-ONCE, and that is the contractual guarantee ───────────────────────

test('RED BY ABSENCE: first_sent_at is WRITE-ONCE — a resend cannot move the dispute clock', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  const FIRST = Date.UTC(2026, 7, 10, 12, 0, 0);
  const LATER = Date.UTC(2026, 7, 24, 12, 0, 0);      // a resend two weeks on

  await ledger.recordSend({ ledgerId: row.id, primusInvoiceId: 'I1', recipient: 'a@b.com', outcome: 'sent', at: FIRST });
  await ledger.recordSend({ ledgerId: row.id, primusInvoiceId: 'I1', recipient: 'a@b.com', outcome: 'sent', at: LATER });

  const [l] = db.rows(`SELECT first_sent_at FROM ledger WHERE id = ${row.id}`);
  assert.equal(l.first_sent_at, FIRST,
    'A RESEND MOVED THE ANCHOR. C1 starts a 3-business-day dispute window on our send date; if a ' +
    'later copy re-stamps it, the customer\'s deadline shifts under them without anyone deciding to.');

  assert.equal(db.count('invoice_send'), 2, 'both attempts must still be recorded individually');
});

// ── the date, not the integer (spec §8.867) ──────────────────────────────────────────────────

test('RED BY ABSENCE: sent_date is RECORDED in America/Los_Angeles, not derived later', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  // 2026-08-11 03:30 UTC is 2026-08-10 20:30 in Los Angeles. The UTC date and OUR business date
  // are DIFFERENT DAYS — which is the entire reason this column exists rather than a derivation.
  await ledger.recordSend({
    ledgerId: row.id, primusInvoiceId: 'I1', recipient: 'a@b.com', outcome: 'sent',
    at: Date.UTC(2026, 7, 11, 3, 30, 0),
  });
  const [rec] = db.rows('SELECT sent_date, attempted_at FROM invoice_send');
  assert.equal(rec.sent_date, '2026-08-10',
    'sent_date was stored as the UTC day. "Business day" means OUR business day and we operate in ' +
    'Los Angeles; a contractual clock must not depend on whoever reads the integer later picking ' +
    'a zone (§8.867: a time value crossing a boundary carries its unit, its zone and its modality).');
  assert.equal(typeof rec.attempted_at, 'number', 'the epoch value is kept alongside, not replaced');
});

// ── the query the whole thing exists for ─────────────────────────────────────────────────────

test('RED BY ABSENCE: minted-but-never-sent is DETECTABLE in one query', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const a = (await ledger.claim({ primusInvoiceId: 'MINTED_SENT', arCode: '1234' })).row;
  const b = (await ledger.claim({ primusInvoiceId: 'MINTED_UNSENT', arCode: '1234' })).row;
  const c = (await ledger.claim({ primusInvoiceId: 'NEVER_MINTED', arCode: '1234' })).row;

  await ledger.markLinkMinted(a.id, 1000);
  await ledger.markLinkMinted(b.id, 1000);
  await ledger.recordSend({ ledgerId: a.id, primusInvoiceId: 'MINTED_SENT', recipient: 'a@b.com', outcome: 'sent', at: 2000 });

  assert.equal(typeof ledger.openMintedUnsent, 'function',
    whyRed('Ledger.openMintedUnsent (spec §8.883)',
      'The read side. Minted-but-never-sent must not be a state we can only discover by asking a ' +
      'customer why they never got an invoice.'));

  const stuck = await ledger.openMintedUnsent();
  assert.deepEqual(stuck.map(r => r.primus_invoice_id), ['MINTED_UNSENT'],
    'the sweep must find the minted-and-unsent row, and ONLY it');
  assert.ok(!stuck.some(r => r.primus_invoice_id === c.primus_invoice_id),
    'a row that was never minted is not "unsent" — it has not reached this stage');
});

test('RED BY ABSENCE: the sweep is bound-scoped like every other ledger read', async () => {
  const db = freshDb();
  const wide = new Ledger(db, 'test', ANY_AR);
  const { row } = await wide.claim({ primusInvoiceId: 'OUTSIDE', arCode: '5406' });
  await wide.markLinkMinted(row.id, 1000);

  const pilot = new Ledger(db, 'test', PILOT);
  const stuck = await pilot.openMintedUnsent();
  assert.deepEqual(stuck.map(r => r.primus_invoice_id), [],
    'the sweep returned a row outside the pilot bound — every ledger read carries the bound');
});
