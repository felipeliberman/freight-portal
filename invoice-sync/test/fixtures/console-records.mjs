// Console `getShippingLocation` records — CAPTURED LIVE 2026-08-16, values verbatim.
//
// These are real customers on this tenant, read with `getAccounting: true`. Trimmed to the fields
// the resolver reads; nothing is invented, edited or tidied. That is the whole point of a fixture
// here: the rule's failure modes are all shapes of REAL data (an empty main email, four addresses
// in one field, the same address in both cases), and a hand-written approximation would have
// passed a resolver that misroutes 19 of 27 live customers.
//
// `id` appears ONLY on the two records whose console id was read directly (33717, 123301). The
// others omit it rather than carry a placeholder — the resolver never reads it, and an invented
// id in a fixture is a value someone will later cite as observed.
//
// The SYNTHETIC records at the bottom are labelled as such. They exist because two branches have
// no live example: accounting contacts (ZERO customers have any today — the branch is first in
// precedence and inert, which is exactly why it needs a test) and the malformed cases.

/** ARCode 1234 — Freight and Logistics' own internal test customer. The pilot subject. */
export const FL_TEST = Object.freeze({
  id: '33717', accountingId: '1234', ARCode: '1234',
  name: 'Freight and Logistics, Inc. - TEST',
  remitToSL: '1',
  email: 'felipe@freightandlogistics.com',
  billingEmail: '',
  accountingContacts: [],
});

/** ARCode 2395 — billing override active; AP is a different mailbox from the shipping desk. */
export const BISON = Object.freeze({
  id: '123301', accountingId: '2395', ARCode: '2395',
  name: 'Bison Office LLC',
  remitToSL: '0',
  email: 'shipping@bisoncommerce.com',
  billingEmail: 'accounting@bisoncommerce.com',
  accountingContacts: [],
});

/**
 * ARCode 5300 — THE RECORD THAT MAKES MAIN-ONLY INDEFENSIBLE. Main email is EMPTY; the only
 * address on the customer is the billing one. Main-only does not misroute this invoice, it fails
 * to send it at all, and Haynes is the account every write test on this project runs through.
 */
export const HAYNES = Object.freeze({
  accountingId: '5300', ARCode: '5300',
  name: 'Haynes Brothers Furniture',
  remitToSL: '0',
  email: '',
  billingEmail: 'sarah@haynesbrosfurniture.com',
  accountingContacts: [],
});

/** ARCode 5242 — empty main AND a multi-address billing field. Both traps on one record. */
export const KB_AUTHORITY = Object.freeze({
  accountingId: '5242', ARCode: '5242',
  name: 'KB Authority',
  remitToSL: '0',
  email: '',
  billingEmail: 'po@kbauthority.com,Madina@KBAuthority.com',
  accountingContacts: [],
});

/**
 * ARCode 5040 — four billing addresses, two of which differ ONLY IN CASE (`AP@` and `ap@`).
 * Deduping is not cosmetic: the same person receiving two copies of one invoice reads as a system
 * that sent twice, which is the complaint the send log exists to be able to answer.
 */
export const UNBEATABLE_SALE = Object.freeze({
  accountingId: '5040', ARCode: '5040',
  name: 'UnbeatableSale, Inc.',
  remitToSL: '0',
  email: 'freight@unbeatablesale.com,adrea@unbeatablesale.com',
  billingEmail: 'AP@unbeatablesale.com,kpascale@unbeatablesale.com,ap@unbeatablesale.com,freight@unbeatablesale.com',
  accountingContacts: [],
});

/** ARCode 2839 — billing list that INCLUDES the main address. Overlap is normal, not an error. */
export const OCI = Object.freeze({
  accountingId: '2839', ARCode: '2839',
  name: 'OCI',
  remitToSL: '0',
  email: 'bashi@ocielectronics.com',
  billingEmail: 'accounting@ocielectronics.com,bashi@ocielectronics.com',
  accountingContacts: [],
});

/** ARCode 2134 — multi-address on BOTH fields, and the billing one wins. */
export const NET_RETAILERS = Object.freeze({
  accountingId: '2134', ARCode: '2134',
  name: 'Net Retailers, LLC.',
  remitToSL: '0',
  email: 'freight@netretailers.com,FREIGHT@NETRETAILERS.NET',
  billingEmail: 'invoices@netretailers.net',
  accountingContacts: [],
});

/** Every live record above, for sweeps that assert a property across all of them. */
export const LIVE_RECORDS = Object.freeze([
  FL_TEST, BISON, HAYNES, KB_AUTHORITY, UNBEATABLE_SALE, OCI, NET_RETAILERS,
]);

// ── SYNTHETIC ────────────────────────────────────────────────────────────────────────────────
// Branches with no live example. Marked so nobody cites them as evidence about the tenant.

/** SYNTHETIC. Accounting contacts present — beats BOTH email fields, including a set billing one. */
export const SYNTHETIC_WITH_ACCOUNTING = Object.freeze({
  id: '999001', accountingId: '9001', ARCode: '9001',
  name: 'Synthetic Co (accounting contacts)',
  remitToSL: '0',
  email: 'shipping@synthetic.example',
  billingEmail: 'billing@synthetic.example',
  accountingContacts: [
    { firstName: 'Ada', lastName: 'AP', type: 'Accounting', email: 'ap1@synthetic.example' },
    { firstName: 'Bo', lastName: 'AP', type: 'Accounting', email: 'ap2@synthetic.example' },
  ],
});

/** SYNTHETIC. Accounting contacts exist but carry nothing usable → refuse, never fall through. */
export const SYNTHETIC_ACCOUNTING_JUNK = Object.freeze({
  id: '999002', accountingId: '9002', ARCode: '9002',
  name: 'Synthetic Co (junk accounting contacts)',
  remitToSL: '1',
  email: 'good@synthetic.example',
  billingEmail: 'alsogood@synthetic.example',
  accountingContacts: [
    { type: 'Accounting', email: 'Accounts Payable' },
    { type: 'Accounting', email: 'ap@synthetic' },      // no dotted domain
  ],
});

/** SYNTHETIC. Override active, billing field never filled in. */
export const SYNTHETIC_EMPTY_BILLING = Object.freeze({
  id: '999003', accountingId: '9003', ARCode: '9003',
  name: 'Synthetic Co (empty billing)',
  remitToSL: '0',
  email: 'shipping@synthetic.example',
  billingEmail: '',
  accountingContacts: [],
});

/** SYNTHETIC. `remitToSL` absent — the state we refuse to interpret in either direction. */
export const SYNTHETIC_NO_REMIT_FLAG = Object.freeze({
  id: '999004', accountingId: '9004', ARCode: '9004',
  name: 'Synthetic Co (no remit flag)',
  email: 'shipping@synthetic.example',
  billingEmail: 'billing@synthetic.example',
  accountingContacts: [],
});
