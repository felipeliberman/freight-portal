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

// ── Invariant 5 — answer-or-re-ask ─────────────────────────────────────────────────────────────
// A gate question the customer poses an answer to must be answered or re-asked — never assumed. The
// enforceable deterministic instance is the cargo-insurance gate (it has a deterministic ask AND a
// settlement state): if the ask was pending coming into this turn, the customer's message did NOT
// address insurance, and yet the insurance decision was recorded settled WITHOUT the ask being
// re-posed, the agent assumed the answer (typically an assumed decline → uninsured freight). Harm
// ranks with wrong price. The per-turn signals are computed in the harness (agentTurn).
function invAnswerOrReask(ctx, turn) {
  if (!turn.insAskOpenBefore) return null;   // the insurance gate was not awaiting an answer
  if (turn.insAnsweredThisTurn) return null; // the customer addressed insurance — fine
  if (turn.insReAskedThisTurn) return null;  // the agent re-asked — fine
  if (!turn.insSettledNow) return null;      // nothing assumed — still legitimately pending
  return {
    invariant: 'answer-or-reask', harm: HARM.WRONG_PRICE, rootKey: 'unanswered-gate-assumed-settled',
    summary: 'a gate question the customer never answered was recorded as settled without being re-asked',
    detail: 'the cargo-insurance question was pending; the customer did not address insurance this turn; yet the insurance decision was settled without a re-ask (an assumed decline → uninsured freight)',
    evidence: { insAskOpenBefore: true, answeredThisTurn: false, reAskedThisTurn: false, settled: true },
  };
}

// ── Invariant 6 — no unrequested accessorial in the pull ───────────────────────────────────────
// Every customer-controlled accessorial in the outbound pull must trace to a customer request
// (requestedConfig.addCodes) or to a documented automatic rule (residential established in the
// customer's OWN words → RSD, and its mandatory liftgate). Anything else is an over-quote (customer
// harm: wrong price). Residential establishment is read from the TRANSCRIPT, never from
// window._residentialStatus — the prose-backing path (portal.html ~14185) sets that flag from a mere
// agent claim, which is precisely the over-quote this invariant exists to catch.
const CONTROLLED_ACC = new Set(['RSD', 'RSO', 'LFD', 'LFO', 'IND', 'INO', 'LAD', 'LAO', 'APD']);
function invUnrequestedAccessorial(ctx, turn) {
  const pulls = turn.newRatePayloads;
  if (!pulls.length) return null;
  const p = pulls[pulls.length - 1];
  const requested = turn.requestedConfig.addCodes;
  const ct = String(turn.customerText || '').toLowerCase();
  const saysBusiness = /\b(business|commercial|warehouse|loading dock|has a dock|company|office|storefront|distribution center)\b/.test(ct);
  const saysResidence = /\b(residence|residential|a home|to a home|my home|a house|to a house|apartment|\bapt\b|condo|townhouse|house address|home address)\b/.test(ct);
  const resEstablished = saysResidence && !saysBusiness;
  const unrequested = [];
  (p.accessorials || []).forEach(code => {
    if (!CONTROLLED_ACC.has(code)) return;                            // INS/HZM/etc have their own gates
    if (requested.has(code)) return;                                  // the customer asked for it
    if ((code === 'RSD' || code === 'LFD') && resEstablished) return; // documented residential rule
    unrequested.push(code);
  });
  if (!unrequested.length) return null;
  return {
    invariant: 'no-unrequested-accessorial', harm: HARM.WRONG_PRICE, rootKey: 'unrequested-accessorial-in-pull',
    summary: 'the outbound pull carried an accessorial the customer never requested',
    detail: 'unrequested accessorial(s) in the pull: ' + unrequested.join(', ') + ' (customer requested: ' + ([...requested].join(', ') || 'none') + '; residential established in transcript: ' + resEstablished + ')',
    evidence: { unrequested, requested: [...requested], payloadAccessorials: p.accessorials, resEstablished, payloadUrl: p.url },
  };
}

// WRONG_PRICE-tier checks first (they order the same in the report, but keep the source grouped).
const CHECKS = [invChangeProp, invUnrequestedAccessorial, invAnswerOrReask, invFreshness, invNoInternals, invSingleAsk];

function runInvariants(ctx, turn) {
  const out = [];
  for (const fn of CHECKS) { try { const r = fn(ctx, turn); if (r) out.push(r); } catch (e) { /* invariant crash is not a portal finding */ } }
  return out;
}

module.exports = { runInvariants, HARM };
