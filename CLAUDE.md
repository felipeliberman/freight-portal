# FreightAI Portal — Claude Code Rulebook

This is the source of truth for developing the FreightAI customer portal. Read this before touching anything.

---

## What this product is

A conversational AI-powered TMS (Transportation Management System) customer portal for Freight and Logistics, Inc. — a nationwide LTL and white glove freight brokerage based in Los Angeles, in business since 2010. The portal layers Claude (claude-sonnet-4-6) as a conversational agent on top of Primus (ShipPrimus), the existing TMS backend. Customers quote, book, and dispatch freight entirely through chat or a form UI.

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
