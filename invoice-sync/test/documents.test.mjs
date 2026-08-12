// Spec §8 + §6.4 — document exposure and scoped links.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  normalizeType, classifyDocument, selectDocuments, deriveDocToken, verifyDocToken, documentFilename,
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

test('the live document set exposes the customer-facing four, and excludes the carrier internals', () => {
  // RULING CHANGED 2026-08-10 (spec §8.878), not drift. INV, LBL and QUO became customer-facing:
  // INV because its exclusion read "superseded by the Stripe invoice" and Stripe is gone — the
  // Primus PDF is what the invoice link now serves; LBL and QUO because they are live customer
  // workflows. COST and DO stay out: carrier cost and dispatch internals.
  const r = selectDocuments(LIVE, 'primary');
  assert.deepEqual(r.pull.map(d => d.type), ['BOL', 'LBL', 'QUO', 'INV']);
  assert.deepEqual(r.excluded.map(d => d.type).sort(), ['COST', 'DO']);
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

test('IMG is NEVER exposed — not pulled, not pushed, on any classification', () => {
  // STRENGTHENED 2026-08-10 (spec §8.878). This previously asserted IMG was PULL-ONLY. That was too
  // generous and the new assertion is strictly stronger, not a relaxation.
  //
  // Driver photos show the consignee's house, door, plates and sometimes people. On a ~90%
  // residential white-glove book the bill-to is usually the retailer and the consignee is THEIR
  // customer — so a pull link shows a retailer a photograph of someone else's front door.
  //
  // The rule that decided it, and the one to apply to the next type Primus adds: a document is
  // customer-facing only if THE BILL-TO IS ITS SUBJECT, not merely a party to the shipment.
  assert.equal(classifyDocument('IMG'), 'never');
  assert.ok(!AUTO_PUSH.includes('IMG'));
  for (const c of ['rebill', 'primary', 'hold', null]) {
    const r = selectDocuments([{ type: 'IMG' }], c);
    assert.deepEqual(r.push, [], `IMG pushed on ${c}`);
    assert.deepEqual(r.pull, [], `IMG pulled on ${c}`);
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// verifyDocToken — the half deriveDocToken never had
//
// THE THREAT MODEL, because it decides the whole shape of this function. The document route is
// handed a token off a URL and is about to serve bytes. It must NOT ask the token which invoice it
// was minted for — that would be the client naming its own scope, the same defect as trusting a
// `customerEmail` out of sessionStorage. The route already knows which (invoice, bol, type) it is
// serving; verification re-derives the token for THAT triple and asks whether the presented one
// matches. The client supplies exactly one thing: the candidate.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const SECRET = 'server-side-secret';
const INV = '1591052345';
const BOL = '160133377';
const TYPE = 'BOL';

test('a token minted by deriveDocToken verifies against the same four inputs', async () => {
  const t = await deriveDocToken(SECRET, INV, BOL, TYPE);
  assert.equal(await verifyDocToken(SECRET, INV, BOL, TYPE, t), true);
});

test('a changed primusInvoiceId does not verify', async () => {
  // Kept as three separate tests rather than one loop: if the invoice component ever stopped
  // contributing to the digest, a combined case could still fail for the wrong reason and read as
  // "the test caught it". Each component is pinned on its own.
  const t = await deriveDocToken(SECRET, INV, BOL, TYPE);
  assert.equal(await verifyDocToken(SECRET, '38466460', BOL, TYPE, t), false);
});

test('a changed bolNumber does not verify', async () => {
  const t = await deriveDocToken(SECRET, INV, BOL, TYPE);
  assert.equal(await verifyDocToken(SECRET, INV, '160133693', TYPE, t), false);
});

test('a changed type does not verify', async () => {
  const t = await deriveDocToken(SECRET, INV, BOL, TYPE);
  assert.equal(await verifyDocToken(SECRET, INV, BOL, 'POD', t), false);
});

test('an empty candidate token is false, never a throw', async () => {
  // The route receives this off a URL. A throw would turn a malformed request into a 500, which is
  // both a worse answer and a DIFFERENT answer from the one a wrong token gets — and a difference
  // an attacker can see is an oracle.
  assert.equal(await verifyDocToken(SECRET, INV, BOL, TYPE, ''), false);
});

test('a null or undefined candidate token is false, never a throw', async () => {
  for (const bad of [null, undefined]) {
    assert.equal(await verifyDocToken(SECRET, INV, BOL, TYPE, bad), false, `${bad} must be false`);
  }
});

test('a candidate of the RIGHT length but wrong content is false', async () => {
  // The interesting negative: length alone must not satisfy anything, and a near-miss must be
  // rejected by content. '0'.repeat(32) is a legal-looking 32-char hex string.
  const t = await deriveDocToken(SECRET, INV, BOL, TYPE);
  assert.equal(t.length, 32, 'the format assumption this test rests on');
  assert.equal(await verifyDocToken(SECRET, INV, BOL, TYPE, '0'.repeat(32)), false);

  // One character off, in the last position — the case a prefix-comparison bug would still reject,
  // and the first position, which a suffix bug would.
  const lastFlipped = t.slice(0, 31) + (t[31] === 'a' ? 'b' : 'a');
  const firstFlipped = (t[0] === 'a' ? 'b' : 'a') + t.slice(1);
  assert.equal(await verifyDocToken(SECRET, INV, BOL, TYPE, lastFlipped), false);
  assert.equal(await verifyDocToken(SECRET, INV, BOL, TYPE, firstFlipped), false);
});

test('a candidate of a DIFFERENT length is false and does not throw', async () => {
  // THE TRAP THIS TEST EXISTS FOR. Node's own crypto.timingSafeEqual THROWS a RangeError when the
  // two buffers differ in length — so the obvious "use the standard constant-time compare" answer
  // turns a short token in a URL into a 500. Anything used here must answer false instead.
  const t = await deriveDocToken(SECRET, INV, BOL, TYPE);
  const lengths = ['', 'a', t.slice(0, 31), t.slice(0, 16), t + 'a', t + t, 'x'.repeat(1000)];
  for (const c of lengths) {
    await assert.doesNotReject(
      () => verifyDocToken(SECRET, INV, BOL, TYPE, c), `length ${c.length} threw instead of returning false`);
    assert.equal(await verifyDocToken(SECRET, INV, BOL, TYPE, c), false, `length ${c.length} must be false`);
  }
});

test('NEGATIVE: two invoices\' tokens never verify against each other, on one secret', async () => {
  // The property the whole per-(invoice, document) scoping exists for. Two parties can bill on one
  // BOL — shipper-paid and consignee-paid rebill — so holding one party's token must not open the
  // other's view of the SAME file. Same secret, same BOL, same type: only the invoice differs.
  const a = await deriveDocToken(SECRET, '1591052345', BOL, TYPE);
  const b = await deriveDocToken(SECRET, '38466460', BOL, TYPE);
  assert.notEqual(a, b, 'precondition: the two tokens differ');

  assert.equal(await verifyDocToken(SECRET, '1591052345', BOL, TYPE, a), true);
  assert.equal(await verifyDocToken(SECRET, '38466460', BOL, TYPE, b), true);
  assert.equal(await verifyDocToken(SECRET, '38466460', BOL, TYPE, a), false, 'A\'s token opened B\'s invoice');
  assert.equal(await verifyDocToken(SECRET, '1591052345', BOL, TYPE, b), false, 'B\'s token opened A\'s invoice');
});

test('a token minted under a DIFFERENT secret does not verify', async () => {
  // Rotating the secret must invalidate every outstanding token. Since the token is derived and
  // never stored, the secret is the only thing that can revoke them wholesale.
  const t = await deriveDocToken('secret-one', INV, BOL, TYPE);
  assert.equal(await verifyDocToken('secret-two', INV, BOL, TYPE, t), false);
});

test('verification normalises `type` exactly as minting does', async () => {
  // `BOL ` carries a trailing space in the live Primus response. If mint normalised and verify did
  // not, a link built from the live list would fail against a type read back from the same list —
  // and it would fail as "wrong token", indistinguishable from an attack.
  const t = await deriveDocToken(SECRET, INV, BOL, 'bol ');
  assert.equal(await verifyDocToken(SECRET, INV, BOL, 'BOL', t), true);
  assert.equal(await verifyDocToken(SECRET, INV, BOL, ' Bol', t), true);
});

test('verification is case-SENSITIVE on the token itself', async () => {
  // The token is an opaque credential, not a type code. Accepting a case variant would widen the
  // set of strings that open a document for no benefit to anyone holding a real link.
  const t = await deriveDocToken(SECRET, INV, BOL, TYPE);
  const upper = t.toUpperCase();
  if (upper !== t) assert.equal(await verifyDocToken(SECRET, INV, BOL, TYPE, upper), false);
});

test('the comparison adds no dependency — documents.js imports nothing', () => {
  // This module must stay importable by a PUBLIC Worker (§8.878 plan step 3), so its only crypto
  // is the global `crypto.subtle` deriveDocToken already uses. Asserting on the IMPORT SURFACE is
  // the whole check: Node's `crypto.timingSafeEqual` — which throws a RangeError on a length
  // mismatch, the trap the previous test guards behaviourally — is simply unreachable without one.
  //
  // Deliberately NOT a grep for the identifier. Comments are source: the first version of this
  // test matched this file's own explanation of why node:crypto is avoided, and a test that a name
  // may not be MENTIONED pushes the next author to rename a well-named function or delete the
  // reasoning. Pin what is reachable, not what is written.
  const HERE = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(HERE, '..', 'src', 'documents.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(src), 'documents.js must stay dependency-free');
  assert.ok(!/require\(/.test(src), 'documents.js must not require anything');
});

test('CLBL is CUSTOMER-FACING — the customer\'s own parcel label (owner ruling 2026-08-12)', () => {
  // ── WHY THIS MOVED, AND WHY IT IS NOT A LOOSENING ───────────────────────────────────────────
  //
  // CLBL sat on NEVER_EXPOSE under "carrier internals / dispatch", grouped with DO / SHP / MET.
  // That grouping was wrong for CLBL specifically: it is the REAL CARRIER LABEL for the customer's
  // own parcel shipment — the thing they physically stick on the box. Apply §8.878's own test:
  //
  //     A document type is customer-facing only if THE BILL-TO IS ITS SUBJECT,
  //     not merely a party to the shipment.
  //
  // The bill-to IS the subject of their own shipping label. This is the same reasoning that
  // admitted INV, and the opposite of what excluded IMG (a photo of someone else's front door).
  //
  // IT IS ALSO LOAD-BEARING, not cosmetic. For a PARCEL shipment CLBL is the PRIMARY action in the
  // portal — portal.html:6057 `const isPrimary = bc.isParcel ? isClbl : isBOL`, labelled "Download
  // Carrier Label". Serving parcel documents through a route that enforces this allowlist would
  // have 404'd exactly the document a parcel customer needs, and 404 is that route's refusal
  // vocabulary, so it would have read as "not allowed" rather than "we broke it".
  assert.equal(classifyDocument('CLBL'), 'pull');
  assert.ok(CUSTOMER_FACING.includes('CLBL'));
  assert.ok(!NEVER_EXPOSE.includes('CLBL'), 'CLBL must not be on both lists');
  assert.equal(classifyDocument('clbl '), 'pull', 'and it normalises like every other code');

  // NEGATIVE CONTROLS — the ruling is about CLBL alone, and must not have widened its neighbours.
  // These three shared its "carrier internals / dispatch" line; they stay out.
  for (const t of ['DO', 'SHP', 'MET']) {
    assert.equal(classifyDocument(t), 'never', `${t} moved with CLBL and must not have`);
  }
  // And the canary the whole allowlist exists for: carrier COST is never customer-facing.
  assert.equal(classifyDocument('COST'), 'never', 'COST reaching a customer is the margin leak');
  assert.equal(classifyDocument('COI'), 'never');
  assert.equal(classifyDocument('IMG'), 'never');
});
