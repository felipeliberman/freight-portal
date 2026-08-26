// qbo-api — QuickBooks Online invoice + payment operations.
// Shares KV (tokens + realmId) with the qbo-auth worker.

const QBO_API_ROOT = 'https://quickbooks.api.intuit.com/v3/company';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const MINOR_VERSION = '73';

const ALLOWED_ORIGINS = [
  'https://freightandlogistics.ai',
  'https://www.freightandlogistics.ai'
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// Refresh the access token using the stored refresh token, persist rotated
// tokens back to KV, and return the fresh access token.
async function refreshAccessToken(env) {
  const refreshToken = await env.QBO_KV.get('qbo_refresh_token');
  if (!refreshToken) throw new Error('No refresh_token in KV');

  const creds = btoa(env.QBO_CLIENT_ID + ':' + env.QBO_CLIENT_SECRET);
  const resp = await fetch(QBO_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + creds,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });

  const tokens = await resp.json();
  if (!tokens.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(tokens));
  }

  await env.QBO_KV.put('qbo_access_token', tokens.access_token);
  // QBO rotates the refresh token — persist the new one when returned.
  if (tokens.refresh_token) {
    await env.QBO_KV.put('qbo_refresh_token', tokens.refresh_token);
  }
  if (tokens.expires_in) {
    await env.QBO_KV.put('qbo_token_expiry', String(Date.now() + tokens.expires_in * 1000));
  }
  return tokens.access_token;
}

// Call the QBO API with the stored access token. On 401, refresh once and retry.
async function qboFetch(env, realmId, path, options = {}) {
  let accessToken = await env.QBO_KV.get('qbo_access_token');
  if (!accessToken) accessToken = await refreshAccessToken(env);

  const doFetch = (token) => {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${QBO_API_ROOT}/${realmId}${path}${sep}minorversion=${MINOR_VERSION}`;
    return fetch(url, {
      ...options,
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
  };

  let resp = await doFetch(accessToken);
  if (resp.status === 401) {
    accessToken = await refreshAccessToken(env);
    resp = await doFetch(accessToken);
  }
  return resp;
}

// Escape reserved chars for the QBO query language so a value can't break out
// of its string literal. Backslash MUST be escaped first, otherwise it would
// double-process the backslashes we add for quotes (and an input ending in `\`
// could break out). NOTE: the customer lookup uses LIKE '%value%', so a literal
// % or _ in the input acts as a wildcard and broadens the match. That's
// acceptable for internal name/email search; we don't escape them to literals
// because QBO's LIKE has no reliable wildcard-escape mechanism.
function q(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

async function queryQBO(env, realmId, query) {
  const resp = await qboFetch(env, realmId, `/query?query=${encodeURIComponent(query)}`);
  const data = await resp.json();
  if (!resp.ok) {
    throw new Error('QBO query failed (' + resp.status + '): ' + JSON.stringify(data));
  }
  return data.QueryResponse || {};
}

function shapeInvoice(inv) {
  return {
    Id: inv.Id,
    DocNumber: inv.DocNumber || null,
    DueDate: inv.DueDate || null,
    Balance: inv.Balance,
    TotalAmt: inv.TotalAmt,
    CustomerRef: inv.CustomerRef || null,
    EmailAddr: (inv.BillEmail && inv.BillEmail.Address) || null
  };
}

// LOOKUP BY DocNumber ONLY.
//
// This endpoint is PUBLIC and unauthenticated — CORS is not access control, so ALLOWED_ORIGINS
// above governs browsers and nothing else. Until that is fixed, the size of this route IS the
// exposure, so it is kept to exactly what production calls.
//
// The `?email=` and `?name=` customer searches were REMOVED on 2026-08-26. They took a substring
// (`LIKE '%value%'`) and answered with up to 25 customers — DisplayName and email address each —
// so `?name=a` returned a slice of the customer list to anyone who asked, and iterating the
// alphabet returned most of it. That is a customer-list-with-revenue disclosure reachable by one
// unauthenticated GET, and it existed to serve callers that turned out not to exist: the whole
// repo was searched (portal.html, every Worker, every file type) and NOTHING used either
// parameter. The only production caller of this route is portal.html's invoice-id resolution,
// which passes docNumber. Removing them cost nothing and removed the largest leak here.
//
// Do not restore them for debugging convenience. The QuickBooks MCP tools read the same data with
// real authentication behind them.
//
// NOTE what this route still does NOT do: it will return ANY invoice by DocNumber, to anyone.
// Constraining that needs caller identity (forward the portal's Primus bearer token, resolve the
// ARCode, refuse invoices that are not the caller's) and is deliberately a later phase.
async function handleInvoices(request, env, realmId) {
  const url = new URL(request.url);
  const docNumber = url.searchParams.get('docNumber');
  if (!docNumber) {
    return json(request, { error: 'Provide a docNumber query parameter' }, 400);
  }
  const invoiceRows =
    (await queryQBO(env, realmId, `select * from Invoice where DocNumber = '${q(docNumber)}'`)).Invoice || [];
  return json(request, { invoices: invoiceRows.map(shapeInvoice) });
}

async function handlePayment(request, env, realmId) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json(request, { error: 'Invalid JSON body' }, 400);
  }

  const { invoiceId, amount, paymentDate, stripePaymentIntentId } = body;
  if (!invoiceId || amount == null) {
    return json(request, { error: 'invoiceId and amount are required' }, 400);
  }

  // The invoice supplies the CustomerRef required by the Payment object.
  const invResp = await qboFetch(env, realmId, `/invoice/${encodeURIComponent(invoiceId)}`);
  const invData = await invResp.json();
  if (!invResp.ok || !invData.Invoice) {
    return json(request, { error: 'Invoice not found', detail: invData }, 404);
  }
  const invoice = invData.Invoice;

  const payment = {
    CustomerRef: invoice.CustomerRef,
    TotalAmt: Number(amount),
    ...(paymentDate ? { TxnDate: paymentDate } : {}),
    PrivateNote: 'Stripe PaymentIntent: ' + (stripePaymentIntentId || 'n/a'),
    Line: [
      {
        Amount: Number(amount),
        LinkedTxn: [{ TxnId: String(invoiceId), TxnType: 'Invoice' }]
      }
    ]
  };

  const payResp = await qboFetch(env, realmId, '/payment', {
    method: 'POST',
    body: JSON.stringify(payment)
  });
  const payData = await payResp.json();
  if (!payResp.ok) {
    return json(request, { error: 'Payment creation failed', detail: payData }, payResp.status);
  }

  return json(request, {
    ok: true,
    paymentId: payData.Payment && payData.Payment.Id,
    payment: payData.Payment
  });
}

async function handleHealth(request, env) {
  const [access, refresh, realmId] = await Promise.all([
    env.QBO_KV.get('qbo_access_token'),
    env.QBO_KV.get('qbo_refresh_token'),
    env.QBO_KV.get('qbo_realm_id')
  ]);
  return json(request, {
    ok: Boolean(access && refresh && realmId),
    access_token: access ? 'present' : 'missing',
    refresh_token: refresh ? 'present' : 'missing',
    realm_id: realmId ? 'present' : 'missing',
    client_id: env.QBO_CLIENT_ID ? 'present' : 'missing',
    client_secret: env.QBO_CLIENT_SECRET ? 'present' : 'missing'
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {
      if (url.pathname === '/health') {
        return await handleHealth(request, env);
      }

      // Every data path needs the realmId, read from shared KV.
      const realmId = await env.QBO_KV.get('qbo_realm_id');
      if (!realmId) {
        return json(request, { error: 'qbo_realm_id missing from KV — run the auth worker /connect flow' }, 503);
      }

      if (url.pathname === '/invoices' && request.method === 'GET') {
        return await handleInvoices(request, env, realmId);
      }
      if (url.pathname === '/payment' && request.method === 'POST') {
        return await handlePayment(request, env, realmId);
      }

      return json(request, { error: 'Not found' }, 404);
    } catch (err) {
      return json(request, { error: String(err && err.message || err) }, 500);
    }
  }
};
