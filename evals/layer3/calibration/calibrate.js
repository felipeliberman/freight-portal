#!/usr/bin/env node
// Phase-2 calibration GATE for the Inv-1 (claim/state) judge. The judge is not built yet; this
// harness exists now so labels can be added (in labels.json) without touching judge code, and so the
// gate is wired the moment the judge lands.
//
// Contract: a judge module at ./judge exporting `async classifyClaim({agentText, formState}) ->
// 'TRUE' | 'FALSE'` must score the labeled calibration set at >= THRESHOLD before its findings may
// count in any report. Until it exists, this reports label-set readiness only.
//
//   node evals/layer3/calibration/calibrate.js
//
const fs = require('fs');
const path = require('path');

const THRESHOLD = 1.0; // must get every labeled example right before the judge is trusted
const LABELS = fs.existsSync(path.join(__dirname, 'labels.json'))
  ? path.join(__dirname, 'labels.json')
  : path.join(__dirname, 'labels.sample.json');

function load() {
  const raw = JSON.parse(fs.readFileSync(LABELS, 'utf8'));
  const entries = raw.entries || [];
  const labeled = entries.filter(e => e.label === 'TRUE' || e.label === 'FALSE');
  const unlabeled = entries.filter(e => e.label == null);
  return { entries, labeled, unlabeled, file: LABELS };
}

async function main() {
  const { entries, labeled, unlabeled, file } = load();
  console.log('Inv-1 judge calibration');
  console.log('  labels file: ' + path.relative(process.cwd(), file));
  console.log('  entries: ' + entries.length + ' (' + labeled.length + ' labeled, ' + unlabeled.length + ' unlabeled)');

  let judge = null;
  try { judge = require('./judge'); } catch (e) { judge = null; }
  if (!judge || typeof judge.classifyClaim !== 'function') {
    console.log('\n  Judge: NOT BUILT (phase 2). The gate is wired; add ./judge.js exporting');
    console.log('  classifyClaim({agentText, formState}) and re-run to score it.');
    console.log('  To label: copy labels.sample.json -> labels.json and set each "label" to TRUE/FALSE.');
    process.exit(0);
  }

  if (!labeled.length) { console.log('\n  No labeled examples yet — cannot gate. Label labels.json first.'); process.exit(1); }
  let correct = 0;
  for (const e of labeled) {
    const got = await judge.classifyClaim({ agentText: e.agentText, formState: e.formState });
    const ok = got === e.label;
    if (ok) correct++;
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + e.id + '  (judge=' + got + ' label=' + e.label + ')');
  }
  const acc = correct / labeled.length;
  console.log('\n  accuracy ' + (acc * 100).toFixed(0) + '% (' + correct + '/' + labeled.length + '); gate threshold ' + (THRESHOLD * 100) + '%');
  console.log('  Judge is ' + (acc >= THRESHOLD ? 'TRUSTED — Inv-1 findings may count.' : 'NOT TRUSTED — Inv-1 findings must be suppressed.'));
  process.exit(acc >= THRESHOLD ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
