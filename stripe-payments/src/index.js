export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const STRIPE_SK = env.STRIPE_SK;
    const SENDGRID_KEY = env.SENDGRID_KEY;
    const RECAPTCHA_SECRET = env.RECAPTCHA_SECRET;
    const STRIPE_VERSION = "2024-06-20";
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    function json(data, status = 200) {
      return new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
    }
    const EMAIL_ALLOWED_ORIGINS = ["https://freightandlogistics.ai", "https://www.freightandlogistics.ai"];
    async function emailGuard(request2) {
      const origin = request2.headers.get("Origin") || "";
      if (!EMAIL_ALLOWED_ORIGINS.includes(origin)) return json({ error: "Forbidden" }, 403);
      const ip = request2.headers.get("CF-Connecting-IP") || "unknown";
      if (env.STRIPE_KV) {
        try {
          const rk = "rl:email:" + ip;
          const prior = parseInt(await env.STRIPE_KV.get(rk) || "0", 10) || 0;
          if (prior >= 30) return json({ error: "Too many requests. Please try again later or call (800) 687-3713." }, 429);
          await env.STRIPE_KV.put(rk, String(prior + 1), { expirationTtl: 3600 });
        } catch (e) {}
      }
      return null;
    }
    if (pathname === "/verify-recaptcha" && request.method === "POST") {
      try {
        const { token } = await request.json();
        if (!token) return json({ success: false, error: "Missing token" }, 400);
        const vRes = await fetch("https://www.google.com/recaptcha/api/siteverify", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token }).toString()
        });
        const vData = await vRes.json();
        return json({ success: !!vData.success, score: vData.score, action: vData.action, errors: vData["error-codes"] || [] });
      } catch (e) {
        return json({ success: false, error: e.message }, 500);
      }
    }
    // Identity for the invoice-payment path. Resolves ONCE, deterministically, and fails CLOSED.
    // This used to list the 100 newest customers and match the email in JS: past 100 customers the
    // match silently missed, so it minted a same-email DUPLICATE and returned a different customer
    // on every call. /get-payment-methods then listed a bank PaymentMethod off one customer while
    // /create-payment-intent built the PaymentIntent on another, and Stripe rejected the confirm
    // with "The provided PaymentMethod cannot be attached." The `catch -> return null` compounded
    // it: any API failure produced a customer-less PaymentIntent instead of an error. Stripe
    // filters by email server-side, so ?email= is exact and unaffected by how many customers exist.
    async function getOrCreateCustomer(email) {
      if (!email) throw new Error("Cannot resolve a Stripe customer without an email");
      const auth = { "Authorization": `Bearer ${STRIPE_SK}` };
      const res = await fetch(`https://api.stripe.com/v1/customers?email=${encodeURIComponent(email)}&limit=1`, { headers: auth });
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const existing = data.data && data.data[0];
      if (existing && existing.id) return existing.id;
      const createRes = await fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: `email=${encodeURIComponent(email)}`
      });
      const c = await createRes.json();
      if (c.error) throw new Error(c.error.message);
      if (!c.id) throw new Error("Stripe did not return a customer id");
      return c.id;
    }
    function skFor(mode) {
      return mode === "live" ? STRIPE_SK : env.STRIPE_SK_TEST;
    }
    // ── ACH settlement plumbing ────────────────────────────────────────────────
    //
    // An ACH debit settles 2-5 business days after it is submitted, so the browser cannot record it
    // to QuickBooks — it is long gone. The settled-payment ledger write therefore happens HERE, from
    // the payment_intent.succeeded webhook, and it needs to know which QBO invoices the money covers.
    //
    // That mapping is written into PaymentIntent metadata at creation. It is NOT parsed back out of
    // the human-readable `description` ("Invoices: 141590, 141617, ..."): DocNumbers are not QBO ids,
    // the string is display copy that nobody guarantees the shape of, and guessing wrong here posts a
    // payment against the wrong invoice. Metadata is the contract; description stays cosmetic.
    //
    // Format: "qboId:docNum:amount" triples, comma-joined, split across fl_inv_0..N because a Stripe
    // metadata VALUE caps at 500 chars. fl_inv_n holds the chunk count so a missing chunk is
    // detectable — a short list would silently under-post, which is the failure this whole change
    // exists to prevent.
    const FL_META_VERSION = "1";
    const META_MAX_VALUE = 500;
    const META_MAX_CHUNKS = 10;
    function packQboInvoices(rows) {
      const toks = rows.map((r) => `${r.qboId}:${r.docNum}:${Number(r.amount).toFixed(2)}`);
      const chunks = [];
      let cur = "";
      for (const t of toks) {
        if (t.length > META_MAX_VALUE) throw new Error("Invoice reference too long to record: " + t);
        if (cur && cur.length + 1 + t.length > META_MAX_VALUE) { chunks.push(cur); cur = t; }
        else cur = cur ? cur + "," + t : t;
      }
      if (cur) chunks.push(cur);
      // Refuse rather than truncate. A truncated list means invoices that are charged and never
      // posted — silently, and only discoverable weeks later in a reconciliation.
      if (chunks.length > META_MAX_CHUNKS) throw new Error(`Too many invoices to record on one payment (${rows.length}); pay them in smaller batches.`);
      return chunks;
    }
    function unpackQboInvoices(md) {
      const n = parseInt((md && md.fl_inv_n) || "0", 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      let s = "";
      for (let i = 0; i < n; i++) {
        const c = md["fl_inv_" + i];
        if (c == null) return null; // missing chunk -> refuse the whole set
        s += (s ? "," : "") + c;
      }
      const rows = [];
      for (const t of s.split(",")) {
        const p = t.split(":");
        if (p.length !== 3) return null;
        const amount = Number(p[2]);
        if (!p[0] || !Number.isFinite(amount) || amount <= 0) return null;
        rows.push({ qboId: p[0], docNum: p[1], amount });
      }
      return rows.length ? rows : null;
    }
    // Stripe webhook signature. The raw request text MUST be hashed — parsing to JSON and
    // re-stringifying reorders/reformats bytes and the HMAC will never match.
    async function verifyStripeSignature(rawBody, sigHeader, secret, nowSec, toleranceSec = 300) {
      if (!secret) return { ok: false, reason: "no signing secret configured" };
      if (!sigHeader) return { ok: false, reason: "missing Stripe-Signature header" };
      const parts = /* @__PURE__ */ Object.create(null);
      const v1 = [];
      for (const kv of sigHeader.split(",")) {
        const i = kv.indexOf("=");
        if (i < 0) continue;
        const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
        if (k === "v1") v1.push(v); else parts[k] = v;
      }
      const t = parseInt(parts.t, 10);
      if (!Number.isFinite(t)) return { ok: false, reason: "no timestamp in signature" };
      // Rejects replays of a genuinely-signed old event in both directions.
      if (Math.abs(nowSec - t) > toleranceSec) return { ok: false, reason: "timestamp outside tolerance" };
      if (!v1.length) return { ok: false, reason: "no v1 signature" };
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`));
      const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
      for (const cand of v1) {
        if (typeof cand === "string" && cand.length === expected.length) {
          let d = 0;
          for (let i = 0; i < expected.length; i++) d |= cand.charCodeAt(i) ^ expected.charCodeAt(i);
          if (d === 0) return { ok: true };
        }
      }
      return { ok: false, reason: "signature mismatch" };
    }
    const FL_FROM = { email: "support@freightandlogistics.ai", name: "Freight and Logistics" };
    async function sendGrid(personalizations, html) {
      const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${SENDGRID_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ personalizations, from: FL_FROM, content: [{ type: "text/html", value: html }] })
      });
      return r.status === 202;
    }
    // Internal alert channel for money that needs a human. Deliberately separate from customer copy.
    async function alertAccounting(subject, bodyHtml) {
      try {
        const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;padding:20px;"><tr><td style="border-bottom:2px solid #bd27bc;padding-bottom:12px;"><span style="font-size:16px;font-weight:700;color:#bd27bc;">FreightAI &mdash; automated alert</span></td></tr><tr><td style="padding:20px 0;">' + bodyHtml + '</td></tr></table></body></html>';
        return await sendGrid([{ to: [{ email: "accounting@freightandlogistics.ai" }], subject }], html);
      } catch (e) {
        return false;
      }
    }
    // ONE builder for the invoice-payment email, so the browser path (/send-confirmation) and the
    // settlement path (the webhook) can never drift into telling a customer two different stories
    // about the same payment.
    function buildInvoiceEmailHtml(o) {
      const achInitiated = !!o.achInitiated;
      const invoiceRows = (o.invoices || []).map(
        (inv) => '<tr style="border-bottom:1px solid #e5e2d9;"><td style="padding:10px 12px;font-size:13px;color:#1a1a1a;">Invoice #' + inv.invNum + '</td><td style="padding:10px 12px;font-size:13px;color:#706c63;">' + (inv.consignee || "") + '</td><td style="padding:10px 12px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">$' + Number(inv.amount || 0).toFixed(2) + "</td></tr>"
      ).join("");
      const paymentDisplay = o.paymentMethod === "card" ? (o.cardBrand || "Card") + " ending in " + (o.cardLast4 || "----") : (achInitiated ? "ACH Bank Transfer (settles in 2-5 business days)" : "ACH Bank Transfer");
      const intro = achInitiated
        ? '<p>Your payment has been submitted. Your bank transfer is on its way and typically settles within 2-5 business days.</p><p style="font-size:13px;color:#706c63;">This is a confirmation that we received your payment instruction &mdash; not a receipt of payment. The invoices below stay open until the transfer settles, and we will let you know if anything goes wrong with it.</p>'
        : '<p>Your payment has been received. Thank you for doing business with us!</p>';
      const listLabel = achInitiated ? "Invoices Submitted for Payment" : "Invoices Paid";
      const amountLabel = achInitiated ? "Amount Submitted" : "Amount Paid";
      return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;margin:0;padding:0;"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;padding:20px;"><tr><td style="border-bottom:2px solid #bd27bc;padding-bottom:16px;"><span style="font-size:20px;font-weight:700;color:#bd27bc;">Freight and Logistics, Inc.</span></td></tr><tr><td style="padding:24px 0;"><p>Hi there,</p>' + intro + '<p style="font-size:11px;font-weight:600;color:#706c63;text-transform:uppercase;letter-spacing:.05em;">' + listLabel + '</p><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' + invoiceRows + '</table><br><table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f8f5;border-radius:8px;"><tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">' + amountLabel + '</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">$' + Number(o.total || 0).toFixed(2) + '</td></tr><tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">Payment Method</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">' + paymentDisplay + '</td></tr><tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">Confirmation #</td><td style="padding:12px 14px;font-size:11px;font-family:monospace;color:#706c63;text-align:right;">' + (o.confirmationId || "N/A") + '</td></tr></table><br><p style="font-size:13px;color:#706c63;">Questions? Email <a href="mailto:support@freightandlogistics.ai" style="color:#bd27bc;">support@freightandlogistics.ai</a> or call <a href="tel:+18006873713" style="color:#bd27bc;">(800) 687-3713</a>.</p></td></tr><tr><td style="border-top:1px solid #e5e5e5;padding-top:16px;font-size:12px;line-height:1.6;color:#8a8a8a;"><div style="font-weight:600;color:#6b6b6b;">Freight and Logistics, Inc. &middot; Nationwide 3PL Freight Brokerage</div><div style="margin-top:2px;"><a href="mailto:support@freightandlogistics.ai" style="color:#bd27bc;text-decoration:none;">support@freightandlogistics.ai</a> &middot; (800) 687-3713 &middot; <a href="https://www.freightandlogistics.ai" style="color:#bd27bc;text-decoration:none;">freightandlogistics.ai</a></div></td></tr></table></body></html>';
    }
    function custKvKey(mode, primusCustomerId) {
      return `stripecust:${mode}:${primusCustomerId}`;
    }
    async function getCustomerByPrimus(sk, mode, primusCustomerId, email) {
      if (!primusCustomerId) return null;
      const kvKey = custKvKey(mode, primusCustomerId);
      if (env.STRIPE_KV) {
        const cached = await env.STRIPE_KV.get(kvKey);
        if (cached) return cached;
      }
      const auth = { "Authorization": `Bearer ${sk}`, "Stripe-Version": STRIPE_VERSION };
      const q = encodeURIComponent(`metadata['primusCustomerId']:'${primusCustomerId}'`);
      const sr = await fetch(`https://api.stripe.com/v1/customers/search?query=${q}&limit=1`, { headers: auth });
      const sd = await sr.json();
      let customerId = sd.data && sd.data[0] && sd.data[0].id;
      if (!customerId) {
        const cr = await fetch("https://api.stripe.com/v1/customers", {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ email: email || "", "metadata[primusCustomerId]": String(primusCustomerId) }).toString()
        });
        const c = await cr.json();
        if (c.error) throw new Error(c.error.message);
        customerId = c.id || null;
      }
      if (customerId && env.STRIPE_KV) {
        try {
          await env.STRIPE_KV.put(kvKey, customerId);
        } catch (e) {
        }
      }
      return customerId;
    }
    async function findCustomerByPrimus(sk, mode, primusCustomerId) {
      if (!primusCustomerId) return null;
      const kvKey = custKvKey(mode, primusCustomerId);
      if (env.STRIPE_KV) {
        const cached = await env.STRIPE_KV.get(kvKey);
        if (cached) return cached;
      }
      const q = encodeURIComponent(`metadata['primusCustomerId']:'${primusCustomerId}'`);
      const sr = await fetch(`https://api.stripe.com/v1/customers/search?query=${q}&limit=1`, {
        headers: { "Authorization": `Bearer ${sk}`, "Stripe-Version": STRIPE_VERSION }
      });
      const sd = await sr.json();
      const customerId = sd.data && sd.data[0] && sd.data[0].id || null;
      if (customerId && env.STRIPE_KV) {
        try {
          await env.STRIPE_KV.put(kvKey, customerId);
        } catch (e) {
        }
      }
      return customerId;
    }
    if (pathname === "/get-payment-methods" && request.method === "POST") {
      try {
        const { customerEmail } = await request.json();
        if (!customerEmail) return json({ error: "Missing customerEmail" }, 400);
        const customerId = await getOrCreateCustomer(customerEmail);
        const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=us_bank_account`, {
          headers: { "Authorization": `Bearer ${STRIPE_SK}` }
        });
        const pmData = await pmRes.json();
        if (pmData.error) return json({ error: pmData.error.message }, 400);
        const pms = pmData.data || [];
        // customerId rides along on BOTH shapes: the caller has to build the PaymentIntent on the
        // same customer this PaymentMethod was listed off, or the confirm is rejected.
        if (pms.length > 0) {
          const pm = pms[0];
          return json({ customerId, paymentMethods: [{ id: pm.id, bankName: pm.us_bank_account && pm.us_bank_account.bank_name || "Bank account", last4: pm.us_bank_account && pm.us_bank_account.last4 || "", type: "us_bank_account" }] });
        }
        return json({ customerId, paymentMethods: [] });
      } catch (e) {
        // A resolution failure is NOT "no bank linked" — returning [] here would hide an outage as
        // an unlinked account and walk the customer into a needless re-link.
        return json({ error: e.message }, 502);
      }
    }
    if (pathname === "/create-payment-intent" && request.method === "POST") {
      try {
        const body = await request.json();
        const { amount, paymentMethod, invoiceNums, customerEmail } = body;
        const isAch = paymentMethod === "ach";
        // A cus_* carried over from /get-payment-methods is authoritative: it is the customer the
        // linked PaymentMethod is actually attached to. Resolving by email again would re-open the
        // window where the two calls disagree.
        const passed = typeof body.customerId === "string" && /^cus_[A-Za-z0-9]+$/.test(body.customerId) ? body.customerId : null;
        let customerId = passed;
        if (!customerId && customerEmail) {
          if (isAch) {
            customerId = await getOrCreateCustomer(customerEmail);
          } else {
            // Card mints a fresh PaymentMethod per charge and never reuses one, so it does not need
            // a customer to be correct. Keep an identity outage from taking card payments down with
            // it — this is the one place the old degrade-to-null behaviour is still the right call.
            try { customerId = await getOrCreateCustomer(customerEmail); } catch (e) { customerId = null; }
          }
        }
        // ACH reuses a stored PaymentMethod, so its PaymentIntent MUST carry the owning customer.
        // A customer-less ACH PaymentIntent is exactly the split-brain this endpoint used to ship.
        if (isAch && !customerId) return json({ error: "Could not resolve a Stripe customer for this account" }, customerEmail ? 502 : 400);
        const amountCents = Math.round(amount * 100);
        const piParams = new URLSearchParams({
          amount: amountCents.toString(),
          currency: "usd",
          confirm: "false"
        });
        piParams.append("payment_method_types[]", isAch ? "us_bank_account" : "card");
        if (customerId) piParams.append("customer", customerId);
        if (invoiceNums) piParams.append("description", "Invoices: " + invoiceNums);
        if (isAch) piParams.append("setup_future_usage", "off_session");
        // ACH ONLY. Card captures synchronously and the browser posts it to QBO right there, so a
        // card PaymentIntent must never carry this metadata — the webhook keys off it, and a card
        // event that looked webhook-eligible would post the same payment to QuickBooks a second time.
        if (isAch) {
          const rows = Array.isArray(body.qboInvoices) ? body.qboInvoices : [];
          const clean = rows
            .map((r) => ({ qboId: String((r && r.qboId) || "").trim(), docNum: String((r && r.docNum) || "").trim(), amount: Number(r && r.amount) }))
            .filter((r) => r.qboId && Number.isFinite(r.amount) && r.amount > 0);
          // Every selected invoice must survive the trip. If any row is unusable the payment would
          // settle and under-post, so refuse to create it at all — the customer is not charged, and
          // the portal shows the error. Failing here is recoverable; failing at settlement is not.
          if (rows.length && clean.length !== rows.length) {
            return json({ error: "Could not record every invoice on this payment. Nothing was charged — please reselect and try again." }, 400);
          }
          if (clean.length) {
            let chunks;
            try {
              chunks = packQboInvoices(clean);
            } catch (e) {
              return json({ error: e.message }, 400);
            }
            piParams.append("metadata[fl_v]", FL_META_VERSION);
            piParams.append("metadata[fl_channel]", "ach");
            if (customerEmail) piParams.append("metadata[fl_email]", customerEmail);
            piParams.append("metadata[fl_inv_n]", String(chunks.length));
            chunks.forEach((c, i) => piParams.append("metadata[fl_inv_" + i + "]", c));
          }
        }
        const piRes = await fetch("https://api.stripe.com/v1/payment_intents", {
          method: "POST",
          headers: { "Authorization": `Bearer ${STRIPE_SK}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: piParams.toString()
        });
        const piData = await piRes.json();
        if (piData.error) return json({ error: piData.error.message }, 400);
        return json({ clientSecret: piData.client_secret, customerId, paymentIntentId: piData.id });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    // ── Stripe webhook — the ACH settlement path ───────────────────────────────
    //
    // This is a PUBLIC, unauthenticated URL. The only thing standing between it and someone marking
    // arbitrary invoices paid in QuickBooks is the signature check, so that runs FIRST, on the raw
    // bytes, before anything is parsed and before any state is touched.
    //
    // Contract with Stripe: a 2xx means "done, stop retrying". So a 2xx is returned ONLY when the
    // ledger writes actually succeeded. Anything unfinished returns non-2xx and Stripe redelivers.
    if (pathname === "/webhook" && request.method === "POST") {
      // Raw text FIRST — request.json() would consume the body and re-stringifying it changes the
      // bytes the HMAC was computed over.
      const raw = await request.text();
      const sig = request.headers.get("Stripe-Signature") || "";
      const nowSec = Math.floor(Date.now() / 1e3);
      // One route serves both Stripe modes: the dashboard issues a different signing secret per
      // mode, and an event is authentic if it matches EITHER. Both are real HMAC checks, so trying
      // the second one weakens nothing.
      let v = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET, nowSec);
      if (!v.ok && env.STRIPE_WEBHOOK_SECRET_TEST) {
        const vt = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET_TEST, nowSec);
        if (vt.ok) v = vt;
      }
      if (!v.ok) {
        console.error("[webhook] rejected:", v.reason);
        // 400, not 401: the caller is unauthenticated by definition. Never say more than this —
        // a detailed reason is an oracle for someone probing the endpoint.
        return json({ error: "Invalid signature" }, 400);
      }
      let event;
      try {
        event = JSON.parse(raw);
      } catch (e) {
        return json({ error: "Invalid JSON" }, 400);
      }
      const eventId = event && event.id;
      const pi = (event && event.data && event.data.object) || {};
      const md = pi.metadata || {};
      if (!eventId) return json({ error: "No event id" }, 400);
      if (!env.STRIPE_KV) {
        // No idempotency store means no way to promise we won't double-post. Refuse and let Stripe
        // retry rather than write to the ledger unprotected.
        console.error("[webhook] STRIPE_KV unavailable — refusing to process", eventId);
        return json({ error: "Idempotency store unavailable" }, 503);
      }
      // Event-level replay guard. This alone is NOT the real protection — a retry after a PARTIAL
      // success never reaches here, because a partial success returns non-2xx and is not marked
      // done. The per-invoice markers below are what stop the already-posted invoices from posting
      // twice on that retry.
      const doneKey = "wh:done:" + eventId;
      try {
        if (await env.STRIPE_KV.get(doneKey)) return json({ received: true, duplicate: true });
      } catch (e) {
        console.error("[webhook] KV read failed for", eventId, e);
        return json({ error: "Idempotency check failed" }, 503);
      }
      if (event.type === "payment_intent.payment_failed") {
        // ACH can fail days AFTER it settled-looking (R01 insufficient funds, R09 uncollected).
        // Never auto-reverse in QuickBooks — an automated reversal on a return that a human has
        // already handled makes the ledger worse. Flag it and let accounting decide.
        const lastErr = pi.last_payment_error || {};
        const rows = unpackQboInvoices(md) || [];
        const listHtml = rows.length
          ? "<ul>" + rows.map((r) => "<li>Invoice #" + r.docNum + " (QBO id " + r.qboId + ") &mdash; $" + r.amount.toFixed(2) + "</li>").join("") + "</ul>"
          : "<p>No invoice metadata on this PaymentIntent.</p>";
        await alertAccounting(
          "ACH payment FAILED — " + (pi.id || "unknown PaymentIntent"),
          '<p style="font-weight:700;color:#b91c1c;">An ACH payment has failed or been returned. Nothing has been changed in QuickBooks &mdash; this needs a human.</p>' +
          "<p>PaymentIntent: <code>" + (pi.id || "?") + "</code><br>Amount: $" + (Number(pi.amount || 0) / 100).toFixed(2) +
          "<br>Customer: " + (md.fl_email || pi.receipt_email || "unknown") +
          "<br>Reason: " + (lastErr.code || "unknown") + " &mdash; " + (lastErr.message || "no message") + "</p>" +
          "<p>Invoices this payment covered:</p>" + listHtml +
          "<p>If these invoices were already marked paid in QuickBooks, the payment needs reversing there manually.</p>"
        );
        try { await env.STRIPE_KV.put(doneKey, "1", { expirationTtl: 60 * 60 * 24 * 30 }); } catch (e) {}
        return json({ received: true, handled: "payment_failed" });
      }
      if (event.type !== "payment_intent.succeeded") {
        // Acknowledge anything else so Stripe stops sending it; we did not ask for it.
        return json({ received: true, ignored: event.type });
      }
      // ── Three guards, all fail-closed, before any ledger write ───────────────
      // 1. Version marker. PaymentIntents created before this metadata existed carry nothing we can
      //    trust, and the description string is display copy, not a mapping. Refusing to guess is
      //    the whole point: the in-flight payments at the time this shipped had invoices ALREADY
      //    marked paid by the earlier bug, so a guess would have double-posted them.
      // 2. Channel. Card posts to QBO synchronously in the browser; acting on a card event here
      //    would post it twice.
      // 3. Row integrity. A missing chunk or malformed triple means an incomplete invoice set.
      if (md.fl_v !== FL_META_VERSION || md.fl_channel !== "ach") {
        const why = md.fl_v !== FL_META_VERSION ? "no recognised invoice metadata (created before automatic settlement posting)" : "not an ACH payment";
        console.warn("[webhook] not eligible:", pi.id, why);
        if (md.fl_channel !== "ach" && md.fl_v === FL_META_VERSION) {
          // A card payment reaching here is expected and already handled in the browser. Silent.
          return json({ received: true, ignored: "card" });
        }
        await alertAccounting(
          "ACH settled — needs manual QuickBooks posting (" + (pi.id || "unknown") + ")",
          "<p>An ACH payment has settled, but it carries " + why + ", so nothing was posted to QuickBooks automatically.</p>" +
          "<p>PaymentIntent: <code>" + (pi.id || "?") + "</code><br>Amount: $" + (Number(pi.amount || 0) / 100).toFixed(2) +
          "<br>Customer: " + (md.fl_email || pi.receipt_email || "unknown") +
          "<br>Description: " + (pi.description || "none") + "</p>" +
          "<p><strong>Action:</strong> post this payment in QuickBooks by hand, against the invoices named in the description. Check whether any of them are already marked paid before posting.</p>"
        );
        // 200: this is a permanent condition. Retrying will never make the metadata appear.
        try { await env.STRIPE_KV.put(doneKey, "1", { expirationTtl: 60 * 60 * 24 * 30 }); } catch (e) {}
        return json({ received: true, handled: "manual-posting-required" });
      }
      const rows = unpackQboInvoices(md);
      if (!rows) {
        console.error("[webhook] invoice metadata incomplete for", pi.id);
        await alertAccounting(
          "ACH settled — invoice metadata unreadable (" + (pi.id || "unknown") + ")",
          "<p>An ACH payment settled but its invoice metadata could not be read in full, so NOTHING was posted to QuickBooks. Posting a partial set would leave the rest silently unpaid.</p>" +
          "<p>PaymentIntent: <code>" + (pi.id || "?") + "</code><br>Amount: $" + (Number(pi.amount || 0) / 100).toFixed(2) + "<br>Description: " + (pi.description || "none") + "</p>" +
          "<p><strong>Action:</strong> post this payment in QuickBooks by hand.</p>"
        );
        try { await env.STRIPE_KV.put(doneKey, "1", { expirationTtl: 60 * 60 * 24 * 30 }); } catch (e) {}
        return json({ received: true, handled: "metadata-unreadable" });
      }
      // ── Post each invoice, once, ever ────────────────────────────────────────
      // The per-invoice marker is the load-bearing idempotency. Scenario it exists for: 6 of 9
      // invoices post, QBO 500s on the 7th, we return non-2xx, Stripe retries — without these
      // markers the first 6 would post a SECOND time and the customer's invoices show double-paid.
      const paymentDate = new Date().toISOString().split("T")[0];
      const posted = [], failed = [];
      for (const r of rows) {
        const mk = "wh:posted:" + pi.id + ":" + r.qboId;
        try {
          if (await env.STRIPE_KV.get(mk)) { posted.push(r); continue; }
        } catch (e) {
          // Cannot prove this invoice is unposted -> do not post it. Retry later.
          console.error("[webhook] marker read failed", mk, e);
          failed.push({ ...r, reason: "idempotency read failed" });
          continue;
        }
        try {
          const res = await fetch("https://qbo-api.felipe-b80.workers.dev/payment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ invoiceId: r.qboId, amount: r.amount, paymentDate, stripePaymentIntentId: pi.id })
          });
          const data = await res.json().catch(() => ({}));
          // res.ok AND the body — qbo-api returns { error } with a real status, and reading only the
          // parsed body is how a 404 "Invoice not found" got treated as a successful post before.
          if (!res.ok || (data && data.error)) {
            console.error("[webhook] QBO post rejected", r.qboId, res.status, data);
            failed.push({ ...r, reason: (data && data.error) || "HTTP " + res.status });
            continue;
          }
          // Marker written immediately after the write it protects, so a crash between invoices
          // cannot replay the ones already done.
          try { await env.STRIPE_KV.put(mk, "1", { expirationTtl: 60 * 60 * 24 * 90 }); } catch (e) {
            console.error("[webhook] marker write failed after a successful post", mk, e);
          }
          posted.push(r);
        } catch (e) {
          console.error("[webhook] QBO post failed", r.qboId, e);
          failed.push({ ...r, reason: "request failed" });
        }
      }
      if (failed.length) {
        // Non-2xx so Stripe retries. The markers above mean the retry resumes rather than restarts.
        console.error("[webhook] " + failed.length + "/" + rows.length + " invoice(s) failed to post for", pi.id);
        return json({ error: "QBO posting incomplete", posted: posted.length, failed: failed.length }, 500);
      }
      // Ledger is correct. Only now is the customer told the money arrived.
      const to = md.fl_email || pi.receipt_email || "";
      let emailed = false;
      if (to) {
        try {
          emailed = await sendGrid(
            [{ to: [{ email: to }], subject: "Payment Confirmation \u2014 Freight and Logistics, Inc." }],
            buildInvoiceEmailHtml({
              invoices: rows.map((r) => ({ invNum: r.docNum, amount: r.amount })),
              total: Number(pi.amount || 0) / 100,
              paymentMethod: "ach",
              confirmationId: pi.id,
              achInitiated: false
            })
          );
        } catch (e) { emailed = false; }
      }
      // Mark done BEFORE reporting the email outcome: the ledger writes are complete and must never
      // be replayed. A failed email is not worth a redelivery that would re-send to everyone who
      // did receive one — it alerts a human instead.
      try { await env.STRIPE_KV.put(doneKey, "1", { expirationTtl: 60 * 60 * 24 * 30 }); } catch (e) {
        console.error("[webhook] could not mark event done", eventId, e);
      }
      if (to && !emailed) {
        await alertAccounting(
          "ACH posted to QuickBooks, but the customer email failed (" + pi.id + ")",
          "<p>All " + rows.length + " invoice(s) posted to QuickBooks successfully, but the confirmation email to " + to + " did not send.</p>" +
          "<p>PaymentIntent: <code>" + pi.id + "</code></p><p><strong>Action:</strong> send the customer a confirmation manually. Do NOT re-post the payment &mdash; QuickBooks is already correct.</p>"
        );
      }
      console.log("[webhook] posted " + posted.length + " invoice(s) for " + pi.id);
      return json({ received: true, posted: posted.length, emailed });
    }
    if (pathname === "/attach-payment-method" && request.method === "POST") {
      try {
        const { paymentMethodId, customerEmail } = await request.json();
        if (!paymentMethodId || !customerEmail) return json({ error: "Missing fields" }, 400);
        const customerId = await getOrCreateCustomer(customerEmail);
        if (!customerId) return json({ error: "Could not create customer" }, 500);
        const attachRes = await fetch(`https://api.stripe.com/v1/payment_methods/${paymentMethodId}/attach`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${STRIPE_SK}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: `customer=${encodeURIComponent(customerId)}`
        });
        const attachData = await attachRes.json();
        if (attachData.error && !attachData.error.message.includes("already been attached")) {
          return json({ error: attachData.error.message }, 400);
        }
        return json({ success: true, customerId, paymentMethodId });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    if (pathname === "/send-confirmation" && request.method === "POST") {
      try {
        const _g = await emailGuard(request); if (_g) return _g;
        const payload = await request.json();
        const { customerEmail } = payload;
        if (!customerEmail) return json({ error: "Missing customerEmail" }, 400);
        if (payload.type === "dispatch") {
          const amt = (Number(payload.amount || 0) / 100).toFixed(2);
          const cardTxt = (payload.cardBrand ? payload.cardBrand.charAt(0).toUpperCase() + payload.cardBrand.slice(1) : "Card") + " ending in " + (payload.cardLast4 || "----");
          const dateTxt = payload.date || (new Date()).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
          const bol = payload.bolNumber || "";
          const dispatchHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;margin:0;padding:0;"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;padding:20px;"><tr><td style="border-bottom:2px solid #bd27bc;padding-bottom:16px;"><span style="font-size:20px;font-weight:700;color:#bd27bc;">Freight and Logistics, Inc.</span></td></tr><tr><td style="padding:24px 0;"><p>Hi there,</p><p>BOL <strong>' + bol + '</strong> has been dispatched and your card on file was charged.</p><table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f8f5;border-radius:8px;"><tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">Amount charged</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">$' + amt + '</td></tr><tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">Card</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">' + cardTxt + '</td></tr><tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">BOL</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">' + bol + '</td></tr><tr><td style="padding:12px 14px;font-size:13px;color:#706c63;">Date</td><td style="padding:12px 14px;font-size:13px;font-weight:600;color:#1a1a1a;text-align:right;">' + dateTxt + '</td></tr></table><br><p style="font-size:13px;color:#706c63;">Questions? Email <a href="mailto:support@freightandlogistics.ai" style="color:#bd27bc;">support@freightandlogistics.ai</a> or call <a href="tel:+18006873713" style="color:#bd27bc;">(800) 687-3713</a>.</p></td></tr><tr><td style="border-top:1px solid #e5e5e5;padding-top:16px;font-size:12px;line-height:1.6;color:#8a8a8a;"><div style="font-weight:600;color:#6b6b6b;">Freight and Logistics, Inc. &middot; Nationwide 3PL Freight Brokerage</div><div style="margin-top:2px;"><a href="mailto:support@freightandlogistics.ai" style="color:#bd27bc;text-decoration:none;">support@freightandlogistics.ai</a> &middot; (800) 687-3713 &middot; <a href="https://www.freightandlogistics.ai" style="color:#bd27bc;text-decoration:none;">freightandlogistics.ai</a></div></td></tr></table></body></html>';
          const dispatchRes = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": `Bearer ${SENDGRID_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              personalizations: [{ to: [{ email: customerEmail }], subject: "Dispatch charge receipt \u2014 BOL " + bol }],
              from: { email: "support@freightandlogistics.ai", name: "Freight and Logistics" },
              content: [{ type: "text/html", value: dispatchHtml }]
            })
          });
          if (dispatchRes.status !== 202) return json({ error: "Failed to send email" }, 500);
          return json({ success: true });
        }
        const { invoices, total, paymentMethod, confirmationId, cardBrand, cardLast4 } = payload;
        // An ACH debit that is merely INITIATED has not paid anything — Stripe has accepted the
        // instruction and settlement is 2-5 business days out, where it can still fail. The portal
        // sends achStatus:'initiated' for exactly that state, and it gets its own template: submitted,
        // never received, never paid. The settled variant is the truthful one for card payments and
        // for ACH that has actually settled (sent by the webhook, not from here).
        const achInitiated = payload.achStatus === "initiated";
        const htmlEmail = buildInvoiceEmailHtml({ invoices, total, paymentMethod, confirmationId, cardBrand, cardLast4, achInitiated });
        const subject = achInitiated ? "Payment Submitted \u2014 Freight and Logistics, Inc." : "Payment Confirmation \u2014 Freight and Logistics, Inc.";
        const sent = await sendGrid([{ to: [{ email: customerEmail }], subject }], htmlEmail);
        if (!sent) return json({ error: "Failed to send email" }, 500);
        return json({ success: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    if (pathname === "/submit-application" && request.method === "POST") {
      try {
        const _g = await emailGuard(request); if (_g) return _g;
        const body = await request.json();
        const { record, pdfBase64, filename, signerEmail, recaptchaToken } = body || {};
        if (!record || !pdfBase64) return json({ error: "Missing application data" }, 400);
        if (RECAPTCHA_SECRET) {
          if (!recaptchaToken) return json({ error: "Verification failed" }, 400);
          const vRes = await fetch("https://www.google.com/recaptcha/api/siteverify", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ secret: RECAPTCHA_SECRET, response: recaptchaToken }).toString()
          });
          const vData = await vRes.json();
          if (!vData.success || typeof vData.score === "number" && vData.score < 0.3) {
            return json({ error: "Verification failed" }, 400);
          }
        }
        const ip = request.headers.get("CF-Connecting-IP") || "unknown";
        const ua = request.headers.get("User-Agent") || "unknown";
        const serverTs = (new Date()).toISOString();
        const docVersion = record.docVersion || "credit-app-v1";
        const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const c = record.company || {};
        const phys = c.physical || {};
        const sig = record.signature || {};
        const acks = record.acknowledgments || [];
        const refs = record.references || [];
        const consents = record.consents || {};
        const rowsHtml = [
          ["Legal Entity Name", c.legalName],
          ["DBA / Trade Name", c.dba],
          ["Physical Address", [phys.street, [phys.city, phys.state, phys.zip].filter(Boolean).join(", ")].filter(Boolean).join(", ")],
          ["Mailing Address", c.mailingSameAsPhysical ? "Same as physical" : c.mailing ? [c.mailing.street, [c.mailing.city, c.mailing.state, c.mailing.zip].filter(Boolean).join(", ")].filter(Boolean).join(", ") : "\u2014"],
          ["Company Phone", c.phone],
          ["Taxpayer ID / EIN", c.ein],
          ["Date Business Began", c.businessBegan],
          ["Gross Annual Sales", c.grossAnnualSales],
          ["Entity Type", c.entityType],
          ["Preferred Payment", c.paymentMethod],
          ["AP Contact", record.apContact ? record.apContact.name + " \xB7 " + record.apContact.phone + " \xB7 " + record.apContact.email : "\u2014"],
          ["Shipping Contact", record.shipContact ? record.shipContact.name + " \xB7 " + record.shipContact.phone + " \xB7 " + record.shipContact.email : "\u2014"]
        ].map(
          ([k, v]) => '<tr><td style="padding:7px 10px;font-size:12px;color:#706c63;border-bottom:1px solid #e5e2d9;">' + esc(k) + '</td><td style="padding:7px 10px;font-size:12px;color:#1a1a1a;font-weight:600;border-bottom:1px solid #e5e2d9;">' + esc(v || "\u2014") + "</td></tr>"
        ).join("");
        const refsHtml = refs.map(
          (r, i) => '<tr><td style="padding:7px 10px;font-size:12px;color:#706c63;border-bottom:1px solid #e5e2d9;">Reference ' + (i + 1) + '</td><td style="padding:7px 10px;font-size:12px;color:#1a1a1a;border-bottom:1px solid #e5e2d9;">' + esc([r.company, r.contact, r.phone, r.fax, r.email].filter(Boolean).join(" \xB7 ")) + "</td></tr>"
        ).join("");
        const acksHtml = acks.map(
          (a, i) => '<tr><td style="padding:7px 10px;font-size:12px;color:#706c63;border-bottom:1px solid #e5e2d9;">Acknowledgment ' + (i + 1) + '</td><td style="padding:7px 10px;font-size:12px;color:#1a1a1a;border-bottom:1px solid #e5e2d9;">' + esc(a.title) + " \u2014 <strong>" + (a.agreed ? "Agreed \u2713" : "NOT agreed") + "</strong></td></tr>"
        ).join("");
        const auditHtml = '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f8f5;border-radius:8px;margin-top:6px;"><tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">Signer</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;font-weight:600;text-align:right;">' + esc(sig.printedName) + ", " + esc(sig.title) + '</td></tr><tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">Signature method</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + esc(sig.method === "draw" ? "Drawn" : "Typed") + '</td></tr><tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">T&amp;C consent</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + (consents.termsAndConditions ? "AGREED" : "NOT AGREED") + '</td></tr><tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">E-signature consent</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + (consents.electronicSignature ? "AGREED" : "NOT AGREED") + '</td></tr><tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">IP address</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + esc(ip) + '</td></tr><tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">Server timestamp</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + esc(serverTs) + '</td></tr><tr><td style="padding:7px 12px;font-size:12px;color:#706c63;">Document version</td><td style="padding:7px 12px;font-size:12px;color:#1a1a1a;text-align:right;">' + esc(docVersion) + '</td></tr><tr><td style="padding:7px 12px;font-size:11px;color:#706c63;">User agent</td><td style="padding:7px 12px;font-size:10px;color:#706c63;text-align:right;">' + esc(ua) + "</td></tr></table>";
        const header = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;margin:0;padding:0;"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;padding:20px;"><tr><td style="border-bottom:2px solid #bd27bc;padding-bottom:16px;"><span style="font-size:20px;font-weight:700;color:#bd27bc;">Freight and Logistics, Inc.</span></td></tr>';
        const footer = '<tr><td style="border-top:1px solid #e5e5e5;padding-top:16px;font-size:12px;line-height:1.6;color:#8a8a8a;"><div style="font-weight:600;color:#6b6b6b;">Freight and Logistics, Inc. &middot; Nationwide 3PL Freight Brokerage</div><div style="margin-top:2px;"><a href="mailto:support@freightandlogistics.ai" style="color:#bd27bc;text-decoration:none;">support@freightandlogistics.ai</a> &middot; (800) 687-3713 &middot; <a href="https://www.freightandlogistics.ai" style="color:#bd27bc;text-decoration:none;">freightandlogistics.ai</a></div></td></tr></table></body></html>';
        const internalHtml = header + '<tr><td style="padding:20px 0 6px;"><p style="margin:0 0 12px;font-size:15px;font-weight:600;">New Credit Application \u2014 ' + esc(c.legalName || "Applicant") + '</p><table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">' + rowsHtml + refsHtml + acksHtml + '</table><p style="margin:18px 0 4px;font-size:11px;font-weight:700;color:#706c63;text-transform:uppercase;letter-spacing:.05em;">Electronic Signature Audit Record</p>' + auditHtml + '<p style="font-size:12px;color:#706c63;margin-top:14px;">The signed agreement PDF is attached.</p></td></tr>' + footer;
        const signerHtml = header + '<tr><td style="padding:20px 0 6px;"><p style="margin:0 0 10px;">Hi ' + esc(sig.printedName || "there") + ',</p><p style="margin:0 0 12px;">Thank you for submitting your Credit Application &amp; Purchase Agreement to Freight and Logistics, Inc. A copy of your signed agreement is attached to this email for your records.</p><p style="margin:0 0 12px;font-size:13px;color:#706c63;">Our onboarding team will review your application and reach out within one business day.</p><p style="margin:14px 0 4px;font-size:11px;font-weight:700;color:#706c63;text-transform:uppercase;letter-spacing:.05em;">Your Electronic Signature</p>' + auditHtml + '<p style="font-size:13px;color:#706c63;margin-top:16px;">Questions? Email <a href="mailto:support@freightandlogistics.ai" style="color:#bd27bc;">support@freightandlogistics.ai</a> or call <a href="tel:+18006873713" style="color:#bd27bc;">(800) 687-3713</a>.</p></td></tr>' + footer;
        const attachments = [{
          content: pdfBase64,
          filename: filename && /\.pdf$/i.test(filename) ? filename : "Credit-Application.pdf",
          type: "application/pdf",
          disposition: "attachment"
        }];
        const sendOne = (persons, html) => fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: { "Authorization": `Bearer ${SENDGRID_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            personalizations: persons,
            from: { email: "support@freightandlogistics.ai", name: "Freight and Logistics" },
            content: [{ type: "text/html", value: html }],
            attachments
          })
        });
        const internalRes = await sendOne(
          [{ to: [{ email: "support@freightandlogistics.ai" }], subject: "New Credit Application \u2014 " + (c.legalName || "Applicant") }],
          internalHtml
        );
        if (internalRes.status !== 202) return json({ error: "Failed to send application" }, 500);
        if (signerEmail) {
          try {
            await sendOne(
              [{ to: [{ email: signerEmail }], subject: "Your Signed Credit Application \u2014 Freight and Logistics, Inc." }],
              signerHtml
            );
          } catch (e) {
          }
        }
        return json({ success: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    if (pathname === "/create-setup-intent" && request.method === "POST") {
      try {
        const { mode, primusCustomerId, email } = await request.json();
        const smode = mode === "live" ? "live" : "test";
        const sk = skFor(smode);
        if (!sk) return json({ error: "Stripe key not configured for mode: " + mode }, 500);
        if (!primusCustomerId) return json({ error: "Missing primusCustomerId" }, 400);
        const customerId = await getCustomerByPrimus(sk, smode, primusCustomerId, email);
        if (!customerId) return json({ error: "Could not resolve customer" }, 500);
        const siParams = new URLSearchParams({ customer: customerId, usage: "off_session" });
        siParams.append("payment_method_types[]", "card");
        const siRes = await fetch("https://api.stripe.com/v1/setup_intents", {
          method: "POST",
          headers: { "Authorization": `Bearer ${sk}`, "Stripe-Version": STRIPE_VERSION, "Content-Type": "application/x-www-form-urlencoded" },
          body: siParams.toString()
        });
        const siData = await siRes.json();
        if (siData.error) return json({ error: siData.error.message }, 400);
        return json({ clientSecret: siData.client_secret, customerId });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    if (pathname === "/get-saved-cards" && request.method === "POST") {
      try {
        const { mode, primusCustomerId } = await request.json();
        const smode = mode === "live" ? "live" : "test";
        const sk = skFor(smode);
        if (!sk) return json({ error: "Stripe key not configured for mode: " + mode }, 500);
        const customerId = await findCustomerByPrimus(sk, smode, primusCustomerId);
        if (!customerId) return json({ cards: [] });
        const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=card`, {
          headers: { "Authorization": `Bearer ${sk}`, "Stripe-Version": STRIPE_VERSION }
        });
        const pmData = await pmRes.json();
        const cards = (pmData.data || []).map((pm) => ({
          id: pm.id,
          brand: pm.card && pm.card.brand,
          last4: pm.card && pm.card.last4,
          exp_month: pm.card && pm.card.exp_month,
          exp_year: pm.card && pm.card.exp_year
        }));
        return json({ cards, customerId });
      } catch (e) {
        return json({ error: e.message, cards: [] }, 500);
      }
    }
    if (pathname === "/charge-saved-card" && request.method === "POST") {
      try {
        const { mode, primusCustomerId, amount, bolNumber, idempotencyKey } = await request.json();
        const smode = mode === "live" ? "live" : "test";
        const sk = skFor(smode);
        if (!sk) return json({ ok: false, code: "config", error: "Stripe key not configured for mode: " + mode }, 500);
        if (!primusCustomerId) return json({ ok: false, code: "bad_request", error: "Missing primusCustomerId" }, 400);
        const cents = Math.round(Number(amount) * 100);
        if (!cents || cents < 50) return json({ ok: false, code: "bad_amount", error: "Invalid amount" }, 400);
        const auth = { "Authorization": `Bearer ${sk}`, "Stripe-Version": STRIPE_VERSION };
        const customerId = await findCustomerByPrimus(sk, smode, primusCustomerId);
        if (!customerId) return json({ ok: false, code: "no_customer", error: "No Stripe customer on file for this account" }, 200);
        const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=card&limit=1`, { headers: auth });
        const pmData = await pmRes.json();
        const pm = pmData.data && pmData.data[0];
        if (!pm) return json({ ok: false, code: "no_card", error: "No card on file" }, 200);
        const piParams = new URLSearchParams({
          amount: String(cents),
          currency: "usd",
          customer: customerId,
          payment_method: pm.id,
          off_session: "true",
          confirm: "true",
          capture_method: "automatic",
          description: "Dispatch charge \u2014 BOL " + (bolNumber || "")
        });
        if (bolNumber) piParams.append("metadata[bolNumber]", String(bolNumber));
        piParams.append("metadata[primusCustomerId]", String(primusCustomerId));
        const piHeaders = { ...auth, "Content-Type": "application/x-www-form-urlencoded" };
        if (idempotencyKey) piHeaders["Idempotency-Key"] = String(idempotencyKey);
        const piRes = await fetch("https://api.stripe.com/v1/payment_intents", { method: "POST", headers: piHeaders, body: piParams.toString() });
        const pi = await piRes.json();
        if (pi.error) {
          const code = pi.error.code === "authentication_required" ? "authentication_required" : pi.error.decline_code || pi.error.code || "card_declined";
          return json({ ok: false, code, error: pi.error.message, paymentIntentId: pi.error.payment_intent && pi.error.payment_intent.id }, 200);
        }
        if (pi.status !== "succeeded") {
          return json({ ok: false, code: pi.status, error: "Charge not completed (" + pi.status + ")", paymentIntentId: pi.id }, 200);
        }
        return json({ ok: true, paymentIntentId: pi.id, status: pi.status, amount: cents, brand: pm.card && pm.card.brand, last4: pm.card && pm.card.last4 });
      } catch (e) {
        return json({ ok: false, code: "exception", error: e.message }, 500);
      }
    }
    return json({ error: "Not found" }, 404);
  }
};
