// The canonical ARCode form — ONE definition, imported everywhere an ARCode is stored or compared.
//
// This is not a new rule. FIVE sites already agreed on trim+uppercase before this file existed:
// the allowlist parse and checkArCode (config.js), customerCacheKey and displayNameMatchesArCode
// (customers.js), and customerIdempotencyKey (stripe-customer.js). Three sites skipped it —
// Ledger.claim stored the raw value, StripeCustomers.claim/get trimmed without uppercasing — and
// the (mode, ar_code) join runs between exactly those. It held only for ARCodes that are plain
// digits, which every ARCode seen so far is (5406, 1234, 2395), so nothing surfaced.
//
// That join is load-bearing: it is the entire reason `ledger` carries no stripe_customer_id copy
// (schema.sql). A join that silently misses turns "this customer exists" into a create-path refusal.
//
// ── WHAT THIS DELIBERATELY DOES NOT DO (spec §8.867, §4b) ────────────────────────────────────
//
// NO leading-zero stripping. checkArCode (config.js) reports `near_miss` when a code differs from
//   an allowlist entry ONLY by leading zeros, because that is a config typo rather than a business
//   fact. Making '0123' and '123' equal here would delete that detection mechanism in the name of
//   consistency.
//
// NO internal-whitespace collapsing. An ARCode with a space inside is bad data, not a formatting
//   variant; collapsing it would silently accept junk, while leaving it distinct fails the
//   allowlist, which is the correct direction. What the join needs is both sides applying the SAME
//   function — consistency, not aggressiveness.
//
// NO Unicode folding beyond toUpperCase(). KNOWN EDGE: SQLite's UPPER() is ASCII-only while JS
//   toUpperCase() is Unicode-aware, so a non-ASCII ARCode could make the SQL migration and this
//   function disagree. Every ARCode observed is ASCII digits. Recorded rather than engineered for,
//   so the first non-ASCII ARCode is a known case instead of a mystery.

/**
 * @param {*} v
 * @returns {string} the canonical form; '' for null/undefined, so callers can test emptiness
 *   without repeating the null dance. Callers that must preserve SQL NULL check before calling.
 */
export const normalizeArCode = v => String(v ?? '').trim().toUpperCase();

/**
 * The allowlist as a SQL predicate — the pilot bound expressed the way `mode` already is.
 *
 * The allowlist is the pilot's BLAST-RADIUS BOUND. Enforcing it at each call site is the failure it
 * exists to prevent, reproduced inside the mechanism meant to prevent it: eleven places to remember,
 * and the bound is only as good as the least careful one. So it is held by the object and welded
 * into the query, exactly as `AND mode = ?` is — not because eleven authors remembered, but because
 * the row is not addressable otherwise.
 *
 * A NULL `ar_code` PASSES. "No code" is not "a code outside the bound": such a row reaches no
 * customer (resolveClaimedCustomers filters `ar_code IS NOT NULL`) and the poll already records an
 * exception and skips before it can be claimed. Refusing it here would fail a case that is already
 * handled correctly one layer up.
 *
 * @param {{all:boolean, codes:Set<string>}} allowlist
 * @param {string} column  qualified where needed, e.g. 'l.ar_code'
 * @returns {{sql:string, params:string[]}} sql is always a complete boolean expression
 */
export function allowlistPredicate(allowlist, column = 'ar_code') {
  if (!allowlist || typeof allowlist.all !== 'boolean' || !(allowlist.codes instanceof Set)) {
    throw new Error(
      'allowlistPredicate requires a {all, codes:Set} allowlist. It is never defaulted — an ' +
      'absent bound must not silently mean "everything" (spec §3.1).'
    );
  }
  if (allowlist.all) return { sql: '1 = 1', params: [] };
  const codes = [...allowlist.codes];
  // An empty non-wildcard list matches nothing, which is the fail-closed direction. loadArAllowlist
  // already throws on it; this stays correct if some other caller ever builds one by hand.
  if (!codes.length) return { sql: `${column} IS NULL`, params: [] };
  return {
    sql: `(${column} IS NULL OR ${column} IN (${codes.map(() => '?').join(', ')}))`,
    params: codes,
  };
}

/** True when this ARCode may be acted on. NULL/blank passes, for the reason above. */
export function isAllowlisted(allowlist, arCode) {
  if (allowlist && allowlist.all) return true;
  const code = normalizeArCode(arCode);
  if (!code) return true;
  return !!(allowlist && allowlist.codes && allowlist.codes.has(code));
}

/**
 * Parse an AR_ALLOWLIST env value into the {all, codes} shape.
 *
 * LIVES HERE, NOT IN config.js, FOR A BUNDLING REASON. The public `pay` Worker needs this bound
 * too (resolveToken welds it into its WHERE), and config.js reaches Primus credentials, Stripe keys
 * and mode resolution. Importing it from a public Worker would pull all of that into a bundle
 * served from the open internet to satisfy one string parse. arcode.js is pure and dependency-free,
 * which is exactly what a public bundle should be able to import.
 *
 * FAILS CLOSED. An unset or empty value THROWS rather than meaning "everything" — "empty means all"
 * is precisely the misconfiguration that would blast the entire book (§3.1). Widening requires
 * typing '*', which is deliberate, greppable, and logged.
 *
 * ── ⚠ THIS LIST IS NOW A LIVE-ACCESS CONTROL, NOT ONLY A WRITE-SIDE ONE (spec §8.884) ────────
 *
 * It began as a blast-radius bound on what we WRITE. Since §8.882 it is also welded into the
 * invoice-link token query, so it decides which customer-facing links RESOLVE.
 *
 * **REMOVING AN ARCode KILLS LINKS ALREADY IN THAT CUSTOMER'S INBOX.** Their URL starts returning
 * the generic 404 — no explanation, and indistinguishable from an unknown token, because the
 * refusal is deliberately silent (a loud one would be an oracle for which tokens exist). Nobody
 * reports that as an error; the invoice simply goes unpaid.
 *
 * WIDENING IS SAFE. NARROWING IS AN OPERATIONAL CHANGE TO LIVE CUSTOMER ACCESS. To kill one link,
 * revoke it (InvoiceLinks.revoke) — that is the mechanism built for it, and it leaves a record.
 */
export function parseAllowlist(raw, varName = 'AR_ALLOWLIST') {
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!v) {
    throw new Error(
      `${varName} is unset. It fails closed — set it to the pilot ARCode(s) (e.g. "5406"), ` +
      `or to "*" to run the full book. Full-book is spec phase 10 and needs a backfill first (§3.1).`
    );
  }
  if (v === '*') return { all: true, codes: new Set() };
  const codes = new Set(v.split(',').map(normalizeArCode).filter(Boolean));
  if (!codes.size) throw new Error(`${varName} parsed to an empty list from ${JSON.stringify(raw)}`);
  return { all: false, codes };
}
