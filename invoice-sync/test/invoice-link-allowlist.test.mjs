// STEP 4 — THE AR ALLOWLIST ON THE MINT PATH (spec §3.1, §8.879, §8.882).
//
//     node --test invoice-sync/test/invoice-link-allowlist.test.mjs
//
// ── THIS FILE IS RED BY DEFECT, NOT RED BY ABSENCE ───────────────────────────────────────────
//
// Every assertion below FAILS on the HEAD that introduced it, and each failure is a real hole that
// exists in the code today — not scaffolding waiting for unwritten work. Read a failure here as
// "this is how it behaves right now", which is the point.
//
// ── THE DEFECT ───────────────────────────────────────────────────────────────────────────────
//
// `Ledger` and `StripeCustomers` hold the allowlist in their CONSTRUCTOR, so the pilot bound cannot
// be forgotten at a call site. `InvoiceLinks` was written AFTER both and did not inherit it: its
// constructor is (db, mode), and mint() normalises the ARCode, stores it, and never tests
// membership.
//
// SO THE ORDERING IS BACKWARDS. A real customer's invoice acquires a WORKING PUBLIC LINK first, and
// the only trace of the refusal is `markLinkMinted` returning false — which is the SAME value it
// returns for an already-stamped row. A boolean nobody reads. And `resolveToken` filters on nothing
// but mode and revocation, so the public route serves that link regardless.
//
// ── THE LESSON THAT DID NOT TRANSFER, WHICH IS THE LARGER FINDING ────────────────────────────
//
// This is the constructor-bound rule from step B reappearing in a class written after it. A rule
// applied to two classes IS NOT A RULE — nothing made the third class inherit it, and nothing will
// make the fourth. The test named `THE RULE, GENERALISED` below is the mechanism: it enumerates the
// classes that hold an ARCode-scoped bound and asserts EVERY one refuses to be built without it, so
// the next such class fails here on the day it is added rather than in a pilot post-mortem.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger } from '../src/ledger.js';
import { StripeCustomers } from '../src/stripe-customer.js';
import { InvoiceLinks, resolveToken } from '../src/invoice-link.js';
import { freshDb, freshLinksDb, ANY_AR, onlyAr } from './helpers.mjs';

/** The pilot bound: one ARCode. Everything else is a real customer who must not acquire a link. */
const PILOT = onlyAr('1234');
const OUTSIDE = '5406';                 // a real ARCode, deliberately NOT in PILOT

const SNAP = {
  invoiceNumber: '141604', issueDate: '2026-07-13', dueDate: '2026-08-12',
  totalCents: 27357, bolNumber: '160133693',
};

// ── 1. THE CONSTRUCTOR ───────────────────────────────────────────────────────────────────────

test('RED BY DEFECT: InvoiceLinks REFUSES to be built without an allowlist', async () => {
  assert.throws(
    () => new InvoiceLinks(freshLinksDb(), 'test'),
    /allowlist/i,
    'InvoiceLinks can currently be constructed with no bound at all. Ledger and StripeCustomers ' +
    'both refuse this; the class that mints CUSTOMER-FACING PUBLIC LINKS does not.'
  );
});

test('RED BY DEFECT: a malformed allowlist is refused too — an absent bound never means "everything"', async () => {
  for (const bad of [null, undefined, {}, { all: 'yes', codes: new Set() }, { all: false, codes: ['1234'] }]) {
    assert.throws(
      () => new InvoiceLinks(freshLinksDb(), 'test', bad),
      /allowlist/i,
      `a bound of ${JSON.stringify(bad)} was accepted — the shape is checked, not just presence`
    );
  }
});

test('THE RULE, GENERALISED: every class holding an ARCode-scoped bound refuses to be built without one', async () => {
  // The mechanism, not another instance. A rule applied to two classes is not a rule.
  const CLASSES = [
    { name: 'Ledger',         build: (a) => new Ledger(freshDb(), 'test', a) },
    { name: 'StripeCustomers', build: (a) => new StripeCustomers(freshDb(), 'test', a) },
    { name: 'InvoiceLinks',   build: (a) => new InvoiceLinks(freshLinksDb(), 'test', a) },
  ];
  for (const c of CLASSES) {
    assert.throws(() => c.build(undefined), /allowlist/i,
      `${c.name} can be built with NO allowlist. Add it to the constructor — every sibling has it, ` +
      `and the next class to hold an ARCode will need it too.`);
    assert.doesNotThrow(() => c.build(ANY_AR), `${c.name} rejected a valid wildcard allowlist`);
  }
});

// ── 2. THE MINT REFUSES. It does not mint-then-fail-to-stamp. ────────────────────────────────

test('RED BY DEFECT: mint() REFUSES an ARCode outside the allowlist', async () => {
  const links = new InvoiceLinks(freshLinksDb(), 'test', PILOT);
  await assert.rejects(
    () => links.mint({ primusInvoiceId: '1563993653', arCode: OUTSIDE, ...SNAP }),
    /allowlist|refused/i,
    'a non-allowlisted ARCode was minted a link'
  );
});

test('RED BY DEFECT: THE HARM — a non-allowlisted invoice acquires a WORKING link today', async () => {
  // This is the assertion that matters. Not "an internal call returned false" — an actual live,
  // resolvable, customer-facing link to a real customer's invoice, outside the pilot bound.
  const db = freshLinksDb();
  const links = new InvoiceLinks(db, 'test', PILOT);

  let token = null;
  try {
    const r = await links.mint({ primusInvoiceId: '1563993653', arCode: OUTSIDE, ...SNAP });
    token = r.token;
  } catch {
    return;                            // refused at the mint — the correct behaviour, nothing to prove
  }

  const served = await resolveToken(db, 'test', token, PILOT);
  assert.equal(served, null,
    `A LINK WAS MINTED FOR ARCode ${OUTSIDE}, OUTSIDE THE PILOT BOUND, AND THE PUBLIC ROUTE SERVES IT.\n` +
    `      token: ${token}\n` +
    `      invoice ${SNAP.invoiceNumber}, BOL ${SNAP.bolNumber}, $${(SNAP.totalCents / 100).toFixed(2)}\n` +
    `      This is a real customer's invoice reachable by anyone holding the URL, with no session.`);
});

test('the allowlisted ARCode still mints and still resolves — the bound is not a blanket refusal', async () => {
  const db = freshLinksDb();
  const links = new InvoiceLinks(db, 'test', PILOT);
  const r = await links.mint({ primusInvoiceId: '1563993653', arCode: '1234', ...SNAP });
  assert.equal(r.ok, true);
  const got = await resolveToken(db, 'test', r.token, PILOT);
  assert.ok(got, 'the PILOT customer must still get a working link — this is the whole feature');
  assert.equal(got.invoice_number, '141604');
});

test('normalisation applies to the bound: " 1234 " and "1234" are the same code', async () => {
  const links = new InvoiceLinks(freshLinksDb(), 'test', PILOT);
  const r = await links.mint({ primusInvoiceId: '99', arCode: '  1234  ', ...SNAP });
  assert.equal(r.ok, true, 'whitespace around a pilot ARCode must not defeat the allowlist');
});

// ── 3. BELT AND BRACES — the read path asserts the negative independently ────────────────────
//
// The mint refusing is the PRIMARY control. This is the second one: even if a row reaches the table
// by some path that is not mint() — a manual insert, a restored backup, a future writer that
// forgets — the public route must not serve it.

test('RED BY DEFECT: resolveToken REFUSES a row whose ar_code is outside the bound', async () => {
  const db = freshLinksDb();
  // Inserted DIRECTLY, bypassing mint() entirely. This is the case the mint guard cannot cover:
  // the row already exists. A backup restored from before the bound narrowed looks exactly like it.
  db.prepare(
    `INSERT INTO invoice_link (mode, token, primus_invoice_id, ar_code, invoice_number,
       issue_date, due_date, total_cents, bol_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind('test', 'AbCdEfGhIjKlMnOpQrStUv', 'I1', OUTSIDE, '141604',
         '2026-07-13', '2026-08-12', 27357, '160133693', 0).run();

  const got = await resolveToken(db, 'test', 'AbCdEfGhIjKlMnOpQrStUv', PILOT);
  assert.equal(got, null,
    'a pre-existing row outside the bound was served by the public read path');
});

test('resolveToken with a wildcard bound serves everything — the bound is the only filter added', async () => {
  const db = freshLinksDb();
  const links = new InvoiceLinks(db, 'test', ANY_AR);
  const r = await links.mint({ primusInvoiceId: '1563993653', arCode: OUTSIDE, ...SNAP });
  assert.ok(await resolveToken(db, 'test', r.token, ANY_AR),
    'the wildcard must behave exactly as before — this change must not narrow the full-book phase');
});

test('an outside-bound token is NOT DISTINGUISHABLE from an unknown one — no oracle', async () => {
  // §5.8: "not found" and "not yours" are ONE message. A bound that refuses LOUDLY would tell a
  // stranger which tokens exist, which is the property the 404 copy exists to protect.
  const db = freshLinksDb();
  db.prepare(
    `INSERT INTO invoice_link (mode, token, primus_invoice_id, ar_code, invoice_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind('test', 'AbCdEfGhIjKlMnOpQrStUv', 'I1', OUTSIDE, '141604', 0).run();

  const outside = await resolveToken(db, 'test', 'AbCdEfGhIjKlMnOpQrStUv', PILOT);
  const unknown = await resolveToken(db, 'test', 'ZzZzZzZzZzZzZzZzZzZzZz', PILOT);
  assert.equal(outside, unknown, 'outside-the-bound must return exactly what unknown returns: null');
});
