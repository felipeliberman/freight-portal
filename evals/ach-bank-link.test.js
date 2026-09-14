'use strict';
// ── ACH bank link: the three panel states, and the shape of the flow ──────────
//
// A customer at Fifth Third could not pay invoice 144776 by ACH. Her bank fell back to manual
// account-number entry, which always needs microdeposit verification. The portal:
//   - called /attach-payment-method, which is not part of Stripe's ACH flow at all and failed every
//     time (all five of her PaymentMethods ended up with customer: null),
//   - threw "Could not finish linking your bank account" from that failure,
//   - never confirmed anything, so the microdeposits she was told to wait for were never sent,
//   - minted a fresh payable $457.49 PaymentIntent on every attempt — six in two days,
//   - and had no verification screen, no resume, and no next_action handling anywhere.
//
// These assert the shape that cannot regress into that. The panel-state checks render the WHOLE
// panel rather than probing for one field, because it is a display surface.
//
//   node evals/ach-bank-link.test.js

const fs = require('fs');
const path = require('path');

const A = { ok(c, m) { if (!c) throw new Error(m); } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const portal = fs.readFileSync(path.join(__dirname, '..', 'portal.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'stripe-payments', 'src', 'index.js'), 'utf8');

// An assertion that something is GONE has to look at code, not at the comment explaining why it
// went. Every absence check below drafted green against prose describing the very thing it forbids:
// "/attach-payment-method" survives in the note saying it was removed, and the copy rule matched
// the warning against breaking it. Drop whole-line comments first, keep everything else — URLs
// contain "//" and must survive.
const codeOnly = (src) => src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
const portalCode = codeOnly(portal);
const workerCode = codeOnly(worker);

test('linking uses a SetupIntent and can no longer mint a payable intent', () => {
  A.ok(/collectBankAccountForSetup/.test(portal), 'the link flow no longer uses collectBankAccountForSetup');
  A.ok(/confirmUsBankAccountSetup/.test(portal), 'the link flow never confirms the SetupIntent');
  A.ok(/\/ach-link\/start/.test(portal) && /pathname === "\/ach-link\/start"/.test(worker),
    'the SetupIntent route is missing on one side');
  // The defect in one line: a Link click created a payable object for the invoice total.
  A.ok(!/collectBankAccountForPayment/.test(portalCode),
    'linking still goes through collectBankAccountForPayment — a link click can mint a payable PaymentIntent again');
});

test('the hand-rolled attach is gone from the link path', () => {
  A.ok(!/attach-payment-method/.test(portalCode),
    'portal.html still calls /attach-payment-method — that call is not part of the ACH flow and is what failed');
  A.ok(!/Could not finish linking your bank account/.test(portalCode),
    'the error string from the attach failure survives, so something can still fail that way');
  // setup_future_usage stays: with the attach gone it is the documented save path, and it only
  // fires on a CONFIRMED intent, so an unverifiable account can never become a saved bank.
  A.ok(/setup_future_usage/.test(worker), 'setup_future_usage was removed — nothing saves the bank for reuse now');
});

test('next_action is read, and the verification URL reaches the customer', () => {
  A.ok(/verify_with_microdeposits/.test(portal), 'the portal still never looks at next_action');
  A.ok(/hosted_verification_url/.test(worker), 'the Worker never reads the hosted verification URL');
  A.ok(/hostedVerificationUrl/.test(portal), 'the verification URL never reaches the browser');
  A.ok(/ach-link\/pending/.test(portal) && /pathname === "\/ach-link\/pending"/.test(worker),
    'a pending verification is not recorded, so a return visit cannot resume it');
});

test('the panel has THREE states and Pay is impossible in the pending one', () => {
  A.ok(/id="ach-bank-pending"/.test(portal), 'the pending panel is gone');
  A.ok(/function _achShowPanel/.test(portal), 'the panel-state switch is gone');
  // The lie this replaces: any saved us_bank_account PaymentMethod painted "linked" and enabled Pay,
  // whether or not it could be charged.
  A.ok(/confirmBtn\.disabled = \(which !== 'linked'\)/.test(portal),
    'Pay is no longer gated on the VERIFIED state — a pending bank could be paid with again');
  A.ok(!/get-payment-methods/.test(portalCode),
    'the portal still calls /get-payment-methods, which takes an email from the request body and answers for any customer');
});

test('identity comes from Primus, never from the request body', () => {
  A.ok(/async function primusIdentity\(/.test(worker), 'the identity helper is gone');
  A.ok(/applet\/v1\/profile/.test(worker), 'identity is no longer derived from the self-scoped Primus profile');
  for (const route of ['/ach-link/start', '/ach-link/pending', '/ach-link/status', '/payment/abandon']) {
    const i = worker.indexOf('pathname === "' + route + '"');
    A.ok(i > -1, 'route missing: ' + route);
    const seg = worker.slice(i, i + 700);
    A.ok(/primusIdentity\(request\)/.test(seg) && /Not signed in/.test(seg),
      route + ' no longer authenticates the caller — a pending bank link could be surfaced to the wrong user');
  }
});

test('the in-flight guard is a revalidated pointer, not a lock', () => {
  A.ok(/async function liveIntentForInvoice\(/.test(worker), 'the guard read is gone');
  A.ok(/function intentIsLive\(/.test(worker), 'the liveness test is gone');
  const i = worker.indexOf('async function liveIntentForInvoice(');
  const seg = worker.slice(i, i + 900);
  // The invariant: a pointer that no longer names a live intent CLEARS rather than blocks, so a
  // stuck payment degrades into a payable invoice instead of a support ticket.
  A.ok(/STRIPE_KV\.delete\(key\)/.test(seg),
    'the guard no longer clears itself when the intent it names is spent — an invoice could become permanently unpayable');
  A.ok(/stripeGet\("payment_intents\//.test(seg), 'the guard is trusted without revalidating against Stripe');
  A.ok(/payment_in_flight/.test(worker) && /payment_in_flight/.test(portal), 'the guard verdict never reaches the UI');
  // All four exits.
  A.ok(/pathname === "\/payment\/abandon"/.test(worker), 'the explicit abandonment exit is gone');
  A.ok(/PAY_GUARD_TTL_SEC/.test(worker), 'the TTL backstop is gone');
});

test('the guard covers the CARD rail too', () => {
  const i = portal.indexOf("// ── Card flow ");
  A.ok(i > -1, 'the card flow marker moved');
  const seg = portal.slice(i, i + 2500);
  A.ok(/payment_in_flight/.test(seg),
    'the card rail ignores the in-flight guard — paying by card while a bank payment is pending is the double-charge path');
});

test('a mandate is shown and accepted before the setup is confirmed', () => {
  A.ok(/ACH_MANDATE_TEXT/.test(portal), 'the mandate text is gone');
  A.ok(/id="ach-mandate"/.test(portal), 'the mandate panel is gone');
  A.ok(/id="ach-mandate-accept"/.test(portal), 'there is no way for the customer to accept');
  // Order matters: the confirm must hang off the accept handler, not run before it.
  const accept = portal.indexOf("ach-mandate-accept');");
  const confirm = portal.indexOf('confirmUsBankAccountSetup');
  A.ok(accept > -1 && confirm > accept,
    'the SetupIntent is confirmed before the customer accepts the authorization');
});

test('copy promises no email this product does not send', () => {
  const i = portal.indexOf('function _achRenderPending');
  A.ok(i > -1, 'the pending renderer is gone');
  const seg = codeOnly(portal.slice(i, i + 1400));
  A.ok(/Stripe sent a small deposit/.test(seg), 'the pending copy changed');
  A.ok(!/we'?ll email|we will email|check your email for/i.test(seg),
    'the pending copy promises an email from us — the descriptor-code email comes from Stripe');
  A.ok(/1-2 business days/.test(seg), 'the pending copy no longer states the 1-2 business day wait');
});

test('verification_method stays unset, deliberately', () => {
  A.ok(!/verification_method/.test(workerCode),
    'verification_method is now set — instant-only hard-fails every bank Financial Connections cannot reach');
  A.ok(/verification_method is deliberately NOT set/.test(worker),
    'the decision is no longer recorded, so the next reader will read it as an oversight');
});

let fails = 0;
console.log('\n  ACH BANK LINK — evals/ach-bank-link.test.js\n');
for (const t of tests) {
  try { t.fn(); console.log('  PASS  ' + t.name); }
  catch (e) { fails++; console.log('  FAIL  ' + t.name + '\n        ' + String(e.message || e)); }
}
console.log('\n  ' + (tests.length - fails) + '/' + tests.length + ' checks green\n');
process.exit(fails ? 1 : 0);
