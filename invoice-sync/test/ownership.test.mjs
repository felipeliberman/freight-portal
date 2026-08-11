// Spec §5.8 (resolve an identifier only within the caller's own scope), §8.874 (GATE 2 — no
// ownership check exists anywhere), §8.876 (VERIFIED 2026-08-04: a customer token returns another
// account's documents, so ownership CANNOT be delegated to Primus).
//
// What these tests are really pinning down is WHERE THE CALLER'S IDENTITY COMES FROM. The portal
// today keys invoice access off `customerEmail` read out of sessionStorage (portal.html:4106,
// :4179) — a string anyone can edit in devtools. Primus already tells us who the caller is, on the
// strength of the username+password IT validated; portal.html:9212-9229 asks it and then
// portal.html:9260 throws the answer away (`arCode: null`, hardcoded).
//
// So the assertions below care as much about WHAT WAS SENT as about what came back: several of
// them inspect the recorded request, because "returned the right code" is not the property that
// matters if it was derived from something the client asserted about itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCallerArCode, ownsInvoice } from '../src/ownership.js';
import { normalizeArCode } from '../src/arcode.js';

/**
 * The customer/portal API host — NOT invoice-sync's PRIMUS_BASE, which is regex-locked to
 * restapi.shipprimus.com and throws if pointed here (config.js:143-148). Two different APIs; this
 * function talks to the one the customer's own token was issued by (portal.html:1236).
 */
const APPLET = 'https://freightandlogistics-api.shipprimus.com';

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.primus-issued-access-token';

/** The live /applet/v1/profile envelope, per portal.html:9212-9229. */
function profileBody(code) {
  return {
    data: {
      results: {
        billToInformation: { id: 1123086640, code, name: 'Haynes Brothers Furniture' },
      },
    },
  };
}

/**
 * A fetch stand-in that RECORDS every call.
 *
 * The counter is the point, not a convenience. Asserting only on the return value cannot tell
 * "refused without asking Primus" from "asked Primus and got nothing back", and those are
 * different security properties: the first is a local refusal, the second is a round trip that
 * carried a credential somewhere. A test that cannot distinguish them would pass for the wrong
 * implementation.
 */
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  fn.calls = calls;
  return fn;
}

const jsonOk = body => () =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const status = code => () => new Response('', { status: code });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// resolveCallerArCode
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('the caller ARCode comes from Primus\'s own profile answer, on the strength of the token alone', async () => {
  // The token is the ONLY thing forwarded. Not an email, not a customer id, not an ARCode the
  // client claims for itself — because the token is the single artefact Primus itself vouches for
  // (it was issued only after Primus validated username+password). Anything else in this request
  // would be the client asserting its own identity, which is exactly the defect being closed.
  const f = stubFetch(jsonOk(profileBody('1234')));
  const code = await resolveCallerArCode(TOKEN, APPLET, f);

  assert.equal(code, '1234');
  assert.equal(f.calls.length, 1, 'exactly one profile call');
  assert.equal(f.calls[0].url, `${APPLET}/applet/v1/profile`);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);

  // NEGATIVE: nothing client-supplied rode along. A caller-identity check that also accepts a
  // client-supplied identifier is not a check — it is a suggestion.
  const sent = JSON.stringify(f.calls[0]);
  for (const leak of ['@', 'customerId', 'customerEmail', 'primusCustomerId', 'arCode']) {
    assert.ok(!sent.includes(leak), `the request carried a client-supplied ${leak}`);
  }
});

test('a mixed-case, padded code normalises to the exact form the ledger stores', async () => {
  // Ledger.claim (ledger.js:151) stores ar_code through normalizeArCode, and Ledger.get returns it
  // already-canonical. If this side did not apply the SAME function, ownership would fail on a
  // formatting difference — and it would fail CLOSED and silently, which is the hardest kind to
  // notice: the customer sees "not found" on their own invoice and reports nothing.
  const f = stubFetch(jsonOk(profileBody('  ab12  ')));
  const code = await resolveCallerArCode(TOKEN, APPLET, f);

  assert.equal(code, 'AB12');
  assert.equal(code, normalizeArCode('  ab12  '), 'must agree with the ledger\'s canonical form');
  assert.ok(ownsInvoice(code, normalizeArCode('ab12')), 'the two canonical forms must match');
});

test('no access token → null, and Primus is NEVER asked', async () => {
  // A missing token is answered locally. Reaching out first would spend a request, and would put a
  // blank credential on the wire, to learn something already known.
  for (const missing of [undefined, null, '', '   ']) {
    const f = stubFetch(() => {
      throw new Error('Primus was called with no access token');
    });
    const code = await resolveCallerArCode(missing, APPLET, f);
    assert.equal(code, null, `token ${JSON.stringify(missing)} must resolve to null`);
    assert.equal(f.calls.length, 0, `token ${JSON.stringify(missing)} reached the network`);
  }
});

test('a non-200 from Primus is null', async () => {
  // 401 and 403 are the interesting ones — an expired or revoked token must not resolve to an
  // ARCode. 404 and 500 collapse to the same answer deliberately (see the no-oracle test below).
  for (const s of [400, 401, 403, 404, 429, 500, 502, 503]) {
    const f = stubFetch(status(s));
    assert.equal(await resolveCallerArCode(TOKEN, APPLET, f), null, `HTTP ${s} must be null`);
    assert.equal(f.calls.length, 1);
  }
});

test('a 200 with an unparseable body is null, and does not throw', async () => {
  // Primus fronts an HTML error page on some failures; a 200 is not a promise of JSON. Throwing
  // here would turn a bad upstream answer into a 500 on our own route, which reads to the customer
  // as our fault and to us as a bug in the wrong file.
  const bodies = ['<html><body>Gateway</body></html>', '', 'null-ish', '{"data":'];
  for (const b of bodies) {
    const f = stubFetch(() => new Response(b, { status: 200, headers: { 'content-type': 'text/html' } }));
    assert.equal(await resolveCallerArCode(TOKEN, APPLET, f), null, `body ${JSON.stringify(b)} must be null`);
  }
});

test('a well-formed response missing the billToInformation code is null', async () => {
  // The shape can be present and the answer still absent. Each of these is a real possibility on an
  // account that is not fully set up, and none of them may resolve to an ARCode.
  const shapes = [
    {},
    { data: {} },
    { data: { results: {} } },
    { data: { results: { billToInformation: {} } } },
    { data: { results: { billToInformation: { code: null } } } },
    { data: { results: { billToInformation: { code: '' } } } },
    { data: { results: { billToInformation: { code: '   ' } } } },
  ];
  for (const s of shapes) {
    const f = stubFetch(jsonOk(s));
    assert.equal(await resolveCallerArCode(TOKEN, APPLET, f), null, `${JSON.stringify(s)} must be null`);
  }
});

test('two or more billTo answers is NOT a clean single answer, and resolves to nothing', async () => {
  // Taking the first element would be picking an identity for the caller. If Primus ever returns
  // more than one, that is a question to answer deliberately, not one to resolve by array index.
  const many = {
    data: {
      results: [
        { billToInformation: { code: '1234' } },
        { billToInformation: { code: '5406' } },
      ],
    },
  };
  assert.equal(await resolveCallerArCode(TOKEN, APPLET, stubFetch(jsonOk(many))), null);

  // A single-element array is the same answer in a different envelope, and is accepted.
  const one = { data: { results: [{ billToInformation: { code: '1234' } }] } };
  assert.equal(await resolveCallerArCode(TOKEN, APPLET, stubFetch(jsonOk(one))), '1234');
});

test('a network failure is null, not an exception', async () => {
  // Same reasoning as the unparseable body: the caller gets one refusal vocabulary, and an
  // unreachable Primus is not a crash in our route.
  const f = stubFetch(() => { throw new TypeError('fetch failed'); });
  assert.equal(await resolveCallerArCode(TOKEN, APPLET, f), null);
});

test('EVERY failure returns the identical null — this function is not an oracle', async () => {
  // §5.8's rule, applied one layer down: "not found" and "not yours" must be one message. A
  // resolver that distinguished "expired token" from "no billTo on this account" would hand a
  // caller a way to probe accounts that are not theirs. If that distinction is ever needed it
  // belongs in OUR log line, where only we can read it — never in the return value.
  const outcomes = await Promise.all([
    resolveCallerArCode('', APPLET, stubFetch(jsonOk(profileBody('1234')))),
    resolveCallerArCode(TOKEN, APPLET, stubFetch(status(401))),
    resolveCallerArCode(TOKEN, APPLET, stubFetch(status(404))),
    resolveCallerArCode(TOKEN, APPLET, stubFetch(() => new Response('<html>', { status: 200 }))),
    resolveCallerArCode(TOKEN, APPLET, stubFetch(jsonOk({ data: { results: {} } }))),
    resolveCallerArCode(TOKEN, APPLET, stubFetch(() => { throw new Error('down'); })),
  ]);
  for (const o of outcomes) assert.equal(o, null);
  assert.equal(new Set(outcomes).size, 1, 'the failure modes must be indistinguishable');
});

test('a blank applet base THROWS rather than resolving everyone to null', async () => {
  // The split this file keeps: CALLER DATA fails closed (null), OUR CONFIGURATION fails loud.
  // Same discipline as deriveDocToken refusing without a secret and parseAllowlist refusing when
  // unset. A blank base would make every customer unresolvable, and §8.874 names that exact shape
  // as the dangerous one — a wiring bug wearing the costume of a normal empty result, which nobody
  // reports because it looks like the system working.
  for (const bad of [undefined, null, '', '   ']) {
    await assert.rejects(() => resolveCallerArCode(TOKEN, bad, stubFetch(jsonOk(profileBody('1234')))),
      /applet API base/);
  }
});

test('the trailing slash on the base does not become a double slash', async () => {
  const f = stubFetch(jsonOk(profileBody('1234')));
  await resolveCallerArCode(TOKEN, `${APPLET}/`, f);
  assert.equal(f.calls[0].url, `${APPLET}/applet/v1/profile`);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// ownsInvoice
// ─────────────────────────────────────────────────────────────────────────────────────────────

test('ownership is equality of two canonical codes', async () => {
  assert.equal(ownsInvoice('1234', '1234'), true);
  assert.equal(ownsInvoice('1234', '5406'), false);
  assert.equal(ownsInvoice('AB12', 'AB12'), true);
});

test('an unresolved caller owns NOTHING — null is never a wildcard', () => {
  // The failure mode this exists to prevent: treating "we could not work out who this is" as
  // "matches nothing in particular, so let it through". Every unresolved side is a refusal.
  for (const empty of [null, undefined, '', '   ']) {
    assert.equal(ownsInvoice(empty, '1234'), false, `caller ${JSON.stringify(empty)} must own nothing`);
    assert.equal(ownsInvoice('1234', empty), false, `invoice ${JSON.stringify(empty)} must be owned by nobody`);
  }
});

test('blank does not match blank', () => {
  // Two unresolved sides are two refusals, not an agreement. Without the non-empty guard, plain
  // equality would make '' === '' a successful ownership check — the single worst outcome
  // available to this function, reached by the most ordinary-looking line of code in it.
  assert.equal(ownsInvoice('', ''), false);
  assert.equal(ownsInvoice(null, null), false);
  assert.equal(ownsInvoice('   ', '   '), false);
});

test('ownsInvoice does NOT re-normalise — both sides are canonical by construction', () => {
  // resolveCallerArCode returns normalizeArCode's output; Ledger.get returns ar_code already
  // canonical (ledger.js:151 normalises at write). Re-normalising here would hide a caller that
  // fed this raw data, and it would do so by SUCCEEDING — the direction a security check must
  // never fail in. A formatting mismatch refuses, and refusing is the safe answer.
  assert.equal(ownsInvoice('ab12', 'AB12'), false, 'a non-canonical caller value must not be repaired');
  assert.equal(ownsInvoice(' 1234', '1234'), false);
});
