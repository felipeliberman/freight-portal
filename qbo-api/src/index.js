// qbo-api — QuickBooks Online invoice + payment operations.
// Shares KV (tokens + realmId) with the qbo-auth worker.

const QBO_API_ROOT = 'https://quickbooks.api.intuit.com/v3/company';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const MINOR_VERSION = '73';

// Cap how many customer matches a LIKE lookup returns to the caller.
const MAX_CUSTOMER_MATCHES = 25;

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

async function handleInvoices(request, env, realmId) {
  const url = new URL(request.url);
  const email = url.searchParams.get('email');
  const name = url.searchParams.get('name');
  if (!email && !name) {
    return json(request, { error: 'Provide an email or name query parameter' }, 400);
  }

  const customerQuery = email
    ? `select * from Customer where PrimaryEmailAddr LIKE '%${q(email)}%'`
    : `select * from Customer where DisplayName LIKE '%${q(name)}%'`;

  const customers = (await queryQBO(env, realmId, customerQuery)).Customer || [];
  if (customers.length === 0) {
    return json(request, { customer: null, invoices: [], message: 'No matching customer' }, 404);
  }

  // A LIKE search can match several customers. Rather than silently pick one,
  // return the list so the caller can disambiguate and re-query a specific name.
  if (customers.length > 1) {
    const matched = customers.length;
    const shown = customers.slice(0, MAX_CUSTOMER_MATCHES);
    const message = shown.length < matched
      ? `Showing ${shown.length} of ${matched} matching customers — refine the query`
      : `${matched} customers matched — refine the query`;
    return json(request, {
      multiple: true,
      matched,
      showing: shown.length,
      customers: shown.map((c) => ({
        Id: c.Id,
        DisplayName: c.DisplayName,
        EmailAddr: (c.PrimaryEmailAddr && c.PrimaryEmailAddr.Address) || null
      })),
      invoices: [],
      message
    }, 300);
  }

  const customer = customers[0];
  const invoiceRows =
    (await queryQBO(env, realmId, `select * from Invoice where CustomerRef = '${q(customer.Id)}'`)).Invoice || [];

  // "Open" = still has an outstanding balance.
  const openInvoices = invoiceRows
    .filter((inv) => Number(inv.Balance) > 0)
    .map(shapeInvoice);

  return json(request, {
    customer: { Id: customer.Id, DisplayName: customer.DisplayName },
    invoices: openInvoices
  });
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
