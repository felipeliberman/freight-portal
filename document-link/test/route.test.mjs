// document-link — the route that replaces doc-proxy. Spec §8.876 (documents reachable across
// accounts; Documents.php needs no auth), §8.877 (what we can reduce without Primus), §8.878.
//
// WHAT THESE TESTS ARE REALLY FOR. doc-proxy fetches a URL the caller hands it, gated by
// `hostname.endsWith("shipprimus.com")`. Everything below exists to prove this route does not have
// that shape: the caller names no target, four checks must all pass, and every failure returns the
// same 404 without a byte being fetched. The call-counter assertions are the point — a test that
// only checked the status code would pass for a Worker that fetched the document and then threw it
// away, which is a different and much worse thing.
//
// ── WHAT THESE TESTS DO NOT ESTABLISH ────────────────────────────────────────────────────────
//
// The UPSTREAM RESPONSE SHAPE. `GET /applet/v1/document/bol/{BOLNumber}` and its envelope are
// asserted here only at the boundary WE control — the stub returns what the spec records
// (§8, ~line 596: "real and was in production code", once, in the old Email Invoice handler).
// A stub agreeing with itself is not evidence about Primus.
//
// **CONFIRMED LIVE PRE-DEPLOY, NOT BY THIS FILE.** One read against Haynes Brothers (Primus
// 1123086640 — the write-test account; NEVER Simply Nursery, who log in) before any deploy, to
// confirm the envelope the Worker parses. Do not deploy on the spec note alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest, ALLOWED_ORIGIN } from '../src/index.js';
import { deriveDocToken } from '../../invoice-sync/src/documents.js';

const SECRET = 'doc-token-secret';
const APPLET_HOST = 'freightandlogistics-api.shipprimus.com';
const APPLET = `https://${APPLET_HOST}`;
const DOCHOST = 'www.shipprimus.com';

const INV = '1591052345';
const BOL = '160133377';
const TYPE = 'BOL';
const AR = '1234';

const BEARER = 'eyJhbGciOiJIUzI1NiJ9.primus-issued-access-token';
const DOC_URL = `https://${DOCHOST}/Documents.php?id=NDk5OTk5OTk5`;

const env = (over = {}) => ({
  DOC_TOKEN_SECRET: SECRET,
  PRIMUS_APPLET_HOST: APPLET_HOST,
  PRIMUS_DOCUMENT_HOST: DOCHOST,
  LINKS: linksDb(AR),
  ...over,
});

/** D1 stand-in: one row, or null. Records the bound parameters so scoping can be asserted. */
function linksDb(arCode, over = {}) {
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      return {
        bind(...params) { calls.push({ sql, params }); return this; },
        async first() { return arCode === null ? null : { ar_code: arCode, ...over }; },
      };
    },
  };
  return db;
}

/**
 * fetch stand-in that RECORDS every call and answers by host.
 *
 * `docFetches` is the assertion that matters throughout this file: "did any byte of a customer
 * document leave Primus". A route that refuses AFTER fetching has already done the thing.
 */
function stubFetch({ profile, docList, docBytes } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const u = new URL(String(url));
    if (u.pathname.endsWith('/applet/v1/profile')) {
      return profile ?? jsonRes({ data: { results: { billToInformation: { code: AR } } } });
    }
    if (u.pathname.includes('/applet/v1/document/bol/')) {
      return docList ?? jsonRes({ data: { results: [{ type: 'BOL', url: DOC_URL, name: 'Bill Of Lading' }] } });
    }
    return docBytes ?? new Response('%PDF-1.4 bytes', { status: 200, headers: { 'content-type': 'application/pdf' } });
  };
  fn.calls = calls;
  fn.docFetches = () => calls.filter(c => c.url.includes('Documents.php'));
  fn.profileCalls = () => calls.filter(c => c.url.includes('/applet/v1/profile'));
  return fn;
}

const jsonRes = body => new Response(JSON.stringify(body), {
  status: 200, headers: { 'content-type': 'application/json' } });

const tokenFor = (inv = INV, bol = BOL, type = TYPE) => deriveDocToken(SECRET, inv, bol, type);

const req = (path, { method = 'GET', bearer = BEARER, origin = ALLOWED_ORIGIN } = {}) => {
  const headers = {};
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (origin) headers.Origin = origin;
  return new Request(`https://docs.freightandlogistics.ai${path}`, { method, headers });
};

const pathFor = (t, inv = INV, bol = BOL, type = TYPE) => `/d/${inv}/${bol}/${type}/${t}`;

// ── THE ONE SUCCESS PATH ─────────────────────────────────────────────────────────────────────

test('all four checks pass: 200, upstream bytes, inline disposition, private no-store', async () => {
  const f = stubFetch();
  const res = await handleRequest(req(pathFor(await tokenFor())), env(), f);

  assert.equal(res.status, 200);
  assert.equal(await res.text(), '%PDF-1.4 bytes', 'the body is the streamed upstream bytes');
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  // Set because it is correct and free. NOT load-bearing: under the blob-URL path the portal's
  // a.download supplies the visible name, so nothing here asserts what the browser displays.
  assert.equal(res.headers.get('content-disposition'), `inline; filename="${BOL}_${TYPE}.pdf"`);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(f.docFetches().length, 1, 'exactly one document fetch');
});

test('the success response strips upstream X-Frame-Options and CSP', async () => {
  // The reason doc-proxy existed at all — a PDF that will not render in an iframe. Kept, but ONLY
  // on the response that passed all four checks.
  const f = stubFetch({ docBytes: new Response('%PDF', { status: 200, headers: {
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'" } }) });
  const res = await handleRequest(req(pathFor(await tokenFor())), env(), f);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.equal(res.headers.get('content-security-policy'), null);
});

test('HEAD is allowed and carries the same headers', async () => {
  const f = stubFetch();
  const res = await handleRequest(req(pathFor(await tokenFor()), { method: 'HEAD' }), env(), f);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
});

// ── THE FOUR REFUSALS — each must refuse BEFORE any document byte is fetched ─────────────────

test('bad token: 404, and NO document fetch occurred', async () => {
  const f = stubFetch();
  const res = await handleRequest(req(pathFor('0'.repeat(32))), env(), f);
  assert.equal(res.status, 404);
  assert.equal(f.docFetches().length, 0, 'a document was fetched for an unverified token');
});

test('valid token but ownsInvoice false: 404, no document fetch', async () => {
  // The caller is a real, authenticated customer — just not this invoice's. Primus would happily
  // serve them the document (§8.876 layer 1); this route is what refuses.
  const f = stubFetch({ profile: jsonRes({ data: { results: { billToInformation: { code: '720' } } } }) });
  const res = await handleRequest(req(pathFor(await tokenFor())), env(), f);
  assert.equal(res.status, 404);
  assert.equal(f.docFetches().length, 0, 'another customer\'s document was fetched');
});

test('valid token and owner matches, but the type is not pull: 404, no document fetch', async () => {
  // COST is NEVER_EXPOSE — carrier cost. A correctly-minted token for it must still refuse.
  const f = stubFetch();
  const t = await tokenFor(INV, BOL, 'COST');
  const res = await handleRequest(req(pathFor(t, INV, BOL, 'COST')), env(), f);
  assert.equal(res.status, 404);
  assert.equal(f.docFetches().length, 0);
});

test('EVERY never-expose type refuses, one by one', async () => {
  for (const type of ['COST', 'COI', 'IMG', 'DO', 'CLBL', 'SHP', 'MET', 'CLM', 'CLMD', 'MISDOC', 'CI']) {
    const f = stubFetch();
    const t = await tokenFor(INV, BOL, type);
    const res = await handleRequest(req(pathFor(t, INV, BOL, type)), env(), f);
    assert.equal(res.status, 404, `${type} was served`);
    assert.equal(f.docFetches().length, 0, `${type} reached a document fetch`);
  }
});

test('resolveCallerArCode returns null (no bearer): 404, no document fetch', async () => {
  const f = stubFetch();
  const res = await handleRequest(req(pathFor(await tokenFor()), { bearer: null }), env(), f);
  assert.equal(res.status, 404);
  assert.equal(f.docFetches().length, 0);
  assert.equal(f.profileCalls().length, 0, 'no bearer means Primus is never asked');
});

test('an invalid bearer (profile 401) is 404, no document fetch', async () => {
  const f = stubFetch({ profile: new Response('', { status: 401 }) });
  const res = await handleRequest(req(pathFor(await tokenFor())), env(), f);
  assert.equal(res.status, 404);
  assert.equal(f.docFetches().length, 0);
});

test('no link row for the invoice: 404, no document fetch', async () => {
  const f = stubFetch();
  const res = await handleRequest(req(pathFor(await tokenFor())), env({ LINKS: linksDb(null) }), f);
  assert.equal(res.status, 404);
  assert.equal(f.docFetches().length, 0);
});

// ── UPSTREAM BEHAVIOUR ───────────────────────────────────────────────────────────────────────

test('a 3xx from upstream is 404 — the redirect is NOT followed', async () => {
  // A redirect is a signal something is wrong, not a thing to chase. doc-proxy used
  // redirect:'follow', which meant its one host check governed only the FIRST hop.
  for (const status of [301, 302, 303, 307, 308]) {
    const f = stubFetch({ docBytes: new Response(null, { status, headers: { Location: 'https://evil.example/x' } }) });
    const res = await handleRequest(req(pathFor(await tokenFor())), env(), f);
    assert.equal(res.status, 404, `${status} was not refused`);
  }
});

test('BOTH fetches ask for redirect:manual — the list hop as well as the byte hop', async () => {
  // Not just the byte hop. The list hop carries the customer's BEARER TOKEN, so a followed
  // redirect there would replay a live credential at whatever the Location header named — strictly
  // worse than the document case, where only bytes are at stake. doc-proxy used redirect:'follow'
  // and that is precisely why its one host check governed only the first hop.
  const f = stubFetch();
  await handleRequest(req(pathFor(await tokenFor())), env(), f);
  assert.equal(f.calls.length, 3, 'profile, list, bytes');
  for (const c of f.calls.filter(c => !c.url.includes('/applet/v1/profile'))) {
    assert.equal(c.init.redirect, 'manual', `${c.url} did not ask for redirect:manual`);
  }
});

test('a 3xx on the LIST hop is 404, and the bearer is not replayed anywhere', async () => {
  for (const status of [301, 302, 307, 308]) {
    const f = stubFetch({ docList: new Response(null, { status, headers: { Location: 'https://evil.example/x' } }) });
    const res = await handleRequest(req(pathFor(await tokenFor())), env(), f);
    assert.equal(res.status, 404, `list ${status} was not refused`);
    assert.equal(f.docFetches().length, 0);
    assert.equal(f.calls.filter(c => c.url.includes('evil.example')).length, 0, 'the redirect was chased');
  }
});

test('an upstream non-200 is 404', async () => {
  for (const status of [400, 401, 403, 404, 500, 503]) {
    const f = stubFetch({ docBytes: new Response('', { status }) });
    const res = await handleRequest(req(pathFor(await tokenFor())), env(), f);
    assert.equal(res.status, 404, `upstream ${status} leaked`);
  }
});

test('a document list with no row of that type is 404, and nothing is fetched', async () => {
  const f = stubFetch({ docList: jsonRes({ data: { results: [{ type: 'POD', url: DOC_URL }] } }) });
  const res = await handleRequest(req(pathFor(await tokenFor())), env(), f);
  assert.equal(res.status, 404);
  assert.equal(f.docFetches().length, 0);
});

// ── THE OPEN-RELAY REGRESSION. THE TEST THIS WHOLE FILE EXISTS FOR ───────────────────────────

test('NEGATIVE: a caller cannot name the target — no ?url=, no host, ever', async () => {
  // doc-proxy's entire interface was a caller-supplied URL. Every shape of that attempt must be
  // ignored: the Worker builds its own upstream from the VERIFIED bolNumber and type.
  const t = await tokenFor();
  const attempts = [
    `${pathFor(t)}?url=https://evil.example/x`,
    `${pathFor(t)}?url=https://evilshipprimus.com/Documents.php?id=1`,
    `${pathFor(t)}?target=https://evil.example/x&host=evil.example`,
  ];
  for (const p of attempts) {
    const f = stubFetch();
    const res = await handleRequest(req(p), env(), f);
    assert.equal(res.status, 200, 'the query string must be IGNORED, not rejected and not honoured');
    for (const c of f.calls) {
      const h = new URL(c.url).hostname;
      assert.ok(h === DOCHOST || h === new URL(APPLET).hostname,
        `the Worker fetched a caller-named host: ${h}`);
      assert.ok(!c.url.includes('evil.example'), 'a caller-supplied host was reached');
    }
  }
});

test('NEGATIVE: the host check is EXACT, not a suffix — evilshipprimus.com is refused', async () => {
  // `"evilshipprimus.com".endsWith("shipprimus.com")` is true. That is doc-proxy's whole failure.
  // Here the hostile URL arrives from the document LIST, which is the only way it could.
  // Compared as PARSED HOSTNAMES, not substrings — `shipprimus.com` is a substring of both
  // legitimate hosts, so a substring assertion here fails on the two calls that are supposed to
  // happen. That is the same class of loose matching the route itself refuses to do.
  for (const host of ['evilshipprimus.com', 'shipprimus.com.evil.example', 'notshipprimus.com', 'shipprimus.com']) {
    const f = stubFetch({ docList: jsonRes({ data: { results: [{ type: 'BOL', url: `https://${host}/Documents.php?id=1` }] } }) });
    const res = await handleRequest(req(pathFor(await tokenFor())), env(), f);
    assert.equal(res.status, 404, `${host} passed the host check`);
    assert.equal(f.calls.filter(c => new URL(c.url).hostname === host).length, 0, `${host} was fetched`);
  }
});

test('a host binding that is a URL, not a bare hostname, fails closed before the bearer moves', async () => {
  // Owner decision 2026-08-11: both hops exact-host-checked, caller names neither. What that can
  // mean at RUNTIME, precisely — and the earlier version of this test asked for more than is
  // deliverable, so it is written down rather than quietly dropped:
  //
  //   CAN be checked: the binding is a bare hostname. A pasted URL, a port, a credential or a
  //     trailing path is a real and likely config mistake, and `https://${that}` would resolve
  //     somewhere nobody intended.
  //   CANNOT be checked: a well-formed but WRONG host. `PRIMUS_APPLET_HOST` is the trust root for
  //     its hop, exactly as `PRIMUS_DOCUMENT_HOST` is for the byte hop — if either named
  //     evilshipprimus.com, the fetch would go there and no code in the Worker could know. That is
  //     guarded by review of the toml at deploy time, not at runtime. Asserting otherwise here
  //     would be a test that passes because it tests nothing.
  //
  // Failing closed EARLY is the part that matters: the bearer token must not move first.
  const bad = ['https://freightandlogistics-api.shipprimus.com', 'host:8443', 'host/path',
               'user@host.com', 'has space.com', '', 'localhost'];
  for (const host of bad) {
    for (const key of ['PRIMUS_APPLET_HOST', 'PRIMUS_DOCUMENT_HOST']) {
      const f = stubFetch();
      const res = await handleRequest(req(pathFor(await tokenFor())), env({ [key]: host }), f);
      assert.equal(res.status, 404, `${key}=${JSON.stringify(host)} was accepted`);
      assert.equal(f.calls.length, 0, `${key}=${JSON.stringify(host)} forwarded the bearer first`);
    }
  }
});

test('the built list URL is on exactly the configured applet host, path-anchored', async () => {
  // Asserts the URL the Worker BUILT, not merely that a fetch happened. If the route regex ever
  // loosened enough to let a separator through bolNumber, this is what would catch it.
  const f = stubFetch();
  await handleRequest(req(pathFor(await tokenFor())), env(), f);
  const listCall = f.calls.find(c => c.url.includes('/applet/v1/document/bol/'));
  assert.ok(listCall, 'the list hop did not happen');
  const u = new URL(listCall.url);
  assert.equal(u.hostname, new URL(APPLET).hostname);
  assert.equal(u.protocol, 'https:');
  assert.equal(u.pathname, `/applet/v1/document/bol/${BOL}`);
  assert.equal(listCall.init.headers.Authorization, `Bearer ${BEARER}`);
});

// ── CONFIGURATION AND METHOD ─────────────────────────────────────────────────────────────────

test('DOC_TOKEN_SECRET unset is 404, never a 500 leaking the misconfiguration', async () => {
  for (const bad of [undefined, '', null]) {
    const f = stubFetch();
    const res = await handleRequest(req(pathFor(await tokenFor())), env({ DOC_TOKEN_SECRET: bad }), f);
    assert.equal(res.status, 404, 'an unset secret must fail closed as a 404');
    assert.equal(f.docFetches().length, 0);
  }
});

test('a missing host binding is 404, not a crash', async () => {
  for (const key of ['PRIMUS_APPLET_HOST', 'PRIMUS_DOCUMENT_HOST']) {
    const f = stubFetch();
    const res = await handleRequest(req(pathFor(await tokenFor())), env({ [key]: '' }), f);
    assert.equal(res.status, 404, `${key} unset did not fail closed`);
  }
});

test('POST is 405; GET and HEAD are the only methods that route', async () => {
  const t = await tokenFor();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await handleRequest(req(pathFor(t), { method }), env(), stubFetch());
    assert.equal(res.status, 405, `${method} was not refused`);
    assert.equal(res.headers.get('allow'), 'GET, HEAD, OPTIONS');
  }
});

test('a malformed path is 404 and never reaches Primus', async () => {
  const t = await tokenFor();
  const bad = ['/', '/d/', `/d/${INV}/${BOL}/${TYPE}`, `/d/${INV}/${BOL}/${TYPE}/short`,
               `/d/${INV}/${BOL}/${TYPE}/${t.toUpperCase()}`, `/x/${INV}/${BOL}/${TYPE}/${t}`,
               `/d/${INV}/${BOL}/${TYPE}/${t}/extra`];
  for (const p of bad) {
    const f = stubFetch();
    const res = await handleRequest(req(p), env(), f);
    assert.equal(res.status, 404, `${p} was routed`);
    assert.equal(f.calls.length, 0, `${p} reached the network`);
  }
});

// ── CORS — one exact origin, never reflected ─────────────────────────────────────────────────

test('OPTIONS from the allowed origin echoes exactly that origin', async () => {
  const res = await handleRequest(req('/d/x', { method: 'OPTIONS' }), env(), stubFetch());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN);
  assert.equal(ALLOWED_ORIGIN, 'https://www.freightandlogistics.ai');
  assert.match(res.headers.get('access-control-allow-headers') || '', /authorization/i);
});

test('OPTIONS from a DISALLOWED origin gets NO allow-origin header', async () => {
  // The github.io mirror is deliberately not allowed. Being generous here is doc-proxy's mistake
  // in miniature: one permissive string is how a boundary becomes a formality.
  const origins = ['https://felipeliberman.github.io', 'https://freightandlogistics.ai',
                   'https://www.freightandlogistics.ai.evil.example', 'https://evil.example', null];
  for (const o of origins) {
    const res = await handleRequest(req('/d/x', { method: 'OPTIONS', origin: o }), env(), stubFetch());
    assert.equal(res.headers.get('access-control-allow-origin'), null,
      `origin ${o} was allowed`);
  }
});

test('the allow-origin is never REFLECTED from the request', async () => {
  const res = await handleRequest(req('/d/x', { method: 'OPTIONS', origin: 'https://evil.example' }), env(), stubFetch());
  const acao = res.headers.get('access-control-allow-origin');
  assert.ok(acao === null || acao === ALLOWED_ORIGIN, 'the request Origin was reflected back');
});

// ── LOGGING ──────────────────────────────────────────────────────────────────────────────────

test('the miss log carries a token PREFIX only — never the full token or the bearer', async () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const t = await tokenFor();
    const bad = t.slice(0, 31) + (t[31] === 'a' ? 'b' : 'a');
    await handleRequest(req(pathFor(bad)), env(), stubFetch());
  } finally { console.log = orig; }

  const blob = logs.join('\n');
  assert.ok(blob.length, 'a miss must be logged — the miss rate is the only enumeration signal');
  assert.ok(!blob.includes(BEARER), 'the BEARER TOKEN reached a log');
  assert.ok(!/[0-9a-f]{32}/.test(blob), 'a full 32-char token reached a log');
  assert.ok(!blob.includes(AR), 'the arCode reached a log');
});
