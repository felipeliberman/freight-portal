// THE CUSTOMER RECORD — one console read, validated, narrowed.
//
// Turns an invoice's `customerInfo.customerId` into the record `src/recipient.js` consumes. The
// session (login, PHPSESSID, expiry recovery) is piece (i); this file owns the JOIN and the
// ENVELOPE, which is where a lookup goes wrong quietly rather than loudly.
//
// ── THE JOIN KEY, AND THE FIELD THAT LOOKS LIKE IT ───────────────────────────────────────────
//
// The key is the invoice detail's `customerInfo.customerId`, which equals the console record's
// `id`. Verified on 10 of 10 invoices spanning 10 distinct ARCodes (2026-08-16), each resolving to
// a record whose `accountingId` matched the invoice's list ARCode.
//
// THE RECORD ALSO HAS A FIELD LITERALLY NAMED `customerId`, AND IT IS NOT THE KEY. Its value is
// "17" on every customer on this tenant — a tenant-level id. Anyone reading the record while
// writing a join will reach for it first. What happens if they do is measured, and it is not what
// you would guess: recordId=17 returns a HOLLOW record — HTTP 200, `success: "true"`,
// `message: "No results."`, `data: []`. It does not return another customer's data; it returns
// something success-shaped and empty. So the danger is not a wrong address, it is a record of
// `undefined`s flowing downstream and being read as "this customer has no billing email".
//
// That is why `customerId` is dropped by the narrowing below: the wrong key must not be sitting in
// scope next to the right one. It is the same id-namespace hazard as §8.876, which is about
// id-keyed versus number-keyed document lookups — different endpoints, identical shape of mistake.
//
// ── WHY VALIDITY CANNOT BE READ FROM THE RESPONSE'S OWN FLAGS ─────────────────────────────────
//
// Measured, both cases:
//
//   valid record   HTTP 200 · success "true" · (no message)   · data = { id, accountingId, … }
//   unknown id     HTTP 200 · success "true" · "No results."  · data = []
//
//   * `success` is the STRING "true" in BOTH. It is not a validity signal and is never read here.
//   * the status is 200 in BOTH.
//   * the empty case is an empty ARRAY, and `typeof [] === 'object'` is TRUE — so the obvious
//     guard admits the hollow record. `Array.isArray` is checked FIRST, deliberately.
//
// Validity therefore comes from the RECORD: a non-array object, carrying an `id`, and carrying the
// id we asked for. Nothing weaker.

import { assertExactKeys } from './detail.js';
import { refuse, allow, REFUSAL_REASONS } from './refusals.js';

/** The one action this file calls. Read-only, and on ConsoleSession's allowlist. */
export const SHIPPING_LOCATION_ACTION = 'getShippingLocation';

/**
 * The narrowed record's key set, exactly.
 *
 * ── CONSOLE NAMES, KEPT ──────────────────────────────────────────────────────────────────────
 * `remitToSL` and `billingEmail` are the console's own names and they stay. Renaming them to a
 * house style would have meant editing an already-tested rule to match a new shape, and the record
 * stays recognisable against the console screen a human will have open while diagnosing.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────────────────────
 * The live record carries ~80 fields, including `creditLimit`, `creditBalance`, `taxID`,
 * `EINNumber`, `quickbooksListId` and `idHashed`. None of them has a reader on the recipient path,
 * and detail.js's rule applies unchanged: if you cannot say why a customer may see a field, leave
 * it out. Sealed by assertExactKeys, so widening is a deliberate, visible edit rather than a spread.
 *
 * `includeEmailPOD` / `includeEmailBOL` / `mergePDF` are real and WILL be wanted — they are the
 * per-customer attachment preferences the email template should honour. They are left out until
 * that template exists, so the boundary widens when something actually reads them.
 */
export const CONSOLE_RECORD_FIELDS = Object.freeze([
  'id', 'accountingId', 'ARCode', 'name',
  'remitToSL', 'email', 'billingEmail', 'accountingContacts',
]);

/** One accounting contact, narrowed to the address the rule reads. */
function narrowContact(c) {
  return { email: (c && c.email) || null };
}

/**
 * Validate and narrow one `getShippingLocation` response.
 *
 * Separated from the fetch so the envelope rules are testable without a session, and so no caller
 * can hold the raw ~80-field record.
 *
 * @param {object} json  the parsed response
 * @param {string|number} expectedId  the id we asked for; a record with any other id is refused
 * @returns {{ok:true, value:object}|{ok:false, reason:string, detail:object}}
 */
export function narrowConsoleRecord(json, expectedId) {
  const data = json && json.data;

  // ARRAY FIRST. `data: []` is the console's "No results." and it passes every object check.
  if (Array.isArray(data) || !data || typeof data !== 'object') {
    return refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, {
      reason: 'no_record',
      requested: String(expectedId ?? ''),
      // The console's own words, when it offered any. Short, and never a whole body (spec §6.3).
      message: json && typeof json.message === 'string' ? json.message.slice(0, 60) : null,
    });
  }

  if (data.id === undefined || data.id === null || String(data.id).trim() === '') {
    return refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, {
      reason: 'id_missing', requested: String(expectedId ?? ''),
    });
  }

  // Compared as STRINGS: the console returns ids as strings, but a numeric one must not read as a
  // mismatch. Never a loose `==` — that has its own surprises with objects and whitespace.
  if (String(data.id).trim() !== String(expectedId ?? '').trim()) {
    return refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, {
      reason: 'id_mismatch', requested: String(expectedId ?? ''), got: String(data.id).trim(),
    });
  }

  // ABSENCE IS DRIFT, NOT EMPTINESS. `getAccounting: 'true'` is sent unconditionally below, so the
  // key must be there. If it is missing, either the console changed or the flag stopped working —
  // and reading that as "this customer has no accounting contacts" would silently skip the FIRST
  // rule of the precedence and invoice their shipping desk instead of AP.
  if (!Array.isArray(data.accountingContacts)) {
    return refuse(REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED, {
      reason: 'accounting_contacts_absent',
      requested: String(expectedId ?? ''),
      got: data.accountingContacts === undefined ? '(absent)' : typeof data.accountingContacts,
    });
  }

  // Explicit assignment, never a spread — the same rule detail.js states, for the same reason: a
  // field the console adds next quarter must not arrive here by default.
  return allow(assertExactKeys({
    id: String(data.id).trim(),
    accountingId: data.accountingId ?? null,
    ARCode: data.ARCode ?? null,
    name: data.name ?? null,
    remitToSL: data.remitToSL ?? null,
    email: data.email ?? null,
    billingEmail: data.billingEmail ?? null,
    accountingContacts: data.accountingContacts.map(narrowContact),
  }, CONSOLE_RECORD_FIELDS, 'console customer record'));
}

/**
 * The queue key for a SYSTEMIC console shape change.
 *
 * Names the field, not the record: if `accountingContacts` stops arriving it stops arriving for
 * EVERY customer, and that is one event.
 */
export const SHAPE_DRIFT_REF = 'console:shape:accountingContacts';

/**
 * A refusal → the `ref` it should be recorded under in the exception queue.
 *
 * ── WHY THIS EXISTS AT ALL ───────────────────────────────────────────────────────────────────
 *
 * `exceptions` is UNIQUE (mode, kind, ref) with a climbing `seen_count`, so the ref is the ONLY
 * thing deciding whether two failures share a row. One refusal reason covers two triage classes
 * here, and keying them the same way would make the queue useless in both directions:
 *
 *   PER-RECORD (`sl:<id>`) — `no_record`, `id_missing`, `id_mismatch`. A data gap on ONE customer.
 *     Keyed systemically, forty invoices for one bad id would look identical to forty different
 *     customers each broken once, and nobody could tell which.
 *
 *   SYSTEMIC (SHAPE_DRIFT_REF) — `accounting_contacts_absent`. The console changed. Keyed
 *     per-record, ONE upstream change writes a row per customer — hundreds of rows that bury every
 *     genuine per-invoice gap under a single event.
 *
 *   PER-STAGE (`console:<stage>`) — an outage from piece (i), which passes through this module
 *     untouched. One outage is one row however many invoices it hits, and a login failure stays
 *     separable from a transport failure.
 *
 * THROWS on anything else. A ref invented for a refusal this module never produces would land
 * real failures under a key nobody is watching, which is worse than an error at the call site.
 *
 * @param {{ok:boolean, reason?:string, detail?:object}} refusal
 * @returns {string} the exception `ref`
 */
export function exceptionRefFor(refusal) {
  const reason = refusal && refusal.ok === false ? refusal.reason : null;
  const detail = (refusal && refusal.detail) || {};

  if (reason === REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED) {
    return `console:${detail.stage || 'unknown'}`;
  }

  if (reason === REFUSAL_REASONS.RECIPIENT_RECORD_UNRECOGNISED) {
    if (detail.reason === 'accounting_contacts_absent') return SHAPE_DRIFT_REF;
    if (detail.reason === 'no_record' || detail.reason === 'id_missing' || detail.reason === 'id_mismatch') {
      return `sl:${detail.requested ?? ''}`;
    }
  }

  throw new Error(
    `no exception ref for ${JSON.stringify(reason)}/${JSON.stringify(detail.reason)} — this ` +
    `module produces a closed set of refusals, and inventing a key would file a real failure ` +
    `under one nobody reads.`
  );
}

/**
 * Fetch one customer record by its console id.
 *
 * @param {{post:Function}} session  a ConsoleSession
 * @param {string|number} customerId  the invoice detail's `customerInfo.customerId`
 * @returns {Promise<{ok:true, value:object}|{ok:false, reason:string, detail:object}>}
 *
 * A session refusal PASSES THROUGH UNCHANGED. An outage is already classified (stage + status) by
 * piece (i), and re-labelling it as a record problem would send someone to read a response that
 * was never returned.
 */
export async function fetchCustomerRecord(session, customerId) {
  const res = await session.post(SHIPPING_LOCATION_ACTION, {
    recordId: String(customerId ?? ''),
    // NOT A PARAMETER. Without it the console omits `accountingContacts` entirely, which is
    // indistinguishable from a customer having none — the silent skip described above. Any caller
    // options are ignored on purpose; there is no legitimate reason to turn this off.
    getAccounting: 'true',
  });
  if (!res.ok) return res;
  return narrowConsoleRecord(res.value && res.value.json, customerId);
}
