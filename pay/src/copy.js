// EVERY customer-visible string on pay.freightandlogistics.ai, in one place.
//
// ── STOP 2 (§8.55) HOLDS: NO CUSTOMER-FACING WORDING IS WRITTEN BY THE ASSISTANT ─────────────
//
// The prose below is seeded with PENDING OWNER WORDING sentinels, exactly as
// DISPUTE_NOTICE_PENDING is in the invoice mapper. `pay/test/route.test.mjs` FAILS while any
// sentinel remains, so the route cannot ship carrying placeholder text — the same shape as
// assertSendable blocking a send with no dispute notice.
//
// Field LABELS are set: they name a value rather than saying anything, and the owner may change
// them freely. Anything that makes a STATEMENT to a customer is a sentinel.
//
// The 404 copy is EMAIL-ONLY and must stay so. This is error/failure copy, and the
// no-phone-as-fallback product contract (CLAUDE.md) forbids routing a customer to the phone when
// something has gone wrong. The number may appear on transactional documents; not here.
export const COPY = {
  // Field labels.
  labelInvoice: 'Invoice',
  labelIssued:  'Issued',
  labelDue:     'Due',
  labelAmount:  'Amount',
  labelBol:     'BOL',

  // ── OWNER-AUTHORED PROSE, supplied 2026-08-10. Use as written. ─────────────────────────────
  //
  // Owner decision 4, and the reasoning is the owner's: the first line states a fact with a date
  // and does not apologise for it. The second says THE PORTAL WINS without saying the email was
  // wrong — a customer holding a six-week-old email and seeing a different number needs to know
  // which to act on, and the answer is always the portal. It does not claim the invoice HAS been
  // revised, only what to do if it has.
  //
  // `{issue_date}` is interpolated with the SNAPSHOT date, never a live one.
  asSentNote:      'Amount as invoiced on {issue_date}.',
  asSentSecondary: 'If this invoice has since been revised, the amount in your account is current.',

  ctaLabel: 'View documents and pay',

  // ONE message for unknown, revoked, malformed and wrong-mode alike, so the route is not an oracle
  // for which tokens exist. "No longer valid" covers all four without distinguishing them, and
  // reissued-or-cancelled is true for the revoked case and harmless for the other three.
  // EMAIL ONLY — this is failure copy and the no-phone-as-fallback contract governs it.
  notFoundTitle: 'This link is no longer valid',
  notFoundBody:  'Invoice links expire when an invoice is reissued or cancelled. Email ' +
                 'accounting@freightandlogistics.ai with your invoice or BOL number and we will ' +
                 'send a current one.',
};

/**
 * True only when no placeholder would reach a customer. The route's shippability gate.
 *
 * Kept after the copy landed: it is what stops a future edit reintroducing a placeholder, and it
 * costs nothing while green.
 */
export function isShippable() {
  return !Object.values(COPY).some(v => String(v).includes('PENDING OWNER WORDING'));
}
