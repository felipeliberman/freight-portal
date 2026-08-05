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

`portal.html:4114-4176` renders a "Pay Invoices" modal listing Primus invoices and pays them via
`stripe-payments` `/create-payment-intent`, passing the invoice numbers flattened into a PaymentIntent
`description` string. It creates **no Stripe Invoice object** and leaves no link back to one.

Consequences that must be designed for, not discovered:

- **Two payable surfaces for the same debt.** After sync, a customer can pay in the portal modal *and*
  on the Stripe hosted invoice page. Neither knows about the other. ACH settles over days, so both can
  be in flight at once and both succeed.
- **Card surcharge mismatch.** The portal adds a 2.9% convenience fee on card
  (`cardFeeOn()`, `portal.html:3625`). **Re-anchored during the 2026-08-04 sweep, and the prose was
  wrong as well as the line:** the citation pointed at `portal.html:4536`, whose content was
  `const fee = paymentMethod === 'card' ? subtotal * 0.029 + 0.30 : 0;` — a formula that no longer
  exists, because the fee became **2.9% flat with no flat component** (§8.7, verified live). The
  surrounding sentence still said "2.9% + $0.30" and has been corrected here.
  A synced Stripe invoice paid by card carries no such line. Same invoice, two
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
portal.html:3255   qbo-api/invoices?docNumber=<Primus invoice #>   → _qboId, _qboBalance
portal.html:4113   stripe-payments/create-payment-intent           → PaymentIntent
   worker :185       description = "Invoices: 140488, 140061"      ← FREE TEXT, not a reference
portal.html:4128   _recordQboPayments(invoices, paymentIntent.id)
portal.html:3625   qbo-api/payment { invoiceId:_qboId, amount, paymentDate, stripePaymentIntentId }
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
  convenience fee (`portal.html:3665`); a Stripe invoice carries no such line.
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
(`portal.html:3255`), so an invoice already paid in Stripe *does* eventually show zero and drop out
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

`portal.html:3633` (anchor: `// amount is the QBO Balance, falling back to the invoice total.
Best-effort — never`). The comment reads *"Best-effort — never blocks the success UI, since Stripe
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
| `portal.html:3665` | `subtotal * 0.029 + 0.30` | modal summary (displayed) |
| `portal.html:3733` | `subtotal * 0.029 + 0.30` | receipt (displayed) |
| `portal.html:4076` | `subtotal * 0.029 + 0.30` | fee row (displayed) |
| `portal.html:3912` | `subtotal * 1.029 + 0.30` | **`calcTotal` — the CHARGED amount** |

Three display sites computed the fee directly and rendered it via `.toFixed(2)`. The fourth
computed the *total* in a different shape, and that total is what reaches
`/create-payment-intent`, where the worker does `Math.round(amount * 100)`. At $55 the displayed
fee floors to `1.59` while the rounded total yields `1.60` — the two paths disagree by a cent.

**Fix: one function, `cardFeeOn()`, called by all four sites; none computes its own value.**
Consolidation is the fix, not a refactor riding along with it — copies that must agree are exactly
what produced the divergence. Flooring in integer cents additionally makes the displayed fee equal
the charged fee by construction.

### 0.2.0 PILOT IDENTITY CHECKLIST — required before `AR_ALLOWLIST` is repointed (2026-08-04)

The pilot subject is now the **owner's test account** (§3.1). Nothing here may be guessed: every
item is a value the code matches **exactly**, and a wrong one either claims another customer's
invoices or silently claims nothing.

| # | Needed | Why exactly this, and what breaks without it |
|---|---|---|
| 1 | **ARCode** — the value in `customerInfo.customerCode` on that account's Primus invoices | The *only* thing `AR_ALLOWLIST` matches (`checkArCode`, `config.js:93`). It is the pilot boundary; fails closed if unset. Verified on Payless as matching `customerInfo.customerCode` on 11 of 11 |
| 2 | **QBO DisplayName** for that account | `displayNameMatchesArCode` (`customers.js:31`) requires the DisplayName to END in `-<ARCode>` — a **suffix** match, deliberately not `endsWith`, so `Acme-15406` cannot match `5406`. If the record does not follow the `<Company>-<ARCode>` convention, resolution returns `unmatched` and every invoice lands in the exception queue rather than being billed. **Tell me the exact string, including whether the suffix exists at all** |
| 3 | **Whether that account has invoices in the poll window** | Phase 3 polls 60 days. No invoices means the pilot renders nothing and proves nothing — worth knowing before the switch, not after |
| 4 | **Recipient email(s) on the QBO record** | `PrimaryEmailAddr.Address`, comma-split into primary + cc (`parseEmails`). Nothing sends in test mode, but the value is read and rendered, and a malformed address vanishes silently (§5.6) |

**Useful but not identity:** the Primus `customerInfo.customerId` (the numeric — Payless's is
`701567`). It is a cross-check only; ARCode remains the key by elimination.

Once items 1–2 are known, the changes are: `AR_ALLOWLIST` (secret/`wrangler.toml`), the pilot
references in §3.1, §8.7's verification subject, and the fixtures in
`invoice-sync/test/allowlist.test.mjs` and `customers.test.mjs` — **the Payless values in those tests
stay as worked examples where they demonstrate matching behaviour** (`Payless Rugs-5406` vs
`Unrelated 5406 Holdings` is a real negative control and should not be deleted).

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

**Added 2026-08-04 — enumerate the assumptions before drawing the conclusion.** When a conclusion
rests on inference rather than direct observation, write the assumptions down as explicit claims
*first*, then check them. The failure this prevents is not the visible one.

Worked example from the day it was added (§8.868). Two errors, one visible and one not:

| | the error | how it went |
|---|---|---|
| `--date=format-local:'%Y-%m-%dT%H:%M:%SZ'` printed PDT and labelled it `Z` — the `Z` was a literal typed character | **Visible, and it died in two minutes.** It was stated, so it was checkable |
| "the deployed script equals the source committed around that time" | **Load-bearing, and it went unchecked for the whole analysis** — because it was never stated. It was disproven only by pulling the bundle |

The dangerous assumptions are the ones that feel too obvious to write down. An unstated assumption
cannot be falsified by anyone, including its author.

### 0.26 Code citations carry an anchor — STANDING RULE

**Every `portal.html:NNNN` citation (or any line-number citation into a large file) must carry a
function name or a distinctive string alongside the number.**

A bare line number rots silently. Worse, it rots *invisibly*: after an edit above it, the citation
still looks precise, still points at real code, and now describes the wrong thing. **A stale
citation reads as verified when it isn't** — the same failure this document keeps warning about,
applied to the document itself.

The 2026-08-04 sweep is the evidence. Deleting 869 lines (D7) shifted **32 of 40** citations. Of the
rest: one pointed at a card-fee formula that **no longer exists in any form** (§0.1's
`const fee = ... * 0.029 + 0.30`, dead since the fee became 2.9% flat) with the surrounding prose
still quoting the old formula; one pointed into a deleted block; two could not be re-located at all
from their bare numbers because the cited content was `//` and `}`.

Note also that `portal.html:4536` meant **three different things** in three different sections,
depending on when each was written. The number alone cannot tell you which.

Required form — number plus anchor:

> `cardFeeOn()`, `portal.html:3625`
> `portal.html:21477`, anchor `const invUrl = p => PRIMUS_BASE + '/applet/v1/invoice?limit=100&page=' + p;`

In practice:
- **Prefer the function name.** It survives edits that line numbers do not, and it is greppable.
- **Re-locate by content, never by arithmetic.** The naive shift after a deletion is wrong whenever
  the same change also edits other lines — in D7 the true shift differed from −869.
- **Never guess a replacement number.** If content re-location fails, mark the citation
  **UNVERIFIED** and record what it used to say, so the next reader knows the pointer is broken
  rather than trusting it.
- When a change moves code, sweep the citations in the same commit. `git blame` the spec line →
  read the cited file at that commit → find that exact content now. That is mechanical and cheap;
  what is expensive is a spec whose references quietly lie.

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

**CHANGED 2026-08-04 — the pilot subject is the OWNER'S TEST ACCOUNT, not Payless Rugs.**

**Phases 6–9 run against ONE customer: the owner's test account. Its ARCode is NOT YET RECORDED —
see the block below, and do not set `AR_ALLOWLIST` until it is.** Everything else stays on the
current Primus/QBO flow, untouched, until phase 9 proves out.

**Why it changed:** the pilot writes to a real customer's Stripe records and, at phase 9, sends real
customer-facing mail. Doing that first against an account the owner controls removes the entire class
of "we tested on someone who could receive it." `ap@paylessrugs.com` verification (C2) and the
recipient-confirmation work stop being preconditions for the *pilot* — they return only when a real
customer is added.

> ### BLOCKED 2026-08-04 — the test account's identity is INCONSISTENT INSIDE PRIMUS
>
> Not a missing value. **Primus reports two different codes for the same invoice**, and QBO agrees
> with the one the poll does not use.
>
> | Source | Field | Value |
> |---|---|---|
> | Primus invoice **list** | `ARCode` | **`12345678`** |
> | Primus invoice **detail** | `customerInfo.customerCode` | **`1234`** |
> | Primus detail | `customerInfo.customerName` | `Freight and Logistics, Inc. - TEST` |
> | Primus detail | `customerInfo.customerId` | `33717` |
> | QBO | `DisplayName` | `Freight and Logistics, Inc. - TEST-1234` (suffix `1234`) |
>
> Verified on **both** invoices (#141604 `invoiceId 1563993653`, #141385 `invoiceId 1269958425`).
> This is not a transcription error at either end — the two Primus endpoints genuinely disagree.
>
> **Neither value can drive the pilot:**
>
> - `AR_ALLOWLIST="12345678"` — the poll claims (list matches), then `resolveCustomer` searches QBO
>   for `12345678`, finds no `-12345678` suffix, and returns `no_display_name_suffix`. Even had it
>   matched, the detail cross-check at `customers.js:192` compares `customerCode` (`1234`) against
>   the list ARCode (`12345678`), disagrees, and returns `null`. **Two independent guards reject it.**
> - `AR_ALLOWLIST="1234"` — the poll filter reads the **list** ARCode (`12345678`), which is not
>   allowlisted, so the invoices are never claimed at all. This is why the 5,603-invoice scan found
>   zero: the scan was correct, the input value was not.
>
> **The guards are behaving exactly as designed** — `customers.js:188-198` exists precisely to refuse
> a join whose two sides disagree, and it fails closed rather than picking one. Nothing here is a
> code defect. **This is a DATA problem on the account, and fixing it is an owner decision:** make
> Primus's list ARCode and detail customerCode agree, and make the QBO DisplayName suffix match
> whichever wins. **The matcher must not be relaxed to accommodate it** — that hardening is what
> stops `Acme-15406` billing as `5406`.
>
> **Note for the wider book:** §0.2's "`customerInfo.customerCode` MATCHES ON 11 OF 11" was verified
> on Payless, where the two agree. This account proves the two fields **can** diverge, so that match
> is a property of Payless's data rather than a guarantee of the API. The cross-check is load-bearing.

**Payless data is RETAINED as worked examples.** The 11 rendered invoices, BOL 160134786's
aggregation, `vendor.cost` 273.57 and the under-$300 surcharge finding are **evidence** — they
demonstrate real behaviour of the mapper, classifier and Primus payloads, and none of that is
invalidated by changing who the pilot bills. Where Payless appears below as a *worked example*, it
stays. Where it appears as *the pilot subject*, it is superseded by this section.

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
  stripe_state,         -- src/ledger.js STRIPE_STATES is authoritative. Today:
                        -- intent | creating | draft | finalized | void | paid | uncollectible | failed
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
<weight> lbs · Class <class> · PU <pickup date> · <zero-dollar accessorials>
```

> **HOLD #5 — ACTIVE. The zero-dollar accessorials render as the BARE NAME, with no `Incl.` prefix.**
>
> This spec previously specified `Incl. <zero-dollar accessorials>`, and **that is how the drift
> happened**: the owner held the prefix in conversation, the hold was never written down here, and
> the spec kept instructing the mapper to emit it. It reached live rendered output on 2026-08-04
> (invoice #141385, `Incl. RESIDENTIAL DELIVERY`) before being caught.
>
> **Why the prefix is not ours to write:** "Incl." asserts the accessorial was **included at no
> charge** — a commercial claim. A `$0.00` line in `invoiceBreakdown` means the line carried no
> charge *on this invoice*, which is not the same as the service being free. If that accessorial is
> later rebilled, the word "Incl." contradicts us in writing on the customer's own document — the
> same trap §5.1 already avoids by refusing to print `LIFTGATE — $0.00` as a line.
>
> **Blocked on:** the priced-or-included question at `KNOWLEDGE.md` §White Glove ("residential
> liftgate standard on every white glove delivery"). **Owner decides.** Until then the bare name
> states what is true and nothing more: the accessorial was on the shipment.
>
> **A hold that lives only in conversation is not a hold.** This is the second time in this project
> that an owner decision existed nowhere in the repo and was silently reverted by the artefact that
> outlived the conversation (cf. §8.864's instance 1, which survived only in memory). Any future
> hold gets written at the point of decision, into the section that would otherwise contradict it.

**Carrier names in `custom_fields` are abbreviated, never cut mid-word.** Stripe caps custom-field
values at 30 characters, and a hard slice produced **`Metropolitan Warehouse & Deliv`** on live
rendered output — a chopped word reads as a bug where a deliberate abbreviation reads as intent.
`shortenForField` (`mapper.js`) maps long names to the abbreviation **the portal already uses**, so
the customer sees the same name on the invoice and in My Shipments; with no abbreviation available
it truncates at a word boundary with an ellipsis.

Surveyed against live booking data 2026-08-04 (45 bookings, 9 distinct carrier names): **exactly one
name exceeds 30 characters** — `Metropolitan Warehouse & Delivery Corp` (38), and it is the most
common carrier in the sample (21 of 45). Its abbreviation `Metro W&D` is taken from `portal.html`'s
existing `.replace('Metropolitan Warehouse & Delivery Corp','Metro W&D')`. The map holds four keys
covering the `&`/`and` and `Corp`/no-`Corp` spellings. **The footer keeps the full legal name** — it
has no length limit, so nothing is lost.

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

> **CLEARED FOR THE PILOT ONLY, 2026-08-04 — `felipe@freightandlogistics.com`.**
>
> Recorded in `VERIFIED_RECIPIENTS` (`invoice-sync/src/mapper.js`). It is the **owner's own address
> on the owner's own test account**, and it was cleared **BY OWNER ASSERTION**.
>
> **No verification check was performed, and no such check exists.** That list is the record of a
> human decision, not the output of a process — stated plainly so nobody later reads a populated
> list as evidence that something was validated.
>
> **The C2-style requirement is UNCHANGED FOR EVERY REAL CUSTOMER.** An address that exists only in
> QBO, with no corroboration and no record of who added it or when — `ap@paylessrugs.com` is the
> live example below — must be confirmed with the customer directly before it goes on this list.
> Being the pilot subject is what makes assertion sufficient here; it is not a precedent.
>
> Two properties deliberately preserved:
>
> - **`verifiedRecipients` still defaults to `null`**, and `unverifiedRecipients` still fails closed
>   on a null or empty list. A caller that forgets to pass the list blocks everything, exactly as
>   before. The constant is configuration a caller opts into, never a silent default.
> - **The list clears only the address it names.** Verified by test: the same approved notice with
>   an unknown recipient still yields `unverified_recipient` and still throws in `assertSendable`.



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
portal.html:3665   const fee = paymentMethod === 'card' ? subtotal * 0.029 + 0.30 : 0;
portal.html:3733   var   fee = paymentMethod === 'card' ? subtotal * 0.029 + 0.30 : 0;
```

One branch — ACH or not-ACH. Every card Stripe accepts, **including debit**, is charged 2.9% + $0.30.

**And it structurally cannot distinguish**, because the fee is computed and displayed *before the
card is collected*. The worker requests `payment_method_types[] = card` with no funding restriction
(`stripe-payments/src/index.js:183`), and the brand is only known **after** payment, when the portal
passes `cardBrand`/`cardLast4` to `/send-confirmation` (`:227`, `:243`). At fee-calculation time
there is no card to inspect.

#### Exact current user-facing wording — verbatim, unchanged

```
portal.html:3689   Convenience fee (2.9% + $0.30)
portal.html:3755   Convenience fee (2.9% + $0.30)
portal.html:3988   Pay by Card   —   2.9% + $0.30 convenience fee
portal.html:3988   Pay by Bank   —   ACH transfer - No fee
portal.html:4076   Convenience fee (2.9% + $0.30)
```

Four disclosure sites, three render paths, one string. **Not changed.**

### 5.8 Deep link — scope (NOT BUILT, read-only survey 2026-08-03)

Stripe's Pay button carries an invoice into the portal. What that takes:

**1. Read the identifier from the URL.** No mechanism exists. The portal has no invoice deep-link
route today. The identifier should be the **Primus invoice number** — it is the one value already
shared by the Stripe invoice (`number`), QBO (`docNumber`), and the portal's own invoice list.

**2. Survive the login round trip — and `_finalizeLogin` actively destroys tab state.**

`portal.html:9421` runs `localStorage.removeItem('rp_tabs')` and `rp_active_title` on **every**
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
`https://freightandlogistics-api.shipprimus.com` (`portal.html:1236`) — the **customer/portal API**,
which is scoped to one customer's own data by the bearer token
(`GET /applet/v1/invoice?limit=100&page=N`, `portal.html:21477`, anchor `const invUrl = p =>
PRIMUS_BASE + '/applet/v1/invoice?limit=100&page=' + p;`, `Authorization: Bearer <token>`).

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

`portal.html:967` is the entire login screen. It has email, password, an error line, a Sign in
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

### 5.31 The fourth custom field is CONDITIONAL on classification

**REBILL → `Original Invoice`. PRIMARY → `Your Ref #`.** Stated here explicitly rather than left as
a side effect of the code.

| classification | fourth field | value |
|---|---|---|
| `rebill` | `Original Invoice` | the primary's invoice number |
| `primary`, `hold`, unclassified | `Your Ref #` | `ledger.customer_reference` |

**Why it wins on a rebill, and only there.** `Your Ref #` comes from the shipment, so a rebill
carries the *same* value as its primary — it tells the clerk nothing they do not already have on
the invoice they filed. The original invoice number is **the only thing on a rebill not recoverable
from anything else on the page**. On a primary there is no original to point at, so swapping the
field there would lose the customer's own reference for nothing.

Rendered, both live pilot rebills:

```
Invoice #141015          Invoice #142264
BOL #   160133034        BOL #   160134933
PRO #   402052249        PRO #   402052249
Carrier Pilot Freight…   Carrier Pilot Freight…
Original Invoice 140061  Original Invoice 141886
OVERSIZE SURCHARGE …     RESIDENTIAL DELIVERY FEE …
$55.00                   $55.00
```

**Labelled as a POINTER.** `Original Invoice` with a bare number: the field NAME carries the
"which invoice" meaning, so a clerk cannot read it as this invoice's own number. `Re: Invoice …`
inside the value was considered and rejected — it duplicates the label and spends 12 of the 30
available characters restating it.

#### It is DERIVED — treated like ARCode

**Primus hands us this nowhere.** Neither the booking nor the invoice detail references a sibling
invoice. The value comes from the **classifier's sibling set**, which is already computed to decide
primary-vs-rebill, so it costs no additional call.

**Derivation:** among all list records sharing the BOLNumber, ordered by `issueDate` then
`invoiceId` ascending, the earliest record's `invoiceNumber`.

**INDEPENDENT CORROBORATION — the rule, written before anything consults it.**
`GET /document/bolnumber/{n}` returns multiple `INV` entries on a rebilled BOL (§8). That is a
second path to the same fact. **Nothing fetches it today and nothing should be built to.** But if it
is ever consulted and disagrees with the derived value, **the disagreement must SURFACE — an
exception, not a silent resolution.** Two paths to one fact that quietly disagree is how a wrong
number reaches a customer looking authoritative. Neither path wins by default.

#### Negative control — a rebill with no derivable original OMITS the field

Every `hold` path returns a null pointer, so a rebill normally always has one. Defensively, when it
does not: **the field is omitted and `Your Ref #` renders instead.** Chosen over quarantine — the
invoice is otherwise complete and correct, and withholding a valid bill over a pointer field is
worse than shipping it without one. Reversible fails open. The pointer is never guessed.

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

### 5.5 Dispute notice — REQUIRED payload element. **C1 APPROVED 2026-08-04**

> ## APPROVED WORDING — not a draft
>
> ```
> Dispute this invoice within 3 business days of the date sent. Send written notice with
> supporting documentation to accounting@freightandlogistics.ai. Without timely notice and
> documentation, no dispute will be filed with the carrier and the invoice is due in full.
> ```
>
> Owner-authored and approved 2026-08-04. Lives as the exported constant `DISPUTE_NOTICE`
> (`invoice-sync/src/mapper.js`) so it is never retyped at a call site — retyping a contractual
> clause is how two versions of it reach production. **Do not reword, trim or "tighten" it.**
>
> ### It fits, measured rather than estimated
>
> | | |
> |---|---|
> | Notice | **264** chars |
> | Budget with the docs link present | **368** (`MEMO_MAX` 500 − 132 fixed overhead) |
> | Budget without a docs link | 439 |
> | Rendered memo, with docs link | **396 / 500** — headroom 104 |
> | Rendered memo, as actually rendered today (no docs link) | 325 / 500 |
>
> **Nothing is truncated, so all three operative terms survive intact**: the 3-business-day
> deadline, that documentation is required, and the consequence (no carrier dispute filed, invoice
> due in full). This is not a judgement — an over-length memo **send-blocks** (`memo_over_limit`),
> so the passing test *is* the proof that the wording survives whole on every surface.
>
> **It leads the memo**, so on any surface that truncates, the notice is what survives.
>
> ### THIS IS A BILLING-DISPUTE CLAUSE, NOT THE CARGO-CLAIMS WINDOW
>
> Do not conflate it with A1 (§8.857). Different subject, different clock, different legal basis:
>
> | | Cargo claims (A1 / §8.857) | This clause (C1) |
> |---|---|---|
> | Subject | damage/loss to the freight | a disputed **invoice** |
> | Window | 5 days to report concealed damage; **9 months** to file | **3 business days** to dispute |
> | Clock | delivery (or pickup, for non-delivery) | the date the invoice was sent |
> | Basis | Carmack territory | a negotiated contractual term |
>
> **49 USC 14705 sets an 18-month limitation on actions to recover OVERCHARGES. It imposes no floor
> on a contractual dispute-NOTICE window.** So 3 business days stands as a negotiated term and is
> not pre-empted by the statute. Anyone reading the two windows together should stop here: they are
> not versions of the same rule and neither governs the other.
>
> ### Open definitional point, deliberately not resolved here
>
> "**the date sent**" is the clock's start. Once Stripe is the delivery mechanism (§0.1.1), that
> means the **Stripe** send — not Primus's `status.sent` flag, which §8.865 shows varies
> independently (invoice #141385 was never sent from Primus at all). Worth pinning before the first
> real dispute, because the customer and we must start the same clock.



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

## 8.55 HANDOFF — read this first (written 2026-08-03, end of session)

Assume no memory of the session that produced this. Everything below is committed and pushed.

### Where each phase stands

| Phase | State |
|---|---|
| 1 Scaffold, mode-aware config, Primus auth | **Done.** Deployed, test mode, no cron, no public URL |
| 2 D1 ledger + idempotency | **Done.** Constraint verified on the real D1 instance |
| 3 Windowed poll | **Done.** 36 subrequests for 60 days, pilot allowlist `5406` |
| 4 Customer resolution | **Done.** ARCode is the key (§0.2, by elimination) |
| 5 Mapper | **Done.** §5.1 placement, §5.3 lane, §5.5 memo mechanism, §4.3 classifier |
| 6 Draft creation | **HELD AT STOP 1.** Nothing has ever been created in Stripe |
| 7 Dunning / wording | **STOP 2 PARTLY LIFTED 2026-08-04.** The dispute notice (C1) is APPROVED and rendering; dunning wording is still unwritten |
| 8 Documents | Decision layer done; **R2 mirror deliberately not built** (§8.95) |
| 9 Live mode | Not started. Not to be started without the Group A and C gates |

### The three held stops

1. **Nothing is created in Stripe.** ~~The worker holds no Stripe key.~~ **THE SECOND SENTENCE WAS
   FALSE IN PRODUCTION — discovered 2026-08-04, see §8.869.** A restricted test key
   (`invoice-sync-test`) was created on 2026-08-03 and bound to the deployed Worker as
   `STRIPE_RK_TEST`; the project record never mentioned it. It is now revoked. **The first sentence
   holds and is now positively verified** — Stripe reports the key was never used, and the deployed
   bundle contains zero Stripe egress. All 11 pilot invoices have been rendered in memory and read;
   none exists anywhere.

   > This entry is struck through rather than rewritten on purpose. The record and production
   > diverged for a day and nothing detected it; a clean reword would erase the only evidence that
   > the gap is possible.
2. **No customer-facing wording has been written by the assistant.** Still true: the dispute
   notice now rendering (C1, §5.5) was **written by the owner**, not drafted here. `DISPUTE_NOTICE_PENDING`
   remains the fallback whenever a caller supplies no notice, and that case is still send-blocked
   through `assertSendable`. Dunning wording remains unwritten.
3. End of phase 8, which is here.

### What to pick up FIRST

**A2 — Terms versioning — before A1, and before any Terms edit.**

This ordering is not a preference. **A2 lands first regardless of which number wins A1**, because
whichever number wins gets written into the Terms — and writing it into an unversioned Terms page
repeats the exact problem A2 exists to fix. Deciding A1 first and editing immediately would put the
new claims window in as unversioned text, on top of a 3-business-day billing clause that would also
go in unversioned. One unversioned edit is a records gap; three is a pattern.

So: **A2, then A1, then A3, then the Terms edit carrying both A1's number and the new 3-day billing
clause, then A4.**

### Then

- **Group C** before anything is created in Stripe — the wording, the recipient verification, the
  never-payable configuration and its test, and void-awareness detection.
- **Group B** are live defects, reported and unfixed, each out of scope for the invoice-sync build
  and each needing its own decision.
- **Group D** is unstarted work. **Group E** is one parked branch with a known regression.

### Standing rules this build follows

Negative controls in both directions. Serialised-bytes scans covering names AND values. Positive
verification, never exit codes (§0.25). Absence claims need a verified-scope method. Reversible
fails open, irreversible fails closed. Anything asserted about Primus needs a second path or it is a
claim about us. And §8.8: **the eval asserts the whole set, not one sample** — two defects this
session passed 209 unit tests and a single-invoice render, and were caught only by rendering all 11.

## 8.6 WORK QUEUE — open items as of 2026-08-03 (end of phase 8)

Nothing below is built. Ordered by what blocks what, not by size.

### A. Contractual — blocks the 3-business-day billing clause

| # | Item | Ref | Why it blocks |
|---|---|---|---|
| A1 | **CLOSED 2026-08-04.** Neither candidate won — the Worldwide Express structure is adopted: 5 days to report concealed damage (carrier-attributed), 9 months to file from delivery (or from PICKUP for non-delivery), we file and pursue but do not warrant the outcome, ~30 days to acknowledge + ~120 to resolve. **The decision is made; only its publication is still gated, on A2.** | §8.857 | No longer a decision. The 48h framing is still live in the deployed Worker until the KB is rebuilt and redeployed. |
| A2 | **Terms versioning.** `index.html:1710` writes the terms URL into executed credit applications as "incorporated into and made part of this agreement". `rec.consents.termsAndConditions` is a BOOLEAN — it records THAT they agreed, never WHAT. Editing the Terms silently repoints every past signer at text they never saw. | §8.856 | Must land BEFORE any Terms edit, or the 3-day clause goes in unversioned too. |
| A3 | **Split KNOWLEDGE.md §5** ("Billing, adjustments, claims" → 5a/5b/5c/5d). A retrieval defect: one heading is how a billing question reaches a claims deadline. | §8.858 | Independent of A1's number. Gives the 3-day clause an unambiguous home. |
| A4 | **Publish the Terms everywhere before the first 3-day notice ships.** Includes the Wix copy, which cannot be verified from this repo. | §8.85 | Phase 9 precondition. A green repo is not evidence. |

### B. Live defects — reported, not fixed, out of scope for this build

| # | Item | Ref |
|---|---|---|
| **B0** | **EVERY SAVED SHIPMENT SHOWS A COMPLETED "DISPATCHED" CHECKPOINT.** Cause **confirmed** 2026-08-04 on BOL 160135909: a saved shipment's requested pickup date (`estimatedPickupDate`) falls into `dispatchDate` at `portal.html:7631` and lights `disp` at `:7650`. **Not** a failed tender — the earlier "rejected tender rendered as success" framing was a misdiagnosis. Introduced 2026-07-28 (`e3b5d65`); the code it replaced was correct. A standing misrepresentation, not an incident. **Unfixed, parked — portal tracking, unrelated to this build.** Fix shape and reader inventory in §8.864; owner decision pending on scheduled-marker vs tender-outcome-only | §8.864 |
| B1 | `_recordQboPayments` — six silent failure modes; the only writeback from payment to books, and it cannot report its own failure | §0.1.3 |
| B2 | Debit cards are still surcharged, which is not permitted in the US. The cap fix did not address it | §5.7 |
| B3 | The portal payment surface and Stripe invoices can address the same invoice (dissolved by §0.05's architecture, NOT fixed — it returns if the hosted page is ever made payable) | §0.1.2 |
| B4 | ~~Tracking is broken now~~ — **WRONG, corrected 2026-08-03.** There was no outage: nothing has called `track-proxy` since 2026-07-30, and tracking works today on `fl-tracking` (live-verified, both routes). The row is kept rather than deleted because the error is the lesson — a dead dependency was filed as a customer-facing emergency without checking whether anything reached it. The real live defect it was hiding (`?bol=` returning 200 on upstream failure, rendering our outage as the customer's bad number) is **FIXED**. Retiring the dead Worker is cleanup → **D6** | §8.861, §8.863 |
| B5 | `www.freightandlogistics.com/demo-session` — **works today**, so NOT broken, but it is Wix-hosting-dependent and is the only remaining `.com` content dependency in the repo | §8.862 |
| B6 | **An unaccounted-for LIVE restricted Stripe key.** `rk_live_…9lmX` on the same account, created 2026-07-14, **last used 2026-08-04 — today**. Nothing in this project accounts for it; it is a different environment, not `invoice-sync`. **DO NOT TOUCH, DO NOT REVOKE — it is in use by something.** Investigate later this week via the Stripe live request log to identify the caller | §8.869 |

### C. Before anything is created in Stripe

| # | Item | Ref |
|---|---|---|
| C1 | ~~The dispute-notice WORDING~~ — **APPROVED 2026-08-04**, owner-authored, live as `DISPUTE_NOTICE`. 264 chars against a 368 budget, nothing truncated, all three operative terms intact. A BILLING-dispute clause, not the cargo-claims window (A1) — 49 USC 14705 imposes no floor on a contractual notice window | §5.5 |
| C2 | ~~`ap@paylessrugs.com` verification~~ — **not a pilot blocker**: the pilot subject is the owner's test account, and `felipe@freightandlogistics.com` was cleared **by owner assertion** (no check exists). **Returns as a hard blocker for any real customer**; the unverified-address finding in §5.6 stands untouched | §5.6 |
| C3 | The Stripe never-payable configuration, and a test that pins it | §0.05 |
| C4 | Void-awareness detection — a corrected primary currently classifies as a rebill | §8.9 |
| C5 | **The deployed Worker matches no commit — it is a mid-phase-4 working tree.** The running artifact is not reproducible from git; every claim about what is live needs a bundle pull; the deployed code was never reviewed as a diff. Rule adopted, not yet enforced: **nothing deploys from a dirty tree again** — a deploy names a commit, the tree is clean at it, the bundle is verified against a re-bundle. Load-bearing at STOP 1 lift, where "deployed equals reviewed" starts carrying weight it does not carry today | §8.868, §8.866 |

### D. Not started

| # | Item | Ref |
|---|---|---|
| D1 | R2 bucket, mirror fetch/write, and the `docs.` route that validates a token | §8.95 |
| D2 | Deep link into the portal, including the ownership check | §5.8 |
| D3 | Login screen support contact | §5.9 |
| D4 | Detail-pass chunking for full-book scale | §3.2 |
| D5 | Dunning intervals, measured rather than reasoned | §7.1.1 |
| D6 | **Retire the `track-proxy` Worker.** Dead code, still deployed and still answering. No repo consumers, fully superseded by `fl-tracking`. Confirm no dashboard route and no traffic first, then delete the Worker and `track-proxy/` | §8.861 |
| D7 | **Delete the `#public-view` widget** (`portal.html:997-1865`) and point logged-out `/portal` at the landing chat. Never executed in 50 days / 619 versions; duplicates a working surface. Owner decision 2026-08-03: delete, do not repair | §8.861 |
| D8 | **The `wrangler.toml` PENDING block is hand-maintained and has already drifted once.** On 2026-08-04 it listed one of two outstanding ALTERs, so the mechanism meant to catch an unapplied migration had failed silently *before* the hazard did — and nothing in the repo would have stopped a deploy of a `main` that required one. Two independent fixes: a **pre-deploy check that refuses to deploy while the block is non-empty** closes the hazard; **generating the block from `schema.sql`** closes the drift | §8.5, `invoice-sync/wrangler.toml` |

### E. Parked, deliberately

`wip/gate-outcome-rewrite` — the outcome-based save-stall detector. Regresses layer2 case 54; cause
identified at `portal.html:14887`. Untouched until picked up on purpose.

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

`_recordQboPayments` (`portal.html:3622-3624`) deliberately records `_qboBalance` — the invoice
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

## 8.85 TERMS GATE — published Terms updated everywhere BEFORE the first 3-day notice ships

**PHASE 9 PRECONDITION, alongside §8.9.**

If a customer receives an invoice stating a 3-business-day billing-dispute window while the
published Terms say something else, and a dispute lands inside that window, **they have the better
argument.** The invoice is our assertion; the Terms are the contract they agreed to.

**The gate:** every published copy of a dispute or claim window carries the agreed wording BEFORE
the first invoice bearing the notice is sent. Not the same day — before.

**The copy that counts is one we cannot see.** Terms are also hosted at
`freightandlogistics.com/termsandconditions` (Wix, outside this repo). **That is the URL customers
are contractually pointed at.** It is changed by hand by the owner; nothing in this repository can
verify it, and no automated check will ever cover it. A green repo is not evidence that gate is met.

**Also blocking, and PRE-EXISTING:** the repo already publishes TWO different claims deadlines on
two different clocks (§8.86). Adding a third window on top of an unresolved contradiction makes the
contradiction worse, not merely longer.

## 8.855 The terms URL — OPEN, and not the URL that was assumed

**Correcting the premise before recording the item.** Verified scope, all 113 tracked files, four
patterns: **`termsandconditions` appears NOWHERE in this repo except this spec.** `portal.html` §3
is "Customer Responsibilities" and names no URL; `portal.html` renders the Terms **inline** from a
JS array via `openTermsPanel()`, entirely self-contained.

**The URL customers are actually pointed at is `https://www.freightandlogistics.ai/?terms=1`** — the
**.ai** domain, served by our own Cloudflare Pages from `index.html`. Three references, all in
`index.html`:

| Line | Context |
|---|---|
| 1324 | support form — "By submitting you agree to our Terms" |
| 1506 | credit application — the consent checkbox |
| **1710** | **the SIGNED agreement record** — "Terms and Conditions and Privacy Policy (https://www.freightandlogistics.ai/?terms=1), **incorporated into and made part of this agreement**" |

**So tearing down Wix breaks nothing this repo points at.** No repo-referenced terms link depends on
`freightandlogistics.com`.

**The real open item is different, and it does not close when Wix does.** Line 1710 embeds that URL
into **executed credit applications** as incorporated contract text. That means:

1. **`www.freightandlogistics.ai/?terms=1` must resolve permanently.** It is not a marketing link;
   it is cited inside signed agreements. Pages allowlists `/`, so `?terms=1` resolves today.
2. **The Terms shown there change over time, and nothing records which version a customer signed.**
   A customer who signed in March and disputes in December is pointed at whatever the page says
   then. There is no version stamp, no archive, and no way to reconstruct the text they agreed to.
   That is a records problem, not a link problem, and it is made sharper — not created — by editing
   the Terms.

**What cannot be verified from here:** Wix's own internal links, email signatures, printed invoices,
and anything historically sent to customers that may point at the `.com` terms page. A verified
scope over this repo says nothing about those.

## 8.856 BLOCKING PRECONDITION — Terms versioning, before any Terms edit

**This blocks the 3-business-day billing clause and every future Terms edit.** Editing first and
versioning after compounds the problem: the 3-day change would itself go in unversioned.

`index.html:1710` writes into every executed credit application: *"Terms and Conditions and Privacy
Policy (https://www.freightandlogistics.ai/?terms=1), **incorporated into and made part of this
agreement**"*. So editing the Terms silently repoints **every past signer's agreement** at text they
never saw.

### Shape of the fix — NOT BUILT, scoped only

1. **A version identifier and effective date rendered on the Terms page itself** — e.g.
   `v2026.1 · effective 2026-08-03`, visible to a reader, not a comment.
2. **Prior versions archived at stable URLs** — `?terms=1&v=2026.1` or similar — so a signed
   agreement can point at what was actually agreed rather than at "current".
3. **The version recorded on each credit application at signing time.** Today `rec.consents
   .termsAndConditions` is a **boolean** (`index.html:1710`) — it captures THAT they agreed, never
   WHAT they agreed to. A version string alongside it closes that going forward.

### What is and is not recoverable — checked, not assumed

| Copy | Recoverable? |
|---|---|
| `portal.html` Terms | **Partly.** Full git history exists from 2026-06-14; the claims clause has been touched by exactly ONE commit, `8c846a9` (2026-06-15). So the portal text has been unchanged since it was introduced, and any past date since then is reconstructible with `git show <commit>:portal.html`. |
| `index.html` Terms | **Partly.** Same picture — introduced `70c8e0c` (2026-06-15), one commit, unchanged since. History runs to 2026-06-09. |
| **Anything before 2026-06-09** | **LOST.** The repo's initial commit is 2026-06-09. Nothing earlier exists here. |
| **The Wix copy** | **LOST, entirely.** Never in the repo, no history, no snapshots. Whatever it said on any past date is unrecoverable from anything we control. |
| **Which version a given customer signed** | **NOT RECORDED, for anyone, ever.** The consent is a boolean. Even where the text is reconstructible by date, nothing ties a specific signer to a specific version — that requires cross-referencing their signing date against git history by hand, and only for the copies above. |

**The honest summary:** the *portal and landing* Terms happen to be reconstructible by date because
they have not changed since June. That is luck, not a mechanism — the first edit ends it unless
versioning lands first. The Wix copy and anything a customer signed against it are gone.

## 8.857 CLOSED 2026-08-04 — the cargo-claims window. Neither candidate won.

**DECIDED BY THE OWNER. This is no longer an open question.** Both candidates below are superseded;
they are kept only so the record shows what was replaced and why nothing may be published in the old
shape.

### THE DECISION — adopt the Worldwide Express structure

| Element | Rule |
|---|---|
| **Concealed damage** (not noted on the POD) | **5 days to report**, attributed to the carrier |
| **Filing deadline** | **9 months**, from **delivery** |
| **Filing deadline, non-delivery** | **9 months**, from **PICKUP** |
| **Our role** | We **file and pursue** any claim brought to us, and assist — but do **not warrant the outcome** |
| **Expected timing** | Carriers take **~30 days to acknowledge** and **~120 more to resolve** |

**Why it resolves the conflict:** the old candidates were a single bar doing two different jobs at
once. This separates them — a short **reporting** window for concealed damage, and a long **filing**
window for the claim itself — so a shipment delivered before its invoice issues no longer has two
clocks running in opposite order. The clock question disappears because the two windows measure
different events.

### WHAT THIS REPLACES — all four sites, none yet edited

| Site | Currently says | Becomes |
|---|---|---|
| `portal.html:8653` §6 | 10 business days from invoice | the structure above |
| `index.html:1930` §12 | 10 business days from invoice | the structure above |
| `KNOWLEDGE.md:82`, `:134`, `:245-247` | 48 hours from delivery, "binding", "always governs" | the structure above |

**The 48-hour framing is live in the deployed Worker** and the agent still asserts it. That does not
change until the KB is rebuilt (`node evals/build-worker-kb.js`) and the Worker redeployed.

### THE ONLY THING STILL IN FRONT OF PUBLISHING: A2

**A2 (Terms versioning) still lands first.** Not a preference — the reason is unchanged from §8.856:
`index.html:1710` writes the terms URL into executed credit applications as "incorporated into and
made part of this agreement", and `rec.consents.termsAndConditions` is a BOOLEAN recording only
*that* they agreed, never *what*. Publishing this decision into an unversioned Terms page silently
repoints every past signer at text they never saw. **A1 is closed; the publishing of A1 is blocked
by A2, and by nothing else.**

Order stands: **A2 → the Terms edit carrying this decision and the 3-business-day billing clause →
A3 → A4.**

### SUPERSEDED — the two candidates, kept for the record

**Blocks BOTH the KB edit and the Terms edit.** ~~The number is the owner's to decide; nothing is
changed until it is.~~ *(Decided 2026-08-04 — see above.)*

| Candidate | Window | Clock starts | Where it is published |
|---|---|---|---|
| **A** | 10 business days | **invoice date** | `portal.html:8653` §6, `index.html:1930` §12 — the CONTRACT |
| **B** | 48 hours | **delivery date** | `KNOWLEDGE.md:82`, `:134`, `:245`, `:247` — the AGENT, and the deployed Worker |

They differ in **length and in starting event**, so they cannot be reconciled by rounding — a
shipment delivered before its invoice issues has the two clocks running in opposite order.

**The agent is currently asserting the one that is NOT in the contract.** `KNOWLEDGE.md:245` states
B is *"our binding requirement"* and *"always governs"*. A customer told 48 hours who files on day 5
has been given a deadline the contract does not impose; a customer relying on the contract's 10
business days is being told by our own AI that they are late.

Same class as the stale fee KB — except this one is **contractual, not a price**.

Deliberately NOT bundled with the 3-business-day billing-dispute decision: different window,
different subject, and merging them would force one number to justify the other.

## 8.858 §5 HEADING — a RETRIEVAL defect, fix it whatever the number is

`KNOWLEDGE.md` §5 is titled **"Billing, adjustments, claims"** — one section covering three
subjects. That single heading is the mechanism by which a **billing** question retrieves a **claims**
deadline, and it will keep happening whatever window is chosen. It is a retrieval defect, not a
wording one.

**Proposed split — NOT APPLIED:**

| New section | Contents |
|---|---|
| **§5a Payment terms** | Net 15, late fees, the $50 reprocessing charge, accepted methods |
| **§5b Billing disputes** | The NEW 3-business-day window, what documentation is required, the consequence. Unambiguous home for the new clause. |
| **§5c Cargo claims** | The claims window (pending §8.857), the delivery-receipt rule, our role as agent, carrier liability |
| **§5d Adjustments** | Reweigh/reclass, storage fees — where "we dispute it with the carrier on your behalf" belongs, since that is US acting FOR the customer, the opposite direction from a customer disputing US |

§5d matters more than it looks: `KNOWLEDGE.md:131` and `:161` currently describe us disputing a
**carrier** on the customer's behalf, and they live in the same neighbourhood as the customer
disputing **us**. Two opposite directions under one heading is the same defect one level down.

## 8.859 The `.ai` apex change, and the zone-deprovision reference

**What is actually happening (2026-08-03): the apex is being pointed at Porkbun so
`freightandlogistics.ai` redirects to `www.freightandlogistics.ai`. Nothing is being
deprovisioned.** Wix continues to serve and continues to hold DNS.

**What the apex change fixes, once live:**

1. **`freightandlogistics.ai/?terms=1` starts resolving.** Today the apex has **no A record** —
   only `www` resolves — so the bare-domain form fails. This matters because executed credit
   applications cite the terms URL as incorporated contract text (`index.html:1710`), and any that
   cite the **apex** form rather than the `www` form currently point at nothing.
2. **Anyone typing or linking the bare domain lands somewhere** instead of nowhere.

### Reference only — what WOULD break if the zone were ever deprovisioned

**Not a live risk. Recorded for the real Cloudflare nameserver migration, whenever that happens.**

Both domains are on Wix DNS — `ns0.wixdns.net` / `ns1.wixdns.net`, SOA `support.wix.com` on each.
That includes **`.ai`**, which is easy to miss when the mental model is "the Wix site is the .com".

| | Would break | Depends on |
|---|---|---|
| 1 | `www.freightandlogistics.ai` → CNAME → `freight-portal.pages.dev` — the portal and landing site | Wix **DNS**, not Wix hosting |
| 2 | MX for **both** zones → Google Workspace — all email | Wix DNS |
| 3 | `www.freightandlogistics.ai/?terms=1` — the URL inside executed credit applications | Wix DNS |
| 4 | SendGrid sending — SPF/DKIM TXT live in that zone | Wix DNS |

**ZONE-EXPORT WARNING — carry this into the migration.** Export the complete zone for **both**
domains before any cutover: **five MX records**, plus **SPF and DKIM TXT for both SendGrid and
Google**. Anything not copied before the cutover is **lost silently** — the failure mode is mail
quietly not delivering, which nobody notices until a customer says they never received something.

## 8.86 LIVE DEFECT — two conflicting claims deadlines, already published

Found 2026-08-03 while inventorying dispute windows. **Reported, not fixed** — out of scope for the
invoice-sync build.

| Source | Text | Window | Clock |
|---|---|---|---|
| `portal.html:8653` Terms §6 | "Claims must be filed in writing within **10 business days of invoice**" | 10 business days | invoice date |
| `index.html:1930` Terms §12 | same | 10 business days | invoice date |
| `KNOWLEDGE.md:82` §5 | "written claim is filed **within 48 hours of delivery**" | 48 hours | delivery date |
| `KNOWLEDGE.md:134` FAQ | "written claims must be filed within 48 hours of delivery" | 48 hours | delivery date |

**Different length AND different starting event.** `KNOWLEDGE.md:245` goes further and instructs the
agent that the 48-hour rule is "our binding requirement" and "the operative deadline" — so **the
agent tells customers 48 hours from delivery while the published Terms say 10 business days from
invoice.** Which is binding is not decidable from our own material.

This is the anti-fabrication rule failing from the inside: the KB is the agent's source of truth,
and here the KB contradicts the contract.

## 8.861 B4 — CORRECTED 2026-08-03. The original section was wrong twice over

**The original §8.861 asserted a live, customer-facing tracking outage. There was no outage.** It
also recorded a customer-visible error message that no customer has ever seen. Both claims were
produced by reading `track-proxy.js` and reasoning forward from a dead DNS record, without checking
either of the two things that would have falsified them: whether any code still calls that Worker,
and what the Worker actually returns when you ask it.

**The lesson, which is the reason this section is being rewritten instead of deleted: a dead
dependency is not an outage until something depends on it.** Establishing "this host is gone" is
half a finding. The other half is "and here is the live path that reaches it" — and that half was
skipped, so a retired code path was filed as a customer-facing emergency.

### What was claimed vs. what is true

| Original claim | Verified reality |
|---|---|
| "Tracking is broken now… **Customer-facing.**" | **No customer path has reached `track-proxy` since `817640f` (2026-07-30).** Tracking works today |
| Customer sees "Tracking is temporarily unavailable." (HTTP 502) | **That branch has never fired.** The live Worker returns **HTTP 404 "No shipment found for that number."** |

The one true fact in the original: `portal.freightandlogistics.com` is **NXDOMAIN** — re-verified on
the default resolver, `8.8.8.8`, and `1.1.1.1`, with `www.freightandlogistics.com` and
`shipprimus.com` resolving as positive controls, and `curl` exiting 6. The host is genuinely gone.

### What is actually in production

Both live tracking surfaces call **`fl-tracking`**, and both work — verified live, not inferred:

| Surface | Constant | Route | Live result |
|---|---|---|---|
| Landing chat (`index.html:928`) | `index.html:818` | `?q=` public | `200 ok:true` — ABF Freight, in transit, full timeline |
| ~~portal.html chat widget~~ | ~~`portal.html:1464`~~ | `?bol=` portal | `200 found:true` when called by hand — **but nothing calls it; see the third correction below, and D7** |

Negative control: `?q=ZZZ99999` → `200 ok:false found:false`. The logged-in portal's "Track
Shipment" (`portal.html:1023` → `:22559`, post-D7 lines) is not a Worker consumer at all — it reads
status from **Primus booking data** (`fetchBookingByBOL`, the `trackInline` card at `:16728`).

**Verified-scope method for "nothing calls track-proxy"**: all 115 tracked files enumerated; every
`http(s)` URL literal extracted from all 94 non-PNG files and grouped —
`track-proxy.felipe-b80.workers.dev` appears **0 times**; literal grep for
`track-proxy|trackShipment` across all tracked files → 5 hits, all comments/config/this spec, none a
fetch target; `git log -S` across **all** branches → the only client reference was `index.html`,
added `83d275a` (2026-07-08) and removed `817640f` (2026-07-30). **Limit:** Cloudflare routes and
custom domains live in the dashboard, not the repo (`fl-tracking/wrangler.toml:1` says its own
config was reconstructed from deployed settings), so a dashboard route or a non-repo consumer would
be invisible here. Closing it is an owner check: Workers → track-proxy → Domains & Routes, plus the
request-count graph.

### The real defect this was hiding, and it was never the 502

`track-proxy` returns **404 "No shipment found for that number."** for a real, in-transit BOL —
byte-identical to what it returns for `ZZZ99999`. The 404 proves the `catch` at `:56` never fires:
a response came back, so the failure lands at `:63` (JSON.parse fails) or `:67` (no `Result.BOL`),
both of which return that same string. So the defect was never "permanent condition described as
temporary." It was **a system fault presenting as the customer's bad number** — see §8.863.

`b6ea763` established this on 2026-07-30 with these same two BOLs. The original §8.861, written
2026-08-03, contradicted a finding already in the repo's own history.

### Blast radius, bounded

`track-proxy` was created **2026-07-09T03:01:59Z** and redeployed once at **03:06:32Z** — two
deploys, one evening, never touched since (`wrangler deployments list`). The landing page called it
from `83d275a` (2026-07-08) until `817640f` (2026-07-30). **Maximum customer exposure ~22 days,
landing page only, and it ended four days before it was filed as live.** Whether the host was alive
on 2026-07-08 is **not establishable from this repo** — dating the DNS removal needs an external
DNS-history service. `portal.html` never pointed at `track-proxy`; `TRACK_API` has read `fl-tracking`
since its first commit (`1414366`, 2026-06-14).

### The live defect that was actually here — FIXED

Found while verifying the above. `fl-tracking`'s **`?bol=` route returned HTTP 200 on upstream
failure** (`worker.js:96` — the `json()` helper defaults `status = 200`), while the `?q=` route
correctly returns 503. `portal.html:1573` (pre-D7; since deleted) tested `if(!resp.ok) throw 0`,
which never fires on a 200, so control reached `:1575` `d.found===false` and rendered **"No status found for #X yet.
Double-check the number"** — our outage, rendered as the customer's typo. The client never reads
`d.error`.

`b6ea763`'s commit message asserts "step 3's 503 will route upstream failures to `!resp.ok` →
catch." That 503 was only ever added to the public route. The portal route kept the defect for
another four days, in the same file, under a header comment that said its behavior was correct and
"must stay that way."

**Fixed Worker-side, not client-side.** At the time of the fix the reasoning was that both surfaces
would inherit it and `portal.html:1573` would start working as already written — that consumer has
since been deleted (D7), which **strengthens** rather than weakens the choice: a client-side patch
would have been deleted along with the client, leaving the Worker still returning 200 for a failure
and handing the same lie to the next consumer. Verified with negative controls in both
directions against the real Worker module and the real client conditions: upstream throws / HTTP 500
/ non-JSON body → **503**, client renders the outage copy; genuine not-found (no `Result`, or empty
timeline) → **200 `found:false`**, client still renders "double-check the number"; healthy lookup →
unchanged. The same harness run against the pre-fix Worker fails exactly the first three and passes
the last three, so the controls discriminate rather than merely agreeing.

The second direction is the one that matters: widening the 503 to cover genuine not-founds would
invert the same defect — telling a customer with a mistyped BOL that our system is down, so they
wait for a fix that will never come.

### THIRD CORRECTION — `?bol=` has NO live consumer. The fix is latent-correctness

Written after the fix, before it shipped, and it corrects this section a third time in one evening.

**`?bol=`'s only consumer is dead code that has never executed.** Its sole caller was `TRACK_API` in
the `#public-view` widget inside `portal.html`, and that widget's entire script never ran: the
`srcdoc` attribute terminated at the first literal `"` (`portal.html:1458` **as of `fa3f0a0`**,
`const TRUCK_IMG = "`), so the iframe start tag closed at `:1498` and everything after — ~400 lines
including all the tracking code — became inert raw text inside the `<iframe>` element. **All line
numbers in this paragraph are pre-D7; the block has since been deleted** (`portal.html:997-1865`).

Confirmed three ways: **parse5** (spec-compliant) on the local file; **production bytes**, which are
byte-identical to local by SHA-256; and **Chrome on the live site**, where `fetchTrack`, `sendMsg`,
`expandChat`, `looksLikeTracking` and `TRACK_API` are all `undefined` in the frame and inline
handlers throw `ReferenceError`.

**Method note — why "never worked" is stated instead of "probably never worked."** `git log -S`
tells you when a *string* moved; it cannot tell you whether the surrounding markup parsed. So **all
619 historical versions of `portal.html` were parsed with parse5** and each one's `srcdoc` checked
for the widget script. **Every single version is truncated; not one ever contained it.** It arrived
broken in `1414366` (2026-06-14) — the iframe, `TRUCK_IMG`, and `fetchTrack` in one commit, with
`TRUCK_IMG`'s literal quote 108 lines above the tracking code. That is 50 days, and it is a
measurement rather than an inference. **Prefer parsing every version over trusting `git log -S`
whenever the question is "did this ever work" rather than "when did this text change."**

Consequences:

- **The `?bol=` 503 fix above is correct but LATENT.** It repairs no customer-visible behaviour
  today. It is kept because it costs nothing, makes the two routes consistent, and means the route
  is already right when the widget question is settled. **It is explicitly not a customer-facing
  repair, and it does not ship on its own urgency.**
- **The only live tracking surface is the landing page (`?q=`)**, which already returned 503. The
  logged-in portal reads status from Primus booking data and calls no Worker.
- The severity error here is recorded as the second instance of the reviewer-facing cousin in
  §8.863: characterising `?bol=` as a live customer path was reasoning from code to impact without
  checking that anything reaches it — the identical mistake this section was created to correct.

### Status

- `track-proxy` is **superseded dead code that is still deployed**. No consumers, no repo
  references, fully replaced by `fl-tracking` (whose `?q=` route is a strict superset: same field
  names plus `searched[]`, a *bound* rate-limit namespace — track-proxy's `env.RL` was never bound
  — NOTE filtering, and observability). **Retirement is cleanup, queued as D6, deliberately not part
  of this change.**
- Do **not** repoint `track-proxy`. The working upstream is already in production:
  `shipprimus.com/tracking.php?format=json&customer=…&trackingNumber=…` (`fl-tracking/worker.js:35`),
  verified live returning real shipment data.
- What `portal.freightandlogistics.com/trackShipment.php` originally was is **not established**. The
  PHP naming matches the Primus family (`tracking.php`, and the `t.php` link `b6ea763` removed),
  suggesting a white-labeled Primus host — that is provenance, not an endpoint claim, and nothing
  should be built on it.
- **The `#public-view` widget is dead and is being deleted** — see the third correction above. Found
  in passing while verifying this section, then run to ground: it has never executed in 619 versions
  over 50 days. Owner decision 2026-08-03: delete it and point logged-out `/portal` at the landing
  chat rather than repair ~400 lines of JS inside an HTML attribute. Queued as **D7**.

## 8.862 B5 — demo-session works TODAY; the earlier concern was wrong

Checked 2026-08-03 because a prior audit was reportedly fooled by a 200 that was really a redirect
to the Wix homepage.

**It is not a redirect.** `https://www.freightandlogistics.com/demo-session` returns **HTTP 200 with
no redirect** (`redirect_url` empty), and the page title is
`Freight and Logistics, Inc. | Free Demo | Pico Rivera California` — distinct from the root title
`… | 3PL Freight Broker | Los Angeles California`. Two different pages, so the 200 is genuine.

**It can also still be framed:** no `X-Frame-Options` and no `Content-Security-Policy`
`frame-ancestors` header on the response, so the `portal.html:1203` iframe is not blocked.

So B5 is **not** a current defect. It is recorded only as a remaining `.com` **content**
dependency in the repo — which would break if Wix hosting ever stopped, but is fine today.

**UPDATED 2026-08-04 — one of the three is gone.** The list was `portal.html:1504` (the `[[TALK]]`
handler), `:2074` (iframe), `:2076` (fallback link). The `[[TALK]]` handler lived **inside the
`#public-view` widget**, so deleting that widget (D7, commit `3978ecf`) removed it — not as the
point of the change, but as a side effect worth recording rather than letting it vanish inside an
882-line deletion.

**Two remain**, both in the meeting panel and both re-anchored this sweep:

| Line | Anchor | What it is |
|---|---|---|
| `portal.html:1203` | `<iframe src="https://www.freightandlogistics.com/demo-session"` | the embedded booking iframe |
| `portal.html:1205` | `<a class="talk-open" href="https://www.freightandlogistics.com/demo-session"` | the fallback link |

Verified by `grep -n "freightandlogistics\.com" portal.html` returning exactly these two.

## 8.863 DEFECT CLASS — misattributing a system fault to the customer

**Named 2026-08-03, on the third instance.** This is a subclass of silent failure, and it is worse
than the generic form.

A generic silent failure loses information: something broke and nobody was told. **This class
manufactures false information and aims it at the customer.** The system takes its own fault and
renders it as a defect in the customer's input or understanding. The customer is then sent to fix
something that was never broken — re-typing a correct BOL, re-checking a dispatch that never
happened — while the actual fault stays unreported and unfixed.

**Why it is more expensive than it looks.** The resulting support contacts arrive pre-labeled as
user error: "customer can't type their BOL", "customer confused about dispatch." That is the exact
shape of a metric that looks like a training or UX problem, so the real defect is not merely
invisible — it is actively disguised as something else, and the disguise survives triage.

### The three instances

| # | Instance | System fault | What the customer was told |
|---|---|---|---|
| 1 | A "Dispatched" checkpoint on freight nobody tendered (**§8.864**) | A saved shipment's **requested pickup date** lights the checkpoint — **not** a failed tender, which is what this instance was believed to be until 2026-08-04 | "Dispatched ✅" on a shipment still showing Saved / Ready to Dispatch |
| 2 | `track-proxy` 404 (§8.861) | Upstream host is NXDOMAIN | "No shipment found for that number" — double-check a correct BOL |
| 3 | `fl-tracking` `?bol=` 200 on upstream error (§8.861) | Primus tracking unreachable | "No status found… **Double-check the number**" — same, on the live Worker |

Instance 1 is written up in **§8.864**. Its cause is **confirmed for the 2026-08-02 observation and
for that observation only** — and it turned out not to be a failed tender at all. Whether an earlier
occurrence exists is **unestablished**, and §8.864 records the rule that C may not absorb one
retroactively: anything predating 2026-07-28 cannot share C's cause, because the code did not exist.
Instances 2 and 3 are the same misattribution at two layers, four
days apart, and instance 3
survived inside the very file whose commit message (`b6ea763`) claimed to have eliminated the
conflation. That is the argument for naming the class rather than fixing instances one at a time:
the fix does not generalize on its own, even for the person holding it.

### The rule

**Any error path whose cause could be either the system or the customer's input MUST distinguish
between them before rendering, and MUST NEVER default to blaming the input.**

Concretely:

1. **The distinction must survive every hop.** A Worker that collapses "upstream down" and "not
   found" into one status code has destroyed the information before the client can act on it —
   which is exactly how instance 3 happened. Carry the difference in the status code, not only in a
   body field a consumer may ignore.
2. **Fix it at the layer that owns the truth.** The producer of the error knows which it was; the
   consumer is guessing. Patch the Worker, not the client, or the next consumer inherits the lie.
3. **When cause is genuinely unknown, blame the system.** "Something went wrong on our end" is
   recoverable if wrong. "Check your number" is not — it costs the customer real effort and teaches
   them to distrust their own correct input.
4. **Do not invert it.** Widening a system-fault message to cover genuine customer errors is the
   same defect running the other way: it tells someone with a real typo to wait for a fix that will
   never come. Both directions need a negative control.
5. **Test it in both directions.** A control that passes before and after the fix proves nothing.
   Assert the system-fault case renders as our fault AND the customer-error case still renders as
   theirs, and confirm the pre-fix code fails the first while passing the second.

**When reviewing any error branch, the question is not "does this handle the error" but "whose fault
does this claim it is, and does the code actually know that?"**

### The reviewer-facing cousin — misattributing severity to ourselves

The same mistake, aimed inward. **Reasoning from code structure to real-world impact without
measuring whether any live path reaches the code.** Reading the code tells you what would happen
*if it ran*. It does not tell you that it runs.

It happened **twice in one evening**, 2026-08-03:

1. **`track-proxy`'s "outage."** A dead upstream host was filed as a live customer-facing emergency
   (§8.861). Nothing had called that Worker in four days. The severity was inferred from the code,
   never from a caller.
2. **The `?bol=` fix.** Having just corrected the first one, the same session characterised the
   `?bol=` 503 as repairing a live customer path — and then found that `?bol=`'s only consumer is a
   widget whose script **has never executed once in 50 days**. The fix is correct; the severity
   claim was not.

The second is the more instructive: it was made by someone who had just written the rule, in the
same session, about the same subsystem. Knowing the failure mode does not confer immunity from it.

**Third instance, and the most expensive — CORRELATING A SYMPTOM WITH THE MOST ALARMING NEARBY
EVENT** (§8.864, 2026-08-04). A green "Dispatched" checkpoint was seen on BOL 160135857 in the same
session as three carrier rejections of that BOL's tender. The two were connected, and the resulting
theory — *a failed dispatch is rendering as success* — was carried as the highest-severity open
item **for about two months**.

It was wrong. The checkpoint was green **before any dispatch was attempted**, because a saved
shipment's requested pickup date lights it. The rejections and the checkmark were unrelated events
that arrived together.

**What made this expensive is precisely that the wrong theory was the scarier one.** "Dispatch
failures render as success" implies freight nobody tendered, carriers never notified, and a
structural problem in the write path — so it earned top priority, blocked customer exposure, and
shaped two months of thinking. The true cause is a display defect in a resolver, is worse in
*reach* (every saved shipment, continuously, not one incident) and far smaller in *kind*.

**The rule: when a symptom and an alarming event coincide, the coincidence is a hypothesis, not a
finding.** Concretely:

- **Establish the symptom's cause independently of the alarming event.** Here, one question would
  have collapsed it in a minute: *does this checkpoint appear on a shipment that was never
  dispatched at all?* That test needs no incident, no BOL, and no risk.
- **Test the boring explanation first.** It is usually cheaper to test, and being wrong about it
  costs nothing.
- **Severity is not evidence.** A theory does not become more likely because its consequences are
  worse; alarm is a reason to verify sooner, never a reason to verify less.
- **Date the mechanism against the observation.** The resolver that causes this was written
  2026-07-28 and could not have caused anything before it existed — a check that would have broken
  the two-month framing immediately.

**The rule: before characterising a defect's severity, establish that a live path reaches it.**

- "This code is wrong" and "customers are hit by this" are two claims. The second needs its own
  evidence: a caller, a request count, a log line, a reproduction.
- **Reachability is falsifiable — go falsify it.** Grep for callers across the whole tree, check
  whether the consumer executes, probe the deployed endpoint, look at traffic.
- When reachability cannot be established, say so and label the finding **latent** rather than
  guessing in either direction. A latent defect is still worth fixing; it is not worth an emergency.
- Severity language is a claim about the world, not about the code. Spend it accordingly.

## 8.864 LIVE DEFECT — every saved shipment shows a completed "Dispatched" checkpoint

**CONFIRMED by direct observation 2026-08-04. Cause identified. UNFIXED and deliberately PARKED —
this is a portal tracking defect with no relationship to the invoice sync.**

### CONFIRMED — direct observation, BOL 160135909

Created and saved by the owner, never dispatched, observed minutes later:

| Surface | Reads |
|---|---|
| My Shipments list | **Saved** |
| Modal status header | **SHIPMENT CREATED** |
| PRO# | **none** |
| Action button | **Ready to Dispatch** |
| Timeline | Booked ✅ · **DISPATCHED ✅ dated 08/04/26** · Picked Up ○ · In Transit ○ · Delivered ○ |

**The same screen contradicts itself four ways at once** — "SHIPMENT CREATED", no PRO, a
Ready-to-Dispatch button offering an action already shown as complete, and a green Dispatched
checkpoint. **The customer reads the timeline, not the button.**

### The mechanism

`resolveShipmentProgress` (`portal.html:7622`):

```js
dispatchDate = ti.dispatchDate || s.estimatedPickupDate                   // :7631
disp         = s.dispatched === true || !!dispatchDate || stDispatched    // :7650
```

`estimatedPickupDate` is a **booking-time** field — the pickup date the customer requested, written
into the booking payload at save (`:19264`) and read as the estimated pickup date everywhere else
(`:5219`, `:5308`, `:6931`, `:7183`, `:11956`, `:14457`). Any saved shipment carrying one lights the
checkpoint. `dates.dispatched` (`:7665`) is the same variable, so **the date displayed beside the
green check is the requested pickup date presented as a dispatch date** — which is what 08/04/26 was.

Both renderers (`:8051`, `:11987`) are fed by this one resolver (`:7706`, `:11977`), so neither is
independently at fault and both show it.

### Introduced 2026-07-28 by `e3b5d65` — and the code it replaced was CORRECT

The prior implementation kept the estimate out of the state term and used it only for display:

```js
// BEFORE (modal):  done: detail.dispatched || !!ti2.dispatchDate
//                  date: ti2.dispatchDate || detail.estimatedPickupDate
// BEFORE (card):   done: !!(s.dispatched || ti.dispatchDate)
```

`done` excluded `estimatedPickupDate`; only the *displayed date* fell back to it. **The refactor
that unified the header and the timeline onto one resolver collapsed those two into a single
`dispatchDate` variable and used it for both the date and the state.** A deliberate separation was
lost in a change whose purpose was consolidation — the consolidation was right, the merge of a
display fallback into a state term was not.

**Dating consequence, and it matters: the mechanism is 7 days old (2026-07-28 → 2026-08-04) and
CANNOT explain any observation predating 2026-07-28.**

### The original incident was MISDIAGNOSED

BOL 160135857 was never "a rejected tender rendered as success." **The checkpoint was green before
anyone attempted to dispatch it.** The three carrier rejections and the green checkmark were
unrelated events that appeared together and were connected on that basis. The defect predates the
dispatch attempt and has nothing to do with tender outcome.

### SCOPE OF THE CLOSURE — deliberately partial, confirmed with the owner 2026-08-04

**What is established:** the 2026-08-02 observation on BOL 160135857 has a confirmed cause
(Candidate C), reproduced directly on BOL 160135909.

**What is NOT established:** whether any earlier occurrence exists. The theory was carried for about
two months; the mechanism has existed since 2026-07-28. The owner's position, recorded verbatim in
substance: *no specific memory of a dispatch reported as successful before that date, and no ability
to rule one out* — the account of 160135857 came from memory, and that account was already wrong
once about what it demonstrated.

**The rule this creates: C MUST NOT ABSORB ANY EARLIER OCCURRENCE RETROACTIVELY.** If one surfaces:

- It **cannot** share C's cause if it predates **2026-07-28**, because the code did not exist. This
  is a hard boundary, not a judgement call — `e3b5d65` is the commit.
- It must be investigated on its own evidence, starting from the surviving candidates (A, the
  `_lastBooked` short-circuit at `:6230`, is the one with a real mechanism and no evidence of ever
  firing) rather than assumed to be another sighting of C.
- "We already found that one" is exactly the move that produced the two-month misdiagnosis in the
  first place — a symptom matched to a nearby explanation instead of to its own cause (§8.863).

**Instance 1 therefore reads: cause confirmed for one observation, class open.** It is not a
closed item, and it should not be marked closed by anyone tidying this list later.

### Candidates A and B are NOT the cause

- **A — the `_lastBooked.dispatched` short-circuit (`:6230`).** Not the cause: C fires with no
  dispatch attempt at all, and A cannot fire until a dispatch has already succeeded (every
  `_lastBooked` writer initialises `dispatched:false`; only `:6339` sets it true). **A remains a
  real mechanism for a DIFFERENT symptom** — a success returned with no network call — and there is
  no evidence it has ever fired. Not closed, not urgent, not this defect.
- **B — optimistic UI paint (`:7284`, `:5926`).** Not the cause. Local button/header state only.

### Blast radius — a standing misrepresentation, not an incident

Measured read-only against the live book (Haynes, 180-day window, the page's own predicates):

| | |
|---|---|
| Records returned | 65 |
| Carrying `estimatedPickupDate` | **65 / 65 (100%)** |
| Drawing a green Dispatched checkpoint | 65 |
| Never dispatched (`isShipmentDispatched()` false) | 1 |
| **Mislit — green checkpoint, never dispatched** | **1, and it was lit ONLY by `estimatedPickupDate`** |

**The rate is what generalises, not the count.** Every record sampled carries a pickup date, so
**every saved-not-yet-dispatched shipment is mislit** — the mislit population *is* the
saved-not-yet-dispatched population. Haynes badly under-samples it: they book by email and do not
use the portal's two-step Save-then-Dispatch flow, so only one such shipment existed. Accounts that
do use the portal are where the population lives, and the two-step flow guarantees one exists
continuously.

**To count it properly** requires a query across all customers — master-console access or an
all-accounts token — counting records where `isShipmentDispatched()` is false and
`estimatedPickupDate` is set. Not obtainable from a single customer's bearer token, which is why
only the rate is stated here.

### The fix — SHAPE ONLY, not scoped, not written

**An EXPECTED date must not drive a checkpoint meaning OCCURRED.** Deleting the fallback outright
may blank a marker that is legitimately useful, so the likely shape is separating the two: a
requested pickup date renders as a **scheduled** marker, and only a tender outcome renders as a
**completed** checkpoint.

**Required before proposing anything** — every downstream reader of `dispatchDate` and `disp`:

| Reader | Site | Consumes |
|---|---|---|
| `disp` → `reached` → `stages.dispatched` | `:7650`, `:7657`, `:7662` | lights the checkpoint |
| `dates.dispatched` | `:7665` | the date shown beside it — same variable |
| `statusLabel` / `displayStatus` | `:7670-7671` | the header status string |
| Shipment modal timeline | `:8048-8051` (via `:7706`) | `_st.dispatched`, `_dt.dispatched` |
| Modal header status | `:7757` | `_progress.displayStatus` |
| Chat/inline tracking card | `:11984-11987` (via `:11977`) | `_st.dispatched`, `_dt.dispatched` |
| — | `:11979` | `_prog.stages.delivered` (unaffected) |

**Open decision for the owner:** does a distinct scheduled-pickup marker belong on the timeline, or
should `Dispatched` simply require a real tender outcome with `estimatedPickupDate` rendering
nowhere on it?

**Does the same pattern appear elsewhere in the timeline logic? No.** Within the resolver, dispatch
is the **only** stage whose date input includes an estimate — `pickupDate` (`:7629`) and
`deliveryDate` (`:7630`) read `*Actual` fields exclusively, and `transit` derives from those. Two
other sites blend estimated into actual (`:7183`, `:11956`) but both are **display-only** fields
that drive no state; they lose the requested-vs-actual distinction, which is a lesser and separate
issue.

### WORKED EXAMPLE — the procedure nearly defeated itself

The superseded discriminating test told the reader to check `dispatched`, `dispatchDate`, `status`
and a PRO, and to conclude the stored-state hypothesis was **dead** if all were falsy. **`:7631` ORs
in `estimatedPickupDate`, which that list never named.** A reader following it on a cancelled record
would have seen `dispatchDate: null`, declared the hypothesis dead, and gone hunting Candidate A —
the short-circuit that cannot be reached without tendering real freight first.

**The procedure would have produced exactly the wrong verdict, and sent someone toward the one test
that puts freight on a truck.** The discriminator was *assumed* from a field name rather than traced
through the code that consumes it. That is the whole argument for §0.26's anchors and for §8.863's
rule that reachability and mechanism are traced, never inferred — applied here to a procedure
written in this document, two sections above the rule that would have caught it.


## 8.865 HARD API CONSTRAINTS on `/invoice` — phase 9 planning must respect these

Established 2026-08-04 by direct probing with the real `PrimusClient` (same auth, same GET-only
allowlist, same retry). Every claim below reproduced at least twice, paced, to separate real
constraints from rate-limiting.

### 1. VISIBILITY DOES NOT DEPEND ON SENDING — the architecture concern is RESOLVED

**This was the question that could have killed the design**, so it was answered by controlled
experiment rather than reasoning: two invoices on the same account, comparable in every other way,
one SENT from Primus and one never sent.

| | #141604 | #141385 |
|---|---|---|
| Issued | 2026-07-13 | 2026-07-09 |
| Primus "Sent" light | **green (sent)** | **red (never sent)** |
| **Present in `GET /invoice`?** | **YES** | **YES** |
| `status.sent` | `true` | `false` |
| every other status field | identical | identical |

Both status objects are `estimatedCosts/actualCosts/costActualClosed/charges/readyToInvoice/generated
= true, paid = false`. **The two records differ in exactly one field: `sent`.**

Across the window, **91 of 5,401 invoices carry `status.sent === false`** and are returned normally.

**So not-sending in Primus does NOT make an invoice invisible to the sync.** The plan — stop sending
from Primus, let Stripe be the only delivery — does not blind the poll. The requirements are not
mutually exclusive.

**`status` carries `readyToInvoice`, `generated` and `sent` as three independent booleans.** The poll
keys on `generated` (`invoices.js:110`), which is orthogonal to `sent`. `readyToInvoice` was `true`
on 100% of records sampled, so it is not a useful discriminator; `generated` is the right key and
needs no change.

### 2. A POISONED DATE — any window containing 2026-04-29 returns HTTP 500

Isolated by holding `issuedTo` fixed and walking `issuedFrom`:

```
issuedFrom 2026-04-27  OK        issuedFrom 2026-04-30  OK
issuedFrom 2026-04-28  OK        issuedFrom 2026-05-01  OK
issuedFrom 2026-04-29  FAIL 500  ← reproduced 4×, across two different issuedTo values
```

One date poisons every window that spans it. It explains the earlier failures of the 365-day scan,
the 120-day window, and a 60-day historical chunk — all of which contained it.

**Why this is dangerous rather than merely annoying:** it surfaces as **HTTP 500**, which
`PrimusClient._sendWithRetry` treats as transient — three retries with backoff, then throw. A poll
window spanning that date therefore fails on **every run, forever**, while looking exactly like an
upstream blip. That is §8.863's class in the infrastructure: **a permanent condition wearing a
transient's clothes.**

The pilot never hit it by luck alone: the 60-day claims window starts 2026-06-05, six weeks later.

### 3. A HISTORY FLOOR — nothing before ~2026-03 is retrievable

`2026-01-01..2026-02-28` and every 2025 window tested return HTTP 500, deterministically, twice
each. `2026-03-01..2026-04-28` returns page 1 but **500s on page 2**, so even the boundary region is
only partly readable.

Deepest successful read: **5,603 invoices spanning 2026-03-02 → 2026-08-03**.

**Consequence: backfill and historical reconciliation beyond roughly five months are impossible
through this endpoint.** Any phase 9 plan that assumes it can re-derive history — to reconcile
ledger gaps, to re-render a disputed invoice, or to prove what was billed — must not assume this
endpoint can supply it.

### 4. THE AR CODE IS RESOLVED LIVE, NOT FROZEN AT ISSUE — and that cuts both ways

**Demonstrated 2026-08-04 by accident, which is the only reason it is known.** The owner changed the
account's AR Code field; invoices issued **9 and 13 July** — weeks earlier — immediately reported the
new value on `GET /invoice`. Observed across three states of the same two invoices:

| AR Code field set to | List `ARCode` returned for #141604 / #141385 |
|---|---|
| `12345678` (original) | `12345678` |
| `12134` (mistyped) | `12134` |
| `1234` (corrected) | `1234` |

**The good half.** There is no migration hazard of the kind feared: renumbering an account
propagates to its existing open invoices rather than orphaning them. A backfill does not have to be
run before a code change, and historical invoices do not need rewriting.

**The bad half, and it is worse than the good half is good.** The AR Code is a **live join key, not
historical data**. One mistyped character silently re-labels **every open invoice on the account at
once** — no error, no warning, no signal anywhere. During this session `12134` was live across both
invoices and would have been live across hundreds on a real account. Nothing in Primus, the Worker,
or QBO objected; the only reason it surfaced is that a scan happened to be run immediately after.

Consequences that phase 9 must respect:

- **An invoice's ARCode is not evidence of anything historical.** It reports the customer record's
  code *as of the read*, not as of issue. A ledger row recording the claimed ARCode is therefore a
  snapshot that can silently disagree with a later read of the same invoice.
- **A typo is indistinguishable from a legitimate renumber** from the outside. Both look like "the
  code changed."
- **The blast radius is the whole account, instantly.** This is the argument for the allowlist
  failing closed and for `checkArCode`'s near-miss detection — but neither catches a typo that
  lands on a *different valid-looking* code, as `12134` did.
- **Worth considering before live mode:** an alert when the set of ARCodes seen in a poll differs
  from the previous run. That is a detection mechanism, not built, and recorded here as a candidate
  rather than a decision.

### 5. Operational notes

- Windows **ending today** succeed up to at least 90 days; the 120-day failure was the poisoned date,
  not length. Length itself was never shown to be the limit.
- Transient `fetch failed` errors occur under sustained paging and are distinguishable from the
  deterministic 500s only by retrying — a scan without per-page retry **silently under-covers**, which
  is how a partial scan nearly supported a false absence claim during this investigation.
- **Any absence claim from this endpoint must state its page-failure count.** Coverage is not
  complete merely because the loop finished.


## 8.866 How to pull and verify a deployed Worker bundle — METHOD

Established 2026-08-04 on `invoice-sync`, deliberately while the answer was expected to be boring.
**"Deployed code equals committed code" is an inference, and it is wrong for this Worker today
(§8.868).** Anything claimed about what is live needs this procedure, not a git log.

**1. Pull the deployed script.**

```
TOK=$(grep -m1 '^oauth_token' ~/Library/Preferences/.wrangler/config/default.toml | sed 's/.*= *"//; s/"$//')
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.cloudflare.com/client/v4/accounts/b800adf3aeb0eb8ecbf33032450a24a2/workers/scripts/<name>" \
  -o deployed.raw
```

Use the **base** `/scripts/<name>` path. The `/content` sub-path returns error 10405 for an OAuth
token. The response is **multipart**; the script is the `name="index.js"` part, and it is
esbuild-bundled — comments survive, but formatting and identifier printing do not.

**2. Re-bundle the candidate commit and diff.** Export it without disturbing the working tree:

```
git archive <commit> invoice-sync | tar -x -C <scratch>
cd <scratch>/invoice-sync && wrangler deploy --dry-run --outdir=<out>    # --dry-run does NOT upload
```

Then normalise (strip `sourceMappingURL`, trailing whitespace, blank lines) and `diff`. Only
cosmetic esbuild-printing differences should remain. **Count the `<` and `>` lines separately** — a
one-directional diff means one side is a strict superset, which is what identifies a partial build.

**3. Read the result as a fact, not a formality.** On `invoice-sync` this produced 24 lines present
only in the deployed script and 181 present only in the re-bundled candidate, which is how the
finding in §8.868 surfaced.

**Deploy verification, going forward:** a deploy names a commit; the tree is clean at that commit;
the deployed bundle is pulled and diffed against a re-bundle of it. See §8.868 for why.

> **⚠ IF THIS PROCEDURE LEADS YOU TO `sqlite_master`, READ §8.867 CLAUSE 4 FIRST.** The state-list
> comments stored in the live DDL are **stale by construction and permanently uncorrectable** — they
> were frozen before `creating` existed. Code is authoritative: `STRIPE_STATES` (`src/ledger.js`),
> `STRIPE_CUSTOMER_STATES` (`src/stripe-customer.js`). Reading the deployed schema is the right
> instinct for *structure* and the wrong one for *documentation*.


## 8.867 A VALUE CARRIES ITS INTERPRETATION ACROSS A BOUNDARY — STANDING RULE

**The root pattern: something crosses a boundary and arrives without the metadata needed to read it
correctly.** Clauses 1–3 are the time-value form of it, which is where the pattern was first seen.
Clause 4 is the same shape in a different register — documentation crossing into stored DDL — and
is here rather than in its own section because recognising the *class* is what stops the fifth
instance being debugged from scratch.

**The time rule: a time value crossing a boundary carries its UNIT, its ZONE, and its MODALITY, or
it is not portable.** Each clause below has an instance in this system.

**Clause 1 — UNIT.** `cache.expires_at` holds **seconds** when written by `primus.js:40,127-134`
and **milliseconds** when written by `customers.js:263-281`, in one column. Each reader compares in
its own writer's unit, so **this is not a live defect** — but any generic sweep
(`DELETE FROM cache WHERE expires_at < ?`) is wrong for one of them, and it reads as a bug at 3am.
**Out of scope, recorded.** When it is fixed, prefer **renaming the columns to carry the unit**
(`expires_at_ms` / `expires_at_s`) over normalising the values: a name a generic sweep cannot
misread beats a comment asking it not to.

**Clause 2 — ZONE.** 2026-08-04, during the §8.868 investigation:
`git log --date=format-local:'%Y-%m-%dT%H:%M:%SZ'` renders **local** time, and the `Z` was a literal
typed character. PDT was stamped as UTC and a commit appeared to fall on the wrong side of a deploy.
**Analysis defect only, not a data defect** — verified, not assumed: no locale-dependent formatting
exists in `invoice-sync/src` or `test` (zero hits for `toLocale|Intl\.|getTimezoneOffset|
toDateString|toTimeString`); every timestamp written to D1 is a timezone-free epoch integer from
`Date.now()`; and the one place that formats a date, `windowFor`/`ymd` at `invoices.js:15-23`, uses
`getUTCFullYear/getUTCMonth/getUTCDate` explicitly. Had it used the local getters, the poll window
would drift a day near midnight UTC.

**Clause 3 — MODALITY.** *Estimated* is not *occurred*, and *scheduled* is not *happened*. The
instance is **B0 / §8.864**: `estimatedPickupDate` — a requested, intended time — is assigned to
`dispatchDate` at `portal.html:7631` and lights a completed "Dispatched" checkpoint at `:7650`. The
value's unit and zone are both fine; what was dropped is what kind of time it is.

> **IDENTIFIED BY THE ASSISTANT, NOT THE OWNER.** The owner named clauses 1 and 2. B0 as the
> modality instance is the assistant's identification and is open to rejection; B0's status as a
> defect is unaffected either way.

**Why modality is in the rule rather than in a taxonomy note: it is checkable by name.** A field
named `estimated*`, `requested*`, `scheduled*` or `expected*` must not flow unexamined into one
named for an occurrence (`*Date` on an event, `dispatchDate`, `deliveredAt`, `paidAt`). That is
greppable at review time, which is what makes this a rule and not an observation.

**Clause 4 — PERMANENCE. Text that crosses into a stored artifact freezes on arrival.**

*The class:* a comment is written in a source file, where its author reasonably assumes it stays
editable. Some boundaries strip that assumption without saying so — the text arrives on the far
side as an **immutable artifact**, and the interpretation that was lost is "this is maintained."
It then keeps asserting its original claim for the rest of the system's life, with more authority
than a source comment because a reader found it *inside the running system* rather than in a file
someone might have forgotten to update. **Look for it wherever documentation is carried by data:**
DDL comments, migration files that are never re-run, generated config committed once, a `COMMENT ON`
in a schema, an enum documented in a doc-string that outlives the enum.

*The instance:* `CREATE TABLE` comments become part of SQLite's stored schema. **Verified 2026-08-04
by reading remote `sqlite_master` directly** — the comments came back verbatim. Both of these are on
the live database and **BOTH ARE PERMANENTLY WRONG**, having been frozen before `creating` existed:

```
ledger.stripe_state          -- intent  → row claimed, Stripe create not yet confirmed
                             -- draft | finalized | void | paid | uncollectible → mirrors Stripe
                             -- failed  → create attempted and errored; retryable, still holds the claim

stripe_customer.state        -- intent  → row claimed, Stripe create not yet confirmed
                             -- created → Stripe returned a customer
                             -- failed  → create attempted and errored; retryable, still holds the claim
```

Neither lists `creating`. **Neither ever will.** SQLite offers no way to edit stored DDL text short
of a full table rebuild, and a rebuild of a live table to correct a comment is not a trade worth
making.

> ### ⚠ READ THIS BEFORE TRUSTING WHAT §8.866 SHOWS YOU
>
> **§8.866 is what sends a forensic reader to `sqlite_master` in the first place**, so this warning
> belongs at that moment, not filed somewhere they would have to already suspect. The state lists in
> the deployed DDL are **stale by construction**. They are not a second opinion, not a historical
> record, and not evidence about anything.
>
> **AUTHORITATIVE:** `STRIPE_STATES` in `src/ledger.js`, and `STRIPE_CUSTOMER_STATES` in
> `src/stripe-customer.js`. Nothing else.

*The fix that generalises,* applied 2026-08-04: `schema.sql` no longer restates either list — it
points at the code constant. **Duplicating a list across a freezing boundary guarantees divergence;
pointing across it cannot.** That does not repair the two blocks above, and nothing will. It stops
the third.


## 8.868 THE DEPLOYED WORKER IS NOT REPRODUCIBLE FROM GIT — OPEN

**Established 2026-08-04 by pulling the deployed bundle (§8.866). The deployed `invoice-sync`
script matches NO commit.** It is a mid-development working tree.

Evidence, in both directions:

- It **contains** `resolveClaimedCustomers` and `src/customers.js` — phase-4 code committed in
  `22ab820` at **2026-08-03 23:06:18 UTC**, which is **57 minutes AFTER** the final deploy at
  **2026-08-03 22:09:41 UTC**.
- It **lacks** `quarantine`, `auditValues`, `CUSTOMER_INFO_FIELDS` and `newValueSink` — which landed
  in that *same* commit — and carries an older hand-written `narrowInvoiceDetail`.

So it sits strictly between `c82691c` and `22ab820`: someone deployed to test mid-edit, then
committed the finished work an hour later. **This is NOT the dashboard drift the estate already
knows about** (`stripe-payments`, 2026-07-20). Different mechanism, same consequence, and this
Worker is the one whose `wrangler.toml:9-10` claims `src/` is the only source of truth for it.

**Three consequences:**

1. **The running artifact is not reproducible from git.** There is no commit to check out that
   rebuilds it.
2. **Every future claim about what is live requires another bundle pull**, because history cannot
   answer the question. That is now a permanent cost, not a one-off.
3. **Whatever is deployed contains code that was never reviewed as a diff.** A working tree is
   whatever happened to be on disk, including anything uncommitted.

**THE RULE, written down now and acted on later: nothing deploys from a dirty tree again.** A deploy
names a commit; the tree is clean at that commit; the deployed bundle is verified against a
re-bundle of it (§8.866). Before phase 9 this stops being hygiene and becomes the thing that makes
"deploy the reviewed code" mean anything at all.

**Not fixed by redeploying.** A clean redeploy from `main` would make the artifact reproducible
again, but `main` currently carries phases 5-8, so it is a functional change and not a hygiene
step — it needs its own decision, and it must not be smuggled in as cleanup.

**UNRESOLVED CORNER, stated rather than solved.** The obvious escape route is closed in both
directions: production runs an artifact that **cannot be rebuilt** and **cannot be safely replaced**.
Left open deliberately on 2026-08-04. Do not resolve it by reflex.

**REACHABILITY — nothing invokes it. The artifact is inert.** Verified 2026-08-04 against the
deployed configuration, not the repo `wrangler.toml` (which is the same inference that failed above):

| vector | result |
|---|---|
| cron schedules | `[]` — API `success: true` |
| `workers.dev` subdomain | `enabled: false`, `previews_enabled: false` |
| custom domains | 0 account-wide |
| service bindings from other Workers | 0 — **16 of 16** scripts queried, 0 failures |
| queue consumers | 0 queues on the account |
| zone routes | 0 total in the single zone (`freightandlogistics.ai`), 0 to `invoice-sync` |
| callers in this repo | none outside `invoice-sync/` itself |

**So this is a phase-9 problem, not a live exposure.** It becomes one the moment any trigger is
added — and the trigger is the cheap part, which is the hazard.

> **Method note, because it nearly went the other way.** Four of these lookups initially returned a
> clean-looking negative that was actually a failed query: an expired OAuth token, a token without
> `zone:read`, a `grep '"success":true'` that missed the API's pretty-printed `"success": true`, and
> a `for x in $VAR` loop that did not split because **zsh does not word-split unquoted variables**.
> Every one produced "no results found", which is indistinguishable from "no results exist". The
> counts above are reported *with* their query-success denominators for that reason (§0.25).


## 8.869 THE STOP 1 CREDENTIAL — the record and reality diverged, and nothing detected it

**Found 2026-08-04, by the owner, in the Stripe dashboard, after the Cloudflare API showed a
`secret_text STRIPE_RK_TEST` binding on the deployed Worker.** The project record said no Stripe key
had ever been loaded. It had.

**The key.** `invoice-sync-test`, test mode, account `acct_1TjE6BAJRfa3jdmD`, created 2026-08-03.
**Last used: never** — the dashboard field was an em dash, not a date. Scopes, read off the edit
page: **Customers = Read, Invoices = Write**, every other resource **None** — including Payment
Intents, Charges, Payment Links, Payment Methods, Payouts, Checkout Sessions, Products and Prices.
**Now EXPIRED** — revoked by the owner in the Stripe dashboard.

**The Cloudflare binding was deliberately left in place and untouched.** Removing it via `wrangler`
risks pushing a new version of the deployed script, and that script is the unreproducible partial
working tree (§8.868). The binding is inert now that the key behind it is revoked. **Do not "tidy"
it** — that is a deploy wearing a cleanup's clothes.

### What this settles

1. **"Nothing has ever been created in Stripe" — TRUE, and now positively verified rather than
   assumed.** A never-used key can have created nothing. Two independent sources agree: Stripe's own
   "last used" is empty, and the deployed bundle contains no Stripe egress (below).
2. **"No Stripe key has ever been loaded" — FALSE.** One was created and bound on 2026-08-03 and the
   project record does not contain it.
3. **STOP 1 was believed to be two independent layers. It was one.** The belief was "no key" AND "no
   code that calls Stripe". The key was live and bound the entire time, so the *only* thing standing
   between the deployed Worker and Stripe was that its code constructs no Stripe request — and that
   was **unverified until 2026-08-04**.

### The egress check that closes layer 2 — verified, not reasoned

Grepped over the 35,299-byte deployed bundle:

| probe | hits |
|---|---|
| `api.stripe.com` / `stripe.com` | **0** |
| `Stripe-Version` / `Idempotency-Key` | **0** |
| `v1/invoices` / `v1/customers` | **0** |
| absolute URL literals of any kind | **0** |
| `fetch(` call sites | **3**, all Primus: `${this.creds.base}/login`, `this.creds.base + full`, and the `fetch(request)` handler |

The build **does** read the secret — `env.STRIPE_RK_TEST` and the `rk_/sk_` prefix validation are
present — and then never sends it anywhere. So the key was loaded into memory on every run and
validated, which is corroborating evidence it was real and correctly prefixed. Stripe's "never used"
and our "zero egress" are two independent paths to the same conclusion.

### Premise count for the day

**Four premises checked on 2026-08-04. Three failed.**

| premise | outcome |
|---|---|
| deployed code == committed code | **FAILED** — §8.868 |
| deploy/commit timestamps establish what is deployed | **FAILED** — §8.867 clause 2, and the working tree defeats it regardless |
| no Stripe key has ever been loaded | **FAILED** — this section |
| nothing has ever been created in Stripe | **HELD** — and upgraded from assumption to verified |

The one that held is the one that was load-bearing for customer safety. The three that failed were
all about *our own record of our own system*, which is the class of belief nothing external
contradicts until someone looks.

### CREDENTIAL POSTURE FOR TASK 2 — a decision, not an inheritance

The expired key **could not have created a Stripe customer**: Customers was **Read**, not Write. So
the claim-then-create-customer design (§4.2, `stripe_customer`) could never have run on it.

**Keep that constraint on purpose.** The Task 2 key gets **Invoices = Write, Customers = Read**. The
owner creates the pilot customer **by hand in the dashboard**.

> **CORRECTED 2026-08-04: ONE customer, TWO invoices.** An earlier draft of this section said "the two
> pilot customers", which was wrong and worth striking rather than quietly fixing. The pilot is ONE
> ARCode — `1234` — carrying two invoices (#141604 `invoiceId 1563993653`, #141385 `invoiceId
> 1269958425`). **Two customer rows for one ARCode is precisely what control 5 and the
> `UNIQUE (mode, ar_code)` constraint exist to refuse**, so building against the old wording would
> have produced the exact state the schema forbids.

**Why:** control 9 says the code must never create a customer implicitly. At **Customers = Read the
credential enforces that**, rather than a test asserting it — the code *physically cannot* produce a
customer orphan during the phase where blast radius matters most. Two ARCodes by hand costs nothing.
`Customers = Write` is added later, when creating customers is intended behaviour rather than a
failure mode.

**This does not remove control 9.** Belt and braces: the credential makes the failure impossible, the
test makes the *intent* explicit and survives the day the scope widens.

### THE STRIPE CLIENT IS INJECTED, NOT CONSTRUCTED — a decision, not a style preference

Approved 2026-08-04. The create path takes the Stripe client **as a parameter**:
`createInvoiceForClaimedRow({ db, ledger, stripe, row })`, refusing with
`{ ok: false, reason: 'no_stripe_customer' }` when the `(mode, ar_code)` join into `stripe_customer`
misses.

**The reason is this section, not testability-in-general.** A key sat bound and forgotten on the
deployed Worker for a day, and nobody knew. If the create path constructs its own client from
`env`, then **"no key is loaded" is the only thing standing between the code and Stripe** — which is
precisely the assumption that just failed, and the failure was invisible from inside the system.
Injection means the path can be exercised end to end with **no key present at all**: a recorder is
passed in, and the assertion is that nothing was called. The safety property stops depending on a
fact about configuration that nothing verifies.

Corollary for review: a create path that reads `env.STRIPE_RK_*` directly is a regression of this
decision, however convenient it looks at the call site.

## 8.870 ARCODE NORMALISATION — the join that justifies the schema was broken

**Found 2026-08-04 while enumerating allowlist boundaries, fixed the same day.** The `(mode, ar_code)`
join between `ledger` and `stripe_customer` is the ENTIRE justification for `ledger` carrying no
denormalised `stripe_customer_id` (§4.2). **The two sides did not agree on what an `ar_code` is,** so
the argument for that schema was unsound and nine controls were about to be written on top of it.

| site | stored/compared as | agreed |
|---|---|---|
| `config.js` allowlist parse, `checkArCode` | `.trim().toUpperCase()` | ✔ |
| `customers.js` `customerCacheKey`, `displayNameMatchesArCode` | `.trim().toUpperCase()` | ✔ |
| `stripe-customer.js` `customerIdempotencyKey` | `.trim().toUpperCase()` | ✔ |
| `stripe-customer.js` **claim / get** | `.trim()` — no uppercase | ✘ |
| `ledger.js` **claim** | raw | ✘ |

Demonstrated before the fix:

```
ledger.ar_code stored  : [" 1234 ", "ABC1", "abc1"]
stripe_customer stored : ["1234",   "ABC1", "abc1"]
join: ledger " 1234 " -> *** NO MATCH ***
```

Worse than a miss: `abc1` and `ABC1` produced **two** `stripe_customer` rows sharing **one**
idempotency key, so the second create would return the first customer, `attach` would bind one id
to two rows, and the partial unique index would throw a raw `UNIQUE` error. **A data quirk surfacing
as a mis-join alarm.**

**Every ARCode ever observed is plain digits — `5406`, `1234`, `2395` — which hid all of it
completely.** The code already anticipated alphanumeric codes; that is why `checkArCode` bothered to
uppercase at all.

### The canonical form

```js
export const normalizeArCode = v => String(v ?? '').trim().toUpperCase();   // src/arcode.js
```

**Not a new rule — the one five sites already used, extracted and applied at the three that skipped
it.** Three deliberate exclusions:

- **NO leading-zero stripping.** `checkArCode` reports `near_miss` when a code differs from an
  allowlist entry only by leading zeros, because that is a config typo rather than a business fact.
  Folding zero-stripping in would have **deleted a detection mechanism in the name of consistency**.
- **NO internal-whitespace collapsing.** A space inside an ARCode is bad data, not a formatting
  variant; collapsing it silently accepts junk, leaving it distinct fails the allowlist. What the
  join needs is both sides applying the SAME function — consistency, not aggressiveness.
- **NO Unicode folding beyond `toUpperCase()`. KNOWN EDGE:** SQLite's `UPPER()` is ASCII-only while
  JS `toUpperCase()` is Unicode-aware, so a non-ASCII ARCode could make the SQL migration and the JS
  function disagree. Every ARCode observed is ASCII digits. **Recorded rather than engineered for, so
  the first non-ASCII ARCode is a known case and not a mystery.**

A blank normalises to **SQL NULL, not `''`** — `''` would land the row in `resolveClaimedCustomers`'
`ar_code IS NOT NULL` sweep and trigger a QBO lookup for the empty string.

### `exceptions.ref` stays RAW — decision, with the reason

`recordException('unmatched_ar_code', String(arCode), …)` writes an un-normalised ARCode, and
`UNIQUE(mode, kind, ref)` dedupes on it, so `abc1` and `ABC1` can produce two rows for one problem.
**Left raw deliberately.** `ref` is **polymorphic** — it also holds invoice ids (`invoice:141604`)
and document-type codes. Normalising it would apply an ARCode rule to data that is often not an
ARCode, which is a worse defect than an occasional duplicate exception row. **A dedup key is not a
join key.**

### `customers.js:192` — a deliberate LOOSENING, taken as a decision

The cross-check that refuses the join when the invoice LIST's `ARCode` and the invoice DETAIL's
`customerInfo.customerCode` disagree (§3.1) now compares through the shared normaliser.

**The trade, stated rather than hidden: the check becomes slightly MORE PERMISSIVE — `abc1` will
match `ABC1` — in exchange for the two Primus endpoints being compared on the same terms as every
other ARCode comparison.** Owner decision 2026-08-04. This is a safety check changing behaviour, not
housekeeping, and the distinction between a consistency change and a safety change wearing one's
clothes is why it was raised separately rather than folded in.

A genuine disagreement still fails closed, and a test pins both directions.

### The migration — and a STANDING PRECONDITION on it

```sql
UPDATE ledger SET ar_code = UPPER(TRIM(ar_code))
 WHERE ar_code IS NOT NULL AND ar_code <> UPPER(TRIM(ar_code));
```

Applied to remote 2026-08-04. **Before: 0 rows would be rewritten. Changes: 0. After: 11 rows, 1
distinct code (`5406`), 0 non-canonical.** Re-runnable; the `WHERE` makes it a no-op by construction
once clean.

> ### ⚠ STANDING PRECONDITION — any run where the count is NON-ZERO must SNAPSHOT FIRST
>
> The pre-normalisation value is **not recoverable from the post value**. Today the count is zero,
> so writing this rule down costs nothing — **and the moment it matters is the moment nobody will
> think to add it.** Before any non-zero run: capture the affected `(id, ar_code)` pairs, then write.

**Why it ran at all, given it changed nothing:** it exists for **correctness of the sequence, not
because production needed repairing**. Skipping it because this database happens to be clean would
leave the next database that *does* carry a dirty value silently broken, with no record that the
step was ever considered.

## 8.871 THE PILOT BOUND IS HELD BY THE OBJECT, NOT REMEMBERED AT THE CALL SITE

**Decision 2026-08-04.** `Ledger` and `StripeCustomers` now take the AR allowlist as a **required
constructor argument**, exactly as they already take `mode`, and it is welded into the `WHERE`
clause of every query rather than checked by each caller.

**The reasoning is the allowlist's own purpose turned on itself.** A boundary enumeration found
**eleven** places where a non-allowlisted `ar_code` could enter or advance state, and exactly
**one** enforced it (the poll, `invoices.js:113`). Enforcing at eleven call sites is the failure the
allowlist exists to prevent, reproduced inside the mechanism meant to prevent it: the pilot's
blast-radius bound would be only as good as the least careful caller.

**`mode` is the precedent and it works.** Every query carries `AND mode = ?` because the constructor
holds it, not because eleven authors remembered — a row in the wrong mode is not *addressable*,
which is stronger than it being checked. The bound is now held the same way. The cost, stated: this
couples storage to policy. At pilot scale that is the right trade.

### How it refuses

| layer | behaviour |
|---|---|
| constructor | **throws** on an absent or wrongly-shaped allowlist. Never defaulted — an absent bound silently meaning "everything" is the §3.1 misconfiguration |
| `claim()` (both tables) | **throws.** A silent `claimed:false` is indistinguishable from "already claimed", and would suppress the invoice forever with no signal — the never-billed failure §3.1's ordering rule exists to prevent |
| state-advancing writes | the bound is part of the `WHERE`, so the row is **not addressable**; the guarded update returns `false` and nothing is half-applied |
| sweeps | out-of-bound rows are simply not returned |

**A NULL `ar_code` PASSES.** "No code" is not "a code outside the bound": such a row reaches no
customer (`resolveClaimedCustomers` filters `ar_code IS NOT NULL`) and the poll already records an
exception and skips before it can be claimed. Refusing here would fail a case handled correctly one
layer up.

### TWO DELIBERATE EXCEPTIONS — reasoning lives in the code, and tests assert both

**1. `siblingsOfBol` stays UNFILTERED.** It is a READ whose only job is to force explicit
classification, and a BOL collision can span an allowlisted and a NON-allowlisted customer.
Filtering would hide exactly that collision, and the caller would create silently where it should
have held. **The bound limits what we WRITE; it must not limit what we can SEE before writing.**
Narrowing a safety read makes it blinder.

**2. The near-miss / missing-code writes at `invoices.js:118-122` stay UNBOUND.** These rows exist
precisely to say *a code outside the bound was seen, and here it is*. Gating them would silence the
only signal distinguishing "the pilot is correctly scoped" from "the pilot ran for a week and billed
nothing." `recordException` advances no state — it is a report, not an action.

### B3 — the one boundary already being crossed in production

`resolveClaimedCustomers` (`customers.js`) builds its own SQL rather than going through a `Ledger`
method, so the constructor-held bound does not reach it automatically. It selected **every** `intent`
row carrying an ARCode, which on remote D1 meant **the 11 Payless rows** — claimed while
`AR_ALLOWLIST` was `"5406"`, with the pilot now `"1234"` — on **every run**, performing a QBO lookup
and **caching that customer's email addresses** for an account outside the pilot. The `qbo:ar:5406`
cache row on remote is the evidence.

**No ledger state changed and there was no billing risk, which is exactly why it went unnoticed** —
but the pilot bound is the thing that is supposed to make "outside the pilot" mean something. The
bound is now welded in explicitly, and a test asserts no QBO lookup is issued for an out-of-bound
customer.

### The 11 Payless rows are now a live negative control

They are left in place deliberately (owner decision 2026-08-04): a row that must be refused, sitting
in the real database, tests the guard against production data rather than against a fixture written
by the same hand that wrote the guard. The test suite mirrors the scenario exactly — claim under a
wide bound, then prove **all seven** state-advancing writes refuse under the narrow one, and that the
same calls succeed through a wide-bound instance, so the refusals are the bound acting rather than
the guards being broken.

## 8.872 THE REFUSAL VOCABULARY — agreed before the controls, not grown inside them

**Settled 2026-08-04, before Step 5 was written.** The set was deferred at Step 3 on the grounds
that one member is not a set; it was agreed once all nine controls were visible and the real shape
was knowable.

| reason | condition | control |
|---|---|---|
| `not_allowlisted` | the ARCode is outside `AR_ALLOWLIST` | 8 |
| `no_stripe_customer` | the `(mode, ar_code)` join yields no usable customer id | 9 |
| `create_in_flight` | the row is in `creating`; the outcome is unknown and Stripe must be READ first | 7 |
| `already_materialized` | the row already carries a Stripe id | 1 (negative side) |
| `customer_id_already_claimed` | a DIFFERENT row already holds this Stripe customer id | 5 |
| `invoice_id_already_claimed` | a DIFFERENT ledger row already holds this Stripe invoice id | 6 |

**Six, not five.** The set was agreed at five; control 6 turned out to be the same expected mis-join
class as control 5 on the other table, and it needed its own name — `customer_id_already_claimed`
does not describe an invoice. The increment is a genuinely new condition, not drift.

**Shape: always `{ ok: false, reason }`, optionally `detail`. Never a bare `false`, never a thrown
string.** `refuse()` validates against the set, so a sixth word cannot be coined by typo — the
failure that guards against is real and already present: **five different strings for "this ARCode
did not work out" exist across four layers** (`unmatched_ar_code`, `missing_ar_code`,
`not_allowlisted`, `missing_claimed_ar_code`, `no_display_name_suffix`).

**`not_allowlisted` deliberately REUSES the string `checkArCode` already returns** for exactly that
condition. Two names for one condition is how a vocabulary stops being one.

### REFUSALS AND THROWS ARE DIFFERENT CATEGORIES — keep them apart

**A refusal is an expected outcome a caller handles.** The customer is not resolved yet, the row is
outside the pilot bound, another run is mid-create. Every one is a normal state of a correct system
and the caller's job is to skip and move on.

**A throw is a broken invariant nobody should be handling.** `assertLivemode` throwing on a mode
mismatch is the example: **a caller able to write `if (!result.ok)` past it is a caller that can
ignore it**, and the entire point is that it cannot be. Same for an unknown `stripe_state`, and for
a claim outside the bound — which means a caller skipped the poll's filter, a programming error
rather than a business condition.

**`mode_mismatch` is deliberately NOT in the vocabulary.** It stays a throw.

The test to apply when the next one arrives: **does a correct system reach this state on an ordinary
Tuesday?** If yes it is a refusal; if no it is a throw. The temptation runs both ways — the next
refusal will look throwable, and the next broken invariant will look like it deserves a tidy
`{ok:false}`.

### Control 5's raw storage error, and why the catch is narrow

`attach()` used to let a raw `UNIQUE constraint failed: stripe_customer.mode,
stripe_customer.stripe_customer_id` escape to the caller — **a mis-join announcing itself in the
vocabulary of the storage engine rather than the domain**, understandable only by string-matching.
The condition is *expected* — it is precisely what the partial unique index exists to produce — so
it belongs in the refusal set.

**The catch classifies by RE-READING STATE, never by parsing the message.** Verified 2026-08-04:
the control-5 constraint and the `(mode, ar_code)` constraint carry **the same SQLite code (2067)**
and differ only in message text, and D1 wraps messages differently from `node:sqlite`. Matching text
would be brittle across engines *and* would swallow the `ar_code` refusal plus every future index on
that table.

So the error becomes a refusal **only when the domain condition is confirmed by a read** — a
different row, in this mode, now holds this id. Anything the re-read cannot confirm is **rethrown
untouched**, and a test proves it (an injected I/O error propagates rather than becoming a refusal).
A pre-check handles the ordinary case so the storage engine is never reached; the catch is the race
backstop.

**`Ledger.attachStripeInvoice` got the identical treatment (control 6), and that was the point.**
Two sibling tables handling an identical condition by opposite philosophies — one returning a
designed refusal, one letting a raw storage error escape — would mean **a caller cannot learn one
convention and rely on it**, which is the entire reason to have a vocabulary rather than a habit.
Both tables now share one MECHANISM, not merely one word list.

`ledger.test.mjs` previously asserted that collision with `assert.rejects(..., /UNIQUE|constraint/i)`.
**That assertion was worse than the defect it described**: a test pinning a raw storage error keeps
the anti-pattern alive and makes removing it look like a regression. It is gone.

**`_holderOf` on both classes is DELIBERATELY NOT bound-scoped, and says so in the code** — it looks
like an omission to anyone applying the constructor-bound rule mechanically. The unique index is
GLOBAL, so a collision with an out-of-bound row is still a collision; bounding that read would make
the refusal miss precisely the case the 11 Payless rows exist to represent.

### The nine controls, and which are red by absence

`test/controls.test.mjs` is the index. Controls pinned as they were built stay with the code they
guard and are cross-referenced rather than duplicated — **two copies of a control is how one of them
quietly stops being maintained.**

| # | control | where | state |
|---|---|---|---|
| 1 | claim → attach → a re-run does not re-create | `controls.test.mjs` | green |
| 2 | a second customer claim is refused | `stripe-customer.test.mjs` | green |
| 3 | `creating` → read Stripe → adopt | `controls.test.mjs` | **red by absence** |
| 4 | a test-mode row cannot satisfy a live lookup | `stripe-customer.test.mjs` | green |
| 5 | two ARCodes cannot share one customer id | `stripe-customer.test.mjs` + `controls.test.mjs` | green |
| 6 | attach refuses a DIFFERENT invoice id, and a mis-join refuses in the domain vocabulary | `ledger.test.mjs` | green |
| 7 | a `creating` row is never safe to create | `controls.test.mjs` | primitive green, **create path red by absence** |
| 8 | a non-allowlisted row cannot be materialized | `allowlist-bound.test.mjs` + `controls.test.mjs` | bound green (against the 11 real Payless rows), **create path red by absence** |
| 9 | a missing customer join refuses, creates nothing | `create.test.mjs` | **red by absence** |

**Four tests are red by absence and each says so in its NAME and in its OUTPUT**, via a shared
`whyRed()` marker. None can be read as a defect, and each carries `DO NOT DELETE THIS TEST TO GREEN
THE SUITE`. Control 3 additionally records that it **cannot be exercised at all today** —
`invoice-sync-test` is expired and no key exists (§8.869).

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

## 8.95 PHASE 8 — decision layer built, R2 MIRROR DELIBERATELY NOT BUILT

`src/documents.js` decides what MAY be exposed and derives the token a link would carry. It
**fetches nothing, mirrors nothing, writes nothing.**

**The mirror is not built on purpose.** Mirroring writes customer documents into a bucket — PODs
carrying consignee home addresses and phone numbers, on a book that is ~90% residential. That is a
real data-handling action, not a refactor, and it creates infrastructure. It is the same posture as
the mapper: the decision is built and tested; the irreversible step waits.

**Built:**
- `normalizeType` — trim + uppercase before ANY comparison. `BOL ` carries a trailing space live;
  without it the allowlist silently drops every Bill of Lading.
- `classifyDocument` → `pull` / `never` / **`unknown`**. Unknown is excluded like `never` but is
  also **recorded** — a new Primus type must be visible in both directions.
- `selectDocuments(docs, classification)` — PUSH is **rebill-only** and limited to `RECLASS` /
  `REWEIGH`, the two documents that ARE the justification for the charge.
- `deriveDocToken` — HMAC-SHA256 over `invoiceId:bolNumber:type`. **Scoped per (INVOICE, DOCUMENT)**,
  because two parties can bill on one BOL and a per-document token handed to one grants the other's
  view. Derived, not stored, so no token table can drift from links already issued. **Throws without
  a secret** — an unkeyed token is guessable.

**Verified against the live document set** for BOL 160133377 (`BOL`, `LBL`, `QUO`, `INV`, `DO`,
`COST`): exactly one document — the Bill of Lading — is exposed. `COST` (carrier cost) and `QUO` are
excluded by name, `INV` because the Stripe invoice supersedes it.

**`IMG` is pull-only on every classification**, pinned by a test. Driver photos show the consignee's
house, door, plates and sometimes people, and the bill-to is frequently a retailer with no
relationship to the delivery address.

**Still to build for phase 8 to be complete:** the R2 bucket, the mirror fetch/write, and the
`docs.freightandlogistics.ai` route that validates a token and serves the object. None started.

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

**Restricted-key scopes — DECIDED 2026-08-04, see §8.869 for the reasoning.** The Task 2 key carries
**Invoices = Write, Customers = Read**, and nothing else. Customers stays at Read *deliberately*, so
the credential itself makes implicit customer creation impossible; the two pilot customers are
created by hand in the dashboard. `Customers = Write` is a later, separate decision. The predecessor
key (`invoice-sync-test`, created 2026-08-03) carried the same scopes and was revoked unused.

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
| ~~D10~~ | **CLOSED 2026-08-03** — rebills carry `Original Invoice`, derived from the classifier's sibling set (§5.31) | — |
| **D8** | ~~Clock start~~ **CLOSED**: Stripe's send timestamp (§5.5). Still open: the business-day calendar for rendering an explicit deadline | Phase 9 |
| **D9** | Delivery answered (§0.1.1 — Primus + QBO email, both stopping at go-live). **Still open:** can Payless log into the portal and pay via the modal? That path survives the routine change and is the same two-live-paths failure | Phase 9 |
| **D6** | Stripe email subject line — currently "New invoice from Freight and Logistics, Inc. #\<number\>", carries no BOL or PO reference. Gmail will thread these for customers the way QBO reminders threaded for us | Phase 10 |
