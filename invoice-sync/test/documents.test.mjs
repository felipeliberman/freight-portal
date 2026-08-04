// Spec §8 + §6.4 — document exposure and scoped links.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeType, classifyDocument, selectDocuments, deriveDocToken, documentFilename,
  CUSTOMER_FACING, AUTO_PUSH, NEVER_EXPOSE,
} from '../src/documents.js';

/** The live doc list for BOL 160133377, verbatim from the 2026-08-03 read. */
const LIVE = [
  { type: 'BOL', name: 'Bill Of Lading' },
  { type: 'LBL', name: 'Shipping Labels' },
  { type: 'QUO', name: 'Quote #51127643' },
  { type: 'INV', name: 'Invoice #140488' },
  { type: 'DO',  name: 'Carrier Labels' },
  { type: 'COST', name: 'Vendor Quote' },
];

test('type codes are trimmed and uppercased before ANY comparison', () => {
  // `BOL ` carries a trailing space in the live response; without normalising, the allowlist
  // silently drops every Bill of Lading.
  assert.equal(normalizeType('BOL '), 'BOL');
  assert.equal(normalizeType(' bol'), 'BOL');
  assert.equal(classifyDocument('BOL '), 'pull');
  assert.equal(classifyDocument('reclass'), 'pull');
});

test('the live document set exposes ONLY the Bill of Lading', () => {
  const r = selectDocuments(LIVE, 'primary');
  assert.deepEqual(r.pull.map(d => d.type), ['BOL']);
  assert.deepEqual(r.excluded.map(d => d.type).sort(), ['COST', 'DO', 'INV', 'LBL', 'QUO']);
  assert.deepEqual(r.push, [], 'a primary pushes nothing');
});

test('NEGATIVE: every never-expose code is excluded, one by one', () => {
  for (const t of NEVER_EXPOSE) {
    assert.equal(classifyDocument(t), 'never', `${t} must never be exposed`);
    const r = selectDocuments([{ type: t }], 'rebill');
    assert.deepEqual(r.pull, [], `${t} reached a pull link`);
    assert.deepEqual(r.push, [], `${t} reached a push`);
  }
});

test('POSITIVE: every customer-facing code is exposed', () => {
  for (const t of CUSTOMER_FACING) {
    assert.equal(classifyDocument(t), 'pull', `${t} should be pullable`);
  }
});

test('an UNKNOWN type is excluded AND recorded — never silently dropped', () => {
  // A new Primus type must be visible in both directions: excluded from the customer, and surfaced
  // to us. Silently dropping it means a customer-facing document never appears and nobody learns why.
  const r = selectDocuments([{ type: 'WHATSIT' }, { type: 'BOL' }], 'primary');
  assert.deepEqual(r.pull.map(d => d.type), ['BOL']);
  assert.deepEqual(r.unknown, ['WHATSIT']);
  assert.ok(r.excluded.some(e => e.type === 'WHATSIT' && e.why === 'unknown_type'));
});

test('an EMPTY or missing type is unknown, not accidentally exposed', () => {
  for (const t of [undefined, null, '', '   ']) {
    assert.equal(classifyDocument(t), 'unknown');
    assert.deepEqual(selectDocuments([{ type: t }], 'rebill').pull, []);
  }
});

test('PUSH is rebill-only, and only for the two justification documents', () => {
  const docs = [{ type: 'RECLASS' }, { type: 'REWEIGH' }, { type: 'BOL' }, { type: 'POD' }];
  assert.deepEqual(selectDocuments(docs, 'rebill').push.map(d => d.type), ['RECLASS', 'REWEIGH']);
  for (const c of ['primary', 'hold', null]) {
    assert.deepEqual(selectDocuments(docs, c).push, [], `classification ${c} must push nothing`);
  }
});

test('IMG is PULL-ONLY and never pushed, on any classification', () => {
  // Driver photos show the consignee's house, door, plates and sometimes people. The bill-to is
  // often a retailer with no relationship to the delivery address.
  assert.equal(classifyDocument('IMG'), 'pull');
  assert.ok(!AUTO_PUSH.includes('IMG'));
  for (const c of ['rebill', 'primary', 'hold', null]) {
    assert.deepEqual(selectDocuments([{ type: 'IMG' }], c).push, [], `IMG pushed on ${c}`);
  }
});

test('the token is scoped per (INVOICE, DOCUMENT), not per document', async () => {
  // Two parties can bill on one BOL. A per-document token handed to one grants the other's view.
  const s = 'secret';
  const a = await deriveDocToken(s, '1591052345', '160133377', 'BOL');
  const b = await deriveDocToken(s, '38466460',   '160133377', 'BOL');   // different invoice, same doc
  const c = await deriveDocToken(s, '1591052345', '160133377', 'POD');   // same invoice, different doc
  assert.notEqual(a, b, 'a different invoice must not reuse the token');
  assert.notEqual(a, c, 'a different document must not reuse the token');
  assert.equal(a, await deriveDocToken(s, '1591052345', '160133377', 'bol '), 'stable, and normalised');
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('a different secret yields a different token, and no secret THROWS', async () => {
  const a = await deriveDocToken('s1', 'i', 'b', 'BOL');
  const b = await deriveDocToken('s2', 'i', 'b', 'BOL');
  assert.notEqual(a, b);
  await assert.rejects(() => deriveDocToken('', 'i', 'b', 'BOL'), /requires a secret/);
  await assert.rejects(() => deriveDocToken(null, 'i', 'b', 'BOL'), /requires a secret/);
});

test('the filename follows Primus convention', () => {
  assert.equal(documentFilename('160133377', 'bol '), '160133377_BOL.pdf');
});

test('the allowlists are frozen and PUSH is a strict subset of CUSTOMER_FACING', () => {
  for (const [n, l] of Object.entries({ CUSTOMER_FACING, AUTO_PUSH, NEVER_EXPOSE })) {
    assert.ok(Object.isFrozen(l), `${n} must be frozen`);
  }
  for (const t of AUTO_PUSH) assert.ok(CUSTOMER_FACING.includes(t), `${t} pushed but not pullable`);
  for (const t of NEVER_EXPOSE) assert.ok(!CUSTOMER_FACING.includes(t), `${t} on both lists`);
});
