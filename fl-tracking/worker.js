/**
 * Freight and Logistics, Inc. — Shipment Tracking Worker
 *
 * Calls ShipPrimus's tracking endpoint server-side and returns a mapped, allowlisted
 * response. Shipper/consignee NAMES, street addresses, phones, faxes, emails and
 * contacts are NEVER included on either route. City/State only, never street.
 *
 * TWO ROUTES, selected by query parameter (both live at "/"):
 *
 *   ?bol=  PORTAL route — logged-in customers (portal.html). Behavior is unchanged
 *          and must stay that way: digits-only input, all timeline rows including
 *          NOTE, {found,bol,carrier,service,status,delivered,events}, no rate limit
 *          (portal staff share NAT'd office IPs and would lock each other out).
 *
 *   ?q=    PUBLIC route — unauthenticated landing page (index.html). Relaxed
 *          alphanumeric input so carrier PROs work, NOTE rows filtered out, wider
 *          non-PII field set, a per-IP rate limit (see PUBLIC_RATE_LIMIT — the only
 *          place the number lives), and 503 on upstream failure.
 *
 * CUSTOMER is a vestigial query parameter: the upstream ignores it entirely
 * (verified — omitted, wrong, and empty values all return identical data). It is
 * NOT a credential and grants no access. Kept only to preserve the request shape.
 */

const CUSTOMER = 'Shippi';

// Public route only. Enumeration is the threat model — BOL numbers are sequential — but the
// key is a raw IP, so a NAT'd freight office counts as a single visitor. The original 20 was
// too tight: one person testing locked out a whole location. The value below is the ONLY
// place the limit lives; it stays high enough for normal multi-shipment use and low enough
// that walking a sequential range is slow and noisy.
const PUBLIC_RATE_LIMIT = 60;      // lookups per window, per IP
const PUBLIC_RATE_WINDOW = 3600;   // seconds

const UPSTREAM = 'https://shipprimus.com/tracking.php';

function corsFor(request) {
  // Reflect requesting origin so file://, localhost, and the live site all work
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Vary': 'Origin',
  };
}

function upstreamUrl(num) {
  return UPSTREAM + '?format=json' +
    '&customer=' + encodeURIComponent(CUSTOMER) +
    '&trackingNumber=' + encodeURIComponent(num);
}

export default {
  async fetch(request, env) {
    const CORS = corsFor(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);
    // Route on the parameter, not the path, so both clients keep their existing call shape.
    return url.searchParams.has('q')
      ? handlePublic(request, env, url, CORS)
      : handlePortal(url, CORS);
  },
};

/* ------------------------------------------------------------------ *
 * PORTAL ROUTE (?bol=) — unchanged. Do not alter without checking
 * portal.html fetchTrack/renderTrack, which are live with customers.
 * ------------------------------------------------------------------ */
async function handlePortal(url, CORS) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: CORS });

  // Input validation: digits only, sane length
  const bol = (url.searchParams.get('bol') || '').replace(/\D/g, '');
  if (!bol || bol.length < 4 || bol.length > 20) {
    return json({ found: false, error: 'invalid_number' }, 400);
  }

  // Call ShipPrimus tracking server-side — never exposed to browser
  const trackUrl =
    'https://shipprimus.com/tracking.php?format=json' +
    '&customer=' + encodeURIComponent(CUSTOMER) +
    '&trackingNumber=' + encodeURIComponent(bol);

  let data;
  try {
    const res = await fetch(trackUrl);
    if (!res.ok) throw new Error('upstream');
    data = await res.json();
  } catch {
    return json({ found: false, error: 'upstream_error' });
  }

  const r = data?.Result;
  if (!r || !r.TrackingInformation?.length) {
    return json({ found: false });
  }

  // PII-free response — Shipper/Consignee/ThirdParty/FreightInformation intentionally excluded
  const events = r.TrackingInformation.map(row => ({
    status:  row.Item?.Status  || '',
    remarks: row.Item?.Remarks || '',
    date:    row.Item?.date    || '',
    time:    row.Item?.time    || '',
    code:    row.Item?.Code    || '',
  }));

  const latest    = events[0] || {};
  const delivered = latest.code === 'DLV' || /deliver/i.test(latest.status || '');

  return json({
    found:     true,
    bol:       r.BOL                   || bol,
    carrier:   r.Carrier?.CarrierName  || '',
    service:   r.Carrier?.ServiceLevel || '',
    status:    latest.status           || 'Status unavailable',
    delivered,
    events,
  });
}

/* ------------------------------------------------------------------ *
 * PUBLIC ROUTE (?q=) — unauthenticated landing page.
 * ------------------------------------------------------------------ */

// Which reference types the upstream can actually resolve. Returned to the client so
// the not-found copy is API-driven: shipper reference numbers do NOT resolve upstream
// (verified), and that must be stated to the customer, never left a silent miss.
const SEARCHED = ['bol', 'pro'];

async function handlePublic(request, env, url, CORS) {
  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: CORS });

  // Alphanumeric preserved — carrier PROs are not always digits. No \D strip: that
  // silently rewrote the customer's number into a different one before querying.
  const num = (url.searchParams.get('q') || '').trim();
  if (!/^[A-Za-z0-9-]{4,40}$/.test(num)) {
    return json({ ok: false, found: false, error: 'invalid_number', searched: SEARCHED }, 400);
  }

  // Rate limit BEFORE touching the upstream. Fails open if the binding is missing,
  // but loudly — an unbound namespace is why the previous limiter never ran at all.
  if (env?.RL) {
    const ip = request.headers.get('CF-Connecting-IP') || 'anon';
    const key = 'trkq:' + ip;
    const hits = parseInt((await env.RL.get(key)) || '0', 10);
    if (hits >= PUBLIC_RATE_LIMIT) {
      return json({ ok: false, found: false, error: 'rate_limited', searched: SEARCHED }, 429);
    }
    await env.RL.put(key, String(hits + 1), { expirationTtl: PUBLIC_RATE_WINDOW });
  } else {
    console.error('fl-tracking: RL binding missing — public route is UNTHROTTLED');
  }

  // Transport/parse failure must be distinguishable from a genuine not-found. Conflating
  // the two is exactly what hid the track-proxy outage for weeks.
  let data;
  try {
    const res = await fetch(upstreamUrl(num));
    if (!res.ok) {
      console.error('fl-tracking upstream non-OK', { num, status: res.status });
      return json({ ok: false, found: false, error: 'upstream_error', searched: SEARCHED }, 503);
    }
    data = await res.json();
  } catch (e) {
    console.error('fl-tracking upstream failure', { num, message: String((e && e.message) || e) });
    return json({ ok: false, found: false, error: 'upstream_error', searched: SEARCHED }, 503);
  }

  const r = data?.Result;
  if (!r || !r.TrackingInformation?.length) {
    return json({ ok: false, found: false, searched: SEARCHED });
  }

  // NOTE rows are internal operator chatter, not shipment milestones. The upstream sends
  // the code clean ("NOTE") but the status with a leading space (" NOTE"), so trim both.
  const timeline = r.TrackingInformation
    .map(row => row && row.Item)
    .filter(Boolean)
    .filter(i => String(i.Code || '').trim().toUpperCase() !== 'NOTE')
    .map(i => ({
      date:    i.date || '',
      time:    i.time || '',
      status:  String(i.Status  || '').trim(),
      remarks: String(i.Remarks || '').trim(),
      code:    String(i.Code    || '').trim(),
    }));

  // Derived from the FILTERED list, so a NOTE row can never become the headline status.
  const latest = timeline[0] || {};
  const currentStatus = latest.status || 'Status unavailable';
  const delivered = String(latest.code || '').toUpperCase() === 'DLV' || /deliver/i.test(currentStatus);

  // Allowlist. City/State only — never street, name, phone, fax, email, or contact.
  const cityState = (o) => [o?.City, o?.State].filter(Boolean).join(', ');

  return json({
    ok:          true,
    found:       true,
    bol:         r.BOL                   || num,
    currentStatus,
    carrier:     r.Carrier?.CarrierName  || '',
    service:     r.Carrier?.ServiceLevel || '',
    scac:        r.Carrier?.SCAC         || '',
    delivered,
    origin:      cityState(r.Shipper),
    destination: cityState(r.Consignee),
    pieces:      r.FreightInformation?.TotalPieces ?? null,
    weight:      r.FreightInformation?.TotalWeight ?? null,
    timeline,
    searched:    SEARCHED,
  });
}
