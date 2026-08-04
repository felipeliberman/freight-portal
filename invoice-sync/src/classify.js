// Spec §4.3 — primary vs rebill classification.
//
// ORDERING COMES FROM PRIMUS, NOT FROM LOCAL STATE. Deriving "first one I've seen" from the ledger
// misclassifies a rebill as a primary whenever the primary predates go-live or a backfill runs out
// of order — which would fold real supplemental charges into the freight description.
//
// The verdict is written ONCE (ledger.setClassification refuses to overwrite): a later run sees
// more BOL siblings and would otherwise reclassify an invoice that has already been sent.
//
// HOLD, DON'T GUESS. A wrong classification is a wrong customer-facing document.

/** Sort key: issueDate ascending, then invoiceId, so ties are still deterministic. */
function orderKey(inv) {
  return `${String(inv.issueDate ?? '')}|${String(inv.invoiceId ?? '')}`;
}

/**
 * @param {object}   invoice   the list record being classified
 * @param {object[]} siblings  ALL list records sharing its BOLNumber, from Primus
 * @returns {{classification:'primary'|'rebill'|'hold', reason:string}}
 */
export function classifyInvoice(invoice, siblings) {
  const bol = invoice && invoice.shipment && invoice.shipment.BOLNumber;
  if (!bol) return { classification: 'hold', reason: 'no BOLNumber — cannot establish siblings', primaryInvoiceNumber: null };

  const list = (Array.isArray(siblings) ? siblings : [])
    .filter(s => s && s.shipment && String(s.shipment.BOLNumber) === String(bol));

  if (!list.length || !list.some(s => String(s.invoiceId) === String(invoice.invoiceId))) {
    return { classification: 'hold', reason: 'invoice not present in its own sibling set', primaryInvoiceNumber: null };
  }
  if (list.length === 1) return { classification: 'primary', reason: 'only invoice on this BOL', primaryInvoiceNumber: null };

  // Any sibling with no usable ordering key makes the whole ordering untrustworthy.
  if (list.some(s => !s.issueDate)) {
    return { classification: 'hold', reason: 'a sibling has no issueDate — ordering is not decidable', primaryInvoiceNumber: null };
  }

  const sorted = [...list].sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
  const first = sorted[0];
  const isPrimary = String(first.invoiceId) === String(invoice.invoiceId);

  // The primary's invoice NUMBER, DERIVED from the sibling set — Primus hands it to us nowhere.
  // Neither the booking nor the invoice detail references a sibling invoice; this is the only
  // route, and it costs no extra call because the classifier already holds the set.
  // Treated like ARCode: derived values are labelled as derived (spec §5.31).
  const primaryInvoiceNumber = isPrimary ? null : (first.invoiceNumber ?? null);

  return isPrimary
    ? { classification: 'primary', reason: `earliest of ${list.length} on BOL ${bol}`, primaryInvoiceNumber: null }
    : { classification: 'rebill', reason: `later of ${list.length} on BOL ${bol}`, primaryInvoiceNumber };
}

/**
 * VOID-AWARENESS IS NOT IMPLEMENTED, AND CANNOT BE FROM CURRENT DATA.
 *
 * §4.3 requires that if every prior invoice on a BOL is voided, this one is a CORRECTED PRIMARY
 * rather than a rebill. The Primus list `status` object carries
 * {estimatedCosts, actualCosts, costActualClosed, charges, readyToInvoice, generated, sent, paid}
 * — verified live 2026-08-03. **There is no void or cancelled flag anywhere in it.**
 *
 * So a corrected primary is currently classified as a REBILL. Consequence today is bounded: the
 * classification only drives §5.1's zero-dollar placement, and the rebill document push is not
 * built. It is recorded rather than silently accepted, because the consequence grows the moment
 * documents are pushed on a rebill.
 */
export const VOID_AWARENESS_AVAILABLE = false;
