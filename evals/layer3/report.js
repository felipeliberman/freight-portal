// Findings report. Groups by ROOT CAUSE (not one row per symptom), ranks by customer harm (wrong
// price / false claim first, cosmetics last), carries the REAL/INTERMITTENT/FLAKE classification and
// the model version + date, and repeats the "what this does NOT catch" honesty in every report.

const HARM_LABEL = { 1: 'wrong price / false claim', 2: 'stale rates presented', 3: 'internal leak', 4: 'duplicate gate ask', 9: 'cosmetic' };

// Layer-3 scope caveats — kept in the report so a green run is never mistaken for a proof.
const WONT_CATCH = [
  'Fabricated rationales (inventing carrier/pricing explanations) — Inv-1 judge is phase 2, gated on a hand-labeled calibration set.',
  'Prose quality (tone, clarity, verbosity) — by design: state and payloads only.',
  'Real-Primus-specific behavior — the rate fixture varies by parameters but is not Primus (real lane rejects, true accessorial pricing, transit times).',
  'Timing/concurrency bugs needing real latency — jsdom fixtures resolve fast.',
  'web_search / terminal-lookup paths — stripped from the agent tools this suite.',
  'Booking / dispatch / tracking / invoices — unless a persona drives there (seed personas stay in quote->rate).',
  'The prose half of Inv-4 (narrating internal gating/hold mechanics) — needs the phase-2 judge.',
  'Whatever the customer model did not think to try, and anything a future model version changes.',
];

// Group flat findings (each carrying persona/episode/turnIndex + classification) by rootKey.
function groupFindings(findings) {
  const byKey = new Map();
  for (const f of findings) {
    if (!byKey.has(f.rootKey)) byKey.set(f.rootKey, { rootKey: f.rootKey, invariant: f.invariant, harm: f.harm, summary: f.summary, occurrences: [] });
    byKey.get(f.rootKey).occurrences.push(f);
  }
  const groups = [...byKey.values()];
  // Worst harm first; within a harm tier, more occurrences first.
  groups.sort((a, b) => (a.harm - b.harm) || (b.occurrences.length - a.occurrences.length));
  return groups;
}

function bucketCounts(findings) {
  const c = { REAL: 0, INTERMITTENT: 0, FLAKE: 0, UNCLASSIFIED: 0 };
  findings.forEach(f => { c[(f.classification && f.classification.bucket) || 'UNCLASSIFIED']++; });
  return c;
}

function renderMarkdown(rep) {
  const L = [];
  L.push('# Layer-3 adversarial persona run — findings');
  L.push('');
  L.push('- **Date:** ' + rep.meta.date);
  L.push('- **Agent model:** ' + (rep.meta.agentModels.join(', ') || 'n/a') + '  ·  **Customer model:** ' + rep.meta.customerModel);
  L.push('- **Mode:** ' + rep.meta.mode + '  ·  **Personas × episodes × turns:** ' + rep.meta.scope);
  L.push('- **Replays for classification:** N=' + rep.meta.replayN + ' (REAL ≥2/3 · INTERMITTENT 1/3 · FLAKE 0/3)');
  if (rep.meta.cost != null) L.push('- **Est. API spend:** $' + rep.meta.cost.toFixed(2) + '  ·  **Model calls:** ' + rep.meta.calls);
  L.push('');

  const groups = groupFindings(rep.findings);
  const bc = bucketCounts(rep.findings);
  L.push('## Summary');
  L.push('');
  L.push(rep.findings.length + ' finding(s) across ' + groups.length + ' root-cause group(s) — ' +
    'REAL ' + bc.REAL + ' · INTERMITTENT ' + bc.INTERMITTENT + ' · FLAKE ' + bc.FLAKE + (bc.UNCLASSIFIED ? ' · unclassified ' + bc.UNCLASSIFIED : '') + '.');
  if (!rep.findings.length) L.push('No invariant violations observed in this run. (A clean run is evidence, not proof — see scope below.)');
  L.push('');

  if (groups.length) {
    L.push('## Findings by root cause (worst customer-harm first)');
    L.push('');
    groups.forEach((g, i) => {
      L.push('### ' + (i + 1) + '. ' + g.rootKey + '  —  ' + (HARM_LABEL[g.harm] || 'harm ' + g.harm));
      L.push('');
      L.push('- **Invariant:** ' + g.invariant);
      L.push('- **What it means:** ' + g.summary);
      L.push('- **Occurrences:** ' + g.occurrences.length);
      g.occurrences.forEach(o => {
        const cls = o.classification ? (o.classification.bucket + ' (' + o.classification.observed + ')') : 'unclassified';
        L.push('  - persona ' + o.persona + ', episode ' + o.episode + ', turn ' + o.turnIndex + ' — **' + cls + '** — ' + o.detail);
      });
      // One representative dump.
      const rep0 = g.occurrences[0];
      L.push('');
      L.push('  <details><summary>Representative evidence (persona ' + rep0.persona + ', ep ' + rep0.episode + ', turn ' + rep0.turnIndex + ')</summary>');
      L.push('');
      L.push('  Captured payload / state:');
      L.push('');
      L.push('  ```json');
      L.push('  ' + JSON.stringify(rep0.evidence, null, 2).split('\n').join('\n  '));
      L.push('  ```');
      if (rep0.transcript) {
        L.push('');
        L.push('  Transcript:');
        L.push('');
        L.push('  ```');
        rep0.transcript.forEach(m => L.push('  ' + (m.role === 'user' ? 'Customer: ' : 'Agent: ') + m.text));
        L.push('  ```');
      }
      L.push('  </details>');
      L.push('');
    });
  }

  L.push('## What this run did NOT check (scope — a green run is not a proof)');
  L.push('');
  WONT_CATCH.forEach(w => L.push('- ' + w));
  L.push('');
  return L.join('\n');
}

module.exports = { groupFindings, bucketCounts, renderMarkdown, WONT_CATCH, HARM_LABEL };
