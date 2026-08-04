// Spec phase 3 — invoice list poll.
//
// Reads a rolling window off the Primus system API, pages through it, dedupes, applies the pilot
// allowlist (§3.1), and claims a ledger row per surviving invoice. It stops there: no detail
// fetch, no Stripe. Rows land in 'intent' and phase 6 materializes them.
//
// The window deliberately OVERLAPS previous runs (spec §3). Invoices are editable after issuance
// and the list may sort on a mutable field, so a record can shift pages between calls and be
// silently skipped. Re-seeing an invoice must therefore be free — which it is, because the ledger
// refuses the duplicate claim rather than erroring.

import { findRows, findTotalResults } from './envelope.js';

/** Rolling window, inclusive, as YYYY-MM-DD. */
export function windowFor(nowMs, days = 7) {
  const to = new Date(nowMs);
  const from = new Date(nowMs - days * 86400000);
  return { issuedFrom: ymd(from), issuedTo: ymd(to) };
}

function ymd(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Find the rows array and the result count in whatever envelope Primus returns.
 *
 * The field NAMES are verified (spec §1); the envelope around them is not, so this accepts the
 * plausible shapes and fails with a shape description rather than a silent empty page. An
 * unrecognised envelope reading as "zero invoices" would look exactly like a quiet week.
 */
export function normalizePage(body) {
  // `shape` and `keys` are key names only, never values — logged every run so a silent envelope
  // change (or a count field appearing under a name we don't read) is visible rather than inferred.
  const { rows, shape, keys } = findRows(body, 'invoice list');
  return { rows, totalResults: findTotalResults(body), shape, keys };
}


/**
 * Money → integer cents. Mirrors the portal's parseMoney rule: strip $ and commas, never produce
 * NaN silently. Returns null when unparseable so the caller can route it to the exception queue
 * instead of writing a wrong amount.
 */
export function toCents(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/**
 * Page through one window. Yields raw invoice records, deduped by invoiceId across the whole run.
 *
 * Termination is guarded three ways because a runaway pager would hammer a shared production API:
 * a short page ends it, the reported totalResults bounds the page count, and a hard cap backstops
 * both. A page that yields nothing new also ends it — that is what a broken pager looks like.
 */
export async function* listInvoices(primus, { issuedFrom, issuedTo, limit = 100, maxPages = 200 }, stats = {}) {
  const seen = new Set();
  stats.pages = 0;
  stats.fetched = 0;
  stats.totalResults = null;

  for (let page = 1; page <= maxPages; page++) {
    const body = await primus.get('/invoice', { issuedFrom, issuedTo, page, limit });
    const { rows, totalResults, shape, keys } = normalizePage(body);
    stats.pages = page;
    stats.fetched += rows.length;
    if (totalResults !== null) stats.totalResults = totalResults;
    if (page === 1) { stats.envelope = shape; stats.envelopeKeys = keys; }

    let fresh = 0;
    for (const inv of rows) {
      const id = inv && (inv.invoiceId ?? inv.invoiceID ?? inv.id);
      if (id === undefined || id === null || id === '') { stats.missingId = (stats.missingId || 0) + 1; continue; }
      const key = String(id);
      if (seen.has(key)) continue;      // in-run dedupe, unconditional (spec §3 pass 1)
      seen.add(key);
      fresh++;
      yield inv;
    }

    if (rows.length < limit) break;                                   // short page = last page
    if (!fresh) break;                                                // pager repeating itself
    if (stats.totalResults !== null && stats.fetched >= stats.totalResults) break;
    if (page === maxPages) stats.hitPageCap = true;
  }

  stats.unique = seen.size;
}

/**
 * Poll a window and claim ledger rows. Returns a summary; writes nothing to Stripe.
 *
 * Ordering is load-bearing (spec §3.1): the allowlist filter runs BEFORE the ledger claim, so a
 * non-allowlisted invoice leaves no row at all. Recording skips would permanently suppress them
 * when the allowlist widens, since claim() would then return claimed:false forever.
 */
export async function pollWindow({ primus, ledger, allowlist, checkArCode, issuedFrom, issuedTo, limit = 100 }) {
  const s = {
    issuedFrom, issuedTo,
    pages: 0, fetched: 0, unique: 0, totalResults: null,
    notGenerated: 0, skippedNotAllowed: 0, nearMiss: 0, missingArCode: 0,
    claimed: 0, alreadyClaimed: 0, totalChanged: 0, missingTotal: 0, missingId: 0,
  };
  const listStats = {};

  for await (const inv of listInvoices(primus, { issuedFrom, issuedTo, limit }, listStats)) {
    if (!(inv.status && inv.status.generated === true)) { s.notGenerated++; continue; }

    const arCode = inv.ARCode ?? inv.arCode ?? null;
    const verdict = checkArCode(allowlist, arCode);
    if (!verdict.allowed) {
      s.skippedNotAllowed++;
      if (verdict.reason === 'near_miss') {
        s.nearMiss++;
        await ledger.recordException('unmatched_ar_code', String(arCode),
          'differs from an allowlist entry only by leading zeros — likely AR_ALLOWLIST typo');
      } else if (verdict.reason === 'missing_ar_code') {
        s.missingArCode++;
        await ledger.recordException('unmatched_ar_code', `invoice:${inv.invoiceId}`, 'invoice carries no ARCode');
      }
      continue;   // NO ledger row — see the doc comment above.
    }

    const totalCents = toCents(inv.total);
    if (totalCents === null) {
      // Do not claim on an amount we could not read; a wrong stored total would drive a bogus
      // void-and-reissue at phase 6.
      s.missingTotal++;
      await ledger.recordException('fetch_failed', `invoice:${inv.invoiceId}`, 'invoice total unparseable');
      continue;
    }

    const bolNumber = (inv.shipment && inv.shipment.BOLNumber) || null;
    // Claim-time only: the customer's own reference lives on the LIST response and NOT on the
    // detail (verified live 2026-08-03). If it is not captured here it is unavailable at map time.
    const customerReference = (inv.shipment && inv.shipment.consigneeReferenceNumber) || null;
    const { claimed, row } = await ledger.claim({
      primusInvoiceId: inv.invoiceId,
      primusInvoiceNumber: inv.invoiceNumber ?? null,
      bolNumber,
      arCode: arCode === null ? null : String(arCode),
      customerReference,
      totalCents,
    });

    if (claimed) s.claimed++;
    else {
      s.alreadyClaimed++;
      // Amount drift on an already-claimed invoice is the §4.4 edit path. Counted here so the
      // frequency is visible before phase 6 has to act on it; phase 6 owns the state machine.
      if (row && row.total_cents !== null && row.total_cents !== totalCents) s.totalChanged++;
    }

    // Spec §4.6 — stamp the first sighting of paid. Write-once; nothing reads it. Recorded here
    // because the list response is the only place `status.paid` is observed without a detail call,
    // and because the moment cannot be recovered later: Primus keeps no paid timestamp.
    if (inv.status.paid === true && row && row.id && row.paid_first_seen_at == null) {
      if (await ledger.markPaidFirstSeen(row.id)) s.paidFirstSeen = (s.paidFirstSeen || 0) + 1;
    }
  }

  s.pages = listStats.pages || 0;
  s.fetched = listStats.fetched || 0;
  s.unique = listStats.unique || 0;
  s.totalResults = listStats.totalResults;
  s.missingId = listStats.missingId || 0;
  s.envelope = listStats.envelope || null;
  s.envelopeKeys = listStats.envelopeKeys || null;
  if (listStats.hitPageCap) s.hitPageCap = true;

  // Integrity check: the window overlap is supposed to absorb page-shift skips, but a persistent
  // shortfall means it is not. Surfaced rather than assumed away.
  if (s.totalResults !== null && s.unique < s.totalResults) s.shortfall = s.totalResults - s.unique;

  return s;
}
