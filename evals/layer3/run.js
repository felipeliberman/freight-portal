#!/usr/bin/env node
// Layer-3 runner. Real mode drives live customer + agent models against real portal.html and
// classifies every finding via N=3 deterministic replay (REAL/INTERMITTENT/FLAKE). Requires
// ANTHROPIC_API_KEY. This is a NIGHTLY / pre-release suite — never per-diff.
//
//   ANTHROPIC_API_KEY=... node evals/layer3/run.js [--persona=A] [--episodes=1] [--replay=3]
//   node evals/layer3/run.js --smoke     # no key: crafted self-test of the invariants + report
//
// Smoke mode does NOT call a model and does NOT discover bugs — it feeds CRAFTED inputs to the real
// invariants against real portal.html to prove the checks fire and the report renders.

const fs = require('fs');
const path = require('path');
const { boot3, runEpisode, replayEpisode } = require('./harness');
const { runInvariants } = require('./invariants');
const personas = require('./personas');
const { renderMarkdown } = require('./report');

// Teardown guard (jsdom page async after window.close()).
process.on('unhandledRejection', () => {});

const args = process.argv.slice(2);
const arg = (k, d) => { const a = args.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const SMOKE = args.includes('--smoke');
const REPLAY_N = Number(arg('replay', '3'));
const EPISODES = Number(arg('episodes', '1'));
const PERSONA = arg('persona', null);
const OUTDIR = path.join(__dirname, 'report');

function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }
// Writes to `base` (a fixed path per run) so partial reports OVERWRITE one file — a mid-run crash
// still leaves the latest completed-episode report on disk. base is computed once per run.
function writeReport(rep, base) {
  if (!fs.existsSync(OUTDIR)) fs.mkdirSync(OUTDIR, { recursive: true });
  base = base || path.join(OUTDIR, 'findings-' + stamp());
  const md = renderMarkdown(rep);
  fs.writeFileSync(base + '.md', md);
  fs.writeFileSync(base + '.json', JSON.stringify(rep, null, 2));
  return { md, base };
}

// ── SMOKE: crafted invariant self-test against real portal.html (no model) ──────────────────────
async function smoke() {
  const ctx = boot3({}); // no model
  const findings = [];
  const push = (persona, episode, turnIndex, arr, transcript) => arr.forEach(f => findings.push(Object.assign({ persona, episode, turnIndex, transcript, classification: { bucket: 'SELFTEST', observed: 'crafted' } }, f)));

  // (1) change-propagation: agreed RSD+LFD but the pull carried only LFD -> DROP must fire.
  push('SELFTEST', 0, 0, runInvariants(ctx, {
    requestedConfig: { addCodes: new Set(['RSD', 'LFD']), removeCodes: new Set(), weight: null },
    newRatePayloads: [{ url: '/applet/v1/rate/multiple?accessorialsList[]=LFD', accessorials: ['LFD'], freightInfo: [{ weight: 450 }] }],
    botMessagesThisTurn: ['53 options came back.'], summarizedThisTurn: false, banned: ctx.banned,
  }), null);

  // (2) no-internals: a customer-facing message leaking a backend name + an internal code.
  push('SELFTEST', 0, 1, runInvariants(ctx, {
    requestedConfig: { addCodes: new Set(), removeCodes: new Set(), weight: null }, newRatePayloads: [],
    botMessagesThisTurn: ['Your Primus quote with RSD applied is on the right.'],
    summarizedThisTurn: false, banned: ctx.banned,
  }), null);

  // (3) single-ask: the cargo-insurance question asked twice in one turn.
  push('SELFTEST', 0, 2, runInvariants(ctx, {
    requestedConfig: { addCodes: new Set(), removeCodes: new Set(), weight: null }, newRatePayloads: [],
    botMessagesThisTurn: ['Would you like to add cargo insurance?', 'One last thing — would you like to add cargo insurance?'],
    summarizedThisTurn: false, banned: ctx.banned,
  }), null);

  // (4) freshness: a REAL pull sets _lastRatesSig; then change the form so _rateParamSig differs;
  //     a summarize this turn must be flagged stale. Uses the real signatures from portal.html.
  const w = ctx.win;
  w._suppressQuoteAutoRun = true;
  w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
  w._insDecided = true;
  try { await w._doGetRates(); } catch (e) {}
  for (let i = 0; i < 40 && (!w._lastRatesSig); i++) await require('./harness').sleep(25);
  w._applyQuoteFields({ addAccessorials: ['RSD'] }); // form now differs from the settled rates' signature
  push('SELFTEST', 0, 3, runInvariants(ctx, {
    requestedConfig: { addCodes: new Set(), removeCodes: new Set(), weight: null }, newRatePayloads: [],
    botMessagesThisTurn: ['Cheapest is Forward Air at $241.13.'], summarizedThisTurn: true, banned: ctx.banned,
  }), null);

  try { ctx.close(); } catch (e) {}
  const rep = {
    meta: { date: new Date().toISOString(), agentModels: [], customerModel: 'none (crafted)', mode: 'SMOKE — crafted invariant self-test against real portal.html; NOT a live model run and NOT a discovered bug', scope: 'self-test', replayN: REPLAY_N, cost: 0, calls: 0 },
    findings,
  };
  const { md, base } = writeReport(rep);
  console.log(md);
  console.log('\n[smoke report written to ' + path.relative(process.cwd(), base) + '.md]');
  process.exit(0);
}

// ── REAL: live customer + agent, N=3 replay classification ──────────────────────────────────────
async function real(apiKey) {
  const { makeLiveModel } = require('./model');
  const { askCustomer } = require('./customer');
  const model = makeLiveModel(apiKey, { label: 'sonnet-4-6' });
  const list = (PERSONA ? personas.filter(p => p.id === PERSONA) : personas);
  const planned = list.length * EPISODES;
  const allFindings = [];
  const runErrors = [];
  let completed = 0;
  // One fixed base for the whole run; partial reports overwrite it after every episode.
  const base = path.join(OUTDIR, 'findings-' + stamp());
  const buildRep = partial => ({
    meta: {
      date: new Date().toISOString(), agentModels: [...model.acc.models], customerModel: 'claude-sonnet-4-6',
      mode: 'LIVE' + (partial ? ' — PARTIAL' : ''), scope: list.length + ' personas × ' + EPISODES + ' episodes',
      replayN: REPLAY_N, cost: model.acc.cost, calls: model.acc.calls, retries: model.acc.retries,
      partial: partial, completedEpisodes: completed, plannedEpisodes: planned, runErrors: runErrors,
    },
    findings: allFindings,
  });
  const flush = partial => { try { writeReport(buildRep(partial), base); } catch (e) {} };

  for (const persona of list) {
    for (let ep = 0; ep < EPISODES; ep++) {
      try {
        const res = await runEpisode(model, persona, askCustomer);
        if (res.findings.length) {
          // Classify each distinct rootKey in this episode via N=3 replay; a replay failure leaves
          // the finding UNCLASSIFIED (kept, not dropped) and is recorded as a run error.
          const keys = [...new Set(res.findings.map(f => f.rootKey))];
          const rate = {};
          for (const k of keys) {
            try {
              let hit = 0;
              for (let r = 0; r < REPLAY_N; r++) { const fired = await replayEpisode(model, persona, res.turns); if (fired.includes(k)) hit++; }
              rate[k] = hit;
            } catch (e) { runErrors.push({ persona: persona.id, episode: ep, error: 'replay(' + k + '): ' + String(e && e.message || e) }); }
          }
          res.findings.forEach(f => {
            const hit = rate[f.rootKey];
            const bucket = hit == null ? 'UNCLASSIFIED' : (hit >= 2 ? 'REAL' : (hit === 1 ? 'INTERMITTENT' : 'FLAKE'));
            allFindings.push(Object.assign({ persona: persona.id, episode: ep, transcript: res.snapshot.transcript, classification: { bucket, observed: hit == null ? 'replay failed' : hit + '/' + REPLAY_N } }, f));
          });
        }
      } catch (e) {
        // One episode failing (e.g. a live-model error after retries) must not abort the whole run.
        runErrors.push({ persona: persona.id, episode: ep, error: String(e && e.message || e) });
        console.error('episode failed (persona ' + persona.id + ', ep ' + ep + '): ' + String(e && e.message || e));
      }
      completed++;
      flush(completed < planned); // overwrite the partial after every episode; final is written below
    }
  }

  const { md } = writeReport(buildRep(false), base);
  console.log(md);
  console.log('\n[report written to ' + path.relative(process.cwd(), base) + '.md]' + (runErrors.length ? '  (' + runErrors.length + ' episode error(s) — partials preserved)' : ''));
  process.exit(runErrors.length ? 1 : 0);
}

(async () => {
  if (SMOKE) return smoke();
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log('\nLayer 3 needs a live model. Set ANTHROPIC_API_KEY and run:');
    console.log('  ANTHROPIC_API_KEY=... node evals/layer3/run.js --persona=A --episodes=1\n');
    console.log('Or run the crafted self-test (no key, proves the invariants + report):');
    console.log('  node evals/layer3/run.js --smoke\n');
    process.exit(0);
  }
  return real(key);
})().catch(e => { console.error('layer3 run error:', e && e.stack || e); process.exit(1); });
