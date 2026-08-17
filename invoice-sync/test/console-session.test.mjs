// PIECE (i) — THE CONSOLE SESSION (Phase 1, deliver-and-inform).
//
//     node --test invoice-sync/test/console-session.test.mjs
//
// NO NETWORK. Every response below is a stub carrying a body captured from the live console on
// 2026-08-16, so the thing under test is the real protocol rather than a convenient one.
//
// ── THE SIGNAL THIS FILE EXISTS TO PIN ───────────────────────────────────────────────────────
//
// AN EXPIRED CONSOLE SESSION RETURNS HTTP 200. Not 401, not a redirect — 200, `text/html`, body
// `No session started.` Every status-code-based staleness check reads that as a SUCCESSFUL lookup
// that happened to return no customer, and the caller then has no recipient for reasons it cannot
// explain. Detection is by BODY, and these tests are what keeps it that way.
//
// The second thing pinned here is the COUNT. Re-login exactly once: zero means a run dies on a
// session that expired mid-pass, and unbounded means a broken credential turns one cron tick into
// a login storm against a shared production console.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConsoleSession, isLostSession, CONSOLE_SESSION_CACHE_KEY } from '../src/console-session.js';
import { REFUSAL_REASONS } from '../src/refusals.js';
import { freshDb } from './helpers.mjs';

// ── captured live 2026-08-16, verbatim ───────────────────────────────────────────────────────

/** An expired / absent session. HTTP 200, text/html. */
const LOST = 'No session started.';
/** The login success body. NOTE THE UNQUOTED KEY — this is NOT valid JSON. */
const LOGIN_OK = '{success: true}';
/** A getShippingLocation response, trimmed. `success` is the STRING "true". */
const RECORD_OK = JSON.stringify({
  success: 'true',
  data: { id: '33717', accountingId: '1234', remitToSL: '1', email: 'felipe@freightandlogistics.com', billingEmail: '', accountingContacts: [] },
  readOnly: false,
});

const CREDS = { username: 'console-user', password: 'console-pass', base: 'https://shipprimus.com/PRIMUS/trunk' };

/**
 * A scriptable console. Each entry answers one request, in order; `calls` records what was sent so
 * a test can assert the SEQUENCE, which is where "exactly once" lives.
 *
 * Real `Response` objects rather than a hand-rolled double: header access and `set-cookie`
 * behaviour are part of what is being tested, and a stub that returns a plain object would prove
 * the test's idea of headers rather than Node's.
 */
function fakeConsole(script) {
  const calls = [];
  const queue = [...script];
  const fetchImpl = async (url, init = {}) => {
    const body = String(init.body || '');
    const action = /(?:^|&)action=([^&]*)/.exec(body);
    calls.push({
      url: String(url),
      method: init.method || 'GET',
      action: action ? decodeURIComponent(action[1]) : null,
      cookie: (init.headers && (init.headers.Cookie || init.headers.cookie)) || null,
      body,
    });
    const next = queue.shift();
    if (!next) throw new Error(`fakeConsole: unscripted request #${calls.length} (${action ? action[1] : 'GET'})`);
    if (next.throws) throw new Error(next.throws);
    return new Response(next.body ?? '', {
      status: next.status ?? 200,
      headers: next.setCookie
        ? { 'content-type': next.contentType || 'text/html', 'set-cookie': next.setCookie }
        : { 'content-type': next.contentType || 'text/html' },
    });
  };
  return { fetchImpl, calls, remaining: () => queue.length };
}

/** The seed request is where the cookie actually comes from — login returns no Set-Cookie. */
const seed = id => ({ setCookie: `PHPSESSID=${id}; path=/` });
const loginOk = () => ({ body: LOGIN_OK });
const lost = () => ({ body: LOST });
const record = () => ({ body: RECORD_OK, contentType: 'application/json' });

const session = (fake, db) => new ConsoleSession(CREDS, db, { fetchImpl: fake.fetchImpl });
const logins = calls => calls.filter(c => c.action === 'login').length;
const seeds = calls => calls.filter(c => c.method === 'GET').length;

// ── the lost-session signal ──────────────────────────────────────────────────────────────────

test('isLostSession matches the real body and nothing else', () => {
  assert.equal(isLostSession('No session started.'), true);
  assert.equal(isLostSession('  No session started.  \n'), true, 'surrounding whitespace');
  assert.equal(isLostSession('no session started.'), true, 'case must not decide it');
  assert.equal(isLostSession(RECORD_OK), false);
  assert.equal(isLostSession(LOGIN_OK), false);
  assert.equal(isLostSession(''), false, 'an empty body is a different failure');
});

// ── fresh login ──────────────────────────────────────────────────────────────────────────────

test('no cached session: seeds, logs in, then makes the call — in that order', async () => {
  const db = freshDb();
  const fake = fakeConsole([seed('AAA'), loginOk(), record()]);
  const r = await session(fake, db).post('getShippingLocation', { recordId: '33717', getAccounting: 'true' });

  assert.equal(r.ok, true, `expected success, got ${r.reason}`);
  assert.equal(r.value.json.data.id, '33717');

  assert.deepEqual(fake.calls.map(c => c.action ?? 'SEED'), ['SEED', 'login', 'getShippingLocation']);
  assert.equal(fake.calls[2].cookie, 'PHPSESSID=AAA', 'the call must carry the seeded cookie');
});

test('THE COOKIE COMES FROM THE SEED — login carries no Set-Cookie', async () => {
  // Measured live: the login response sets no cookie at all. An implementation that took the
  // cookie only from the login response would hold nothing and every call would be unauthenticated.
  const db = freshDb();
  const fake = fakeConsole([seed('SEEDED'), loginOk(), record()]);
  await session(fake, db).post('getShippingLocation', { recordId: '33717' });
  assert.equal(fake.calls[1].cookie, 'PHPSESSID=SEEDED', 'login itself must carry the seeded cookie');
  assert.equal(fake.calls[2].cookie, 'PHPSESSID=SEEDED');
});

test('the login success body is NOT valid JSON and must still be accepted', async () => {
  // `{success: true}` — unquoted key. A JSON.parse-based check fails this test, which is the point.
  assert.throws(() => JSON.parse(LOGIN_OK), 'precondition: the real body does not parse as JSON');
  const db = freshDb();
  const fake = fakeConsole([seed('A'), loginOk(), record()]);
  assert.equal((await session(fake, db).post('getShippingLocation', {})).ok, true);
});

test('the session is cached for reuse across isolates', async () => {
  const db = freshDb();
  const fake = fakeConsole([seed('CACHED'), loginOk(), record()]);
  await session(fake, db).post('getShippingLocation', {});
  const row = await db.prepare('SELECT * FROM cache WHERE key = ?').bind(CONSOLE_SESSION_CACHE_KEY).first();
  assert.ok(row, 'nothing was cached');
  assert.ok(Number(row.expires_at) > Date.now(), 'cached with an expiry already in the past');
});

// ── reuse ────────────────────────────────────────────────────────────────────────────────────

test('a cached session is reused: no seed, no login, one request', async () => {
  const db = freshDb();
  const warm = fakeConsole([seed('WARM'), loginOk(), record()]);
  const s1 = session(warm, db);
  await s1.post('getShippingLocation', {});

  // A SECOND instance, so the reuse comes from D1 rather than from instance memory.
  const fake = fakeConsole([record()]);
  const r = await session(fake, db).post('getShippingLocation', {});
  assert.equal(r.ok, true);
  assert.deepEqual(fake.calls.map(c => c.action), ['getShippingLocation']);
  assert.equal(fake.calls[0].cookie, 'PHPSESSID=WARM');
});

test('an EXPIRED cache entry is not used — it logs in again', async () => {
  const db = freshDb();
  await db.prepare('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)')
    .bind(CONSOLE_SESSION_CACHE_KEY, 'PHPSESSID=STALE', Date.now() - 1000).run();
  const fake = fakeConsole([seed('FRESH'), loginOk(), record()]);
  await session(fake, db).post('getShippingLocation', {});
  assert.equal(logins(fake.calls), 1);
  assert.equal(fake.calls[2].cookie, 'PHPSESSID=FRESH');
});

// ── expiry, and the count ────────────────────────────────────────────────────────────────────

test('EXPIRED MID-RUN: re-logs in EXACTLY once and retries with the new cookie', async () => {
  const db = freshDb();
  await db.prepare('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)')
    .bind(CONSOLE_SESSION_CACHE_KEY, 'PHPSESSID=DEAD', Date.now() + 60_000).run();

  const fake = fakeConsole([lost(), seed('NEW'), loginOk(), record()]);
  const r = await session(fake, db).post('getShippingLocation', { recordId: '33717' });

  assert.equal(r.ok, true, `expected recovery, got ${r.reason}`);
  assert.equal(r.value.json.data.id, '33717');
  assert.equal(logins(fake.calls), 1, 'EXACTLY one re-login');
  assert.equal(seeds(fake.calls), 1, 'one re-seed');
  assert.deepEqual(fake.calls.map(c => c.action ?? 'SEED'),
    ['getShippingLocation', 'SEED', 'login', 'getShippingLocation']);
  assert.equal(fake.calls[0].cookie, 'PHPSESSID=DEAD', 'first attempt used the cached cookie');
  assert.equal(fake.calls[3].cookie, 'PHPSESSID=NEW', 'the retry used the NEW cookie');
  assert.equal(fake.remaining(), 0);
});

test('EXPIRED MID-RUN ON THE SAME INSTANCE: the in-run memo does not stop the recovery', async () => {
  // THE ACTUAL LONG-RUN CASE, and the one the cache-sourced test above does not cover: the cookie
  // came from this instance's own memo, not from D1. The memo has no TTL of its own — it is the
  // in-run memo by design — so if `fresh` were tracked per instance rather than per attempt, a
  // session that died between two calls would never be recovered.
  const db = freshDb();
  const fake = fakeConsole([seed('FIRST'), loginOk(), record(), lost(), seed('SECOND'), loginOk(), record()]);
  const s = session(fake, db);

  assert.equal((await s.post('getShippingLocation', {})).ok, true, 'first call');
  const r = await s.post('getShippingLocation', {});

  assert.equal(r.ok, true, `second call should have recovered, got ${r.reason}`);
  assert.equal(logins(fake.calls), 2, 'the initial login plus exactly one recovery');
  assert.equal(fake.calls[2].cookie, 'PHPSESSID=FIRST');
  assert.equal(fake.calls[6].cookie, 'PHPSESSID=SECOND', 'the recovered call used the new cookie');
  assert.equal(fake.remaining(), 0);
});

test('a recovered session REPLACES the dead one in the cache', async () => {
  const db = freshDb();
  await db.prepare('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)')
    .bind(CONSOLE_SESSION_CACHE_KEY, 'PHPSESSID=DEAD', Date.now() + 60_000).run();
  const fake = fakeConsole([lost(), seed('NEW'), loginOk(), record()]);
  await session(fake, db).post('getShippingLocation', {});
  const row = await db.prepare('SELECT value FROM cache WHERE key = ?').bind(CONSOLE_SESSION_CACHE_KEY).first();
  assert.equal(row.value, 'PHPSESSID=NEW', 'the dead cookie must not survive the recovery');
});

test('RE-LOGIN FAILS: refuses, and does not try a second time', async () => {
  const db = freshDb();
  await db.prepare('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)')
    .bind(CONSOLE_SESSION_CACHE_KEY, 'PHPSESSID=DEAD', Date.now() + 60_000).run();

  const fake = fakeConsole([lost(), seed('X'), { body: '{"success":false}' }]);
  const r = await session(fake, db).post('getShippingLocation', {});

  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED);
  assert.equal(logins(fake.calls), 1, 'one login attempt, not a storm');
  assert.equal(fake.remaining(), 0, 'nothing further was attempted');
});

test('STILL LOST AFTER RE-LOGIN: refuses, no third attempt', async () => {
  const db = freshDb();
  await db.prepare('INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?)')
    .bind(CONSOLE_SESSION_CACHE_KEY, 'PHPSESSID=DEAD', Date.now() + 60_000).run();

  const fake = fakeConsole([lost(), seed('NEW'), loginOk(), lost()]);
  const r = await session(fake, db).post('getShippingLocation', {});

  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED);
  assert.equal(logins(fake.calls), 1, 'exactly one re-login, then it stops');
  assert.equal(fake.calls.filter(c => c.action === 'getShippingLocation').length, 2);
  assert.equal(fake.remaining(), 0);
});

test('a lost session on a FRESH login is not retried either', async () => {
  // No cached session at all, so the login just happened. If the very next call says the session
  // is not started, re-logging in would loop against a console that is not honouring logins.
  const db = freshDb();
  const fake = fakeConsole([seed('A'), loginOk(), lost()]);
  const r = await session(fake, db).post('getShippingLocation', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED);
  assert.equal(logins(fake.calls), 1);
  assert.equal(fake.remaining(), 0);
});

// ── other failures: refuse, never guess, never re-login ──────────────────────────────────────

test('a non-200 refuses and is NOT treated as a session problem', async () => {
  const db = freshDb();
  const fake = fakeConsole([seed('A'), loginOk(), { status: 502, body: 'Bad Gateway' }]);
  const r = await session(fake, db).post('getShippingLocation', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED);
  assert.equal(logins(fake.calls), 1, 'a 502 is not fixed by logging in again');
});

test('a transport throw refuses rather than escaping', async () => {
  const db = freshDb();
  const fake = fakeConsole([seed('A'), loginOk(), { throws: 'network unreachable' }]);
  const r = await session(fake, db).post('getShippingLocation', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED);
});

test('a body that is neither lost-session nor JSON refuses', async () => {
  const db = freshDb();
  const fake = fakeConsole([seed('A'), loginOk(), { body: '<html>maintenance</html>' }]);
  const r = await session(fake, db).post('getShippingLocation', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED);
});

test('NO COOKIE ANYWHERE: refuses before making the call', async () => {
  // The seed returned no Set-Cookie and login sets none. Holding no cookie, the call would go out
  // unauthenticated and come back "No session started." — fail closed instead.
  const db = freshDb();
  const fake = fakeConsole([{ body: '' }, loginOk()]);
  const r = await session(fake, db).post('getShippingLocation', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED);
  assert.equal(fake.calls.filter(c => c.action === 'getShippingLocation').length, 0);
});

test('a SEED that fails refuses at stage:seed — a distinct signal from no_cookie', async () => {
  // Same safety either way (no session, nothing sent), but a run that dies at 2am should say
  // whether the console failed to answer or answered without handing over a session.
  const db = freshDb();
  const fake = fakeConsole([{ status: 503, body: 'Service Unavailable' }]);
  const r = await session(fake, db).post('getShippingLocation', {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED);
  assert.equal(r.detail.stage, 'seed');
  assert.equal(r.detail.status, 503);
  assert.equal(logins(fake.calls), 0, 'credentials must not go out when the seed failed');
  assert.equal(fake.remaining(), 0);
});

test('a seed that ANSWERS but sets no cookie is stage:no_cookie, not stage:seed', async () => {
  const db = freshDb();
  const fake = fakeConsole([{ body: '' }, loginOk()]);
  const r = await session(fake, db).post('getShippingLocation', {});
  assert.equal(r.ok, false);
  assert.equal(r.detail.stage, 'no_cookie');
});

test('a 3xx seed carrying a cookie is a WORKING seed, not a failure', async () => {
  // Refusing on `!res.ok` would break this: `ok` is false for a 3xx, but a redirect that still
  // sets PHPSESSID has given us everything the seed exists to provide.
  const db = freshDb();
  const fake = fakeConsole([{ status: 302, setCookie: 'PHPSESSID=VIA302; path=/' }, loginOk(), record()]);
  const r = await session(fake, db).post('getShippingLocation', {});
  assert.equal(r.ok, true, `expected the 302 seed to work, got ${r.reason}`);
  assert.equal(fake.calls[2].cookie, 'PHPSESSID=VIA302');
});

test('login refused at HTTP level refuses without reaching the action', async () => {
  const db = freshDb();
  const fake = fakeConsole([seed('A'), { status: 500, body: 'boom' }]);
  const r = await session(fake, db).post('getShippingLocation', {});
  assert.equal(r.ok, false);
  assert.equal(fake.calls.filter(c => c.action === 'getShippingLocation').length, 0);
});

// ── structural guards ────────────────────────────────────────────────────────────────────────

test('only read actions are reachable — a write action throws', async () => {
  const db = freshDb();
  const fake = fakeConsole([]);
  const s = session(fake, db);
  for (const action of ['SaveShippingLocation', 'DeleteShippingLocation', 'saveInvoice', 'login']) {
    await assert.rejects(() => s.post(action, {}), /non-allowlisted console action/,
      `${action} must not be reachable through post()`);
  }
  assert.equal(fake.calls.length, 0, 'nothing may go out for a refused action');
});

test('THE COOKIE IS NEVER IN A RETURNED VALUE OR REFUSAL', async () => {
  const db = freshDb();
  const fake = fakeConsole([seed('SECRETCOOKIE'), loginOk(), { status: 502, body: 'Bad Gateway' }]);
  const r = await session(fake, db).post('getShippingLocation', {});
  const asText = JSON.stringify(r);
  assert.ok(!asText.includes('SECRETCOOKIE'), 'a refusal leaked the session cookie');
  assert.ok(!asText.includes('PHPSESSID'), 'a refusal leaked the cookie name/value');
});

test('credentials never appear in a refusal', async () => {
  const db = freshDb();
  const fake = fakeConsole([seed('A'), { status: 500, body: 'boom' }]);
  const r = await session(fake, db).post('getShippingLocation', {});
  const asText = JSON.stringify(r);
  assert.ok(!asText.includes(CREDS.password), 'a refusal leaked the console password');
  assert.ok(!asText.includes(CREDS.username), 'a refusal leaked the console username');
});

test('an upstream body is never embedded in a refusal (spec §6.3)', async () => {
  const db = freshDb();
  const fake = fakeConsole([seed('A'), loginOk(), { status: 502, body: 'UPSTREAM-BODY-MARKER' }]);
  const r = await session(fake, db).post('getShippingLocation', {});
  assert.ok(!JSON.stringify(r).includes('UPSTREAM-BODY-MARKER'));
});

test('credentials are required — an incomplete config throws rather than half-working', () => {
  const db = freshDb();
  const fake = fakeConsole([]);
  assert.throws(() => new ConsoleSession({ username: 'u', password: '' }, db, { fetchImpl: fake.fetchImpl }), /PRIMUS_CONSOLE/);
  assert.throws(() => new ConsoleSession({ username: '', password: 'p' }, db, { fetchImpl: fake.fetchImpl }), /PRIMUS_CONSOLE/);
});
