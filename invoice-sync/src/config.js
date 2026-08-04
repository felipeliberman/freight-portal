// Mode resolution and secret selection.
//
// Spec §2.1: test mode is the phase-1 safety guarantee. A test-mode invoice cannot reach a
// customer at all, regardless of code defects or dashboard mistakes. That guarantee is only worth
// anything if the mode is impossible to get wrong by accident, so everything here fails closed:
// an unset, unknown, or mismatched value throws rather than picking a default.

const MODES = ['test', 'live'];

/**
 * Resolve the run mode. Explicit only — never inferred from the presence of a key, the
 * environment name, or anything else that can drift.
 */
export function resolveMode(env) {
  const mode = (env.STRIPE_MODE || '').trim();
  if (!MODES.includes(mode)) {
    throw new Error(
      `STRIPE_MODE must be exactly 'test' or 'live' (got ${JSON.stringify(env.STRIPE_MODE)}). ` +
      `It is never defaulted — see spec §2.1.`
    );
  }
  if (mode === 'live' && String(env.ALLOW_LIVE_MODE).trim() !== 'true') {
    // Two independent switches. Flipping to live is spec phase 9 with its own gate; a single
    // fat-fingered var should not be able to start billing real customers.
    throw new Error(
      `STRIPE_MODE='live' requires ALLOW_LIVE_MODE='true' as a second, deliberate switch. ` +
      `Live mode is spec phase 9 and has gates that must be cleared first (§11 D1, D4, D5, §6.2).`
    );
  }
  return mode;
}

/**
 * The Stripe key for this mode, with a prefix check.
 *
 * The check is the point: a live key pasted into the test secret is otherwise undetectable until
 * it bills someone. Stripe key prefixes encode their own mode, so the secret can be validated
 * against the declared mode before a single request goes out.
 *
 * Restricted keys (rk_) are expected — this worker needs invoice write + customer read and
 * nothing else. A full secret key (sk_) is accepted but warned about, since an unattended cron
 * holding unrestricted credentials is a standing risk rather than an immediate bug.
 */
export function stripeKey(env, mode) {
  const key = (mode === 'live' ? env.STRIPE_RK_LIVE : env.STRIPE_RK_TEST) || '';
  if (!key) {
    throw new Error(`Missing Stripe key secret ${mode === 'live' ? 'STRIPE_RK_LIVE' : 'STRIPE_RK_TEST'}`);
  }
  const expected = mode === 'live' ? ['rk_live_', 'sk_live_'] : ['rk_test_', 'sk_test_'];
  if (!expected.some(p => key.startsWith(p))) {
    throw new Error(
      `Stripe key does not match STRIPE_MODE='${mode}'. Expected a key starting with ` +
      `${expected.join(' or ')}. Refusing to run — a mode/key mismatch is exactly the mistake ` +
      `test mode exists to prevent.`
    );
  }
  return { key, restricted: key.startsWith('rk_') };
}

/**
 * THE AUTHORITATIVE MODE CHECK — Stripe's own answer, not our reading of a string.
 *
 * `stripeKey()` above parses a key PREFIX. That is a string we typed, checked against a string we
 * typed, and it is now the WEAKER of the two paths (spec §8.867, §8.869): it cannot detect a key
 * that was rotated, re-scoped, or bound to a different account. Every Stripe object carries
 * `livemode`, which the SERVER asserts — so once any response is in hand, that is what mode this
 * credential actually operates in.
 *
 * FAILS CLOSED in both directions:
 *   - `livemode` missing or not a boolean → throw. "Cannot verify" must never read as "fine";
 *     a response without it is not a response we understand.
 *   - `livemode` disagreeing with the declared mode → throw. A sweep that reports clean against
 *     the wrong account is worse than no sweep, because it produces false confidence in exactly
 *     the artefact people trust most.
 *
 * Call this on the FIRST response of any run that touches Stripe, before acting on anything.
 *
 * @param {'test'|'live'} mode  the declared mode
 * @param {object} stripeObject any Stripe API response object
 */
export function assertLivemode(mode, stripeObject) {
  if (!stripeObject || typeof stripeObject.livemode !== 'boolean') {
    throw new Error(
      `Stripe response carries no boolean 'livemode', so the account mode cannot be verified. ` +
      `Refusing to proceed — an unverifiable mode is treated as a mismatch, not as a pass.`
    );
  }
  const expected = mode === 'live';
  if (stripeObject.livemode !== expected) {
    throw new Error(
      `Stripe reports livemode=${stripeObject.livemode} but STRIPE_MODE='${mode}'. The key is ` +
      `operating against the ${stripeObject.livemode ? 'LIVE' : 'TEST'} account. Refusing to ` +
      `proceed — the key prefix agreed and the server did not, and the server is authoritative.`
    );
  }
  return mode;
}

/**
 * Customer allowlist — pilot scope (spec §3.1).
 *
 * Phases 6-9 run against ONE customer. At ~1733 invoices/month the manual review that makes
 * drafts-only meaningful is not survivable across the full book; a single customer's slice is.
 *
 * Fails closed on purpose. An unset or empty value throws rather than meaning "everything" —
 * "empty means all" is precisely the misconfiguration that would blast the entire book. Widening
 * requires typing '*', which is deliberate, greppable, and logged.
 */
export function loadArAllowlist(env) {
  const raw = env.AR_ALLOWLIST;
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!v) {
    throw new Error(
      `AR_ALLOWLIST is unset. It fails closed — set it to the pilot ARCode(s) (e.g. "5406"), ` +
      `or to "*" to run the full book. Full-book is spec phase 10 and needs a backfill first (§3.1).`
    );
  }
  if (v === '*') return { all: true, codes: new Set() };

  const codes = new Set(v.split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
  if (!codes.size) throw new Error(`AR_ALLOWLIST parsed to an empty list from ${JSON.stringify(raw)}`);
  return { all: false, codes };
}

/**
 * @returns {{allowed:boolean, reason:string}} reason is for the exception queue, not control flow.
 *
 * `near_miss` exists because ARCodes differing only by leading zeros are a config typo, not a
 * business fact. Silently skipping those looks identical to correct pilot scoping, so it surfaces
 * instead — the failure it prevents is "the pilot ran for a week and billed nothing."
 */
export function checkArCode(allowlist, arCode) {
  if (allowlist.all) return { allowed: true, reason: 'wildcard' };

  const code = String(arCode === undefined || arCode === null ? '' : arCode).trim().toUpperCase();
  if (!code) return { allowed: false, reason: 'missing_ar_code' };
  if (allowlist.codes.has(code)) return { allowed: true, reason: 'allowlisted' };

  const strip = s => s.replace(/^0+/, '');
  if (strip(code) && [...allowlist.codes].some(c => strip(c) === strip(code))) {
    return { allowed: false, reason: 'near_miss' };
  }
  return { allowed: false, reason: 'not_allowlisted' };
}

/** Primus system API credentials. Read-only by discipline — see primus.js. */
export function primusCreds(env) {
  const username = env.PRIMUS_USER || '';
  const password = env.PRIMUS_PASS || '';
  if (!username || !password) throw new Error('Missing PRIMUS_USER / PRIMUS_PASS');
  const base = (env.PRIMUS_BASE || '').replace(/\/+$/, '');
  if (!base) throw new Error('Missing PRIMUS_BASE');
  if (!/^https:\/\/restapi\.shipprimus\.com\//.test(base + '/')) {
    // The customer/portal API (freightandlogistics-api.shipprimus.com) is scoped to one customer
    // and would silently return a fraction of the data. Spec §1.
    throw new Error(`PRIMUS_BASE must be the SYSTEM API (restapi.shipprimus.com), got: ${base}`);
  }
  return { username, password, base };
}

/** Resolve everything at once so a misconfiguration fails on the first line of a run, not midway. */
export function loadConfig(env) {
  const mode = resolveMode(env);
  const { key: stripeSecret, restricted } = stripeKey(env, mode);
  return {
    mode,
    stripeSecret,
    stripeRestricted: restricted,
    primus: primusCreds(env),
    arAllowlist: loadArAllowlist(env),
    db: requireDb(env),
  };
}

function requireDb(env) {
  if (!env.DB) throw new Error('Missing D1 binding DB — run `wrangler d1 create invoice-sync` and set database_id');
  return env.DB;
}
