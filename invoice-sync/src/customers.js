// Spec phase 4 — customer resolution.
//
// ARCode → QBO customer → recipient emails. ARCode IS the customer key (spec §0.2, decided by
// elimination); `customerInfo.customerId` is carried alongside as Stripe metadata, not as the key.
// Resolution NEVER guesses: an unmatched or ambiguous ARCode goes to the exception
// queue and the invoice is left alone. A wrong customer match would send one customer's freight
// detail, consignee names, and amounts to another — unrecoverable in a way a skipped invoice is not.

import { findRows, describeShape } from './envelope.js';
import { fetchInvoiceDetail, auditValues } from './detail.js';

const CACHE_TTL_MS = 24 * 3600 * 1000;

/**
 * Cache key is NOT mode-namespaced, unlike ledger and lease keys.
 *
 * Deliberate: this caches upstream Primus/QBO data, which is identical in test and live. The thing
 * mode-namespacing protects against is test-mode state suppressing a live-mode action, and a
 * customer record cannot do that — the worst case is serving the same correct data twice.
 */
export function customerCacheKey(arCode) {
  return `qbo:ar:${String(arCode).trim().toUpperCase()}`;
}

/**
 * QBO DisplayName is `<Company>-<ARCode>` (verified: "Bison Office LLC-2395", "Payless Rugs-5406").
 *
 * Matched as an exact suffix after the final hyphen — NOT `endsWith`, which would match
 * "Acme-15406" against ARCode "5406" and bill the wrong company.
 */
export function displayNameMatchesArCode(displayName, arCode) {
  if (!displayName || arCode === null || arCode === undefined) return false;
  const idx = String(displayName).lastIndexOf('-');
  if (idx === -1) return false;
  const suffix = String(displayName).slice(idx + 1).trim().toUpperCase();
  return suffix === String(arCode).trim().toUpperCase();
}

/**
 * Choose the QBO record for an ARCode from a search result.
 *
 * `/quickbooks/customers?name=` is a fuzzy search, so extra records are expected and are filtered
 * by the DisplayName suffix rather than trusted by position. Two survivors is a data problem, not
 * a tie to break.
 */
export function pickQboCustomer(records, arCode) {
  const rows = Array.isArray(records) ? records : [];
  const matches = rows.filter(r => displayNameMatchesArCode(r && r.DisplayName, arCode));
  if (matches.length === 1) return { ok: true, record: matches[0] };
  if (matches.length === 0) {
    // Name what actually came back. "No match" alone leaves a human with nothing to act on, and
    // this queue is the whole mechanism for the QBO customers that lack the -<ARCode> convention.
    // Company names only — no amounts, no contact details.
    const names = rows.map(r => (r && r.DisplayName) || `(no DisplayName, keys ${describeShape(r)})`).slice(0, 3).join(' | ');
    return {
      ok: false,
      reason: 'no_display_name_suffix',
      detail: `search returned ${rows.length} record(s), none with a -${arCode} suffix: ${names}`.slice(0, 300),
    };
  }
  return { ok: false, reason: 'ambiguous', detail: `${matches.length} QBO customers carry the -${arCode} suffix` };
}

/**
 * `PrimaryEmailAddr.Address` may hold several comma-separated addresses
 * (e.g. "nickz@paylessrugs.com,ap@paylessrugs.com").
 *
 * These are RECIPIENTS, not identity (spec §0.2) — the Stripe customer is keyed on ARCode, so
 * which address sorts first never determines who gets billed.
 */
export function parseEmails(raw) {
  const parts = String(raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.includes('@'));
  return { primary: parts[0] ?? null, cc: parts.slice(1) };
}

/** QBO record → only what Stripe needs. Balance, terms, and the rest stay upstream. */
export function narrowQboCustomer(rec) {
  const addr = (rec && rec.BillAddr) || {};
  const { primary, cc } = parseEmails(rec && rec.PrimaryEmailAddr && rec.PrimaryEmailAddr.Address);
  return {
    qboId: (rec && rec.Id) ?? null,
    displayName: (rec && rec.DisplayName) ?? null,
    primaryEmail: primary,
    ccEmails: cc,
    billAddr: {
      line1: addr.Line1 ?? null,
      city: addr.City ?? null,
      state: addr.CountrySubDivisionCode ?? null,
      postalCode: addr.PostalCode ?? null,
      country: addr.Country ?? null,
    },
  };
}

/**
 * Resolve one ARCode to a customer record, caching the result.
 *
 * `sampleInvoiceId` supplies `customerInfo.customerId`, which lives on the invoice detail rather
 * than on QBO. It is metadata (spec §0.2), not the key — resolution succeeds without it.
 *
 * @returns {object|null} null means unresolved — an exception was recorded and the caller must skip.
 */
export async function resolveCustomer({ primus, db, ledger, arCode, sampleInvoiceId, valueSink = null, now = Date.now(), force = false }) {
  const key = customerCacheKey(arCode);

  if (!force) {
    const cached = await readCache(db, key, now);
    if (cached) return cached;
  }

  // ── QBO half ──────────────────────────────────────────────────────────────────────────────
  // Searching by the ARCode itself: the endpoint requires a `name`, and DisplayName embeds the code.
  let rows;
  try {
    const body = await primus.get('/quickbooks/customers', { name: String(arCode) });
    rows = findRows(body, 'quickbooks customer').rows;
  } catch (err) {
    await ledger.recordException('unmatched_ar_code', String(arCode), `QBO lookup failed: ${short(err)}`);
    return null;
  }

  const picked = pickQboCustomer(rows, arCode);
  if (!picked.ok) {
    // The user's rule: log it, skip the invoice, never guess at a match.
    await ledger.recordException('unmatched_ar_code', String(arCode), picked.detail);
    return null;
  }
  const qbo = narrowQboCustomer(picked.record);

  if (!qbo.primaryEmail) {
    await ledger.recordException('unmatched_ar_code', String(arCode),
      'QBO customer has no PrimaryEmailAddr — nowhere to deliver an invoice');
    return null;
  }

  // ── primusCustomerId half ─────────────────────────────────────────────────────────────────
  let primusCustomerId = null;
  if (sampleInvoiceId) {
    try {
      const detail = await fetchInvoiceDetail(primus, sampleInvoiceId);
      const ci = detail.customerInfo;
      if (ci && String(ci.customerCode ?? '').trim() !== String(arCode).trim()) {
        // The list and the detail disagree about which customer this invoice belongs to. Never
        // reconciled by preferring one — it means an assumption underneath the join is wrong.
        await ledger.recordException('unmatched_ar_code', String(arCode),
          `detail customerCode ${ci.customerCode} != list ARCode ${arCode}`);
        return null;
      }
      primusCustomerId = (ci && ci.customerId) ?? null;

      // Value-level audit (never throws). A null REQUIRED value quarantines this one invoice and
      // the run continues; optional nulls are counted so a rate change is visible the same day.
      const audit = auditValues(detail, valueSink);
      if (!audit.ok) {
        await ledger.quarantine(sampleInvoiceId, 'null_required_value',
          `null required value(s): ${audit.missingRequired.join(', ')}`);
      }

      if (!primusCustomerId) {
        // No longer blocking: §0.2 keys Stripe customers on ARCode, so a null customerId costs
        // metadata, not the ability to bill. Still recorded — a change in its availability is a
        // signal about Primus worth seeing the day it happens.
        await ledger.recordException('missing_primus_customer_id', String(arCode),
          `invoice ${sampleInvoiceId}: customerInfo ${describeShape(ci)}; record keys ${detail._sourceKeys}`);
      }
    } catch (err) {
      await ledger.recordException('fetch_failed', `invoice:${sampleInvoiceId}`, `detail fetch failed: ${short(err)}`);
      return null;
    }
  }

  const resolved = { arCode: String(arCode), primusCustomerId, ...qbo, resolvedAt: now };
  await writeCache(db, key, resolved, now + CACHE_TTL_MS);
  return resolved;
}

/**
 * Resolve every distinct ARCode carrying unmaterialized ledger rows.
 *
 * One QBO search plus one detail call per DISTINCT customer, not per invoice — the subrequest
 * budget (spec §3.2) does not survive per-invoice resolution at full-book scale.
 */
export async function resolveClaimedCustomers({ primus, db, ledger, valueSink = null, now = Date.now() }) {
  const { results } = await db
    .prepare(
      `SELECT ar_code, MIN(primus_invoice_id) AS sample_invoice_id, COUNT(*) AS n
         FROM ledger
        WHERE mode = ? AND stripe_state = 'intent' AND ar_code IS NOT NULL
        GROUP BY ar_code`
    )
    .bind(ledger.mode)
    .all();

  const summary = { customers: (results || []).length, resolved: 0, unresolved: 0, withPrimusId: 0, detail: [] };

  for (const row of results || []) {
    const r = await resolveCustomer({ primus, db, ledger, arCode: row.ar_code, sampleInvoiceId: row.sample_invoice_id, valueSink, now });
    if (!r) { summary.unresolved++; continue; }
    summary.resolved++;
    if (r.primusCustomerId) summary.withPrimusId++;
    // Logged fields are identity and routing only — no amounts, no cost, no margin.
    summary.detail.push({
      arCode: r.arCode,
      displayName: r.displayName,
      primusCustomerId: r.primusCustomerId,
      emails: 1 + r.ccEmails.length,
      invoices: row.n,
    });
  }
  return summary;
}

async function readCache(db, key, now) {
  try {
    const row = await db.prepare('SELECT value, expires_at FROM cache WHERE key = ?').bind(key).first();
    if (!row || Number(row.expires_at) <= now) return null;
    return JSON.parse(row.value);
  } catch {
    return null;   // a cache miss must never take down a run
  }
}

async function writeCache(db, key, value, expiresAt) {
  try {
    await db
      .prepare(
        'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
      )
      .bind(key, JSON.stringify(value), expiresAt)
      .run();
  } catch { /* non-fatal */ }
}

/** Error text only, truncated — never an upstream response body (spec §6.3). */
function short(err) {
  return String((err && err.message) || err).slice(0, 120);
}
