-- invoice-sync — D1 schema.
-- Spec: ops/SPEC-primus-stripe-invoice-sync.md §4 (idempotency), §0.2 (identity), §8 (documents).
--
-- Apply:  wrangler d1 execute invoice-sync --remote --file=./schema.sql
-- Local:  wrangler d1 execute invoice-sync --local  --file=./schema.sql
--
-- EVERY table that persists anything mode-dependent carries `mode` and includes it in the
-- uniqueness key. A test-mode row must never suppress a live-mode create — that failure mode
-- is silent and its symptom is "we never billed them."


-- ── PENDING MIGRATIONS — apply to remote D1 BEFORE deploying code that uses them ──────────────
--
-- DEPLOY ORDER IS SCHEMA FIRST, CODE SECOND. Backwards, the running worker issues statements
-- against columns that do not exist and every write fails mid-run.
--
-- THIS FILE IS THE RESUME DOCUMENT. Statements 1 and 2 are NOT re-runnable — SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so a second run errors `duplicate column name`. And re-running this
-- file repairs neither of them, because the columns live inside a `CREATE TABLE IF NOT EXISTS`
-- that no-ops against an existing table. A half-applied migration is therefore resumed BY COLUMN,
-- from a fresh PRAGMA — never by re-running the file.
--
--   1. ALTER TABLE ledger ADD COLUMN paid_first_seen_at INTEGER       -- NOT re-runnable
--   2. ALTER TABLE ledger ADD COLUMN customer_reference TEXT          -- NOT re-runnable
--   3. CREATE TABLE IF NOT EXISTS stripe_customer (...)               -- idempotent
--   4. CREATE UNIQUE INDEX IF NOT EXISTS stripe_customer_id_uniq ...  -- idempotent
--
-- Apply 1 and 2 as explicit --command ALTERs. Apply 3 and 4 by re-running this file, which is a
-- no-op for every table that already exists:
--   wrangler d1 execute invoice-sync --remote --command "ALTER TABLE ledger ADD COLUMN paid_first_seen_at INTEGER"
--   wrangler d1 execute invoice-sync --remote --command "ALTER TABLE ledger ADD COLUMN customer_reference TEXT"
--   wrangler d1 execute invoice-sync --remote --file=./schema.sql
--
-- Verify POSITIVELY afterwards — never an exit code (spec §0.25):
--   wrangler d1 execute invoice-sync --remote --command "PRAGMA table_info(ledger)"
--   wrangler d1 execute invoice-sync --remote --command "SELECT sql FROM sqlite_master WHERE tbl_name='stripe_customer'"
--
-- DOWN MIGRATION:
--   1, 2 — DO NOTHING. An added nullable column with no reader is inert, and dropping it is a
--          riskier operation than the one it would undo.
--   3, 4 — DROP TABLE stripe_customer. THIS EXPIRES AT THE FIRST STRIPE CREATE: once the table
--          holds a stripe_customer_id, dropping it orphans every Stripe object keyed through it,
--          which is precisely the failure the table exists to prevent. After the first create
--          there is no down migration, only a forward fix.


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
  -- MIGRATION: statement 2 in the PENDING block at the top of this file.
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
  -- MIGRATION: statement 1 in the PENDING block at the top of this file. (schema.sql is
  -- CREATE IF NOT EXISTS, so re-running it will NOT add this to a table that already exists.)
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


-- ── stripe_customer ──────────────────────────────────────────────────────────────────────────
-- The Stripe CUSTOMER identity, keyed (mode, ar_code). One row per customer, many ledger rows
-- against it, JOINED AT READ TIME.
--
-- There is deliberately NO stripe_customer_id copy on `ledger`. A copy would be N duplicates of a
-- single fact; it would turn the adoption path — rewriting the id after re-finding a customer
-- whose ledger write was lost — into a fan-out UPDATE carrying its own atomicity problem; and it
-- would be a second id column of exactly the shape whose unconditional overwrite is the defect
-- being fixed on ledger.stripe_invoice_id. Both sides of the join are already indexed:
-- ledger_ar_idx (mode, ar_code) on one side, this table's UNIQUE (mode, ar_code) on the other. If
-- the join ever costs anything, add an index, not a column.
--
-- NOT in the `cache` table, which is where a Stripe customer id most obviously wants to live and
-- must not. customerCacheKey (src/customers.js) is DELIBERATELY not mode-namespaced, because it
-- caches upstream Primus/QBO data that is identical in test and live. A Stripe customer id is the
-- opposite: mode-scoped, and meaningless across the boundary. Storing it there would either
-- destroy that rationale or let a live run attach a live invoice to a TEST-mode customer — the
-- exact failure mode-namespacing exists to prevent (spec §2.1). That cache also carries a 24h TTL
-- and a writer that swallows its own errors; an identifier that must survive does not live behind
-- a lossy, expiring, silent store.
CREATE TABLE IF NOT EXISTS stripe_customer (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  mode               TEXT    NOT NULL,           -- 'test' | 'live'
  ar_code            TEXT    NOT NULL,

  stripe_customer_id TEXT,
  -- intent  → row claimed, Stripe create not yet confirmed
  -- created → Stripe returned a customer
  -- failed  → create attempted and errored; retryable, still holds the claim
  state              TEXT    NOT NULL DEFAULT 'intent',

  -- Layer 2 of the same discipline as `ledger` (spec §4.2). Server-side and immediate, so it closes
  -- the sub-second race; it expires at 24h, so it closes nothing longer. The claim row is what
  -- persists past that, which is the whole reason this table exists.
  idempotency_key    TEXT    NOT NULL,

  qbo_display_name   TEXT,
  last_error         TEXT,

  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,

  -- CLAIM BEFORE CREATE, exactly as on `ledger` — deliberately the same discipline rather than a
  -- second one invented for customers. Total, no WHERE clause, so it is legal inline.
  UNIQUE (mode, ar_code)
);

-- Two ARCodes must never attach the SAME Stripe customer. That is a mis-join, not a coincidence,
-- and its consequence is one company's freight detail and amounts billed to another. PARTIAL, so
-- the many 'intent' rows with a NULL stripe_customer_id do not collide with each other.
--
-- This is necessarily its own statement: SQLite accepts no WHERE clause on an inline UNIQUE(...)
-- table constraint, so a partial unique index cannot be inline. It therefore fails, and re-runs,
-- independently of the CREATE TABLE above — statement 4 in the PENDING block, not part of 3.
CREATE UNIQUE INDEX IF NOT EXISTS stripe_customer_id_uniq
  ON stripe_customer (mode, stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;


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
