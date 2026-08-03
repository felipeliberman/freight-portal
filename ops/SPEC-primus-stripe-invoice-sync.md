# Primus → Stripe Invoice Sync — Build Spec

**Status:** discovery complete. API facts verified against live endpoints 2026-08-03. Design revised 2026-08-03 after adversarial review.
**Goal:** Primus stays the source of truth for shipments and charges. Stripe becomes the customer-facing invoice delivery, payment, and dunning surface. QBO remains the book of record and owns payment state.

**Phase 1 runs entirely in Stripe TEST MODE.** See §2.1. Nothing built here can reach a customer until that is deliberately flipped.

---

## 0. Relationship to what already exists

This does not land on a clean slate. Three existing facts constrain the design.

### 0.1 The portal already has a live invoice-payment surface

`portal.html:4968-5030` renders a "Pay Invoices" modal listing Primus invoices and pays them via
`stripe-payments` `/create-payment-intent`, passing the invoice numbers flattened into a PaymentIntent
`description` string. It creates **no Stripe Invoice object** and leaves no link back to one.

Consequences that must be designed for, not discovered:

- **Two payable surfaces for the same debt.** After sync, a customer can pay in the portal modal *and*
  on the Stripe hosted invoice page. Neither knows about the other. ACH settles over days, so both can
  be in flight at once and both succeed.
- **Card surcharge mismatch.** The portal adds a 2.9% + $0.30 convenience fee on card
  (`portal.html:4536`). A synced Stripe invoice paid by card carries no such line. Same invoice, two
  prices, and the cheaper one is the one being emailed.
- **A portal payment leaves the Stripe invoice open**, feeding the dunning problem in §5.

**Phase 1 does not resolve this** — test mode means no customer sees a Stripe invoice, so the conflict
is inert. **It must be resolved before live mode.** See Open Decision D1.

### 0.2 Stripe customer identity is already split two ways

| Path | Keyed on | Where |
|---|---|---|
| Invoice payment | **email** | `getOrCreateCustomer(email)`, `stripe-payments/src/index.js:55` |
| Prepaid (PRE) gate | `metadata.primusCustomerId` + KV cache | `getCustomerByPrimus()`, same file:79 |

Duplicate Stripe customers already exist live as a result.

Resolving this sync by ARCode → QBO `PrimaryEmailAddr` would add a **third** key. The QBO AP email is
routinely not the portal login email, so it would mint a fourth set of duplicates. Failure mode: the
customer pays a synced invoice on customer A while their linked bank account lives on customer B —
saved payment methods don't appear, ACH adoption drops, and the prepaid gate never sees them.

**Rule:** resolve to the `primusCustomerId`-keyed customer as the single identity spine. Treat the QBO
email as a **recipient list**, not an identity key.

**Join status (verified 2026-08-03).** The QBO half is settled: `ARCode` == `customerInfo.customerCode`
on the invoice detail, and QBO `DisplayName` is `<Company>-<ARCode>` — confirmed on `Bison Office
LLC-2395` (ARCode 2395) and `Payless Rugs-5406` (ARCode 5406, invoice 141886).

The `primusCustomerId` half is **not** the same field. The likely bridge is `customerInfo.customerId`,
which sits beside `customerCode` on the same response — confirm it matches the portal's
`primusCustomerId` format (e.g. Haynes `1123086640`) at phase 4. One field to eyeball, not a fork.

**Unmatched ARCodes are an exception, not a failure.** Some QBO customers may have been created
without the `-<ARCode>` DisplayName suffix. Log to the exception queue, skip the invoice, and **never
guess at a match** — a wrong customer match sends one customer's freight detail and consignee
addresses to another. A skipped invoice is recoverable; a misdelivered one is not.

### 0.3 This is a separate Worker

Do **not** add it to `stripe-payments`. That worker's own `wrangler.toml` documents deployed-vs-repo
drift from direct dashboard edits, and it carries the live payment path. An unattended cron does not
belong in that blast radius.

New worker. Own secrets. **Restricted Stripe key** (invoice write, customer read) — not `STRIPE_SK`.

---

## 1. Verified API facts

*(Verified against live endpoints 2026-08-03. Settled — do not re-derive.)*

### Two Primus APIs — use the right one

| API | Host | Scope |
|---|---|---|
| Customer/portal API | `freightandlogistics-api.shipprimus.com` | One customer's own data only. Used by portal.html. **Not for this project.** |
| **System API** | `restapi.shipprimus.com` | Broker-level, all customers. **This is the one.** |

Docs: `https://restapi.shipprimus.com/api/v1/docs`

### Auth

```
POST https://restapi.shipprimus.com/api/v1/login
{"username": "claude", "password": "<secret>"}
→ {"data": {"accessToken": "<jwt>", "exp": <unix>}}
```

Token valid 24h. Send as `Authorization: Bearer <token>`.

**Credential note:** the `claude` user is shared with terms-proxy and the prepaid check. Do not modify
its permissions. It has broad write access including `bookDelete` — the sync must never call a write
endpoint. Read-only by discipline.

### Endpoints in use (all GET)

```
GET /api/v1/invoice?issuedFrom=YYYY-MM-DD&issuedTo=YYYY-MM-DD&page=N&limit=N
GET /api/v1/invoice/{invoiceId}
GET /api/v1/book/bolnumber/{BOLNumber}
GET /api/v1/quickbooks/customers?name=<string>
GET /api/v1/document/bolnumber/{BOLNumber}
GET /api/v1/document/filetype
```

Volume reference: July 2026 returned `totalResults: 1733`.

**Never call:** `PUT /api/v1/invoice/{id}/paid`, any DELETE, any POST/PUT. QBO owns payment state.

### Invoice list response — key fields

```
invoiceId, invoiceNumber, ARCode, total, invoiceTermsCode, issueDate,
invoiceDueDate, issueBy, invoiceFirstSaved
status: { estimatedCosts, actualCosts, costActualClosed, charges,
          readyToInvoice, generated, sent, paid }   // all booleans
shipment: { BOLId, BOLNumber, BOLDocumentURL, carrierPRO, totalWeight,
            totalPieces, shipperName, shipperReferenceNumber,
            consigneeName, consigneeReferenceNumber, url,
            billPartyReferenceNumber }
```

List does **not** include line items. Detail call required per invoice.

### Invoice detail response — additional fields

```
customerInfo: { customerId, customerName, customerCode, creditStatus }
invoiceBreakdown: [ { code, description, qty, rate, total } ]
invoiceRemarks            // customer-facing BY POLICY, internal BY HABIT — see §6.2
invoiceInternalRemarks    // INTERNAL — never send to Stripe
costBreakdown             // INTERNAL — carrier cost + discounts
payableBreakdown          // INTERNAL
profitSummary             // INTERNAL — cost, sell, profit, GP%
```

`customerInfo.customerCode` == `ARCode` on the list response.

### Customer resolution

`ARCode` → QBO customer. QBO `DisplayName` is `<Company>-<ARCode>`:
- `2395` → `Bison Office LLC-2395`
- `5406` → `Payless Rugs-5406`

`GET /api/v1/quickbooks/customers?name=<string>` is a **search**, not a list — requires `name`. Returns
the full QBO record including `PrimaryEmailAddr.Address`, `BillAddr`, `PrimaryPhone`, `SalesTermRef`,
`Balance`.

**Gotcha:** `PrimaryEmailAddr.Address` may be comma-separated, e.g.
`nickz@paylessrugs.com,ap@paylessrugs.com`. Split on comma — these are **recipients**, not identity
(§0.2). First is the primary recipient, remainder become CC.

**Ignore** `PreferredDeliveryMethod` — reads "Print" on all customers, an untouched QBO default.

Do not call the search per invoice. Pull the customer list once, cache keyed on ARCode, refresh
periodically.

### Documents

`GET /api/v1/document/bolnumber/{BOLNumber}` → `[{ type, url, name, documentExtension }]`

Type codes confirmed on this tenant: `BOL ` (**note trailing space**), `RECLASS`, `REWEIGH`, `DIM`,
`IMG`, `COI`, `CLM`, `CLMD`, `MISDOC`, `SHP`, `MET`, `CI`, plus `LBL`, `DO`, `COST`, `QUO`, `INV`.

Type codes in the per-BOL response do not fully match `/document/filetype` — `LBL` and `DO` appear in
one but not the other, `SHP` and `MET` vice versa. **Allowlist, never denylist.**

No explicit POD code. `trackingInformation.lastStatusInternal == "POD"` on the booking record is the
actual signal that a POD exists; the file itself may arrive as `IMG`.

Document URLs are **publicly fetchable, no auth header** — the `t=` query parameter is the auth.
Returns real PDF bytes with `Content-Disposition: attachment;filename="{BOLNumber}_{TYPE}.pdf"`.

### Booking join

`GET /api/v1/book/bolnumber/{BOLNumber}` returns `shipper`, `consignee` (full addresses), `freightInfo`
(commodity, class, dims), `accessorials`, `trackingInformation`. Source for the lane description.

---

## 2. Architecture

```
Primus system API (read-only)
   │  cron poll
   ▼
Sync Worker ──► D1 ledger (idempotency spine, §4)
   │            │
   │            └──► Stripe TEST MODE (phase 1) / LIVE (phase 5+)
   │                        │
   ▼                        ▼
QBO customer cache     customer pays → QBO (book of record) → Primus → portal
```

Payment flow is unchanged and deliberate: **payment → QBO → Primus → portal.** The sync reads
`status.paid` from Primus to close out Stripe invoices. It never writes payment state anywhere.

### 2.1 Test mode is the phase-1 safety guarantee

The original spec relied on "create drafts only, review and send manually." That is a *policy*
guarantee — one dashboard click sends a live draft, and one bug that finalizes instead of drafting
mails a customer.

**Phase 1 runs against a Stripe test-mode key.** A test-mode invoice cannot reach a customer at all,
regardless of code defects or dashboard mistakes. Same effort, categorically stronger guarantee.

Requirements:

- The worker is **mode-aware from the first commit** — `STRIPE_RK_TEST` and `STRIPE_RK_LIVE` as separate
  secrets (restricted keys: invoice write, customer read), mode selected by an explicit `STRIPE_MODE`
  var, never inferred. Live additionally requires `ALLOW_LIVE_MODE='true'` as a second, independent
  switch, so no single fat-fingered var can start billing.
- **The declared mode is validated against the key prefix** (`rk_test_`/`sk_test_` vs
  `rk_live_`/`sk_live_`) before any request goes out. A live key pasted into the test secret is
  otherwise undetectable until it bills someone.
- **Every persisted key is mode-namespaced.** The D1 ledger carries a `mode` column and every uniqueness
  constraint includes it; the lease and cache keys are prefixed `<mode>:`. This mirrors the existing
  convention in `stripe-payments` (`custKvKey(mode, …)` → `stripecust:<mode>:<id>`). Test and live must
  never collide, and test-mode ledger rows must never suppress a live-mode create.
- Test-mode Stripe customers are created fresh from real Primus/QBO data. They are throwaway.
- Drafts-only **still applies** on top of test mode, and stays in force through the first live phase.
- Flipping to live is its own phase with its own gate (§7 phase 5), not a config tweak.

The input data is real Primus data throughout. Only the Stripe side is sandboxed — which is precisely
where the customer-facing risk lives.

---

## 3. Sync job

Cron-triggered Worker. Two passes per run. Both passes are resumable: state lives in the D1 ledger
per-invoice, never per-run, so a run killed by CPU limits resumes rather than restarts.

### 3.1 Customer allowlist — pilot scope

**Phases 6–9 run against ONE customer: Payless Rugs, ARCode `5406`.** Everything else stays on the
current Primus/QBO flow, untouched, until phase 9 proves out.

This is what makes the manual review phase survivable. Drafts-only and test mode are both only as
good as someone actually reading the output, and nobody reads ~1733 invoices a month. One customer's
slice is reviewable line by line; the full book is reviewable in aggregate at best, which is how a
systematic mapping error ships.

**Config:** `AR_ALLOWLIST`, comma-separated ARCodes. It **fails closed** — unset or empty throws
rather than meaning "everything," because "empty means all" is exactly the misconfiguration that
would blast the full book. The full book requires typing `*`: deliberate, greppable, and logged.

**The filter runs BEFORE the ledger claim.** Non-allowlisted invoices get **no ledger row at all**.

This ordering is load-bearing. If skipped invoices were recorded, widening the allowlist later would
hit `claimed: false` on every one of them and they would be permanently suppressed — a silent
never-billed, whose symptom surfaces only when a customer notices they were never invoiced. The cost
of the alternative is explicit and bounded: **widening the allowlist requires a wide-window backfill
run**, because the rolling 7-day poll will not reach back for invoices it previously skipped. That is
a phase 10 gate, not an afterthought.

**Near-miss detection.** An ARCode differing from an allowlist entry only by leading zeros is a
config typo, not a business fact. It is reported to the exception queue as `near_miss` rather than
skipped silently — "the pilot ran for a week and billed nothing" and "the pilot is correctly scoped"
are indistinguishable from the outside otherwise.

**What the pilot does and does not prove.** Phases 6–8 are test mode, so nothing reaches Payless at
all. Phase 9 is the first time a real invoice can reach a real customer — and the blast radius of
every unresolved decision, D1 included, is exactly one account. That is the point. But note the
converse: if Payless does not use the portal's payment modal, the pilot does **not** exercise the
dual-payment-surface conflict in §0.1, and clearing phase 9 would give false confidence about it.
See Open Decision D9.

### 3.2 Subrequest budget — a hard ceiling at full-book scale

Cloudflare Workers cap outbound subrequests per invocation (1000 on the paid plan). The poll itself
is comfortable: ~1733 invoices at `limit=100` is ~18 list pages.

**The detail pass is not.** Phase 5 needs one `/invoice/{id}` call per invoice plus one
`/book/bolnumber/{n}` for the lane description — roughly **3,500 subrequests a month**, which cannot
complete in a single invocation. Nor can it be fixed by running more often: the ceiling is per
invocation, not per day.

The pilot allowlist hides this completely — one customer's slice is far under the cap — so it will
not surface until phase 10 widens to `*`. Design the chunking before then: bounded batch per run
(claim now, materialize N per invocation, resume from the ledger), or a queue. The ledger already
makes this safe, since work is tracked per invoice rather than per run.

Verify the exact scheduled-handler limits against current Cloudflare docs before sizing the batch.

### Run lock

Cloudflare will start a scheduled invocation while the previous one is still running. At ~1733
invoices/month and two API calls each, a full window is not fast.

Take a lease (Durable Object, or KV with TTL) at run start; abort immediately if held. The lease is a
performance guard, not a correctness guard — correctness is the ledger (§4).

### Pass 1 — create

1. Auth; cache token until `exp`.
2. `GET /api/v1/invoice` for the window, paginated. **Dedupe by `invoiceId` in-run** — unconditionally.
3. Filter to `status.generated == true`.
4. **Allowlist filter (§3.1) — before the ledger claim.** Non-allowlisted invoices are skipped with
   no ledger row written.
5. Ledger check (§4). Skip if already materialized at the current version.
5. `GET /api/v1/invoice/{invoiceId}` for detail. **Narrow at the fetch boundary** (§6.1).
6. Resolve customer (§0.2 spine).
7. Classify primary vs rebill (§4.3) — from Primus ordering, not Stripe state.
8. Create a **draft** Stripe invoice under an idempotency key, recording the ledger row first.

**Window overlap.** Invoices are editable after issuance and the list may sort on a mutable field, so a
record can shift pages between calls and be silently *skipped*. Use a generous overlapping window (poll
the last 7 days daily) so a skipped record is caught on the next run. This is only safe because §4
makes re-seeing a record free.

### Pass 2 — reconcile

1. Query the **ledger** (not Stripe search) for invoices materialized and not yet closed.
2. Check Primus `status.paid`.
3. If paid in Primus and open in Stripe, mark paid out-of-band in Stripe.

Guards:
- Marking paid an invoice Stripe already considers paid is a **no-op, not an error** — it must not abort
  the pass.
- Reconcile must also consider draft and uncollectible states, not only `open`, or those invoices are
  silently skipped forever.
- `status.paid` is a **boolean**. Partial payments and short-pays never flip it. See §5.

---

## 4. Idempotency

This is the only thing preventing double-billing a real customer. It gets built first and it gets built
correctly. Three layers, none of which is sufficient alone.

### 4.1 What does not work

**Querying Stripe for `metadata.primus_invoice_number` before create.** Stripe Search is index-backed
with up to ~1 minute of lag; a just-created invoice is not immediately findable. Two overlapping runs
30 seconds apart both see "no match" and both create. Search is a reconciliation tool, never a lock.

### 4.2 What does work — three layers

**Layer 1 — D1 ledger (authoritative).**

A row is written **before** the Stripe create is attempted, with a `UNIQUE` constraint that the database
enforces regardless of timing. KV is not a substitute: it is eventually consistent (~60s), which is the
same failure mode being escaped.

```
ledger(
  mode,                 -- 'test' | 'live'; part of every unique key
  primus_invoice_id,
  primus_invoice_number,
  bol_number,
  ar_code,
  version,              -- increments on reissue (§4.4)
  classification,       -- 'primary' | 'rebill' | 'hold'; PERSISTED, never re-derived
  stripe_invoice_id,
  stripe_state,         -- intent | draft | finalized | void | paid | uncollectible
  total_cents,
  UNIQUE(mode, primus_invoice_id, version)
)
```

**Layer 2 — Stripe idempotency key** on the create call:
`<mode>-primus-inv-<invoiceId>-v<version>`. Server-side and immediate — it closes the sub-second race
the ledger write can't. It expires at **24 hours**, so a daily cron re-attempting on day 2 gets a fresh
key and would create a duplicate; the ledger is what stops that. Necessary, not sufficient.

**Layer 3 — BOL-level guard.** Before creating, check the ledger for any existing open-or-paid invoice
against the same `bol_number`. A hit does not block — it **forces explicit classification** (§4.3)
rather than a silent create. This is the only defense against a Primus reissue that changes both
`invoiceId` and `invoiceNumber`, where layers 1 and 2 both miss.

### 4.3 Rebill classification

Not a pure function of a BOL collision. That misclassifies at least four ways.

**Derive ordering from Primus, not from Stripe/ledger state.** Pull all invoices for the BOL from
Primus and order by `issueDate`/`invoiceId`. Deriving "first one I've seen" from local state
misclassifies a rebill as a primary whenever the primary predates go-live or a backfill runs out of
order — which folds real supplemental charges into the freight description.

**Void-awareness.** If every prior invoice for the BOL is voided/cancelled, this is a **corrected
primary**, not a rebill. Without this, a routine correction is framed to AP as a supplemental charge and
sent down the document-push branch hunting a `RECLASS` that does not exist.

**Persist, never re-derive.** Classification is written to the ledger once. A later run sees more
collisions and would otherwise reclassify an invoice already sent.

**Hold, don't guess.** If the primary is not in the ledger, or the ordering is ambiguous, classify
`hold` and surface it for review. A wrong guess here is a wrong customer-facing document.

**Three-invoice case.** primary + reclass + reweigh classifies correctly, but the *document push* rule
(§5.4) assumes a 1:1 invoice→document mapping that does not exist in the data. Push only when exactly
one candidate supporting doc exists, issued after the primary, not already pushed. Otherwise link.

**Open:** does Primus ever issue two invoices on one BOL to *different* bill-to parties (split or
third-party billing)? If yes the key is `(BOLNumber, ARCode)`, not `BOLNumber`. See Open Decision D3.

**The pilot set contains real rebills — verified 2026-08-03.** A 60-day poll claimed 11 Payless
invoices across 9 distinct BOLs: **two BOL collisions, both a second invoice of exactly $55.00**
(BOL 160133034 → 140061/141015; BOL 160134933 → 141886/142264). Roughly an 18% rebill rate.

This is good news for phase 6 — the classifier, the §5.1 line rule, and the rebill document-push
branch all get exercised by the pilot rather than waiting for the full book. It also means the
$55.00 uniformity is worth understanding before mapping: if it is a standard flat rebill charge,
its `invoiceBreakdown` shape is the one to design the line rule against first.

### 4.4 Invoice edits after issuance — state machine

Invoices are editable in Primus after issuance (verified; amount changes appear immediately on the API).
A create-only job misses those, and "update the Stripe invoice if `total` differs" is only legal in one
state. Define it explicitly:

| Stripe state | Primus total changed → |
|---|---|
| `draft` | Update in place. Same ledger row, same version. |
| `finalized` (open) | **Cannot be edited.** Void + reissue at `version + 1`. The voided row records the successor's `stripe_invoice_id`. |
| `paid` | Never touch. The delta is a new charge and becomes a rebill, or a credit note (§5.2). |
| `void` / `uncollectible` | Terminal. Reissue only under an explicit new version. |

---

## 5. Field mapping

| Stripe | Source |
|---|---|
| Customer | `primusCustomerId` spine (§0.2), ARCode and email attached as attributes |
| Recipient email | QBO `PrimaryEmailAddr.Address` split on comma, first entry |
| CC recipients | remaining entries |
| Invoice number | `invoiceNumber`, **normalized** — see below (API only; the dashboard cannot set this) |
| Due date | `invoiceDueDate` |
| Line items | `invoiceBreakdown` (§5.1) |
| Metadata | `primus_invoice_id`, `primus_invoice_number`, `bol_number`, `ar_code` — these four only |

**`invoiceNumber` arrives float-formatted.** Observed live 2026-08-03: Primus returns the string
`"139875.0"`, not `"139875"` — confirmed as an API artifact, not a client-side coercion (JS would
render a numeric `139875.0` as `139875`). Rendered as-is on a Stripe invoice, the customer sees
`139875.0`, which matches neither QBO nor their AP records and makes remittance matching fail.

**Normalize before use** — strip a trailing `.0` (and any other zero-only decimal) — and normalize
consistently for the `primus_invoice_number` metadata key so the two never diverge. Ledger
idempotency is unaffected either way, since it keys on `invoiceId`.

### Custom fields (Stripe allows 4)

```
BOL #      → shipment.BOLNumber
PRO #      → shipment.carrierPRO
Carrier    → carrierName
Consignee  → shipment.consigneeName
```

Verified: these render at the top of the PDF beneath the dates, where AP looks first.

### 5.1 Line item rule — keyed on the LINE, not the invoice type

**`total == 0` never becomes a Stripe line item. Anywhere. Primary or rebill.**

The original rule (fold on primary, render as-is on rebill) breaks on rebills, which routinely carry $0
lines — the original freight line restated, or the accessorial that *was* included free sitting beside
the one now being charged. `LIFTGATE AT DESTINATION — $0.00` on a rebill reproduces the exact
contradiction the fold rule exists to prevent, on the document the customer scrutinizes hardest.

Invoice type decides only **where the $0 descriptions go**:

- **Primary:** appended to the freight line's "Includes:" list.
- **Rebill:** dropped, or stated as memo context ("Originally billed: …"). Never a line.

Rationale unchanged: a printed `$0.00` accessorial contradicts you later if that accessorial gets
rebilled.

### 5.2 Credit notes — currently a gap

A rebill can net **negative** (a downward adjustment; common). That is not an invoice — it is a Stripe
**credit note** against the original, a distinct object with its own API.

A **$0-total** invoice creates nothing at all.

Neither path exists in the current design. Both must be handled before live mode. See Open Decision D4.

### 5.3 Description string

Verified to wrap cleanly across two lines in the Stripe PDF:

```
Freight Charge — LTL · <origin city, ST> → <dest city, ST> · <pieces> pcs <commodity> ·
<weight> lbs · Class <class> · PU <pickup date> · Incl. <zero-dollar accessorials>
```

Origin/destination, commodity, and class come from the booking record (`/book/bolnumber/{n}`), not the
invoice — a second call or a cached join.

**Note:** the Stripe dashboard exposes no line-item description field — API-only. Manual invoices
created by hand cannot carry this, and cannot carry the Primus invoice number either.

### 5.4 Memo and documents

```
<dispute notice — §5.5, REQUIRED>

Questions? accounting@freightandlogistics.ai · 800-687-3713
Shipment documents: <short link>
```

Memo appears in email, PDF, and payment page. Footer is PDF-only. The phone number is permitted here —
this is a transactional accounting footer, not error/failure copy (see CLAUDE.md, no-phone-as-fallback).

The dispute notice leads the memo. It is the only time-sensitive element, and on any surface that
truncates, it must be what survives.

**Do not put raw Primus document URLs here.** Verified: they break across lines mid-parameter in the PDF
and are not clickable. Mirror to R2 and serve short links from `docs.freightandlogistics.ai`.

- **Primary invoice:** one link to the shipment view. **Pull, not push** — most customers don't want a
  POD and it invites questions on clean deliveries.
- **Rebill:** push the specific supporting doc inline (`RECLASS`, `REWEIGH`) — there the document *is*
  the justification. Subject to the 1:1 constraint in §4.3.
- `invoiceRemarks` is the manual override channel: whatever is typed in Primus flows to the memo —
  **subject to §6.2**, and it may never displace the dispute notice (§5.5).

### 5.5 Dispute notice — REQUIRED payload element

The current Primus invoice email carries a dispute notice with **contractual weight**: discrepancies
must be reported within **3 business days** with backup documentation (manufacturer spec sheet,
original invoice, packing list, images); absent that, no carrier dispute is filed and payment in full
is required. It ties to the 48-hour customer rule and to carrier claim windows.

**It does not survive the move to Stripe by default. It must be carried deliberately.**

Treat it as a required field of the invoice payload, not as copy. **The payload builder fails closed:
if the notice is absent or empty, no invoice is created.** A missing notice is not a cosmetic
regression — it forfeits the carrier dispute window and the contractual basis for payment in full.

#### Placement

Memo, not footer. Memo renders in the **email body, the PDF, and the hosted payment page**; footer is
**PDF-only** and therefore misses the two surfaces most customers actually read.

#### Character budget (measured)

Memo cap is 500. Fixed overhead is **131 chars** (contact line 59 + document link line 70, plus
separators), leaving **~369 for the notice**. Measured against real link lengths:

| Variant | Notice | Memo total |
|---|---|---|
| Names all four document types + consequence | 271 | 403 / 500 |
| Document types abbreviated | 250 | 382 / 500 |
| Points to PDF for detail | 208 | 340 / 500 |
| Explicit computed deadline date, detail on PDF | 202 | 334 / 500 |

**A notice up to ~369 chars fits in the memo in full.** Use the footer only if the authoritative
wording exceeds that.

#### If the full text does not fit

Short form in memo, full text in footer — **but the memo short form must be self-sufficient as
notice**, because the footer does not reach the email or payment page. Three operative terms may
never degrade to the PDF:

1. the **deadline** (or the window),
2. that **supporting documentation is required**,
3. the **consequence** — no carrier dispute filed, invoice due in full.

Only the enumeration of acceptable document types may move to the footer, and the memo must then say
where the full terms are.

#### Wording is transcribed, never paraphrased

The exact text comes from the current Primus invoice email. Do not reword contractual language to fit
a character budget — if it does not fit, use the short-form split above with wording reviewed for that
purpose. See Open Decision D7.

#### The clock is a live problem, not a wording detail

Today the notice ships with the Primus email at issuance, so the customer receives it with the full
window intact. **This sync introduces lag** — poll interval, plus draft review, plus manual send. A
window measured from the invoice date can be substantially consumed, or fully expired, before the
customer ever sees the invoice. That both cuts against the notice's enforceability and is
straightforwardly unfair to the customer.

Options, in preference order:

1. **Render an explicit deadline date** rather than a relative phrase ("by Fri Aug 7, 2026"). It is
   computable, unambiguous on a document received days after its date, and the variant measured above
   is the *shortest* of the four. Requires deciding the business-day calendar (weekend-only bumping,
   as `portal.html` does for pickup dates, or a holiday calendar).
2. **Measure the window from the Stripe send date**, not the Primus invoice date.
3. **Bound the lag** — refuse to send if issue-date age exceeds a threshold, and route to the
   exception queue.

Whichever is chosen must be consistent with the 48-hour customer rule and the carrier claim windows.
See Open Decision D8.

---

## 6. Security

### 6.1 Narrow at the FETCH boundary, not the mapping boundary

`costBreakdown`, `payableBreakdown`, `profitSummary`, and `invoiceInternalRemarks` carry carrier cost,
negotiated discounts (e.g. "DISCOUNT 94.00%"), and per-shipment GP.

"Build the Stripe payload by explicit assignment" is necessary and **not sufficient** — it leaves the
internal fields sitting in scope where a later careless edit can reach them.

**Parse the detail response into a narrow object the moment it lands and discard the rest.** The
internal fields must never enter the mapping function's scope at all. Never compute a Stripe field from
a cost field even as an intermediate — a freight line derived by subtraction makes GP recoverable.

### 6.2 Free-text fields are not covered by an object whitelist

- **`invoiceRemarks` is the largest hole.** It is customer-facing by policy and internal by habit —
  ops paste carrier cost, "our cost was X", carrier names, and internal shorthand into it. Whitelisting
  the *object* does not whitelist the *string*. Apply a length cap and a scan (currency figures adjacent
  to cost/margin/profit/rebate terms) before it can ever auto-send. Drafts-only covers phase 1; this
  gates live send.
- **Line-item `description`** comes from Primus rate/accessorial config and can echo discount structure.
  Same class of risk, lower frequency.

### 6.3 Logging is the likeliest actual leak

One `console.log(detail)` during a debugging session puts per-shipment margin into Cloudflare tail.
Explicitly banned:

- logging the raw detail object, at any level, ever;
- exception handlers that embed the upstream response body in the message;
- any dry-run mode that prints the *source* object rather than the constructed payload.

### 6.4 Metadata and R2

**Metadata** is not on the PDF but is in the API, in webhook payloads, and in the dashboard. Keep it to
the four IDs in §5. Do not stash the detail blob there for debugging.

**R2 bypasses field whitelisting by construction** — mirroring a `COST` or `INV` PDF "for completeness"
means the file *is* the leak. The mirror obeys the same allowlist as §8.

Document tokens must be unguessable **and scoped per-(invoice, document)**, not per-document. Two
parties can bill on one BOL (shipper-paid vs consignee-paid rebill); a per-document token handed to one
grants the other's view. PODs carry consignee home addresses and phone numbers, and the book is ~90%
residential.

---

## 7. Dunning

### 7.1 The structural problem

**Dunning is automatic and customer-facing; the close-out signal is manual and multi-hop.** A broken
sync fails loudly to the customer and silently to you. That inversion is the thing to design around.

Where a customer who has already paid still gets dunned:

- **Paid outside Stripe** — check, direct ACH, or the portal's own modal (§0.1). All land in QBO on a
  human's schedule. Month-end, or one bookkeeper on vacation, and a day-1 payer gets a day-7 notice.
  **This is the common case, not the tail.**
- **Partial payment or short-pay.** `status.paid` is a boolean. Pay 90% and dispute one accessorial and
  it never flips — dunned at every interval having paid nearly all of it.
- **Misapplied in QBO.** A lump sum applied to the oldest open invoice: Primus says A paid, B open;
  Stripe duns B; the customer says "I paid you." The sync cannot fix this. It is an argument for
  conservative intervals.
- **Reconcile scope holes.** Covered by the §3 pass-2 guards.

### 7.2 Phase 1–4 policy

**Stripe automatic reminders stay OFF.** There is no lever to hold an in-flight reminder short of
pausing the entire schedule.

Before enabling anything: **measure the actual QBO→Primus lag distribution** from live data. Set
intervals well clear of the observed tail — expect 45/60, not the 7/15/30 originally configured.

The memo's phone number is fine, but note the single most likely reason a customer calls it is
"I already paid this."

### 7.3 Deferred: Stripe `invoice.paid` webhook

There are no webhooks in the estate today. A webhook would record Stripe-side payment truth immediately
rather than waiting for the QBO→Primus round trip.

**Deliberately deferred to a later phase (§8 phase 7), not dropped.** Reasoning:

- It only fires on **Stripe** payments, which already close themselves out in Stripe immediately. The
  lag that actually causes wrong dunning is a **mailed check hitting QBO late** — the webhook does not
  help there at all.
- It is a **public endpoint** requiring signature verification and replay handling. Not worth debugging
  while still confirming the invoices come out right.

Revisit once Stripe is a meaningful share of payment volume and the invoice output is trusted.

---

## 8. Document allowlist

`GET /api/v1/document/bolnumber/{BOLNumber}` returns **internal documents alongside customer-facing
ones.** Filter with an explicit allowlist. Multiple `INV` entries on one BOL indicate a rebill — a
second signal alongside the BOL collision check.

**Customer-facing (pull link):** `BOL`, `RECLASS`, `REWEIGH`, `DIM`, `COI`†, `POD`‡

**Auto-push (rebill justification only):** `RECLASS`, `REWEIGH`

**Never expose:** `COST` (vendor quote — carrier cost), `QUO` (customer quote), `DO`, `CLBL`, `LBL`,
`SHP`, `MET` (labels), `INV` (Primus invoice PDF — superseded by the Stripe invoice), `CLM`, `CLMD`
(claims correspondence — carries carrier settlement positions), `MISDOC` (unknown by definition — the
drawer everything ambiguous lands in)

**`IMG` — pull link only, never auto-push.** Driver delivery photos show the consignee's house, door,
plates, and sometimes people. On a ~90% residential book where the bill-to is often a retailer or a
third party with no relationship to the delivery address, pushing `IMG` hands over their end customer's
home. Safe behind a scoped pull link; wrong as a push.

† **`COI` needs a decision.** Carrier COI is fine to share. *Your* broker/contingent cargo COI names
your limits and insurer, which is claims leverage. See Open Decision D5.

‡ `POD` is not confirmed to exist as a type code (§1). Harmless to allowlist; do not build
"POD available" logic on it — use `trackingInformation.lastStatusInternal == "POD"`.

**Normalize before matching.** `BOL ` carries a trailing space in the live response. Trim and uppercase
every type code before comparing, or the allowlist silently drops every BOL.

**Unknown codes are logged and excluded.** A type code in neither list must be excluded *and* recorded
where someone will see it. Otherwise a new Primus document type is invisible in both directions.

**`CI`** (commercial invoice) — usually customer-facing, but on cross-border it can carry the shipper's
pricing to *their* buyer. Excluded pending a decision.

### Fetching

Publicly fetchable, no auth header (§1). The Worker can fetch and mirror to R2 with no session handling.
Mirror Primus's `{BOLNumber}_{TYPE}.pdf` filename so downloads land sensibly.

**Still mirror despite the URLs being public:** they are unusable in a PDF (break across lines, not
clickable), Primus controls expiry and rotation, and mirroring gives access logs. The token appears
derived from the document ID and likely does not rotate — a link handed out today probably works
indefinitely, which is itself a reason to serve your own.

---

## 9. Build order

Phases 1–4 are **test mode only** (§2.1). Nothing customer-facing exists until phase 5.

| # | Phase | Gate to exit |
|---|---|---|
| 1 | Worker scaffold, mode-aware config, Primus auth + token cache | Test-mode key wired; `STRIPE_MODE` explicit; no live secret present |
| 2 | D1 ledger schema + idempotency layers (§4.1–4.2) | Ledger rejects a duplicate under forced concurrent runs |
| 3 | Invoice list poll, pagination, dedupe, run lock | Full month window replayed twice → zero duplicate ledger rows |
| 4 | Customer resolution + ARCode cache (§0.2) | ARCode↔primusCustomerId join confirmed (D2) |
| 5 | Field mapping, fetch-boundary narrowing, line rule (§5.1), classifier (§4.3), dispute notice (§5.5) | Internal fields provably absent from payload construction scope; payload builder refuses to construct without the dispute notice |
| 6 | Draft creation in **test mode**, **pilot customer only** (§3.1) | Every Payless invoice for a real month reviewed line by line; classifier verified on known rebills |
| 7 | Reconcile pass | Handles partial-pay and already-paid without aborting |
| 8 | R2 document mirror + scoped short links (§6.4, §8) | Document allowlist verified; unknown-code logging in place |
| 9 | **Live mode flip** — still drafts-only, still pilot-only | D1, D4, D5, D7, D8 resolved; §6.2 remarks scan in place; dispute notice verified on a real rendered PDF, email, and payment page |
| 10 | Widen `AR_ALLOWLIST` to `*` + auto-send + dunning intervals from measured lag (§7.2) | **Wide-window backfill run first** (§3.1 — the rolling poll will not reach back for previously skipped invoices); **detail-pass chunking built** (§3.2 — full book exceeds the per-invocation subrequest cap); lag distribution measured on real data |
| 11 | `invoice.paid` webhook (§7.3) | Only once Stripe is meaningful payment volume |

---

## 10. Stripe configuration

Already configured on the account:

- Branding: logo, accent `#b310ab`
- Support email: `accounting@freightandlogistics.ai` (where replies land)
- Invoice numbering: sequential across account; overridden per invoice via API
- Payment methods: Cards + ACH Direct Debit only
- Invoice PDFs attached to emails: on

**Changed by this revision:** reminders were configured at 7/15/30 days past due. **Turn them off** for
phases 1–9 (§7.2).

**Pending:** custom email domain (`invoice@freightandlogistics.ai`). Requires DNS + DMARC, blocked on
the Cloudflare zone for the .ai being active. Use a subdomain to isolate transactional deliverability
from the cold outreach campaign on the root domain.

---

## 11. Open decisions

| # | Decision | Blocks |
|---|---|---|
| **D1** | How the portal's PaymentIntent modal (§0.1) and Stripe Invoices coexist — retire the modal, link it to the invoice, or reconcile the card surcharge | Phase 9 (live) |
| ~~D2~~ | ~~ARCode ↔ QBO join~~ — **resolved 2026-08-03** (§0.2). Residual: confirm `customerInfo.customerId` is the portal's `primusCustomerId` | — |
| **D3** | Does Primus issue two invoices on one BOL to different bill-to parties? Determines whether the classifier keys on `(BOLNumber, ARCode)` | Phase 6 |
| **D4** | Credit-note path for net-negative rebills (§5.2) | Phase 9 |
| **D5** | Is the `COI` on a BOL the carrier's or ours? (§8) | Phase 8 |
| **D7** | Authoritative dispute-notice wording, transcribed from the current Primus invoice email (§5.5). If >369 chars, which short form goes in the memo | Phase 5 |
| **D8** | What the 3-business-day clock runs from once the sync introduces lag, and the business-day calendar for rendering an explicit deadline (§5.5) | Phase 5 |
| **D9** | Does Payless Rugs (ARCode 5406) use the portal's payment modal? If not, the pilot does not exercise the dual-payment-surface conflict in §0.1 and phase 9 gives false confidence about it | Phase 9 |
| **D6** | Stripe email subject line — currently "New invoice from Freight and Logistics, Inc. #\<number\>", carries no BOL or PO reference. Gmail will thread these for customers the way QBO reminders threaded for us | Phase 10 |
