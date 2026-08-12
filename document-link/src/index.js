// docs.freightandlogistics.ai — THE DOCUMENT ROUTE. Spec §8.876, §8.877, §8.878, §8.95.
//
// THE THING THIS REPLACES, AND WHY THE SHAPE IS DIFFERENT.
//
// `doc-proxy` (deployed 2026-07-02, no source in this repo until it was pulled) is an
// unauthenticated relay: hand it `?url=<anything>` and, if the hostname ENDS WITH "shipprimus.com",
// it fetches that URL and returns the bytes. No token, no session, no ownership check. Its host
// test admits `evilshipprimus.com`, and `redirect: 'follow'` means the test governed only the first
// hop. It is deleted in a later step, once its one caller (portal.html `_waybOpenDocTab`) moves
// here — NOT in this one.
//
// The single structural difference, from which everything else follows:
//
//     THE CALLER NEVER NAMES A TARGET. It presents a token and identifiers; this Worker decides
//     what to fetch. The query string is not parsed at all.
//
// ── FOUR PROOFS, ALL SERVER-SIDE, NONE FORGEABLE BY THE CALLER ───────────────────────────────
//
//   1. THE LINK IS REAL      verifyDocToken re-derives the token for THIS (invoice, bol, type) and
//                            constant-time compares. The token is never asked what it is for.
//   2. THE CALLER IS REAL    resolveCallerArCode asks Primus's own /applet/v1/profile with the
//                            caller's forwarded bearer token. Identity comes from Primus, which
//                            issued that token only after validating a password — never from
//                            anything in the URL or a client-set field.
//   3. THE DOCUMENT IS THEIRS ownsInvoice compares the caller's ARCode to the invoice's, read from
//                            the link store rather than from anything the request carried.
//   4. THE TYPE IS SHAREABLE classifyDocument must return 'pull'. A correctly-minted token for a
//                            COST or IMG is still refused.
//
// ALL FOUR, THEN BYTES. Any failure is one uniform 404 — same body for unknown, unverified,
// not-yours, not-shareable and malformed, because any distinction makes this an oracle (§5.8:
// "not found" and "not yours" are one message).
//
// ── WHAT THIS DOES NOT FIX ───────────────────────────────────────────────────────────────────
//
// §8.876's two Primus-side failures are untouched and remain Primus's: a customer token still
// lists another account's documents, and `Documents.php` URLs still serve to anyone. What changes
// is that no `Documents.php` URL reaches a browser through us, and a wrong-customer request is
// refused HERE rather than being served BY THEM.

import { verifyDocToken, classifyDocument, documentFilename, normalizeType }
  from '../../invoice-sync/src/documents.js';
import { resolveCallerArCode, ownsInvoice } from '../../invoice-sync/src/ownership.js';

/**
 * ONE EXACT ORIGIN. Not a list, not a suffix, never reflected from the request.
 *
 * The legacy `felipeliberman.github.io` mirror is deliberately NOT here. Being generous with this
 * string is doc-proxy's mistake in miniature — its failure was one permissive comparison, and a
 * boundary that accepts "close enough" is a formality.
 */
export const ALLOWED_ORIGIN = 'https://www.freightandlogistics.ai';

/**
 * The whole input surface, matched BEFORE any work: /d/{invoiceId}/{bolNumber}/{TYPE}/{token}.
 *
 * The token is 32 lowercase hex — deriveDocToken's exact output — so a malformed one is refused by
 * the regex before a secret is read or a network call is made. Everything is in the path; the
 * QUERY STRING IS NEVER PARSED, matching pay's rule that a parameter which is validated is a
 * parameter that can be attacked. `bolNumber`, never `bolId`: §8.876 settled that a raw Primus
 * internal id may never appear in a customer-facing URL.
 */
const ROUTE_RE = /^\/d\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\/([A-Za-z]{1,16})\/([0-9a-f]{32})$/;

/** A BARE hostname — no scheme, port, path, credential or whitespace. See the config block. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** Set on EVERY response, not only the 200s — a document cached at the edge and served to the
 *  wrong person is the worst failure this route has. */
const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

/** ONE response for unknown, unverified, not-yours, not-shareable, misconfigured and malformed. */
function notFound() {
  return new Response('Not Found', {
    status: 404,
    headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function methodNotAllowed() {
  return new Response(null, {
    status: 405,
    headers: { ...BASE_HEADERS, Allow: 'GET, HEAD, OPTIONS' },
  });
}

/** The allow-origin header, or nothing. Never the request's own Origin echoed back. */
function corsFor(request) {
  return request.headers.get('Origin') === ALLOWED_ORIGIN
    ? { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN }
    : {};
}

/** Bearer token out of the Authorization header, or ''. Option A: the portal forwards it on a
 *  fetch(); no cookie and no session mechanism is invented here. */
function bearerFrom(request) {
  const h = request.headers.get('Authorization') || '';
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : '';
}

/**
 * The miss signal — PREFIX ONLY.
 *
 * A 404 spike is the only evidence anyone is probing, so it is logged. What is never logged: the
 * full document token (it is a credential), the caller's bearer token (it is a stronger one), and
 * the ARCode (it identifies the customer). Same discipline as pay's `link.miss`.
 */
function logMiss(reason, token) {
  console.log(JSON.stringify({ evt: 'doc.miss', reason, prefix: String(token || '').slice(0, 6) }));
}

/**
 * @param {Request} request
 * @param {object} env  DOC_TOKEN_SECRET, PRIMUS_APPLET_HOST, PRIMUS_DOCUMENT_HOST, LINKS (D1)
 * @param {typeof fetch} fetchImpl  injection point for tests ONLY — production passes the global.
 *
 * DENY BY DEFAULT: every branch below returns before the fetch except the one where all four
 * proofs held. There is exactly one `return new Response(upstream.body, …)` in this file.
 */
export async function handleRequest(request, env, fetchImpl = fetch) {
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...BASE_HEADERS,
        ...corsFor(request),
        'Access-Control-Allow-Methods': 'GET, HEAD',
        'Access-Control-Allow-Headers': 'Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed();

  const cors = corsFor(request);
  const url = new URL(request.url);
  const m = ROUTE_RE.exec(url.pathname);      // query string deliberately untouched
  if (!m) { logMiss('malformed', ''); return notFound(); }
  const [, invoiceId, bolNumber, rawType, token] = m;
  const type = normalizeType(rawType);

  try {
    // ── Configuration. Missing bindings fail CLOSED, and as a 404 rather than a 500: a
    // misconfiguration must not be distinguishable from a wrong token by anyone outside.
    const secret = env.DOC_TOKEN_SECRET;
    const appletHost = env.PRIMUS_APPLET_HOST;
    const documentHost = env.PRIMUS_DOCUMENT_HOST;
    if (!secret || !appletHost || !documentHost || !env.LINKS) {
      logMiss('misconfigured', token);
      return notFound();
    }

    // ── BOTH HOPS ARE EXACT-HOST-CHECKED, AND HOP 1 IS CHECKED HERE — BEFORE THE BEARER MOVES.
    //
    // ONE HOST BINDING PER HOP, and the Worker builds each origin itself. A configurable BASE URL
    // would be a second thing to disagree with the host it is supposed to be on — and there would
    // then be no expected host to check "exactly" against, which is how hop 1 initially shipped
    // with no check at all. A host cannot carry a scheme, a port, a path, or credentials, so
    // `https://user:pass@evil.example` and `http://…` are not expressible rather than rejected.
    //
    // WHAT CAN BE CHECKED is the SHAPE — a bare hostname. A value carrying a scheme, port, path,
    // credential or whitespace means someone pasted a URL into a host field, and `https://${that}`
    // would resolve somewhere nobody intended. Checked BEFORE the bearer moves: forwarding a
    // customer's Primus token to a host we did not intend is worse than serving a wrong document.
    //
    // WHAT CANNOT BE CHECKED, stated rather than pretended: a well-formed but WRONG host. These
    // two bindings are the trust root for their hops — if `PRIMUS_DOCUMENT_HOST` said
    // `evilshipprimus.com`, the byte hop would go there and no code here could know. That is a
    // deploy-time property, guarded by review of the toml. The runtime guarantee is narrower and
    // precise: whatever these name, both fetches go THERE and nowhere else, and the CALLER cannot
    // influence either.
    if (!HOSTNAME_RE.test(appletHost) || !HOSTNAME_RE.test(documentHost)) {
      logMiss('badhost', token);
      return notFound();
    }
    const appletBase = `https://${appletHost}`;

    // ── PROOF 1 — the link is real. Cheapest of the four and it needs no network, so it runs
    // first: an invented token costs one HMAC and never touches Primus.
    if (!(await verifyDocToken(secret, invoiceId, bolNumber, type, token))) {
      logMiss('token', token);
      return notFound();
    }

    // ── PROOF 4 — the type is shareable. Also local. A token minted for a COST is still refused,
    // because the allowlist is the control and the token only proves the link exists.
    if (classifyDocument(type) !== 'pull') { logMiss('type', token); return notFound(); }

    // ── PROOF 2 — the caller is who they say. The ONE thing forwarded is the bearer token.
    const bearer = bearerFrom(request);
    if (!bearer) { logMiss('nobearer', token); return notFound(); }
    const callerArCode = await resolveCallerArCode(bearer, appletBase, fetchImpl);
    if (!callerArCode) { logMiss('caller', token); return notFound(); }

    // ── PROOF 3 — the document is theirs. The invoice's ARCode comes from the LINK STORE, which
    // the mint wrote, never from the request and never from a field the caller could set.
    const row = await env.LINKS
      .prepare('SELECT ar_code FROM invoice_link WHERE primus_invoice_id = ? AND revoked_at IS NULL')
      .bind(invoiceId)
      .first();
    if (!row || !ownsInvoice(callerArCode, row.ar_code)) {
      logMiss('owner', token);
      return notFound();
    }

    // ── ALL FOUR HELD. Only now does anything reach for a document.
    //
    // THE WORKER BUILDS THIS URL. Keyed on the BOL NUMBER, so no internal id is involved, and the
    // caller contributed nothing but values already proven by the token.
    const listUrl = new URL(`${appletBase}/applet/v1/document/bol/${encodeURIComponent(bolNumber)}`);
    // Re-checked against the configured host after construction. Redundant today by design — the
    // regex already bounds bolNumber — and it is the assertion that would catch a future loosening
    // of that regex rather than letting it become a path-injection.
    if (listUrl.hostname !== appletHost) { logMiss('listhost', token); return notFound(); }
    // redirect:'manual' HERE TOO, and this hop is the more important of the two: it carries the
    // customer's BEARER TOKEN. Following a redirect would replay a live credential at whatever the
    // Location header named — worse than the byte hop, where only a document is at stake. A 3xx is
    // refused below with everything else that is not a 200.
    const listRes = await fetchImpl(listUrl.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${bearer}` },
    });
    if (!listRes || listRes.status >= 300 || !listRes.ok) { logMiss('list', token); return notFound(); }
    // THE ENVELOPE. `data.results`, per spec §8 (~line 596) and the old Email Invoice handler.
    // ⚠ CONFIRMED LIVE PRE-DEPLOY, not by the tests — one read against Haynes Brothers (Primus
    // 1123086640, the write-test account) before this ships. The tests stub this shape, and a stub
    // agreeing with itself says nothing about Primus.
    const listBody = await listRes.json();
    const rows = (listBody && listBody.data && listBody.data.results) || [];
    const doc = (Array.isArray(rows) ? rows : []).find(d =>
      d && normalizeType(d.fileType || d.type || d.documentType || d.name) === type);
    const target = doc && (doc.url || doc.fileUrl || doc.documentUrl || doc.link);
    if (!target) { logMiss('nodoc', token); return notFound(); }

    // ── EXACT HOST. `===`, never endsWith. doc-proxy's whole failure is that
    // "evilshipprimus.com".endsWith("shipprimus.com") is true. This URL came from Primus rather
    // than from the caller, and it is still checked, because "it came from upstream" is a
    // provenance argument and this is a boundary.
    let parsed;
    try { parsed = new URL(String(target)); } catch { logMiss('badurl', token); return notFound(); }
    if (parsed.protocol !== 'https:' || parsed.hostname !== documentHost) {
      logMiss('host', token);
      return notFound();
    }

    // ── redirect:'manual'. A 3xx is a signal something is wrong, not a thing to chase — following
    // one would put the host check on the first hop only, which is exactly doc-proxy's shape.
    const upstream = await fetchImpl(parsed.toString(), { method: 'GET', redirect: 'manual' });
    if (!upstream || upstream.status >= 300 || !upstream.ok) { logMiss('upstream', token); return notFound(); }

    // ── THE ONLY PATH THAT STREAMS BYTES. Upstream's framing headers are dropped so the PDF can
    // render in an iframe (the reason doc-proxy existed) — but only on this response, the one
    // where all four proofs held.
    const headers = new Headers(upstream.headers);
    headers.delete('X-Frame-Options');
    headers.delete('Content-Security-Policy');
    headers.delete('Set-Cookie');
    headers.set('Content-Type', 'application/pdf');
    // Correct and free. NOT load-bearing: under Option A the portal reads this into a Blob, so the
    // visible filename comes from its `a.download`. This header is what a direct hit would get.
    headers.set('Content-Disposition', `inline; filename="${documentFilename(bolNumber, type)}"`);
    for (const [k, v] of Object.entries({ ...BASE_HEADERS, ...cors })) headers.set(k, v);

    return new Response(upstream.body, { status: 200, headers });
  } catch (err) {
    // Anything unforeseen is a 404 too. A stack trace reaching a customer is an information leak,
    // and a 500 here would distinguish "we broke" from "you are not allowed" — which is the
    // distinction this route spends its whole length refusing to make.
    console.log(JSON.stringify({ evt: 'doc.error', error: String((err && err.message) || err).slice(0, 120) }));
    return notFound();
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env, fetch);
  },
};
