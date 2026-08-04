// stripe_customer claim/attach + the `creating` transition + the orphan sweep + the livemode gate.
//
// Every test here asserts BOTH directions: that the mechanism does its job, and that it refuses
// when it should. A guard only tested in the passing direction is a guard that can be satisfied by
// refusing everything.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StripeCustomers, STRIPE_CUSTOMER_STATES, customerIdempotencyKey } from '../src/stripe-customer.js';
import { Ledger, STRIPE_STATES } from '../src/ledger.js';
import { assertLivemode } from '../src/config.js';
import { freshDb, ANY_AR } from './helpers.mjs';

// ── claim ────────────────────────────────────────────────────────────────────────────────────

test('a second claim for the same ARCode is refused, not an error', async () => {
  const c = new StripeCustomers(freshDb(), 'test', ANY_AR);
  const a = await c.claim({ arCode: '1234', qboDisplayName: 'Freight and Logistics, Inc. - TEST-1234' });
  const b = await c.claim({ arCode: '1234' });

  assert.equal(a.claimed, true, 'first claim wins');
  assert.equal(b.claimed, false, 'second is refused, not an error — re-seeing a customer is free');
  assert.equal(b.row.id, a.row.id, 'the loser sees the winner row');
  assert.equal(a.row.state, 'intent');
  assert.equal(a.row.stripe_customer_id, null);
});

test('NEGATIVE CONTROL: a test-mode claim does not satisfy a live-mode lookup', async () => {
  const db = freshDb();
  const testMode = new StripeCustomers(db, 'test', ANY_AR);
  const liveMode = new StripeCustomers(db, 'live', ANY_AR);

  await testMode.claim({ arCode: '1234' });
  await testMode.attach((await testMode.get('1234')).id, 'cus_TEST');

  assert.equal(await liveMode.idFor('1234'), null,
    'a test-mode customer must never be handed to a live-mode create');
  const live = await liveMode.claim({ arCode: '1234' });
  assert.equal(live.claimed, true, 'live mode claims its own row rather than being suppressed');
});

test('claim refuses an empty ARCode rather than creating an unkeyed row', async () => {
  const c = new StripeCustomers(freshDb(), 'test', ANY_AR);
  for (const bad of [null, undefined, '', '   ']) {
    await assert.rejects(() => c.claim({ arCode: bad }), /requires an arCode/);
  }
});

test('the idempotency key is mode-namespaced and case-normalised', () => {
  assert.equal(customerIdempotencyKey('test', ' 1234 '), 'test-primus-ar-1234');
  assert.notEqual(customerIdempotencyKey('test', '1234'), customerIdempotencyKey('live', '1234'));
});

// ── attach: write-once per id ────────────────────────────────────────────────────────────────

test('attach refuses to overwrite a DIFFERENT stripe_customer_id', async () => {
  const c = new StripeCustomers(freshDb(), 'test', ANY_AR);
  const { row } = await c.claim({ arCode: '1234' });

  assert.equal(await c.attach(row.id, 'cus_FIRST'), true);
  assert.equal(await c.attach(row.id, 'cus_SECOND'), false, 'a different id is refused');
  assert.equal(await c.idFor('1234'), 'cus_FIRST', 'overwriting would strand cus_FIRST in Stripe');
  assert.equal((await c.get('1234')).state, 'created');
});

test('attach is idempotent for the SAME id — a retry is not a conflict', async () => {
  const c = new StripeCustomers(freshDb(), 'test', ANY_AR);
  const { row } = await c.claim({ arCode: '1234' });
  assert.equal(await c.attach(row.id, 'cus_SAME'), true);
  assert.equal(await c.attach(row.id, 'cus_SAME'), true);
});

test('attach refuses a falsy id — it would satisfy the IS NULL branch forever', async () => {
  const c = new StripeCustomers(freshDb(), 'test', ANY_AR);
  const { row } = await c.claim({ arCode: '1234' });
  await assert.rejects(() => c.attach(row.id, null), /requires a stripeCustomerId/);
  await assert.rejects(() => c.attach(row.id, ''), /requires a stripeCustomerId/);
});

test('CONTROL 5 at the database: two ARCodes cannot share one Stripe customer', async () => {
  const c = new StripeCustomers(freshDb(), 'test', ANY_AR);
  const a = await c.claim({ arCode: '1234' });
  const b = await c.claim({ arCode: '9999' });
  assert.equal(await c.attach(a.row.id, 'cus_SHARED'), true);
  await assert.rejects(() => c.attach(b.row.id, 'cus_SHARED'), /UNIQUE/,
    'the partial unique index rejects a mis-join rather than billing one company as another');
});

// ── the creating transition ──────────────────────────────────────────────────────────────────

test("markCreating moves intent -> creating, and failed -> creating for a retry", async () => {
  const c = new StripeCustomers(freshDb(), 'test', ANY_AR);
  const { row } = await c.claim({ arCode: '1234' });

  assert.equal(await c.markCreating(row.id), true);
  assert.equal((await c.get('1234')).state, 'creating');

  await c.recordFailure(row.id, 'stripe 500');
  assert.equal((await c.get('1234')).state, 'failed');
  assert.equal(await c.markCreating(row.id), true, 'a failed row is retryable');
});

test('markCreating REFUSES once an id is attached — an existing customer is not re-created', async () => {
  const c = new StripeCustomers(freshDb(), 'test', ANY_AR);
  const { row } = await c.claim({ arCode: '1234' });
  await c.attach(row.id, 'cus_1');

  assert.equal(await c.markCreating(row.id), false);
  assert.equal((await c.get('1234')).state, 'created', 'state is unchanged');
});

test("'creating' is a legal state on both tables, and a typo is refused loudly", async () => {
  assert.ok(STRIPE_CUSTOMER_STATES.includes('creating'));
  assert.ok(STRIPE_STATES.includes('creating'));

  const c = new StripeCustomers(freshDb(), 'test', ANY_AR);
  const { row } = await c.claim({ arCode: '1234' });
  await assert.rejects(() => c.setState(row.id, 'createing'), /Unknown stripe_customer state/);

  const ledger = new Ledger(freshDb(), 'test', ANY_AR);
  const l = await ledger.claim({ primusInvoiceId: 'I1' });
  await assert.rejects(() => ledger.setState(l.row.id, 'createing'), /Unknown stripe_state/);
});

// ── the orphan sweep ─────────────────────────────────────────────────────────────────────────

test('openCreating returns only STALE creating rows — a run in flight is left alone', async () => {
  const db = freshDb();
  const c = new StripeCustomers(db, 'test', ANY_AR);
  const fresh = await c.claim({ arCode: '1111' });
  const stale = await c.claim({ arCode: '2222' });
  await c.markCreating(fresh.row.id);
  await c.markCreating(stale.row.id);

  // Age the second row past the threshold.
  db.raw.prepare('UPDATE stripe_customer SET updated_at = ? WHERE id = ?')
    .run(Date.now() - 60 * 60 * 1000, stale.row.id);

  const candidates = await c.openCreating();
  assert.deepEqual(candidates.map(r => r.ar_code), ['2222'],
    'sweeping a row out from under a running create is how a second create happens');
});

test('the ledger sweep is separate from reconcile: creating is in one and not the other', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', ANY_AR);
  const states = ['draft', 'finalized', 'uncollectible', 'paid', 'void', 'intent'];
  for (const [i, st] of states.entries()) {
    const { row } = await ledger.claim({ primusInvoiceId: `S${i}` });
    await ledger.setState(row.id, st);
  }
  const c = await ledger.claim({ primusInvoiceId: 'C1' });
  await ledger.markCreating(c.row.id);
  db.raw.prepare('UPDATE ledger SET updated_at = ? WHERE id = ?')
    .run(Date.now() - 60 * 60 * 1000, c.row.id);

  const reconcile = await ledger.openForReconcile();
  assert.deepEqual(reconcile.map(r => r.stripe_state).sort(), ['draft', 'finalized', 'uncollectible'],
    'reconcile asks "was it paid", which is meaningless for an invoice that may not exist');

  const orphans = await ledger.openCreating();
  assert.deepEqual(orphans.map(r => r.primus_invoice_id), ['C1']);
});

test('ledger markCreating refuses once an invoice id is attached', async () => {
  const ledger = new Ledger(freshDb(), 'test', ANY_AR);
  const { row } = await ledger.claim({ primusInvoiceId: 'I1' });
  await ledger.attachStripeInvoice(row.id, 'in_1');
  assert.equal(await ledger.markCreating(row.id), false);
  assert.equal((await ledger.get('I1')).stripe_state, 'draft');
});

// ── the livemode gate ────────────────────────────────────────────────────────────────────────

test('assertLivemode accepts only the server-asserted mode that matches', () => {
  assert.equal(assertLivemode('test', { livemode: false }), 'test');
  assert.equal(assertLivemode('live', { livemode: true }), 'live');
});

test('NEGATIVE CONTROL: a live-mode response under STRIPE_MODE=test hard-fails', () => {
  assert.throws(() => assertLivemode('test', { livemode: true }),
    /livemode=true but STRIPE_MODE='test'/);
  assert.throws(() => assertLivemode('live', { livemode: false }),
    /livemode=false but STRIPE_MODE='live'/);
});

test('NEGATIVE CONTROL: an unverifiable response fails closed, it does not pass', () => {
  // "Cannot verify" must never read as "fine" — the whole point of not trusting the key prefix.
  for (const bad of [null, undefined, {}, { livemode: 'false' }, { livemode: 0 }, { livemode: null }]) {
    assert.throws(() => assertLivemode('test', bad), /cannot be verified/,
      `a response shaped ${JSON.stringify(bad)} must not be treated as a pass`);
  }
});
