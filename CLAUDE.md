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
- **Residential detection:** use Geocodio (`zip4.residential === true`) on the delivery street address. Ask the customer directly for Canadian addresses (Geocodio is US-only).
- **Pickup dates:** Monday–Friday only. If a date falls on a weekend, bump to the next Monday. Never allow a past pickup date — auto-bump to next business day and show a note.
- **Valid Primus accessorial codes:** LFD (liftgate delivery), LFO (liftgate pickup), RSD (residential delivery), IND (inside delivery), LAD (limited access delivery), NAO (limited access pickup), APT (appointment). Do NOT use RSP, NAD — Primus rejects them.
- **NMFC is optional** — offer it, never require it.
- **Cargo insurance commodity (Option B — product contract):** when the quote already carries a mappable commodity, insurance settles silently in that turn with the read-back ("Cargo insurance requested — [category] ([commodity]), declared value $X.XX"). The numbered commodity list renders ONLY when the commodity is unknown or unmappable, and it mirrors the form dropdown from the one canonical source (`REDKIK_COMMODITIES`). The customer can always change it ("change the commodity" / "the commodity is wrong") — even after insurance is set; the declared value is preserved and rates re-pull so the premium follows the category.
- **Customer-facing copy never sends customers to the phone (product contract):** customer-facing chat replies, error/fallback states, overlays, and toasts direct to email — `support@freightandlogistics.ai` (and/or the in-app Email Support panel) — NEVER a phone number or "call us" phrasing. The canonical failure line (`AGENT_FAIL_MSG`) and rate/write error copy (`RATE_SUPPORT`) are email-only and must stay that way. Out of scope (left as-is): the "Talk to Our Team" phone link in the site chrome, and formal transactional document footers (invoice/receipt/email letterhead).
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

- **Portal:** three single-file HTML pages in `felipeliberman/freight-portal` on GitHub Pages — `index.html`, `demo.html`, `portal.html` (~15k lines, all the work happens here).
- **AI agent:** `claude-sonnet-4-6` via Anthropic API, tool-use loop (max 5 iterations), client-side tools: `update_quote`, `read_rates`, `book_shipment`, `dispatch_shipment`, `update_booking`.
- **Primus API:** `https://freightandlogistics-api.shipprimus.com` — book: `POST /applet/v1/book`, update: `PUT /applet/v1/book/{BOLId}`, dispatch: `POST /applet/v2/dispatch/{BOLId}`.
- **Stripe:** Financial Connections for ACH, `setup_future_usage: off_session`. `collectBankAccountForPayment` requires `billing_details.name`.
- **Geocodio:** residential detection via `zip4.residential === true`. US only.
- **Cloudflare Worker:** `stripe-payments.felipe-b80.workers.dev` — payments + SendGrid email. Keys hardcoded (lost on redeploy).
- **SendGrid:** verified sender `support@freightandlogistics.com`.

---

## Test account

**Haynes Brothers Furniture** — Primus customer ID `1123086640`. All testing before any customer-facing launch goes through this account.

---

## Regression checklist — run after every change

1. **Quote → book → dispatch:** rates pull, agent asks for pickup day/window, one BOL, dispatch fires confirmation once.
2. **Partial save → edit → dispatch:** Save goes through with missing fields, button locks after save, Edit pre-fills the form, Save keeps same BOL number, Ready to Dispatch works.
3. **New-chat isolation:** new chat starts blank — no stale rates, no stale form, no stale addresses.
4. **Residential safeguard:** residential delivery address triggers the warning before booking.
5. **Pickup date rules:** past dates auto-bump to next business day, weekends never allowed.
6. **No duplicates:** booking twice or saving twice never creates two BOLs.

---

## What only the human can verify

- Does it look right on a real phone?
- Did Primus actually accept the dispatch on the Haynes Brothers account?
- Does the freight logic match real-world brokerage practice?
- Is the UX clear to a non-technical furniture customer?
