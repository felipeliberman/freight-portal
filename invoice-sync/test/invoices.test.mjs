// Spec phase 3 — invoice list poll.
//
// Exit gate: a full window replayed twice produces zero duplicate ledger rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger } from '../src/ledger.js';
import { checkArCode, loadArAllowlist } from '../src/config.js';
import { windowFor, normalizePage, toCents, listInvoices, pollWindow } from '../src/invoices.js';
import { freshDb, fakePrimus, inv, ANY_AR } from './helpers.mjs';

const PILOT = loadArAllowlist({ AR_ALLOWLIST: '5406' });

function poll(primus, ledger, allowlist = PILOT, limit = 100) {
  return pollWindow({
    primus, ledger, allowlist, checkArCode,
    issuedFrom: '2026-07-01', issuedTo: '2026-07-31', limit,
  });
}

// ── window ───────────────────────────────────────────────────────────────────────────────────

// THESE TWO WERE CHANGED, NOT ADDED, and the reason matters: they previously asserted
// `issuedTo === ymd(now)`, which encoded a WRONG BELIEF about the API rather than a requirement.
// `issuedTo` is EXCLUSIVE — measured live 2026-08-17: `07-09 → 07-09` returns 0 rows while
// `07-09 → 07-10` returns 102, all dated 07-09. So the old expectation was green while the poll
// silently skipped every invoice issued on the current day. A test can be green and wrong.

test('the window ends TOMORROW, because issuedTo is exclusive', () => {
  const w = windowFor(Date.UTC(2026, 7, 3, 17, 30), 7);
  assert.equal(w.issuedTo, '2026-08-04', 'the day after "now" — anything less excludes today');
  assert.equal(w.issuedFrom, '2026-07-27');
});

test('the window pads single-digit months and days', () => {
  const w = windowFor(Date.UTC(2026, 0, 8), 7);
  assert.equal(w.issuedTo, '2026-01-09');
  assert.equal(w.issuedFrom, '2026-01-01');
});

test('TODAY IS INSIDE THE WINDOW — the property the off-by-one broke', () => {
  // Stated as the invariant rather than as a date arithmetic detail, so it survives a future
  // rewrite of how the ends are computed.
  const now = Date.UTC(2026, 7, 17, 23, 59);
  const { issuedFrom, issuedTo } = windowFor(now, 7);
  const today = '2026-08-17';
  assert.ok(today >= issuedFrom, 'today must not precede the start');
  assert.ok(today < issuedTo, 'today must fall strictly inside an EXCLUSIVE end');
});

test('the window crosses a month boundary without losing the day', () => {
  const w = windowFor(Date.UTC(2026, 6, 31, 12, 0), 7);
  assert.equal(w.issuedTo, '2026-08-01');
  assert.equal(w.issuedFrom, '2026-07-24');
});

// ── envelope + money ─────────────────────────────────────────────────────────────────────────

test('every plausible list envelope is understood', () => {
  const rows = [inv(1), inv(2)];
  for (const body of [
    { data: { results: rows, totalResults: 9 } },
    { data: rows, totalResults: 9 },
    { results: rows, totalResults: 9 },
  ]) {
    const p = normalizePage(body);
    assert.equal(p.rows.length, 2);
    assert.equal(p.totalResults, 9);
  }
  assert.equal(normalizePage(rows).rows.length, 2, 'a bare array is accepted');
});

test('an unrecognised envelope throws with key names only, never values', () => {
  // A silent empty page would be indistinguishable from a quiet week. And the thrown message must
  // not carry field values — a list record neighbours cost data (spec §6.3).
  try {
    normalizePage({ payload: { rows: [], secretCost: 42.5 } });
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /Unrecognised Primus invoice list envelope/);
    assert.match(e.message, /payload/);
    assert.doesNotMatch(e.message, /42\.5/);
  }
});

test('totalResults is read from pagingDetails — the live envelope shape', () => {
  // Verified against the real API 2026-08-03: {data:{pagingDetails,results,message}}.
  const p = normalizePage({ data: { pagingDetails: { totalResults: 1733, page: 1 }, results: [inv(1)] } });
  assert.equal(p.totalResults, 1733);
  assert.equal(p.shape, 'data.results');
  assert.match(p.keys, /paging/);
});

test('a page count is never mistaken for a result count', () => {
  // totalPages read as totalResults would make the shortfall guard fire on every single run.
  assert.equal(normalizePage({ data: { pagingDetails: { totalPages: 5 }, results: [] } }).totalResults, null);
});

test('totalResults is not confused with an invoice amount', () => {
  // `total` beside `results` would be the money field, not a count.
  assert.equal(normalizePage({ data: { results: [], total: 1234.56 } }).totalResults, null);
});

test('money parses like the portal parseMoney rule and never yields NaN', () => {
  assert.equal(toCents(1234.56), 123456);
  assert.equal(toCents('$1,234.56'), 123456);
  assert.equal(toCents('0'), 0);
  assert.equal(toCents(0), 0);
  for (const bad of [null, undefined, '', 'n/a', {}]) assert.equal(toCents(bad), null, `${JSON.stringify(bad)}`);
});

// ── pagination ───────────────────────────────────────────────────────────────────────────────

test('pagination walks every page and stops on a short one', async () => {
  const primus = fakePrimus(Array.from({ length: 250 }, (_, i) => inv(i + 1)));
  const stats = {};
  const out = [];
  for await (const r of listInvoices(primus, { issuedFrom: 'a', issuedTo: 'b', limit: 100 }, stats)) out.push(r);

  assert.equal(out.length, 250);
  assert.equal(stats.pages, 3);
  assert.equal(stats.unique, 250);
});

test('an invoice appearing on two pages is yielded once', async () => {
  // The page-shift case: invoices are editable after issuance, so a record can move between pages
  // mid-poll and be seen twice.
  const dupes = [inv(1), inv(2), inv(2), inv(3)];
  const primus = fakePrimus(dupes);
  const out = [];
  for await (const r of listInvoices(primus, { issuedFrom: 'a', issuedTo: 'b', limit: 2 }, {})) out.push(r);
  assert.deepEqual(out.map(r => r.invoiceId), [1, 2, 3]);
});

test('a pager that repeats itself terminates instead of looping forever', async () => {
  // Guards a runaway loop against a shared production API.
  let calls = 0;
  const stuck = { async get() { calls++; return { data: { results: [inv(1), inv(2)] } }; } };
  const out = [];
  for await (const r of listInvoices(stuck, { issuedFrom: 'a', issuedTo: 'b', limit: 2 }, {})) out.push(r);
  assert.equal(out.length, 2);
  assert.ok(calls <= 3, `expected an early stop, made ${calls} calls`);
});

test('the page cap backstops both other termination guards', async () => {
  let n = 0;
  const endless = { async get() { return { data: { results: [inv(++n), inv(++n)] } }; } };
  const stats = {};
  const out = [];
  for await (const r of listInvoices(endless, { issuedFrom: 'a', issuedTo: 'b', limit: 2, maxPages: 5 }, stats)) out.push(r);
  assert.equal(stats.pages, 5);
  assert.equal(out.length, 10);
  assert.equal(stats.hitPageCap, true);
});

test('records with no invoiceId are counted, not silently dropped', async () => {
  const primus = fakePrimus([inv(1), { invoiceNumber: 'orphan' }, inv(2)]);
  const stats = {};
  const out = [];
  for await (const r of listInvoices(primus, { issuedFrom: 'a', issuedTo: 'b', limit: 100 }, stats)) out.push(r);
  assert.equal(out.length, 2);
  assert.equal(stats.missingId, 1);
});

// ── the exit gate ────────────────────────────────────────────────────────────────────────────

test('EXIT GATE: a full window replayed twice creates zero duplicate ledger rows', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const invoices = Array.from({ length: 250 }, (_, i) => inv(i + 1));
  const primus = fakePrimus(invoices);

  const first = await poll(primus, ledger);
  assert.equal(first.claimed, 250);
  assert.equal(first.alreadyClaimed, 0);
  assert.equal(db.count('ledger'), 250);

  const second = await poll(primus, ledger);
  assert.equal(second.claimed, 0, 'a replay must claim nothing new');
  assert.equal(second.alreadyClaimed, 250);
  assert.equal(db.count('ledger'), 250, 'row count must be unchanged after the replay');
});

test('overlapping windows over shifted data still converge to one row per invoice', async () => {
  // What the rolling 7-day window actually does day to day: yesterday's tail re-polled alongside
  // today's new invoices.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);

  await poll(fakePrimus([inv(1), inv(2), inv(3)]), ledger, PILOT, 2);
  await poll(fakePrimus([inv(2), inv(3), inv(4), inv(5)]), ledger, PILOT, 2);
  await poll(fakePrimus([inv(4), inv(5), inv(6)]), ledger, PILOT, 2);

  assert.equal(db.count('ledger'), 6);
});

// ── filters ──────────────────────────────────────────────────────────────────────────────────

test('a non-allowlisted invoice leaves NO ledger row', async () => {
  // Load-bearing (spec §3.1): recording skips would make claim() return false forever once the
  // allowlist widens, permanently suppressing them.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const primus = fakePrimus([inv(1), inv(2, { ARCode: '2395' }), inv(3, { ARCode: '9999' })]);

  const s = await poll(primus, ledger);
  assert.equal(s.claimed, 1);
  assert.equal(s.skippedNotAllowed, 2);
  assert.equal(db.count('ledger'), 1);
  assert.equal(db.rows('SELECT ar_code FROM ledger')[0].ar_code, '5406');
});

test('widening the allowlist later picks up previously skipped invoices', async () => {
  // The consequence of not recording skips: they must still be claimable afterwards.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const invoices = [inv(1), inv(2, { ARCode: '2395' })];

  await poll(fakePrimus(invoices), ledger);
  assert.equal(db.count('ledger'), 1);

  await poll(fakePrimus(invoices), ledger, loadArAllowlist({ AR_ALLOWLIST: '*' }));
  assert.equal(db.count('ledger'), 2);
});

test('an ARCode near miss is recorded as an exception, not skipped silently', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const allow = loadArAllowlist({ AR_ALLOWLIST: '05406' });

  const s = await poll(fakePrimus([inv(1)]), ledger, allow);
  assert.equal(s.claimed, 0);
  assert.equal(s.nearMiss, 1);

  const open = await ledger.openExceptions();
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, 'unmatched_ar_code');
  assert.match(open[0].detail, /leading zeros/);
});

test('an invoice with no ARCode is recorded and not claimed', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const s = await poll(fakePrimus([inv(1, { ARCode: null })]), ledger);
  assert.equal(s.missingArCode, 1);
  assert.equal(db.count('ledger'), 0);
  assert.equal((await ledger.openExceptions())[0].kind, 'unmatched_ar_code');
});

test('invoices that are not generated are skipped', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const primus = fakePrimus([
    inv(1),
    inv(2, { status: { generated: false } }),
    inv(3, { status: {} }),
    inv(4, { status: { generated: 'true' } }),   // must be boolean true, not truthy
  ]);
  const s = await poll(primus, ledger);
  assert.equal(s.claimed, 1);
  assert.equal(s.notGenerated, 3);
  assert.equal(db.count('ledger'), 1);
});

test('an unparseable total is not claimed on a guessed amount', async () => {
  // Storing a wrong total would drive a bogus void-and-reissue at phase 6 (spec §4.4).
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const s = await poll(fakePrimus([inv(1, { total: 'ask accounting' })]), ledger);
  assert.equal(s.missingTotal, 1);
  assert.equal(db.count('ledger'), 0);
  assert.equal((await ledger.openExceptions())[0].kind, 'fetch_failed');
});

test('a zero-dollar invoice is claimed — zero is a real amount, not a missing one', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const s = await poll(fakePrimus([inv(1, { total: 0 })]), ledger);
  assert.equal(s.claimed, 1);
  assert.equal(db.rows('SELECT total_cents FROM ledger')[0].total_cents, 0);
});

// ── drift + integrity ────────────────────────────────────────────────────────────────────────

test('an amount changed after issuance is detected on the next poll', async () => {
  // Spec §4.4 — phase 6 owns the state machine; phase 3 makes the frequency visible.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);

  await poll(fakePrimus([inv(1, { total: 100 })]), ledger);
  const s = await poll(fakePrimus([inv(1, { total: 175.25 })]), ledger);

  assert.equal(s.alreadyClaimed, 1);
  assert.equal(s.totalChanged, 1);
  assert.equal(db.rows('SELECT total_cents FROM ledger')[0].total_cents, 10000, 'phase 3 must not mutate state');
});

test('an unchanged amount is not reported as drift', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  await poll(fakePrimus([inv(1, { total: 100 })]), ledger);
  const s = await poll(fakePrimus([inv(1, { total: '$100.00' })]), ledger);
  assert.equal(s.totalChanged, 0);
});

test('a shortfall against the reported result count is surfaced', async () => {
  // The overlap is supposed to absorb page-shift skips. A persistent shortfall means it is not.
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const primus = fakePrimus([inv(1), inv(2)], { totalResults: 5 });
  const s = await poll(primus, ledger);
  assert.equal(s.unique, 2);
  assert.equal(s.totalResults, 5);
  assert.equal(s.shortfall, 3);
});

test('no shortfall is reported when the counts agree', async () => {
  const db = freshDb();
  const s = await poll(fakePrimus([inv(1), inv(2)]), new Ledger(db, 'test', ANY_AR));
  assert.equal(s.shortfall, undefined);
});

test('the poll sends the window and paging params Primus expects', async () => {
  const primus = fakePrimus([inv(1)]);
  await poll(primus, new Ledger(freshDb(), 'test', ANY_AR));
  assert.equal(primus.calls[0].path, '/invoice');
  assert.deepEqual(primus.calls[0].params, { issuedFrom: '2026-07-01', issuedTo: '2026-07-31', page: 1, limit: 100 });
});
