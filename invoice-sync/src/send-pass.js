// THE COMPOSITION — one pass from "which invoices" to "what left, if anything".
//
//     collectSendCandidates  →  InvoiceRecipients.forInvoice  →  SendGuard.send
//     (which invoices)          (who receives it)                (whether it leaves)
//
// Each of those is tested in its own file and owns its own rule. This file owns only the ORDER and
// the accounting, and it is deliberately thin for the reason the three are separate at all: the
// mode switch must not end up behind a database query, and the recipient rule must not be able to
// decide whether something sends.
//
// ── PER-CANDIDATE ISOLATION ──────────────────────────────────────────────────────────────────
//
// One invoice failing must cost exactly that invoice. A console outage on the third of eight is
// an ordinary Tuesday, and a pass that aborted there would leave five invoices unsent with nothing
// saying why. Every candidate is resolved and sent independently, and anything that fails is left
// SELECTABLE — no `first_sent_at`, no `invoice_send` row that a later run would read as a send.
//
// ── THE REPORT IS THE POINT, BEFORE ANY TRANSPORT EXISTS ─────────────────────────────────────
//
// In `dryrun` this returns the list of who WOULD have been emailed, with the field each address
// came from. That list is the acceptance gate: it can be read against production before code
// capable of sending exists at all.

import { collectSendCandidates } from './send-candidates.js';
import { InvoiceRecipients } from './invoice-recipient.js';
import { SendGuard } from './send-guard.js';
import { fetchInvoiceDetail } from './detail.js';
import { REFUSAL_REASONS } from './refusals.js';

/**
 * @param {object} primus       read-only PrimusClient
 * @param {Ledger} ledger
 * @param {object} session      a ConsoleSession. NOT USED UNLESS THERE ARE CANDIDATES — it logs in
 *   lazily on its first call, so a quiet run establishes no master console session at all.
 * @param {object} sendConfig   from loadSendConfig
 * @param {object} [transport]  injected; absent is fine for `dryrun`
 * @returns {object} counters plus `report`, the reviewable who-would-have-been-emailed list
 */
export async function runSendPass({
  primus, ledger, session, sendConfig, allowlist, checkArCode,
  issuedFrom, issuedTo, sendFromDate = null, cap = 25,
  transport = null, sink = null,
}) {
  const found = await collectSendCandidates({
    primus, ledger, allowlist, checkArCode, issuedFrom, issuedTo, sendFromDate, cap,
  });

  const s = {
    mode: sendConfig.mode,
    seen: found.seen,
    candidates: found.candidates.length,
    notRed: found.notRed,
    alreadySentByUs: found.alreadySentByUs,
    beforeFloor: found.beforeFloor,
    skippedNotAllowed: found.skippedNotAllowed,
    cappedAt: found.cappedAt,
    dropped: found.dropped,
    sent: 0, wouldSend: 0, unresolved: 0, failed: 0, alreadySent: 0,
    unresolvedDetail: [],
    report: [],
  };

  if (!found.candidates.length) return s;

  // Constructed only now. The session logs in on its first request, so this is where laziness
  // actually lives — no candidates, no console session.
  const recipients = new InvoiceRecipients(session, allowlist, { ledger, sink });
  const guard = new SendGuard(ledger, sendConfig, { transport });

  for (const candidate of found.candidates) {
    // The detail is what carries `customerInfo.customerId`, the console join key. It is fetched
    // per invoice rather than per customer because the id is per invoice; the RECORD behind it is
    // memoised by InvoiceRecipients, so the console is read once per customer either way.
    let detail;
    try {
      detail = await fetchInvoiceDetail(primus, candidate.row.primus_invoice_id);
    } catch (err) {
      s.unresolved++;
      s.unresolvedDetail.push({
        invoiceNumber: candidate.invoiceNumber,
        reason: REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED,
      });
      continue;
    }

    const resolved = await recipients.forInvoice(detail);
    if (!resolved.ok) {
      // NOT A SEND, and not consumed. The candidate rule is `first_sent_at IS NULL`, so leaving
      // the row untouched is what makes this retriable next run — and the queue row explaining it
      // was already written by InvoiceRecipients.
      s.unresolved++;
      s.unresolvedDetail.push({ invoiceNumber: candidate.invoiceNumber, reason: resolved.reason });
      continue;
    }

    const result = await guard.send({ row: candidate.row, recipient: resolved.value });

    if (result.ok) {
      if (result.value.sent) s.sent++; else s.wouldSend++;
      s.report.push({
        invoiceNumber: candidate.invoiceNumber,
        issueDate: candidate.issueDate,
        arCode: resolved.value.arCode,
        customerId: resolved.value.customerId,
        to: resolved.value.to,
        source: resolved.value.source,
        sent: result.value.sent,
      });
      continue;
    }

    if (result.reason === REFUSAL_REASONS.ALREADY_SENT) s.alreadySent++;
    else s.failed++;
  }

  return s;
}

/**
 * The report as lines, for a log a human reads.
 *
 * Addresses are included ON PURPOSE — this is the artefact the owner reviews before anything can
 * send, and a redacted version would not answer the only question it exists to answer. It goes to
 * the run log, which is already inside the private boundary; it must not be handed anywhere else.
 */
export function formatSendReport(report) {
  return report.map(r =>
    `${r.sent ? 'SENT   ' : 'WOULD  '} #${r.invoiceNumber}  ${r.issueDate || '(no date)'}  ` +
    `AR ${r.arCode}  →  ${r.to.join(', ')}  [${r.source}]`
  );
}
