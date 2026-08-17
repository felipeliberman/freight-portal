// PIECE (c) — THE SEND CANDIDATES (Phase 1, deliver-and-inform).
//
//     node --test invoice-sync/test/send-candidates.test.mjs
//
// NO NETWORK. The Primus list is a stub; the ledger is a real (in-memory) D1.
//
// ── THE RULE, AND WHY IT TAKES TWO CLAUSES ───────────────────────────────────────────────────
//
//     candidate = Primus says RED (status.sent === false)
//                 AND we have not sent it (ledger.first_sent_at IS NULL)
//
// EACH CLAUSE ALONE IS A DEFECT:
//
//   * RED ALONE re-sends forever. Primus's flag never flips when WE send — Primus did not send —
//     so every cycle would see the same red invoice and email it again.
//   * UNSENT ALONE emails everything Primus already delivered. 296 of 300 recent invoices are
//     `sent=true`; the customer would get a second copy of each.
//
// ── WHY NOT openMintedUnsent ─────────────────────────────────────────────────────────────────
//
// It exists, it is the obvious thing to reach for, and it is WRONG HERE. It requires
// `link_minted_at IS NOT NULL`, and Phase 1 is portal-only so nothing mints links —
// `InvoiceLinks.mint()` has no production caller. Measured on production 2026-08-17: 11 unsent
// rows, 0 ever minted, so that query returns ZERO. A poller built on it would find nothing and
// look like a quiet week.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collectSendCandidates } from '../src/send-candidates.js';
import { Ledger } from '../src/ledger.js';
import { checkArCode } from '../src/config.js';
import { onlyAr, ANY_AR, freshDb } from './helpers.mjs';

const PILOT = onlyAr('1234');

/**
 * One invoice-list row, in the shape spec §1 documents. `sent` is the flag that decides.
 *
 * `status` is destructured OUT of the overrides and merged separately. Spreading `...over` after a
 * merged `status` REPLACES the whole object, so `{ status: { sent: true } }` would silently drop
 * `generated: true` and the row would be rejected as not-generated instead of not-red — passing
 * the candidates-are-zero assertion for entirely the wrong reason. That is what the counter
 * assertions caught, and why they are there.
 */
const inv = (id, over = {}) => {
  const { status: statusOver, ...rest } = over;
  return {
    invoiceId: id,
    invoiceNumber: `14${id}`,
    ARCode: '1234',
    total: 100,
    issueDate: '2026-07-09 13:10:29',
    invoiceDueDate: '2026-08-08',
    shipment: { BOLNumber: `BOL${id}`, consigneeReferenceNumber: `PO${id}` },
    ...rest,
    status: { generated: true, sent: false, paid: false, ...(statusOver || {}) },
  };
};

/** A Primus double serving one page of the invoice list. */
function fakePrimus(rows) {
  const calls = [];
  return {
    calls,
    async get(path, params = {}) {
      calls.push({ path, params });
      if (path !== '/invoice') throw new Error(`unexpected path ${path}`);
      return { data: { results: Number(params.page) === 1 ? rows : [], pagingDetails: { totalResults: rows.length } } };
    },
  };
}

const run = (primus, ledger, allowlist, over = {}) => collectSendCandidates({
  primus, ledger, allowlist, checkArCode,
  issuedFrom: '2026-07-01', issuedTo: '2026-07-31', ...over,
});

// ── the two clauses ──────────────────────────────────────────────────────────────────────────

test('RED and not-sent-by-us is a candidate', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const r = await run(fakePrimus([inv('I1')]), ledger, PILOT);

  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].row.primus_invoice_id, 'I1');
  assert.equal(r.candidates[0].row.first_sent_at, null);
  assert.equal(r.candidates[0].invoiceNumber, '14I1');
});

test('GREEN is not a candidate — Primus already emailed it', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const r = await run(fakePrimus([inv('I1', { status: { sent: true } })]), ledger, PILOT);

  assert.equal(r.candidates.length, 0);
  assert.equal(r.notRed, 1);
});

test('RED BUT ALREADY SENT BY US is not a candidate — this is the anti-loop clause', async () => {
  // Primus's flag stays red forever because Primus did not send. Without this clause the same
  // invoice is emailed on every cycle.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const { row } = await ledger.claim({ primusInvoiceId: 'I1', arCode: '1234', totalCents: 100 });
  await ledger.markFirstSent(row.id);

  const r = await run(fakePrimus([inv('I1')]), ledger, PILOT);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.alreadySentByUs, 1);
});

test('the SECOND run over the same window yields nothing new', async () => {
  // The property the whole rule exists for, asserted end to end rather than argued.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const primus = fakePrimus([inv('I1'), inv('I2')]);

  const first = await run(primus, ledger, PILOT);
  assert.equal(first.candidates.length, 2);
  for (const c of first.candidates) await ledger.markFirstSent(c.row.id);

  const second = await run(primus, ledger, PILOT);
  assert.equal(second.candidates.length, 0, 'a re-run would have re-sent');
  assert.equal(second.alreadySentByUs, 2);
});

test('not-generated is never a candidate, whatever the sent flag says', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const r = await run(fakePrimus([inv('I1', { status: { generated: false, sent: false } })]), ledger, PILOT);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.notGenerated, 1);
});

// ── the bound ────────────────────────────────────────────────────────────────────────────────

test('BOUNDED TO THE ALLOWLIST — another customer\'s red invoice is not a candidate', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const rows = [inv('I1'), inv('I2', { ARCode: '2395' })];

  const r = await run(fakePrimus(rows), ledger, PILOT);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].row.ar_code, '1234');
  assert.equal(r.skippedNotAllowed, 1);
  assert.ok(!JSON.stringify(r.candidates).includes('2395'));
});

test('a non-allowlisted invoice leaves NO ledger row — widening later must not find it suppressed', async () => {
  // Spec §3.1: recording skips would make claim() return false forever once the bound widens.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  await run(fakePrimus([inv('I2', { ARCode: '2395' })]), ledger, PILOT);
  assert.equal(db.count('ledger'), 0);
});

// ── the backfill floor ───────────────────────────────────────────────────────────────────────

test('THE FLOOR: invoices issued before SEND_FROM_DATE are never candidates', async () => {
  // The sharpest risk in this piece. The ledger already holds rows claimed during phase 3, all
  // with first_sent_at NULL; without a floor the first live run emails every one of them.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const rows = [
    inv('OLD', { issueDate: '2026-07-05 09:00:00' }),
    inv('NEW', { issueDate: '2026-07-20 09:00:00' }),
  ];

  const r = await run(fakePrimus(rows), ledger, PILOT, { sendFromDate: '2026-07-10' });
  assert.deepEqual(r.candidates.map(c => c.row.primus_invoice_id), ['NEW']);
  assert.equal(r.beforeFloor, 1);
});

test('the floor is INCLUSIVE of its own date', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const r = await run(fakePrimus([inv('SAME', { issueDate: '2026-07-10 23:59:59' })]), ledger, PILOT,
    { sendFromDate: '2026-07-10' });
  assert.equal(r.candidates.length, 1);
});

test('an unparseable issue date is EXCLUDED when a floor is set, not waved through', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const r = await run(fakePrimus([inv('BAD', { issueDate: null })]), ledger, PILOT,
    { sendFromDate: '2026-07-10' });
  assert.equal(r.candidates.length, 0, 'a date we cannot read must not pass a floor');
  assert.equal(r.beforeFloor, 1);
});

test('no floor configured means no floor applied — but it is REPORTED', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const r = await run(fakePrimus([inv('OLD', { issueDate: '2020-01-01 00:00:00' })]), ledger, PILOT);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.floor, null, 'the summary must say the floor was absent, not imply one applied');
});

// ── the cap ──────────────────────────────────────────────────────────────────────────────────

test('THE CAP bounds a run, and says so rather than truncating silently', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const rows = ['A', 'B', 'C', 'D', 'E'].map(id => inv(id));

  const r = await run(fakePrimus(rows), ledger, PILOT, { cap: 2 });
  assert.equal(r.candidates.length, 2);
  assert.equal(r.cappedAt, 2);
  assert.equal(r.dropped, 3, 'a bounded run that reads as complete is how a never-billed invoice hides');
});

test('under the cap, nothing is reported as dropped', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const r = await run(fakePrimus([inv('A')]), ledger, PILOT, { cap: 10 });
  assert.equal(r.dropped, 0);
  assert.equal(r.cappedAt, null);
});

// ── the ledger row ───────────────────────────────────────────────────────────────────────────

test('a candidate carries a REAL ledger row, with what the send guard reads', async () => {
  // SendGuard.send touches row.id, row.primus_invoice_id and row.first_sent_at. A candidate that
  // carried a list record instead would fail inside the guard, past every check here.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const r = await run(fakePrimus([inv('I1')]), ledger, PILOT);

  const { row } = r.candidates[0];
  assert.ok(Number.isInteger(row.id), 'row.id must be the ledger primary key');
  assert.equal(row.primus_invoice_id, 'I1');
  assert.equal(row.first_sent_at, null);
});

test('claiming happens here too — an unclaimed red invoice is claimed, then offered', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  assert.equal(db.count('ledger'), 0);

  const r = await run(fakePrimus([inv('I1')]), ledger, PILOT);
  assert.equal(db.count('ledger'), 1);
  assert.equal(r.claimed, 1);
  assert.equal(r.candidates.length, 1);
});

test('an already-claimed invoice is not re-claimed, and is still offered', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  await ledger.claim({ primusInvoiceId: 'I1', arCode: '1234', totalCents: 100 });

  const r = await run(fakePrimus([inv('I1')]), ledger, PILOT);
  assert.equal(db.count('ledger'), 1);
  assert.equal(r.alreadyClaimed, 1);
  assert.equal(r.candidates.length, 1, 'a claimed-but-unsent invoice is exactly the normal case');
});

test('the claim captures the dates the ledger now has columns for', async () => {
  // Statements 5 and 6, applied 2026-08-17. Captured at claim from the LIST, which is the only
  // place they appear — the detail does not carry them.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  await run(fakePrimus([inv('I1')]), ledger, PILOT);
  const row = await ledger.get('I1');
  assert.equal(row.issue_date, '2026-07-09 13:10:29');
  assert.equal(row.invoice_due_date, '2026-08-08');
  assert.equal(row.customer_reference, 'POI1');
});

// ── the summary ──────────────────────────────────────────────────────────────────────────────

test('every skipped invoice is accounted for in the summary', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const { row } = await ledger.claim({ primusInvoiceId: 'SENT', arCode: '1234', totalCents: 100 });
  await ledger.markFirstSent(row.id);

  const rows = [
    inv('RED'),
    inv('GREEN', { status: { sent: true } }),
    inv('SENT'),
    inv('OTHER', { ARCode: '2395' }),
    inv('UNGEN', { status: { generated: false } }),
  ];
  const r = await run(fakePrimus(rows), ledger, PILOT);

  assert.equal(r.seen, 5);
  assert.equal(r.candidates.length, 1);
  assert.equal(r.notRed + r.alreadySentByUs + r.skippedNotAllowed + r.notGenerated + r.candidates.length,
    r.seen, 'the counters must add up to what was seen — an unexplained gap hides a skipped invoice');
});

test('the wildcard bound still works, for a widened pilot', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const r = await run(fakePrimus([inv('I1'), inv('I2', { ARCode: '2395' })]), ledger, ANY_AR);
  assert.equal(r.candidates.length, 2);
});

// ── it does not send ─────────────────────────────────────────────────────────────────────────

test('COLLECTING IS NOT SENDING — this module has no transport and no guard', async () => {
  // The separation is the point: candidates are chosen here, and whether anything leaves is the
  // send guard's decision. A module that did both would put the mode switch behind a query.
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/send-candidates.js', import.meta.url), 'utf8'));
  for (const forbidden of ['SendGuard', 'sendgrid', 'transport']) {
    assert.ok(!new RegExp(forbidden, 'i').test(src.replace(/^\s*(\/\/|\*).*$/gm, '')),
      `send-candidates.js references ${forbidden} — collecting must not become sending`);
  }
});
