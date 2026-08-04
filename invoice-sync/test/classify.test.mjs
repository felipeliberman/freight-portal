// Spec §4.3 — primary vs rebill classification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInvoice, VOID_AWARENESS_AVAILABLE } from '../src/classify.js';

const inv = (id, bol, issueDate) => ({ invoiceId: id, issueDate, shipment: { BOLNumber: bol } });

// The real pilot collisions: BOL 160133034 -> 140061 then 141015 ($55 rebill).
const A = inv('690883244', '160133034', '2026-06-20 10:00:00');
const B = inv('38466460', '160133034', '2026-07-01 09:00:00');

test('the only invoice on a BOL is a primary', () => {
  const r = classifyInvoice(A, [A]);
  assert.equal(r.classification, 'primary');
  assert.match(r.reason, /only invoice/);
});

test('the EARLIEST of a BOL collision is the primary, the later one a rebill', () => {
  assert.equal(classifyInvoice(A, [A, B]).classification, 'primary');
  assert.equal(classifyInvoice(B, [A, B]).classification, 'rebill');
});

test('array order does not decide it — Primus issueDate does', () => {
  // Deriving "first one I've seen" from local state misclassifies whenever a backfill runs out of
  // order or the primary predates go-live.
  assert.equal(classifyInvoice(A, [B, A]).classification, 'primary');
  assert.equal(classifyInvoice(B, [B, A]).classification, 'rebill');
});

test('NEGATIVE: no BOLNumber holds rather than guessing', () => {
  const r = classifyInvoice({ invoiceId: '1', shipment: {} }, []);
  assert.equal(r.classification, 'hold');
  assert.match(r.reason, /no BOLNumber/);
});

test('NEGATIVE: an invoice missing from its own sibling set holds', () => {
  // The primary not being in the ledger/poll is exactly when a rebill would be mistaken for one.
  const r = classifyInvoice(B, [A]);
  assert.equal(r.classification, 'hold');
  assert.match(r.reason, /not present in its own sibling set/);
  assert.equal(classifyInvoice(A, []).classification, 'hold');
});

test('NEGATIVE: an undated sibling makes ordering undecidable — hold, not a coin flip', () => {
  const undated = inv('999', '160133034', null);
  const r = classifyInvoice(A, [A, undated]);
  assert.equal(r.classification, 'hold');
  assert.match(r.reason, /no issueDate/);
});

test('siblings on OTHER BOLs are ignored', () => {
  const other = inv('777', '160199999', '2026-01-01 00:00:00');
  assert.equal(classifyInvoice(A, [A, other]).classification, 'primary', 'earlier date, different BOL');
});

test('ties on issueDate fall back to invoiceId — deterministic either way', () => {
  const x = inv('111', 'B', '2026-06-20 10:00:00');
  const y = inv('222', 'B', '2026-06-20 10:00:00');
  assert.equal(classifyInvoice(x, [x, y]).classification, 'primary');
  assert.equal(classifyInvoice(y, [y, x]).classification, 'rebill');
});

test('VOID-AWARENESS IS NOT AVAILABLE — recorded, not silently accepted', () => {
  // §4.3 wants a corrected primary (all priors voided) treated as a PRIMARY. The Primus list
  // status object carries no void or cancelled flag — verified live 2026-08-03 — so a corrected
  // primary is currently classified REBILL. Pinned so the gap cannot be forgotten.
  assert.equal(VOID_AWARENESS_AVAILABLE, false);
  assert.equal(classifyInvoice(B, [A, B]).classification, 'rebill',
    'even if A were voided, which we cannot see');
});
