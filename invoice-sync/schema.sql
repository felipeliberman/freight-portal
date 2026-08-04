-- invoice-sync — D1 schema.
-- Spec: ops/SPEC-primus-stripe-invoice-sync.md §4 (idempotency), §0.2 (identity), §8 (documents).
--
-- Apply:  wrangler d1 execute invoice-sync --remote --file=./schema.sql
-- Local:  wrangler d1 execute invoice-sync --local  --file=./schema.sql
--
-- EVERY table that persists anything mode-dependent carries `mode` and includes it in the
-- uniqueness key. A test-mode row must never suppress a live-mode create — that failure mode
-- is silent and its symptom is "we never billed them."


-- ── ledger ───────────────────────────────────────────────────────────────────────────────────
-- The authoritative idempotency spine (spec §4.2 layer 1). A row is written BEFORE the Stripe
-- create is attempted, so the database rejects a concurrent second attempt regardless of timing.
-- Stripe Search cannot do this job: it is index-backed with ~1min lag, so two runs 30s apart
-- both see "no match" and both create.
CREATE TABLE IF NOT EXISTS ledger (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  mode                  TEXT    NOT NULL,           -- 'test' | 'live'
  primus_invoice_id     TEXT    NOT NULL,
  primus_invoice_number TEXT,
  bol_number            TEXT,
  ar_code               TEXT,

  -- The CUSTOMER'S OWN reference — what their AP matches against internally, and the only thing on
  -- the invoice that belongs to them rather than to us. Prints as "REF.#" on the Primus invoice.
  -- Source: shipment.consigneeReferenceNumber on the LIST response ONLY; the detail does not carry
  -- it (verified live 2026-08-03). Claim-time value, like ar_code — never re-derived later.
  -- MIGRATION: ALTER TABLE ledger ADD COLUMN customer_reference TEXT
  customer_reference    TEXT,

  -- Increments on reissue (spec §4.4). A finalized Stripe invoice cannot be edited, so a
  -- post-issuance amount change in Primus becomes void + reissue at version+1.
  version               INTEGER NOT NULL DEFAULT 1,

  -- 'primary' | 'rebill' | 'hold'. Written ONCE and never re-derived (spec §4.3): a later run
  -- sees more BOL collisions and would otherwise reclassify an invoice already sent.
  classification        TEXT,

  stripe_invoice_id     TEXT,
  -- intent  → row claimed, Stripe create not yet confirmed
  -- draft | finalized | void | paid | uncollectible → mirrors Stripe
  -- failed  → create attempted and errored; retryable, still holds the claim
  stripe_state          TEXT    NOT NULL DEFAULT 'intent',

  total_cents           INTEGER,
  idempotency_key       TEXT    NOT NULL,
  -- Set when a reissue supersedes this row; points at the successor's ledger id.
  superseded_by         INTEGER,
  last_error            TEXT,

  -- Written ONCE, when a poll first observes status.paid flip true (spec §4.6). Nothing reads it,
  -- nothing displays it, no feature is attached. It exists because it CANNOT BE BACKFILLED: Primus
  -- stores `paid` as a bare boolean with no date, so the moment passes unrecorded otherwise. This
  -- is the only payment timestamp that will ever exist outside QBO.
  --
  -- MIGRATION on an existing database (schema.sql is CREATE IF NOT EXISTS, so it will NOT add this
  -- to a table that already exists). Run before the next deploy:
  --   wrangler d1 execute invoice-sync --remote --command \
  --     "ALTER TABLE ledger ADD COLUMN paid_first_seen_at INTEGER"
  --   wrangler d1 execute invoice-sync --remote --command \
  --     "ALTER TABLE ledger ADD COLUMN customer_reference TEXT"
  paid_first_seen_at    INTEGER,

  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,

  UNIQUE (mode, primus_invoice_id, version)
);

-- One Stripe invoice can never be claimed by two ledger rows. Partial index so the many
-- 'intent' rows with a NULL stripe_invoice_id don't collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS ledger_stripe_invoice_uniq
  ON ledger (mode, stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;

-- BOL-level guard (spec §4.2 layer 3): the only defense against a Primus reissue that changes
-- BOTH invoiceId and invoiceNumber, where layers 1 and 2 both miss.
CREATE INDEX IF NOT EXISTS ledger_bol_idx ON ledger (mode, bol_number);

-- Reconcile pass (spec §3) sweeps by state, not by Stripe search.
CREATE INDEX IF NOT EXISTS ledger_state_idx ON ledger (mode, stripe_state);

CREATE INDEX IF NOT EXISTS ledger_ar_idx ON ledger (mode, ar_code);


-- ── exceptions ───────────────────────────────────────────────────────────────────────────────
-- Skip-and-record, never guess. Anything the sync cannot resolve confidently lands here and the
-- invoice is left alone: an unmatched ARCode (a QBO customer created without the -<ARCode>
-- DisplayName suffix), a document type in neither allowlist nor denylist, an ambiguous rebill
-- classification, a missing primary.
--
-- `detail` is SHORT and non-sensitive by construction. Never write a Primus detail object here:
-- costBreakdown / payableBreakdown / profitSummary / invoiceInternalRemarks carry carrier cost
-- and per-shipment GP (spec §6.1).
CREATE TABLE IF NOT EXISTS exceptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  mode          TEXT    NOT NULL,
  kind          TEXT    NOT NULL,   -- 'unmatched_ar_code' | 'unknown_doc_type'
                                    -- 'ambiguous_classification' | 'missing_primary' | 'fetch_failed'
  ref           TEXT    NOT NULL,   -- ARCode / invoiceId / BOLNumber / doc type code
  detail        TEXT,
  seen_count    INTEGER NOT NULL DEFAULT 1,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  resolved_at   INTEGER,

  UNIQUE (mode, kind, ref)
);

CREATE INDEX IF NOT EXISTS exceptions_open_idx ON exceptions (mode, kind) WHERE resolved_at IS NULL;


-- ── lease ────────────────────────────────────────────────────────────────────────────────────
-- Run lock (spec §3). Cloudflare will start a scheduled invocation while the previous one is
-- still running; ~1733 invoices/month at two API calls each is not fast.
--
-- This is a PERFORMANCE guard, not a correctness guard. Correctness is the ledger. If the lease
-- is ever wrong, the ledger still refuses the duplicate.
CREATE TABLE IF NOT EXISTS lease (
  name        TEXT    PRIMARY KEY,   -- includes mode, e.g. 'test:sync'
  holder      TEXT    NOT NULL,      -- opaque run id, for diagnosis only
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);


-- ── cache ────────────────────────────────────────────────────────────────────────────────────
-- Cross-isolate TTL cache. Currently: the Primus bearer token (24h, cached to its `exp`).
-- D1 rather than KV so this worker has exactly one binding, and so the lease above gets
-- SQLite's serialized writes instead of KV's eventual consistency.
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT    PRIMARY KEY,   -- includes mode where mode-dependent
  value      TEXT    NOT NULL,
  expires_at INTEGER NOT NULL
);
