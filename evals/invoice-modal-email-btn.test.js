#!/usr/bin/env node
'use strict';
/**
 * The Email Invoice button is REMOVED from the invoice detail modal.
 *
 *     node evals/invoice-modal-email-btn.test.js
 *
 * WHY. It never worked. `_lastInvoiceSend` is referenced three times and declared nowhere, so the
 * handler threw `ReferenceError` on its first statement and never reached the send. `git log -S`
 * returns exactly ONE commit touching the identifier — the same commit that ADDED portal.html — so
 * it was born broken and has never sent an invoice in any deployed version.
 *
 * The failure was SILENT: no dialog, no user-facing error, the button simply did nothing. That is
 * why it survived on a live site for 57 days.
 *
 * It is removed rather than repaired because the new invoice pipeline (spec §8.878) replaces its
 * purpose: customers receive an invoice email with a link, and forwarding that email is the
 * forwarding story. A repaired button would be a second send path with different copy, no send log,
 * and no link — three things the new design exists to fix.
 *
 * ── WHICH RED IS WHICH ───────────────────────────────────────────────────────────────────────
 *
 * Assertion 1 is RED BY DEFECT on HEAD: the button is present, so the test fails against
 * unmodified source and its failure IS the thing being removed. Assertions 2-4 are NEGATIVE
 * CONTROLS — they pass on HEAD and must keep passing, because the risk in a deletion is cutting
 * too much, not too little.
 */

const fs = require('fs');
const path = require('path');
const { boot } = require('./state/harness');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n         ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const PORTAL = fs.readFileSync(path.join(__dirname, '..', 'portal.html'), 'utf8');

/** The minimum an invoice needs to render the detail modal. */
const INV = {
  invoiceNumber: '141604', BOLNumber: '160133693', total: 273.57,
  invoiceDueDate: '2026-08-12', issueDate: '2026-07-13',
  _bolId: '1362360734',
  _shipment: { BOLId: '1362360734', BOLNumber: '160133693' },
};

(async function main() {
  console.log('\nEmail Invoice button — removed from the invoice detail modal\n');

  const ctx = boot();
  const w = ctx.win;
  assert(typeof w.showInvoiceDetail === 'function', 'showInvoiceDetail is not defined');
  w.showInvoiceDetail(INV);
  // The real id is `inv-detail-overlay`. NO FALLBACK TO document.body: in jsdom the body
  // contains the inlined app script, so a fallback scans SOURCE TEXT and a comment mentioning
  // the button would fail an assertion about RENDERED markup. Assert the overlay exists
  // instead, so a missing modal is a loud failure rather than a silently wider search.
  const overlay = w.document.getElementById('inv-detail-overlay');
  assert(overlay, 'showInvoiceDetail did not render its overlay');

  // 1 ─ RED BY DEFECT on HEAD. The button exists there; this failing is the point.
  check('RED-BY-DEFECT: #inv-email-btn is absent from the rendered modal', () => {
    assert(!overlay.querySelector('#inv-email-btn'),
      'the Email Invoice button is still rendered — it has never worked and is being removed');
  });

  check('no "Email Invoice" label remains in the rendered modal', () => {
    assert(!/Email Invoice/i.test(overlay.innerHTML),
      'the label survives the button — a dead affordance is worse than none');
  });

  // 2 ─ NEGATIVE CONTROLS. The risk in a deletion is cutting too much.
  check('NEGATIVE CONTROL: the other two buttons survive', () => {
    assert(overlay.querySelector('#inv-detail-dl-btn'), 'Download Invoice was removed too');
    assert(overlay.querySelector('#inv-view-ship-btn'), 'View Shipment was removed too');
  });

  check('NEGATIVE CONTROL: sendViaEmail SURVIVES — it has other callers and step 6 needs it', () => {
    assert(typeof w.sendViaEmail === 'function',
      'sendViaEmail was deleted. It is the transport for the support-request path (two call sites) ' +
      'and it is what the new invoice send path will use.');
  });

  // 3 ─ SOURCE. The orphan is the point: a handler with no button, or a variable with no handler.
  check('SOURCE: _lastInvoiceSend is gone entirely — no orphaned reference', () => {
    const hits = (PORTAL.match(/_lastInvoiceSend/g) || []).length;
    assert(hits === 0,
      hits + ' reference(s) to _lastInvoiceSend remain. It was never declared; every use was inside ' +
      'the handler being removed, so none should survive it.');
  });

  check('SOURCE: no orphaned handler wiring for a button that no longer exists', () => {
    assert(!/inv-email-btn/.test(PORTAL),
      'a querySelector or handler still references #inv-email-btn');
  });

  ctx.dom.window.close();
  console.log('\n' + (failures ? failures + ' FAILING' : 'all passing') + '\n');
  process.exit(failures ? 1 : 0);
})();
