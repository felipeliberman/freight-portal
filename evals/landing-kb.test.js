'use strict';
// ── Landing agent KB contract (Workstream 2, Option A) ────────────────────────
// Asserts the instruction the landing agent actually receives — knowledgeFor('landing'), the
// SAME text build-worker-kb.js bakes into KB_LANDING — enforces Option A, and that the built
// Worker source matches (so the deployed instruction can't silently drift from KNOWLEDGE.md).
//
//   node evals/landing-kb.test.js

const fs = require('fs');
const path = require('path');
const { knowledgeFor } = require('./knowledge');

const A = { ok(c, m) { if (!c) throw new Error(m); } };
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const landing = knowledgeFor('landing');
const portal = knowledgeFor('portal');

test('landing KB no longer instructs shipment-detail collection for quoting', () => {
  A.ok(!/ask for a few sample lanes/i.test(landing), 'the sample-lanes collection hook survives');
  A.ok(!/Qualifying questions for any quote request/i.test(landing), 'the qualifying-questions intake survives');
  A.ok(!/ask for pallet dims and weight and re-quote/i.test(landing), 'the price-objection dims/weight ask survives');
  A.ok(!/lane details captured/i.test(landing), 'the "lane details captured" close survives');
});

test('landing KB states the account-gate up front and forbids shipment intake', () => {
  A.ok(/Account-first for any quote/i.test(landing), 'the account-first rule is missing');
  A.ok(/live rates require a free portal account/i.test(landing), 'the up-front account-gate disclosure is missing');
  A.ok(/No shipment-detail intake on the landing page/i.test(landing), 'the no-intake rule is missing');
  A.ok(/ZERO shipment specifics for quoting/i.test(landing), 'the zero-shipment-questions rule is missing');
});

test('freight class is never presented as a customer input (any agent)', () => {
  // §3 walkthrough no longer lists freight class among fields the customer enters.
  A.ok(!/enter origin and destination ZIPs.*freight class \(or let us calculate/i.test(landing.replace(/\n/g, ' ')),
    'the §3 walkthrough still lists freight class as a field to enter');
  // The cross-cutting rule is present for BOTH audiences.
  A.ok(/FREIGHT CLASS IS NEVER ASKED/i.test(landing), 'freight-class-never-asked missing from landing KB');
  A.ok(/FREIGHT CLASS IS NEVER ASKED/i.test(portal), 'freight-class-never-asked missing from portal KB');
});

test('no-promise-without-action and accurate-enumerations reach BOTH agents', () => {
  A.ok(/NO PROMISE WITHOUT ACTION/i.test(landing) && /NO PROMISE WITHOUT ACTION/i.test(portal), 'no-promise rule missing from a bundle');
  A.ok(/ACCURATE ENUMERATIONS/i.test(landing) && /ACCURATE ENUMERATIONS/i.test(portal), 'enumeration-accuracy rule missing from a bundle');
});

test('scope split preserved: sales playbook is landing-only', () => {
  A.ok(/Sales playbook/i.test(landing), 'the sales playbook vanished from the landing bundle');
  A.ok(!/Sales playbook/i.test(portal), 'the sales playbook leaked into the portal bundle');
  A.ok(!/Account-first for any quote/i.test(portal), 'the landing account-first rule leaked into the portal bundle');
});

test('the built Worker KB matches KNOWLEDGE.md (deploy chain is in sync)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'anthropic-proxy', 'src', 'index.js'), 'utf8');
  const mL = src.match(/const KB_LANDING = ("(?:[^"\\]|\\.)*");/);
  const mP = src.match(/const KB_PORTAL = ("(?:[^"\\]|\\.)*");/);
  A.ok(mL && mP, 'KB-embed constants not found in the Worker source');
  A.ok(JSON.parse(mL[1]) === landing, 'KB_LANDING in the Worker is stale — run: node evals/build-worker-kb.js');
  A.ok(JSON.parse(mP[1]) === portal, 'KB_PORTAL in the Worker is stale — run: node evals/build-worker-kb.js');
});

let fails = 0;
console.log('\n  LANDING KB CONTRACT — evals/landing-kb.test.js\n');
for (const t of tests) {
  try { t.fn(); console.log('  PASS  ' + t.name); }
  catch (e) { fails++; console.log('  FAIL  ' + t.name + '\n        ' + String(e.message || e)); }
}
console.log('\n  ' + (tests.length - fails) + '/' + tests.length + ' KB checks green\n');
process.exit(fails ? 1 : 0);
