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
// ── TWO ROUTES, TWO OWNERSHIP MODELS, ONE SHARED TAIL ────────────────────────────────────────
//
// They differ because the questions differ. An INVOICE document is reached from a link we minted
// and can bind to an invoice; a SHIPMENT document is reached from the chat buttons, where no
// invoice exists at all. Forcing one model onto both is what would produce a token that proves
// nothing, or a route the live caller cannot use.
//
//   /d/{invoiceId}/{bolNumber}/{TYPE}/{token}   — FOUR PROOFS
//     1. THE LINK IS REAL      verifyDocToken re-derives the token for THIS (invoice, bol, type)
//                              and constant-time compares. The token is never asked what it is for.
//     2. THE CALLER IS REAL    resolveCallerArCode asks Primus's own /applet/v1/profile with the
//                              caller's forwarded bearer token. Identity comes from Primus, which
//                              issued it only after validating a password.
//     3. THE DOCUMENT IS THEIRS ownsInvoice compares the caller's ARCode to the invoice's, read
//                              from the link store, never from the request.
//     4. THE TYPE IS SHAREABLE classifyDocument must return 'pull'.
//
//   /s/{bolNumber}/{TYPE}                       — NO TOKEN, THREE CONTROLS
//     1. THE BEARER            same Primus-issued credential.
//     2. OUR CHECK             the BOL must resolve in the caller's OWN /book/bolnumber set.
//     3. PRIMUS'S CHECK        number-keyed lookups are customer-scoped (verified live, below).
//     plus THE TYPE IS SHAREABLE, refused locally before any request goes out.
//
// A token here would be one every legitimate caller could mint for itself — ceremony, not a
// control — so the route carries none. See ROUTE_S_RE for the live evidence.
//
// EITHER WAY, ALL CHECKS THEN BYTES. Every failure is one uniform 404 — same body for unknown,
// unverified, not-yours, not-shareable, misconfigured and malformed, because any distinction makes
// this an oracle (§5.8: "not found" and "not yours" are one message). The shared tail
// (serveDocument) establishes NOTHING itself, which is precisely why it is safe to share.
//
// ── WHAT THIS DOES NOT FIX, AND A NARROWING OF §8.876 ────────────────────────────────────────
//
// §8.876's Primus-side failures remain Primus's: `Documents.php` URLs still serve to anyone, and
// an ID-KEYED document lookup still returns another customer's list. What changes is that no
// `Documents.php` URL reaches a browser through us, and a wrong-customer request is refused HERE.
//
// NARROWED 2026-08-12 by live probe, and this is load-bearing rather than trivia: the cross-account
// failure is specific to the ID-KEYED lookups. NUMBER-keyed lookups (/book/bolnumber,
// /document/bolnumber) ARE customer-scoped — Primus answers a foreign BOL with `404 Booking not
// found.` The shipment route is built on that, and touches no id anywhere.

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

/**
 * THE SHIPMENT ROUTE: /s/{bolNumber}/{TYPE}. NO TOKEN, DELIBERATELY.
 *
 * This is the route the LIVE caller needs — `_waybOpenDocTab` opens a document for a BOL from the
 * chat buttons, and there is no invoice anywhere in that flow for an invoice-scoped token to bind
 * to. A token every legitimate caller could mint for itself is not a control, it is ceremony, so
 * this route carries none. Ownership rests on three things the caller cannot forge:
 *
 *   1. THE BEARER — Primus issued it only after validating a password.
 *   2. OUR CHECK — the BOL must resolve in the caller's OWN /book/bolnumber set (§5.8: resolve
 *      only within data the token already scoped).
 *   3. PRIMUS'S CHECK — number-keyed lookups are customer-scoped. VERIFIED LIVE 2026-08-12, both
 *      directions, with Haynes' token: own BOL 160134944 → 200 (thirdParty.id 1123086640);
 *      foreign BOL 303260010320 → 404 "Booking not found."
 *
 * ⚠ AND THE REASON THIS ROUTE MAY NEVER TOUCH A bolId. In the same session, the same token on the
 * ID-KEYED endpoint returned FIVE documents for a foreign bolId (136013091) — including a POD.
 * §8.876's failure is specifically the ID-KEYED lookups; number-keyed scopes, id-keyed does not.
 * That is a narrowing of §8.876, not a contradiction of it, and it is the whole basis of this
 * route. `bolNumber` only, never derived into an id.
 */
const ROUTE_S_RE = /^\/s\/([A-Za-z0-9_-]{1,64})\/([A-Za-z]{1,16})$/;

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
  const url = new URL(request.url);      // query string deliberately never parsed

  // ── CONFIG SHARED BY BOTH ROUTES. Missing bindings fail CLOSED, and as a 404 rather than a 500:
  // a misconfiguration must not be distinguishable from a refusal by anyone outside.
  //
  // WHAT CAN BE CHECKED is the SHAPE — a bare hostname. A value carrying a scheme, port, path,
  // credential or whitespace means someone pasted a URL into a host field, and `https://${that}`
  // would resolve somewhere nobody intended. Checked BEFORE any bearer moves: forwarding a
  // customer's Primus token to a host we did not intend is worse than serving a wrong document.
  //
  // WHAT CANNOT BE CHECKED, stated rather than pretended: a well-formed but WRONG host. These two
  // bindings are the trust root for their hops — if `PRIMUS_DOCUMENT_HOST` said
  // `evilshipprimus.com`, the byte hop would go there and no code here could know. That is a
  // deploy-time property, guarded by review of the toml. The runtime guarantee is narrower and
  // precise: whatever these name, every fetch goes THERE and nowhere else, and the CALLER cannot
  // influence any of them.
  const appletHost = env.PRIMUS_APPLET_HOST;
  const documentHost = env.PRIMUS_DOCUMENT_HOST;
  if (!appletHost || !documentHost || !HOSTNAME_RE.test(appletHost) || !HOSTNAME_RE.test(documentHost)) {
    logMiss('badhost', '');
    return notFound();
  }
  // fetchImpl is wrapped in an ARROW rather than stored bare. Holding it on `ctx` and calling
  // `ctx.fetchImpl(...)` is a METHOD call, so `this` becomes `ctx` — and Cloudflare's global fetch
  // refuses a detached `this` with "Illegal invocation", turning EVERY request into a 404 through
  // the catch. Found live 2026-08-12 against a fully green suite; a plain test stub has no `this`
  // requirement to violate, so no unit test could have caught it. Pinned by the REGRESSION test.
  const doFetch = (u, i) => fetchImpl(u, i);
  const ctx = { appletBase: `https://${appletHost}`, appletHost, documentHost, cors, fetchImpl: doFetch };

  try {
    const s = ROUTE_S_RE.exec(url.pathname);
    if (s) return await serveShipment(request, s[1], normalizeType(s[2]), ctx);

    const m = ROUTE_RE.exec(url.pathname);
    if (m) return await serveInvoice(request, env, m[1], m[2], normalizeType(m[3]), m[4], ctx);

    logMiss('malformed', '');
    return notFound();
  } catch (err) {
    // Anything unforeseen is a 404 too. A stack trace reaching a customer is an information leak,
    // and a 500 here would distinguish "we broke" from "you are not allowed" — which is the
    // distinction this route spends its whole length refusing to make.
    console.log(JSON.stringify({ evt: 'doc.error', error: String((err && err.message) || err).slice(0, 120) }));
    return notFound();
  }
}

/**
 * /s/{bolNumber}/{TYPE} — ownership by the caller's own book, no token.
 *
 * DENY BY DEFAULT, cheapest first: the two local checks refuse before a single byte leaves, so a
 * non-pull type or a missing bearer costs no request at all.
 */
async function serveShipment(request, bolNumber, type, ctx) {
  // LOCAL 1 — the type is shareable. The allowlist is the control; a COST is refused here and
  // never costs a lookup.
  if (classifyDocument(type) !== 'pull') { logMiss('type', ''); return notFound(); }

  // LOCAL 2 — the caller presents an identity. No bearer, no question to ask.
  const bearer = bearerFrom(request);
  if (!bearer) { logMiss('nobearer', ''); return notFound(); }

  // OWNERSHIP — resolve the BOL inside the caller's OWN book, with the caller's OWN token. A
  // foreign BOL is answered by Primus with `404 Booking not found.` (verified live), and an empty
  // envelope is NOT a yes: treating a well-formed empty answer as ownership is how a check becomes
  // decorative.
  const bookUrl = new URL(`${ctx.appletBase}/applet/v1/book/bolnumber/${encodeURIComponent(bolNumber)}`);
  if (bookUrl.hostname !== ctx.appletHost) { logMiss('bookhost', ''); return notFound(); }
  const bookRes = await ctx.fetchImpl(bookUrl.toString(), {
    method: 'GET',
    redirect: 'manual',
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!bookRes || bookRes.status >= 300 || !bookRes.ok) { logMiss('notmine', ''); return notFound(); }
  let booking;
  try { booking = await bookRes.json(); } catch { logMiss('bookbody', ''); return notFound(); }
  if (!bookingRecord(booking)) { logMiss('notmine', ''); return notFound(); }

  return serveDocument(bolNumber, type, bearer, ctx, '');
}

/** The one record out of /book/bolnumber, or null. An absent/empty result is null — never a yes. */
function bookingRecord(body) {
  let b = body && body.data !== undefined ? body.data : body;
  if (b && b.results !== undefined) b = Array.isArray(b.results) ? b.results[0] : b.results;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  return (b.BOLNumber || b.bolNumber || b.BOLId) ? b : null;
}

/**
 * /d/{invoiceId}/{bolNumber}/{TYPE}/{token} — the four proofs. Unchanged in substance; it now
 * shares the list/host/stream tail with the shipment route so the two can never drift apart on
 * the part that actually touches a document.
 */
async function serveInvoice(request, env, invoiceId, bolNumber, type, token, ctx) {
  // Config THIS route needs and the shipment route does not. Kept here rather than in the shared
  // block so the shipment route is not held hostage to a secret it never reads.
  const secret = env.DOC_TOKEN_SECRET;
  if (!secret || !env.LINKS) { logMiss('misconfigured', token); return notFound(); }

  // PROOF 1 — the link is real. Cheapest of the four and it needs no network, so it runs first:
  // an invented token costs one HMAC and never touches Primus.
  if (!(await verifyDocToken(secret, invoiceId, bolNumber, type, token))) {
    logMiss('token', token);
    return notFound();
  }

  // PROOF 4 — the type is shareable. Also local. A token minted for a COST is still refused,
  // because the allowlist is the control and the token only proves the link exists.
  if (classifyDocument(type) !== 'pull') { logMiss('type', token); return notFound(); }

  // PROOF 2 — the caller is who they say. The ONE thing forwarded is the bearer token.
  const bearer = bearerFrom(request);
  if (!bearer) { logMiss('nobearer', token); return notFound(); }
  const callerArCode = await resolveCallerArCode(bearer, ctx.appletBase, ctx.fetchImpl);
  if (!callerArCode) { logMiss('caller', token); return notFound(); }

  // PROOF 3 — the document is theirs. The invoice's ARCode comes from the LINK STORE, which the
  // mint wrote, never from the request and never from a field the caller could set.
  const row = await env.LINKS
    .prepare('SELECT ar_code FROM invoice_link WHERE primus_invoice_id = ? AND revoked_at IS NULL')
    .bind(invoiceId)
    .first();
  if (!row || !ownsInvoice(callerArCode, row.ar_code)) { logMiss('owner', token); return notFound(); }

  return serveDocument(bolNumber, type, bearer, ctx, token);
}

/**
 * THE SHARED TAIL — list, pick, exact-host, stream. Reached ONLY after a route has established
 * ownership its own way. It establishes nothing itself, which is why it is safe to share.
 */
async function serveDocument(bolNumber, type, bearer, ctx, token) {
  // THE WORKER BUILDS THIS URL. Keyed on the BOL NUMBER, so no internal id is involved, and the
  // caller contributed nothing but values its route already proved it may have.
  //
  // `bolnumber`, ONE WORD — verified live 2026-08-12 against Haynes BOL 160134944. This was
  // `/document/bol/` until then, on the authority of spec §8 (~line 596), and THAT ROUTE DOES NOT
  // EXIST: Primus answers `404 Route /applet/v1/document/bol/… does not exist`. Every document
  // would have 404'd, and 404 is this route's refusal vocabulary, so the outage would have looked
  // exactly like a permission denial. No stub could have caught it — a stub answers whatever path
  // it is asked for. Pinned by the REGRESSION test in route.test.mjs.
  const listUrl = new URL(`${ctx.appletBase}/applet/v1/document/bolnumber/${encodeURIComponent(bolNumber)}`);
  // Re-checked against the configured host after construction. Redundant today by design — the
  // route regexes already bound bolNumber — and it is the assertion that would catch a future
  // loosening of one of them rather than letting it become a path-injection.
  if (listUrl.hostname !== ctx.appletHost) { logMiss('listhost', token); return notFound(); }
  // redirect:'manual' HERE TOO, and this hop is the more important of the two: it carries the
  // customer's BEARER TOKEN. Following a redirect would replay a live credential at whatever the
  // Location header named — worse than the byte hop, where only a document is at stake.
  const listRes = await ctx.fetchImpl(listUrl.toString(), {
    method: 'GET',
    redirect: 'manual',
    headers: { Authorization: `Bearer ${bearer}` },
  });
  if (!listRes || listRes.status >= 300 || !listRes.ok) { logMiss('list', token); return notFound(); }
  // THE ENVELOPE — `data.results[]`, each row carrying `type` and `url`. VERIFIED LIVE 2026-08-12
  // against Haynes BOL 160134944: 4 rows (BOL, LBL, QUO, INV), every url on www.shipprimus.com.
  const listBody = await listRes.json();
  const rows = (listBody && listBody.data && listBody.data.results) || [];
  const doc = (Array.isArray(rows) ? rows : []).find(d =>
    d && normalizeType(d.fileType || d.type || d.documentType || d.name) === type);
  const target = doc && (doc.url || doc.fileUrl || doc.documentUrl || doc.link);
  if (!target) { logMiss('nodoc', token); return notFound(); }

  // EXACT HOST. `===`, never endsWith. doc-proxy's whole failure is that
  // "evilshipprimus.com".endsWith("shipprimus.com") is true. This URL came from Primus rather than
  // from the caller, and it is STILL checked, because "it came from upstream" is a provenance
  // argument and this is a boundary. Note the live response proves the byte URL cannot be
  // constructed anyway: the query param differs per type (id / idLabel / idCQ / idInv, each with a
  // `t=`), which is exactly why the Worker takes what Primus returns and checks it.
  let parsed;
  try { parsed = new URL(String(target)); } catch { logMiss('badurl', token); return notFound(); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== ctx.documentHost) {
    logMiss('host', token);
    return notFound();
  }

  // redirect:'manual'. A 3xx is a signal something is wrong, not a thing to chase — following one
  // would put the host check on the first hop only, which is exactly doc-proxy's shape.
  const upstream = await ctx.fetchImpl(parsed.toString(), { method: 'GET', redirect: 'manual' });
  if (!upstream || upstream.status >= 300 || !upstream.ok) { logMiss('upstream', token); return notFound(); }

  // THE ONLY PATH THAT STREAMS BYTES. Upstream's framing headers are dropped so the PDF can render
  // in an iframe (the reason doc-proxy existed) — but only on this response, the one a route
  // established ownership for.
  const headers = new Headers(upstream.headers);
  headers.delete('X-Frame-Options');
  headers.delete('Content-Security-Policy');
  headers.delete('Set-Cookie');
  // UPSTREAM CORS IS DELETED, NOT OVERWRITTEN. Primus answers with `Access-Control-Allow-Origin: *`.
  // We only SET our own ACAO when the Origin matches — so on a mismatch there was nothing to
  // overwrite and upstream's `*` survived onto our response, handing any origin's JavaScript a
  // customer's PDF. Found live 2026-08-12 on an otherwise perfect 200. Deleting beats overwriting:
  // a header we forgot to name cannot be overwritten by name, but the whole family can be dropped.
  for (const h of ['Access-Control-Allow-Origin', 'Access-Control-Allow-Credentials',
                   'Access-Control-Expose-Headers', 'Access-Control-Allow-Methods',
                   'Access-Control-Allow-Headers', 'Access-Control-Max-Age',
                   'Timing-Allow-Origin']) headers.delete(h);
  headers.set('Content-Type', 'application/pdf');
  // Correct and free. NOT load-bearing: under Option A the portal reads this into a Blob, so the
  // visible filename comes from its `a.download`. This header is what a direct hit would get.
  headers.set('Content-Disposition', `inline; filename="${documentFilename(bolNumber, type)}"`);
  for (const [k, v] of Object.entries({ ...BASE_HEADERS, ...ctx.cors })) headers.set(k, v);

  return new Response(upstream.body, { status: 200, headers });
}

export default {
  async fetch(request, env) {
    // BOUND, belt-and-braces alongside the arrow wrapper above. The global fetch must keep its
    // own `this`; passing it bare has bitten this file once already.
    return handleRequest(request, env, (u, i) => fetch(u, i));
  },
};
