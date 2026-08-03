#!/usr/bin/env node
'use strict';
/**
 * predeploy.js — the gate to run BEFORE deploying the anthropic-proxy Worker or Pages.
 *
 *     node evals/predeploy.js
 *
 * WHY THIS EXISTS. On 2026-08-02 five of five portal-navigation answers were wrong on a real
 * iPhone: the agent named a "Quote" tab, an "Edit" button, a "Rebook" button and an
 * "Update & Requote" button, all removed or hidden by three commits earlier that day. Every check
 * that could have caught it already existed and simply was not run —
 * evals/landing-kb.test.js had been failing ("KB_LANDING in the Worker is stale") through the
 * whole period, because nothing invoked it. A failing test nobody runs is worth exactly as much as
 * a "GENERATED FROM portal.html" header nobody honours.
 *
 * So this is deliberately NOT a new test. It is one command that runs the checks that already
 * exist, fails loudly on the first one that breaks, and prints the fix. Nothing here needs
 * credentials or network — it is safe to run on any machine at any time.
 *
 * Checks, in the order a stale deploy actually breaks:
 *   1. layer2 case 53   — KNOWLEDGE.md §12 nav labels still match portal.html (source-level drift)
 *   2. landing-kb.test  — scope split, white-glove non-disclosure, and Worker-vs-KNOWLEDGE.md sync
 *
 * If (2) reports the Worker KB is stale, that is the deploy chain out of sync — run:
 *     node evals/build-worker-kb.js && (cd anthropic-proxy && wrangler deploy)
 */
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = 0;

function section(title) { console.log('\n── ' + title + ' ' + '─'.repeat(Math.max(0, 66 - title.length))); }

async function main() {
  // ── 1. Source-level KB/portal drift ────────────────────────────────────────
  section('KB nav labels vs portal.html (layer2 case 53)');
  try {
    const { cases } = require('./layer2/cases');
    const c = cases.find((x) => x && x.id === 53);
    if (!c) throw new Error('layer2 case 53 (kb-nav-labels-match-portal) is missing — it is the drift guard');
    await c.run();                       // AWAITED: run() is async, and a floating promise here
    console.log('  PASS  ' + c.name);    // reported nothing at all on the first version of this file
  } catch (e) {
    failed++;
    console.log('  FAIL  ' + (e && e.message ? e.message : e));
  }

  // ── 2. KB contract + deploy-chain sync ─────────────────────────────────────
  section('KB contract + deploy chain (landing-kb.test.js)');
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, 'landing-kb.test.js')], { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write(out.replace(/^/gm, '  ').replace(/^\s+$/gm, ''));
  } catch (e) {
    failed++;
    process.stdout.write(String((e && e.stdout) || '').replace(/^/gm, '  '));
    console.log('\n  → The KB contract is broken. If the message says the Worker KB is stale, run:');
    console.log('      node evals/build-worker-kb.js && (cd anthropic-proxy && wrangler deploy)');
  }

  console.log('');
  if (failed) {
    console.log('PRE-DEPLOY GATE: FAILED — do not deploy until the above is green.\n');
    process.exit(1);
  }
  console.log('PRE-DEPLOY GATE: all checks green — safe to build and deploy.\n');
}

main();
