// The pilot bound, held by the object rather than remembered at each call site (spec §3.1).
//
// WHY THIS SHAPE. The allowlist is the pilot's BLAST-RADIUS BOUND. Enforcing it at eleven call
// sites is the failure it exists to prevent, reproduced inside the mechanism meant to prevent it —
// the bound would be only as good as the least careful caller. `mode` already proves the
// alternative works: every query carries `AND mode = ?` because the constructor holds it, not
// because eleven authors remembered. The allowlist is now held the same way.
//
// TWO DELIBERATE EXCEPTIONS, both asserted below so they cannot be "tidied" into consistency:
//   * siblingsOfBol stays UNFILTERED — a read that forces explicit classification must be able to
//     see a collision spanning an allowlisted and a non-allowlisted customer.
//   * the near-miss / missing-code writes in invoices.js exist PRECISELY to record non-allowlisted
//     codes, and gating them would silence the only signal that distinguishes "correctly scoped"
//     from "ran for a week and billed nothing."

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger } from '../src/ledger.js';
import { StripeCustomers } from '../src/stripe-customer.js';
import { allowlistPredicate, isAllowlisted } from '../src/arcode.js';
import { resolveClaimedCustomers } from '../src/customers.js';
import { freshDb, ANY_AR, onlyAr } from './helpers.mjs';

const PILOT = onlyAr('1234');

// ── the bound is not optional ────────────────────────────────────────────────────────────────

test('both classes REFUSE to be constructed without an allowlist', () => {
  const db = freshDb();
  for (const ctor of [Ledger, StripeCustomers]) {
    assert.throws(() => new ctor(db, 'test'), /explicit AR allowlist/,
      `${ctor.name} must not default the bound`);
    assert.throws(() => new ctor(db, 'test', null), /explicit AR allowlist/);
    // The shape matters too: a bare array or a plain object would silently behave as "nothing".
    assert.throws(() => new ctor(db, 'test', { all: false }), /explicit AR allowlist/);
    assert.throws(() => new ctor(db, 'test', ['1234']), /explicit AR allowlist/);
  }
});

test('an absent bound must never silently mean everything', () => {
  assert.throws(() => allowlistPredicate(undefined), /never defaulted/);
  assert.throws(() => allowlistPredicate({ all: false, codes: ['1234'] }), /never defaulted/);
});

// ── claim refuses LOUDLY ─────────────────────────────────────────────────────────────────────

test('claim THROWS for a non-allowlisted ARCode, on both tables', async () => {
  const ledger = new Ledger(freshDb(), 'test', PILOT);
  const customers = new StripeCustomers(freshDb(), 'test', PILOT);

  await assert.rejects(() => ledger.claim({ primusInvoiceId: 'I1', arCode: '5406' }),
    /outside AR_ALLOWLIST/);
  await assert.rejects(() => customers.claim({ arCode: '5406' }), /outside AR_ALLOWLIST/);

  // Throwing rather than returning claimed:false is the point. A silent refusal is
  // indistinguishable from "already claimed", and the invoice is then suppressed forever with no
  // signal anywhere — the never-billed failure §3.1's ordering rule exists to prevent.
});

test('claim ACCEPTS an allowlisted code, normalised', async () => {
  const ledger = new Ledger(freshDb(), 'test', PILOT);
  assert.equal((await ledger.claim({ primusInvoiceId: 'I1', arCode: ' 1234 ' })).claimed, true);
});

test('a NULL ARCode PASSES the bound — "no code" is not "a code outside the bound"', async () => {
  // Such a row reaches no customer: resolveClaimedCustomers filters `ar_code IS NOT NULL`, and the
  // poll records an exception and skips before it can be claimed. Refusing here would fail a case
  // already handled correctly one layer up.
  const ledger = new Ledger(freshDb(), 'test', PILOT);
  assert.equal((await ledger.claim({ primusInvoiceId: 'I1' })).claimed, true);
  assert.equal((await ledger.claim({ primusInvoiceId: 'I2', arCode: null })).claimed, true);
  assert.equal(isAllowlisted(PILOT, null), true);
  assert.equal(isAllowlisted(PILOT, '   '), true);
});

// ── THE LIVE SCENARIO: rows claimed before the allowlist narrowed ─────────────────────────────

test('a row claimed under a WIDER allowlist cannot be advanced under a NARROWER one', async () => {
  // This is not hypothetical. Remote D1 holds 11 rows with ar_code 5406 (Payless), claimed while
  // AR_ALLOWLIST was "5406"; the pilot is now "1234". Those rows are the live fixture for exactly
  // this: they exist, they are outside the bound, and nothing may advance them.
  const db = freshDb();
  const wide = new Ledger(db, 'test', ANY_AR);
  const pilot = new Ledger(db, 'test', PILOT);

  const { row } = await wide.claim({ primusInvoiceId: '140061', bolNumber: '160133034', arCode: '5406' });

  // Every state-advancing write refuses it — not by remembering to check, but because the row is
  // not addressable through a Ledger whose bound excludes it.
  assert.equal((await pilot.attachStripeInvoice(row.id, 'in_X')).ok, false, 'attachStripeInvoice');
  assert.equal(await pilot.markCreating(row.id), false, 'markCreating');
  assert.equal(await pilot.setState(row.id, 'draft'), false, 'setState');
  assert.equal(await pilot.setClassification(row.id, 'primary'), false, 'setClassification');
  assert.equal(await pilot.recordFailure(row.id, 'x'), false, 'recordFailure');
  assert.equal(await pilot.markPaidFirstSeen(row.id), false, 'markPaidFirstSeen');
  assert.equal(await pilot.supersede(row.id, 999), false, 'supersede');

  // The row is untouched — no half-applied state.
  const after = await wide.get('140061');
  assert.equal(after.stripe_state, 'intent');
  assert.equal(after.stripe_invoice_id, null);
  assert.equal(after.classification, null);
  assert.equal(after.paid_first_seen_at, null);

  // And the SAME calls succeed through a Ledger whose bound includes it, so the refusals above are
  // the bound acting, not the guards being broken.
  assert.deepEqual(await wide.attachStripeInvoice(row.id, 'in_X'), { ok: true });
});

test('the customer table refuses the same way', async () => {
  const db = freshDb();
  const wide = new StripeCustomers(db, 'test', ANY_AR);
  const pilot = new StripeCustomers(db, 'test', PILOT);

  const { row } = await wide.claim({ arCode: '5406' });
  assert.equal(await pilot.get('5406'), null, 'not even readable through the narrower bound');
  assert.equal(await pilot.idFor('5406'), null);
  assert.equal(await pilot.markCreating(row.id), false);
  assert.equal((await pilot.attach(row.id, 'cus_X')).ok, false);
  assert.equal(await pilot.setState(row.id, 'failed'), false);
  assert.equal(await pilot.recordFailure(row.id, 'x'), false);

  assert.equal((await wide.get('5406')).state, 'intent', 'untouched');
});

// ── the sweeps ───────────────────────────────────────────────────────────────────────────────

test('both sweeps exclude out-of-bound rows', async () => {
  const db = freshDb();
  const wide = new Ledger(db, 'test', ANY_AR);
  const pilot = new Ledger(db, 'test', PILOT);

  const outside = await wide.claim({ primusInvoiceId: 'OUT', arCode: '5406' });
  const inside = await wide.claim({ primusInvoiceId: 'IN', arCode: '1234' });
  await wide.setState(outside.row.id, 'draft');
  await wide.setState(inside.row.id, 'draft');

  assert.deepEqual((await pilot.openForReconcile()).map(r => r.primus_invoice_id), ['IN']);
  assert.deepEqual((await wide.openForReconcile()).map(r => r.primus_invoice_id).sort(), ['IN', 'OUT']);

  await wide.markCreating((await wide.claim({ primusInvoiceId: 'OUT2', arCode: '5406' })).row.id);
  await wide.markCreating((await wide.claim({ primusInvoiceId: 'IN2', arCode: '1234' })).row.id);
  db.raw.prepare('UPDATE ledger SET updated_at = ? WHERE stripe_state = ?')
    .run(Date.now() - 60 * 60 * 1000, 'creating');

  assert.deepEqual((await pilot.openCreating()).map(r => r.primus_invoice_id), ['IN2']);
});

test('the customer sweep excludes out-of-bound rows', async () => {
  const db = freshDb();
  const wide = new StripeCustomers(db, 'test', ANY_AR);
  const pilot = new StripeCustomers(db, 'test', PILOT);
  for (const code of ['5406', '1234']) {
    const { row } = await wide.claim({ arCode: code });
    await wide.markCreating(row.id);
  }
  db.raw.prepare('UPDATE stripe_customer SET updated_at = ?').run(Date.now() - 60 * 60 * 1000);

  assert.deepEqual((await pilot.openCreating()).map(r => r.ar_code), ['1234']);
  assert.deepEqual((await wide.openCreating()).map(r => r.ar_code).sort(), ['1234', '5406']);
});

// ── EXCEPTION 1: siblingsOfBol must stay unfiltered ──────────────────────────────────────────

test('EXCEPTION: siblingsOfBol SEES a collision spanning the bound — do not "fix" this', async () => {
  // A BOL collision can span an allowlisted and a non-allowlisted customer. Filtering this read
  // would hide exactly that collision, and the caller would then create silently where it should
  // have held for explicit classification. The bound limits what we WRITE, not what we can SEE
  // before writing — narrowing a safety read makes it blinder.
  const db = freshDb();
  const wide = new Ledger(db, 'test', ANY_AR);
  const pilot = new Ledger(db, 'test', PILOT);

  await wide.claim({ primusInvoiceId: 'A', bolNumber: 'BOL1', arCode: '1234' });
  await wide.claim({ primusInvoiceId: 'B', bolNumber: 'BOL1', arCode: '5406' });

  const seen = await pilot.siblingsOfBol('BOL1');
  assert.deepEqual(seen.map(r => r.primus_invoice_id).sort(), ['A', 'B'],
    'the out-of-bound sibling MUST still be visible to the layer-3 guard');
});

// ── EXCEPTION 2: the exception queue must record out-of-bound codes ──────────────────────────

test('EXCEPTION: recordException still records a non-allowlisted ARCode', async () => {
  // These rows exist precisely to say "a code outside the bound was seen, and here it is."
  // Gating them would silence the only signal distinguishing a correctly-scoped pilot from one
  // that ran for a week and billed nothing. recordException advances no state — it is a report.
  const pilot = new Ledger(freshDb(), 'test', PILOT);
  await pilot.recordException('unmatched_ar_code', '5406', 'differs only by leading zeros');
  const open = await pilot.openExceptions();
  assert.deepEqual(open.map(r => r.ref), ['5406']);
});

// ── the wildcard ─────────────────────────────────────────────────────────────────────────────

test('the wildcard bound admits everything, and is the only way to get that', async () => {
  const ledger = new Ledger(freshDb(), 'test', ANY_AR);
  for (const code of ['1234', '5406', 'ZZZZ', null]) {
    assert.equal((await ledger.claim({ primusInvoiceId: `I-${code}`, arCode: code })).claimed, true);
  }
  assert.deepEqual(allowlistPredicate(ANY_AR), { sql: '1 = 1', params: [] });
});

// ── B3: the sweep that was already crossing the bound in production ──────────────────────────

test('resolveClaimedCustomers no longer reaches out-of-bound customers', async () => {
  // The live crossing. On remote D1 this sweep reached 11 Payless rows (ar_code 5406, claimed when
  // AR_ALLOWLIST was "5406"; the pilot is now "1234") on EVERY run — doing a QBO lookup and caching
  // that customer's email addresses for an account outside the pilot. No ledger state changed and
  // no billing risk, which is exactly why it went unnoticed.
  const db = freshDb();
  const wide = new Ledger(db, 'test', ANY_AR);
  await wide.claim({ primusInvoiceId: '140061', arCode: '5406' });
  await wide.claim({ primusInvoiceId: '141604', arCode: '1234' });

  const pilot = new Ledger(db, 'test', PILOT);
  const calls = [];
  const primus = {
    async get(path, params) {
      calls.push(params && params.name);
      return { data: { results: [] } };
    },
  };
  await resolveClaimedCustomers({ primus, db, ledger: pilot });

  assert.deepEqual(calls, ['1234'], 'no QBO lookup may be issued for a customer outside the bound');
});
