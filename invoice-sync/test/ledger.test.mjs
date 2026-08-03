// Exit gate for spec phase 2: the ledger must refuse a duplicate claim regardless of timing.
//
// Run:  node --test invoice-sync/test/
//
// SCOPE, stated honestly: this runs the real schema.sql and the real Ledger class against
// node:sqlite, which is the same engine D1 is built on, so it proves the CONSTRAINT SEMANTICS —
// that the UNIQUE key, the mode namespacing, the partial index, and the conditional lease update
// behave as intended. It does NOT prove D1's distributed behaviour end to end. That needs a
// `wrangler dev --remote` run with two overlapping invocations, which is a deploy-time check.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger, idempotencyKey } from '../src/ledger.js';
import { freshDb } from './helpers.mjs';

test('schema applies cleanly', () => {
  assert.ok(freshDb());
});

test('a second claim for the same invoice is refused', async () => {
  const ledger = new Ledger(freshDb(), 'test');
  const a = await ledger.claim({ primusInvoiceId: '141886', bolNumber: '160133942', arCode: '5406' });
  const b = await ledger.claim({ primusInvoiceId: '141886', bolNumber: '160133942', arCode: '5406' });

  assert.equal(a.claimed, true, 'first claim wins');
  assert.equal(b.claimed, false, 'second claim is refused, not an error');
  assert.equal(b.row.id, a.row.id, 'the loser sees the winner row');
  assert.equal(a.row.stripe_state, 'intent');
});

test('a burst of claims for one invoice yields exactly one winner', async () => {
  // Simulates the overlapping-cron case the whole design exists to survive.
  const ledger = new Ledger(freshDb(), 'test');
  const results = [];
  for (let i = 0; i < 25; i++) results.push(await ledger.claim({ primusInvoiceId: '999001', bolNumber: 'B1' }));
  assert.equal(results.filter(r => r.claimed).length, 1);
});

test('test-mode rows never suppress a live-mode claim', async () => {
  // The silent failure this guards: a test row suppressing the live create, whose symptom is
  // "we never billed them" and which nobody notices until the customer does.
  const db = freshDb();
  const testLedger = new Ledger(db, 'test');
  const liveLedger = new Ledger(db, 'live');

  const t = await testLedger.claim({ primusInvoiceId: '141886' });
  const l = await liveLedger.claim({ primusInvoiceId: '141886' });

  assert.equal(t.claimed, true);
  assert.equal(l.claimed, true, 'live claim must not be blocked by the test-mode row');
  assert.notEqual(t.row.id, l.row.id);
  assert.equal(t.row.idempotency_key, idempotencyKey('test', '141886', 1));
  assert.equal(l.row.idempotency_key, idempotencyKey('live', '141886', 1));
});

test('a reissue claims a new version rather than colliding', async () => {
  const ledger = new Ledger(freshDb(), 'test');
  await ledger.claim({ primusInvoiceId: '141886' });
  const v = await ledger.nextVersion('141886');
  assert.equal(v, 2);

  const reissue = await ledger.claim({ primusInvoiceId: '141886', version: v });
  assert.equal(reissue.claimed, true);
  assert.equal((await ledger.versionsOf('141886')).length, 2);
});

test('two ledger rows cannot claim the same Stripe invoice', async () => {
  const ledger = new Ledger(freshDb(), 'test');
  const a = await ledger.claim({ primusInvoiceId: 'A' });
  const b = await ledger.claim({ primusInvoiceId: 'B' });
  await ledger.attachStripeInvoice(a.row.id, 'in_test_123');
  await assert.rejects(
    () => ledger.attachStripeInvoice(b.row.id, 'in_test_123'),
    /UNIQUE|constraint/i,
    'the partial unique index must reject a shared stripe_invoice_id'
  );
});

test('many intent rows with no Stripe invoice coexist', async () => {
  // Guards against the partial index being written without its WHERE clause, which would make
  // NULL stripe_invoice_id collide and break every claim after the first.
  const ledger = new Ledger(freshDb(), 'test');
  for (let i = 0; i < 5; i++) {
    const r = await ledger.claim({ primusInvoiceId: `INV${i}` });
    assert.equal(r.claimed, true);
  }
});

test('classification is written once and never overwritten', async () => {
  const ledger = new Ledger(freshDb(), 'test');
  const { row } = await ledger.claim({ primusInvoiceId: '141886', bolNumber: 'B9' });

  assert.equal(await ledger.setClassification(row.id, 'primary'), true);
  assert.equal(await ledger.setClassification(row.id, 'rebill'), false, 'a later run must not reclassify');
  assert.equal((await ledger.get('141886')).classification, 'primary');
});

test('BOL siblings surface for the layer-3 guard, excluding void and failed', async () => {
  const ledger = new Ledger(freshDb(), 'test');
  const a = await ledger.claim({ primusInvoiceId: 'I1', bolNumber: '160133942' });
  const b = await ledger.claim({ primusInvoiceId: 'I2', bolNumber: '160133942' });
  await ledger.claim({ primusInvoiceId: 'I3', bolNumber: '160133942' });
  await ledger.attachStripeInvoice(a.row.id, 'in_1', 'finalized');
  await ledger.setState(b.row.id, 'void');

  const siblings = await ledger.siblingsOfBol('160133942');
  assert.equal(siblings.length, 2);
  assert.ok(!siblings.some(s => s.stripe_state === 'void'));
});

test('reconcile sweep includes draft and uncollectible, not just finalized', async () => {
  const ledger = new Ledger(freshDb(), 'test');
  const states = ['draft', 'finalized', 'uncollectible', 'paid', 'void', 'intent'];
  for (const [i, st] of states.entries()) {
    const { row } = await ledger.claim({ primusInvoiceId: `S${i}` });
    await ledger.setState(row.id, st);
  }
  const open = await ledger.openForReconcile();
  assert.deepEqual(open.map(r => r.stripe_state).sort(), ['draft', 'finalized', 'uncollectible']);
});

test('exceptions upsert and count repeats instead of duplicating', async () => {
  const ledger = new Ledger(freshDb(), 'test');
  await ledger.recordException('unmatched_ar_code', '7788', 'no QBO DisplayName suffix');
  await ledger.recordException('unmatched_ar_code', '7788');
  await ledger.recordException('unknown_doc_type', 'WHATSIT');

  const open = await ledger.openExceptions();
  assert.equal(open.length, 2);
  const ar = open.find(e => e.kind === 'unmatched_ar_code');
  assert.equal(ar.seen_count, 2);
  assert.equal(ar.detail, 'no QBO DisplayName suffix', 'a later bare report must not erase the detail');
});

test('a quarantine row is visibly distinct from an operational exception', async () => {
  // Reading a data gap as a fetch failure has already cost a debugging round (spec §0.25).
  const ledger = new Ledger(freshDb(), 'test');
  await ledger.recordException('fetch_failed', 'invoice:1', 'HTTP 503');
  await ledger.quarantine('2', 'null_required_value', 'null required value(s): total');

  const quarantines = await ledger.openQuarantines();
  assert.equal(quarantines.length, 1, 'only the quarantine matches the prefix');
  assert.equal(quarantines[0].kind, 'quarantine:null_required_value');
  assert.equal(quarantines[0].ref, 'invoice:2');
  assert.ok(!quarantines.some(q => q.kind === 'fetch_failed'));

  assert.equal((await ledger.openExceptions()).length, 2, 'both remain visible in the full list');
});

test('quarantines are per-mode like every other ledger row', async () => {
  const db = freshDb();
  await new Ledger(db, 'test').quarantine('1', 'null_required_value', 'x');
  assert.equal((await new Ledger(db, 'live').openQuarantines()).length, 0);
});

test('the lease admits one holder at a time', async () => {
  const ledger = new Ledger(freshDb(), 'test');
  assert.equal(await ledger.acquireLease('sync', 'run-A', 60_000), true);
  assert.equal(await ledger.acquireLease('sync', 'run-B', 60_000), false, 'concurrent run must back off');

  await ledger.releaseLease('sync', 'run-A');
  assert.equal(await ledger.acquireLease('sync', 'run-B', 60_000), true, 'released lease is takeable');
});

test('an expired lease is taken over', async () => {
  // A run killed by CPU limits never reaches its release; without expiry takeover the sync
  // wedges until a human notices. Negative TTL stands in for "held, but expiry has passed".
  const ledger = new Ledger(freshDb(), 'test');
  assert.equal(await ledger.acquireLease('sync', 'run-A', -1), true);
  assert.equal(await ledger.acquireLease('sync', 'run-B', 60_000), true, 'expired lease is takeable');
});

test('releasing with the wrong holder is a no-op', async () => {
  // run() releases in a finally block using its own runId. If a slow run lost the lease by expiry
  // and the next run took it over, the slow run's release must not evict the new holder.
  const ledger = new Ledger(freshDb(), 'test');
  await ledger.acquireLease('sync', 'run-A', -1);
  await ledger.acquireLease('sync', 'run-B', 60_000);

  await ledger.releaseLease('sync', 'run-A');
  assert.equal(await ledger.acquireLease('sync', 'run-C', 60_000), false, "run-B's lease must survive");
});

test('a lease is per-mode', async () => {
  const db = freshDb();
  assert.equal(await new Ledger(db, 'test').acquireLease('sync', 'r1', 60_000), true);
  assert.equal(await new Ledger(db, 'live').acquireLease('sync', 'r2', 60_000), true);
});

test('Ledger refuses to construct without an explicit mode', () => {
  assert.throws(() => new Ledger(freshDb(), undefined), /explicit mode/);
  assert.throws(() => new Ledger(freshDb(), 'prod'), /explicit mode/);
});
