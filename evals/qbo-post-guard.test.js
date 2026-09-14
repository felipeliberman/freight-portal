'use strict';
// ── QuickBooks posting guard ──────────────────────────────────────────────────
// Structural assertions about the ONE path that writes a payment to QuickBooks. These are source
// checks on purpose: they are about what the code CANNOT do, and a behavioural test can only show
// what it did not do on the inputs it was given.
//
// Two invariants, both of which cost real money when broken:
//
//   1. pi.amount NEVER reaches a QBO post. It is the CHARGED total — on the card rail it includes
//      the convenience fee, and on any multi-invoice payment it is the sum of several invoices.
//      Posted against one invoice it over-credits the ledger. postInvoicePayment() therefore takes
//      a per-invoice amount and never receives the PaymentIntent at all.
//
//   2. Card invoice metadata and the shared claim key are a PAIR. Before the claim existed, the
//      absence of fl_inv_* on card PaymentIntents was the only thing preventing the settlement
//      webhook from posting a second payment on a charge the browser had already recorded. Stamping
//      the metadata without the claim reinstates that double-post.
//
//   node evals/qbo-post-guard.test.js

const fs = require('fs');
const path = require('path');

const A = { ok(c, m) { if (!c) throw new Error(m); } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const worker = fs.readFileSync(path.join(__dirname, '..', 'stripe-payments', 'src', 'index.js'), 'utf8');
const portal = fs.readFileSync(path.join(__dirname, '..', 'portal.html'), 'utf8');

// The body of postInvoicePayment, for assertions about what it can see.
function postFnBody() {
  const start = worker.indexOf('async function postInvoicePayment(');
  A.ok(start > -1, 'postInvoicePayment() is gone — the single QBO writer no longer exists');
  // Brace-match from the first { after the signature.
  let i = worker.indexOf('{', start), depth = 0;
  for (let j = i; j < worker.length; j++) {
    if (worker[j] === '{') depth++;
    else if (worker[j] === '}') { depth--; if (depth === 0) return worker.slice(i, j + 1); }
  }
  throw new Error('could not brace-match postInvoicePayment()');
}

test('exactly one place in the Worker writes a QBO payment', () => {
  const hits = worker.match(/qbo-api\.felipe-b80\.workers\.dev\/payment/g) || [];
  A.ok(hits.length === 1, 'expected exactly 1 qbo-api /payment call in the Worker, found ' + hits.length +
    ' — a second writer bypasses the shared claim key');
  A.ok(/async function postInvoicePayment\(/.test(worker), 'postInvoicePayment() is missing');
  A.ok(postFnBody().includes('qbo-api.felipe-b80.workers.dev/payment'),
    'the one QBO write is no longer inside postInvoicePayment() — it has escaped the claim');
});

test('postInvoicePayment cannot see the PaymentIntent', () => {
  const body = postFnBody();
  A.ok(!/\bpi\.amount\b/.test(body), 'postInvoicePayment() references pi.amount — the charged total must never be posted');
  A.ok(!/\bpi\.metadata\b/.test(body), 'postInvoicePayment() reached into the PaymentIntent object');
  // o.piId is an id (a string used for the claim key and the PrivateNote), not an amount source.
  A.ok(/amount: amount\b/.test(body) || /amount,/.test(body), 'the posted amount is no longer the per-invoice amount argument');
});

test('no caller hands pi.amount to the QBO writer', () => {
  const calls = worker.match(/postInvoicePayment\(\{[^}]*\}/g) || [];
  A.ok(calls.length >= 2, 'expected the webhook and /qbo-post to both call postInvoicePayment(), found ' + calls.length);
  for (const c of calls) {
    A.ok(!/pi\.amount/.test(c), 'a call site passes pi.amount into the QBO writer: ' + c);
    A.ok(/amount:\s*r\.amount\b/.test(c), 'a call site posts something other than the per-invoice amount: ' + c);
  }
});

test('the claim key is shared, and both rails claim it', () => {
  A.ok(/function qboKey\(piId, qboId\)/.test(worker), 'the shared claim key helper is gone');
  A.ok(/"qbo:posted:" \+ piId \+ ":" \+ qboId/.test(worker), 'the claim key is no longer keyed on the PaymentIntent and invoice');
  A.ok(/by: "webhook"/.test(worker), 'the webhook no longer claims through the shared key');
  A.ok(/by: "browser"/.test(worker), 'the browser path no longer claims through the shared key');
  // Claim BEFORE the write, release on failure — otherwise a crash mid-post double-posts, or a
  // failed post is never retried.
  const body = postFnBody();
  const claimAt = body.indexOf('state: "claimed"');
  const postAt = body.indexOf('qbo-api.felipe-b80.workers.dev/payment');
  A.ok(claimAt > -1 && postAt > -1 && claimAt < postAt, 'the claim is no longer written BEFORE the QBO post');
  A.ok(/releaseQboClaim\(key\)/.test(body), 'a failed post no longer releases its claim — the invoice would never post');
});

test('card metadata and the claim key ship together', () => {
  const stampsCard = /metadata\[fl_rail\]/.test(worker);
  const hasClaim = /function qboKey\(/.test(worker) && /async function postInvoicePayment\(/.test(worker);
  A.ok(!stampsCard || hasClaim,
    'card PaymentIntents carry invoice metadata but the shared claim key is gone — the webhook will post a second QBO payment on a charge the browser already recorded');
});

test('/qbo-post verifies the payment before writing', () => {
  A.ok(/pathname === "\/qbo-post"/.test(worker), 'the /qbo-post route is missing');
  A.ok(/pi\.status !== "succeeded"/.test(worker), '/qbo-post no longer requires the PaymentIntent to have succeeded');
  A.ok(/requestedCents > chargedCents/.test(worker), '/qbo-post no longer refuses a post larger than the amount charged');
  A.ok(/The mode is NOT taken from the request/.test(worker) || !/body\.mode/.test(worker),
    '/qbo-post lets the caller choose the Stripe key');
});

test('the browser no longer writes to qbo-api directly', () => {
  A.ok(!/qbo-api\.felipe-b80\.workers\.dev\/payment/.test(portal),
    'portal.html still POSTs to qbo-api /payment — that write shares no idempotency state with the webhook');
  A.ok(/STRIPE_WORKER \+ '\/qbo-post'/.test(portal), 'portal.html no longer routes its QBO post through /qbo-post');
  // A won race is a correct ledger, not a failure to warn the customer about.
  A.ok(/'posted' \|\| o\.outcome === 'already' \|\| o\.outcome === 'in_flight'/.test(portal),
    'a lost race is being reported as a QBO failure — a clean payment would paint the amber banner');
});

test('no alert still hardcodes ACH for every rail', () => {
  A.ok(/function railOf\(pi, md\)/.test(worker), 'the rail helper is gone');
  A.ok(!/"ACH settled — needs manual QuickBooks posting/.test(worker), 'the hardcoded ACH settlement subject survives');
  A.ok(!/"ACH payment FAILED/.test(worker), 'the hardcoded ACH failure subject survives');
  A.ok(!/"ACH posted PARTIALLY to QuickBooks/.test(worker), 'the hardcoded ACH partial-post subject survives');
});

// ── The alert email, as it actually renders ───────────────────────────────────
//
// The checks above are about the SOURCE. These drive the real Worker — signed webhook in, captured
// SendGrid payload out — and assert the WHOLE rendered body, byte for byte, not just the words that
// changed. A display surface is asserted as a surface: a change anywhere in it fails here and has to
// be made deliberately, which is how an edit to one clause stops silently rewriting the rest.
//
// It caught something on the first run. The neutral fallback rendered "Rail: Payment", which reads
// as though the rail were named "Payment" rather than being unknown. A rail-word-only assertion
// passed it.
const HEAD = '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1a1a1a;line-height:1.6;"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;padding:20px;"><tr><td style="border-bottom:2px solid #bd27bc;padding-bottom:12px;"><span style="font-size:16px;font-weight:700;color:#bd27bc;">FreightAI &mdash; automated alert</span></td></tr><tr><td style="padding:20px 0;">';
const TAIL = '</td></tr></table></body></html>';

// Every unrecognised-metadata alert, spelled out. Only the Rail: value differs between rails, and
// that is the point of asserting the whole thing rather than that one field.
function manualPostingBody(railDetail) {
  return HEAD +
    '<p>A payment has settled, but it carries no recognised invoice metadata (created before automatic settlement posting), so nothing was posted to QuickBooks automatically.</p>' +
    '<p>PaymentIntent: <code>pi_TEST123</code><br>Rail: ' + railDetail + '<br>Amount charged: $182.93<br>Customer: ap@example.com<br>Description: Invoices: 144888</p>' +
    '<p>The invoice set on this payment is UNKNOWN &mdash; there is no metadata to read it from, so the amount above is the amount CHARGED and is not necessarily any invoice\'s balance.</p>' +
    '<p><strong>Action:</strong> post this payment in QuickBooks by hand, against the invoices named in the description. Check whether any of them are already marked paid before posting.</p>' +
    TAIL;
}

const SECRET = 'whsec_test_secret';
const PI_BASE = { id: 'pi_TEST123', amount: 18293, description: 'Invoices: 144888', receipt_email: 'ap@example.com' };

// Drive the deployed handler itself: a genuinely signed payment_intent.succeeded, an in-memory KV,
// a stubbed qbo-api binding, and SendGrid intercepted so the alert can be read back verbatim.
async function fire(pi) {
  const { pathToFileURL } = require('url');
  const nodeCrypto = require('crypto');
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'stripe-payments', 'src', 'index.js')).href);
  const sent = [], qbo = [];
  const kv = new Map();
  const env = {
    STRIPE_SK: 'sk_live_fake', STRIPE_SK_TEST: '', SENDGRID_KEY: 'SG.fake',
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_KV: {
      get: async (k) => (kv.has(k) ? kv.get(k) : null),
      put: async (k, v) => void kv.set(k, v),
      delete: async (k) => void kv.delete(k),
    },
    QBO: {
      fetch: async (url, init) => {
        qbo.push({ url: String(url), body: init && init.body });
        return new Response(JSON.stringify({ ok: true, paymentId: 'P1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  };
  const raw = JSON.stringify({ id: 'evt_test_1', type: 'payment_intent.succeeded', data: { object: pi } });
  const t = Math.floor(Date.now() / 1000);
  const sig = 't=' + t + ',v1=' + nodeCrypto.createHmac('sha256', SECRET).update(t + '.' + raw).digest('hex');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.sendgrid.com')) {
      const b = JSON.parse(init.body);
      sent.push({ subject: b.personalizations[0].subject, html: b.content[0].value });
      return new Response('', { status: 202 });
    }
    throw new Error('unexpected outbound fetch from the webhook: ' + url);
  };
  try {
    const res = await mod.default.fetch(new Request('https://w/webhook', { method: 'POST', body: raw, headers: { 'Stripe-Signature': sig } }), env);
    return { sent, qbo, status: res.status, body: await res.json() };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('RENDER: a card payment WITH invoice rows alerts nobody and posts nothing', async () => {
  const r = await fire({
    ...PI_BASE,
    payment_method_types: ['card'],
    metadata: { fl_v: '1', fl_rail: 'card', fl_email: 'ap@example.com', fl_inv_n: '1', fl_inv_0: '77:144888:177.78' },
  });
  // This is the case that misfired on pi_3UFcSMAJRfa3jdmD1rIuwkFr: already posted by the browser,
  // announced as an ACH payment needing manual posting.
  A.ok(r.sent.length === 0, 'a card payment the browser already recorded still raises an alert: ' + JSON.stringify(r.sent.map((s) => s.subject)));
  A.ok(r.qbo.length === 0, 'the webhook posted a card payment to QuickBooks — the browser already did');
  A.ok(r.status === 200 && r.body.ignored === 'card', 'expected a silent card acknowledgement, got ' + r.status + ' ' + JSON.stringify(r.body));
});

test('RENDER: a card payment WITHOUT invoice rows — whole alert body', async () => {
  const r = await fire({ ...PI_BASE, payment_method_types: ['card'], metadata: {} });
  A.ok(r.sent.length === 1, 'expected exactly one alert, got ' + r.sent.length);
  A.ok(r.qbo.length === 0, 'nothing may post to QuickBooks when the invoice set is unknown');
  A.ok(r.sent[0].subject === 'Card payment settled — needs manual QuickBooks posting (pi_TEST123)',
    'subject changed:\n  ' + r.sent[0].subject);
  A.ok(r.sent[0].html === manualPostingBody('Card payment'),
    'the rendered alert body changed:\n  GOT      ' + r.sent[0].html + '\n  EXPECTED ' + manualPostingBody('Card payment'));
});

test('RENDER: a legacy ACH payment without metadata — whole alert body', async () => {
  const r = await fire({ ...PI_BASE, payment_method_types: ['us_bank_account'], metadata: {} });
  A.ok(r.sent.length === 1, 'expected exactly one alert, got ' + r.sent.length);
  A.ok(r.sent[0].subject === 'ACH payment settled — needs manual QuickBooks posting (pi_TEST123)',
    'subject changed:\n  ' + r.sent[0].subject);
  A.ok(r.sent[0].html === manualPostingBody('ACH payment'),
    'the rendered alert body changed:\n  GOT      ' + r.sent[0].html + '\n  EXPECTED ' + manualPostingBody('ACH payment'));
});

test('RENDER: the neutral fallback names no rail it cannot prove — whole alert body', async () => {
  // No fl_rail and no payment_method_types: nothing to derive a rail from.
  const r = await fire({ ...PI_BASE, metadata: {} });
  A.ok(r.sent.length === 1, 'expected exactly one alert, got ' + r.sent.length);
  A.ok(r.sent[0].subject === 'Payment settled — needs manual QuickBooks posting (pi_TEST123)',
    'the neutral subject changed:\n  ' + r.sent[0].subject);
  A.ok(!/Rail: Payment</.test(r.sent[0].html),
    'the body says "Rail: Payment" — that reads as the name of a rail rather than as unknown');
  A.ok(r.sent[0].html === manualPostingBody('unknown'),
    'the rendered alert body changed:\n  GOT      ' + r.sent[0].html + '\n  EXPECTED ' + manualPostingBody('unknown'));
});

test('the webhook checks the ledger before alerting on an unfinished claim', () => {
  A.ok(/async function invoiceIsSettled\(/.test(worker), 'the balance check is gone');
  A.ok(/Number\(match\.Balance\) === 0/.test(worker), 'the balance check no longer tests for a settled invoice');
  A.ok(/String\(i\.Id\) === String\(qboId\)/.test(worker), 'the balance check matches on DocNumber rather than the QBO Id');
});

(async () => {
  let fails = 0;
  console.log('\n  QBO POSTING GUARD — evals/qbo-post-guard.test.js\n');
  for (const t of tests) {
    try { await t.fn(); console.log('  PASS  ' + t.name); }
    catch (e) { fails++; console.log('  FAIL  ' + t.name + '\n        ' + String(e.message || e)); }
  }
  console.log('\n  ' + (tests.length - fails) + '/' + tests.length + ' guard checks green\n');
  process.exit(fails ? 1 : 0);
})();
