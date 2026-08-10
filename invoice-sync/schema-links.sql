-- invoice-sync — the INVOICE LINK database. SEPARATE from the ledger's D1, deliberately.
--
-- Spec: ops/SPEC-primus-stripe-invoice-sync.md §8.878 (the identifier decision), §8.879 (this store).
--
-- Apply:  wrangler d1 execute invoice-links --remote --file=./schema-links.sql
--
-- ── WHY THIS IS A SECOND DATABASE, NOT A SECOND TABLE ────────────────────────────────────────
--
-- The public Worker reads this. The ledger's D1 also holds `exceptions` and `cache` — and `cache`
-- holds `qbo:ar:*` rows carrying CUSTOMER EMAIL ADDRESSES. Binding a public route to that database
-- and promising to read only one table is a convention, not a control.
--
-- Held apart, THE PUBLIC WORKER'S ENTIRE DATA SURFACE IS POSSESSION-TIER BY CONSTRUCTION. If it is
-- ever breached it discloses exactly the tier already decided safe on possession, because nothing
-- else is reachable from there. Same boundary as keeping Primus credentials off the public Worker:
-- the thing answering strangers holds only what strangers may see.
--
-- The FILE lives with invoice-sync because invoice-sync is the WRITER, and schema-first discipline
-- means whoever owns the migration owns the file. The new Worker only reads.
--
-- ── THE COST, NAMED: THE MINT IS NOT TRANSACTIONAL ──────────────────────────────────────────
--
-- Minting writes THIS database and then stamps `ledger.link_minted_at` in the OTHER one. Two
-- databases, no transaction. If the mint succeeds and the stamp fails, a re-run must not produce a
-- second live link — so `invoice_link_active` below refuses the duplicate and the caller reads back
-- the existing token and re-stamps. THE CONSTRAINT ABSORBS THE FAILURE; the discipline is the same
-- claim-before-create shape as the ledger and does not need reinventing.

CREATE TABLE IF NOT EXISTS invoice_link (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  mode               TEXT    NOT NULL,           -- 'test' | 'live'; part of every key, as everywhere
  token              TEXT    NOT NULL,           -- 128 bits of CSPRNG, base64url, 22 chars
  primus_invoice_id  TEXT    NOT NULL,
  ar_code            TEXT    NOT NULL,           -- the SESSION tier resolves ownership on this

  -- ── THE POSSESSION-TIER SNAPSHOT ──────────────────────────────────────────────────────────
  --
  -- Exactly what §8.878 permits without a session, and NOTHING ELSE. The possession tier is a
  -- SCHEMA boundary first and a rendering rule second: a field cannot leak from a table that does
  -- not hold it. `customer_reference` (the customer's own PO) is behind the session, so there is no
  -- column for it here — that is the allowlist rule applied one layer below the renderer.
  --
  -- FROZEN AT MINT, and the duplication with `ledger` is only apparent. Primus invoices are
  -- editable after issuance (§4.4), so the possession page must render WHAT THE CUSTOMER WAS SENT,
  -- not what the ledger now says. A join to live data would silently restate the amount on a link
  -- someone received a month ago, showing them a number that never appeared in their email.
  -- These are DIFFERENT FACTS that happen to agree at mint time. Do not normalise them.
  invoice_number     TEXT,
  issue_date         TEXT,                       -- YYYY-MM-DD, captured from the LIST (§1)
  due_date           TEXT,                       -- YYYY-MM-DD, captured from the LIST (§1)
  total_cents        INTEGER,
  bol_number         TEXT,

  -- Revocation, not expiry. There is DELIBERATELY no `expires_at`: AR runs long and a link that
  -- dies at 30 days generates support calls, so the decision was no hard expiry with revocation as
  -- the control. An inert nullable column would invite someone to set it and quietly re-litigate a
  -- settled decision. IF IT IS EVER WANTED it is one additive nullable column — the cheapest
  -- migration shape there is. The door is not closed, it is simply not standing open.
  revoked_at         INTEGER,

  created_at         INTEGER NOT NULL,
  last_seen_at       INTEGER,                    -- diagnostic only; nothing keys on it

  UNIQUE (mode, token)
);

-- AT MOST ONE ACTIVE LINK PER INVOICE. This is what makes the mint idempotent at the database
-- rather than by remembering: a re-send reaches the SAME link. Two live links to one invoice would
-- mean revoking a leaked one still leaves the other open.
--
-- PARTIAL, so revoked rows accumulate as history without blocking a replacement.
CREATE UNIQUE INDEX IF NOT EXISTS invoice_link_active
  ON invoice_link (mode, primus_invoice_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS invoice_link_ar_idx ON invoice_link (mode, ar_code);
