// Layer-3 harness. Builds on evals/layer2/harness.js (real portal.html in jsdom, window.flAnthropic
// seam, recording fetch router). Adds: a parameter-VARYING rate fixture, the live agent driver, a
// _summarizeRatesToChat hook (invariant 2), transcript extraction for the customer, cumulative
// requested-config tracking (invariant 3 ground truth), and the episode + N=3 replay loops.

const path = require('path');
const { boot2, sleep } = require(path.join(__dirname, '..', 'layer2', 'harness'));
const { rateRoute } = require('./ratemodel');
const { installAgentDriver } = require('./agent');
const { buildBanned } = require('./banned');
const { runInvariants } = require('./invariants');

// boot3 — a fresh session. opts.model installs the live agent driver; omit it for the scripted
// smoke path (the caller uses ctx.scriptAI per turn instead).
function boot3(opts) {
  opts = opts || {};
  // The varying rate route must win over layer-2's flat fixture — boot2 puts opts.routes first.
  const ctx = boot2({ routes: [{ match: u => /\/applet\/v1\/rate\/multiple/.test(u), reply: (u) => rateRoute(u) }] });
  const w = ctx.win;
  ctx.seedZips({ '30301': { city: 'Atlanta', state: 'GA', ok: true, reason: 'ok' } });

  ctx.banned = buildBanned();
  ctx._summarizedTurn = false;
  const _origSummarize = w._summarizeRatesToChat;
  w._summarizeRatesToChat = function () { ctx._summarizedTurn = true; try { if (typeof _origSummarize === 'function') return _origSummarize.apply(this, arguments); } catch (e) {} };

  if (opts.model) installAgentDriver(ctx, opts.model);
  ctx.accCodeOf = ctx.g('ACC_CODE_OF');
  return ctx;
}

// Fresh cumulative requested-config (invariant-3 ground truth).
function newRequestedConfig() { return { addCodes: new Set(), removeCodes: new Set(), weight: null, hazmat: null }; }

// Merge a customer intentDelta into the cumulative requested config, mapping human accessorial names
// to codes via the app's OWN map so nothing is hand-maintained.
function mergeIntent(ctx, cfg, intent) {
  intent = intent || {};
  const toCode = name => ctx.accCodeOf[String(name || '').toUpperCase()] || null;
  (intent.addAccessorials || []).forEach(n => { const c = toCode(n); if (c) { cfg.addCodes.add(c); cfg.removeCodes.delete(c); } });
  (intent.removeAccessorials || []).forEach(n => { const c = toCode(n); if (c) { cfg.removeCodes.add(c); cfg.addCodes.delete(c); } });
  if (typeof intent.setWeight === 'number' && intent.setWeight > 0) cfg.weight = intent.setWeight;
  if (typeof intent.hazmat === 'boolean') cfg.hazmat = intent.hazmat;
  return cfg;
}

// Drive one agent turn (real pipeline) and return the per-turn observation for the invariants.
async function agentTurn(ctx, utterance, cfg) {
  const w = ctx.win;
  const rateBefore = ctx.rateRequests().length;
  const msgBefore = ctx.messages.length;
  ctx._summarizedTurn = false;

  w.appendMessage('user', utterance);        // production shows the user's message, then routes it
  try { await w.handleInput(utterance); } catch (e) { /* a thrown turn is itself observable, not fatal */ }
  // Settle: let any deferred (450ms) pull fire and clear the in-flight flag.
  for (let i = 0; i < 80; i++) { let f = false; try { f = !!w._ratePullInFlight; } catch (e) {} if (!f && i > 4) break; await sleep(25); }

  const botMessagesThisTurn = ctx.messages.slice(msgBefore).filter(m => m.role === 'bot').map(m => m.text);
  const newRatePayloads = ctx.rateRequests().slice(rateBefore);
  return {
    requestedConfig: cfg,
    newRatePayloads,
    botMessagesThisTurn,
    summarizedThisTurn: ctx._summarizedTurn,
    banned: ctx.banned,
  };
}

// Run a full episode with a LIVE customer + LIVE agent. Returns findings + the recorded (utterance,
// intent) pairs (for replay) + the transcript + captured payloads.
async function runEpisode(model, persona, askCustomer) {
  const ctx = boot3({ model });
  const cfg = newRequestedConfig();
  const turns = []; // recorded (utterance,intentDelta) for deterministic replay
  const findings = [];
  try {
    for (let t = 0; t < persona.maxTurns; t++) {
      const c = await askCustomer(model, persona, ctx.messages.map(m => ({ role: m.role, text: m.text })));
      turns.push({ utterance: c.utterance, intentDelta: c.intentDelta });
      mergeIntent(ctx, cfg, c.intentDelta);
      const turn = await agentTurn(ctx, c.utterance, cfg);
      runInvariants(ctx, turn).forEach(f => findings.push(Object.assign({ turnIndex: t }, f)));
      if (c.done) break;
    }
  } finally {
    var snapshot = { transcript: ctx.messages.map(m => ({ role: m.role, text: m.text })), rateRequests: ctx.rateRequests(), agentCalls: ctx.agentCalls || [] };
    try { ctx.close(); } catch (e) {}
  }
  return { persona: persona.id, findings, turns, snapshot };
}

// Deterministic replay of a recorded episode (customer no longer improvises — recorded utterances +
// intents are fed in order). Isolates AGENT nondeterminism for the N=3 classification. Returns the
// set of rootKeys that fired on this replay.
async function replayEpisode(model, persona, recordedTurns) {
  const ctx = boot3({ model });
  const cfg = newRequestedConfig();
  const fired = [];
  try {
    for (const rt of recordedTurns) {
      mergeIntent(ctx, cfg, rt.intentDelta);
      const turn = await agentTurn(ctx, rt.utterance, cfg);
      runInvariants(ctx, turn).forEach(f => fired.push(f.rootKey));
    }
  } finally { try { ctx.close(); } catch (e) {} }
  return fired;
}

module.exports = { boot3, newRequestedConfig, mergeIntent, agentTurn, runEpisode, replayEpisode, sleep };
