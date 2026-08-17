#!/usr/bin/env bash
#
# APPLY THE SEND LOG — schema.sql statements 8, 9 and 10.
#
#     ./invoice-sync/apply-send-log.sh --local     # miniflare, safe to repeat
#     ./invoice-sync/apply-send-log.sh --remote    # production D1
#
#   8. ALTER TABLE ledger ADD COLUMN first_sent_at INTEGER   — NOT re-runnable
#   9. CREATE TABLE IF NOT EXISTS invoice_send (…)           — idempotent
#  10. CREATE INDEX invoice_send_inv_idx / _out_idx          — idempotent
#
# ── WHY THIS IS A SCRIPT AND NOT A MIGRATION FILE ────────────────────────────────────────────
#
# THE DDL ALREADY EXISTS. `first_sent_at` is declared at schema.sql:146, `invoice_send` at 248,
# its indexes at 283-284. A migration file restating any of that would be a SECOND source of truth
# for one table, and the two would diverge on the first edit — so this script applies what
# schema.sql already declares and defines nothing of its own.
#
# There is no migration tooling in this project to slot into: no migrations/ directory, no
# `migrations_dir` in any wrangler.toml, no numbered sequence. schema.sql's own header is the
# convention — a resume document listing every pending statement and whether it is re-runnable.
#
# ── WHAT THIS ENCODES THAT A COMMENT CANNOT ──────────────────────────────────────────────────
#
# Statement 8 is an ALTER, and SQLite has no `ADD COLUMN IF NOT EXISTS`. A second run errors
# `duplicate column name`, and re-running schema.sql does NOT repair a half-applied migration —
# the columns live inside a `CREATE TABLE IF NOT EXISTS` that no-ops against an existing table.
# schema.sql states the fix (resume BY COLUMN from a fresh PRAGMA); this makes it executable, so
# nobody has to re-derive it while a run is half-applied.
#
# VERIFICATION IS POSITIVE, NEVER AN EXIT CODE (spec §0.25). The script asks the database what it
# now contains and fails loudly if the answer is wrong.

set -euo pipefail

DB="invoice-sync"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"                      # wrangler.toml lives here

TARGET="${1:-}"
if [[ "$TARGET" != "--local" && "$TARGET" != "--remote" ]]; then
  echo "usage: $0 --local | --remote" >&2
  echo >&2
  echo "Neither is the default. --remote is production, and a schema change is not something to" >&2
  echo "reach by omitting an argument." >&2
  exit 64
fi

run() { npx wrangler d1 execute "$DB" "$TARGET" "$@"; }
has() { run --command "$1" 2>/dev/null | grep -q "$2"; }

echo "── target: $TARGET  db: $DB ───────────────────────────────────────────────"

# ── statements 9 and 10 FIRST — and the order is load-bearing ───────────────────────────────
#
# THIS RUNS BEFORE THE ALTER, which is not a stylistic choice. On an EMPTY database there is no
# `ledger` table yet, so a guarded ALTER fires first and dies on `no such table: ledger` — found
# by running --local against a fresh miniflare store, which is what --local is for. Creating the
# table first covers all three states:
#
#   empty database      → CREATE TABLE ledger includes first_sent_at, so the ALTER below skips
#   existing, no column → CREATE TABLE no-ops, and the ALTER below adds it
#   already applied     → both no-op
#
# ── WHY THE STATEMENTS ARE EXTRACTED RATHER THAN `--file=./schema.sql` ───────────────────────
#
# `wrangler d1 execute --file --remote` posts to the D1 IMPORT endpoint, which returns
# `Authentication error [code: 10000]` under an OAuth login even when the same session's
# `--command` (query endpoint) works and `whoami` reports `d1 (write)`. Observed 2026-08-17.
#
# So the statements are pulled OUT of schema.sql by name and run as `--command`. schema.sql stays
# the sole source of truth — nothing is retyped here, it is read from the file at runtime — and
# the blast radius is narrower than `--file`, which re-applied every CREATE in the schema when
# this script is scoped to three statements.
# A LITERAL prefix match, not a regex: the statement contains `(`, and escaping it through awk's
# -v string parsing is how this broke the first time (`illegal primary in regular expression`).
extract() {                      # extract 'statement prefix' → the statement, comments and all
  awk -v needle="$1" '
    index($0, needle) == 1 { inside = 1 }
    inside                 { print }
    inside && /^\);/       { exit }
  ' ./schema.sql
}

echo "9.  invoice_send               creating (idempotent)"
run --command "$(extract 'CREATE TABLE IF NOT EXISTS invoice_send')" >/dev/null

echo "10. invoice_send indexes       creating (idempotent)"
while IFS= read -r idx; do
  [[ -z "$idx" ]] && continue
  run --command "$idx" >/dev/null
done < <(grep '^CREATE INDEX IF NOT EXISTS invoice_send_' ./schema.sql)

# ── statement 8 — the one that is not re-runnable ──────────────────────────────────────────
if has "PRAGMA table_info(ledger)" "first_sent_at"; then
  echo "8. ledger.first_sent_at        already present — skipping the ALTER"
else
  echo "8. ledger.first_sent_at        adding"
  run --command "ALTER TABLE ledger ADD COLUMN first_sent_at INTEGER" >/dev/null
fi

# ── verify, positively ─────────────────────────────────────────────────────────────────────
echo
echo "── verification ───────────────────────────────────────────────────────────"
fail=0

# RETRIED, because remote D1 is not read-your-writes. Observed 2026-08-17: a verification run
# immediately after creating both indexes reported `invoice_send_inv_idx` NOT FOUND while
# `invoice_send_out_idx` was present — and a direct query moments later showed BOTH. The object
# existed; the read did not see it yet.
#
# A false "VERIFICATION FAILED — do not deploy" is expensive in exactly the way this script is
# meant to prevent: it sends someone hunting a half-applied migration that never happened. Three
# attempts, one second apart, then believe the answer.
check() {
  for attempt in 1 2 3; do
    if has "$1" "$2"; then
      echo "  ✓ $3$([[ $attempt -gt 1 ]] && echo "   (visible on attempt $attempt)")"
      return
    fi
    [[ $attempt -lt 3 ]] && sleep 1
  done
  echo "  ✗ $3   — NOT FOUND after 3 attempts"
  fail=1
}
check "PRAGMA table_info(ledger)"                                  "first_sent_at"        "ledger.first_sent_at"
check "SELECT name FROM sqlite_master WHERE type='table'"           "invoice_send"         "table invoice_send"
check "SELECT name FROM sqlite_master WHERE type='index'"           "invoice_send_inv_idx" "index invoice_send_inv_idx"
check "SELECT name FROM sqlite_master WHERE type='index'"           "invoice_send_out_idx" "index invoice_send_out_idx"

# ── the OTHER ledger ALTERs — reported, never applied here ─────────────────────────────────
# Out of scope for this script, which is statements 8/9/10 only. Reported because a ledger missing
# one of them fails at WRITE time, far from here — 5, 6 and 7 are a prerequisite for the poller
# (`link_minted_at` is read by markLinkMinted/openMintedUnsent; the claim path writes the dates).
#
# 1 and 2 are already applied on production; they are listed so the output states the whole
# ledger's position rather than only the part that is still outstanding.
echo
echo "── other ledger ALTERs (schema.sql 1, 2, 5, 6, 7) — REPORT ONLY ────────────"
outstanding=0
for col in paid_first_seen_at customer_reference issue_date invoice_due_date link_minted_at; do
  if has "PRAGMA table_info(ledger)" "$col"; then
    echo "  ✓ ledger.$col"
  else
    echo "  ! ledger.$col   MISSING — apply it deliberately; this script does not"
    outstanding=$((outstanding + 1))
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo
  echo "VERIFICATION FAILED — the database does not contain what it should. Do not deploy code" >&2
  echo "that writes invoice_send until this is resolved." >&2
  exit 1
fi

echo
echo "Done. Statements 8, 9 and 10 are applied and verified."
if [[ "$outstanding" -ne 0 ]]; then
  echo
  echo "STILL OUTSTANDING: $outstanding ledger column(s) above. They are NOT this script's job, but"
  echo "the poller reads link_minted_at and writes issue_date / invoice_due_date — apply them before"
  echo "deploying code that does, or writes fail mid-run against columns that do not exist."
fi
