// CONTROL 9 — a create whose customer join misses must REFUSE, and must never create a customer.
//
// ── THIS RED IS NOT THE SAME KIND OF RED AS THE ONES IN ledger.test.mjs ───────────────────────
//
// Those reproduce a defect: they were run against unmodified source, failed, and the failure was
// the bug itself. THIS test is red because the code under test DOES NOT EXIST YET. That is much
// weaker evidence — it proves only that nothing is there, which was never in doubt. It becomes
// real evidence the moment a create path exists and this test still passes.
//
// The distinction is in the test names so it survives into a session that did not watch it happen.
//
// ── WHY THE CONTROL EXISTS ────────────────────────────────────────────────────────────────────
//
// The Stripe customer id lives in `stripe_customer`, keyed (mode, ar_code), joined at read time —
// there is deliberately no denormalised copy on `ledger` (schema.sql). So a create path can find
// itself holding a ledger row whose ARCode has no customer row. The tempting repair is to create
// the customer right there. That is EXACTLY the customer orphan: a Stripe object made outside the
// claim-before-create discipline, which nothing is holding a claim for and no re-run can re-find.
//
// Refusing is the correct behaviour, and asserting the refusal alone is not enough — a path could
// refuse only AFTER calling Stripe. So the recorder below asserts that nothing was called at all.
//
// Belt and braces with the credential: the Task 2 restricted key carries Customers = READ, so this
// is also unreachable at the API layer (spec §8.869). The credential makes the failure impossible;
// this test makes the INTENT explicit, and survives the day Customers = Write is granted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger } from '../src/ledger.js';
import { freshDb } from './helpers.mjs';

/**
 * A CALL RECORDER. Deliberately NOT a response simulator.
 *
 * It records the call and throws. It returns no Stripe-shaped object, because control 9 asserts
 * that these are never called — so there is no response to model, and modelling one would quietly
 * make this double into a specification for the real client. The real Stripe client is Task 2 and
 * must not inherit its design from a test fixture.
 *
 * If this ever needs to return something to keep a test moving, that is the signal to stop and
 * raise it rather than grow it here.
 */
function stripeCallRecorder() {
  const calls = [];
  const record = name => (...args) => {
    calls.push({ name, args });
    throw new Error(`control 9 violated: ${name} was called`);
  };
  return { calls, createCustomer: record('createCustomer'), createInvoice: record('createInvoice') };
}

/**
 * Printed BY THE FAILURE, not left in a comment.
 *
 * Once the attach guard lands this is the only red test in the suite, and a single standing red
 * normalises within days and then gets deleted by someone tidying up. Nobody opens the file when
 * the suite is green-except-one — so the reason has to be in the output they actually see.
 */
const WHY_RED = [
  '',
  '  ── CONTROL 9 IS RED BY ABSENCE, NOT BY DEFECT ──',
  '  Nothing is broken. This test is pending implementation of src/create.js',
  '  (createInvoiceForClaimedRow). It goes green on its own the moment that lands.',
  '',
  '  DO NOT DELETE THIS TEST TO GREEN THE SUITE.',
  '  Delete it only if the create path is abandoned outright. It is the only thing',
  '  asserting that a create never implicitly creates a Stripe customer — the',
  '  customer-orphan failure mode (spec §4.2, §8.869).',
  '',
].join('\n');

test('PENDING-IMPLEMENTATION (red by absence, not by defect): a create whose customer join misses refuses, and creates no customer', async () => {
  // PROVISIONAL PATH AND SIGNATURE. Neither exists yet, so this test is naming both — see the
  // note reported alongside this file. If the entry point lands elsewhere, fix it here; do not
  // weaken the assertions to accommodate it.
  let mod = null;
  try {
    mod = await import('../src/create.js');
  } catch {
    /* not built — asserted below with a useful message rather than an import crash */
  }

  assert.ok(mod, `src/create.js does not exist yet — control 9 has nothing to enforce${WHY_RED}`);
  assert.equal(typeof mod.createInvoiceForClaimedRow, 'function',
    `src/create.js exists but exports no createInvoiceForClaimedRow${WHY_RED}`);

  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const { row } = await ledger.claim({ primusInvoiceId: '141604', bolNumber: '160135796', arCode: '1234' });

  // The join misses: nothing was ever inserted into stripe_customer for (test, 1234).
  const stripe = stripeCallRecorder();
  const result = await mod.createInvoiceForClaimedRow({ db, ledger, stripe, row });

  assert.equal(result.ok, false, 'a missing customer join must refuse');
  assert.equal(result.reason, 'no_stripe_customer');

  // The load-bearing assertion. Refusing after calling Stripe is still an orphan.
  assert.deepEqual(stripe.calls, [], 'nothing may be sent to Stripe — not even the customer create');

  // And it must leave the claim intact for a retry rather than burning it.
  const after = await ledger.get('141604');
  assert.equal(after.stripe_invoice_id, null);
});
