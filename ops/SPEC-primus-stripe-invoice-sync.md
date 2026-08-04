# Primus → Stripe Invoice Sync — Build Spec

**Status:** discovery complete. API facts verified against live endpoints 2026-08-03. Design revised 2026-08-03 after adversarial review.
**Goal:** Primus stays the source of truth for shipments and charges. Stripe becomes the customer-facing invoice delivery, payment, and dunning surface. QBO remains the book of record and owns payment state.

**Phase 1 runs entirely in Stripe TEST MODE.** See §2.1. Nothing built here can reach a customer until that is deliberately flipped.

---

## 0. Relationship to what already exists

This does not land on a clean slate. Three existing facts constrain the design.

### 0.05 ARCHITECTURE DECISION — Stripe is DELIVERY ONLY (2026-08-03)

**Stripe sends the invoice. Stripe never collects it.**

The Pay button on the Stripe invoice does **not** go to Stripe's hosted invoice page. It deep-links
into **our portal**, where the customer logs in and lands with the invoice panel open on that
specific invoice. Payment happens through the existing portal path — which already applies the card
fee and already writes to QBO.

**Why.** A Stripe invoice fixes its amount at finalisation, before the customer chooses a payment
method, so method-dependent surcharging is structurally impossible on the hosted page (§5.7,
verified against Stripe's docs). The card fee cannot be absorbed. Therefore the payment surface has
to be ours. It also matches the wider goal that every customer-facing surface is ours.

#### INVARIANT — the Stripe invoice must never be payable

This is the new fail-closed boundary and it **replaces** the old one (the §0.1.2 double-payment
gate). Whatever configuration makes it true must be explicit and tested:

- no payment methods attached to the invoice,
- nothing that lets a customer pay Stripe directly,
- the hosted page must not present a collection path.

The old invariant guarded *two* payable objects. The new one guards *one* — and it fails closed in
the same direction: if the Stripe invoice is ever payable, the failure it produces is exactly the
one §0.1.2 describes.

**Not yet scoped:** the precise Stripe configuration that guarantees this, and the test that pins
it. Both are required before phase 6.

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

#### 0.1.1 How the pilot customer is invoiced today (answered 2026-08-03)

Payless currently receives **two invoices for the same charge**: one emailed from Primus, one emailed
from QBO with a payment link. Both carry the **same number** — the Primus invoice number, which
imports into QBO unchanged. Both sends are manual, by the account owner, who is the only person with
QBO access.

**Decision: when Stripe goes live for Payless, both sends stop.** No Primus email, no QBO email.
Stripe becomes the only invoice they receive. Nothing is disabled in either system — the routine
changes.

Three consequences:

1. **The Stripe invoice MUST carry the Primus invoice number as its customer-visible number.**
   Payless AP matches on it and has always seen it. Stripe assigns its own number by default, so it
   is **explicitly overridden** per invoice via the API. Stripe's internal number still exists
   underneath, so reconciliation has two numbers in play — **expected, not a bug.**

2. **The single-surface guarantee rests on a manual routine, not a system constraint. STATED RISK.**
   Nothing in Primus, QBO, or Stripe prevents a second send. If a Primus or QBO send ever happens
   alongside a Stripe send, the customer holds two live payment paths, and a payment through the
   non-Stripe path leaves the Stripe invoice **open** — so dunning chases a customer who has already
   paid. **That is the worst failure this system can produce.** It is mitigated by discipline only.

3. **Payment methods** confirmed in the Stripe *sandbox*: Cards enabled (Amex included — Stripe does
   not break out networks, Amex rides with Cards) and ACH Direct Debit enabled, no pending state.
   **Payless pays by American Express today**, so both paths must work. Settings do **not** carry
   from sandbox to live — **re-verify both in LIVE mode before phase 9.**

**Still open, and NOT closed by the above:** whether Payless can log into the portal and pay through
the payment modal (§0.1). That path survives the routine change entirely, and it is the same
two-live-paths failure as consequence 2. D1 remains open.

### 0.1.2 D1 — DISSOLVED BY ARCHITECTURE, not fixed

**STATUS: RESOLVED by §0.05. Retained in full because the reasoning matters if anyone reconsiders
the hosted invoice page later.**

**Why it is gone rather than mitigated:** the double-payment path required *two payable objects*
for the same money. Under §0.05 Stripe never collects, so the second object does not exist. The
portal is the only place money moves — which is the state that already holds today.

**This section is now a warning, not a gate.** Everything below describes what WOULD happen if the
Stripe invoice were ever made payable. That is precisely why §0.05's invariant exists: enabling
collection on the hosted page silently reintroduces every consequence enumerated here.

The original framing, preserved: this was never live harm. The portal was already the only way to
pay, so there was nothing to collide with; it would have become real the moment the first payable
Stripe invoice existed.

Answered from code, read-only, 2026-08-03. No live test was run.

#### The mechanism

The portal creates a **bare PaymentIntent**. It never creates, references, or attaches to a Stripe
Invoice object.

```
portal.html:4126   qbo-api/invoices?docNumber=<Primus invoice #>   → _qboId, _qboBalance
portal.html:4984   stripe-payments/create-payment-intent           → PaymentIntent
   worker :185       description = "Invoices: 140488, 140061"      ← FREE TEXT, not a reference
portal.html:4999   _recordQboPayments(invoices, paymentIntent.id)
portal.html:4496   qbo-api/payment { invoiceId:_qboId, amount, paymentDate, stripePaymentIntentId }
```

The complete Stripe surface of `stripe-payments` is `payment_intents`, `payment_methods`,
`customers`, `customers/search`, `setup_intents`. **There is no call to `/v1/invoices` anywhere**,
no Checkout Session, no payment link. `portal.html` contains no `hosted_invoice_url` and no
`checkout.stripe`.

**Payments reach QBO, but not the way one might assume.** It is not Stripe attaching a payment to an
invoice — it is **the portal writing the QBO payment itself**, client-side, after Stripe succeeds.

**Why the two objects cannot see each other.** A Stripe Invoice is closed by a payment *attached to
it*. The portal's PaymentIntent is a standalone object whose only connection to invoice 140488 is
the string `"Invoices: 140488"` in a `description` field. Stripe does not parse descriptions.
Nothing links them, in either direction, at any layer.

**The convergence.** The portal resolves QBO by `docNumber`, and QBO's `docNumber` **is** the Primus
invoice number (it imports unchanged — §0.1.1). The sync sets the Stripe invoice `number` to the
same Primus invoice number. So **invoice 140488 is addressable from both surfaces, keyed on the
same identifier**, with no link between the objects that represent it.

#### Consequences, severity order

**1. Double payment. Nothing prevents it.**
- *Customer:* pays 140488 on the Stripe hosted page, and again in the portal (or vice versa). Both
  succeed. They are charged twice. **The two amounts differ** — the portal adds a 2.9% + $0.30 card
  convenience fee (`portal.html:4536`); a Stripe invoice carries no such line.
- *Stripe:* two unrelated successful objects — one Invoice marked paid, one PaymentIntent with a
  description string. Nothing flags a duplicate.
- *QBO:* one payment written by the portal, one arriving via Stripe. Potential double credit (see 3).

**2. A portal payment leaves the Stripe invoice OPEN.**
- *Customer:* has paid. Their Stripe invoice still shows unpaid, and the hosted payment page still
  invites payment.
- *Stripe:* `open`. It closes only when our reconcile marks it paid out-of-band.
- *Timing, concretely:* portal → QBO is immediate (a client-side POST). QBO → Primus is the
  4–5×/day sync — **up to ~6 hours** (reported, §7.1.1, not measured). Our reconcile then runs on
  the poll cadence — **up to another 24 hours** on a daily cron. **Worst case roughly 30 hours
  open after the customer has paid.** Reminders are OFF for the pilot (§7.2), which is doing more
  work here than it was originally credited with.
- *Additional failure:* `_recordQboPayments` is **best-effort and swallows errors** —
  `.catch(e => { console.error(...); return null; })`, and the success UI shows regardless. If that
  write fails, QBO never learns, Primus never flips, and **the Stripe invoice stays open
  indefinitely** while the customer has been charged.

**3. QBO double credit.**
- *Customer:* may see a credit balance or a refund conversation.
- *QBO:* one payment from the portal's direct write, plus one from Stripe's own attachment if both
  paths are used on the same invoice.
- *Stripe:* nothing unusual — it has no view of QBO.
- **Depends on the Stripe→QBO connector configuration, which is not in our code.** See "live test".

#### Partial protections, and exactly how far they reach

**`_qboBalance` reading zero** is real but **late**. The portal reads the balance from QBO
(`portal.html:4126`), so an invoice already paid in Stripe *does* eventually show zero and drop out
of the payable list.

How late: Stripe → QBO, plus QBO's own balance update. Until that lands, **the portal shows the
invoice as fully payable, at full amount, with a working Pay button.** A customer who paid the
Stripe invoice an hour ago sees no indication anywhere in the portal that they have already paid.

There is **no protection at all in the other direction**: paying in the portal does nothing to the
Stripe invoice until reconcile runs.

Neither protection prevents a double payment. Both only shorten the window afterwards.

#### Options — enumerated, NOT recommended

**A. Converge the portal on the Stripe Invoice object.** Portal pays the invoice itself (hosted
page, or a PaymentIntent created *from* the invoice), so both entry points close the same object.
- *Breaks:* the card convenience fee (a Stripe invoice cannot easily carry a per-payment
  surcharge); **batch payment** — the portal pays several invoices with one PaymentIntent
  (`"Invoices: 140488, 140061"`), and Stripe invoices are paid one at a time; the saved-ACH flow;
  the QBO writeback becomes duplicative and must be removed.
- *Cost:* the largest. Rewrites live payment code that handles real money.
- *Customers not on the sync:* have no Stripe invoice, so the old path must remain — **two payment
  paths coexisting in the portal**, indefinitely, until every customer is synced.

**B. Segment the portal path off for synced customers.** Portal hides or disables invoice payment
for ARCodes on the sync allowlist; those customers pay only via Stripe.
- *Breaks:* pilot customers lose a portal feature they may use today. If Payless pays through the
  portal now, this is a visible regression for them.
- *Cost:* smallest — an allowlist check in `portal.html`.
- *Customers not on the sync:* entirely unaffected.
- *Risk:* the allowlist now lives in two places (worker config and portal). **Drift between them is
  a silent reopening of the gap** — the exact failure this option exists to close.

**C. Gate one path behind the other.** Portal checks whether a Stripe invoice exists for that
invoice number and, if so, redirects to the hosted invoice URL instead of paying locally.
- *Breaks:* adds a live lookup on the payment path — a new failure mode on a money surface. Needs a
  decision on what happens when the lookup fails (fail open = the gap returns; fail closed = the
  customer cannot pay).
- *Cost:* medium. A new read endpoint over the ledger, plus a portal branch.
- *Customers not on the sync:* unaffected — the lookup returns nothing and the old path runs.
- *Note:* Stripe Search's ~1min index lag is not a factor here, since invoices are created hours
  before anyone pays.

**D. Per-customer ownership of the invoicing surface** — a generalisation of B: each customer is
either a portal-invoicing customer or a Stripe-invoicing customer, never both, with the assignment
held in one place rather than inferred.
- *Breaks:* nothing structurally; it is a policy, and its weakness is that it depends on the
  assignment being respected.
- *Cost:* low technically, higher operationally.
- *Customers not on the sync:* unaffected by construction.

#### Knowable from code vs only from a live test

**Settled from code, no test needed:**
- The portal creates no Stripe Invoice — certain, from the worker's complete endpoint list.
- The two paths converge on the Primus invoice number — certain.
- The PaymentIntent's only link to the invoice is a free-text description — certain.
- The QBO writeback is client-side, best-effort, and swallows errors — certain.
- The card surcharge asymmetry — certain.

**Only from a live test (none run):**
- Whether Stripe's QBO connector *also* writes a payment for an invoice-attached payment, producing
  the double credit in consequence 3. That is connector configuration, not our code.
- The real QBO→Primus latency distribution (§7.1.1 is reported, not measured).
- Whether a Stripe-paid invoice actually disappears from the portal list, and how quickly — depends
  on `qbo-api` behaviour and QBO's balance timing.
- Whether Payless's users use the portal invoice modal at all. That is usage data, not code, and it
  determines whether option B is a real regression or a no-op for them.

### 0.1.3 `_recordQboPayments` — the only writeback, and it cannot report failure

Read-only survey 2026-08-03. **Not fixed. Queue item 1 (§8.6).**

Under §0.05 the portal is the only payment surface, which makes this the **single point where
money-received becomes money-recorded**. That raises its severity rather than lowering it.

`portal.html:4489-4508`. The comment reads *"Best-effort — never blocks the success UI, since Stripe
has already captured the funds."* The reasoning is sound; the implementation goes past best-effort
into unobservable.

**Six silent failure modes:**

| # | Failure | Where | What is visible |
|---|---|---|---|
| a | QBO lookup fails → `_qboId` stays `''` → the write is **never attempted** | `:4133` catch, `:4492` guard | console only |
| b | Lookup succeeds but matches no QBO invoice → same no-op | `:4127-4132` | nothing |
| c | The POST throws | `:4506` `.catch(… return null)` | console only |
| d | The POST returns HTTP 4xx/5xx | `:4506` — **there is no `r.ok` check**; `.then(r => r.json())` resolves and the error body is discarded | **nothing at all** |
| e | No retry, no queue, no persistence — verified absent | — | the fact that a payment needs recording exists nowhere |
| f | Partial batch: `Promise.all` swallows per-invoice, so 3 paid can record 2 | `:4491` | success UI identical |

**(d) is the sharpest.** An application-level rejection from `qbo-api` is indistinguishable from
success, because the response is parsed and thrown away without inspection.

**Customer-visible outcome of any of them:** charged, and sent a payment confirmation email
(`:5001`/`:5043`, a separate SendGrid call that fires regardless). They hold proof of payment while
QBO shows the invoice open, Primus never flips `paid`, and — once the sync exists — the Stripe
invoice stays open indefinitely.

**Amount edge:** the recorded amount is `_qboBalance`, falling back to the Primus total
(`:4493-4495`). If QBO already carries a partial payment, the fallback over-records.

### 0.1.4 Display/charge mismatch on the card fee — a SECOND defect, different cause

**Distinct from the cap breach (§5.7). Same code, different failure.**

On a $55.00 invoice the portal **displayed a $1.59 fee and charged $1.60.** The customer is shown
one surcharge and charged another. That fails the disclosure requirement on its own terms —
independently of whether the amount is within Visa's cap.

**Cause: four copies of the fee logic that drifted.** Not a rounding subtlety — a duplication
problem.

| Site | Formula | Role |
|---|---|---|
| `portal.html:4536` | `subtotal * 0.029 + 0.30` | modal summary (displayed) |
| `portal.html:4604` | `subtotal * 0.029 + 0.30` | receipt (displayed) |
| `portal.html:4947` | `subtotal * 0.029 + 0.30` | fee row (displayed) |
| `portal.html:4783` | `subtotal * 1.029 + 0.30` | **`calcTotal` — the CHARGED amount** |

Three display sites computed the fee directly and rendered it via `.toFixed(2)`. The fourth
computed the *total* in a different shape, and that total is what reaches
`/create-payment-intent`, where the worker does `Math.round(amount * 100)`. At $55 the displayed
fee floors to `1.59` while the rounded total yields `1.60` — the two paths disagree by a cent.

**Fix: one function, `cardFeeOn()`, called by all four sites; none computes its own value.**
Consolidation is the fix, not a refactor riding along with it — copies that must agree are exactly
what produced the divergence. Flooring in integer cents additionally makes the displayed fee equal
the charged fee by construction.

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

**Rule:** treat the QBO email as a **recipient list**, not an identity key. (An earlier draft named
`primusCustomerId` as the spine — superseded by the decision below, which tested that candidate and
rejected it.)

**Join status (verified 2026-08-03).** The QBO half is settled: `ARCode` == `customerInfo.customerCode`
on the invoice detail, and QBO `DisplayName` is `<Company>-<ARCode>` — confirmed on `Bison Office
LLC-2395` (ARCode 2395) and `Payless Rugs-5406` (ARCode 5406, invoice 141886).

**DECIDED 2026-08-03, by elimination: Stripe customers are keyed on ARCode.**

Two candidate spines were tested against live data and both failed:

1. **`customerInfo.customerId` is not the portal's `primusCustomerId`.** Haynes returns
   `customerId = 646664` where the portal stores `1123086640`; Payless returns `701567`. These are
   different identifier systems. Keying on `customerId` would produce Stripe customers the rest of
   the estate cannot join to.
2. **The booking is not the join either.** In `portal.html`, `primusCustomerId` is only ever
   compared against `booking.thirdParty.id` — it is a bill-to **party** id, not a customer id.
   Across three Haynes bookings, `1123086640` appears at `$.thirdParty.id` **and** `$.shipper.id`
   on every one, while `646664` appears on none, and no `ARCode` field exists anywhere on the
   booking record. Consistent across the sample. The party system and the customer system do not
   meet on the booking.

So ARCode is the key, arrived at by elimination rather than preference. It is the one identifier
that appears on both the invoice list (`ARCode`) and the invoice detail (`customerInfo.customerCode`),
and it is what QBO `DisplayName` embeds.

**Write BOTH `arCode` and `customerId` into Stripe customer metadata.** They cost nothing to store
and they are the difference between a later surprise costing a metadata read and costing a
migration. A Stripe customer created without them cannot be re-joined after the fact.

Resolution still records a `missing_primus_customer_id` exception when `customerInfo.customerId` is
absent — no longer because it blocks billing, but because a change in its availability is a signal
about Primus worth seeing.

**Unmatched ARCodes are an exception, not a failure.** Some QBO customers may have been created
without the `-<ARCode>` DisplayName suffix. Log to the exception queue, skip the invoice, and **never
guess at a match** — a wrong customer match sends one customer's freight detail and consignee
addresses to another. A skipped invoice is recoverable; a misdelivered one is not.

### 0.24 ARCode is sourced from the CLAIM, never re-derived

The invoice **detail response carries no `ARCode`** — confirmed by `hasOwnProperty` on the raw
record, 2026-08-03. (An earlier note cited a 12-key field list as evidence; that list was
TRUNCATED by the diagnostic's own shape-describer and should not have been read as complete. The
truncation is now visible as `…+N more`. The conclusion held for an independent reason: the
required-value gate quarantined on a null ARCode.) The authoritative
value is the one the **list** response carried, which is what selected the invoice and what the
ledger row stores.

**The mapper gates on the claimed value. There is no fallback.** Absent → quarantine.

Deriving it from `customerInfo.customerCode` was tried and removed: a second derivation path can
only ever disagree silently, and "the two are equal" was an unverified §1 assertion about Primus.
`ARCode` is therefore NOT a detail-level required value (requiring it there quarantines every
invoice — which is exactly what the gate reported on the first real invoice mapped).

**Equality checked rather than trusted: the list `ARCode` and the detail
`customerInfo.customerCode` MATCH ON 11 OF 11** Payless invoices, 0 differ, 0 absent. That is a
match on eleven records — **not** a confirmation of the general claim, and nothing depends on it.

### 0.25 Verification discipline — STANDING RULE

**Every verification step must assert a positive fact about the world after the operation, never
merely the absence of an error.**

Three failures of this in one session (2026-08-03), each producing output *indistinguishable from
success*:

| What was done | Why it looked fine | What it actually did |
|---|---|---|
| `wrangler d1 execute "DELETE FROM exceptions" >/dev/null 2>&1` | no error surfaced | the statement failed; a stale row was then read as a live failure |
| `git diff --no-index` against copies taken by hand | a clean-looking diff rendered | a copy of unknown vintage silently yields an incomplete diff that looks identical to a correct one |
| revert with relative paths from a stale shell cwd | `cp`/`rm` reported nothing wrong | nothing was reverted at all |

`git status` caught the third — because it **re-read reality** instead of trusting an exit code.
That is the pattern to generalize.

In practice:
- After a delete, count the rows. After a write, read it back. After a revert, diff against the
  recorded baseline hash.
- Never silence stderr on a step whose success you intend to rely on.
- Prefer showing whole current state (`cat` the file, `git status`) over showing a delta computed
  from an artifact you produced yourself.
- An exit code is evidence that a command ran, not that it did what you wanted.

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

### Response envelopes — inconsistent across endpoints (verified live 2026-08-03)

The field NAMES below are documented and correct. The envelope around them is **not uniform**, and
reading the wrong nesting level does not error — it yields an object full of `undefined`, which
narrows to a record of nulls and reads as "a customer with no data."

| Endpoint | Shape |
|---|---|
| `GET /invoice` (list) | `{data:{pagingDetails:{totalResults,pages,currentPage,resultsPerPage}, results:[…], message}}` |
| `GET /invoice/{id}` (detail) | `{data:{results:{…invoice…}, message}}` — one level deeper than the list's rows |
| `GET /quickbooks/customers` | `{data:{results:{customers:[…]}, message}}` — a container at `results`, not the array |

Consequences baked into the client:

- The result count is at **`data.pagingDetails.totalResults`**, not beside `results`. `pages` sits
  next to it — reading a page count as a result count would fire the shortfall guard every run.
- Row extraction descends into a sole array property, and falls back to treating a lone object as a
  single record. Both fallbacks are only safe because **every caller re-verifies what it picked**
  (the QBO lookup demands an exact DisplayName suffix; the detail locator demands an `invoiceId`).
- **Locate records by content, not position.** A positional read of the detail endpoint silently
  produced `customerInfo: null` and would have shipped a customer with no identity.

Assume any new endpoint nests differently until observed.

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

### A third identifier space — observed, no conclusion drawn

Every booking record carries, under `accountingInformation`:

```
customerQuoteId, customerQuoteNumber, customerQuoteAmount
costQuoteId
```

Observed on three Haynes bookings 2026-08-03 — e.g. `customerQuoteId 375147199`,
`customerQuoteNumber 49963388`, `customerQuoteAmount 997.20`.

**The quote amounts do not match the invoice totals.** No conclusion has been drawn about what this
space is, whether it joins to anything, or why the amounts differ. Recorded so it is not
rediscovered from scratch, and so nobody assumes it is the customer join without checking.

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

### 3.3 Poll cursor — invariant, if one is ever built

A cursor is **not built today** and is not needed for the poll: a 60-day window costs 36 subrequests
of 1000 (measured on Workers Paid, 2026-08-03), and the full re-sweep every run *is* the skip
protection.

**If a cursor is ever added, it resets to page 1 on each new window and resumes only within an
interrupted window.**

A cursor that resumes mid-window stops re-sweeping the earlier pages. Since invoices are editable
after issuance and the list may sort on a mutable field, a record that shifted *backwards* between
runs is then never seen again — a silent skip, with no error and no shortfall signal, because the
pages it would have appeared on were never re-read. The overlapping window is the only thing that
catches that class of miss, and a naive cursor removes it.

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

### 4.5 Prepaid payments — STRUCTURALLY EXCLUDED, not deferred

Customers without credit can prepay **before an invoice exists**. Those payments have no invoice
attached, so they **cannot enter this sync at all** — the poll reads `/invoice`, and there is nothing
to read.

Written down so their absence is never later read as a bug. This is not a gap, not a backlog item,
and not something to design around. Out of scope by construction.

### 4.6 Payment date — not built, one column reserved

Primus stores `status.paid` as a **bare boolean with no date** (verified 2026-08-03). We are **not**
surfacing payment dates to customers and **not** pulling them from QBO. Parked with the eventual
Primus replacement.

One exception, deliberately minimal:

**`ledger.paid_first_seen_at`** — written once, when a poll first observes `status.paid` flip true.
Nothing reads it. Nothing displays it. No feature is attached.

It exists because it **cannot be backfilled**: the moment passes unrecorded and Primus keeps no
timestamp, so it is the only payment timestamp that will ever exist outside QBO. One column, one
assignment. If the dunning latency in §7.1.1 ever needs to be *measured* rather than reported, this
is the only data that will make that possible.

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

**`invoiceNumber` needs normalizing before it reaches a customer — but the cause is OURS, not
Primus's. Corrected 2026-08-03.**

The earlier entry here claimed Primus returns the string `"139875.0"` and called it "an API
artifact, not a client-side coercion." **That was wrong.** The `.0` is introduced by our own
storage: `ledger.primus_invoice_number` is a TEXT column, and SQLite TEXT affinity renders a bound
REAL `139875.0` as the string `"139875.0"`. Reading direct from the API — Haynes invoice
`1774934402`, no D1 in the path — returned `invoiceNumber: 139303` as a **number**.

Same error class as reading the Free-plan subrequest ceiling as a design limit: **an artifact of our
own environment attributed to the upstream system.** The tell in both cases was that the observation
only ever came through one particular path.

Still normalize, for a different reason: a JS number rendered onto a Stripe invoice must not carry a
spurious decimal, and the value stored in `primus_invoice_number` metadata must match what the
customer sees or remittance matching fails. Ledger idempotency is unaffected — it keys on
`invoiceId`.

**Type consistency across the API is unverified.** `invoiceNumber` is a number on the one record
read directly; nothing establishes that every numeric field is a number on every record. See the
§5.1 string trap.

**`invoiceDueDate` — evidence gathered, owner verification pending.**

Invoice 140488's own PDF, as Payless receives it, reads `DATE 06/23/26 · TERMS Net 15 · DUE:
07/08/26`. 06/23 + 15 days = 07/08, so the API's `invoiceDueDate` of `2026-07-08` is **internally
consistent with the printed terms.**

An earlier note here flagged the due date as preceding the issue date. **That was wrong** — it
compared a live `due_date` against an `issueDate` taken from a hand-written TEST FIXTURE, not from
the API. Retracted.

Still marked **pending owner verification against QuickBooks** before anything downstream treats
`invoiceDueDate` as trusted.

### Custom fields (Stripe allows 4)

```
BOL #       → shipment.BOLNumber
PRO #       → shipment.carrierPRO
Consignee   → shipment.consigneeName
Your Ref #  → ledger.customer_reference   (shipment.consigneeReferenceNumber, LIST only)
```

**The fourth slot is the CUSTOMER'S reference, not Carrier — decided 2026-08-03.** It is the only
thing on the invoice that belongs to them rather than to us, and it is what their AP matches
against internally; carrier is ours and appears elsewhere. An AP clerk who cannot find their own
number on our invoice has been handed something harder to process than the invoice it replaced.

**It is a CLAIM-TIME value.** `shipment.consigneeReferenceNumber` is on the **LIST** response only —
the detail's `shipment` object does not carry it (verified live 2026-08-03: invoice 140488 shows
`consigneeReferenceNumber "129320"` on the list, absent from the detail). If the poll does not
capture it, it is unavailable at map time. Stored on `ledger.customer_reference`.

**RESOLVED 2026-08-03 — the third slot is `Carrier`. `Consignee` is displaced.**

The reader is an AP clerk, and **carrier is where claims and tracking start** — the one field they
cannot derive from anything else in the email body or on the hosted page. The consignee's name is
recoverable from the attached PDF; the carrier is recoverable from nowhere else.

The fourth slot is unchanged: the **customer's reference**. Carrier took the third, never the fourth.

**The consignee NAME moves to the footer as a DELIBERATE DEMOTION, not an omission** — rendered as
`Megan Cappiello, Baldwin Place, NY` so the name and the place read as one thing. Consequence, stated
plainly: the footer is **PDF-only**, so the recipient's name is now **absent from the email body and
the hosted page**. If that turns out to matter for white-glove residential work — where the
recipient's name is often how a shipment gets discussed — it is a **one-field change back, and
Carrier is what it would displace**.

The superseded argument, for the record: Once §5.3 puts the destination
city into the line description, `Consignee` becomes partly redundant — the line already says where
it went. An AP clerk approving a freight charge is arguably more likely to need **who moved it**
than the recipient's contact name, and carrier appears nowhere else on the Stripe invoice except a
PDF-only footer.

Arguments each way, to be decided rather than defaulted:
- *Keep Consignee:* it is the name on the delivery, matches the Primus PDF's own prominent
  `CONSIGNEE` block, and on a residential white-glove book the recipient's name is often how the
  shipment is discussed internally. The line description carries only the destination **city**, not
  the person.
- *Switch to Carrier:* claim disputes, tracking, and "where is it" questions all start with the
  carrier. It is the one field an AP clerk cannot derive from anything else on the invoice, and
  §5.4's footer is PDF-only so email and hosted-page readers never see it.

**Open:** `billPartyReferenceNumber` also exists and is `""` on this record. Semantically it is the
bill-to party's own reference and would be the better source if it were ever populated. Worth
checking across more customers before the full-book widening.

Verified: these render at the top of the PDF beneath the dates, where AP looks first.

### 5.1 Line item rule — keyed on the LINE, not the invoice type

**`total == 0` never becomes a Stripe line item. Anywhere. Primary or rebill.**

> **INHERITED CONSTRAINT — two coercion doors, close both.**
>
> **Null.** `null == 0` is **false** but `null >= 0` is **true**, so a null total classifies as a
> zero-dollar line under one comparison and as a priced line under the other — and **both read as
> reasonable code**.
>
> **String.** Line amounts are **not confirmed to be numbers** — `invoiceBreakdown` has never been
> observed live (as of 2026-08-03) and Primus type consistency is unverified. If a total arrives as
> a string, `"0" == 0` and `"0.00" == 0` are true (accidentally correct), but `"$0.00" == 0` is
> **false** — a formatted zero becomes a PRICED line on a customer's invoice.
>
> Required order: **reject null/undefined → type-check → normalise via `toCents()`** (the poll's,
> which strips `$` and commas) **→ compare on integer cents.** Never `total == 0` on a raw field.
>
> `''` is caught upstream — an empty-string total is a REQUIRED-value violation (§6.5) and
> quarantines the invoice before §5.1 sees it. That ordering is load-bearing: `'' == 0` is true, so
> an empty string reaching a coercion-based rule would read as a zero-dollar line.

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

### 5.3 Line description — PHASE 6 PREREQUISITE, not a nice-to-have

**The bar is set by the invoice Payless receives today.** Anything thinner is a downgrade, and the
point of moving invoicing in-house is that what we send is *better* than what it replaces.

**What the Primus invoice for 140488 actually shows** (extracted from the PDF, 2026-08-03):

- `CHARGE DETAIL` is **one line**: `FREIGHT CHARGE · Qty 1.00 · Rate 300.93 · Subtotal 300.93`.
  So a single Stripe line is **not** a regression at the charge level — the charge detail matches.
- Everything else on the page is what a single Stripe line loses:

| Block | Content on the Primus invoice |
|---|---|
| Shipment | Pickup Date 06/22/26, BOL #160133377, PRO #402052249, Mode LTL |
| Service | `Hd basic - signature release` |
| Carrier | Pilot Freight Services |
| Weight | 82 lbs |
| Delivery | Delivered 07/09/26, Signed By William Lawery 07/09/26 11:14:00 |
| Shipper | Momeni Rugs, ADAIRSVILLE GA 30103, contact + phone |
| Consignee | Megan Cappiello, BALDWIN PLACE NY 10505, contact + phone |
| Pieces | Qty 1 · Type rug · Wt 82 · **CL 70** |
| Pickup window | 06/22/26 between 09:00 and 14:00 |
| References | **REF.# 129320** (consignee reference) |
| Terms | Net 15, AR Code 5406 |

**`REF.# 129320` is the highest-value omission.** It is the customer's own reference — the field an
AP team matches on — and the current Stripe object drops it entirely. Stripe allows **4** custom
fields and only 3 are used (BOL #, PRO #, Consignee); the fourth should be the customer reference,
or Carrier, and that choice needs deciding rather than defaulting.

**Blocked on the booking join**, which resolves cleanly via `GET /api/v1/book/bolnumber/{n}` —
already proven. It needs its own §6.1 narrowing boundary with its own allowlist, since the booking
carries `accountingInformation.costQuoteId` and vendor data that must not cross.

Target shape (verified to wrap cleanly across two lines in the Stripe PDF):

```
<Primus line description> — LTL · <origin city, ST> → <dest city, ST> · <pieces> pcs <commodity> ·
<weight> lbs · Class <class> · PU <pickup date> · Incl. <zero-dollar accessorials>
```

**The Primus line text leads** (e.g. `FREIGHT CHARGE`), so the mirror stays visibly faithful. The
line items themselves remain a **1:1 mirror of `invoiceBreakdown`** — context is added to the
existing line's description, never as synthesised extra lines.

#### Aggregation across ALL freight items — never element [0]

**`freightInfo` is an array and multi-item is real.** 11 pilot bookings scanned 2026-08-03: 10 have
one item, **BOL 160134786 has two** — 64 lbs Class 70 and 112 lbs Class 85. Zero empty arrays, zero
absent.

**Reading `[0]` alone would have printed `82 lbs · Class 70` on a shipment that is 176 lbs across
classes 70 and 85.** Wrong numbers on a customer invoice — and it would have passed every test we
had. That is the reason the rule is what it is.

- **Weight and pieces SUM.**
- **Class does NOT average** — there is no meaningful mean of 70 and 85 — so it renders as a
  **deduped, NUMERICALLY ASCENDING list**: `Class 70, 85`. Ascending always, so identical freight
  never renders two ways depending on array order. (String sorting would print `100, 70`.)
- **Commodity takes the same deduped-ascending rule.** Beyond **3** distinct commodities the list is
  replaced by `N items` — a long list stops informing and starts crowding the line.
- Single-item output is byte-identical to the originally accepted shape.

**Empty or absent `freightInfo` quarantines** — a line cannot describe freight it has no record of.
**UNTESTED: 0 of 11 pilot bookings had one, so this rule exists and has never fired against real
data.** Do not read it as verified.

**`hazmat` is carried, and nothing renders it.** Every item observed has `hazmat: false` and
`UN: ""`. A hazmat shipment would want surfacing on the line; **nothing in the pilot set exercises
it**, so it is available to a future decision and not built.

**HARD LIMIT: 500 characters**, verified against Stripe's changelog (2018-10-31), not assumed:
*"The `description` field on invoice line items now has a maximum character length limit of `500`."*
Over-length descriptions must be truncated or revised. §5.3's two-rendered-line wrap constraint sits
well inside that — the limit is not the binding constraint, legibility is.

**Note:** the Stripe dashboard exposes no line-item description field — API-only. Manual invoices
created by hand cannot carry this, and cannot carry the Primus invoice number either.

### 5.6 Recipients — a stated assumption and an UNVERIFIED address

**Source.** QBO customer record → `PrimaryEmailAddr.Address`, one free-text string, fetched
per-CUSTOMER (never per-invoice) and cached 24h in D1 under `qbo:ar:<code>`.

#### POSITION IS THE ONLY SIGNAL — stated assumption

QBO has no role field on this string. **Which address is primary and which are CC is decided
entirely by comma order.**

`"nickz@…, ap@…"` and `"ap@…, nickz@…"` produce **different recipients with no visible difference
in intent.** Anyone reordering that field in QBO silently changes who gets invoiced, and nothing in
this system detects it. There is no last-modified on the field and no validation of the addresses.

The ordering never changes who is **billed** — the customer is keyed on ARCode (§0.2) — only who
**receives** it. That is still billing data going to a chosen human.

#### Parsing decisions

Each real-world QBO shape either parses correctly or yields no recipient. **A wrong address is the
worst failure here: it delivers successfully and looks perfect.** So anything unrecognisable is
discarded rather than guessed at.

| Shape | Decision |
|---|---|
| `a@x.com; b@x.com` (semicolon) | **parse** |
| `Nick Zerbe <nick@x.com>` | **parse** — the angle-bracket address |
| `Zerbe, Nick <nick@x.com>` (comma in display name) | **parse** — the name half carries no address and is dropped |
| surrounding whitespace | **parse** — trimmed |
| single address, no separator | **parse** |
| duplicates | **parse**, deduped case-insensitively, first position wins |
| empty / whitespace-only / separators only | **QUARANTINE** — no recipient, cannot deliver |
| junk with no address | token **dropped**; if nothing remains → quarantine |
| no dotted domain (`nick@localhost`) | **dropped** — not a deliverable business address |

#### `ap@paylessrugs.com` is UNVERIFIED

`nickz@paylessrugs.com` is corroborated independently — it appears on the Primus invoice PDF as
`Email: NICKZ@PAYLESSRUGS.COM · Attn. Nick Zerbe`.

**`ap@paylessrugs.com` exists in QBO alone.** No corroboration, no last-modified, no validation, and
no record of who added it or when. **Owner is confirming it with Payless directly.**

**Until that confirmation, nothing sends to it.** The mechanism is not a note:

- `buildStripeInvoice` still BUILDS the payload (it needs reviewing) but sets
  `payload.send_blocked = { reason: 'unverified_recipient', addresses: [...] }`.
- **`assertSendable(payload)` THROWS.** Any send path must call it and must not catch it.
- Verification **fails closed** — a null or empty verified list means *nothing* is verified, not
  that everyone is fine.

**That rule is ENFORCED, not documented.** A test scans every `src/*.js` for a Stripe send surface
(`api.stripe.com`, `/invoices/…/send|finalize|pay`, `auto_advance: true`, `sendInvoice`…) and fails
any file that can send without calling `assertSendable()`. It passes vacuously today because no
send path exists; it fails the moment one is written without the gate. A `{ todo }` alongside it
keeps the missing send path visible in every test run.

This is the same treatment §5.1's `toCents()` mandate got. A rule that lives only in prose is a
rule the next person doesn't know exists.

#### Discarded addresses are COUNTED

A dropped token means the invoice reaches one fewer person. "Dropped" and "never existed" are
indistinguishable downstream — a typo like `ap@paylessrugs` (no TLD) vanishes with nothing anywhere
saying so.

Every discard is counted by reason — `no_at`, `no_dotted_domain`, `empty`, `duplicate` — and logged
per run. **Email drops carry their OWN denominator** (`emailParses`, one per customer resolution)
rather than the invoice-record count: drops happen once per customer, not once per invoice, and a
shared denominator would produce a rate that looks precise and means nothing. A rate moving from 0
to 40 is the signal.

### 5.7 Card fee — OPEN COMMERCIAL DECISION

Nothing implemented. This records what is true today, what Stripe can and cannot do, and two
compliance questions for the owner.

#### Three different behaviours today

| Surface | Card fee | Who absorbs it |
|---|---|---|
| Portal invoice modal | **2.9% + $0.30 added** | Customer pays it |
| QBO payment link | none | **We absorb it** (owner had believed customers paid it; they do not) |
| Stripe invoice as mapped | none | We would absorb it |

**Desired:** ACH free; card carries the fee (percentage AND per-transaction), shown at checkout as
a separate charge, **not** baked into the invoice total and **not** a line on the invoice.

**DECIDED 2026-08-03: the portal card fee STAYS.** Under §0.05 the portal is the only payment
surface, so absorbing the fee is not an option — and the desired behaviour is already exactly what
the portal does today. This resolves the whole section: the fee does not need to move onto a Stripe
invoice, because no Stripe invoice ever collects. §5.7's feasibility analysis below is retained as
the record of *why* the hosted page was rejected.

#### Can Stripe Invoicing do this natively? NO — verified, not reasoned

**The timing problem is real and confirmed by Stripe's own docs.** An invoice's amount is fixed at
finalisation, which happens *before* the customer chooses a payment method on the hosted page.

> "After you finalize an invoice, you can't change certain fields that pertain to the amount and
> customer." … "If you require updates to the invoice amount after it finalizes, use credit notes."
> — [Invoice workflow transitions](https://docs.stripe.com/invoicing/integration/workflow-transitions)

And surcharging is **not a Stripe Invoicing feature**. The surcharging documentation lists its
supported integrations as **Payment Intents, Payment Line Items, and Checkout**. Stripe Invoicing
and the hosted invoice page are **not mentioned as supported**.
— [Collect surcharges](https://docs.stripe.com/payments/cards/surcharge)

So there is no native mechanism by which a Stripe invoice's total varies with the payment method
the customer picks. The structural objection was correct.

#### Mechanisms that could produce the behaviour, and what each costs

**A. Route card payers off the invoice** — ACH pays the Stripe invoice; card payers go to a
Checkout Session or PaymentIntent that supports surcharging.
- *Cost:* high. And it **recreates §0.1.2 exactly** — a second payable object for the same money
  that cannot close the invoice. We would be building the failure we are currently gating on.

**B. Two invoices, one card-priced and one ACH-priced.** Doubles the idempotency surface, doubles
the invoice numbers in play, and asks the customer to pick a document. Not seriously proposed.

**C. INVERSE FRAMING — price at the card rate, credit back for ACH.** Asked for explicitly, so
answered explicitly: **it does not work as a discount.** A Stripe discount/coupon is applied to the
invoice *before* finalisation, so it hits the same timing wall. The only post-finalisation lever is
a **credit note**, which is issued *after* payment. The customer would pay the card-inflated amount
by ACH and receive a credit afterwards — over-collection followed by a correction, not a discount
at checkout. It also breaks the §0.1.1 guarantee that the Stripe invoice total matches the Primus
invoice total, and puts a number on the customer's invoice that is not what we billed.

**D. Charge the fee as a separate transaction after the fact.** Requires detecting the method
post-payment, a second charge, and separate consent. Worst of all options.

**E. Absorb the fee.** Zero complexity, zero new failure modes. Matches what the QBO payment link
already does today.

**HONEST ANSWER: it cannot be done cleanly on an invoice object.** The invoice is a fixed-amount
document by design and the fee is method-dependent by definition; those two facts do not reconcile
without leaving the invoice, and leaving the invoice reintroduces §0.1.2.

#### Is there an existing feature being overlooked? No

- **Adaptive Pricing** — *currency localisation.* It does apply to hosted invoice pages, but it
  presents a local currency; it has nothing to do with payment-method-dependent fees.
  [Adaptive Pricing](https://docs.stripe.com/payments/checkout/adaptive-pricing)
- **Stripe Tax** — computes *tax*. A card surcharge is not a tax, and representing it as one would
  be wrong on the document and wrong in the filing.

#### Two compliance questions for the owner — reported, not decided

**1. The label is probably wrong.** The portal charges a **percentage**, and calls it a
*convenience fee*. Under card-network rules a percentage-based charge is a **surcharge**;
"convenience fee" is a narrower category, generally required to be flat and limited to alternative
payment channels. The practice may be fine; the wording likely is not. Legal/network question, not
an engineering one.

Stripe also notes a procedural requirement: **Visa requires notifying Visa and your acquirer at
least 30 days before surcharging begins.**

**2. The flat $0.30 component breaches Visa's cap on every invoice under $300.**

Stripe's own guidance names this exact pattern:

> "on small transactions, a flat fee might exceed Visa's 3% cap, which makes it noncompliant"
> — [What Is a Surcharge Fee?](https://stripe.com/resources/more/surcharge-fees)

Visa's US cap is **3%**, or the merchant discount rate, whichever is lower. Mastercard's is 4%.

The portal charges `2.9% + $0.30`, so the **effective** rate is `2.9% + (30/A)%`:

| Invoice | Effective rate | Visa 3% cap |
|---|---|---|
| $300.00 | 3.00% | exactly at the cap |
| $210.78 | 3.04% | **over** |
| $100.00 | 3.20% | **over** |
| $55.00 | 3.45% | **over** |
| $27.27 | 4.00% | over Visa AND at Mastercard's cap |

**Break-even is $300.00.** Below it, every card payment exceeds Visa's cap.

**This is live in the pilot data.** Of the 11 Payless invoices claimed, amounts include **$55.00
(twice — the rebills), $167.12, $194.52, $210.78** — the majority are under $300.

**3. DEBIT REMAINS SURCHARGED — DEFERRED, NOT RESOLVED.**

The 2026-08-03 flat-fee removal fixes **the cap only**. Debit cards continue to be surcharged, and
**that is not permitted in the US.** This stays open; it does not close with the cap fix.

**The proper fix is Stripe's surcharge API**, which returns a status of `unavailable` for debit and
enforces `maximum_amount` — i.e. it answers both the debit question and the cap question at the
source, instead of the portal guessing before the card exists. Deferred, not dropped.

**Wording, on the record (2026-08-03):** "convenience fee" was KEPT in the flat-fee-removal diff, so
the label change could be approved independently. Noted explicitly because shipping a NEW string
that still reads "convenience fee" **re-asserts** the label rather than merely inheriting it. The
label diff is prepared separately on request.

**4. Debit cards cannot be surcharged in the US — and the portal cannot tell.**

> United States — permitted payment methods: **Credit cards only.**
> — [Collect surcharges](https://docs.stripe.com/payments/cards/surcharge)

**The portal's fee logic does not distinguish card type in any way.** The entire rule is:

```js
portal.html:4536   const fee = paymentMethod === 'card' ? subtotal * 0.029 + 0.30 : 0;
portal.html:4604   var   fee = paymentMethod === 'card' ? subtotal * 0.029 + 0.30 : 0;
```

One branch — ACH or not-ACH. Every card Stripe accepts, **including debit**, is charged 2.9% + $0.30.

**And it structurally cannot distinguish**, because the fee is computed and displayed *before the
card is collected*. The worker requests `payment_method_types[] = card` with no funding restriction
(`stripe-payments/src/index.js:183`), and the brand is only known **after** payment, when the portal
passes `cardBrand`/`cardLast4` to `/send-confirmation` (`:227`, `:243`). At fee-calculation time
there is no card to inspect.

#### Exact current user-facing wording — verbatim, unchanged

```
portal.html:4560   Convenience fee (2.9% + $0.30)
portal.html:4626   Convenience fee (2.9% + $0.30)
portal.html:4859   Pay by Card   —   2.9% + $0.30 convenience fee
portal.html:4859   Pay by Bank   —   ACH transfer - No fee
portal.html:4947   Convenience fee (2.9% + $0.30)
```

Four disclosure sites, three render paths, one string. **Not changed.**

### 5.8 Deep link — scope (NOT BUILT, read-only survey 2026-08-03)

Stripe's Pay button carries an invoice into the portal. What that takes:

**1. Read the identifier from the URL.** No mechanism exists. The portal has no invoice deep-link
route today. The identifier should be the **Primus invoice number** — it is the one value already
shared by the Stripe invoice (`number`), QBO (`docNumber`), and the portal's own invoice list.

**2. Survive the login round trip — and `_finalizeLogin` actively destroys tab state.**

`portal.html:10285` runs `localStorage.removeItem('rp_tabs')` and `rp_active_title` on **every**
login, and `doLogout` (`:9562`) does the same. So any pending-invoice value parked in `rp_tabs` is
wiped by the very act of logging in.

`_finalizeLogin` writes `sessionStorage.fl_session` (`:10294`) and does **not** clear other
sessionStorage keys, so a **dedicated key** (e.g. `fl_pending_invoice`) written before login
survives it. That is the mechanism — a separate key, never `rp_tabs`.

Ordering note: `_finalizeLogin` calls `closeLogin()` then `setLoggedIn(true)`, so the pending
invoice must be consumed *after* that, not during.

**3. Open the right panel.** Reuse the existing invoice panel and detail modal. No new UI. The
pending key is read after auth, the panel opened, the invoice selected, and the key **cleared** so a
refresh does not silently reopen it.

#### THE OWNERSHIP CHECK — and the current state is worse than "client-side only"

**A link is not authorisation.** If an AP clerk clicks a link and authenticates as a different
customer, the portal must not open or display that invoice.

**What exists today.** The portal fetches invoices from `PRIMUS_BASE` =
`https://freightandlogistics-api.shipprimus.com` (`portal.html:2107`) — the **customer/portal API**,
which is scoped to one customer's own data by the bearer token
(`GET /applet/v1/invoice?limit=100&page=N`, `portal.html:22333`, `Authorization: Bearer <token>`).

**So server-side scoping does exist, and it is the right kind:** the API returns only the
authenticated customer's invoices. An invoice belonging to another customer is not in the response
at all.

**But that is a property of the LIST, not a check on a LOOKUP.** There is no
"does this invoice belong to me" function anywhere, because nothing has ever needed one. A deep link
introduces the first case where the portal is handed an identifier from outside and asked to display
it.

**The check must therefore be: resolve the identifier ONLY within the authenticated customer's own
fetched invoice set, and if it is not there, do not display it.** Not a filter applied to a
separately-fetched invoice — a lookup that can only ever succeed inside data the token already
scoped. That makes ownership a consequence of where the data came from rather than of a comparison
someone can forget.

**Failure copy matters and must not leak.** "Invoice not found" and "that invoice is not yours" must
be the **same message**, or the portal becomes an oracle for which invoice numbers exist on other
accounts.

**Not built. Nothing above is implemented.**

### 5.9 Login screen — no support contact (scope)

`portal.html:969-994` is the entire login screen. It has email, password, an error line, a Sign in
button, a Remember me checkbox, and one link: *"Don't have an account? Open one free →"*.

**There is no support contact, no "forgot password", no "trouble signing in".** Confirmed by search
across the file.

That matters more under §0.05 than it did before: the deep link routes invoice recipients — AP
clerks, who may never have logged in — straight to this screen. **Accounts are provisioned manually
and no password reset exists**, so the only recovery path is contacting support, and the screen
gives them nothing to contact.

Scope: a support line on the login card (`support@freightandlogistics.ai`, and the phone is
permitted here — this is an onboarding/access surface, not error-fallback copy; see CLAUDE.md's
no-phone-as-fallback rule, which this does not breach).

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

**DECIDED 2026-08-03 (closes the clock-start half of D8): the clock starts the day the invoice is
SENT.** Once Stripe is the sender, "sent" means **Stripe's send timestamp** — not `issueDate`, not
the moment the invoice is generated in Primus, not the poll that discovered it. Written explicitly
because all three are plausible-looking and all wrong, and the drift would silently shorten a
customer's dispute window.

Must stay consistent with the 48-hour customer rule and the carrier claim windows. The business-day
calendar for rendering an explicit deadline is still open.

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

### 6.05 THE WORKED EXAMPLE — why the boundary is an allowlist, not a denylist

Not a note. This is the case that proves the rule, and it comes from live data.

The **booking** record carries, as plain named fields:

```
$.vendor.cost                            273.57      <- carrier cost
$.vendor.name                            "Pilot Freight Services"   <- §5.3 NEEDS this
$.accountingInformation.GPActual         9.74313     <- gross margin %
$.accountingInformation.profitUSDActual  29.32       <- margin in dollars
$.accountingInformation.costQuoteId      1443678960
```

**The customer invoice for that shipment is $300.93.** `vendor.cost` of **$273.57 IS the entire
margin** — and it sits **one property away from `vendor.name`**, which the lane description needs.

**`detail.js`'s `BANNED_FIELDS` matches NOT ONE of these names.** That denylist —
`costBreakdown`, `payableBreakdown`, `profitSummary`, `invoiceInternalRemarks` — was written for the
invoice detail and is completely blind to every hazard above.

A denylist only excludes the hazards that existed when it was written, and it is written against one
endpoint's vocabulary. A second endpoint arrives with different names for the same danger and the
denylist says nothing. **The allowlist does not need to know what the hazard is called.**

`src/booking.js` therefore has its own allowlists, its own seal, its own required-value list, and its
own `BOOKING_HOSTILE` byte scan — reused nowhere, inherited from nothing.

### 6.06 `_sourceKeys` records NAMES — do not "simplify" it by blinding it

A leak scan over the narrowed booking fired on the bare string `accountingInformation`. The hit was
in **`_sourceKeys`**, which truthfully records the source record's key NAMES.

**The scan was over-broad; the diagnostic was correct.** The fix was to the TEST, not the field.

Blinding `_sourceKeys` — filtering hostile names out of it — would look tidier and would destroy the
thing it exists for. That field is what caught the `data.results` nesting bug, where reading the
wrong level silently produced a record of nulls. A shape-describer that hides part of the shape
cannot detect drift in the part it hides.

**The distinction is NAMES vs VALUES**, and it is the same distinction that separates the key seal
from the value audit (§6.5):

- `_sourceKeys` may contain the NAME `accountingInformation`. A name is not margin.
- It must never contain a VALUE. Pinned by an explicit test: it must match `accountingInformation`
  and must not contain `273.57`, `9.74313`, `29.32`, or any party name.
- It never reaches Stripe regardless — it is on `NON_PAYLOAD_FIELDS` and `assertPayloadClean`
  rejects any key called `_sourceKeys`.

**The byte scan is on the SERIALISED payload, and covers names AND values.** Names alone are not
enough: the seal already makes an unexpected KEY impossible, so a name scan is belt-and-braces. The
case it cannot catch is a future edit assigning a hostile VALUE to an ALLOWED key —
`serviceLevel: v.cost` passes the seal and passes a name scan. So `assertBookingClean` takes the
source record and learns the hostile values from it, rather than hard-coding a list that would only
ever be right for the one booking it was written against.

Both directions are pinned by negative controls: a planted hostile NAME throws, a planted hostile
VALUE under an allowed key throws, and a clean payload against the same source does not.

### 6.5 Two boundary rules, deliberately separate

The narrowing boundary enforces **two different things**, and conflating them was a trap worth
recording:

| | Guards | On violation |
|---|---|---|
| **Key set** (`assertExactKeys`) | a code regression in the narrowing itself | **THROWS**, everywhere, both directions |
| **Values** (`auditValues`) | a data gap in Primus | **NEVER throws** |

Narrowing assigns every key unconditionally with `?? null`, so a key can only go missing if someone
edits `detail.js`. Absent Primus data never removes a key — it produces a present key with a null
value. A key-level rule therefore cannot catch "this customer has no phone", and marking any key
optional would only weaken the regression guard while buying nothing.

**Key set: all 33 keys, strict in both directions.** An unknown key present is a leak reaching
Stripe — irreversible, so it fails closed and halts. A required key missing is a regression.

**Values: quarantine one record, continue the run.** One bad record must not stop 1,749 good ones.

- **Required value null** → quarantine THIS invoice with the field name; the run continues.
- **Optional value null** → counted, nothing else.

Fields whose null value means *do not bill* — 13 of 33:

| Boundary | Required values |
|---|---|
| detail | `invoiceId`, `invoiceNumber`, `ARCode`, `total`, `status`, `shipment`, `invoiceBreakdown` |
| status | `generated`, `paid` |
| shipment | `BOLNumber` |
| customerInfo | `customerCode` (only once the object exists — `customerInfo` itself is optional, demoted by §0.2) |
| breakdownLine | `description`, `total` |

Notes that are easy to get wrong:

- **`0` and `false` are values, not absences.** A $0 total and `paid: false` are real answers.
  Missing means `null`, `undefined`, or `''` — nothing else.
- **An empty `invoiceBreakdown` counts as missing.** Otherwise the requirement is vacuous: an
  invoice with no lines has nothing to bill.
- **Quarantine rows are prefixed `quarantine:`** in the exceptions table, so a data gap is never
  read as a fetch failure. That confusion has already cost a debugging round (§0.25).
- **Optional nulls are counted per field per run against a denominator**, so the log reads
  `shipment.carrierPRO: 412/1750 (23.5%)`. A rate is what makes a field going from 1-in-1000 to
  400-in-1000 obvious the same day — that is Primus changing something.
- The counter sink is **created per run and threaded explicitly**. A module global would accumulate
  across invocations in a warm isolate and silently inflate (§0.25).

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

### 7.1.1 Round-trip latency — REPORTED, NOT MEASURED

**Stated by the account owner 2026-08-03. Not instrumented, not sampled, not verified by this
system.** Labelled that way deliberately — a number that sounds measured but isn't is the §0.25 error
class.

- **Stripe → QBO:** automatic whenever the payment is attached to an invoice, which every invoice in
  this sync is by definition.
- **QBO → Primus:** syncs roughly **four to five times a day**.
- **Worst case a few hours**, judged not to matter: paying major carriers (TForce, Estes) through
  BillTrust takes days and nobody minds; the receivable side running hours behind is not a constraint
  anyone will feel.

**Why it still cannot be measured from data.** Primus stores `status.paid` as a bare boolean with
**no accompanying date** — verified 2026-08-03 on paid invoices, whose only date fields are
`issueDate`, `invoiceDueDate`, `invoiceFirstSaved`. "When did this flip?" is unanswerable from a
historical read. Measuring it requires instrumenting forward — see `paid_first_seen_at` (§4.5).

### 7.2 Phase 1–8 policy

**Stripe automatic reminders stay OFF for the pilot, regardless of the latency above.** 11 invoices,
one customer — chased manually if it ever comes to that. There is also no lever to hold an in-flight
reminder short of pausing the entire schedule.

**Turning reminders on is a PHASE 9 decision with a measured number behind it, never a phase 5
default.** Before enabling anything, measure the real distribution rather than reasoning from the
reported figure.

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

## 8.5 Deploy ordering — SCHEMA FIRST, CODE SECOND

**A schema change is applied to the remote D1 BEFORE the code that writes it deploys. Never the
reverse.** Backwards, the running worker issues UPDATEs against a column that does not exist and
every write silently fails or errors mid-run.

`schema.sql` is `CREATE TABLE IF NOT EXISTS`, so it will **not** add a column to a table that
already exists. Added columns need an explicit `ALTER`.

**Outstanding, required before the next deploy:**

```
wrangler d1 execute invoice-sync --remote \
  --command "ALTER TABLE ledger ADD COLUMN paid_first_seen_at INTEGER"
wrangler d1 execute invoice-sync --remote --command "PRAGMA table_info(ledger)"   # verify positively
```

The second command is not optional — §0.25: assert the column exists, do not trust the first
command's exit code.

**Also outstanding:** the deployed worker (`5f716f43`) is **older than HEAD**. Before redeploying,
**diff the deployed source against the repo** rather than assuming the deployed side is simply an
earlier commit of the same lineage. `stripe-payments` has a documented history of dashboard edits
producing exactly that divergence.

## 8.6 Work queue as of 2026-08-03

In order. Nothing below is built.

1. **`_recordQboPayments` silent catch** (§0.1.3) — reported read-only. Under §0.05 this is now the
   ONLY writeback path from payment to books, which raises its severity rather than lowering it.
2. **Portal surcharge fixes** — the under-$300 Visa cap breach and the debit exclusion (§5.7).
   Independent of the delivery-only decision; **the fee stays**, so both must be fixed, not dropped.
3. **Stripe never-payable configuration + its test** (§0.05 invariant).
4. **Deep link** (§5.8) including the ownership check, and the login support contact (§5.9).
5. **Booking join and §5.3** — the phase 6 prerequisite.

## 8.65 Layer3 `agreed-config-dropped-on-pull` — UNREPRODUCED, closed

Verified working on **both** paths 2026-08-03 (90660 → 90035, 100 lbs): form path — no accessorials
$69.00/50 rates, with Residential + Liftgate $230.00/43 rates, Primus quote #52571424 showing
LIFTGATE DELIVERY $65.00 and RESIDENTIAL DELIVERY $75.00; agent path — same quote via chat, 43
rates, STG LTL $230.00, header "Residential Delivery, Liftgate Delivery".

Layer3 finding is **UNREPRODUCED**, six days old (present in every 2026-07-29 run), and not in the
invoice-sync path. No investigation, no fix. If it recurs there will be a payload worth reading then.

## 8.7 Post-deploy verification — card fee change

Reading a diff is not verification on a payment path. After the fee change deploys, **one small live
card payment**, confirming three things:

1. the fee charged is **2.9% flat** (no flat component),
2. the fee **displayed equals the fee charged** (§0.1.4 — this is what was broken),
3. it **lands in QuickBooks**.

Item 3 matters most and is the least certain: `_recordQboPayments` still swallows its errors
(§0.1.3), so a QBO write failure is invisible from the UI — and that unfixed defect now sits
directly beneath a change to the same payment path.

### RESULT — PASSED, live, 2026-08-03

| Check | Observed |
|---|---|
| Fee is 2.9% flat | $10.00 subtotal → **$0.29** fee, total **$10.29** |
| Floor holds at scale | $489.64 invoice → **$14.19** = **2.8998%** |
| Label | reads **"Convenience fee (2.9%)"** — no flat component |
| Displayed == charged | $10.29 displayed, **$10.29 paid** |
| Reaches QuickBooks | QBO invoice **142870** shows **Paid in full**, $10.00 recorded |
| `_recordQboPayments` | **writeback worked** on this run |

The $489.64 case is the useful one: 2.8998% confirms the floor is doing its job on a realistic
amount, not just on the round $10.00.

**One caveat on the writeback.** It worked here; that is one successful observation, not evidence
the six failure modes in §0.1.3 are absent. They are all silent, so a passing run looks identical to
a run where the write was never attempted. §0.1.3 stays open.

### OPEN QUESTION — the card fee is not booked in QuickBooks

QBO invoice 142870 recorded **$10.00**, not $10.29. **The card fee is not written to QBO.**

Consequence: **Stripe balance and QBO revenue diverge by the fee on every card payment.** Stripe
receives $10.29; QBO records $10.00 against the invoice; the $0.29 exists in Stripe and nowhere in
the books.

`_recordQboPayments` (`portal.html:4493-4495`) deliberately records `_qboBalance` — the invoice
balance — falling back to the Primus invoice total. Neither includes the fee, so this is the code
behaving as written rather than a defect in it.

Presumably intentional — the fee is a payment-processing charge rather than freight revenue, and
booking it against the freight invoice would overstate the invoice. **Raised for the owner as an
accounting decision, not an engineering one.** Recorded so it is explicit rather than implicit; no
action taken.

## 8.55 Deploy order EXCEPTION — Pages before Worker, for the 2.9% fee change

**The standing rule is Worker before Pages** (§8.5) — KNOWLEDGE.md chain integrity, so the agent is
never speaking from a KB that predates the code.

**For the 2026-08-03 card-fee change the order is REVERSED: Pages first, Worker second.** Do not
"correct" this back.

The governing principle is unchanged — *the agent quoting a LOWER fee than we charge is worse than
quoting a higher one* — but for this change the direction of harm points the other way:

| Order | Gap state | Customer effect |
|---|---|---|
| Worker first | KB says 2.9%, portal still charges 2.9% + $0.30 | quoted 2.9%, **charged MORE**. This is the agent quoting lower than we charge — the bad case. |
| **Pages first** | portal charges 2.9%, KB still says 2.9% + $0.30 | quoted 2.9% + $0.30, **charged LESS**. Harmless. |

**A slow or manual Pages deploy is therefore fine** — the gap sits in the safe direction for as long
as it lasts. **Do not deploy the Worker early to close it.**

This also removes the Cloudflare Pages auto-build question as a blocker for this change: the answer
does not affect the ordering, because Pages going first is correct either way.

**Generalisation for the next time the two are out of step:** the standing order is a default, not
the principle. The principle is *which side of the gap harms the customer*. Work out the direction
of harm for the specific change before applying the default.

## 8.8 STANDING RULE — the eval asserts the WHOLE SET, not one sample

**A green run on one record is not evidence. Render every record and assert every one.**

Worked example, 2026-08-03. Two defects passed 209 unit tests and a full single-invoice render, and
were caught only by rendering all 11 pilot invoices:

**1. The booking value scan rejected EVERY booking.** `accountingInformation.insuranceIncluded` is
`false` on the live record. `hostileValues` stringified it to `"false"` — 5 characters, past the
length guard — and added it to the hostile set. The narrowed `hazmat: false` then matched it, so
`narrowBooking` threw for all 11. **Carrier, footer and the entire lane description were silently
absent from every rendered invoice**, and the single-invoice render looked plausible because a
missing booking degrades gracefully to the Primus line text alone.

The failure mode is the lesson: **a scan broad enough to reject legitimate data is its own defect.**
It failed loudly, which is the right direction — but it failed on 11 of 11, and only the full set
showed it.

**2. Only the LAST send-blocker survived.** `send_blocked` was assigned rather than accumulated, so
the unverified-recipient block overwrote the missing-dispute-notice block. Clearing one would have
looked like clearing all of them.

Neither is exotic. Both are the ordinary shape of a bug that a representative sample hides: one
failed uniformly (so a single sample looked like the norm), the other failed only when two
conditions coincided (so a single sample never met both).

**Rule:** any change to a rendering or narrowing path is verified by rendering the complete pilot
set and asserting each record — not by one representative invoice.

## 8.9 VOID-AWARENESS — PHASE 9 GATE, not an open note

**A corrected primary is currently classified as a REBILL, and that is the worst misclassification
this system can produce.** A full corrected invoice would render as though it were a supplemental
charge: a second invoice for the whole amount, described like an add-on, with nothing saying it
supersedes anything. **To the customer that reads as double billing.**

**It cannot be detected from a void flag.** The Primus list `status` object is
`{estimatedCosts, actualCosts, costActualClosed, charges, readyToInvoice, generated, sent, paid}` —
verified live 2026-08-03. There is no void or cancelled field anywhere in it.

**It CAN be detected by SHAPE, and that detection is not built.** A corrected primary and a true
rebill differ in two observable ways:

| | true rebill | corrected primary |
|---|---|---|
| line description | a surcharge — `OVERSIZE SURCHARGE`, `RESIDENTIAL DELIVERY FEE` | full freight — `FREIGHT CHARGE` |
| amount vs the primary | small and unrelated ($55 against $167.12) | at or near the primary's total |

**Blast radius across the pilot set: ZERO.** Both rebills are $55.00 with surcharge line
descriptions, against primaries of $167.12 and $156.03. Neither resembles a corrected primary on
either signal.

**PHASE 9 GATE.** Before live mode, a later invoice on a BOL whose line description matches the
primary's, or whose amount is within tolerance of the primary's total, must classify **`hold`**
rather than `rebill`. `hold` is already a supported verdict and already leaves placement unplaced —
the detection is what is missing, not the handling.

## 9. Build order

Phases 1–4 are **test mode only** (§2.1). Nothing customer-facing exists until phase 5.

| # | Phase | Gate to exit |
|---|---|---|
| 1 | Worker scaffold, mode-aware config, Primus auth + token cache | Test-mode key wired; `STRIPE_MODE` explicit; no live secret present |
| 2 | D1 ledger schema + idempotency layers (§4.1–4.2) | Ledger rejects a duplicate under forced concurrent runs |
| 3 | Invoice list poll, pagination, dedupe, run lock | Full month window replayed twice → zero duplicate ledger rows |
| 4 | Customer resolution + ARCode cache (§0.2) | ARCode↔primusCustomerId join confirmed (D2) |
| 5 | Field mapping, fetch-boundary narrowing, line rule (§5.1), classifier (§4.3), dispute notice (§5.5) | Internal fields provably absent from payload construction scope; payload builder refuses to construct without the dispute notice |
| 6 | Draft creation in **test mode**, **pilot customer only** (§3.1). **PREREQUISITE: §5.3 line description + the booking-join narrowing boundary** — a single generic line is thinner than the invoice Primus sends today | Every Payless invoice for a real month reviewed line by line; classifier verified on known rebills; **line detail at least as informative as the Primus invoice it replaces** |
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
| **D1** | **ANSWERED §0.1.2** — the portal creates a bare PaymentIntent and the two paths converge on the Primus invoice number, so the same invoice is payable twice. Not live harm today (the portal is the only path); becomes real with the first Stripe invoice. Four options enumerated, **none chosen** | **Phase 6 GATE** |
| ~~D2~~ | ~~ARCode ↔ QBO join~~ — **resolved 2026-08-03** (§0.2). Residual: confirm `customerInfo.customerId` is the portal's `primusCustomerId` | — |
| **D3** | Does Primus issue two invoices on one BOL to different bill-to parties? Determines whether the classifier keys on `(BOLNumber, ARCode)` | Phase 6 |
| **D4** | Credit-note path for net-negative rebills (§5.2) | Phase 9 |
| **D5** | Is the `COI` on a BOL the carrier's or ours? (§8) | Phase 8 |
| **D7** | Authoritative dispute-notice wording, transcribed from the current Primus invoice email (§5.5). If >369 chars, which short form goes in the memo | Phase 5 |
| **D10** | Rebill→original linkage: what a rebill carries pointing at the invoice it supplements (§5.3) | Phase 6 |
| **D8** | ~~Clock start~~ **CLOSED**: Stripe's send timestamp (§5.5). Still open: the business-day calendar for rendering an explicit deadline | Phase 9 |
| **D9** | Delivery answered (§0.1.1 — Primus + QBO email, both stopping at go-live). **Still open:** can Payless log into the portal and pay via the modal? That path survives the routine change and is the same two-live-paths failure | Phase 9 |
| **D6** | Stripe email subject line — currently "New invoice from Freight and Logistics, Inc. #\<number\>", carries no BOL or PO reference. Gmail will thread these for customers the way QBO reminders threaded for us | Phase 10 |
