#!/usr/bin/env node
'use strict';
/**
 * STEP 1 (spec §8.878 invariant 3, work-queue B7) — ONE document allowlist, ONE place, BOTH
 * consumers reading it, enforced rather than displayed.
 *
 *     node evals/document-allowlist.test.js
 *
 * WHY. The portal filters customer documents with a DENYLIST — `HIDDEN = ['DO','COST','COI']`, twice
 * (`portal.html:8145` and `:24183`) — which §8 rules out: the type codes differ between the two
 * Primus document endpoints, so a denylist built from either is blind to the other, and **any type
 * Primus adds appears to customers by default**. On a ~90% residential book the documents carry
 * consignee home addresses and phone numbers.
 *
 * `invoice-sync/src/documents.js` holds a considered ALLOWLIST for the same question. The two
 * disagree, which is the point: two lists is why they diverged, and picking a winner without
 * collapsing them leaves the identical defect with a tidier symptom.
 *
 * WHAT THIS ASSERTS — properties, not membership. Every check below is decision-free: it turns on
 * "a type not on the canonical list must not reach a customer", never on whether any particular
 * code belongs there. Membership is an owner decision and is deliberately NOT encoded here beyond
 * the two the owner has already given (COI out; BOL in).
 *
 * SCOPE, STATED HONESTLY. This proves the portal's RENDER decision and that one list governs it.
 * It does NOT prove server-side enforcement, because the portal fetches browser→Primus directly and
 * there is no server of ours in that path — that arrives with the new Worker (§8.878, plan step 3).
 * A filter applied in the UI is a display preference, not a control, and this file must not be read
 * as claiming otherwise.
 */

const path = require('path');
const fs = require('fs');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n         ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const PORTAL = fs.readFileSync(path.join(__dirname, '..', 'portal.html'), 'utf8');

(async function main() {
  console.log('\nSTEP 1 — one document allowlist, one place, both consumers\n');

  const docs = await import('../invoice-sync/src/documents.js');

  // 1 ─ the owner's ruling, on the canonical list.
  check('COI is NOT customer-facing (owner ruling 2026-08-10, resolved DOWNWARD)', () => {
    assert(!docs.CUSTOMER_FACING.includes('COI'),
      'COI is still on CUSTOMER_FACING — a certificate can carry policy numbers, limits and broker ' +
      'details that are ours and our carriers\', not the customer\'s');
  });

  // 2 ─ the portal must read the canonical list, not carry a second opinion.
  check('the portal exposes ONE allowlist-based filter', () => {
    const g = global.__portalFilter = null;
    assert(/_customerFacingDocs\s*\(/.test(PORTAL),
      'portal.html has no _customerFacingDocs() — the render decision is still made inline, twice');
  });

  check('the portal carries NO denylist — the mechanism is collapsed, not outvoted', () => {
    const hits = [...PORTAL.matchAll(/const\s+HIDDEN\s*=/g)];
    assert(hits.length === 0,
      hits.length + ' denylist definition(s) remain in portal.html. Picking a winner without ' +
      'collapsing the lists leaves the identical defect with a tidier symptom.');
  });

  // 3 ─ THE PROPERTY. Decision-free: an unknown type is one Primus has not shown us yet.
  check('PROPERTY: a type absent from the canonical list cannot reach a customer', () => {
    const filter = loadPortalFilter();
    const out = filter([
      { type: 'BOL',        url: 'u1' },
      { type: 'ZZNEWTYPE',  url: 'u2' },   // whatever Primus adds next
      { type: '',           url: 'u3' },   // unlabelled
      { type: 'MISDOC',     url: 'u4' },   // the drawer everything ambiguous lands in
    ]);
    const shown = out.map(d => String(d.type || '').toUpperCase());
    assert(!shown.includes('ZZNEWTYPE'), 'an unrecognised type reached the customer — a denylist is blind to what it has not met');
    assert(!shown.includes('MISDOC'), 'MISDOC reached the customer');
    assert(!shown.includes(''), 'an unlabelled document reached the customer');
  });

  // 4 ─ NEGATIVE CONTROL. The fix must not be "hide everything".
  check('NEGATIVE CONTROL: an allowlisted type still reaches the customer', () => {
    const filter = loadPortalFilter();
    const out = filter([{ type: 'BOL', url: 'u1' }]);
    assert(out.length === 1 && String(out[0].type).toUpperCase() === 'BOL',
      'BOL did not survive the filter — the allowlist is too tight, or is not being applied');
  });

  // 5 ─ DRIFT. Two copies is the defect; a copy plus a failing test is a maintained mirror.
  check('DRIFT: the portal\'s list is identical to the canonical list', () => {
    const embedded = extractPortalList();
    assert(embedded, 'no allowlist literal found in portal.html to compare');
    assert(JSON.stringify(embedded) === JSON.stringify([...docs.CUSTOMER_FACING]),
      'portal list ' + JSON.stringify(embedded) + ' != canonical ' + JSON.stringify([...docs.CUSTOMER_FACING]));
  });

  console.log('\n' + (failures ? failures + ' FAILING' : 'all passing') + '\n');
  process.exit(failures ? 1 : 0);
})();

// ── helpers ──────────────────────────────────────────────────────────────────────────────────
// Evaluate the portal's filter in isolation. Deliberately does NOT boot jsdom: the property under
// test is the filtering decision, and loading the whole app would let a DOM failure masquerade as a
// filtering failure.
function loadPortalFilter() {
  const m = PORTAL.match(/function _customerFacingDocs[\s\S]*?\n\}/);
  if (!m) throw new Error('_customerFacingDocs() is not defined in portal.html');
  const listM = PORTAL.match(/var\s+CUSTOMER_FACING_DOCS\s*=\s*(\[[^\]]*\])/);
  if (!listM) throw new Error('CUSTOMER_FACING_DOCS is not defined in portal.html');
  // eslint-disable-next-line no-new-func
  return new Function('var CUSTOMER_FACING_DOCS = ' + listM[1] + ';\n' + m[0] + '\nreturn _customerFacingDocs;')();
}

function extractPortalList() {
  const m = PORTAL.match(/var\s+CUSTOMER_FACING_DOCS\s*=\s*(\[[^\]]*\])/);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/'/g, '"')); } catch (e) { return null; }
}
