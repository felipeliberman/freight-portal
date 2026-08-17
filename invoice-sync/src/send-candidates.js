// WHICH INVOICES SHOULD BE EMAILED — the selection, and nothing else.
//
// Walks the rolling window, claims what belongs to the pilot, and returns the rows that are ready
// to send. It does NOT send: whether anything leaves is the send guard's decision (send-guard.js),
// and keeping the two apart is what stops the mode switch ending up behind a database query.
//
// ── THE RULE, AND WHY IT TAKES TWO CLAUSES ───────────────────────────────────────────────────
//
//     candidate = Primus says RED (status.sent === false)
//                 AND we have not sent it (ledger.first_sent_at IS NULL)
//
// The owner's workflow is: generate the invoice in Primus, DECLINE Primus's own email, and let
// this send it. Declining is what leaves the console's Sent column red — `status_sent` falsy,
// rendered `ball-red-icon` (js/desktop/Invoices.js), and exposed to us as `status.sent` on the
// REST list.
//
// NEITHER CLAUSE SURVIVES ALONE:
//
//   * RED ALONE RE-SENDS FOREVER. Primus's flag does not flip when WE send — Primus did not send.
//     The invoice stays red, so every cycle sees it again and emails it again.
//   * UNSENT ALONE EMAILS WHAT PRIMUS ALREADY DELIVERED. 296 of 300 invoices in a recent window
//     are `sent=true`; every one of those customers would receive a second copy.
//
// ── WHY NOT Ledger.openMintedUnsent ──────────────────────────────────────────────────────────
//
// It is the obvious thing to reach for, it reads like the right query, and it returns NOTHING for
// Phase 1. It requires `link_minted_at IS NOT NULL`, and Phase 1 is portal-only so no link is ever
// minted — `InvoiceLinks.mint()` has no production caller by design. Measured on production
// 2026-08-17: 11 unsent rows, 0 ever minted, so that query answers 0. A poller built on it would
// find no work and look like a quiet week rather than a broken selector.
//
// ── WHERE THE RED FLAG IS READ, AND WHY NOT FROM THE LEDGER ──────────────────────────────────
//
// From the LIST RESPONSE, in this pass. `status.sent` is on every row the poll already fetches, so
// the value used to decide is the value Primus holds right now. Persisting it would add a column
// that can go stale between runs, and a stale "not sent" is an invoice emailed twice.

import { findRows } from './envelope.js';
import { toCents } from './invoices.js';

/**
 * Collect the invoices ready to be emailed.
 *
 * @param {object}   primus        a read-only PrimusClient
 * @param {Ledger}   ledger
 * @param {{all:boolean, codes:Set<string>}} allowlist  the pilot bound (§3.1)
 * @param {Function} checkArCode   from config.js — the same verdict the poll uses
 * @param {string}   issuedFrom    YYYY-MM-DD
 * @param {string}   issuedTo      YYYY-MM-DD
 * @param {string|null} sendFromDate  the BACKFILL FLOOR; invoices issued earlier are never
 *   candidates. See below — this is the sharpest risk in the piece.
 * @param {number}   cap           most candidates one run may return
 * @returns {{candidates:Array<{row:object, invoiceNumber:string, issueDate:string}>, ...counters}}
 */
export async function collectSendCandidates({
  primus, ledger, allowlist, checkArCode,
  issuedFrom, issuedTo, sendFromDate = null, cap = 25, limit = 100, maxPages = 200,
}) {
  const s = {
    issuedFrom, issuedTo, floor: sendFromDate || null, seen: 0,
    notGenerated: 0, notRed: 0, skippedNotAllowed: 0, beforeFloor: 0, alreadySentByUs: 0,
    claimed: 0, alreadyClaimed: 0, missingTotal: 0,
    cappedAt: null, dropped: 0,
    candidates: [],
  };

  for (let page = 1; page <= maxPages; page++) {
    const body = await primus.get('/invoice', { issuedFrom, issuedTo, page, limit });
    const { rows } = findRows(body, 'invoice list');

    for (const inv of rows) {
      s.seen++;

      // Only a generated invoice exists to be emailed at all.
      if (!(inv.status && inv.status.generated === true)) { s.notGenerated++; continue; }

      // ── CLAUSE ONE: RED ───────────────────────────────────────────────────────────────────
      // Read from THIS response, never from a stored copy.
      if (inv.status.sent === true) { s.notRed++; continue; }

      const arCode = inv.ARCode ?? inv.arCode ?? null;
      if (!checkArCode(allowlist, arCode).allowed) {
        // NO ledger row, deliberately (spec §3.1): recording skips would make claim() refuse
        // these forever once the bound widens, turning a widened pilot into a silent never-billed.
        s.skippedNotAllowed++;
        continue;
      }

      // ── THE BACKFILL FLOOR ────────────────────────────────────────────────────────────────
      // The ledger already holds rows claimed during earlier phases, every one with
      // `first_sent_at IS NULL`. Without a floor the first run that can send emails ALL of them —
      // months of history, at once, irreversibly. An unreadable date fails CLOSED for the same
      // reason: a date we cannot compare is not a date that passed.
      if (sendFromDate && !issuedOnOrAfter(inv.issueDate, sendFromDate)) { s.beforeFloor++; continue; }

      const totalCents = toCents(inv.total);
      if (totalCents === null) { s.missingTotal++; continue; }

      const { claimed, row } = await ledger.claim({
        primusInvoiceId: inv.invoiceId,
        primusInvoiceNumber: inv.invoiceNumber ?? null,
        issueDate: inv.issueDate ?? null,
        invoiceDueDate: inv.invoiceDueDate ?? null,
        bolNumber: (inv.shipment && inv.shipment.BOLNumber) || null,
        arCode: arCode === null ? null : String(arCode),
        customerReference: (inv.shipment && inv.shipment.consigneeReferenceNumber) || null,
        totalCents,
      });
      claimed ? s.claimed++ : s.alreadyClaimed++;

      // ── CLAUSE TWO: NOT SENT BY US ────────────────────────────────────────────────────────
      // The ledger is the authority, not Primus. `first_sent_at` is write-once and set only on a
      // delivered send, so this is the clause that stops the loop clause one would otherwise make.
      if (!row || row.first_sent_at != null) { s.alreadySentByUs++; continue; }

      if (s.candidates.length >= cap) {
        // NO SILENT TRUNCATION. A bounded run that reads as complete is how an invoice nobody
        // billed disappears — so what was dropped is counted and returned.
        s.cappedAt = cap;
        s.dropped++;
        continue;
      }

      s.candidates.push({ row, invoiceNumber: inv.invoiceNumber ?? null, issueDate: inv.issueDate ?? null });
    }

    if (rows.length < limit) break;
  }

  return s;
}

/**
 * Is this invoice's issue date on or after the floor?
 *
 * Compared as YYYY-MM-DD STRINGS, which sort lexically and need no timezone decision — the floor
 * is a business boundary someone types, not an instant. `Date` parsing would introduce exactly the
 * zone ambiguity §8.867 keeps warning about, for no gain.
 *
 * Returns FALSE for anything unreadable, so a missing or malformed date cannot cross a floor.
 */
export function issuedOnOrAfter(issueDate, floor) {
  const day = String(issueDate ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  return day >= String(floor).trim().slice(0, 10);
}
