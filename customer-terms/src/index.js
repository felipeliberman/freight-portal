// customer-terms — self-sourced billing-terms (PRE / NET15 / NET30 / …) tracking.
//
// Primus does not expose a customer's billing-terms code on any API endpoint
// (verified live: the profile, invoice, and BOL endpoints all lack it, even for
// a customer actively switched to PRE). The portal must therefore track terms
// itself. This Worker owns that store: TERMS_KV, keyed by Primus customer ID.
//
//   GET  /terms?customerId=<id>   Public (CORS-gated). Read a customer's terms.
//                                 Absent entry => { termsCode: null }. A missing
//                                 customer is NORMAL, never an error.
//   PUT  /terms                   Admin only. Requires header X-Admin-Secret
//                                 matching env.ADMIN_SECRET. Body JSON:
//                                 { customerId, termsCode, setBy? }.
//
// Deploy:  cd customer-terms && wrangler deploy
// KV:      wrangler kv namespace create TERMS_KV   (paste the id into wrangler.toml)
// Secret:  wrangler secret put ADMIN_SECRET        (set once; not stored in this repo)

const ALLOWED_ORIGINS = [
  'https://freightandlogistics.ai',
  'https://www.freightandlogistics.ai'
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
    'Vary': 'Origin'
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) }
  });
}

// GET /terms?customerId=<id> — read one customer's terms. Absence => termsCode:null.
async function handleGet(request, env) {
  const url = new URL(request.url);
  const customerId = (url.searchParams.get('customerId') || '').trim();
  if (!customerId) return json(request, { error: 'customerId required' }, 400);

  const raw = await env.TERMS_KV.get(customerId);
  if (!raw) return json(request, { customerId, termsCode: null });

  let rec;
  try { rec = JSON.parse(raw); } catch (e) { rec = {}; }
  return json(request, {
    customerId,
    termsCode: rec.termsCode || null,
    setAt: rec.setAt || null,
    setBy: rec.setBy || null
  });
}

// PUT /terms — admin write, shared-secret gated. Body: { customerId, termsCode, setBy? }.
async function handlePut(request, env) {
  const secret = request.headers.get('X-Admin-Secret') || '';
  if (!env.ADMIN_SECRET || secret !== env.ADMIN_SECRET) {
    return json(request, { error: 'unauthorized' }, 401);
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return json(request, { error: 'invalid JSON body' }, 400); }

  const customerId = String(body.customerId == null ? '' : body.customerId).trim();
  const termsCode  = String(body.termsCode == null ? '' : body.termsCode).trim().toUpperCase();
  if (!customerId) return json(request, { error: 'customerId required' }, 400);
  if (!termsCode)  return json(request, { error: 'termsCode required' }, 400);

  const record = {
    termsCode,
    setAt: Date.now(),
    setBy: (String(body.setBy == null ? '' : body.setBy).trim()) || 'admin'
  };
  await env.TERMS_KV.put(customerId, JSON.stringify(record));
  return json(request, { ok: true, customerId, ...record });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {
      if (url.pathname === '/health') {
        return json(request, { ok: true });
      }
      if (url.pathname === '/terms' && request.method === 'GET') {
        return await handleGet(request, env);
      }
      if (url.pathname === '/terms' && request.method === 'PUT') {
        return await handlePut(request, env);
      }
      return json(request, { error: 'Not found' }, 404);
    } catch (err) {
      return json(request, { error: String(err && err.message || err) }, 500);
    }
  }
};
