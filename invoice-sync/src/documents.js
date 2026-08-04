// Spec §8 + §6.4 — document exposure and scoped links.
//
// NOTHING HERE FETCHES, MIRRORS, OR WRITES. It decides what MAY be exposed and derives the token a
// link would carry. The R2 mirror is deliberately not built: mirroring writes customer documents —
// PODs carrying consignee home addresses and phone numbers, on a book that is ~90% residential —
// and that is a real data-handling action, not a refactor.
//
// ALLOWLIST, NEVER DENYLIST (§8). The per-BOL document response returns internal documents beside
// customer-facing ones, and its type codes do not match /document/filetype: LBL and DO appear in
// one, SHP and MET in the other. A denylist built from either list is blind to the other.

/** Trim and uppercase before ANY comparison. `BOL ` carries a trailing space in the live response. */
export function normalizeType(t) {
  return String(t ?? '').trim().toUpperCase();
}

/** Safe to expose behind a scoped PULL link. */
export const CUSTOMER_FACING = Object.freeze(['BOL', 'RECLASS', 'REWEIGH', 'DIM', 'COI', 'POD', 'IMG']);

/**
 * Safe to PUSH inline — rebills only, where the document IS the justification for the charge.
 *
 * IMG is deliberately ABSENT. Driver delivery photos show the consignee's house, door, plates and
 * sometimes people. The bill-to is frequently a retailer or third party with no relationship to the
 * delivery address, so pushing IMG hands over their end customer's home. Safe behind a scoped pull
 * link; wrong as a push.
 */
export const AUTO_PUSH = Object.freeze(['RECLASS', 'REWEIGH']);

/** Named for documentation and for the negative controls. The ALLOWLIST is the enforcement. */
export const NEVER_EXPOSE = Object.freeze([
  'COST',    // vendor quote — carrier cost
  'QUO',     // customer quote
  'INV',     // Primus invoice PDF — superseded by the Stripe invoice
  'DO', 'CLBL', 'LBL', 'SHP', 'MET',   // carrier / shipping labels
  'CLM', 'CLMD',                       // claims correspondence — carrier settlement positions
  'MISDOC',                            // unknown by definition; the drawer everything ambiguous lands in
  'CI',                                // commercial invoice — can carry the shipper's pricing to THEIR buyer
]);

/**
 * @returns {'pull'|'never'|'unknown'} exposure for a single type code.
 *
 * `unknown` is NOT `never` by accident — it is excluded like `never`, but it is also RECORDED. A
 * new Primus document type must be visible in both directions; silently dropping it means a
 * customer-facing document never appears and nobody learns why.
 */
export function classifyDocument(type) {
  const t = normalizeType(type);
  if (!t) return 'unknown';
  if (CUSTOMER_FACING.includes(t)) return 'pull';
  if (NEVER_EXPOSE.includes(t)) return 'never';
  return 'unknown';
}

/**
 * Decide what a given invoice exposes.
 *
 * @param {object[]} docs            the /document/bolnumber response rows
 * @param {string}   classification  'primary' | 'rebill' | 'hold' | null
 * @returns {{pull:object[], push:object[], excluded:object[], unknown:string[]}}
 *
 * PUSH is rebill-only. On a primary the customer gets a pull link and nothing else — most customers
 * do not want a POD, and pushing one invites questions on a clean delivery.
 */
export function selectDocuments(docs, classification) {
  const rows = Array.isArray(docs) ? docs : [];
  const out = { pull: [], push: [], excluded: [], unknown: [] };

  for (const d of rows) {
    const t = normalizeType(d && d.type);
    const verdict = classifyDocument(t);
    if (verdict === 'never') { out.excluded.push({ type: t, why: 'never_expose' }); continue; }
    if (verdict === 'unknown') {
      out.excluded.push({ type: t, why: 'unknown_type' });
      out.unknown.push(t);                       // recorded, not merely dropped
      continue;
    }
    out.pull.push({ type: t, name: (d && d.name) ?? null });
    if (classification === 'rebill' && AUTO_PUSH.includes(t)) out.push.push({ type: t, name: (d && d.name) ?? null });
  }
  return out;
}

/**
 * Token for a document link — scoped per (INVOICE, DOCUMENT), never per document alone.
 *
 * Two parties can bill on one BOL (shipper-paid vs consignee-paid rebill). A per-document token
 * handed to one grants the other's view of the same file, so the invoice must be part of the key.
 *
 * HMAC-SHA256 over `${primusInvoiceId}:${bolNumber}:${type}` with a server-side secret. Derived
 * rather than stored so no token table can drift from the links already issued; unguessable because
 * the secret is not in the URL.
 */
export async function deriveDocToken(secret, primusInvoiceId, bolNumber, type) {
  if (!secret) throw new Error('deriveDocToken requires a secret — an unkeyed token is guessable');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const msg = `${primusInvoiceId}:${bolNumber}:${normalizeType(type)}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** `{BOLNumber}_{TYPE}.pdf` — Primus's own convention, so a download lands with a sensible name. */
export function documentFilename(bolNumber, type) {
  return `${bolNumber}_${normalizeType(type)}.pdf`;
}
