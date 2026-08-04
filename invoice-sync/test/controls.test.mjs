// THE NINE CONTROLS, enumerated in one place (spec §8.872).
//
// This file is the INDEX. Several controls were pinned as they were built and their tests live
// with the code they guard; those are cross-referenced by name rather than duplicated, because two
// copies of a control is how one of them quietly stops being maintained. What is NEW here is
// everything that had no home: the round trip (1), the create-path halves of 7 and 8, and the
// vocabulary itself.
//
//   1  claim -> attach -> a re-run does not re-create ............ HERE
//   2  a second customer claim is refused ....................... stripe-customer.test.mjs
//   3  creating -> read Stripe -> adopt ......................... HERE, red by absence
//   4  a test-mode row cannot satisfy a live lookup ............. stripe-customer.test.mjs
//   5  two ARCodes cannot share one Stripe customer ............. stripe-customer.test.mjs (+ HERE, shape)
//   6  attach refuses a DIFFERENT invoice id .................... ledger.test.mjs
//   7  a `creating` row is never safe to create ................. HERE (primitive) + red by absence (create path)
//   8  a non-allowlisted row cannot be materialized ............. allowlist-bound.test.mjs + HERE, red by absence
//   9  a missing customer join refuses, creates nothing ......... create.test.mjs, red by absence
//
// THREE ARE RED BY ABSENCE — 3, the create-path half of 7, and the create-path half of 8. They say
// so in their names AND in their output, so none of them can be read as a defect or tidied away.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger } from '../src/ledger.js';
import { StripeCustomers } from '../src/stripe-customer.js';
import { REFUSAL_REASONS, refuse, allow } from '../src/refusals.js';
import { assertLivemode } from '../src/config.js';
import { freshDb, ANY_AR, onlyAr, whyRed } from './helpers.mjs';

const PILOT = onlyAr('1234');

// ── the vocabulary itself ────────────────────────────────────────────────────────────────────

test('the refusal set is closed — a coined synonym is refused', () => {
  assert.deepEqual(refuse(REFUSAL_REASONS.NOT_ALLOWLISTED), { ok: false, reason: 'not_allowlisted' });
  assert.deepEqual(allow(), { ok: true });

  // The failure this prevents: five different words for "this ARCode did not work out" already
  // exist across four layers. A sixth must not be coinable by typo.
  assert.throws(() => refuse('not_allow_listed'), /Unknown refusal reason/);
  assert.throws(() => refuse('customer_missing'), /Unknown refusal reason/);
});

test('not_allowlisted reuses checkArCode\'s existing string rather than coining a synonym', async () => {
  const { checkArCode, loadArAllowlist } = await import('../src/config.js');
  const verdict = checkArCode(loadArAllowlist({ AR_ALLOWLIST: '1234' }), '5406');
  assert.equal(verdict.reason, REFUSAL_REASONS.NOT_ALLOWLISTED,
    'one condition, one name — across both layers');
});

test('THROWS ARE NOT REFUSALS: a broken invariant must not be handleable as an outcome', () => {
  // A caller able to write `if (!result.ok)` past a mode mismatch is a caller that can ignore it.
  assert.throws(() => assertLivemode('test', { livemode: true }), /livemode=true/);
  assert.throws(() => assertLivemode('test', {}), /cannot be verified/);

  // Same category: a claim outside the bound means a caller skipped the poll's filter — a
  // programming error, not a business condition a correct system reaches on an ordinary Tuesday.
  const ledger = new Ledger(freshDb(), 'test', PILOT);
  assert.rejects(() => ledger.claim({ primusInvoiceId: 'I1', arCode: '5406' }), /outside AR_ALLOWLIST/);
});

// ── CONTROL 1 — the round trip ───────────────────────────────────────────────────────────────

test('CONTROL 1: claim -> attach -> a re-run reads the ids and does NOT create again', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const customers = new StripeCustomers(db, 'test', PILOT);

  const { row } = await ledger.claim({ primusInvoiceId: '141604', bolNumber: '160135796', arCode: '1234' });
  const cust = await customers.claim({ arCode: '1234' });
  assert.deepEqual(await customers.attach(cust.row.id, 'cus_PILOT'), { ok: true });
  assert.deepEqual(await ledger.attachStripeInvoice(row.id, 'in_PILOT'), { ok: true });

  // The re-run: same inputs, second pass. Both claims are refused as already-owned, and BOTH ids
  // are re-findable — which is the whole point of persisting them. A re-run that could not find
  // them would create a duplicate and orphan the first.
  assert.equal((await ledger.claim({ primusInvoiceId: '141604', arCode: '1234' })).claimed, false);
  assert.equal((await customers.claim({ arCode: '1234' })).claimed, false);
  assert.equal((await ledger.get('141604')).stripe_invoice_id, 'in_PILOT');
  assert.equal(await customers.idFor('1234'), 'cus_PILOT');

  // And the join resolves, which is what makes the ledger's missing stripe_customer_id column sound.
  const joined = db.rows(
    `SELECT c.stripe_customer_id AS cus FROM ledger l
       LEFT JOIN stripe_customer c ON c.mode = l.mode AND c.ar_code = l.ar_code
      WHERE l.primus_invoice_id = '141604'`
  );
  assert.equal(joined[0].cus, 'cus_PILOT');
});

// ── CONTROL 5 — the shape, not just the refusal ──────────────────────────────────────────────

test('CONTROL 5: a mis-join refuses in the DOMAIN vocabulary, never the storage engine\'s', async () => {
  const c = new StripeCustomers(freshDb(), 'test', ANY_AR);
  const a = await c.claim({ arCode: '1234' });
  const b = await c.claim({ arCode: '9999' });
  await c.attach(a.row.id, 'cus_ONE');

  const r = await c.attach(b.row.id, 'cus_ONE');
  assert.deepEqual(r, {
    ok: false,
    reason: REFUSAL_REASONS.CUSTOMER_ID_ALREADY_CLAIMED,
    detail: { heldBy: '1234' },
  });
});

test('CONTROL 5: the catch is NARROW — an unrelated failure is rethrown, not swallowed', async () => {
  // The constraint that produces control 5 and the (mode, ar_code) constraint carry the SAME
  // SQLite code (2067); only the message differs, and D1 wraps messages differently from
  // node:sqlite. So classification is by RE-READING STATE, never by matching text — and anything
  // the re-read does not confirm must propagate untouched.
  const db = freshDb();
  const c = new StripeCustomers(db, 'test', ANY_AR);
  const { row } = await c.claim({ arCode: '1234' });

  const boom = new Error('disk I/O error');
  const realPrepare = db.prepare.bind(db);
  db.prepare = sql => (sql.includes('UPDATE stripe_customer') ? { bind: () => ({ run: () => { throw boom; } }) } : realPrepare(sql));

  await assert.rejects(() => c.attach(row.id, 'cus_NEW'), /disk I\/O error/,
    'a failure the re-read cannot confirm as a mis-join must not become a refusal');
  db.prepare = realPrepare;
});

// ── CONTROL 7 — the primitive half is buildable; the create-path half is not ─────────────────

test('CONTROL 7: a `creating` row is not re-creatable, and surfaces to the orphan sweep', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const { row } = await ledger.claim({ primusInvoiceId: '141604', arCode: '1234' });

  assert.equal(await ledger.markCreating(row.id), true);
  assert.equal(await ledger.markCreating(row.id), false,
    'a row already in `creating` cannot be marked again — the outcome is unknown, not restartable');

  // It is invisible to reconcile (a paid-check on an invoice that may not exist is meaningless)
  // and visible to the sweep that exists for exactly this state, once it is stale.
  db.raw.prepare('UPDATE ledger SET updated_at = ? WHERE id = ?').run(Date.now() - 60 * 60 * 1000, row.id);
  assert.deepEqual((await ledger.openForReconcile()).map(r => r.id), []);
  assert.deepEqual((await ledger.openCreating()).map(r => r.id), [row.id]);
});

test(`CONTROL 7 create path — PENDING-IMPLEMENTATION (red by absence, not by defect): a create must REFUSE a row in \`creating\``, async () => {
  const WHY = whyRed(
    'src/create.js (createInvoiceForClaimedRow)',
    'Resolving a `creating` row means READING Stripe (list, never search — §4.1),\n  which needs the client. Until then nothing enforces that a create refuses one.'
  );
  let mod = null;
  try { mod = await import('../src/create.js'); } catch { /* not built */ }
  assert.ok(mod, `src/create.js does not exist yet — control 7's create path has nothing to enforce${WHY}`);

  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  const { row } = await ledger.claim({ primusInvoiceId: '141604', arCode: '1234' });
  await ledger.markCreating(row.id);

  const calls = [];
  const stripe = { createCustomer: () => { calls.push('createCustomer'); throw new Error('must not be called'); },
                   createInvoice: () => { calls.push('createInvoice'); throw new Error('must not be called'); } };
  const r = await mod.createInvoiceForClaimedRow({ db, ledger, stripe, row: await ledger.get('141604') });

  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSAL_REASONS.CREATE_IN_FLIGHT);
  assert.deepEqual(calls, [], 'an unresolved create must not be followed by another one');
});

// ── CONTROL 8 — the primitive half is proven against production data; the create path is not ──

test(`CONTROL 8 create path — PENDING-IMPLEMENTATION (red by absence, not by defect): a create must REFUSE an out-of-bound row`, async () => {
  const WHY = whyRed(
    'src/create.js (createInvoiceForClaimedRow)',
    'The BOUND itself is enforced and tested (allowlist-bound.test.mjs, against the 11\n  real Payless rows). What is unbuilt is the create path returning not_allowlisted\n  rather than simply finding the row unaddressable.'
  );
  let mod = null;
  try { mod = await import('../src/create.js'); } catch { /* not built */ }
  assert.ok(mod, `src/create.js does not exist yet — control 8's create path has nothing to enforce${WHY}`);

  const db = freshDb();
  const wide = new Ledger(db, 'test', ANY_AR);
  const { row } = await wide.claim({ primusInvoiceId: '140061', arCode: '5406' });
  const pilot = new Ledger(db, 'test', PILOT);

  const calls = [];
  const stripe = { createInvoice: () => { calls.push('createInvoice'); throw new Error('must not be called'); } };
  const r = await mod.createInvoiceForClaimedRow({ db, ledger: pilot, stripe, row });

  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSAL_REASONS.NOT_ALLOWLISTED);
  assert.deepEqual(calls, []);
});

// ── CONTROL 3 — wholly dependent on the Stripe client ────────────────────────────────────────

test(`CONTROL 3 — PENDING-IMPLEMENTATION (red by absence, not by defect): a stale \`creating\` row is resolved by READING Stripe and adopting, never by creating`, async () => {
  const WHY = whyRed(
    'the Stripe client (Task 2) and src/create.js',
    'This is the orphan-recovery path: a create that succeeded while its ledger write\n  was lost. Resolution is a LIST by customer matched on the invoice number we set —\n  never Search, which lags ~1min and would let two runs both see "no match" (§4.1).\n  It cannot be exercised at all today: invoice-sync-test is EXPIRED and no key exists.'
  );
  let mod = null;
  try { mod = await import('../src/create.js'); } catch { /* not built */ }
  assert.ok(mod, `no create path and no Stripe client — control 3 has nothing to enforce${WHY}`);
  assert.equal(typeof mod.resolveCreating, 'function', `no resolveCreating to test${WHY}`);
});
