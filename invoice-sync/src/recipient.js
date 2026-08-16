// WHO AN INVOICE IS EMAILED TO — Primus's own rule, reimplemented, pure.
//
// This file contains NO I/O. It takes a console shipping-location record and returns addresses.
// The session, the fetch and the cache live in the module that supplies the record; they are
// separated so the rule — the part that decides which company receives a document — is testable
// against fixtures with no network and no credentials.
//
// ── WHERE THE RULE COMES FROM ────────────────────────────────────────────────────────────────
//
// NOT designed here. Transcribed from Primus's own console source — `js/desktop/gridDims.js`,
// `MyDesktop.EmailWindow`, the dialog behind the console's "Email invoice" button. It calls
// `getShippingLocation` with `getAccounting: true` and then:
//
//     if (createdFrom == 'invoice' || createdFrom == 'invoicesLookup')
//         if (customerData.accountingContacts.length > 0)
//             to = accountingContacts.map(c => c.email).join(',')
//     if ((createdFrom != 'invoice' && createdFrom != 'invoicesLookup') || to.contacts.length == 0)
//         to = (customerData.remitToSL == '1') ? data.email : data.billingEmail
//
// We are always the invoice case, so the precedence is:
//
//     1. accountingContacts[]   → every contact, comma-joined
//     2. remitToSL === '0'      → billingEmail   (the Billing tab's Remit-To address)
//     3. remitToSL === '1'      → email          (Main Info)
//
// ── WHY IT IS NOT "JUST USE THE MAIN EMAIL" ──────────────────────────────────────────────────
//
// Measured 2026-08-16 across the 27 customer records behind every ARCode invoiced 2026-08-01..16:
// 19 of 27 have the billing override ACTIVE (`remitToSL = '0'`), and in all 19 the billing address
// differs from the main one. TWO of them have NO main email at all — Haynes Brothers (AR 5300) and
// KB Authority (AR 5242) — so main-only would have had nobody to send to. Roughly 70% of active
// customers would have been misrouted, silently, to a delivered inbox.
//
// ── THE ONE PLACE WE DELIBERATELY DIVERGE FROM PRIMUS ────────────────────────────────────────
//
// Primus falls through to the remitToSL branch when the accounting array is EMPTY. It does not
// check whether those contacts' addresses are usable — it pushes raw values into the To field and
// lets the mail server complain. We refuse instead (RECIPIENT_UNPARSEABLE).
//
// Falling through on junk would email a DIFFERENT PARTY than the console screen shows, which is
// the failure this whole module exists to prevent: it delivers, it looks perfect, and nobody finds
// out. A refusal is a queue entry someone fixes; a wrong recipient is a customer's freight detail
// and amounts in a stranger's inbox. Recorded here as a divergence rather than tidied in, so the
// next person to diff this against the console source meets it as a decision.

import { parseEmails } from './customers.js';
import { isAllowlisted } from './arcode.js';
import { refuse, allow, REFUSAL_REASONS } from './refusals.js';

/**
 * The vocabulary written to `invoice_send.recipient_source` (schema.sql).
 *
 * CLOSED SET, exported, imported by both the resolver and its tests — the same discipline as
 * STRIPE_STATES and SEND_OUTCOMES. This column is what answers "how did this reach the wrong
 * person" without a reconstruction, and it can only do that if the values are a vocabulary rather
 * than whatever string a call site typed that day.
 *
 * The `console_` prefix is load-bearing: these values come from the master console, NOT from the
 * REST API, which does not expose the billing override at all. A later `qbo_` or `primus_rest_`
 * source would be a genuinely different provenance and must not be spelled the same.
 */
export const RECIPIENT_SOURCES = Object.freeze({
  ACCOUNTING_CONTACTS: 'console_accounting_contacts',
  BILLING_EMAIL: 'console_billing_email',
  MAIN_EMAIL: 'console_main_email',
});

const ALL_SOURCES = Object.freeze(new Set(Object.values(RECIPIENT_SOURCES)));

/** True only for the console's own affirmative value. Exported for the tests that pin the trap. */
export function isRemitToShippingLocation(v) {
  return v === '1' || v === 1 || v === true;
}

/** True only for the console's own negative value. NOT `!isRemitToShippingLocation(v)`. */
export function isRemitToBillingAddress(v) {
  return v === '0' || v === 0 || v === false;
}

/**
 * Which field is authoritative for this record.
 *
 * ── THE TRAP THIS FUNCTION EXISTS TO CLOSE ───────────────────────────────────────────────────
 *
 * `remitToSL` arrives from the console as a STRING, and the value that means "no override" is
 * `'0'` — which is TRUTHY in JavaScript. `if (record.remitToSL)` is therefore true for BOTH
 * states, and the override inverts for every customer that has one. That is 19 of the 27 active
 * customers, all of them silently emailing the shipping desk instead of AP.
 *
 * So both branches are matched EXPLICITLY against the values the console actually sends, and
 * anything else refuses. `!isRemitToShippingLocation(v)` would reintroduce the same defect from
 * the other side: an absent field would read as "override active" and pick billingEmail.
 *
 * @returns {{ok:true, value:{source:string, raw:*}}|{ok:false, reason:string, detail?:object}}
 */
export function selectRecipientSource(record) {
  const r = record || {};

  const contacts = Array.isArray(r.accountingContacts) ? r.accountingContacts : [];
  if (contacts.length > 0) {
    // Order is the record's, NOT the console's. Primus's loop walks the array BACKWARDS
    // (`for (i = length - 1; i >= 0; i--)`), so its To field lists these in reverse. Everyone on
    // the list is emailed either way and there is no primary/CC distinction on this field, so the
    // difference is display order only — noted because someone WILL compare the two side by side
    // and needs to know the mismatch is expected rather than a bug.
    const raw = contacts.map(c => (c && c.email) || '').filter(Boolean).join(',');
    return allow({ source: RECIPIENT_SOURCES.ACCOUNTING_CONTACTS, raw });
  }

  if (isRemitToBillingAddress(r.remitToSL)) {
    return allow({ source: RECIPIENT_SOURCES.BILLING_EMAIL, raw: r.billingEmail });
  }
  if (isRemitToShippingLocation(r.remitToSL)) {
    return allow({ source: RECIPIENT_SOURCES.MAIN_EMAIL, raw: r.email });
  }

  return refuse(REFUSAL_REASONS.RECIPIENT_SOURCE_UNKNOWN, {
    remitToSL: r.remitToSL === undefined ? '(absent)' : JSON.stringify(r.remitToSL),
  });
}

/**
 * A console shipping-location record → the addresses this invoice is emailed to.
 *
 * ── NO CROSS-SOURCE FALLBACK ─────────────────────────────────────────────────────────────────
 *
 * Exactly one source is selected, and if it yields nothing this REFUSES. It does not try the next
 * one down. "The billing address was blank so we used the shipping desk's" is a decision nobody
 * made, taken silently, about who receives a customer's amounts.
 *
 * @param {object} record  a console `getShippingLocation` response, `data` level, fetched with
 *   `getAccounting: true`. Without that flag `accountingContacts` is absent — which is
 *   indistinguishable from "this customer has none", and would silently skip the FIRST rule.
 * @param {{all:boolean, codes:Set<string>}} allowlist  the pilot bound (spec §3.1). REQUIRED and
 *   never defaulted, for the reason the Ledger constructor gives: an absent bound quietly meaning
 *   "everything" is the misconfiguration that would reach the whole book. Resolution alone reaches
 *   no customer, but it is what MINTS an address into our store, and §8.884 is the record of a
 *   sweep that cached an out-of-pilot customer's emails on every run.
 * @param {object|null} sink  the per-run value sink (detail.js), for drop-rate counting.
 * @returns {{ok:true, value:{to:string[], source:string, dropped:string[], arCode:string|null}}
 *          |{ok:false, reason:string, detail?:object}}
 */
export function resolveRecipient(record, allowlist, sink = null) {
  if (!allowlist || typeof allowlist.all !== 'boolean' || !(allowlist.codes instanceof Set)) {
    throw new Error(
      'resolveRecipient requires an explicit AR allowlist. It is never defaulted — see §3.1 and ' +
      'the Ledger constructor, which refuses for the same reason.'
    );
  }
  if (!record || typeof record !== 'object') {
    return refuse(REFUSAL_REASONS.RECIPIENT_SOURCE_UNKNOWN, { record: '(missing)' });
  }

  // `accountingId` is the console's name for the ARCode; `ARCode` also appears on the record.
  // Read both rather than picking one — the two have been observed to disagree elsewhere on this
  // tenant, and a recipient lookup is not the place to adjudicate that.
  const arCode = firstNonEmpty(record.accountingId, record.ARCode);
  if (!isAllowlisted(allowlist, arCode)) {
    return refuse(REFUSAL_REASONS.NOT_ALLOWLISTED, { arCode: arCode ?? null });
  }

  const picked = selectRecipientSource(record);
  if (!picked.ok) return picked;

  const { source, raw } = picked.value;
  const text = String(raw ?? '').trim();

  // Empty BEFORE parsing: nobody ever filled the field in.
  if (!text) {
    return refuse(REFUSAL_REASONS.NO_RECIPIENT, { source, arCode: arCode ?? null });
  }

  const { all, dropped } = parseEmails(text, sink);

  // Non-empty before parsing, empty after: somebody filled it in with something that is not an
  // address. A different problem from the one above, and a more urgent one.
  if (!all.length) {
    return refuse(REFUSAL_REASONS.RECIPIENT_UNPARSEABLE, { source, dropped, arCode: arCode ?? null });
  }

  return allow({ to: all, source, dropped, arCode: arCode ?? null });
}

/** Assert a value belongs to the closed source vocabulary. Throws — an unknown source is a
 *  programming error, not a data condition, and it must not reach the send log. */
export function assertRecipientSource(source) {
  if (!ALL_SOURCES.has(source)) {
    throw new Error(
      `Unknown recipient source ${JSON.stringify(source)} — expected one of ` +
      `${[...ALL_SOURCES].join(', ')}. The set is closed; growing it is a deliberate edit.`
    );
  }
  return source;
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    const s = v === null || v === undefined ? '' : String(v).trim();
    if (s) return s;
  }
  return null;
}
