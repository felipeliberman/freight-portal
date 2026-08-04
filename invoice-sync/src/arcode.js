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
