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
  ctx._insAskOpen = false; // invariant-5 cross-turn state: is the cargo-insurance ask awaiting an answer?
  const _origSummarize = w._summarizeRatesToChat;
  w._summarizeRatesToChat = function () { ctx._summarizedTurn = true; try { if (typeof _origSummarize === 'function') return _origSummarize.apply(this, arguments); } catch (e) {} };

  if (opts.model) installAgentDriver(ctx, opts.model);
  ctx.accCodeOf = ctx.g('ACC_CODE_OF');
  return ctx;
}

// Fresh cumulative requested-config (invariant-3 ground truth). _lastDelta remembers what the last
// non-probe merge changed, so a stated refusal (Part 3 / Option B) can reverse exactly that.
function newRequestedConfig() { return { addCodes: new Set(), removeCodes: new Set(), weight: null, hazmat: null, _lastDelta: null }; }

// Merge a customer intentDelta into the cumulative requested config, mapping human accessorial names
// to codes via the app's OWN map so nothing is hand-maintained.
function mergeIntent(ctx, cfg, intent) {
  intent = intent || {};
  const toCode = name => ctx.accCodeOf[String(name || '').toUpperCase()] || null;
  // Part 3 (invariant-3 refinement, Option B): a stated refusal or a self-declared probe is NOT an
  // agreed change. The customer model — which alone may read the agent's wording — reconciles the prior
  // turn's outcome here, so invariant 3 stays state/payload-only and never flags a transparent refusal.
  // (A refusal reverses the LAST merged delta; the immediately-prior request is the common case.)
  if (intent.priorRequestOutcome === 'refused' && cfg._lastDelta) {
    const d = cfg._lastDelta;
    (d.added || []).forEach(c => cfg.addCodes.delete(c));
    (d.removed || []).forEach(c => cfg.removeCodes.delete(c));
    if (d.weightChanged) cfg.weight = (d.prevWeight != null ? d.prevWeight : null);
    cfg._lastDelta = null;
  }
  // A probe ("bump the weight to 451 then back, just to force a re-pull") is a test, not a durable
  // target — record nothing so a net-zero request never counts as agreed config.
  if (intent.probe === true) { cfg._lastDelta = null; return cfg; }
  const added = [], removed = []; const prevWeight = cfg.weight; let weightChanged = false;
  (intent.addAccessorials || []).forEach(n => { const c = toCode(n); if (c) { cfg.addCodes.add(c); cfg.removeCodes.delete(c); added.push(c); } });
  (intent.removeAccessorials || []).forEach(n => { const c = toCode(n); if (c) { cfg.removeCodes.add(c); cfg.addCodes.delete(c); removed.push(c); } });
  if (typeof intent.setWeight === 'number' && intent.setWeight > 0) { cfg.weight = intent.setWeight; weightChanged = true; }
  if (typeof intent.hazmat === 'boolean') cfg.hazmat = intent.hazmat;
  cfg._lastDelta = { added, removed, weightChanged, prevWeight };
  return cfg;
}

// Drive one agent turn (real pipeline) and return the per-turn observation for the invariants.
async function agentTurn(ctx, utterance, cfg, intent) {
  const w = ctx.win;
  const rateBefore = ctx.rateRequests().length;
  const msgBefore = ctx.messages.length;
  ctx._summarizedTurn = false;

  // Invariant-5 ground truth (captured BEFORE the turn runs): was the cargo-insurance gate awaiting an
  // answer coming into this turn, and does the customer's message THIS turn address insurance at all?
  const insAskOpenBefore = !!ctx._insAskOpen;
  const insAnsweredThisTurn = !!(intent && intent.insurance) || /insur/i.test(String(utterance || ''));

  w.appendMessage('user', utterance);        // production shows the user's message, then routes it
  try { await w.handleInput(utterance); } catch (e) { /* a thrown turn is itself observable, not fatal */ }
  // Settle: let any deferred (450ms) pull fire and clear the in-flight flag.
  for (let i = 0; i < 80; i++) { let f = false; try { f = !!w._ratePullInFlight; } catch (e) {} if (!f && i > 4) break; await sleep(25); }

  const botMessagesThisTurn = ctx.messages.slice(msgBefore).filter(m => m.role === 'bot').map(m => m.text);
  const newRatePayloads = ctx.rateRequests().slice(rateBefore);
  const insReAskedThisTurn = botMessagesThisTurn.some(x => /would you like to add cargo insurance/i.test(x));
  let insSettledNow = false;
  try { insSettledNow = ctx.g('window._insDecided') === true; } catch (e) {}
  // Carry the insurance-ask open flag to the NEXT turn: a re-ask this turn is open; an already-open ask
  // stays open only until the customer answers it or it settles.
  ctx._insAskOpen = insReAskedThisTurn || (insAskOpenBefore && !insAnsweredThisTurn && !insSettledNow);
  // Invariant-6 ground truth: the customer's OWN words so far (never portal state, which the over-quote
  // path corrupts — see invariants.js invUnrequestedAccessorial).
  const customerText = ctx.messages.filter(m => m.role === 'user').map(m => m.text).join(' ');

  return {
    requestedConfig: cfg,
    newRatePayloads,
    botMessagesThisTurn,
    summarizedThisTurn: ctx._summarizedTurn,
    banned: ctx.banned,
    // invariant-5 signals
    insAskOpenBefore, insAnsweredThisTurn, insReAskedThisTurn, insSettledNow,
    // invariant-6 ground truth
    customerText,
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
      const turn = await agentTurn(ctx, c.utterance, cfg, c.intentDelta);
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
      const turn = await agentTurn(ctx, rt.utterance, cfg, rt.intentDelta);
      runInvariants(ctx, turn).forEach(f => fired.push(f.rootKey));
    }
  } finally { try { ctx.close(); } catch (e) {} }
  return fired;
}

module.exports = { boot3, newRequestedConfig, mergeIntent, agentTurn, runEpisode, replayEpisode, sleep };
