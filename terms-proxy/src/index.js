// terms-proxy — live customer billing terms, read from the ShipPrimus admin console.
//
// WHY THIS EXISTS
// Billing terms (PREPAID / NET15 / …) live ONLY on the console customer record,
// not on the tenant REST API the portal authenticates against. Reaching them
// needs the master console session (cookie auth), which must NEVER touch the
// browser. This Worker holds that session and exposes ONE read-only endpoint:
//
//   GET /terms?code=<accountingId>&name=<company>&id=<primusCustomerId>
//        -> { termDescription, termsCode, isPrepaid, matchConfidence }
//
// JOIN (locked): the applet login hands the portal billToInformation.code
// (= console accountingId) and .name at sign-in. We two-factor match:
// getShippingLocations query=<name>, then keep records where accountingId===code.
// Exactly one -> resolved. Zero or many -> standard (isPrepaid=false). NO email
// matching (a customer has many login emails; the general email is often blank).
//
// SECURITY: master creds live only as wrangler secrets; the PHPSESSID lives only
// in SESSION_KV. Nothing sensitive is ever returned to or stored in the browser.

const CONSOLE_BASE = 'https://shipprimus.com/PRIMUS/trunk';
const MANAGE = CONSOLE_BASE + '/manage.php';

const SESSION_KEY = 'console_session';
const SESSION_TTL_MS = 45 * 60 * 1000;   // refresh well before the ~50min server session
const TERMS_TTL_MS = 4 * 60 * 60 * 1000; // resolved terms good for 4h — backstop for a missed runbook purge; the KV expirationTtl below is derived from this, so the two never drift

// ─── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://freightandlogistics.ai',
  'https://www.freightandlogistics.ai'
];
function isAllowedOrigin(origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const h = new URL(origin).hostname;
    return h === 'freight-portal.pages.dev' || h.endsWith('.freight-portal.pages.dev');
  } catch (e) { return false; }
}
function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = isAllowedOrigin(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}
function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
  });
}

// ─── console session ─────────────────────────────────────────────────────────
function pickCookie(setCookie) {
  if (!setCookie) return null;
  const m = setCookie.match(/PHPSESSID=[^;]+/);
  return m ? m[0] : null;
}

// Fresh master login -> returns an authenticated PHPSESSID string, or throws.
async function consoleLogin(env) {
  const user = env.PRIMUS_CONSOLE_USER;
  const pass = env.PRIMUS_CONSOLE_PASS;
  if (!user || !pass) throw new Error('console creds not configured');

  // Seed a PHPSESSID (PHP session_start), then log in carrying it.
  let cookie = null;
  try {
    const seed = await fetch(CONSOLE_BASE + '/', { redirect: 'manual' });
    cookie = pickCookie(seed.headers.get('set-cookie'));
  } catch (e) { /* seeding is best-effort */ }

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'XMLHttpRequest'
  };
  if (cookie) headers.Cookie = cookie;

  const body = new URLSearchParams({
    action: 'login',
    loginUsername: user,
    loginPassword: pass,
    browser: 'Firefox', browserVersion: '120', os: 'Mac'
  }).toString();

  const r = await fetch(MANAGE, { method: 'POST', headers, body, redirect: 'manual' });
  const blessed = pickCookie(r.headers.get('set-cookie'));
  if (blessed) cookie = blessed;
  const txt = await r.text();
  if (!/success['"]?\s*:\s*true/i.test(txt)) {
    throw new Error('console login failed: ' + txt.slice(0, 120));
  }
  if (!cookie) throw new Error('console login returned no session cookie');
  return cookie;
}

// Return a usable session cookie, from cache or a fresh login. forceFresh bypasses cache.
async function getSession(env, forceFresh) {
  if (!forceFresh) {
    try {
      const raw = await env.SESSION_KV.get(SESSION_KEY);
      if (raw) {
        const rec = JSON.parse(raw);
        if (rec && rec.cookie && rec.expiresAt && rec.expiresAt > Date.now()) {
          return rec.cookie;
        }
      }
    } catch (e) { /* fall through to fresh login */ }
  }
  const cookie = await consoleLogin(env);
  try {
    await env.SESSION_KV.put(
      SESSION_KEY,
      JSON.stringify({ cookie, expiresAt: Date.now() + SESSION_TTL_MS }),
      { expirationTtl: Math.floor(SESSION_TTL_MS / 1000) }
    );
  } catch (e) { /* cache write is best-effort */ }
  return cookie;
}

// One getShippingLocations name-search. Returns { ok, records } or { ok:false, lostSession }.
async function searchLocations(cookie, name) {
  const body = new URLSearchParams({
    action: 'getShippingLocations', page: '1', limit: '50', query: name
  }).toString();
  const r = await fetch(MANAGE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookie
    },
    body,
    redirect: 'manual'
  });
  const txt = await r.text();
  let j = null;
  try { j = JSON.parse(txt); } catch (e) { /* non-JSON => lost session/HTML */ }
  if (j && Array.isArray(j.shipping_locations)) {
    return { ok: true, records: j.shipping_locations };
  }
  // Anything else (login redirect, "No session started", success:false) => stale session.
  return { ok: false, lostSession: true };
}

// getShippingLocations with one automatic re-login on a lost session.
async function searchWithSession(env, name) {
  let cookie = await getSession(env, false);
  let res = await searchLocations(cookie, name);
  if (!res.ok && res.lostSession) {
    cookie = await getSession(env, true); // force fresh login, retry once
    res = await searchLocations(cookie, name);
  }
  if (!res.ok) throw new Error('console search failed (session)');
  return res.records;
}

// ─── terms mapping ───────────────────────────────────────────────────────────
function mapTerms(termDescription) {
  const desc = (termDescription || '').trim();
  const isPrepaid = /^prepaid$/i.test(desc);
  let termsCode = null;
  if (isPrepaid) termsCode = 'PRE';              // portal consumers gate on === 'PRE'
  else if (desc) termsCode = desc.toUpperCase().replace(/[^A-Z0-9]/g, ''); // NET15, NET30, CREDITCARD…
  return { termDescription: desc || null, termsCode, isPrepaid };
}

// Two-factor match: name-search ∩ accountingId===code. Exactly one => resolved.
function matchRecord(records, code) {
  const want = String(code == null ? '' : code).trim();
  const hits = records.filter(r => String(r.accountingId == null ? '' : r.accountingId).trim() === want);
  if (hits.length === 1) return { record: hits[0], matchConfidence: 'resolved' };
  if (hits.length === 0) return { record: null, matchConfidence: 'none' };
  return { record: null, matchConfidence: 'ambiguous' };
}

const STANDARD = { termDescription: null, termsCode: null, isPrepaid: false };

// ─── /terms ──────────────────────────────────────────────────────────────────
async function handleTerms(request, env) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim();
  const name = (url.searchParams.get('name') || '').trim();
  const id   = (url.searchParams.get('id') || '').trim(); // primusCustomerId, cache key only

  if (!code && !name) {
    return json(request, { ...STANDARD, matchConfidence: 'none', source: 'no-input' });
  }

  // Fast path: fresh cache hit keyed by primusCustomerId.
  if (id) {
    try {
      const raw = await env.TERMS_CACHE_KV.get(id);
      if (raw) {
        const rec = JSON.parse(raw);
        if (rec && rec.resolvedAt && (rec.resolvedAt + TERMS_TTL_MS) > Date.now()) {
          return json(request, {
            termDescription: rec.termDescription, termsCode: rec.termsCode,
            isPrepaid: rec.isPrepaid, matchConfidence: rec.matchConfidence || 'resolved',
            source: 'cache'
          });
        }
      }
    } catch (e) { /* ignore cache read errors */ }
  }

  // Live resolution.
  let records;
  try {
    records = await searchWithSession(env, name || code);
  } catch (e) {
    // Console/session failure -> last-known cached value (stale-but-safe), else standard.
    if (id) {
      try {
        const raw = await env.TERMS_CACHE_KV.get(id);
        if (raw) {
          const rec = JSON.parse(raw);
          return json(request, {
            termDescription: rec.termDescription, termsCode: rec.termsCode,
            isPrepaid: rec.isPrepaid, matchConfidence: rec.matchConfidence || 'resolved',
            source: 'cache-stale'
          });
        }
      } catch (e2) { /* ignore */ }
    }
    return json(request, { ...STANDARD, matchConfidence: 'error', source: 'console-error' });
  }

  const { record, matchConfidence } = matchRecord(records, code);
  const mapped = record ? mapTerms(record.termDescription) : { ...STANDARD };

  const out = {
    termDescription: mapped.termDescription,
    termsCode: mapped.termsCode,
    isPrepaid: mapped.isPrepaid,
    matchConfidence
  };

  // Cache the resolved value (including a clean no-match, so dead accounts don't re-hit).
  if (id) {
    try {
      await env.TERMS_CACHE_KV.put(id, JSON.stringify({
        ...out,
        name: record ? record.name : name,
        code: record ? record.accountingId : code,
        resolvedAt: Date.now()
      }), { expirationTtl: Math.floor(TERMS_TTL_MS / 1000) });
    } catch (e) { /* best-effort */ }
  }

  return json(request, { ...out, source: 'live' });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    try {
      if (url.pathname === '/health') return json(request, { ok: true });
      if (url.pathname === '/terms' && request.method === 'GET') {
        return await handleTerms(request, env);
      }
      return json(request, { error: 'Not found' }, 404);
    } catch (err) {
      return json(request, { error: String((err && err.message) || err) }, 500);
    }
  }
};
