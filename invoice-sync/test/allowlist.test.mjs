// Spec §3.1 — pilot customer allowlist.
//
// The property under test is that this fails CLOSED. An allowlist that silently degrades to
// "everything" during the pilot would create Stripe drafts for the full book (~1733/month), which
// is the exact outcome the pilot scoping exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadArAllowlist, checkArCode } from '../src/config.js';

test('an unset or empty allowlist throws rather than meaning everything', () => {
  for (const raw of [undefined, null, '', '   ', ',', ' , , ']) {
    assert.throws(() => loadArAllowlist({ AR_ALLOWLIST: raw }), /AR_ALLOWLIST/,
      `${JSON.stringify(raw)} must not be read as "allow all"`);
  }
});

test('the pilot ARCode is allowed and everything else is not', () => {
  const allow = loadArAllowlist({ AR_ALLOWLIST: '5406' });   // Payless Rugs
  assert.equal(checkArCode(allow, '5406').allowed, true);
  assert.equal(checkArCode(allow, '2395').allowed, false);   // Bison Office
  assert.equal(checkArCode(allow, '2395').reason, 'not_allowlisted');
});

test('multiple codes, whitespace and case tolerated', () => {
  const allow = loadArAllowlist({ AR_ALLOWLIST: ' 5406 , 2395 ,ab12 ' });
  assert.equal(checkArCode(allow, '5406').allowed, true);
  assert.equal(checkArCode(allow, '2395').allowed, true);
  assert.equal(checkArCode(allow, 'AB12').allowed, true);
  assert.equal(checkArCode(allow, '9999').allowed, false);
});

test('a missing ARCode is never allowed', () => {
  const allow = loadArAllowlist({ AR_ALLOWLIST: '5406' });
  for (const v of [undefined, null, '', '  ']) {
    const r = checkArCode(allow, v);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'missing_ar_code');
  }
});

test('a leading-zero mismatch reports near_miss instead of skipping silently', () => {
  // "The pilot ran a week and billed nothing" and "the pilot is correctly scoped" look identical
  // from the outside. This is the difference.
  const allow = loadArAllowlist({ AR_ALLOWLIST: '05406' });
  const r = checkArCode(allow, '5406');
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'near_miss');

  const reverse = checkArCode(loadArAllowlist({ AR_ALLOWLIST: '5406' }), '05406');
  assert.equal(reverse.reason, 'near_miss');
});

test('an unrelated code is not reported as a near miss', () => {
  const allow = loadArAllowlist({ AR_ALLOWLIST: '5406' });
  assert.equal(checkArCode(allow, '406').reason, 'not_allowlisted');
  assert.equal(checkArCode(allow, '54060').reason, 'not_allowlisted');
});

test('wildcard runs the full book and says so', () => {
  const allow = loadArAllowlist({ AR_ALLOWLIST: '*' });
  assert.equal(allow.all, true);
  assert.equal(checkArCode(allow, '2395').reason, 'wildcard');
  assert.equal(checkArCode(allow, 'anything').allowed, true);
});

test('wildcard must be exact — no accidental globbing', () => {
  const allow = loadArAllowlist({ AR_ALLOWLIST: '54*' });
  assert.equal(allow.all, false);
  assert.equal(checkArCode(allow, '5406').allowed, false);
});
