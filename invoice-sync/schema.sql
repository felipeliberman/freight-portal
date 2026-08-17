-- invoice-sync — D1 schema.
-- Spec: ops/SPEC-primus-stripe-invoice-sync.md §4 (idempotency), §0.2 (identity), §8 (documents).
--
-- Apply:  wrangler d1 execute invoice-sync --remote --file=./schema.sql
-- Local:  wrangler d1 execute invoice-sync --local  --file=./schema.sql
--
-- EVERY table that persists anything mode-dependent carries `mode` and includes it in the
-- uniqueness key. A test-mode row must never suppress a live-mode create — that failure mode
-- is silent and its symptom is "we never billed them."


-- ── MIGRATIONS — NOTHING IS PENDING (production, verified 2026-08-17) ─────────────────────────
--
-- DEPLOY ORDER IS SCHEMA FIRST, CODE SECOND. Backwards, the running worker issues statements
-- against columns that do not exist and every write fails mid-run.
--
-- THIS FILE IS THE RESUME DOCUMENT. Every ALTER below is NOT re-runnable — SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so a second run errors `duplicate column name`. And re-running this
-- file repairs none of them, because the columns live inside a `CREATE TABLE IF NOT EXISTS`
-- that no-ops against an existing table. A half-applied migration is therefore resumed BY COLUMN,
-- from a fresh PRAGMA — never by re-running the file. That is still the procedure for the NEXT
-- migration; it is recorded here because the list below no longer demonstrates it.
--
-- ── ALL APPLIED — do NOT run any of these again ──────────────────────────────────────────────
-- Verified against production by PRAGMA and sqlite_master, not assumed. Each ALTER re-run errors
-- `duplicate column name`, which is why they are marked rather than left listed as work.
--   1. ALTER TABLE ledger ADD COLUMN paid_first_seen_at INTEGER       -- APPLIED
--   2. ALTER TABLE ledger ADD COLUMN customer_reference TEXT          -- APPLIED
--   3. CREATE TABLE IF NOT EXISTS stripe_customer (...)               -- APPLIED
--   4. CREATE UNIQUE INDEX IF NOT EXISTS stripe_customer_id_uniq ...  -- APPLIED
--   5. ALTER TABLE ledger ADD COLUMN issue_date TEXT                  -- APPLIED 2026-08-17
--   6. ALTER TABLE ledger ADD COLUMN invoice_due_date TEXT            -- APPLIED 2026-08-17
--   7. ALTER TABLE ledger ADD COLUMN link_minted_at INTEGER           -- APPLIED 2026-08-17
--   8. ALTER TABLE ledger ADD COLUMN first_sent_at INTEGER            -- APPLIED 2026-08-17
--   9. CREATE TABLE IF NOT EXISTS invoice_send (...)                  -- APPLIED 2026-08-17
--  10. CREATE INDEX IF NOT EXISTS invoice_send_inv_idx / _out_idx     -- APPLIED 2026-08-17
--
-- Production `ledger` now carries all 22 columns this file declares, and `invoice_send` exists
-- with its 14. THE POLLER'S PREREQUISITE IS CLEARED: `Ledger.markLinkMinted` and
-- `openMintedUnsent` read `link_minted_at`, and the claim path writes `issue_date` /
-- `invoice_due_date` — all three were missing until 5, 6 and 7 landed.
--
-- 5, 6 and 7 were applied guarded (PRAGMA first, ALTER only when absent) and verified positively
-- on local and then remote, the same way 8/9/10 were. No script was added for them: three plain
-- ALTERs did not justify a second copy of apply-send-log.sh's scaffolding. IF A THIRD GROUP EVER
-- COMES, generalise that script rather than writing a third one.
--
-- Applied by ./apply-send-log.sh, which reads the DDL out of THIS FILE rather than restating it,
-- and verifies positively afterwards. Confirmed on production: ledger.first_sent_at present,
-- invoice_send present with its 14 columns, both indexes present.
--
-- TWO THINGS THAT RUN LEARNED, WORTH HAVING WRITTEN DOWN:
--
--   * `--file=` DOES NOT WORK AGAINST REMOTE UNDER AN OAUTH LOGIN. It posts to the D1 *import*
--     endpoint, which returned `Authentication error [code: 10000]` while the same session's
--     `--command` (query endpoint) worked and `wrangler whoami` reported `d1 (write)`. A remote
--     apply therefore goes statement by statement; `--file` is still correct for `--local` and
--     for a fresh database, and may work under an API token rather than an OAuth login.
--
--   * REMOTE D1 IS NOT READ-YOUR-WRITES. A verification immediately after creating both indexes
--     reported one of them NOT FOUND; a direct query moments later showed both. The object
--     existed, the read had not caught up. apply-send-log.sh retries a check three times before
--     believing a negative, and anything else verifying a fresh write should do the same.
--
-- A SECOND DATABASE is also required — schema-links.sql, applied to its own D1 (`invoice-links`).
-- It is separate on purpose: the public Worker reads it, and the ledger's D1 also holds `cache`,
-- which carries customer email addresses. See that file.
--
-- NOTHING IS LEFT TO APPLY. Every statement 1-10 is on production; running any of the ALTERs
-- again errors with `duplicate column name`. A `--file=./schema.sql` remains correct for --local
-- and for a fresh database, where it creates everything at once.
--
-- FOR THE NEXT MIGRATION, whatever it turns out to be: add the object to this file, add a numbered
-- line above, apply it guarded (PRAGMA first, ALTER only when the column is absent) and verify
-- positively — never on an exit code, and never on a single read (see the read-your-writes note).
--
-- And the SECOND database, which is its own D1 and its own apply:
--   wrangler d1 create invoice-links
--   wrangler d1 execute invoice-links --remote --file=./schema-links.sql
--
-- Verify POSITIVELY afterwards — never an exit code (spec §0.25):
--   wrangler d1 execute invoice-sync  --remote --command "PRAGMA table_info(ledger)"
--   wrangler d1 execute invoice-sync  --remote --command "SELECT sql FROM sqlite_master WHERE tbl_name='stripe_customer'"
--   wrangler d1 execute invoice-sync  --remote --command "SELECT sql FROM sqlite_master WHERE tbl_name='invoice_send'"
--   wrangler d1 execute invoice-links --remote --command "SELECT name, sql FROM sqlite_master WHERE tbl_name='invoice_link'"
--
-- DOWN MIGRATION:
--   1, 2, 5, 6, 7, 8 — DO NOTHING. An added nullable column with no reader is inert, and dropping
--          it is a riskier operation than the one it would undo.
--   9, 10 — DROP TABLE invoice_send. EXPIRES AT THE FIRST SEND: once a row exists it is the ONLY
--          record that an invoice was emailed. SendGrid's Activity Feed retains 3 days (§8.875),
--          so after 72 hours dropping this table destroys evidence that cannot be reconstructed —
--          including the date C1's dispute clock runs from.
--   3, 4 — DROP TABLE stripe_customer. THIS EXPIRES AT THE FIRST STRIPE CREATE: once the table
--          holds a stripe_customer_id, dropping it orphans every Stripe object keyed through it,
--          which is precisely the failure the table exists to prevent. After the first create
--          there is no down migration, only a forward fix.
--   invoice-links — DROP TABLE invoice_link. EXPIRES AT THE FIRST LINK SENT: once a customer holds
--          a link, dropping the table does not revoke it, it makes it unresolvable AND unrevocable.


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
  -- The legal values are STRIPE_STATES in src/ledger.js, which is AUTHORITATIVE — do not restate
  -- the list here. A comment inside CREATE TABLE is frozen into the live database's stored DDL at
  -- creation, so a list duplicated here silently diverges from the code the day a state is added,
  -- and cannot be corrected without a table rebuild. Point at the source instead of copying it.
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

  -- Captured AT CLAIM from the LIST response, which carries both (spec §1) — the same reason
  -- customer_reference is captured there. The possession page must render without a Primus call on
  -- an unauthenticated route, so these have to exist before a link is minted.
  -- MIGRATION: statements 5 and 6 in the PENDING block.
  issue_date            TEXT,
  invoice_due_date      TEXT,

  -- Write-once stamp: the moment a customer-facing link was first minted for this invoice.
  -- THE RECONCILIATION POINT for a half-failed mint. The mint writes the LINKS database and then
  -- stamps here — two databases, no transaction. If the stamp fails, a re-run finds the link
  -- already active (invoice_link_active refuses the duplicate), reads the token back, and re-stamps.
  -- MIGRATION: statement 7 in the PENDING block.
  link_minted_at        INTEGER,

  -- WRITE-ONCE. When we FIRST emailed this invoice — never "when we last did".
  --
  -- C1's dispute clause starts a 3-business-day clock on our send date. Anchored on the latest
  -- send instead, a resend in week three would silently move a customer's dispute deadline under
  -- them — a contractual change nobody decided to make. Write-once makes the anchor unmovable BY
  -- CONSTRUCTION rather than by discipline, the same guard link_minted_at already carries.
  --
  -- Denormalised from invoice_send on purpose: this also makes "minted but never sent" a
  -- single-table query with no join (see Ledger.openMintedUnsent).
  first_sent_at         INTEGER,

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
  -- Legal values: STRIPE_CUSTOMER_STATES in src/stripe-customer.js, which is AUTHORITATIVE.
  -- Not restated here, for the reason given on ledger.stripe_state above.
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


-- ── invoice_send ─────────────────────────────────────────────────────────────────────────────
-- THE SEND LOG (spec §8.883). What we sent, to whom, when, and what happened — INCLUDING failures.
--
-- ── WHY A TABLE AND NOT COLUMNS ON `ledger` ──────────────────────────────────────────────────
-- One invoice has SEVERAL attempts: a retry, a resend, a bounce, a corrected recipient. Columns on
-- `ledger` hold only the last one, and "what did we send, to whom" is exactly the question that
-- must survive the second attempt.
--
-- ── WHY THIS DATABASE AND NOT THE LINKS DATABASE — A BOUNDARY, NOT A LAYOUT CHOICE ───────────
-- The links database is READ BY THE PUBLIC WORKER, and its entire data surface is possession-tier
-- by construction (schema-links.sql). RECIPIENT EMAIL ADDRESSES MUST NOT BE REACHABLE FROM THERE.
-- That is the second time this boundary has decided a placement — the first was keeping `cache`,
-- which carries customer emails, out of the public Worker's reach. It is a boundary, and it is
-- recorded as one so the next placement question is answered by it rather than re-argued.
--
-- ── NO UNIQUE CONSTRAINT, DELIBERATELY ───────────────────────────────────────────────────────
-- A RESEND IS LEGITIMATE. Preventing an ACCIDENTAL double-send is a claim-before-send guard in
-- code; a constraint here cannot tell the two apart and would block the legitimate one. Recorded
-- as deliberately absent for the same reason `expires_at` is (schema-links.sql) — so its absence
-- reads as a decision rather than an oversight, and nobody "fixes" it.
CREATE TABLE IF NOT EXISTS invoice_send (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  mode                TEXT    NOT NULL,          -- 'test' | 'live', as everywhere
  ledger_id           INTEGER NOT NULL,          -- the spine
  primus_invoice_id   TEXT    NOT NULL,          -- survives a ledger rebuild
  token               TEXT,                      -- WHICH link went; a re-mint after revoke differs

  -- The address as sent. Kept verbatim: the question this answers is "who actually received it".
  recipient           TEXT    NOT NULL,
  -- WHERE THE ADDRESS CAME FROM ('qbo_cache' | 'primus_detail' | ...). This is the column that
  -- answers "how did this reach the wrong person" without a reconstruction, which is what C2's
  -- recipient-verification rule needs.
  recipient_source    TEXT,

  attempted_at        INTEGER NOT NULL,          -- epoch ms, kept ALONGSIDE sent_date, not replaced

  -- ── THE BUSINESS DATE, RECORDED — NOT DERIVED (spec §8.867) ────────────────────────────────
  -- YYYY-MM-DD in **America/Los_Angeles**. THE ZONE NAME IS WRITTEN HERE ON PURPOSE so a future
  -- migration cannot silently reinterpret existing rows.
  --
  -- "Business day" means OUR business days, and we operate in Los Angeles. A contractual clock must
  -- not depend on whoever reads `attempted_at` later picking a zone: 2026-08-11 03:30 UTC is
  -- 2026-08-10 in Los Angeles — a DIFFERENT DAY, and C1's 3-business-day window would start on the
  -- wrong one. §8.867 already governs this (a time value crossing a boundary carries its unit, its
  -- zone and its modality); this is that rule applied, not a new one.
  sent_date           TEXT,

  outcome             TEXT    NOT NULL,          -- 'sent' | 'failed' | 'refused' (SEND_OUTCOMES)
  provider            TEXT,                      -- 'sendgrid'
  provider_message_id TEXT,                      -- SendGrid X-Message-Id — the join to their side
  provider_status     INTEGER,                   -- HTTP status
  -- Reason + message ONLY. NEVER an upstream response body (spec §6.3).
  error               TEXT
);

CREATE INDEX IF NOT EXISTS invoice_send_inv_idx ON invoice_send (mode, primus_invoice_id);
CREATE INDEX IF NOT EXISTS invoice_send_out_idx ON invoice_send (mode, outcome);


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
