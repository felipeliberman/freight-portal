// THE OWNERSHIP CHECK — spec §5.8, §8.874 (GATE 2), §8.876.
//
// §8.874 recorded that no "does this invoice belong to me" function exists anywhere, "because
// nothing has ever needed one." A customer-facing document route is the first thing that does: it
// is handed an identifier from outside and asked to serve bytes for it.
//
// ── WHY THE TOKEN, AND ONLY THE TOKEN ────────────────────────────────────────────────────────
//
// The portal keys invoice access off `customerEmail` read out of sessionStorage/localStorage
// (portal.html:4106, :4179). That is a string in the customer's own browser: editable in devtools,
// checked against nothing. Anything a client says about who it is has this property, whether it is
// an email, a customer id, or an ARCode — so none of them may be an input here.
//
// Primus already knows the answer. It issues an accessToken only after validating username and
// password, and `/applet/v1/profile` returns that token's own billToInformation. portal.html
// (:9212-9229) already makes exactly this call and reads `billToInformation.code` from it — and
// then :9260 discards it, building the customer object with `arCode: null` hardcoded. The fact was
// always available; nothing consumed it.
//
// So the ONE input is the token, because the token is the only artefact Primus itself vouches for.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────────────────────
//
// This does NOT make ownership independently verifiable. §8.876 verified on 2026-08-04 that a
// customer token returns another account's document list (5 documents for ARCode 720, fetched with
// ARCode 1234's token, including a POD), so `GET /applet/v1/document/{bolId}` cannot be trusted to
// refuse. What this adds is what §8.874 said such a check is worth, precisely:
//
//   * it refuses BEFORE the request goes out, rather than relying on the far end to say no;
//   * it makes the failure legible to us, where today a wrong-customer link and a shipment with no
//     documents are indistinguishable.
//
// Both sides of the comparison still originate from Primus. That is stated here so nobody later
// reads this file as having closed §8.876 layers 1 or 2. It has not; those are Primus's.
//
// ── DISCIPLINE ───────────────────────────────────────────────────────────────────────────────
//
// Two pure functions. No env, no request, no D1 — same shape as arcode.js and documents.js, and
// for the same reason: the Worker route wires configuration and request parsing to these, so the
// decision can be tested without standing up either.

import { normalizeArCode } from './arcode.js';

/** The customer/portal API path. NOT the system API — see the base note in resolveCallerArCode. */
const PROFILE_PATH = '/applet/v1/profile';

/**
 * Who is the caller, according to Primus?
 *
 * @param {string} accessToken        the customer's OWN Primus bearer token, forwarded by the
 *   browser. Never an email, never a client-supplied customer id — see the header.
 * @param {string} primusAppletBase   the customer/portal API origin
 *   (`https://freightandlogistics-api.shipprimus.com`, portal.html:1236). Deliberately a parameter
 *   and NOT invoice-sync's `PRIMUS_BASE`: that one is regex-locked to `restapi.shipprimus.com` and
 *   throws if pointed here (config.js:143-148). Two different APIs, and the token in hand belongs
 *   to this one.
 * @param {typeof fetch} fetchImpl    injection point for tests ONLY. No production path passes
 *   anything but the global fetch; it is a parameter so the decision can be tested without a
 *   network, not so it can be swapped at runtime.
 * @returns {Promise<string|null>} the ARCode in canonical form, or null.
 *
 * EVERY failure returns the SAME null: no token, non-ok response, unparseable body, missing
 * billToInformation, missing or blank code, unreachable host. §5.8's rule — "not found" and "not
 * yours" are one message — applied one layer below the route. A resolver that distinguished
 * "expired token" from "no billTo on this account" would hand a caller a probe for accounts that
 * are not theirs. If that distinction is ever wanted it belongs in a caller's LOG LINE, where only
 * we can read it, never in the return value.
 */
export async function resolveCallerArCode(accessToken, primusAppletBase, fetchImpl = fetch) {
  // OUR CONFIGURATION FAILS LOUD; CALLER DATA FAILS CLOSED. Same split as deriveDocToken refusing
  // without a secret and parseAllowlist refusing when unset. A blank base would resolve EVERY
  // customer to null — a wiring bug wearing the costume of a normal empty result, which is the
  // failure §8.874 singles out as the one nobody reports, because it looks like the system working.
  const base = String(primusAppletBase ?? '').trim().replace(/\/+$/, '');
  if (!base) {
    throw new Error(
      'resolveCallerArCode requires the applet API base (the customer/portal host, e.g. ' +
      'https://freightandlogistics-api.shipprimus.com). It is never defaulted: a blank base makes ' +
      'every caller unresolvable, and a uniform refusal that is really a misconfiguration is ' +
      'indistinguishable from the system working correctly (§8.874).'
    );
  }

  // No token, no question to ask. Answered locally rather than by a round trip — reaching out
  // would put a blank credential on the wire to learn something already known.
  const token = String(accessToken ?? '').trim();
  if (!token) return null;

  let body;
  try {
    const res = await fetchImpl(base + PROFILE_PATH, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res || !res.ok) return null;
    // A 200 is not a promise of JSON — Primus fronts an HTML error page on some failures. Throwing
    // here would turn a bad upstream answer into a 500 on our own route.
    body = await res.json();
  } catch {
    return null;
  }

  const billTo = billToInformationOf(body);
  if (!billTo) return null;

  // THE SAME function the ledger stores through (Ledger.claim, ledger.js:151). If these two ever
  // applied different normalisation, ownership would fail on a formatting difference — and it
  // would fail closed and silently, which is the hardest kind to notice: the customer sees "not
  // found" on their own invoice and reports nothing.
  return normalizeArCode(billTo.code) || null;
}

/**
 * Pull `billToInformation` out of the profile envelope, or nothing.
 *
 * The live shape is a single object: `data.results.billToInformation` (portal.html:9212-9229). An
 * array of exactly one is the same answer in a different envelope and is accepted. Two or more is
 * NOT a clean single answer and resolves to nothing — taking `[0]` would be choosing an identity
 * for the caller by array index, and if Primus ever returns more than one that is a question to
 * answer deliberately.
 */
function billToInformationOf(body) {
  const results = body && body.data && body.data.results;
  if (!results || typeof results !== 'object') return null;
  const single = Array.isArray(results) ? (results.length === 1 ? results[0] : null) : results;
  const billTo = single && single.billToInformation;
  return billTo && typeof billTo === 'object' ? billTo : null;
}

/**
 * May this caller see this invoice?
 *
 * A NAMED FUNCTION rather than an inlined `a === b`, so every call site reads as an ownership
 * decision. An incidental string comparison in a route handler is something a later reader edits
 * without noticing what it was load-bearing for; a call to `ownsInvoice` is not.
 *
 * @param {string|null} callerArCode   from resolveCallerArCode — already canonical
 * @param {string|null} invoiceArCode  from Ledger.get / the link row — already canonical
 *   (Ledger.claim normalises at write, ledger.js:151, so reads need no second pass)
 * @returns {boolean}
 *
 * NO RE-NORMALISATION, deliberately. Both sides are canonical by construction, and repairing a
 * non-canonical input here would hide a caller feeding this raw data — by SUCCEEDING, which is the
 * one direction a security check must never fail in. A formatting mismatch refuses instead.
 */
export function ownsInvoice(callerArCode, invoiceArCode) {
  const caller = callerArCode == null ? '' : String(callerArCode);
  const invoice = invoiceArCode == null ? '' : String(invoiceArCode);

  // Two unresolved sides are two refusals, not an agreement. Without this guard, plain equality
  // would make '' === '' a SUCCESSFUL ownership check — the worst outcome available to this
  // function, reached by its most ordinary-looking line. "Could not resolve" is never a wildcard.
  if (!caller.trim() || !invoice.trim()) return false;

  return caller === invoice;
}
