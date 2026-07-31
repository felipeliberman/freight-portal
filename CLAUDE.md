# FreightAI Portal — Claude Code Rulebook

This is the source of truth for developing the FreightAI customer portal. Read this before touching anything.

---

## What this product is

A conversational AI-powered TMS (Transportation Management System) customer portal for Freight and Logistics, Inc. — a nationwide LTL and white glove freight brokerage based in Los Angeles, in business since 2013. The portal layers Claude (claude-sonnet-4-6) as a conversational agent on top of Primus (ShipPrimus), the existing TMS backend. Customers quote, book, and dispatch freight entirely through chat or a form UI.

The business goal: build the stickiest TMS in the market by making freight as low-friction as possible. Legacy brokers (Echo, GlobalTranz, Priority One) are friction-dependent by design. Low-friction AI UX is the competitive wedge.

---

## Workflow rules — STRICT

- **Plan first, then wait for explicit "go" before any code change or push.**
- "Don't go" means discuss only — no changes.
- Before editing: re-fetch the live file from GitHub (never assume the local copy is current).
- After editing: extract the largest `<script>` block, run `node --check` on it before every commit.
- Push to GitHub only when explicitly told to.
- One thing at a time — don't bundle unrelated fixes.

---

## The two-step booking flow

This is the most important UX concept in the whole portal. Customers do NOT book and dispatch in one click.

**Step 1 — Save:** Customer fills in shipment details and hits Save. Creates a BOL in Primus but does NOT dispatch. The shipment appears in My Shipments as "Saved."

**Step 2 — Dispatch:** Customer comes back, opens the saved shipment, reviews it, and hits Ready to Dispatch. This notifies the carrier and makes the BOL valid for tendering.

**Consequences:**
- Any warning or confirmation pop-up must offer a "Save and come back later" path, not just "Book" or "Dispatch now."
- "Book Anyway" or "Proceed" language is confusing — customers think it means dispatch. Use "Save Without Changes" or "Save and Come Back" instead.
- Customers frequently save partial shipments with missing fields and complete them later. Never block Save on missing fields.
- Dispatch is irreversible. Save is not. The UI must make this distinction clear.

---

## Customer flow: full lifecycle

Quote → Rate → Book (Save) → Edit/Complete → Dispatch

- **Requote:** Customer re-rates an existing saved shipment. Must preserve the original shipper, consignee, pickup, contacts, and special instructions. Must update the same BOL (PUT), never create a duplicate (POST).
- **Edit:** Customer fixes details (addresses, contacts, pickup date) on a saved shipment without changing the rate. Same BOL, PUT update.
- **Dispatch:** Sends the pickup request to the carrier. Irreversible. Must check pickup date is not in the past and not a weekend.

---

## Freight domain rules

- **Liftgate is always required for residential furniture deliveries** — never optional, never skip it.
- **Accessorials default to the delivery side** unless explicitly stated otherwise. "Pickup on Tuesday" is a date, not a side indicator.
- **Residential detection (two layers, both intended):** the chat agent asks "residence or a business" during quoting and adds RSD that turn — this is deliberate, not a leak, so do not "fix" it out. Geocodio (`zip4.residential === true`) on the delivery **street** address is the silent backstop. Ask the customer directly for Canadian addresses (Geocodio is US-only). **Coverage today is FORM-ONLY and that is a known gap, not the design:** the backstop fires from `checkRDIBeforeDispatch` (the two form dispatch buttons) and the two guards inside `showBookingPanel` (the Save button and Book & Dispatch button) — all four are DOM handlers unreachable from chat. `_execBookShipment`, `_execSaveShipment`, and `_execDispatchShipment` have NO residential check, so a chat-driven booking to a residential address is quoted without RSD and rebilled by the carrier after delivery. Do not read the sentence above as "chat is covered."
- **Residential classification — who may speak it (product contract, narrowed 2026-07-30):** the rule is about *the agent's mouth*, not about whether the system checks. **The AGENT never raises, volunteers, or challenges classification** — it never says an address "comes back" residential, never mentions a lookup/check/verification, and never second-guesses the customer's intake answer. The classification is therefore kept off every agent-facing surface (`_liveStateBlock`, the `read_rates` result, `_convoSysPrompt`), which is what invariant 15 asserts. **Deterministic CODE MAY geocode the address, hold a write, and render FIXED COPY** naming the missing services — that is not the agent raising it, and invariant 15 does not forbid it (it asserts only on `_liveStateBlock()` and `_convoSysPrompt`). The required shape is the existing one, not a new mechanism: `appendMessage('bot', FIXED_COPY)` plus a tool return of `{ ok:false, _turnHandled:true, message:'…say nothing further this turn' }`, so the agent can neither rephrase the hold nor fire a pull onto it. **Never** raise `checkRDIBeforeDispatch`'s overlay from inside a chat tool call — its only exits are click callbacks, so the tool has no return value until the customer clicks (live-diagnosed, reverts `4cc49ac` / `6f31228` / `e8c1556`). Chat speaks; the form shows the overlay.
- **Pickup dates:** Monday–Friday only. If a date falls on a weekend, bump to the next Monday. Never allow a past pickup date — auto-bump to next business day and show a note.
- **Valid Primus accessorial codes:** LFD (liftgate delivery), LFO (liftgate pickup), RSD (residential delivery), RSO (residential pickup), IND (inside delivery), INO (inside pickup), LAD (limited access delivery), LAO (limited access pickup), APD (appointment delivery). Other service codes the app sends: INS (cargo insurance), HZM (hazmat), OVL (overlength), SOR (sort & segregate), TWO (two-man delivery), NBD (notify before delivery). Do NOT use APT or NAO — they are fake codes Primus never had; the code auto-migrates APT→APD and NAO→LAO (canonical map in `ACC_LABEL`/`ACC_CODE_OF`, portal.html ~2174). RSP and NAD are legacy input aliases normalized to RSO and LAD.
- **NMFC is optional** — offer it, never require it.
- **Cargo insurance commodity (Option B — product contract):** when the quote already carries a mappable commodity, insurance settles silently in that turn with the read-back ("Cargo insurance requested — [category] ([commodity]), declared value $X.XX"). The numbered commodity list renders ONLY when the commodity is unknown or unmappable, and it mirrors the form dropdown from the one canonical source (`REDKIK_COMMODITIES`). The customer can always change it ("change the commodity" / "the commodity is wrong") — even after insurance is set; the declared value is preserved and rates re-pull so the premium follows the category.
- **Cargo insurance is settable at ANY point — change of mind included (product contract):** enable, adjust the declared value, correct the commodity, or cancel coverage — before OR after rates, and after a prior decline or settle. The agent does this via `update_quote`'s `insurance` field (`{enable:true, declaredValue, commodity}` to add/change — value-only or commodity-only preserves the other; `{enable:false}` to cancel), and the same phrasings work deterministically in chat ("insure it for $1,200", "cancel the insurance"). Every path routes through the ONE writer (`setInsurance` → `_insCompleteWithCommodity`/`_insDeclineSettle`, `_applyInsuranceIntent` is the chat/agent entrypoint), so `lastQuotedShipment` + chip + panel + value always move together and rates re-pull — no cancel-but-still-billed split-brain, no priced-nothing half-state. INS is NOT a plain accessorial: never set it through `addAccessorials`/`removeAccessorials`.
- **No phone-as-fallback (product contract):** error, failure, and handoff copy is EMAIL-ONLY — never route a customer to the phone when something goes wrong. The canonical failure line (`AGENT_FAIL_MSG`) and rate/write error copy (`RATE_SUPPORT`) direct to `support@freightandlogistics.ai` (and/or the in-app Email Support panel), with no phone number or "call us" phrasing, and must stay that way. The number is allowed to exist elsewhere: the agent MAY share `(800) 687-3713` when a customer asks for it directly, and onboarding/conversion surfaces MAY offer it — the "Request Account Setup" modal, the "Talk to Our Team" site-chrome link, and transactional document footers (invoice/receipt/email letterhead). The ban is on phone-as-fallback, not on the number existing.
- **Landing agent — Option A, account-first (product contract):** the landing-page agent NEVER collects shipment details it cannot act on. When a prospect wants a quote or a price, it says up front that live rates require a free (~5-minute) portal account and offers to get them started (or book a call) — asking ZERO shipment questions for quoting purposes (no ZIPs, dims, weight, commodity, freight class, or accessorials). General freight questions, terminal lookups, and service explanations are answered normally. Source of truth: `KNOWLEDGE.md` §9 (`scope: landing`), baked into `KB_LANDING` in `anthropic-proxy/src/index.js` via `node evals/build-worker-kb.js` (Worker deploy). The landing behavioral prompt (`SYSTEM_PROMPT` in `index.html`) is already account-first and is NOT the collection driver.
- **White glove carrier roster is not disclosed on public/prospect surfaces (product contract):** the white glove / final-mile carrier roster is available to logged-in customers (it's on their BOLs, tracking, and live quotes) but NOT named on prospect-facing surfaces. The landing agent never names a specific white glove or final-mile carrier and never confirms or denies a carrier a prospect asks about ("Do you use Metropolitan?" = same non-answer as "Who are your carriers?"); it describes white glove capability fully and deflects with the account-visibility conversion hook (every quote shows the carrier once you have a free account). It DOES describe capability/coverage enthusiastically. **Scope: landing only — the portal agent is unaffected** (logged-in customers get carrier names freely). Source of truth: `KNOWLEDGE.md` §9 (`scope: landing`) → `KB_LANDING` via `node evals/build-worker-kb.js`. Every prospect-facing white-glove roster mention is genericized to the same panel language (no carrier names): `index.html` `wg.sub` (the White Glove panel), `KNOWLEDGE.md` §2 White Glove (`scope: both`, so it's removed from BOTH bundles), and `index.html` `SYSTEM_PROMPT` (~line 845 "KEY CARRIERS"). Verified: white-glove names appear in NEITHER `KB_LANDING` nor `KB_PORTAL`. **Portal carrier visibility is unaffected** — the portal agent names carriers from live rate/BOL data, not the KB, so logged-in customers still see the exact carrier on every quote and shipment. Out of scope (left as-is, deliberate): the FEATURED CARRIERS logo strip (public LTL/ocean brands, kept as credibility) and the demo movie's sample rates/analytics.
- **Freight class is never asked by any agent (landing or portal):** class is auto-calculated from density (dims + weight); no agent asks the customer to supply, choose, or confirm a class, and it is never a field they fill in. Stating class as a rate factor, or displaying a computed class, is fine. (KNOWLEDGE.md §10, `scope: both`.)
- **No promise without action (both agents):** never say you are looking something up / pulling details / checking / fetching unless the retrieval (web_search or tool call) happens in the SAME turn. Mirrors the portal `_gateFinalText` promise-without-action enforcement. (KNOWLEDGE.md §10.)
- **Accurate enumerations (both agents):** never attach a count that doesn't match what is listed ("top 10" then nine). State a number only when correct, else drop it. (KNOWLEDGE.md §10.)
- **STC must be a STRING** in the Primus payload, never a number. Omit it when blank.
- **Packaging type codes:** PLT pallet, BOX box/carton, CRT crate, SKD skid, BAG bag, BND bundle, RLL roll, TBE tube, OTH other.

---

## AI agent rules (the chat agent in portal.html)

- Never narrate tool actions — the agent must trust form-state snapshots and never re-ask for fields already filled.
- Never speak negatively about any carrier or service.
- Never quote insurance rates or percentages.
- Must ask for pickup day AND time window before reading the booking back — never default silently.
- When a number is ambiguous (e.g. "100 x 48 40 40"), confirm which number is the weight.
- Must treat a ZIP the user states as theirs — never say "it was already in the form."
- Responses: plain prose, no markdown, no emoji, no bullets, 2–4 sentences max.
- **A carrier rule may PROMPT, never APPLY (product contract, 2026-07-31):** real-world rules like "JTS requires an appointment when the delivery is residential, while other carriers bundle it" are legitimate and worth surfacing — but a rule may only cause the system to *ask*. It may never add an accessorial to the set on its own. An accessorial is a priced line the customer pays for, so it is set ONLY by the canonical customer-request path (`update_quote` / form chips / wizard) or the geocoder/RDI, exactly as with residential. **Nothing does this today** — verified 2026-07-31: `rateBreakdown` and `rateRemarks` are display-only (the breakdown modal and the rate `note:` field), there is no carrier-rules map, and the only code that pushes `APD` from text is `_claimedAccessorialCodes` (which *corrects*, never writes) and `parseQuoteChat` (which parses the **customer's** message). But nothing stops a future change from doing it and **no test forbids it**, which is why it is written down. Related open defect: `parseQuoteChat` matches a bare `/\bappointment\b|\bappt\b/i`, so *discussing* an appointment adds `APD` — the same over-eager-parse class as `26 PO #123` parsing as a street address, and the same fix shape: require an explicit request, not a keyword.
- **Carrier rules the agent states must exist in `KNOWLEDGE.md` (pending, 2026-07-31):** the residential→appointment rule is **not in the system anywhere** — not in `KNOWLEDGE.md`, not in `_convoSysPrompt`, no carrier map. On BOL 160135796 the agent stated it as a system fact ("JTS Express requires an appointment at delivery accessorial when residential delivery is selected") sourced from training data. That is the fabrication class recorded at `portal.html:2960`, where the agent invented **the same per-carrier appointment claim** for a failure identical on every carrier. The rule being TRUE in the real world does not make stating it a system fact correct. **Action for next session:** Felipe to confirm the exact wording and which carriers bundle vs charge separately; then it goes into `KNOWLEDGE.md` as a stated fact so the agent stops reconstructing it.
- **Agent prose is never a source of truth for shipment state (product contract):** an accessorial or residential classification may be set ONLY by the canonical customer-request path (`update_quote` / form chips / wizard) or by the geocoder/RDI — never inferred from what the agent *says*. If the agent claims an accessorial was added but no tool call backed it, the system makes the claim FALSE and corrects the text; it must never write state to make the claim true (that fabricates agreement the customer never gave → a silent over-quote). The `_gateFinalText` 2d block enforces this: it corrects an unbacked accessorial claim and writes nothing. This is the mirror of the promise-without-action enforcer, which is legitimate because it fires a REAL tool call to satisfy a claim about an action the customer actually requested.

---

## State management

All conversation-scoped state is owned by `resetShipmentState(wipeConversation)`. Call it at every boundary:
- `resetShipmentState(true)` — new chat, switching chats
- `resetShipmentState(false)` — fresh quote in the same chat

Never scatter state resets — always go through this chokepoint. Adding a new piece of conversation state? Add its reset here too.

Key globals: `_lastRates`, `_lastRatesRaw`, `_lastRatesShipment`, `_lastBooked`, `_bookingLock`, `_lastPulledSig`, `_resWarnShown`, `_editingBOLId`, `_editingShipment`, `_requoteContext`, `lastQuotedShipment`.

**STATE HANDOFF RULE (quote → rate → book):** Any freight field that flows through the quote→rate→book lifecycle (weight, dims, freightClass, packageType, hazmat, unNumber, nmfc, stc, accessorials) must be verified to survive EVERY handoff before a change is declared done. The handoff chain is: the quote form / `_applyQuoteFields` (form + agent paths) → `fetchRates` freightInfo builder → `_publishRatesForAI` → `lastQuotedShipment` → the booking payload builder (`s.items`) and the booking form's field reads (e.g. `fHaz` from `lastQuotedShipment.items[0].hazmat`). `lastQuotedShipment` is the shared chokepoint between rating and booking; if `_publishRatesForAI` does not sync it, the booking form and book call read stale data. When editing any lifecycle field, trace and confirm all readers AND writers of that field across this chain — do not fix only the one builder named in the task.

---

## Design rules

- **Two-tone palette only:** `#bd27bc` (CSS var `--ac`) for primary actions and active states. Everything else in neutral grays. No competing accent colors.
- **Button hierarchy:** primary (purple fill) = the main action. Secondary (gray fill) = alternatives. Ghost (purple outline) = low-commitment actions like Requote.
- **Never show $NaN** — always use `parseMoney()` to parse rate values; it strips `$`/commas before parsing.
- CSS variables like `var(--bdr)` do not resolve in dynamically-set inline styles — hardcode hex values (`#c8c4bc`, `#e5e2d9`).
- Email HTML must use table-based layouts — Gmail strips `display:flex` and CSS filters.

---

## Tech stack

- **Portal:** single-file HTML pages in `felipeliberman/freight-portal` — `index.html` (landing) and `portal.html` (~24.6k lines — all the app work happens here), plus a small `admin.html` terms panel. (`demo.html` was retired in commit `b88cfdf`; the inline demo now lives on the landing page.) **Hosting:** production is **Cloudflare Pages** (canonical — `functions/_middleware.js` allowlists what's publicly served); `felipeliberman.github.io` is a **legacy GitHub Pages mirror** still serving (the `_config.yml` is a leftover from that era). Deploy verification polls all three URLs.
- **AI agent:** `claude-sonnet-4-6` via Anthropic API, tool-use loop (max 5 iterations), client-side tools: `update_quote`, `read_rates`, `book_shipment`, `dispatch_shipment`, `update_booking`.
- **Primus API:** `https://freightandlogistics-api.shipprimus.com` — book: `POST /applet/v1/book`, update: `PUT /applet/v1/book/{BOLId}`, dispatch: `POST /applet/v2/dispatch/{BOLId}` (note `v2`), rates: `GET /applet/v1/rate/multiple`. **List reads differ:** `/applet/v1/book` supports server-side `dateFrom`/`dateTo` filtering (primary lists use `limit=100`); `/applet/v1/invoice` honors ONLY `limit` (=100) and `page` — it ignores `dateFrom`/`dateTo`/`sort`, so windowing is reverse-paged and filtered client-side. Do not assume `/invoice` can date-filter.
- **Stripe:** Financial Connections for ACH, `setup_future_usage: off_session`. `collectBankAccountForPayment` requires `billing_details.name`.
- **Geocodio:** residential detection via `zip4.residential === true`. US only.
- **Cloudflare Worker:** `stripe-payments.felipe-b80.workers.dev` — payments + SendGrid email. Keys hardcoded (lost on redeploy).
- **SendGrid:** verified sender `support@freightandlogistics.com`.

---

## Test account

**Haynes Brothers Furniture** — Primus customer ID `1123086640`. The designated **write-test** account: book, edit, save, dispatch, appointment. All testing before any customer-facing launch goes through it.

**Why it is safe, which is the part that keeps getting lost:** Haynes books **exclusively by email** — they ask for quotes and we create them on their behalf. They have **no portal access and do not know the login**. Nothing created on that account is ever customer-visible, so a saved BOL there cannot surface to them. This is a fact about their access, not an assumption that they "probably won't look."

**Rules:**
- **Cancel test BOLs when you are finished** — My Shipments → open the shipment → Cancel Shipment. Do this even though they are invisible; do not leave phantom freight on a real customer's account.
- **Never Simply Nursery.** They are live in the portal, they log in, and they would see it. Same for any other account with portal access.
- A dispatch that succeeds is real regardless of account: it tenders freight, notifies a carrier, and on a prepaid account charges a card. Being on Haynes makes the BOL invisible, not the tender reversible.

**History, so this is not re-litigated a third time:** on 2026-07-27 this was reversed to "no test writes on Haynes," on the reasoning that they are a real customer and "they never look at the portal" was an unsafe assumption. Reinstated 2026-07-30 by Felipe with the fact that assumption was missing — they have no portal access at all. If you are about to move this again, the question to answer is "can this account's users see it?", not "is this a real customer?"

---

## Regression checklist — run after every change

1. **Quote → book → dispatch:** rates pull, agent asks for pickup day/window, one BOL, dispatch fires confirmation once.
2. **Partial save → edit → dispatch:** Save goes through with missing fields, button locks after save, Edit pre-fills the form, Save keeps same BOL number, Ready to Dispatch works.
3. **New-chat isolation:** new chat starts blank — no stale rates, no stale form, no stale addresses.
4. **Residential safeguard:** residential delivery address triggers the warning before booking — **on the FORM paths only.** The chat paths (`book_shipment` / `save_shipment` / `dispatch_shipment`) have no check at all today; do not check this item off against a chat booking and conclude it passes.
5. **Pickup date rules:** past dates auto-bump to next business day, weekends never allowed.
6. **No duplicates:** booking twice or saving twice never creates two BOLs.

---

## What only the human can verify

- Does it look right on a real phone?
- Did Primus actually accept the dispatch on the Haynes Brothers account?
- Does the freight logic match real-world brokerage practice?
- Is the UX clear to a non-technical furniture customer?
