// pay.freightandlogistics.ai — THE POSSESSION ROUTE. Spec §8.878, §8.880.
//
// THE FIRST THING THIS ESTATE HAS EVER EXPOSED PUBLICLY, so the scope is deliberately one route.
//
// The token SELECTS an invoice; the portal session AUTHORISES. This Worker serves ONLY the
// possession tier and holds ONLY the possession database — no Primus credentials, no ledger
// binding, no SendGrid key. Documents and payment are session-tier and live in the portal; the
// document byte-proxy is a SEPARATE step, because verifying a session is a different security
// problem and folding it in here would pull identity back toward the public edge.
//
// ── WHERE THE BOUNDARY IS ACTUALLY ENFORCED — four layers, and only one is this file ─────────
//   1. THE DATABASE holds only possession-tier columns. Nothing else is reachable from here.
//   2. THE QUERY names its fields (POSSESSION_FIELDS) rather than SELECT *, so a column added
//      later is not silently disclosed.
//   3. THE BINDING is one D1 and nothing else.
//   4. THE RENDERER is server-side, so session-tier data never reaches a browser to be hidden —
//      §8.873's lesson that a boundary enforced in the UI is a display preference.
//   5. THE AR ALLOWLIST is welded into the token query (§8.882), so a row outside the pilot bound
//      is NOT ADDRESSABLE from here — not fetched and then rejected. The mint refusing is the
//      primary control; this is the second one, and it covers rows that never passed through the
//      mint at all (a restored backup, a manual insert, a future writer that forgets).
// LAYERS 1 AND 3 ARE THE REAL ONES: they hold when this file is wrong.
//
// ── ENUMERATION: THE ENTROPY IS THE CONTROL, NOT A RATE LIMIT (§8.880) ───────────────────────
// A thousand guesses a minute against 2^128 finds nothing. Rate limiting belongs at the Cloudflare
// edge and exists for COST AND AVAILABILITY. Conflating the two is how short tokens ship behind a
// limiter and are believed safe. What this file contributes is the miss SIGNAL: a 404 spike is the
// only evidence anyone is trying, and the token is logged BY PREFIX ONLY — a full token in a log is
// the credential-in-a-log problem, reappearing where nobody would look for it.

import { resolveToken } from '../../invoice-sync/src/invoice-link.js';
// arcode.js is PURE and dependency-free. config.js would drag Primus credentials, Stripe key
// resolution and mode config into a bundle served from the open internet, to parse one string.
import { parseAllowlist } from '../../invoice-sync/src/arcode.js';
import { DISPUTE_NOTICE } from '../../invoice-sync/src/dispute-notice.js';
import { COPY } from './copy.js';

/** Where the CTA sends a customer. The deep link (D2) is unbuilt; this is the honest interim. */
const PORTAL_URL = 'https://www.freightandlogistics.ai/portal';

/** 22 base64url characters, matched BEFORE any database call. */
const TOKEN_RE = /^\/i\/([A-Za-z0-9_-]{22})$/;

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  // A possession page cached at the edge and served to the wrong person is the worst failure this
  // route has. Set on EVERY response, not only the 200s.
  'Cache-Control': 'private, no-store',
  // The token is IN THE URL and the CTA links to the portal. A default policy hands it to the next
  // origin in the Referer header.
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  // No scripts, no forms, no images on this page — so state it rather than relying on it staying
  // true. Added by the assistant, not asked for; cheap and easy to remove if unwanted.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Never render $NaN (CLAUDE.md design rule). A missing amount is blank — not zero, not junk. */
function money(cents) {
  return Number.isInteger(cents) ? `$${(cents / 100).toFixed(2)}` : '';
}

function html(body, status) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>Freight and Logistics, Inc.</title></head><body>${body}</body></html>`,
    { status, headers: HEADERS });
}

/**
 * ONE response for unknown, revoked, malformed and wrong-mode alike.
 *
 * Four different causes, one output, deliberately: any distinction makes this route an oracle for
 * which tokens exist (§5.8 — "not found" and "not yours" are one message).
 */
function notFound() {
  return html(`<main><h1>${esc(COPY.notFoundTitle)}</h1><p>${esc(COPY.notFoundBody)}</p></main>`, 404);
}

function page(link) {
  return html(
    `<main>` +
    `<h1>${esc(COPY.labelInvoice)} ${esc(link.invoice_number)}</h1>` +
    `<dl>` +
    `<dt>${esc(COPY.labelIssued)}</dt><dd>${esc(link.issue_date)}</dd>` +
    `<dt>${esc(COPY.labelDue)}</dt><dd>${esc(link.due_date)}</dd>` +
    `<dt>${esc(COPY.labelAmount)}</dt><dd>${esc(money(link.total_cents))}</dd>` +
    `<dt>${esc(COPY.labelBol)}</dt><dd>${esc(link.bol_number)}</dd>` +
    `</dl>` +
    // Owner decision 4 — the amount is as-sent and the page says so, beside its date.
    // {issue_date} is interpolated with the SNAPSHOT date — never a live read.
    `<p>${esc(COPY.asSentNote.replace('{issue_date}', link.issue_date ?? ''))}</p>` +
    `<p>${esc(COPY.asSentSecondary)}</p>` +
    // The CTA needs a destination and the deep link (D2) does not exist yet, so it points at the
    // portal itself: the customer signs in and finds the invoice. Degrades honestly today and gains
    // the token parameter when D2 lands. THE COPY IS UNTOUCHED — only the href is a choice here.
    `<p><a href="${PORTAL_URL}">${esc(COPY.ctaLabel)}</a></p>` +
    `</main>`, 200);
}

export default {
  async fetch(request, env) {
    // GET and HEAD only. This route reads one row; nothing about it should accept a body.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { ...HEADERS, Allow: 'GET, HEAD' } });
    }

    const url = new URL(request.url);
    // Query parameters are IGNORED, never parsed. A parameter that is validated is a parameter that
    // can be attacked; the token is the only input this route accepts.
    const m = TOKEN_RE.exec(url.pathname);
    if (!m) return notFound();

    // Parsed per request rather than at module scope: parseAllowlist THROWS on an unset value, and
    // a throw at module scope in a Worker is a hard 1101 on every request with no useful log. Here
    // it is one caught failure, and an unset AR_ALLOWLIST fails CLOSED — serving nothing — which is
    // the correct direction for a public route.
    let bound;
    try {
      bound = parseAllowlist(env.AR_ALLOWLIST);
    } catch (err) {
      console.error(JSON.stringify({ evt: 'link.misconfigured', error: String(err && err.message || err) }));
      return notFound();
    }

    const link = await resolveToken(env.LINKS, env.LINK_MODE, m[1], bound);
    if (!link) {
      // PREFIX ONLY. The miss rate is the enumeration signal; the token is not ours to log.
      console.log(JSON.stringify({ evt: 'link.miss', mode: env.LINK_MODE, prefix: m[1].slice(0, 6) }));
      return notFound();
    }
    return page(link);
  },
};
