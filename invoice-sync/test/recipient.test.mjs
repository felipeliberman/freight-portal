// PIECE A — THE RECIPIENT RULE (Phase 1, deliver-and-inform).
//
//     node --test invoice-sync/test/recipient.test.mjs
//
// NO NETWORK, NO CREDENTIALS, NO SEND PATH. Every case below runs against records captured from
// the live console on 2026-08-16 (test/fixtures/console-records.mjs) and asserts the rule
// transcribed from Primus's own `MyDesktop.EmailWindow`.
//
// WHAT THESE TESTS ARE ACTUALLY DEFENDING. A wrong recipient does not fail — it DELIVERS, to a
// real person, at a company that is not ours to show freight detail and amounts to, and nothing
// anywhere reports it. Every assertion here is about one of the three ways that happens:
//
//   1. reading the wrong FIELD          (the `remitToSL` truthiness trap)
//   2. falling through to another field (cross-source fallback on empty or junk)
//   3. losing addresses in parsing      (multi-address fields, silently truncated)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRecipient, selectRecipientSource, assertRecipientSource,
  isRemitToShippingLocation, isRemitToBillingAddress, RECIPIENT_SOURCES,
} from '../src/recipient.js';
import { REFUSAL_REASONS } from '../src/refusals.js';
import { newValueSink, formatEmailDrops } from '../src/detail.js';
import { ANY_AR, onlyAr } from './helpers.mjs';
import {
  FL_TEST, BISON, HAYNES, KB_AUTHORITY, UNBEATABLE_SALE, OCI, NET_RETAILERS, LIVE_RECORDS,
  SYNTHETIC_WITH_ACCOUNTING, SYNTHETIC_ACCOUNTING_JUNK, SYNTHETIC_EMPTY_BILLING,
  SYNTHETIC_NO_REMIT_FLAG,
} from './fixtures/console-records.mjs';

const ok = r => { assert.equal(r.ok, true, `expected success, got refusal ${r.reason}`); return r.value; };
const no = r => { assert.equal(r.ok, false, 'expected a refusal'); return r; };

// ── precedence ───────────────────────────────────────────────────────────────────────────────

test('accounting contacts BEAT both email fields', () => {
  const v = ok(resolveRecipient(SYNTHETIC_WITH_ACCOUNTING, ANY_AR));
  assert.equal(v.source, RECIPIENT_SOURCES.ACCOUNTING_CONTACTS);
  assert.deepEqual(v.to, ['ap1@synthetic.example', 'ap2@synthetic.example']);
  // The record also carries a billing address and a main address. Neither may appear.
  assert.ok(!v.to.includes('billing@synthetic.example'));
  assert.ok(!v.to.includes('shipping@synthetic.example'));
});

test('remitToSL=0 selects the BILLING address, not the main one', () => {
  const v = ok(resolveRecipient(BISON, ANY_AR));
  assert.equal(v.source, RECIPIENT_SOURCES.BILLING_EMAIL);
  assert.deepEqual(v.to, ['accounting@bisoncommerce.com']);
  assert.ok(!v.to.includes('shipping@bisoncommerce.com'), 'the shipping desk must not be billed');
});

test('remitToSL=1 selects the MAIN address', () => {
  const v = ok(resolveRecipient(FL_TEST, ANY_AR));
  assert.equal(v.source, RECIPIENT_SOURCES.MAIN_EMAIL);
  assert.deepEqual(v.to, ['felipe@freightandlogistics.com']);
});

test('THE CASE MAIN-ONLY CANNOT SERVE: empty main, populated billing', () => {
  // Haynes has no main email at all. A resolver that read `email` would produce no recipient and
  // the invoice would never be sent — and this is the account every write test here runs through.
  const v = ok(resolveRecipient(HAYNES, ANY_AR));
  assert.equal(v.source, RECIPIENT_SOURCES.BILLING_EMAIL);
  assert.deepEqual(v.to, ['sarah@haynesbrosfurniture.com']);
});

// ── the truthiness trap ──────────────────────────────────────────────────────────────────────

test("remitToSL '0' is TRUTHY in JS — both branches must match explicitly", () => {
  assert.equal(Boolean('0'), true, 'the trap itself: a naive if(remitToSL) is true for BOTH states');

  assert.equal(isRemitToShippingLocation('1'), true);
  assert.equal(isRemitToShippingLocation('0'), false);
  assert.equal(isRemitToBillingAddress('0'), true);
  assert.equal(isRemitToBillingAddress('1'), false);

  // And neither predicate may be the negation of the other: an ABSENT flag must satisfy neither,
  // or a missing field silently picks a branch.
  assert.equal(isRemitToShippingLocation(undefined), false);
  assert.equal(isRemitToBillingAddress(undefined), false);
  assert.equal(isRemitToShippingLocation(''), false);
  assert.equal(isRemitToBillingAddress(''), false);
});

test('an unrecognised remitToSL REFUSES rather than defaulting either way', () => {
  const r = no(resolveRecipient(SYNTHETIC_NO_REMIT_FLAG, ANY_AR));
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_SOURCE_UNKNOWN);
  for (const bad of ['', 'X', null, 2, {}]) {
    const s = selectRecipientSource({ ...SYNTHETIC_NO_REMIT_FLAG, remitToSL: bad });
    assert.equal(s.ok, false, `remitToSL=${JSON.stringify(bad)} must not resolve to a field`);
  }
});

// ── no cross-source fallback ─────────────────────────────────────────────────────────────────

test('an EMPTY selected source refuses — it never falls through to the other field', () => {
  const r = no(resolveRecipient(SYNTHETIC_EMPTY_BILLING, ANY_AR));
  assert.equal(r.reason, REFUSAL_REASONS.NO_RECIPIENT);
  assert.equal(r.detail.source, RECIPIENT_SOURCES.BILLING_EMAIL);
  // The record HAS a usable main address. Using it would email the shipping desk an invoice the
  // console says goes to AP — a decision nobody made, taken silently.
  assert.ok(JSON.stringify(r).indexOf('shipping@synthetic.example') === -1);
});

test('accounting contacts that parse to NOTHING refuse — the documented divergence from Primus', () => {
  // Primus falls through here (it only checks array length, not whether the addresses are usable).
  // We refuse: falling through emails a different party than the console screen shows.
  const r = no(resolveRecipient(SYNTHETIC_ACCOUNTING_JUNK, ANY_AR));
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_UNPARSEABLE);
  assert.equal(r.detail.source, RECIPIENT_SOURCES.ACCOUNTING_CONTACTS);
  const asText = JSON.stringify(r);
  assert.ok(!asText.includes('good@synthetic.example'), 'must not reach the main address');
  assert.ok(!asText.includes('alsogood@synthetic.example'), 'must not reach the billing address');
});

test('EMPTY and UNPARSEABLE are different refusals — they need different human actions', () => {
  const empty = no(resolveRecipient({ ...BISON, billingEmail: '   ' }, ANY_AR));
  const junk = no(resolveRecipient({ ...BISON, billingEmail: 'Accounts Payable' }, ANY_AR));
  assert.equal(empty.reason, REFUSAL_REASONS.NO_RECIPIENT);
  assert.equal(junk.reason, REFUSAL_REASONS.RECIPIENT_UNPARSEABLE);
  assert.notEqual(empty.reason, junk.reason);
  assert.ok(junk.detail.dropped.length > 0, 'the junk refusal must say WHY the token was discarded');
});

// ── multi-address fields ─────────────────────────────────────────────────────────────────────

test('every address on a multi-address field survives', () => {
  assert.deepEqual(ok(resolveRecipient(KB_AUTHORITY, ANY_AR)).to,
    ['po@kbauthority.com', 'Madina@KBAuthority.com']);
});

test('case-only duplicates are deduped, first spelling wins', () => {
  // AP@ and ap@ are the same mailbox. Two copies of one invoice reads as a system that sent twice.
  const v = ok(resolveRecipient(UNBEATABLE_SALE, ANY_AR));
  assert.deepEqual(v.to, [
    'AP@unbeatablesale.com', 'kpascale@unbeatablesale.com', 'freight@unbeatablesale.com',
  ]);
  assert.equal(new Set(v.to.map(a => a.toLowerCase())).size, v.to.length);
  assert.ok(v.dropped.includes('duplicate'));
});

test('an address appearing on BOTH fields is not an error', () => {
  assert.deepEqual(ok(resolveRecipient(OCI, ANY_AR)).to,
    ['accounting@ocielectronics.com', 'bashi@ocielectronics.com']);
});

test('the billing field wins even when BOTH fields are multi-address', () => {
  const v = ok(resolveRecipient(NET_RETAILERS, ANY_AR));
  assert.deepEqual(v.to, ['invoices@netretailers.net']);
  assert.equal(v.to.some(a => /netretailers\.com/i.test(a)), false);
});

// ── the pilot bound ──────────────────────────────────────────────────────────────────────────

test('the allowlist is REQUIRED — it is never defaulted', () => {
  assert.throws(() => resolveRecipient(FL_TEST), /never defaulted/);
  assert.throws(() => resolveRecipient(FL_TEST, { all: false }), /never defaulted/);
});

test('a customer outside the bound refuses before any address is read', () => {
  const r = no(resolveRecipient(BISON, onlyAr('1234')));
  assert.equal(r.reason, REFUSAL_REASONS.NOT_ALLOWLISTED);
  assert.ok(!JSON.stringify(r).includes('@'), 'a refused customer must not leak an address');
});

test('the pilot customer resolves under the pilot bound', () => {
  assert.deepEqual(ok(resolveRecipient(FL_TEST, onlyAr('1234'))).to,
    ['felipe@freightandlogistics.com']);
});

// ── the source vocabulary ────────────────────────────────────────────────────────────────────

test('every resolution names a source from the closed set', () => {
  for (const rec of [...LIVE_RECORDS, SYNTHETIC_WITH_ACCOUNTING]) {
    const r = resolveRecipient(rec, ANY_AR);
    if (!r.ok) continue;
    assertRecipientSource(r.value.source);   // throws on anything outside the set
  }
});

test('an invented source throws — it must never reach invoice_send.recipient_source', () => {
  assert.throws(() => assertRecipientSource('billing'), /Unknown recipient source/);
  assert.throws(() => assertRecipientSource('console_billing'), /Unknown recipient source/);
});

// ── the live sweep ───────────────────────────────────────────────────────────────────────────

test('SWEEP: all seven live records resolve, and no main address is used where an override exists', () => {
  const overrideRecords = LIVE_RECORDS.filter(r => r.remitToSL === '0');
  assert.equal(overrideRecords.length, 6, 'six of the seven captured records carry the override');

  for (const rec of LIVE_RECORDS) {
    const v = ok(resolveRecipient(rec, ANY_AR));
    assert.ok(v.to.length > 0, `${rec.name} resolved to nothing`);
    if (rec.remitToSL === '0') {
      assert.equal(v.source, RECIPIENT_SOURCES.BILLING_EMAIL, `${rec.name} must use the override`);
      const main = String(rec.email || '').toLowerCase();
      if (main && !String(rec.billingEmail).toLowerCase().includes(main)) {
        assert.ok(!v.to.map(a => a.toLowerCase()).includes(main),
          `${rec.name}: the main address must not appear when an override is set`);
      }
    }
  }
});

test('SWEEP: main-only would have misrouted or failed on six of the seven', () => {
  // The counterfactual, asserted rather than claimed — this is the number that justifies reading
  // the console at all, and it should fail loudly if someone "simplifies" the rule later.
  let wrongOrMissing = 0;
  for (const rec of LIVE_RECORDS) {
    const correct = ok(resolveRecipient(rec, ANY_AR)).to.map(a => a.toLowerCase()).sort();
    const mainOnly = String(rec.email || '').split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean).sort();
    if (JSON.stringify(correct) !== JSON.stringify(mainOnly)) wrongOrMissing++;
  }
  assert.equal(wrongOrMissing, 6);
});

// ── drop accounting ──────────────────────────────────────────────────────────────────────────

test('discarded tokens are counted on the run sink AND reported per record', () => {
  const sink = newValueSink();
  const v = ok(resolveRecipient({ ...BISON, billingEmail: 'ap@bison, accounting@bisoncommerce.com' }, ANY_AR, sink));
  assert.deepEqual(v.to, ['accounting@bisoncommerce.com']);
  assert.deepEqual(v.dropped, ['no_dotted_domain']);
  assert.ok(formatEmailDrops(sink).some(l => l.startsWith('email.dropped.no_dotted_domain')));
});
