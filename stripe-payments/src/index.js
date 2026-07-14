/**
 * Cloudflare Worker — Stripe payments + SendGrid emails + reCAPTCHA verify
 * stripe-payments.felipe-b80.workers.dev
 */

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const STRIPE_SK        = env.STRIPE_SK;
    const SENDGRID_KEY     = env.SENDGRID_KEY;
    const RECAPTCHA_SECRET = env.RECAPTCHA_SECRET;
    // Pinned Stripe API version for the Phase 2 SetupIntent/card endpoints only.
    // Existing invoice endpoints keep using the account default version, unchanged.
    const STRIPE_VERSION = '2024-06-20';

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    function json(data, status = 200) {
      return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ── VERIFY RECAPTCHA ───────────────────────────────────────────────────
    if (pathname === '/verify-recaptcha' && request.method === 'POST') {
      try {
        const { token } = await request.json();
        if (!token) return json({ success: false, error: 'Missing token' }, 400);
        const vRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token }).toString()
        });
        const vData = await vRes.json();
        return json({ success: !!vData.success, score: vData.score, action: vData.action, errors: vData['error-codes'] || [] });
      } catch(e) { return json({ success: false, error: e.message }, 500); }
    }

    // Helper: find or create Stripe Customer by email
    async function getOrCreateCustomer(email) {
      if (!email) return null;
      try {
        const res = await fetch('https://api.stripe.com/v1/customers?limit=100', {
          headers: { 'Authorization': `Bearer ${STRIPE_SK}` }
        });
        const data = await res.json();
        const existing = (data.data || []).find(c => c.email === email);
        if (existing) return existing.id;
        const createRes = await fetch('https://api.stripe.com/v1/customers', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${STRIPE_SK}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `email=${encodeURIComponent(email)}`
        });
        const c = await createRes.json();
        return c.id || null;
      } catch(e) { return null; }
    }

    // ── Phase 2 helpers: mode-aware key + Primus-id-keyed customer ─────────
    // Select the Stripe secret for the requested mode. 'live' -> existing
    // STRIPE_SK (untouched); anything else -> STRIPE_SK_TEST. Additive only.
    function skFor(mode) { return mode === 'live' ? STRIPE_SK : env.STRIPE_SK_TEST; }

    // Find-or-create a Stripe Customer keyed by metadata.primusCustomerId
    // (stable, unlike email). Uses customers/search — NOT the legacy first-100
    // email scan. Mode is implicit in `sk` (test/live are separate accounts).
    async function getCustomerByPrimus(sk, primusCustomerId, email) {
      if (!primusCustomerId) return null;
      const auth = { 'Authorization': `Bearer ${sk}`, 'Stripe-Version': STRIPE_VERSION };
      const q = encodeURIComponent(`metadata['primusCustomerId']:'${primusCustomerId}'`);
      const sr = await fetch(`https://api.stripe.com/v1/customers/search?query=${q}&limit=1`, { headers: auth });
      const sd = await sr.json();
      if (sd.data && sd.data[0]) return sd.data[0].id;
      const cr = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: email || '', 'metadata[primusCustomerId]': String(primusCustomerId) }).toString()
      });
      const c = await cr.json();
      if (c.error) throw new Error(c.error.message);
      return c.id || null;
    }

    // Read-only customer lookup by Primus id (does NOT create). Used by
    // /get-saved-cards so listing cards never mints an empty customer.
    async function findCustomerByPrimus(sk, primusCustomerId) {
      if (!primusCustomerId) return null;
      const q = encodeURIComponent(`metadata['primusCustomerId']:'${primusCustomerId}'`);
      const sr = await fetch(`https://api.stripe.com/v1/customers/search?query=${q}&limit=1`, {
        headers: { 'Authorization': `Bearer ${sk}`, 'Stripe-Version': STRIPE_VERSION }
      });
      const sd = await sr.json();
      return (sd.data && sd.data[0] && sd.data[0].id) || null;
    }

    // ── GET PAYMENT METHODS ────────────────────────────────────────────────
    if (pathname === '/get-payment-methods' && request.method === 'POST') {
      try {
        const { customerEmail } = await request.json();
        const customerId = await getOrCreateCustomer(customerEmail);
        if (!customerId) return json({ paymentMethods: [] });
        const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=us_bank_account`, {
          headers: { 'Authorization': `Bearer ${STRIPE_SK}` }
        });
        const pmData = await pmRes.json();
        const pms = pmData.data || [];
        if (pms.length > 0) {
          const pm = pms[0];
          return json({ paymentMethods: [{ id: pm.id, bankName: (pm.us_bank_account && pm.us_bank_account.bank_name) || 'Bank account', last4: (pm.us_bank_account && pm.us_bank_account.last4) || '', type: 'us_bank_account' }] });
        }
        return json({ paymentMethods: [] });
      } catch(e) { return json({ paymentMethods: [] }); }
    }

    // ── CREATE PAYMENT INTENT ──────────────────────────────────────────────
    if (pathname === '/create-payment-intent' && request.method === 'POST') {
      try {
        const { amount, paymentMethod, invoiceNums, customerEmail } = await request.json();
        const customerId = await getOrCreateCustomer(customerEmail);
        const amountCents = Math.round(amount * 100);

        const piParams = new URLSearchParams({
          amount: amountCents.toString(),
          currency: 'usd',
          confirm: 'false'
        });
        piParams.append('payment_method_types[]', paymentMethod === 'ach' ? 'us_bank_account' : 'card');
        if (customerId) piParams.append('customer', customerId);
        if (invoiceNums) piParams.append('description', 'Invoices: ' + invoiceNums);
        if (paymentMethod === 'ach') piParams.append('setup_future_usage', 'off_session');

        const piRes = await fetch('https://api.stripe.com/v1/payment_intents', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${STRIPE_SK}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: piParams.toString()
        });
        const piData = await piRes.json();
        if (piData.error) return json({ error: piData.error.message }, 400);
        return json({ clientSecret: piData.client_secret, customerId, paymentIntentId: piData.id });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── ATTACH PAYMENT METHOD ──────────────────────────────────────────────
    if (pathname === '/attach-payment-method' && request.method === 'POST') {
      try {
        const { paymentMethodId, customerEmail } = await request.json();
        if (!paymentMethodId || !customerEmail) return json({ error: 'Missing fields' }, 400);
        const customerId = await getOrCreateCustomer(customerEmail);
        if (!customerId) return json({ error: 'Could not create customer' }, 500);
        const attachRes = await fetch(`https://api.stripe.com/v1/payment_methods/${paymentMethodId}/attach`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${STRIPE_SK}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `customer=${encodeURIComponent(customerId)}`
        });
        const attachData = await attachRes.json();
        if (attachData.error && !attachData.error.message.includes('already been attached')) {
          return json({ error: attachData.error.message }, 400);
        }
        return json({ success: true, customerId, paymentMethodId });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── SEND CONFIRMATION ──────────────────────────────────────────────────
    if (pathname === '/send-confirmation' && request.method === 'POST') {
      try {
        const { customerEmail, invoices, total, paymentMethod, confirmationId, cardBrand, cardLast4 } = await request.json();
        if (!customerEmail) return json({ error: 'Missing customerEmail' }, 400);

        const invoiceRows = (invoices || []).map(inv =>
          '<tr style="border-bottom:1px solid #e5e2d9;">' +
          '<td style="padding:10px 12px;font-size:13px;color:#1a1a1a;">Invoice #' + inv.invNum + '</td>' +
          '<td style="padding:10px 12px;font-size:13px;color:#706c63;">' + (inv.consignee || 'N/A') + '</td>' +
          '<td style="padding:10px 12px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">$' + Number(inv.amount || 0).toFixed(2) + '</td>' +
          '</tr>'
        ).join('');

        const paymentDisplay = paymentMethod === 'card'
          ? (cardBrand || 'Card') + ' ending in ' + (cardLast4 || '----')
          : 'ACH Bank Transfer (settles in 2-5 business days)';

        const htmlEmail =
          '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;margin:0;padding:0;">' +
          '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;padding:20px;">' +
          '<tr><td style="border-bottom:2px solid #bd27bc;padding-bottom:16px;"><span style="font-size:20px;font-weight:700;color:#bd27bc;">Freight and Logistics, Inc.</span></td></tr>' +
          '<tr><td style="padding:24px 0;">' +
          '<p>Hi there,</p><p>Your payment has been received. Thank you for doing business with us!</p>' +
          '<p style="font-size:11px;font-weight:600;color:#706c63;text-transform:uppercase;letter-spacing:.05em;">Invoices Paid</p>' +
          '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' + invoiceRows + '</table><br>' +
          '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f8f5;border-radius:8px;">' +
          '<tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">Amount Paid</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">$' + Number(total || 0).toFixed(2) + '</td></tr>' +
          '<tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">Payment Method</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">' + paymentDisplay + '</td></tr>' +
          '<tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">Confirmation #</td><td style="padding:12px 14px;font-size:11px;font-family:monospace;color:#706c63;text-align:right;">' + (confirmationId || 'N/A') + '</td></tr>' +
          '</table><br>' +
          '<p style="font-size:13px;color:#706c63;">Questions? Email <a href="mailto:support@freightandlogistics.com" style="color:#bd27bc;">support@freightandlogistics.com</a> or call <a href="tel:+18006873713" style="color:#bd27bc;">(800) 687-3713</a>.</p>' +
          '</td></tr>' +
          '<tr><td style="border-top:1px solid #e5e2d9;padding-top:16px;font-size:12px;color:#706c63;"><p style="margin:0;">Freight and Logistics, Inc. | Nationwide 3PL Freight Brokerage</p></td></tr>' +
          '</table></body></html>';

        const sendRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: customerEmail }], subject: 'Payment Confirmation — Freight and Logistics, Inc.' }],
            from: { email: 'support@freightandlogistics.com', name: 'Freight and Logistics' },
            content: [{ type: 'text/html', value: htmlEmail }]
          })
        });
        if (sendRes.status !== 202) return json({ error: 'Failed to send email' }, 500);
        return json({ success: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── CREATE SETUP INTENT (Phase 2: save a card on file) ─────────────────
    if (pathname === '/create-setup-intent' && request.method === 'POST') {
      try {
        const { mode, primusCustomerId, email } = await request.json();
        const sk = skFor(mode);
        if (!sk) return json({ error: 'Stripe key not configured for mode: ' + mode }, 500);
        if (!primusCustomerId) return json({ error: 'Missing primusCustomerId' }, 400);
        const customerId = await getCustomerByPrimus(sk, primusCustomerId, email);
        if (!customerId) return json({ error: 'Could not resolve customer' }, 500);
        const siParams = new URLSearchParams({ customer: customerId, usage: 'off_session' });
        siParams.append('payment_method_types[]', 'card');
        const siRes = await fetch('https://api.stripe.com/v1/setup_intents', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${sk}`, 'Stripe-Version': STRIPE_VERSION, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: siParams.toString()
        });
        const siData = await siRes.json();
        if (siData.error) return json({ error: siData.error.message }, 400);
        return json({ clientSecret: siData.client_secret, customerId });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── GET SAVED CARDS (Phase 2) ──────────────────────────────────────────
    if (pathname === '/get-saved-cards' && request.method === 'POST') {
      try {
        const { mode, primusCustomerId } = await request.json();
        const sk = skFor(mode);
        if (!sk) return json({ error: 'Stripe key not configured for mode: ' + mode }, 500);
        const customerId = await findCustomerByPrimus(sk, primusCustomerId);
        if (!customerId) return json({ cards: [] });
        const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=card`, {
          headers: { 'Authorization': `Bearer ${sk}`, 'Stripe-Version': STRIPE_VERSION }
        });
        const pmData = await pmRes.json();
        const cards = (pmData.data || []).map(pm => ({
          id: pm.id,
          brand: pm.card && pm.card.brand,
          last4: pm.card && pm.card.last4,
          exp_month: pm.card && pm.card.exp_month,
          exp_year: pm.card && pm.card.exp_year
        }));
        return json({ cards, customerId });
      } catch(e) { return json({ error: e.message, cards: [] }, 500); }
    }

    // ── 404 ───────────────────────────────────────────────────────────────
    return json({ error: 'Not found' }, 404);
  }
};