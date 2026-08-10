// THE APPROVED BILLING-DISPUTE NOTICE — owner-authored, approved 2026-08-04, re-approved for the
// possession page 2026-08-10 (spec §8.878). NOT to be reworded, trimmed or "tightened".
//
// EXTRACTED to its own module so the ONE definition can be imported by both the mapper and the
// public pay Worker without dragging the mapper's Primus-shaped dependencies into a public bundle.
// Duplicating it would be worse: the two copies would drift, and this text is contractual.
//
// THIS IS A BILLING-DISPUTE CLAUSE, not the cargo-claims window (§8.857 / A1). Different subject,
// different clock, different legal basis. 49 USC 14705 sets an 18-month limitation on actions to
// recover OVERCHARGES and imposes no floor on a contractual dispute-NOTICE window, so 3 business
// days stands as a negotiated term rather than being pre-empted.
//
// "THE DATE SENT" IS NO LONGER AMBIGUOUS (§8.865.6). Under the Stripe design it would have meant
// Stripe's send while Primus's status.sent moved independently. With Stripe out it means OUR
// SendGrid send — timestamped by us, logged by us, ours to produce on demand. A window that starts
// on a date we can PROVE is a materially better term than one starting on a flag we did not own.
//
// The 368-character budget is GONE — it existed only because Stripe's memo field capped at 500.
// If any phrasing here was compressed to fit it, that constraint no longer applies; the text is
// unchanged by owner decision, but nobody should preserve the compression as deliberate style.
export const DISPUTE_NOTICE =
  'Dispute this invoice within 3 business days of the date sent. Send written notice with ' +
  'supporting documentation to accounting@freightandlogistics.ai. Without timely notice and ' +
  'documentation, no dispute will be filed with the carrier and the invoice is due in full.';

/** The sentinel that blocks a send when no notice is supplied. Never render this to a customer. */
export const DISPUTE_NOTICE_PENDING = '« DISPUTE NOTICE — PENDING OWNER WORDING (D7) »';
