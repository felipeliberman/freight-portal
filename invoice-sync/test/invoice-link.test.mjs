// STEP 2 — the invoice link token store (spec §8.878, §8.879).
//
// The token SELECTS an invoice; the portal session AUTHORISES. This file pins the store's
// properties, not its wiring.
//
// FOUR PROPERTIES THAT ARE EASY TO GET WRONG AND EXPENSIVE TO GET WRONG:
//
//   1. THE MINT IS IDEMPOTENT PER INVOICE. A re-send must reach the SAME link. If minting twice
//      produced two live tokens, a customer with two copies of the email would hold two live links
//      to one invoice, and revoking the leaked one would leave the other open.
//   2. THE SNAPSHOT IS FROZEN AT MINT. Primus invoices are editable after issuance (§4.4), so the
//      possession page must render WHAT WAS SENT, not what the ledger now says. A join to live data
//      would silently restate the amount on a link someone received a month ago.
//   3. THE POSSESSION TIER IS A SCHEMA BOUNDARY. Fields outside it are not columns. A field cannot
//      leak from a table that does not hold it — which is why this asserts the table's SHAPE, not
//      just what a renderer chooses to show.
//   4. MODE NAMESPACING, as everywhere: a test-mode link must never satisfy a live-mode lookup.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Ledger } from '../src/ledger.js';
import { freshDb, freshLinksDb, ANY_AR, onlyAr } from './helpers.mjs';

const PILOT = onlyAr('1234');

// The possession tier, from §8.878. The dispute notice is a constant rendered from code, not a
// column, so it is deliberately not here.
const POSSESSION_COLUMNS = ['invoice_number', 'issue_date', 'due_date', 'total_cents', 'bol_number'];

// Fields the owner placed BEHIND the session. None may exist as a column.
const MUST_NOT_BE_COLUMNS = [
  'customer_reference',   // the customer's own PO — behind the session by the allowlist rule
  'consignee_name', 'consignee_address', 'shipper_name',
  'line_items', 'charges', 'accessorials', 'weight', 'commodity',
];

async function mod() { return import('../src/invoice-link.js'); }

// ── the store exists ─────────────────────────────────────────────────────────────────────────

test('the invoice-link store exists', async () => {
  const m = await mod().catch(() => null);
  assert.ok(m, 'src/invoice-link.js does not exist yet');
  assert.equal(typeof m.InvoiceLinks, 'function', 'no InvoiceLinks class');
});

// ── 1. THE MINT IS IDEMPOTENT ────────────────────────────────────────────────────────────────

test('PROPERTY: minting twice for one invoice returns the SAME token, not an error', async () => {
  const { InvoiceLinks } = await mod();
  const links = new InvoiceLinks(freshLinksDb(), 'test');
  const snap = { invoiceNumber: '141604', issueDate: '2026-07-13', dueDate: '2026-08-12', totalCents: 27357, bolNumber: '160133693' };

  const a = await links.mint({ primusInvoiceId: '1563993653', arCode: '1234', ...snap });
  const b = await links.mint({ primusInvoiceId: '1563993653', arCode: '1234', ...snap });

  assert.equal(a.ok, true);
  assert.equal(b.ok, true, 'a second mint must not error — a re-send is normal, not a fault');
  assert.equal(b.token, a.token, 'a re-send must reach the SAME link, or one invoice has two live links');
  assert.equal(b.created, false, 'the second mint reports that it reused, so a caller can tell');
});

test('PROPERTY: a REVOKED link can be replaced, and the replacement is a different token', async () => {
  const { InvoiceLinks } = await mod();
  const links = new InvoiceLinks(freshLinksDb(), 'test');
  const args = { primusInvoiceId: 'I1', arCode: '1234', invoiceNumber: '141604', issueDate: '2026-07-13', dueDate: '2026-08-12', totalCents: 100, bolNumber: 'B1' };

  const first = await links.mint(args);
  assert.equal(await links.revoke(first.token), true);
  const second = await links.mint(args);

  assert.notEqual(second.token, first.token, 'revocation must not be undone by re-minting the same token');
  assert.equal(await links.resolve(first.token), null, 'a revoked token resolves to nothing');
  assert.ok(await links.resolve(second.token), 'the replacement resolves');
});

// ── 2. THE SNAPSHOT IS FROZEN ────────────────────────────────────────────────────────────────

test('PROPERTY: the snapshot is frozen at mint — a later invoice edit does not restate the link', async () => {
  const { InvoiceLinks } = await mod();
  const db = freshLinksDb();
  const links = new InvoiceLinks(db, 'test');

  const { token } = await links.mint({
    primusInvoiceId: 'I1', arCode: '1234', invoiceNumber: '141604',
    issueDate: '2026-07-13', dueDate: '2026-08-12', totalCents: 27357, bolNumber: '160133693',
  });

  // Primus edits the invoice after issuance (§4.4). A re-mint must not silently restate the link.
  await links.mint({
    primusInvoiceId: 'I1', arCode: '1234', invoiceNumber: '141604',
    issueDate: '2026-07-13', dueDate: '2026-08-12', totalCents: 99999, bolNumber: '160133693',
  });

  const r = await links.resolve(token);
  assert.equal(r.total_cents, 27357,
    'the link restated an amount the customer never received — it must render WHAT WAS SENT');
});

// ── 3. THE POSSESSION TIER IS A SCHEMA BOUNDARY ──────────────────────────────────────────────

test('PROPERTY: the possession tier is a SCHEMA boundary — behind-session fields are not columns', async () => {
  const db = freshLinksDb();
  const cols = db.rows('PRAGMA table_info(invoice_link)').map(r => r.name);

  for (const c of POSSESSION_COLUMNS) {
    assert.ok(cols.includes(c), `possession column ${c} is missing`);
  }
  for (const c of MUST_NOT_BE_COLUMNS) {
    assert.ok(!cols.includes(c),
      `${c} is a column. It is behind the session, and a field cannot leak from a table that does ` +
      `not hold it — the allowlist rule applied one layer below the renderer.`);
  }
});

test('resolve() returns the possession snapshot and nothing beyond it', async () => {
  const { InvoiceLinks } = await mod();
  const links = new InvoiceLinks(freshLinksDb(), 'test');
  const { token } = await links.mint({
    primusInvoiceId: 'I1', arCode: '1234', invoiceNumber: '141604',
    issueDate: '2026-07-13', dueDate: '2026-08-12', totalCents: 27357, bolNumber: '160133693',
  });
  const r = await links.resolve(token);
  for (const c of POSSESSION_COLUMNS) assert.ok(c in r, `${c} missing from resolve()`);
  for (const c of MUST_NOT_BE_COLUMNS) assert.ok(!(c in r), `${c} reached a possession-tier read`);
});

// ── 4. MODE NAMESPACING ──────────────────────────────────────────────────────────────────────

test('NEGATIVE CONTROL: a test-mode link never satisfies a live-mode lookup', async () => {
  const { InvoiceLinks } = await mod();
  const db = freshLinksDb();
  const t = new InvoiceLinks(db, 'test');
  const l = new InvoiceLinks(db, 'live');

  const { token } = await t.mint({ primusInvoiceId: 'I1', arCode: '1234', invoiceNumber: 'N', issueDate: 'd', dueDate: 'd', totalCents: 1, bolNumber: 'B' });
  assert.equal(await l.resolve(token), null, 'a test-mode link resolved in live mode');

  const live = await l.mint({ primusInvoiceId: 'I1', arCode: '1234', invoiceNumber: 'N', issueDate: 'd', dueDate: 'd', totalCents: 1, bolNumber: 'B' });
  assert.notEqual(live.token, token, 'live minted the test-mode token instead of its own');
});

// ── the token itself ─────────────────────────────────────────────────────────────────────────

test('the token is 128 bits of CSPRNG output, URL-safe, and never repeats', async () => {
  const { InvoiceLinks, newToken } = await mod();
  assert.equal(typeof newToken, 'function', 'newToken is not exported — it must be testable in isolation');

  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const t = newToken();
    assert.match(t, /^[A-Za-z0-9_-]{22}$/, `token ${JSON.stringify(t)} is not 22 chars of base64url`);
    assert.ok(!seen.has(t), 'newToken repeated within 500 draws');
    seen.add(t);
  }
});

// ── the ledger side: capture at claim, and the write-once mint stamp ─────────────────────────

test('the ledger captures issue and due dates AT CLAIM, from list data already in hand', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test', PILOT);
  await ledger.claim({
    primusInvoiceId: '1563993653', arCode: '1234', bolNumber: '160133693',
    issueDate: '2026-07-13', invoiceDueDate: '2026-08-12', totalCents: 27357,
  });
  const row = await ledger.get('1563993653');
  assert.equal(row.issue_date, '2026-07-13', 'issue_date not captured — the LIST carries it (§1)');
  assert.equal(row.invoice_due_date, '2026-08-12', 'invoice_due_date not captured');
});

test('link_minted_at is WRITE-ONCE — it is the reconciliation point for a half-failed mint', async () => {
  // The mint writes the links DB, then stamps the ledger. Those are different databases, so the
  // pair is NOT transactional. If the stamp fails, a re-run must find the mint already done —
  // the links table's active-unique index refuses the duplicate and the caller re-stamps.
  const ledger = new Ledger(freshDb(), 'test', PILOT);
  const { row } = await ledger.claim({ primusInvoiceId: 'I1', arCode: '1234' });

  assert.equal(await ledger.markLinkMinted(row.id, 1000), true, 'first stamp writes');
  assert.equal(await ledger.markLinkMinted(row.id, 2000), false, 'a later stamp must not overwrite');
  assert.equal((await ledger.get('I1')).link_minted_at, 1000, 'the first moment is the one that matters');
});
