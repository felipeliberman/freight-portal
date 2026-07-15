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
    // KV mapping key. Mode-namespaced so test/live customer ids never collide.
    function custKvKey(mode, primusCustomerId) { return `stripecust:${mode}:${primusCustomerId}`; }

    async function getCustomerByPrimus(sk, mode, primusCustomerId, email) {
      if (!primusCustomerId) return null;
      const kvKey = custKvKey(mode, primusCustomerId);
      // 1) KV cache — strongly consistent, fixes read-after-write + dup-on-repeat.
      if (env.STRIPE_KV) {
        const cached = await env.STRIPE_KV.get(kvKey);
        if (cached) return cached;
      }
      const auth = { 'Authorization': `Bearer ${sk}`, 'Stripe-Version': STRIPE_VERSION };
      // 2) Stripe search — eventually consistent; a backstop when KV is cold.
      const q = encodeURIComponent(`metadata['primusCustomerId']:'${primusCustomerId}'`);
      const sr = await fetch(`https://api.stripe.com/v1/customers/search?query=${q}&limit=1`, { headers: auth });
      const sd = await sr.json();
      let customerId = sd.data && sd.data[0] && sd.data[0].id;
      // 3) create.
      if (!customerId) {
        const cr = await fetch('https://api.stripe.com/v1/customers', {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ email: email || '', 'metadata[primusCustomerId]': String(primusCustomerId) }).toString()
        });
        const c = await cr.json();
        if (c.error) throw new Error(c.error.message);
        customerId = c.id || null;
      }
      // Write KV immediately so the very next call is consistent.
      if (customerId && env.STRIPE_KV) { try { await env.STRIPE_KV.put(kvKey, customerId); } catch(e) {} }
      return customerId;
    }

    // Read-only customer lookup by Primus id (does NOT create). Used by
    // /get-saved-cards so listing cards never mints an empty customer.
    async function findCustomerByPrimus(sk, mode, primusCustomerId) {
      if (!primusCustomerId) return null;
      const kvKey = custKvKey(mode, primusCustomerId);
      if (env.STRIPE_KV) {
        const cached = await env.STRIPE_KV.get(kvKey);
        if (cached) return cached;
      }
      const q = encodeURIComponent(`metadata['primusCustomerId']:'${primusCustomerId}'`);
      const sr = await fetch(`https://api.stripe.com/v1/customers/search?query=${q}&limit=1`, {
        headers: { 'Authorization': `Bearer ${sk}`, 'Stripe-Version': STRIPE_VERSION }
      });
      const sd = await sr.json();
      const customerId = (sd.data && sd.data[0] && sd.data[0].id) || null;
      if (customerId && env.STRIPE_KV) { try { await env.STRIPE_KV.put(kvKey, customerId); } catch(e) {} }
      return customerId;
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
        const payload = await request.json();
        const { customerEmail } = payload;
        if (!customerEmail) return json({ error: 'Missing customerEmail' }, 400);

        // Phase 3 (#2): dispatch-charge receipt. Separate template + subject from the invoice
        // flow. Invoice callers send no `type`, so they fall through to the existing path below
        // UNCHANGED. Additive — no shared mutable state. Amount arrives in cents.
        if (payload.type === 'dispatch') {
          const amt = (Number(payload.amount || 0) / 100).toFixed(2);
          const cardTxt = (payload.cardBrand ? payload.cardBrand.charAt(0).toUpperCase() + payload.cardBrand.slice(1) : 'Card') + ' ending in ' + (payload.cardLast4 || '----');
          const dateTxt = payload.date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
          const bol = payload.bolNumber || '';
          const dispatchHtml =
            '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;margin:0;padding:0;">' +
            '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;padding:20px;">' +
            '<tr><td style="border-bottom:2px solid #bd27bc;padding-bottom:16px;"><span style="font-size:20px;font-weight:700;color:#bd27bc;">Freight and Logistics, Inc.</span></td></tr>' +
            '<tr><td style="padding:24px 0;">' +
            '<p>Hi there,</p><p>BOL <strong>' + bol + '</strong> has been dispatched and your card on file was charged.</p>' +
            '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f8f5;border-radius:8px;">' +
            '<tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">Amount charged</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">$' + amt + '</td></tr>' +
            '<tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">Card</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">' + cardTxt + '</td></tr>' +
            '<tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">BOL</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">' + bol + '</td></tr>' +
            '<tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">Date</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">' + dateTxt + '</td></tr>' +
            '</table><br>' +
            '<p style="font-size:13px;color:#706c63;">Questions? Email <a href="mailto:support@freightandlogistics.ai" style="color:#bd27bc;">support@freightandlogistics.ai</a> or call <a href="tel:+18006873713" style="color:#bd27bc;">(800) 687-3713</a>.</p>' +
            '</td></tr>' +
            '<tr><td style="border-top:1px solid #e5e2d9;padding-top:16px;font-size:12px;color:#706c63;"><p style="margin:0;">Freight and Logistics, Inc. | Nationwide 3PL Freight Brokerage</p></td></tr>' +
            '</table></body></html>';
          const dispatchRes = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: customerEmail }], subject: 'Dispatch charge receipt — BOL ' + bol }],
              from: { email: 'support@freightandlogistics.com', name: 'Freight and Logistics' },
              content: [{ type: 'text/html', value: dispatchHtml }]
            })
          });
          if (dispatchRes.status !== 202) return json({ error: 'Failed to send email' }, 500);
          return json({ success: true });
        }

        const { invoices, total, paymentMethod, confirmationId, cardBrand, cardLast4 } = payload;
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

    // ── SUBMIT CREDIT APPLICATION (public /apply page) ─────────────────────
    // Verifies reCAPTCHA, captures the server-side e-signature audit trail
    // (IP / user-agent / ISO timestamp / doc version), and emails the signed
    // agreement PDF (generated client-side, passed as base64) to us AND to the
    // signer via SendGrid attachments. Additive — no shared state with other
    // endpoints. Sender stays support@freightandlogistics.com (verified sender;
    // intentionally .com for this legal document — do not change to .ai).
    if (pathname === '/submit-application' && request.method === 'POST') {
      try {
        const body = await request.json();
        const { record, pdfBase64, filename, signerEmail, recaptchaToken } = body || {};
        if (!record || !pdfBase64) return json({ error: 'Missing application data' }, 400);

        // reCAPTCHA v3 verification (reuses existing RECAPTCHA_SECRET).
        if (RECAPTCHA_SECRET) {
          if (!recaptchaToken) return json({ error: 'Verification failed' }, 400);
          const vRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret: RECAPTCHA_SECRET, response: recaptchaToken }).toString()
          });
          const vData = await vRes.json();
          if (!vData.success || (typeof vData.score === 'number' && vData.score < 0.3)) {
            return json({ error: 'Verification failed' }, 400);
          }
        }

        // Server-side e-signature audit trail.
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const ua = request.headers.get('User-Agent') || 'unknown';
        const serverTs = new Date().toISOString();
        const docVersion = (record.docVersion || 'credit-app-v1');

        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const c = record.company || {};
        const phys = c.physical || {};
        const sig = record.signature || {};
        const acks = record.acknowledgments || [];
        const refs = record.references || [];
        const consents = record.consents || {};

        const rowsHtml =
          [
            ['Legal Entity Name', c.legalName],
            ['DBA / Trade Name', c.dba],
            ['Physical Address', [phys.street, [phys.city, phys.state, phys.zip].filter(Boolean).join(', ')].filter(Boolean).join(', ')],
            ['Mailing Address', c.mailingSameAsPhysical ? 'Same as physical' : (c.mailing ? [c.mailing.street, [c.mailing.city, c.mailing.state, c.mailing.zip].filter(Boolean).join(', ')].filter(Boolean).join(', ') : '—')],
            ['Company Phone', c.phone],
            ['Taxpayer ID / EIN', c.ein],
            ['Date Business Began', c.businessBegan],
            ['Gross Annual Sales', c.grossAnnualSales],
            ['Entity Type', c.entityType],
            ['Preferred Payment', c.paymentMethod],
            ['AP Contact', record.apContact ? (record.apContact.name + ' · ' + record.apContact.phone + ' · ' + record.apContact.email) : '—'],
            ['Shipping Contact', record.shipContact ? (record.shipContact.name + ' · ' + record.shipContact.phone + ' · ' + record.shipContact.email) : '—'],
          ].map(([k, v]) =>
            '<tr><td style="padding:7px 10px;font-size:12px;color:#706c63;border-bottom:1px solid #e5e2d9;">' + esc(k) + '</td>' +
            '<td style="padding:7px 10px;font-size:12px;color:#1a1a1a;font-weight:600;border-bottom:1px solid #e5e2d9;">' + esc(v || '—') + '</td></tr>'
          ).join('');

        const refsHtml = refs.map((r, i) =>
          '<tr><td style="padding:7px 10px;font-size:12px;color:#706c63;border-bottom:1px solid #e5e2d9;">Reference ' + (i + 1) + '</td>' +
          '<td style="padding:7px 10px;font-size:12px;color:#1a1a1a;border-bottom:1px solid #e5e2d9;">' +
          esc([r.company, r.contact, r.phone, r.fax, r.email].filter(Boolean).join(' · ')) + '</td></tr>'
        ).join('');

        const acksHtml = acks.map((a, i) =>
          '<tr><td style="padding:7px 10px;font-size:12px;color:#706c63;border-bottom:1px solid #e5e2d9;">Acknowledgment ' + (i + 1) + '</td>' +
          '<td style="padding:7px 10px;font-size:12px;color:#1a1a1a;border-bottom:1px solid #e5e2d9;">' +
          esc(a.title) + ' — initialed <strong>' + esc(a.initials || '—') + '</strong>, agreed: ' + (a.agreed ? 'YES' : 'NO') + '</td></tr>'
        ).join('');

        const auditHtml =
          '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f8f5;border-radius:8px;margin-top:6px;">' +
          '<tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">Signer</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;font-weight:600;text-align:right;">' + esc(sig.printedName) + ', ' + esc(sig.title) + '</td></tr>' +
          '<tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">Signature method</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + esc(sig.method === 'draw' ? 'Drawn' : 'Typed') + '</td></tr>' +
          '<tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">T&amp;C consent</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + (consents.termsAndConditions ? 'AGREED' : 'NOT AGREED') + '</td></tr>' +
          '<tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">E-signature consent</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + (consents.electronicSignature ? 'AGREED' : 'NOT AGREED') + '</td></tr>' +
          '<tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">IP address</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + esc(ip) + '</td></tr>' +
          '<tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">Server timestamp</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + esc(serverTs) + '</td></tr>' +
          '<tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">Document version</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + esc(docVersion) + '</td></tr>' +
          '<tr><td style="padding:7px 12px;font-size:11px;color:#706c63;">User agent</td><td style="padding:7px 12px;font-size:10px;color:#706c63;text-align:right;">' + esc(ua) + '</td></tr>' +
          '</table>';

        const header =
          '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;margin:0;padding:0;">' +
          '<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;padding:20px;">' +
          '<tr><td style="border-bottom:2px solid #bd27bc;padding-bottom:16px;"><span style="font-size:20px;font-weight:700;color:#bd27bc;">Freight and Logistics, Inc.</span></td></tr>';
        const footer =
          '<tr><td style="border-top:1px solid #e5e2d9;padding-top:16px;font-size:12px;color:#706c63;"><p style="margin:0;">Freight and Logistics, Inc. | Nationwide 3PL Freight Brokerage</p></td></tr>' +
          '</table></body></html>';

        const internalHtml = header +
          '<tr><td style="padding:20px 0 6px;"><p style="margin:0 0 12px;font-size:15px;font-weight:600;">New Credit Application — ' + esc(c.legalName || 'Applicant') + '</p>' +
          '<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' + rowsHtml + refsHtml + acksHtml + '</table>' +
          '<p style="margin:18px 0 4px;font-size:11px;font-weight:700;color:#706c63;text-transform:uppercase;letter-spacing:.05em;">Electronic Signature Audit Record</p>' + auditHtml +
          '<p style="font-size:12px;color:#706c63;margin-top:14px;">The signed agreement PDF is attached.</p></td></tr>' + footer;

        const signerHtml = header +
          '<tr><td style="padding:20px 0 6px;"><p style="margin:0 0 10px;">Hi ' + esc(sig.printedName || 'there') + ',</p>' +
          '<p style="margin:0 0 12px;">Thank you for submitting your Credit Application &amp; Purchase Agreement to Freight and Logistics, Inc. A copy of your signed agreement is attached to this email for your records.</p>' +
          '<p style="margin:0 0 12px;font-size:13px;color:#706c63;">Our onboarding team will review your application and reach out within one business day.</p>' +
          '<p style="margin:14px 0 4px;font-size:11px;font-weight:700;color:#706c63;text-transform:uppercase;letter-spacing:.05em;">Your Electronic Signature</p>' + auditHtml +
          '<p style="font-size:13px;color:#706c63;margin-top:16px;">Questions? Email <a href="mailto:support@freightandlogistics.com" style="color:#bd27bc;">support@freightandlogistics.com</a> or call <a href="tel:+18006873713" style="color:#bd27bc;">(800) 687-3713</a>.</p></td></tr>' + footer;

        const attachments = [{
          content: pdfBase64,
          filename: (filename && /\.pdf$/i.test(filename)) ? filename : 'Credit-Application.pdf',
          type: 'application/pdf',
          disposition: 'attachment'
        }];

        // Isolated deliveries: the internal (audit) email and the signer copy are sent
        // as separate SendGrid calls so recipients never see each other's address and
        // each gets its own content body.
        const sendOne = (persons, html) => fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${SENDGRID_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            personalizations: persons,
            from: { email: 'support@freightandlogistics.com', name: 'Freight and Logistics' },
            content: [{ type: 'text/html', value: html }],
            attachments
          })
        });

        const internalRes = await sendOne(
          [{ to: [{ email: 'support@freightandlogistics.com' }], subject: 'New Credit Application — ' + (c.legalName || 'Applicant') }],
          internalHtml
        );
        if (internalRes.status !== 202) return json({ error: 'Failed to send application' }, 500);

        if (signerEmail) {
          // Best-effort copy to the signer; don't fail the whole submit if this bounces.
          try {
            await sendOne(
              [{ to: [{ email: signerEmail }], subject: 'Your Signed Credit Application — Freight and Logistics, Inc.' }],
              signerHtml
            );
          } catch (e) { /* ignore signer-copy failure */ }
        }

        return json({ success: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // ── CREATE SETUP INTENT (Phase 2: save a card on file) ─────────────────
    if (pathname === '/create-setup-intent' && request.method === 'POST') {
      try {
        const { mode, primusCustomerId, email } = await request.json();
        const smode = mode === 'live' ? 'live' : 'test';
        const sk = skFor(smode);
        if (!sk) return json({ error: 'Stripe key not configured for mode: ' + mode }, 500);
        if (!primusCustomerId) return json({ error: 'Missing primusCustomerId' }, 400);
        const customerId = await getCustomerByPrimus(sk, smode, primusCustomerId, email);
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
        const smode = mode === 'live' ? 'live' : 'test';
        const sk = skFor(smode);
        if (!sk) return json({ error: 'Stripe key not configured for mode: ' + mode }, 500);
        const customerId = await findCustomerByPrimus(sk, smode, primusCustomerId);
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

    // ── CHARGE SAVED CARD (Phase 3: off-session dispatch charge for PRE) ────
    // Charge + capture the saved card immediately at dispatch. BOL number stamped
    // as metadata for manual invoice matching. Idempotency-keyed on the BOL so a
    // re-dispatch never double-charges. Additive — no existing endpoint touched.
    if (pathname === '/charge-saved-card' && request.method === 'POST') {
      try {
        const { mode, primusCustomerId, amount, bolNumber, idempotencyKey } = await request.json();
        const smode = mode === 'live' ? 'live' : 'test';
        const sk = skFor(smode);
        if (!sk) return json({ ok:false, code:'config', error:'Stripe key not configured for mode: ' + mode }, 500);
        if (!primusCustomerId) return json({ ok:false, code:'bad_request', error:'Missing primusCustomerId' }, 400);
        const cents = Math.round(Number(amount) * 100);
        if (!cents || cents < 50) return json({ ok:false, code:'bad_amount', error:'Invalid amount' }, 400);

        const auth = { 'Authorization': `Bearer ${sk}`, 'Stripe-Version': STRIPE_VERSION };
        const customerId = await findCustomerByPrimus(sk, smode, primusCustomerId);
        if (!customerId) return json({ ok:false, code:'no_customer', error:'No Stripe customer on file for this account' }, 200);

        // Most-recently-saved card on the customer.
        const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=card&limit=1`, { headers: auth });
        const pmData = await pmRes.json();
        const pm = pmData.data && pmData.data[0];
        if (!pm) return json({ ok:false, code:'no_card', error:'No card on file' }, 200);

        const piParams = new URLSearchParams({
          amount: String(cents), currency: 'usd', customer: customerId, payment_method: pm.id,
          off_session: 'true', confirm: 'true', capture_method: 'automatic',
          description: 'Dispatch charge — BOL ' + (bolNumber || '')
        });
        if (bolNumber) piParams.append('metadata[bolNumber]', String(bolNumber));
        piParams.append('metadata[primusCustomerId]', String(primusCustomerId));

        const piHeaders = { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' };
        if (idempotencyKey) piHeaders['Idempotency-Key'] = String(idempotencyKey);
        const piRes = await fetch('https://api.stripe.com/v1/payment_intents', { method: 'POST', headers: piHeaders, body: piParams.toString() });
        const pi = await piRes.json();

        if (pi.error) {
          // Off-session declines and SCA (authentication_required) come back as an error.
          const code = pi.error.code === 'authentication_required'
            ? 'authentication_required'
            : (pi.error.decline_code || pi.error.code || 'card_declined');
          return json({ ok:false, code, error: pi.error.message, paymentIntentId: pi.error.payment_intent && pi.error.payment_intent.id }, 200);
        }
        if (pi.status !== 'succeeded') {
          return json({ ok:false, code: pi.status, error: 'Charge not completed (' + pi.status + ')', paymentIntentId: pi.id }, 200);
        }
        return json({ ok:true, paymentIntentId: pi.id, status: pi.status, amount: cents, brand: pm.card && pm.card.brand, last4: pm.card && pm.card.last4 });
      } catch(e) { return json({ ok:false, code:'exception', error: e.message }, 500); }
    }

    // ── 404 ───────────────────────────────────────────────────────────────
    return json({ error: 'Not found' }, 404);
  }
};