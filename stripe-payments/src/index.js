export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    const STRIPE_SK = env.STRIPE_SK;
    const SENDGRID_KEY = env.SENDGRID_KEY;
    const RECAPTCHA_SECRET = env.RECAPTCHA_SECRET;
    const STRIPE_VERSION = "2024-06-20";
    // Allow-Headers must name EVERY header a caller sends, or the browser blocks the request after
    // a preflight that looked fine. This said "Content-Type" for as long as no route needed
    // authentication, and the day the first authenticated routes shipped (/ach-link/*,
    // /payment/abandon, which send Authorization) bank linking broke for everyone: preflight 200,
    // POST blocked, 0 bytes transferred, "Failed to fetch" in the panel.
    //
    // It is one global object shared by every route, so this is never a per-route problem — and the
    // route that still worked (/create-payment-intent) had the identical CORS. The difference was
    // only that it sends Content-Type alone. Adding an authenticated route means checking here.
    //
    // NOT catchable by curl: curl does not enforce CORS, so a 401 from the terminal proves the route
    // exists and proves nothing about whether a browser can reach it. Verify with a real preflight —
    // OPTIONS carrying Access-Control-Request-Headers — and read what comes back.
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
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
    // ── ONE writer for QuickBooks, ONE key, both rails ─────────────────────────
    //
    // Two paths can post the same payment: the browser, the instant a card captures, and this
    // Worker's webhook, when an ACH debit settles days later. Until now they shared nothing — the
    // browser posted straight to qbo-api and the webhook kept a private `wh:posted:` marker — so the
    // only thing preventing a card charge from posting twice was that card PaymentIntents carried no
    // invoice metadata for the webhook to act on. That is an accident of omission, not a guard, and
    // it is what stamping the rail (below) would otherwise have removed.
    //
    // Both paths now claim the SAME key before writing, so a PaymentIntent can only ever produce one
    // QBO payment per invoice, whichever arrives first.
    //
    // CLAIM BEFORE POSTING, not mark-after. Marking afterwards leaves a window where a crash between
    // the QBO write and the marker lets a retry post it again. The cost of claiming first is that a
    // claim whose post then FAILS must be released (below), or a double-post is merely traded for a
    // silent never-post.
    //
    // HONEST LIMIT: Cloudflare KV has no compare-and-set, so this read-then-write is not a mutex. It
    // closes the SEQUENTIAL race, which is the one that exists here — the browser posts at capture,
    // the webhook arrives seconds to days later. Two genuinely simultaneous writers could still both
    // see an empty key. A hard guarantee needs a Durable Object and is deliberately not smuggled in.
    const QBO_CLAIM_TTL_SEC = 60 * 60 * 24 * 90;
    const QBO_CLAIM_STALE_MS = 5 * 60 * 1e3;
    function qboKey(piId, qboId) {
      return "qbo:posted:" + piId + ":" + qboId;
    }
    // Transition read ONLY. Any ACH payment mid-retry when this shipped has markers under the old
    // webhook-private prefix; ignoring them would re-post invoices that are already in QuickBooks.
    // Read both, write only the new one. Removable once no `wh:posted:` key can still be live
    // (they carry a 90-day TTL).
    function legacyQboKey(piId, qboId) {
      return "wh:posted:" + piId + ":" + qboId;
    }
    async function readQboClaim(piId, qboId) {
      const raw = await env.STRIPE_KV.get(qboKey(piId, qboId));
      if (raw) {
        try {
          return JSON.parse(raw);
        } catch (e) {
          // Unparseable means SOMETHING claimed it. Treat as done — the safe direction is never
          // posting twice, and a stuck key surfaces as an unposted invoice a human can see.
          return { state: "done", by: "unknown" };
        }
      }
      const legacy = await env.STRIPE_KV.get(legacyQboKey(piId, qboId));
      return legacy ? { state: "done", by: "webhook-legacy" } : null;
    }
    async function releaseQboClaim(key) {
      try {
        await env.STRIPE_KV.delete(key);
      } catch (e) {
        // The claim now outlives a post that never happened. It expires on its own, and until then
        // the invoice reads as "ambiguous" rather than posting — which alerts a human. Loud, not lost.
        console.error("[qbo] claim release failed", key, e);
      }
    }
    // THE ONLY function in this Worker that writes a payment to QuickBooks.
    //
    // It takes a per-invoice amount and NOTHING ELSE that could stand in for one. The PaymentIntent
    // is deliberately not a parameter: `pi.amount` is the CHARGED total, which on the card rail
    // includes the convenience fee and on any multi-invoice payment is the sum of several invoices.
    // Posting it against a single invoice would over-credit the ledger. Keeping the PI out of scope
    // here makes that impossible to do by accident rather than merely discouraged.
    async function postInvoicePayment(o) {
      const amount = Number(o.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        // Fail closed. An indeterminate amount is never guessed and never substituted.
        return { outcome: "bad_amount", reason: "no usable invoice amount" };
      }
      const key = qboKey(o.piId, o.qboId);
      let claim;
      try {
        claim = await readQboClaim(o.piId, o.qboId);
      } catch (e) {
        console.error("[qbo] claim read failed", key, e);
        return { outcome: "failed", reason: "idempotency read failed" };
      }
      if (claim) {
        if (claim.state === "done") return { outcome: "already", by: claim.by };
        const age = Date.now() - (Number(claim.at) || 0);
        if (age < QBO_CLAIM_STALE_MS) return { outcome: "in_flight", by: claim.by };
        // Claimed and never finished. We cannot know whether QuickBooks received that write, and
        // guessing either way is a ledger error. Hand it to a human.
        return { outcome: "ambiguous", by: claim.by, reason: "an earlier attempt claimed this invoice and never finished" };
      }
      try {
        await env.STRIPE_KV.put(key, JSON.stringify({ state: "claimed", by: o.by, at: Date.now() }), { expirationTtl: QBO_CLAIM_TTL_SEC });
      } catch (e) {
        console.error("[qbo] claim write failed", key, e);
        return { outcome: "failed", reason: "idempotency claim failed" };
      }
      let res, data;
      try {
        // env.QBO, NOT fetch() — see the service binding note in wrangler.toml. A plain fetch to the
        // qbo-api URL loops back to this Worker, because both sit on the same workers.dev zone.
        res = await env.QBO.fetch("https://qbo-api.felipe-b80.workers.dev/payment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ invoiceId: o.qboId, amount, paymentDate: o.paymentDate, stripePaymentIntentId: o.piId })
        });
        data = await res.json().catch(() => ({}));
      } catch (e) {
        console.error("[qbo] post failed", o.qboId, e);
        await releaseQboClaim(key);
        return { outcome: "failed", reason: "request failed" };
      }
      // res.ok AND the body — qbo-api returns { error } with a real status, and reading only the
      // parsed body is how a 404 "Invoice not found" got treated as a successful post before.
      if (!res.ok || (data && data.error)) {
        console.error("[qbo] post rejected", o.qboId, res.status, data);
        await releaseQboClaim(key);
        return { outcome: "failed", reason: (data && data.error) || "HTTP " + res.status };
      }
      try {
        await env.STRIPE_KV.put(key, JSON.stringify({ state: "done", by: o.by, at: Date.now() }), { expirationTtl: QBO_CLAIM_TTL_SEC });
      } catch (e) {
        // The write landed; only the claim upgrade failed. The claim still blocks a second post
        // until it goes stale, so this degrades to "ambiguous" and alerts rather than double-posts.
        console.error("[qbo] claim->done write failed after a successful post", key, e);
      }
      return { outcome: "posted", paymentId: data && data.paymentId };
    }
    // Is this invoice already settled in QuickBooks? Used before ALERTING, never before posting —
    // a zero balance means the ledger is already right and there is nothing for a human to do.
    // A false alert is worse than none: it trains the reader to ignore the real ones.
    //
    // Matches on Id, NOT DocNumber. /invoices answers by DocNumber and returns an ARRAY; DocNumber
    // is not guaranteed unique, so the row still has to be identified by its QBO Id.
    async function invoiceIsSettled(qboId, docNum) {
      if (!docNum) return false;
      try {
        const res = await env.QBO.fetch("https://qbo-api.felipe-b80.workers.dev/invoices?docNumber=" + encodeURIComponent(docNum));
        if (!res.ok) return false;
        const data = await res.json().catch(() => ({}));
        const match = (data && Array.isArray(data.invoices) ? data.invoices : []).find((i) => String(i.Id) === String(qboId));
        return !!match && Number(match.Balance) === 0;
      } catch (e) {
        // Unknown is not settled. Alerting on an unverifiable invoice is the safe direction.
        return false;
      }
    }
    // The rail a PaymentIntent actually ran on, for copy that used to say "ACH" unconditionally.
    //
    // fl_rail is stamped by us at creation and is authoritative. payment_method_types is the
    // fallback because it is always present on the event payload and costs no extra API call.
    // `charges.data[0].payment_method_details.type` is NOT used: on this API version the
    // PaymentIntent carries `latest_charge` (an id), not an expanded charges array, so reading it
    // would silently yield undefined and land every event on the neutral label.
    // `label` heads a subject line ("Card payment settled — ..."); `detail` is the value of the
    // "Rail:" field in the body, where the neutral case has to read as an ABSENCE of information
    // rather than as the name of a rail — "Rail: Payment" says nothing while looking like it does.
    function railOf(pi, md) {
      const raw = (md && md.fl_rail) || (pi && Array.isArray(pi.payment_method_types) ? pi.payment_method_types[0] : "") || "";
      if (raw === "card") return { code: "card", label: "Card payment", detail: "Card payment" };
      if (raw === "ach" || raw === "us_bank_account") return { code: "ach", label: "ACH payment", detail: "ACH payment" };
      return { code: "unknown", label: "Payment", detail: "unknown" };
    }
    // ── WHO IS ASKING ──────────────────────────────────────────────────────────
    //
    // The bank-link routes below hand back a live capability — a Stripe-hosted verification URL
    // that completes a bank setup — so "which customer is this" cannot be a field the caller fills
    // in. /get-payment-methods does exactly that (it reads customerEmail out of the request body
    // and answers with that customer's bank name and last4), which means one curl with somebody
    // else's address is enough. That endpoint is left alone here only because tightening it would
    // break every browser still running the old page; it is NOT fixed and wants its own change.
    //
    // These routes take ONLY the customer's own Primus bearer token — the one their login issued,
    // not the portal's shared service account — and ask Primus who it belongs to. billToInformation
    // on /applet/v1/profile is self-scoped to the authenticated account, so the answer comes from
    // Primus rather than from the request. There is no identity field to forge because there is no
    // identity field.
    //
    // Fails safe on the shared token too: portal.html's getToken() falls back to the service
    // account after 50 minutes, and that token simply resolves to the service account, which owns
    // no customer's bank link. It gets nothing rather than getting everything.
    const PRIMUS_BASE = "https://freightandlogistics-api.shipprimus.com";
    async function primusIdentity(request2) {
      const auth = request2.headers.get("Authorization") || "";
      const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
      if (!m) return null;
      try {
        const r = await fetch(PRIMUS_BASE + "/applet/v1/profile", {
          headers: { "Authorization": "Bearer " + m[1] }
        });
        if (!r.ok) return null;
        const d = await r.json();
        const bt = (d.data && d.data.results && d.data.results.billToInformation) || null;
        if (!bt || bt.id == null) return null;
        return { primusCustomerId: String(bt.id), name: bt.name || "" };
      } catch (e) {
        // Cannot establish who this is -> nobody. Never degrade to trusting the body.
        return null;
      }
    }
    // ── ACH bank link: the pending SetupIntent, so a return visit RESUMES ───────
    //
    // A manually-entered bank account cannot be verified instantly; Stripe sends microdeposits that
    // take 1-2 business days, and the SetupIntent sits in requires_action until the customer enters
    // the descriptor code. That intent is the thing to come back to. Nothing recorded it before, so
    // every return visit started over and minted another one — six in two days for one customer,
    // none of which could ever complete.
    //
    // Keyed by the PRIMUS customer id derived from the token above, never by anything the caller
    // sends. TTL comfortably outlives Stripe's own 10-day microdeposit timeout so the record cannot
    // disappear while the intent it points at is still live.
    const ACH_LINK_TTL_SEC = 60 * 60 * 24 * 21;
    function achLinkKey(primusCustomerId) {
      return "achlink:" + primusCustomerId;
    }
    // ── The in-flight payment guard ────────────────────────────────────────────
    //
    // A PaymentIntent stuck in requires_action never posts, so the invoice stays "unpaid" and stays
    // payable — which is how one invoice collected six intents. The guard stops the seventh.
    //
    // It is a CACHED POINTER, NOT A LOCK, and the distinction is the whole design. It is revalidated
    // against Stripe on every read, so it can never outlive the intent it names: a succeeded, failed,
    // cancelled or timed-out intent clears it on the next look. A stuck payment therefore degrades
    // into a payable invoice on its own rather than into a support ticket. The TTL is a backstop for
    // a revalidation that never happens, not the mechanism.
    //
    // Deliberately keyed on the invoice alone: its job is preventing a second payment for the same
    // invoice, not access control, and the caller already supplies the invoice number.
    const PAY_GUARD_TTL_SEC = 60 * 60 * 24 * 14;
    function payGuardKey(docNum) {
      return "payguard:inv:" + String(docNum);
    }
    // Live = still capable of taking money. Anything else is spent or dead and must not block.
    function intentIsLive(status) {
      return status === "requires_action" || status === "requires_confirmation" || status === "processing";
    }
    async function stripeGet(path) {
      const r = await fetch("https://api.stripe.com/v1/" + path, {
        headers: { "Authorization": `Bearer ${STRIPE_SK}`, "Stripe-Version": STRIPE_VERSION }
      });
      const d = await r.json().catch(() => ({}));
      return r.ok && d && d.id ? d : null;
    }
    // Reads the guard for one invoice and REVALIDATES it. Returns the live intent, or null after
    // clearing a pointer that no longer names one.
    async function liveIntentForInvoice(docNum) {
      if (!env.STRIPE_KV || !docNum) return null;
      const key = payGuardKey(docNum);
      let piId;
      try { piId = await env.STRIPE_KV.get(key); } catch (e) { return null; }
      if (!piId) return null;
      const pi = await stripeGet("payment_intents/" + encodeURIComponent(piId));
      if (!pi || !intentIsLive(pi.status)) {
        // The intent it pointed at is spent, dead, or gone. Clear rather than block.
        try { await env.STRIPE_KV.delete(key); } catch (e) {}
        return null;
      }
      return pi;
    }
    function microdepositUrl(intent) {
      const na = (intent && intent.next_action) || {};
      if (na.type !== "verify_with_microdeposits") return null;
      const v = na.verify_with_microdeposits || {};
      return v.hosted_verification_url || null;
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
    // ── /ach-link/start — a SetupIntent, NOT a PaymentIntent ───────────────────
    //
    // Linking a bank used to mint a fully-formed, payable PaymentIntent for the invoice total on
    // every click of "Link Bank Account", before the Financial Connections modal had even opened.
    // One customer produced six of them at $457.49 apiece. None could charge — none was ever
    // confirmed — but six payable objects for one invoice is not a thing a link button should be
    // able to create, and the one that carried no payment method at all was simply an abandoned
    // modal. A SetupIntent cannot take money, which is the correct shape for "save my bank".
    //
    // verification_method is deliberately NOT set. Stripe's default offers instant verification with
    // manual account-number entry as the fallback. Forcing instant would hard-fail every bank
    // Financial Connections cannot reach, which is worse than a fallback that works — the fallback
    // was never the defect here, the handling of it was. Decision, not omission.
    if (pathname === "/ach-link/start" && request.method === "POST") {
      const who = await primusIdentity(request);
      if (!who) return json({ error: "Not signed in" }, 401);
      try {
        const { customerEmail } = await request.json().catch(() => ({}));
        // The Stripe customer stays the email-keyed one the payment path already uses, so nothing
        // about how invoices get paid moves in this change. Authorisation is the Primus id above;
        // this is only resolution. (The account has two identity spines — email here, primusCustomerId
        // on the prepaid path — which is a known open item and not one this change tries to settle.)
        if (!customerEmail) return json({ error: "Missing customerEmail" }, 400);
        const customerId = await getOrCreateCustomer(customerEmail);
        const siParams = new URLSearchParams({ customer: customerId, usage: "off_session" });
        siParams.append("payment_method_types[]", "us_bank_account");
        siParams.append("metadata[fl_primus]", who.primusCustomerId);
        const siRes = await fetch("https://api.stripe.com/v1/setup_intents", {
          method: "POST",
          headers: { "Authorization": `Bearer ${STRIPE_SK}`, "Stripe-Version": STRIPE_VERSION, "Content-Type": "application/x-www-form-urlencoded" },
          body: siParams.toString()
        });
        const si = await siRes.json();
        if (si.error) return json({ error: si.error.message }, 400);
        return json({ clientSecret: si.client_secret, setupIntentId: si.id, customerId });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    // ── /ach-link/pending — remember the intent so the customer can come back ───
    //
    // Called once the confirm has landed in requires_action. This is the entire difference between
    // "come back in 1-2 days and verify" meaning something and meaning nothing.
    if (pathname === "/ach-link/pending" && request.method === "POST") {
      const who = await primusIdentity(request);
      if (!who) return json({ error: "Not signed in" }, 401);
      if (!env.STRIPE_KV) return json({ error: "Store unavailable" }, 503);
      try {
        const { setupIntentId } = await request.json().catch(() => ({}));
        if (!/^seti_[A-Za-z0-9_]+$/.test(String(setupIntentId || ""))) {
          return json({ error: "A valid setupIntentId is required" }, 400);
        }
        // Verify it is real, and that it is THIS customer's, before recording it. The id arrives
        // from the browser, so it is checked against Stripe rather than trusted.
        const si = await stripeGet("setup_intents/" + encodeURIComponent(setupIntentId));
        if (!si) return json({ error: "No such SetupIntent" }, 404);
        if ((si.metadata || {}).fl_primus !== who.primusCustomerId) {
          return json({ error: "That setup does not belong to this account" }, 403);
        }
        await env.STRIPE_KV.put(achLinkKey(who.primusCustomerId), si.id, { expirationTtl: ACH_LINK_TTL_SEC });
        return json({ ok: true });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    // ── /ach-link/status — the three states, told apart ─────────────────────────
    //
    // The panel used to have two states, and the second one lied: autoDetectLinkedBank listed any
    // us_bank_account PaymentMethod on the customer and painted "linked", with no idea whether it
    // could actually be charged. A bank pending microdeposit verification looked identical to a
    // verified one, so the customer clicked Pay on something that could not pay.
    //
    // 'pending' carries the verification URL, so coming back to the portal is a route to finishing
    // rather than a dead end.
    if (pathname === "/ach-link/status" && request.method === "POST") {
      const who = await primusIdentity(request);
      if (!who) return json({ error: "Not signed in" }, 401);
      try {
        const { customerEmail } = await request.json().catch(() => ({}));
        // A pending setup outranks a saved PaymentMethod: if verification is outstanding, that is
        // the customer's actual next step whatever else is on file.
        if (env.STRIPE_KV) {
          let seti = null;
          try { seti = await env.STRIPE_KV.get(achLinkKey(who.primusCustomerId)); } catch (e) {}
          if (seti) {
            const si = await stripeGet("setup_intents/" + encodeURIComponent(seti) + "?expand[]=payment_method");
            const url = microdepositUrl(si);
            if (si && si.status === "requires_action" && url) {
              const pm = si.payment_method || {};
              const u = pm.us_bank_account || {};
              return json({ state: "pending", hostedVerificationUrl: url, bankName: u.bank_name || "Bank account", last4: u.last4 || "" });
            }
            // Verified, failed, cancelled or timed out — the pointer is spent either way. Clear it
            // and fall through to whatever is actually saved on the customer.
            try { await env.STRIPE_KV.delete(achLinkKey(who.primusCustomerId)); } catch (e) {}
          }
        }
        if (!customerEmail) return json({ state: "none" });
        const customerId = await getOrCreateCustomer(customerEmail);
        const pmRes = await fetch(`https://api.stripe.com/v1/payment_methods?customer=${customerId}&type=us_bank_account`, {
          headers: { "Authorization": `Bearer ${STRIPE_SK}` }
        });
        const pmData = await pmRes.json();
        if (pmData.error) return json({ error: pmData.error.message }, 400);
        const pm = (pmData.data || [])[0];
        if (!pm) return json({ state: "none", customerId });
        const u = pm.us_bank_account || {};
        // Attached to the customer means a SetupIntent succeeded, which means verified. That is the
        // property the old listing had no way to establish, because it never went through a setup.
        return json({ state: "verified", customerId, paymentMethodId: pm.id, bankName: u.bank_name || "Bank account", last4: u.last4 || "" });
      } catch (e) {
        return json({ error: e.message }, 502);
      }
    }
    // ── /payment/abandon — the customer's own way out ──────────────────────────
    //
    // The fourth way the in-flight guard clears, and the only one a person drives. Success, failure
    // and Stripe's 10-day microdeposit timeout all clear it by revalidation without anyone asking;
    // this is for the customer who has simply changed their mind and wants to pay another way today
    // rather than wait out a verification they no longer intend to finish.
    //
    // Cancelling a PaymentIntent is a write, so it is gated on the caller's own Primus token and on
    // the intent still being live. It cannot cancel a payment that is already processing or settled
    // — intentIsLive() admits 'processing', so that is excluded explicitly here: money on the way is
    // not something a UI button gets to reverse.
    if (pathname === "/payment/abandon" && request.method === "POST") {
      const who = await primusIdentity(request);
      if (!who) return json({ error: "Not signed in" }, 401);
      if (!env.STRIPE_KV) return json({ error: "Store unavailable" }, 503);
      try {
        const { docNum } = await request.json().catch(() => ({}));
        const doc = String(docNum || "").trim();
        if (!doc) return json({ error: "A docNum is required" }, 400);
        const live = await liveIntentForInvoice(doc);
        if (!live) {
          // Already clear — revalidation found nothing live and removed the pointer. Report success:
          // the customer asked for a payable invoice and that is what they have.
          return json({ ok: true, cleared: true, cancelled: false });
        }
        if (live.status === "processing") {
          return json({ error: "That payment is already on its way to the bank and cannot be cancelled here. Email support@freightandlogistics.ai if it needs stopping.", code: "processing" }, 409);
        }
        const cr = await fetch("https://api.stripe.com/v1/payment_intents/" + encodeURIComponent(live.id) + "/cancel", {
          method: "POST",
          headers: { "Authorization": `Bearer ${STRIPE_SK}`, "Stripe-Version": STRIPE_VERSION }
        });
        const cd = await cr.json().catch(() => ({}));
        if (!cr.ok || cd.error) {
          console.error("[abandon] cancel refused", live.id, cr.status, cd && cd.error);
          return json({ error: (cd.error && cd.error.message) || "Could not cancel that payment." }, 400);
        }
        try { await env.STRIPE_KV.delete(payGuardKey(doc)); } catch (e) {}
        return json({ ok: true, cleared: true, cancelled: true });
      } catch (e) {
        return json({ error: e.message }, 500);
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
        // ── IN-FLIGHT GUARD ──────────────────────────────────────────────────
        //
        // Refuse to mint a second payable intent for an invoice that already has a live one. This is
        // the mechanism that let one invoice accumulate six: an intent parked in requires_action
        // never posts, so the invoice never flips to paid, so it stayed selectable and payable
        // forever. It guards the CARD rail too — paying by card while a bank payment is pending
        // verification is the way to actually get charged twice.
        //
        // It does not refuse outright. It hands back the live intent so the caller can offer to
        // finish it or cancel it, and liveIntentForInvoice() revalidates against Stripe first, so a
        // spent or dead pointer clears itself instead of stranding the invoice.
        const guardRows = Array.isArray(body.qboInvoices) ? body.qboInvoices : [];
        for (const g of guardRows) {
          const docNum = String((g && g.docNum) || "").trim();
          if (!docNum) continue;
          const live = await liveIntentForInvoice(docNum);
          if (live) {
            return json({
              error: "There is already a payment in progress for invoice " + docNum + ".",
              code: "payment_in_flight",
              docNum,
              paymentIntentId: live.id,
              intentStatus: live.status,
              hostedVerificationUrl: microdepositUrl(live)
            }, 409);
          }
        }
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
        // THE RAIL, stamped on BOTH paths. Downstream copy used to say "ACH" unconditionally because
        // ACH was the only rail carrying metadata: a card charge missed the eligibility gate below
        // and was announced as a settled ACH payment needing manual QuickBooks posting, on a payment
        // the browser had already posted correctly. The rail is now a fact on the PaymentIntent
        // rather than something the webhook infers from the absence of other fields.
        piParams.append("metadata[fl_rail]", isAch ? "ach" : "card");
        // THE INVOICE MAPPING, now on both rails too.
        //
        // This is ONLY safe because every QuickBooks write — browser and webhook alike — now goes
        // through postInvoicePayment() and its shared claim key. Before that existed, the absence of
        // this metadata on card PaymentIntents was the ONLY thing preventing a second QBO payment on
        // a charge the browser had already recorded. The two changes are a pair: never reinstate
        // this stamping without the claim, and never remove the claim while this stamping stands.
        const qboRows = Array.isArray(body.qboInvoices) ? body.qboInvoices : [];
        const clean = qboRows
          .map((r) => ({ qboId: String((r && r.qboId) || "").trim(), docNum: String((r && r.docNum) || "").trim(), amount: Number(r && r.amount) }))
          .filter((r) => r.qboId && Number.isFinite(r.amount) && r.amount > 0);
        // Every selected invoice must survive the trip. If any row is unusable the payment would
        // settle and under-post, so refuse to create it at all — the customer is not charged, and
        // the portal shows the error. Failing here is recoverable; failing at settlement is not.
        if (qboRows.length && clean.length !== qboRows.length) {
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
          // fl_channel is kept ACH-only and unchanged so that PaymentIntents created BEFORE fl_rail
          // existed still satisfy the webhook's eligibility gate while they are still in flight.
          if (isAch) piParams.append("metadata[fl_channel]", "ach");
          if (customerEmail) piParams.append("metadata[fl_email]", customerEmail);
          piParams.append("metadata[fl_inv_n]", String(chunks.length));
          chunks.forEach((c, i) => piParams.append("metadata[fl_inv_" + i + "]", c));
        }
        const piRes = await fetch("https://api.stripe.com/v1/payment_intents", {
          method: "POST",
          headers: { "Authorization": `Bearer ${STRIPE_SK}`, "Content-Type": "application/x-www-form-urlencoded" },
          body: piParams.toString()
        });
        const piData = await piRes.json();
        if (piData.error) return json({ error: piData.error.message }, 400);
        // Point each invoice at the intent just created. Best-effort by design: a failed write costs
        // the guard, not the payment, and the next read revalidates whatever it finds anyway.
        if (env.STRIPE_KV && piData.id) {
          for (const g of guardRows) {
            const docNum = String((g && g.docNum) || "").trim();
            if (!docNum) continue;
            try { await env.STRIPE_KV.put(payGuardKey(docNum), piData.id, { expirationTtl: PAY_GUARD_TTL_SEC }); } catch (e) {
              console.error("[guard] could not record in-flight intent for invoice", docNum, e);
            }
          }
        }
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
      // Derived ONCE, up front, and used by every alert below. Every subject and headline in this
      // handler used to say "ACH" because ACH was the only rail that ever reached them.
      const rail = railOf(pi, md);
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
          rail.label + " FAILED — " + (pi.id || "unknown PaymentIntent"),
          '<p style="font-weight:700;color:#b91c1c;">A payment has failed or been returned. Nothing has been changed in QuickBooks &mdash; this needs a human.</p>' +
          "<p>Rail: " + rail.detail + "</p>" +
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
      // The card rail is recorded by the browser at capture and is not this handler's work. It is
      // recognised by fl_rail now rather than by the ABSENCE of metadata, which is what made a card
      // charge fall through to the "ACH settled — needs manual posting" alert below while it was in
      // fact already posted. fl_channel stays in the test for PaymentIntents created before fl_rail.
      const isAchEvent = md.fl_channel === "ach" || md.fl_rail === "ach";
      if (md.fl_v === FL_META_VERSION && rail.code === "card") {
        return json({ received: true, ignored: "card" });
      }
      if (md.fl_v !== FL_META_VERSION || !isAchEvent) {
        const why = md.fl_v !== FL_META_VERSION ? "no recognised invoice metadata (created before automatic settlement posting)" : "not an ACH payment";
        console.warn("[webhook] not eligible:", pi.id, why);
        await alertAccounting(
          rail.label + " settled — needs manual QuickBooks posting (" + (pi.id || "unknown") + ")",
          "<p>A payment has settled, but it carries " + why + ", so nothing was posted to QuickBooks automatically.</p>" +
          "<p>PaymentIntent: <code>" + (pi.id || "?") + "</code><br>Rail: " + rail.detail +
          "<br>Amount charged: $" + (Number(pi.amount || 0) / 100).toFixed(2) +
          "<br>Customer: " + (md.fl_email || pi.receipt_email || "unknown") +
          "<br>Description: " + (pi.description || "none") + "</p>" +
          "<p>The invoice set on this payment is UNKNOWN &mdash; there is no metadata to read it from, so the amount above is the amount CHARGED and is not necessarily any invoice's balance.</p>" +
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
      // The claim key inside postInvoicePayment() is the load-bearing idempotency, and it is now
      // SHARED with the browser rather than private to this handler. Scenario it exists for: 6 of 9
      // invoices post, QBO 500s on the 7th, we return non-2xx, Stripe retries — without the claim
      // the first 6 would post a SECOND time and the customer's invoices show double-paid.
      //
      // r.amount is the per-invoice amount from the PaymentIntent metadata. pi.amount is NOT passed
      // and must never be: it is the charged total, which spans every invoice on the payment.
      const paymentDate = new Date().toISOString().split("T")[0];
      const posted = [], failed = [], deferred = [];
      let ambiguous = false;
      for (const r of rows) {
        const o = await postInvoicePayment({ piId: pi.id, qboId: r.qboId, amount: r.amount, paymentDate, by: "webhook" });
        if (o.outcome === "posted") { posted.push(r); continue; }
        if (o.outcome === "already") {
          // Someone got here first — an earlier delivery, or the browser. The ledger is already
          // right, so this counts as posted and says nothing.
          posted.push({ ...r, reason: "already posted by " + (o.by || "an earlier attempt") });
          continue;
        }
        if (o.outcome === "in_flight") {
          // Another writer holds the claim RIGHT NOW. Not an error and not worth waking anyone for:
          // if that writer succeeds this becomes "already" on the next delivery, and if it fails it
          // releases the claim and the next delivery posts. Return non-2xx so there IS a next one.
          deferred.push({ ...r, reason: "another writer is posting this invoice" });
          continue;
        }
        if (o.outcome === "ambiguous") {
          // A claim that was never finished. Whether QuickBooks received that write is unknowable
          // from here, so check the ledger itself before making noise about it.
          if (await invoiceIsSettled(r.qboId, r.docNum)) {
            posted.push({ ...r, reason: "already settled in QuickBooks" });
            continue;
          }
          ambiguous = true;
          failed.push({ ...r, reason: o.reason || "an earlier attempt did not finish" });
          continue;
        }
        failed.push({ ...r, reason: o.reason || "post failed" });
      }
      if (failed.length || deferred.length) {
        // Non-2xx so Stripe retries. The claim keys above mean the retry resumes rather than restarts.
        console.error("[webhook] " + failed.length + " failed, " + deferred.length + " deferred of " + rows.length + " invoice(s) for", pi.id);
        // ── Who needs to hear about this, and when ────────────────────────────
        // Two very different situations share this branch:
        //
        //  - NOTHING posted. No split state. Stripe's retries genuinely self-heal this, so staying
        //    quiet is right — an alert on every attempt is noise that trains you to ignore it. The
        //    danger is only that retries run out and it ends in silence, so it escalates after
        //    ATTEMPT_ALERT_AT tries.
        //  - SOME posted, some did not. This is the split-brain: money captured, part of the ledger
        //    updated, and nobody can tell which part without going and looking. It is exactly the
        //    state that had to be unpicked by hand before. Alert straight away.
        //
        // Either way the alert NAMES the invoices on both sides. A "something went wrong" message
        // that omits the split leaves the reconciliation entirely manual, which is the whole thing
        // this is meant to prevent.
        // A purely DEFERRED result is not a failure and never alerts: another writer holds the
        // claim, and the next delivery resolves it either way. Only real failures are countable
        // here, or the alert fires on the ordinary browser-wins race.
        const ATTEMPT_ALERT_AT = 3;
        const isPartial = failed.length > 0 && posted.length > 0;
        const alertKey = "wh:alerted:" + eventId;
        const attemptKey = "wh:attempts:" + eventId;
        let attempts = 1;
        try {
          attempts = (parseInt(await env.STRIPE_KV.get(attemptKey) || "0", 10) || 0) + 1;
          await env.STRIPE_KV.put(attemptKey, String(attempts), { expirationTtl: 60 * 60 * 24 * 7 });
        } catch (e) { /* counter is best-effort; never let it suppress the alert below */ }
        let alreadyAlerted = false;
        try { alreadyAlerted = !!(await env.STRIPE_KV.get(alertKey)); } catch (e) {}
        if (!alreadyAlerted && failed.length > 0 && (isPartial || ambiguous || attempts >= ATTEMPT_ALERT_AT)) {
          const li = (arr) => arr.length
            ? "<ul>" + arr.map((r) => "<li>Invoice #" + r.docNum + " (QBO id " + r.qboId + ") &mdash; $" + Number(r.amount).toFixed(2) + (r.reason ? " &mdash; " + r.reason : "") + "</li>").join("") + "</ul>"
            : "<p>(none)</p>";
          const headline = isPartial
            ? '<p style="font-weight:700;color:#b91c1c;">A settled payment posted to QuickBooks only PARTIALLY. The customer has been charged in full. Some invoices are recorded and some are not.</p>'
            : '<p style="font-weight:700;color:#b91c1c;">A settled payment has failed to post to QuickBooks after ' + attempts + ' attempts. NOTHING has been recorded. The customer has been charged in full.</p>';
          await alertAccounting(
            (isPartial ? rail.label + " posted PARTIALLY to QuickBooks — " : rail.label + " failing to post to QuickBooks — ") + pi.id,
            headline +
            // "Amount charged", not "Amount": on a multi-invoice payment this is the sum of them all,
            // and on the card rail it also includes the convenience fee. It is never an invoice total.
            "<p>PaymentIntent: <code>" + pi.id + "</code><br>Rail: " + rail.detail +
            "<br>Amount charged: $" + (Number(pi.amount || 0) / 100).toFixed(2) +
            "<br>Customer: " + (md.fl_email || pi.receipt_email || "unknown") +
            "<br>Attempt: " + attempts + "</p>" +
            "<p><strong>Posted to QuickBooks (do NOT post these again):</strong></p>" + li(posted) +
            "<p><strong>NOT posted (these need posting by hand if the retries do not clear):</strong></p>" + li(failed) +
            (deferred.length ? "<p><strong>Waiting on another writer (no action &mdash; these resolve on the next delivery):</strong></p>" + li(deferred) : "") +
            "<p>Stripe keeps retrying for about three days. Each retry re-posts only the invoices in the second list &mdash; the first list is protected and cannot double-post. If the retries succeed you will not hear again; nothing further is needed unless this is still unresolved after that window.</p>"
          );
          try { await env.STRIPE_KV.put(alertKey, "1", { expirationTtl: 60 * 60 * 24 * 7 }); } catch (e) {}
        }
        return json({ error: "QBO posting incomplete", posted: posted.length, failed: failed.length, deferred: deferred.length, attempts }, 500);
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
          rail.label + " posted to QuickBooks, but the customer email failed (" + pi.id + ")",
          "<p>All " + rows.length + " invoice(s) posted to QuickBooks successfully, but the confirmation email to " + to + " did not send.</p>" +
          "<p>PaymentIntent: <code>" + pi.id + "</code></p><p><strong>Action:</strong> send the customer a confirmation manually. Do NOT re-post the payment &mdash; QuickBooks is already correct.</p>"
        );
      }
      console.log("[webhook] posted " + posted.length + " invoice(s) for " + pi.id);
      return json({ received: true, posted: posted.length, emailed });
    }
    // ── /qbo-post — the browser's ONLY route into QuickBooks ───────────────────
    //
    // The card rail captures synchronously, so its ledger write happens while the customer is still
    // on the page. That write used to go from the BROWSER straight to qbo-api, which meant it shared
    // no idempotency state with the settlement webhook and could not be told apart from any other
    // caller. Both problems are the same problem: there was no single place where a QuickBooks write
    // for a PaymentIntent had to pass through.
    //
    // This is that place. It claims the shared key, then posts via the service binding.
    //
    // WHAT IT VERIFIES, before writing anything:
    //   1. The PaymentIntent EXISTS and Stripe says its status is "succeeded". A caller cannot post
    //      against a payment that was never taken.
    //   2. The invoice total does not EXCEED what was actually charged. A caller cannot inflate the
    //      credit beyond the money that moved.
    //   3. If the PaymentIntent carries its own invoice metadata, the request must agree with it.
    //      Where a stamped mapping exists it wins; the browser cannot substitute a different one.
    //
    // WHAT IT DOES NOT DO: it does not authenticate the caller. An Origin check is not access
    // control (non-browsers set any Origin they like) and would break the pages.dev and github.io
    // mirrors. The verification above is what narrows this route, not the header.
    if (pathname === "/qbo-post" && request.method === "POST") {
      if (!env.STRIPE_KV) return json({ error: "Idempotency store unavailable" }, 503);
      if (!env.QBO) return json({ error: "QuickBooks service binding unavailable" }, 503);
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "Invalid JSON body" }, 400);
      }
      const piId = String((body && body.paymentIntentId) || "").trim();
      if (!/^pi_[A-Za-z0-9_]+$/.test(piId)) return json({ error: "A valid paymentIntentId is required" }, 400);
      const given = Array.isArray(body && body.invoices) ? body.invoices : [];
      const rows = given
        .map((r) => ({ qboId: String((r && r.qboId) || "").trim(), docNum: String((r && r.docNum) || "").trim(), amount: Number(r && r.amount) }))
        .filter((r) => r.qboId && Number.isFinite(r.amount) && r.amount > 0);
      if (!rows.length) return json({ error: "No postable invoices in the request" }, 400);
      // Fail closed on a partially-unusable set, exactly as /create-payment-intent does: posting the
      // readable subset would under-record the payment silently.
      if (rows.length !== given.length) {
        return json({ error: "Some invoices in this request could not be read. Nothing was posted." }, 400);
      }
      // ── 1. The PaymentIntent, from Stripe, not from the caller ───────────────
      // Live key first, then test. The mode is NOT taken from the request: letting a caller choose
      // the key lets them choose which ledger their claim is checked against.
      async function fetchPi(sk) {
        if (!sk) return null;
        const r = await fetch("https://api.stripe.com/v1/payment_intents/" + encodeURIComponent(piId), {
          headers: { "Authorization": "Bearer " + sk, "Stripe-Version": STRIPE_VERSION }
        });
        const d = await r.json().catch(() => ({}));
        return r.ok && d && d.id ? d : null;
      }
      let pi;
      try {
        pi = await fetchPi(STRIPE_SK) || await fetchPi(env.STRIPE_SK_TEST);
      } catch (e) {
        // Cannot verify -> do not write. An unreachable Stripe is not permission to post.
        console.error("[qbo-post] PaymentIntent lookup failed", piId, e);
        return json({ error: "Could not verify the payment. Nothing was posted." }, 502);
      }
      if (!pi) return json({ error: "No such PaymentIntent" }, 404);
      if (pi.status !== "succeeded") {
        console.warn("[qbo-post] refused, status", piId, pi.status);
        return json({ error: "That payment has not succeeded (status: " + pi.status + "). Nothing was posted." }, 409);
      }
      // ── 2. The invoice total cannot exceed the money that moved ──────────────
      // Integer cents on both sides; a float comparison here would reject or admit on rounding.
      const requestedCents = rows.reduce((n, r) => n + Math.round(r.amount * 100), 0);
      const chargedCents = Math.round(Number(pi.amount) || 0);
      if (requestedCents > chargedCents) {
        console.error("[qbo-post] refused, over-post", piId, requestedCents, ">", chargedCents);
        await alertAccounting(
          "Refused a QuickBooks post larger than the payment (" + piId + ")",
          '<p style="font-weight:700;color:#b91c1c;">A request tried to record MORE against QuickBooks than this payment actually charged. Nothing was posted.</p>' +
          "<p>PaymentIntent: <code>" + piId + "</code><br>Charged: $" + (chargedCents / 100).toFixed(2) +
          "<br>Requested: $" + (requestedCents / 100).toFixed(2) + "</p>" +
          "<p><strong>Action:</strong> this should not happen from the portal. Check what called it before posting anything by hand.</p>"
        );
        return json({ error: "The invoice total exceeds the amount charged. Nothing was posted." }, 409);
      }
      // ── 3. A stamped mapping wins over the caller's ──────────────────────────
      const stamped = unpackQboInvoices(pi.metadata || {});
      if (stamped) {
        const byId = new Map(stamped.map((r) => [String(r.qboId), r]));
        const mismatch = rows.find((r) => {
          const m = byId.get(String(r.qboId));
          return !m || Math.round(m.amount * 100) !== Math.round(r.amount * 100);
        });
        if (mismatch) {
          console.error("[qbo-post] refused, metadata mismatch", piId, mismatch.qboId);
          return json({ error: "These invoices do not match the ones recorded on the payment. Nothing was posted." }, 409);
        }
      }
      // ── Post ─────────────────────────────────────────────────────────────────
      const paymentDate = new Date().toISOString().split("T")[0];
      const results = [];
      let sawAmbiguous = false;
      for (const r of rows) {
        const o = await postInvoicePayment({ piId, qboId: r.qboId, amount: r.amount, paymentDate, by: "browser" });
        if (o.outcome === "ambiguous") {
          // Check the ledger before treating it as a problem — an earlier attempt may well have
          // landed, in which case there is nothing wrong and nobody to tell.
          if (await invoiceIsSettled(r.qboId, r.docNum)) {
            results.push({ qboId: r.qboId, docNum: r.docNum, outcome: "already" });
            continue;
          }
          sawAmbiguous = true;
        }
        results.push({ qboId: r.qboId, docNum: r.docNum, outcome: o.outcome, reason: o.reason });
      }
      if (sawAmbiguous) {
        await alertAccounting(
          "A QuickBooks post was left in an unknown state (" + piId + ")",
          '<p style="font-weight:700;color:#b91c1c;">An earlier attempt claimed one or more invoices on this payment and never finished, and the invoice is still showing a balance. Whether QuickBooks received that write cannot be determined automatically.</p>' +
          "<p>PaymentIntent: <code>" + piId + "</code></p>" +
          "<p><strong>Action:</strong> check these invoices in QuickBooks before posting anything by hand:</p><ul>" +
          results.filter((r) => r.outcome === "ambiguous").map((r) => "<li>Invoice #" + r.docNum + " (QBO id " + r.qboId + ")</li>").join("") +
          "</ul>"
        );
      }
      return json({ ok: true, results });
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
