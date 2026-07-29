// Phase-1 deterministic invariants. Each runs AFTER an agent turn and asserts on STATE and CAPTURED
// PAYLOADS only — never on agent wording. Returns a finding object on violation, or null.
// Harm ranks (lower = worse) drive report ordering: wrong price / false claim first, cosmetics last.

const { scanMessage } = require('./banned');

const HARM = { WRONG_PRICE: 1, STALE_RATES: 2, INTERNALS: 3, DUP_ASK: 4, VERBOSITY: 9 };

// ── Invariant 3 — change propagation ─────────────────────────────────────────────────────────
// When a new /rate/multiple went out this turn, its payload must reflect the cumulative requested
// config: agreed codes present, removed codes absent, requested weight reflected. A dropped agreed
// code is the RSD/RSO under-quote class (customer harm: wrong price).
function invChangeProp(ctx, turn) {
  const pulls = turn.newRatePayloads;
  if (!pulls.length) return null; // agent did not pull this turn — nothing to check
  const p = pulls[pulls.length - 1]; // the pull the agent is presenting
  const have = new Set(p.accessorials);
  const missing = [...turn.requestedConfig.addCodes].filter(c => !have.has(c));
  const leftover = [...turn.requestedConfig.removeCodes].filter(c => have.has(c));
  const problems = [];
  if (missing.length) problems.push('agreed accessorial(s) dropped from the pull: ' + missing.join(', '));
  if (leftover.length) problems.push('removed accessorial(s) still in the pull: ' + leftover.join(', '));
  if (turn.requestedConfig.weight != null) {
    const w = (p.freightInfo || []).reduce((a, it) => a + (Number(it.weight) || 0), 0);
    if (w && Math.abs(w - turn.requestedConfig.weight) > 0.5) problems.push('requested weight ' + turn.requestedConfig.weight + ' not reflected (payload weight ' + w + ')');
  }
  if (!problems.length) return null;
  return {
    invariant: 'change-propagation', harm: HARM.WRONG_PRICE, rootKey: 'agreed-config-dropped-on-pull',
    summary: 'the outbound rate pull did not match the agreed configuration',
    detail: problems.join('; '),
    evidence: { requestedAdd: [...turn.requestedConfig.addCodes], requestedRemove: [...turn.requestedConfig.removeCodes], payloadAccessorials: p.accessorials, payloadUrl: p.url },
  };
}

// ── Invariant 2 — freshness ──────────────────────────────────────────────────────────────────
// If the agent presented rates this turn (the deterministic _summarizeRatesToChat fired) while the
// current rate-parameter signature no longer matches the signature of the on-screen rates, it is
// reporting STALE rates as the answer. Reuses _rateParamSig / _lastRatesSig from portal.html.
function invFreshness(ctx, turn) {
  if (!turn.summarizedThisTurn) return null;
  let cur = null, last = null;
  try { cur = ctx.g('_rateParamSig()'); } catch (e) {}
  try { last = ctx.g('window._lastRatesSig'); } catch (e) {}
  if (last == null || cur == null || cur === last) return null;
  return {
    invariant: 'freshness', harm: HARM.STALE_RATES, rootKey: 'stale-rates-presented',
    summary: 'rates were presented that were pulled with out-of-date parameters',
    detail: 'current parameter signature differs from the signature of the rates on screen',
    evidence: { currentSig: cur, presentedSig: last },
  };
}

// ── Invariant 4 — no internals ───────────────────────────────────────────────────────────────
// Customer-facing text must contain no internal accessorial codes or backend/proxy names. The
// banned set is DERIVED from the source code sets (see banned.js).
function invNoInternals(ctx, turn) {
  const offenders = [];
  turn.botMessagesThisTurn.forEach(text => {
    const hits = scanMessage(text, turn.banned);
    if (hits.length) offenders.push({ text, hits });
  });
  if (!offenders.length) return null;
  return {
    invariant: 'no-internals', harm: HARM.INTERNALS, rootKey: 'internal-token-leaked',
    summary: 'a customer-facing message leaked an internal code or backend name',
    detail: offenders.map(o => o.hits.map(h => h.kind + ':' + h.token).join(',')).join(' | '),
    evidence: { offenders },
  };
}

// ── Single-ask ───────────────────────────────────────────────────────────────────────────────
// A deterministic gate question (the cargo-insurance ask) must not be duplicated in the same turn.
const INS_ASK = /would you like to add cargo insurance/i;
function invSingleAsk(ctx, turn) {
  const asks = turn.botMessagesThisTurn.filter(t => INS_ASK.test(t));
  if (asks.length <= 1) return null;
  return {
    invariant: 'single-ask', harm: HARM.DUP_ASK, rootKey: 'insurance-ask-duplicated',
    summary: 'the cargo-insurance question was asked more than once in one turn',
    detail: asks.length + ' insurance asks in a single agent turn',
    evidence: { count: asks.length },
  };
}

const CHECKS = [invChangeProp, invFreshness, invNoInternals, invSingleAsk];

function runInvariants(ctx, turn) {
  const out = [];
  for (const fn of CHECKS) { try { const r = fn(ctx, turn); if (r) out.push(r); } catch (e) { /* invariant crash is not a portal finding */ } }
  return out;
}

module.exports = { runInvariants, HARM };
