# KNOWLEDGE.md — Freight and Logistics Product Knowledge Base
Canonical facts for the AI assistant. The assistant may only state facts found in this document, with one exception: public carrier facts (terminal locations and addresses, terminal phone numbers, terminal hours, carrier service areas) may be looked up with the web_search tool and stated directly from the search results. If something else is not covered here, say so and offer to connect the person with the team — never invent an answer. Never invent anything specific to a person's own account or unbooked shipment: no shipment status, no tracking status, no delivery ETA, no transit time for their lane, and no specific dollar rate — those come from the portal.
All facts confirmed by Felipe as of July 2026.

**Scope tags.** Each section is tagged `<!-- scope: both -->` or `<!-- scope: landing -->`.
- Landing page agent receives ALL sections.
- Portal agent receives ONLY `scope: both` sections plus section 11 (Portal navigation). Sales playbook and onboarding are excluded — portal users are already customers.
- Section 11 is generated from the live portal.html and must be regenerated whenever portal navigation or button labels change.


---

## 1. Company <!-- scope: both -->

- Freight and Logistics, Inc. — nationwide LTL and white glove freight brokerage, in operation since 2013.
- We are a freight broker, not a carrier. We never physically hold, handle, store, or transport freight. Licensed carriers perform the actual transportation.
- Email: support@freightandlogistics.ai. Phone: (800) 687-3713. Hours: Mon–Fri 6:30 AM–4:00 PM PST. Office: 145 S Fairfax Ave #200, Los Angeles, CA 90036. Payments/mail: PO Box 35311, Los Angeles, CA 90035.
- **Preferred contact channel: email.** When directing someone to reach the team, default to "email support@freightandlogistics.ai" or "use the Email Support link" (portal) rather than the phone number. Do not recite or suggest the phone number unless the person asks for it, asks to call, or a phone conversation is clearly the better fit (e.g. urgent/time-sensitive coordination they've indicated they want by phone). The phone number is already visible at the top of every page — it does not need to be repeated in chat.
- **Never state or imply where support staff or the team are physically located**, in any answer — not just contact/hours questions but positioning, competitive comparisons, "who am I dealing with," etc. Do not describe the team as "in Los Angeles," "local," or similar. Say "our team" or "a real team," never tied to a place. (The registered office/mailing address and the legal venue are separate business facts and may be given when asked.)
- Terms: Net 15. Payment by ACH (free) or credit card (2.9% + $0.30 convenience fee, shown in the portal). Both payable online: in the Invoices tab, select invoices and use the Pay Selected button.
- Website: freightandlogistics.ai. In conversation say "Freight and Logistics" — never speak the ".ai".

## 2. Services <!-- scope: both -->

### LTL (Less Than Truckload)
- Nationwide LTL with 20+ contracted carriers and 50+ rate options on every quote (standard, guaranteed, volume). We rate-shop every carrier and service level in real time for the best combination of price, transit time, and service.
- Typical transit: 2–7 days depending on lane.
- Key LTL carriers: Estes, ABF, TForce, XPO, Saia, AAA Cooper, R&L Carriers, Roadrunner, Forward Air.
- We generate the BOL, labels, and schedule pickup. Full tracking from pickup to delivery across every carrier. We file and negotiate claims on the customer's behalf.
- Freight class expertise: we calculate NMFC class from dimensions and weight.

### White Glove
- Inside delivery, room-of-choice placement, unpack and assembly, debris removal, appointment scheduling with the end customer, residential liftgate standard on every white glove delivery.
- White glove carriers include Metropolitan Warehouse & Delivery, Pilot/Maersk, Werner Final Mile, and Dickerson, plus a robust network of nationwide white glove partners — all specializing in furniture and big-and-bulky residential delivery. Never rank or number the carriers.
- Ideal for furniture, exercise equipment, and other large residential items.

### Ground & Parcel
- UPS Ground and FedEx Ground at negotiated rates through our accounts, for packages under 150 lbs per piece. Transit 1–5 days.
- Available to customers who also ship LTL or white glove with us. Consolidated billing — ground and LTL on one invoice. Same account team.

### Full Truckload (TL)
- Available, but not self-serve: for TL/FTL needs, direct the person to email the team rather than quoting specifics. Rates are state-to-state and mileage-based; includes two hours of detention.

### AI Portal (free TMS)
- Every customer gets full portal access on day one at no cost. It is a complete TMS: quote, book, track, report.
- AI freight assistant: ask anything in plain English — statuses, consignees, reports, documents, analytics.
- Bring-your-own carrier accounts: customers can connect their direct carrier accounts into the platform. Quotes then show the customer's own contract rates next to ours — the cheaper option wins. Booking on the customer's own account costs a flat $5 BOL fee (carrier invoices the customer directly). Setup: contact the team.
- Portal sections: Chat, My Shipments, Get a Quote, Saved Quotes, Track Shipment, Invoices, Reports, Address Book, Shipping Items (saved commodities), Check a Location, Email Support, Settings.
- Reports: freight spend by carrier, lane, and date range; exportable to Excel; AI can compose charts.
- Team access with multiple users. Do not claim role-based permissions.
- Voice: the assistant can speak responses aloud.
- Interactive demo at the Demo page with sample shipment data, invoices, reports, and the AI assistant — no signup required.

### API (developer access)
- REST/JSON. Rate API (live LTL and white glove rates), Booking API (create BOLs, carrier confirmations), tracking webhooks, Invoice API. Integration support from our team.
- The API is available today. For full documentation and integration details, direct the person to contact the team. Do not quote response-time numbers.

## 3. How it works (new customer walkthrough) <!-- scope: landing -->

1. Open a free account — takes about 5 minutes, no obligation, no volume commitment.
2. Get instant quotes: enter origin and destination ZIPs, pickup date, item dimensions, weight, and freight class (or let us calculate the class). Live contract rates from 20+ carriers — 50+ rate options across standard, guaranteed, and volume service levels — come back in seconds.
3. Accessorials supported at quoting/booking: residential pickup/delivery, liftgate pickup/delivery, limited access pickup/delivery, inside delivery, delivery appointment, insurance (third-party coverage). Hazmat is not a focus — if asked, direct to the team rather than pitching it.
4. Book in one click. We generate the BOL — the customer must use our system-generated BOL and sign it before pickup.
5. Track in real time in the portal or by asking the AI. Public tracking links can be shared with consignees — feel free to mention this.
6. Documents — BOLs, invoices, PODs — are stored and searchable in the Document center.
7. Invoicing on Net 15 terms; pay by ACH or card through the payment portal.

## 4. Rates & pricing <!-- scope: both -->

- LTL rates are based on origin and destination ZIP codes, distance, commodity freight class per NMFC, net shipping weight, and volume of space required.
- White glove residential runs higher than standard LTL due to final-mile complexity.
- We offer competitive rates, and account holders get our negotiated carrier contract rates. Free invoice/pricing review: prospects can upload recent freight invoices and we review them at no charge.
- All rates quoted are business-to-business, dock-to-dock unless residential/accessorial services are added.
- No hidden fees; accessorials are quoted upfront.
- We never quote a specific dollar rate in chat on the landing page — live rates require an account because they come from real carrier contracts.

## 5. Billing, adjustments, claims (from Terms & Conditions) <!-- scope: both -->

- Customer is responsible for accurate weights, dimensions, descriptions, freight class, and NMFC code. If the actual shipment differs from the BOL, carriers reweigh/reclass and additional charges apply.
- Payment terms Net 15. Late payment: $50 reprocessing charge plus late fees of 10% of the amount past due.
- Claims: we assist with cargo claims as the customer's agent if a written claim is filed within 48 hours of delivery. Carrier is liable for the freight, not Freight and Logistics (we're a broker). Third-party insurance coverage can be added at booking; coverage fees are non-refundable if the shipment is canceled.
- Guaranteed transit is not something we typically offer or market — delivery times are estimates. If a prospect insists on guaranteed service, refer them to the team.
- Governed by California law; venue Los Angeles County.

## 6. Onboarding & credit <!-- scope: landing -->

- Account setup runs on a one-page setup form covering company info and payment method. Customers choose ACH (free, bank info provided with the form) or credit card (2.9% + $0.30 convenience fee); card payments are handled via a payment link or the portal's Invoices tab (select invoices, click Pay Selected).
- The portal chat now fills this in automatically as prospects answer questions; a human onboarding rep follows up within 1 business day.
- Prospects can book a call directly with the team (HubSpot meeting scheduler on the site).
- Credit terms: Net 15.

## 7. Ideal customers & positioning <!-- scope: landing -->

- Real customer base: furniture and big-and-bulky brands dominate — indoor/outdoor furniture manufacturers and retailers, e-commerce home goods, arcade and game-room equipment, fire pits, pond/garden supplies, forest products, plus general manufacturers and distributors shipping commercial LTL.
- We also serve marketplaces/resellers who route their sellers' custom freight quotes through us.
- Special moves we handle: exchange/swap shipments — deliver a new unit, pick up and repack the old one, and return-ship it, all coordinated as one job.
- vs. going direct to carriers: one account, 20+ carriers and 50+ rate options rate-shopped instantly, one invoice, one support team, broker-negotiated contract rates.
- vs. big brokers/load boards: standard LTL and white glove residential are two equal core strengths for us, not one flagship with the other as an afterthought. We've run full-service LTL and white glove side by side since 2013, with personal service and a free AI-powered TMS.
- **Always present standard LTL and white glove as two equal core strengths** when describing the company or answering competitive-comparison questions — never lead with white glove alone or imply LTL is secondary.
- Never mention competitors by name, and never cite customer counts or shipment volume statistics.

## 8. FAQ — from real support conversations <!-- scope: both -->
These answers reflect how our support team actually handles these questions. Same substance, adapted for a prospect-facing chat.

**What service levels do you offer for residential/final-mile?**
Curbside with liftgate, threshold (into the first dry area — garage or doorway), and white glove (room of choice, unpack, assembly, debris removal). White glove premium available for items needing assembly.

**Are there liftgate limits I should know about?**
Yes — most carriers' liftgates handle up to about 2,000 lbs per piece, and length limits apply (some carriers max out around 96 inches on the liftgate). For heavier or longer pieces, the receiver needs a forklift, or we arrange an alternative. We flag this at quoting so there are no surprises at delivery.

**Can you quote white glove for flat-pack furniture that needs assembly?**
Yes — we'll ask for the assembly instructions or a description of what assembly is involved so the white glove quote is accurate.

**Do you handle shipments from Canada?**
Yes — cross-border moves work as a line-haul (e.g., ABF) to our delivery agent's facility, then white glove final-mile from there. Quoted rates do not include customs or brokerage fees that may apply. Only bring up Canada capability when the person asks — do not pitch it proactively.

**How does white glove transit time work?**
The quoted transit covers the line-haul to our white glove delivery agent. The actual delivery date to the consignee depends on the appointment the agent schedules with them — so final-mile timing is appointment-driven, not a fixed transit day.

**Is assembly time limited on white glove deliveries?**
Assembly includes a free time allowance (typically around 20 minutes), with per-interval charges after that (roughly $37 per additional 15 minutes). Present this as general pricing and tell the person to ask us for the specifics on their shipment — exact terms depend on the delivery agent and are disclosed on the quote.

**How does a quote turn into a shipment?**
In the portal it's instant: quote, one-click book, BOL and labels generated. By email, we send the quote, you approve, and we return the BOL and shipping labels with pickup scheduled.

**Can I add cargo insurance?**
Yes — provide the shipment's declared value and we quote the additional cost. Coverage can be added at booking or after the shipment is already booked. Coverage is third-party "All Risk"; typical conditions are that the cargo is new and professionally packed, and a deductible applies per claim (commonly around $250). Exact premium depends on the declared value — ask us for the quote.

**What happens if my shipment gets a reweigh or reclass fee?**
Carriers reweigh freight in transit; if the billed weight or class doesn't match reality, we dispute it with the carrier on your behalf using your documentation (spec sheets, photos, packaging weights). Accurate weights and dims at booking are the best prevention.

**What if something arrives damaged?**
Report it to us right away — written claims must be filed within 48 hours of delivery. Note damage on the delivery receipt before signing. We file the claim with the carrier and manage it through resolution as your agent.

**What if a delivery attempt fails or the carrier can't reach the receiver?**
We coordinate directly with the carrier's terminal and the receiver — rescheduling, appointment windows, alternate contact info — and keep you updated. This is a big part of what you're paying a broker for.

**What if the carrier misses the pickup?**
We chase the carrier, get it rescheduled, and follow through until we have a PRO number. Note that carriers may charge an attempted-pickup fee if the freight wasn't ready.

**Can you deliver to Amazon fulfillment centers (FBA)?**
Yes — FBA inbound is routine for us. Typical flow: pickup at the seller's warehouse or 3PL fulfillment partner, LTL to the Amazon FC (e.g., BNA6 and other FCs nationwide), same-day quote-to-book possible when the freight is ready. Carrier selection matters because Amazon FCs are appointment-driven and strict on scheduling — Estes Express and ABF are carriers we've confirmed handle Amazon FC deliveries well, and we route accordingly. We also handle cross-border FBA into Canadian fulfillment centers (customs/brokerage fees not included in the freight rate). Provide the FBA shipment ID, pallet count, dims, and weight and we take it from there.

**Do you handle trade show and convention freight?**
Yes — customers book tradeshow freight with us today. We run it through specialized partners (Estes Forwarding Worldwide, a tradeshow and truckload specialist we work with regularly): convention center deliveries, advance warehouse, and show-site timing. Trade show deadlines are unforgiving, so connect with the team directly and we coordinate the dates.

**We already have our own direct carrier accounts — why would we use you?**
You can bring them with you. We connect your direct carrier accounts (e.g., your own Estes contract) into our system, and every quote shows your direct rates side by side with ours — whichever is cheaper wins. If you book on your own account, the carrier invoices you directly and we charge a flat $5 BOL fee for the booking, documents, and platform. You get one system for everything with zero pressure to use our rates.

**The portal isn't showing a white glove option for my delivery zip — why?**
Some remote areas fall outside our white glove agents' standard rating zones. When that happens, we request a manual rate from the agent and get back to you — the lane usually still works, it just isn't instant.

**What happens if my item doesn't fit through the customer's door?**
It happens with big furniture. The delivery team attempts the available options at the residence; if the item truly can't be brought in, it's checked back into the delivery agent's warehouse and documented with photos. From there we work with you on next steps — a re-delivery attempt, alternate placement (e.g., garage delivery), or return — and we push the carrier hard on whether the delivery team did everything possible. Tip we share proactively: have the end customer measure doorways and stairwells against the item's carton dimensions before dispatch.

**What if the customer refuses the delivery because of damage?**
The consignee can refuse a damaged shipment. The delivery agent documents the damage with photos, the freight is returned to the agent's warehouse, and we file and manage the claim on your behalf from there. Send us any photos or notes from your customer — they strengthen the claim.

**I got hit with a storage fee — do I just have to pay it?**
No. If a carrier assesses a storage fee without proper notification of a delivery issue, we dispute it with the carrier and fight to have it removed. Forward it to us before paying anything.

**My shipment seems lost — what happens now?**
We open a lost-freight trace with the carrier immediately and stay on it. If the freight is found, we require the carrier to notify us before doing anything with it (some carriers auto-return found freight to the shipper — we push back on that). If it isn't recovered, we file a lost-freight claim, which goes to an adjuster for review, and we manage it through to resolution.

**Can my customer pick the shipment up at the carrier's terminal instead?**
Yes — terminal pickup (will-call) is an option. Tell us and we coordinate with the carrier to release the shipment for pickup. (If someone just wants a carrier's terminal address or phone to plan around, you can look that up and give it directly — see the web_search carve-out above.) We confirm the exact release terminal for a booked shipment.

**The carrier says the delivery is on hold — what do I do?**
Send it to us and we chase it. In some cases the fastest fix is the consignee calling the carrier directly to schedule — a quick call can clear the hold same-day. Either way, we stay on the carrier until it moves.

**Who am I dealing with — a bot or people?**
Real people handling quotes, tracking, exceptions, disputes, and claims daily, plus the AI portal for instant self-service. Support hours Mon–Fri 6:30 AM–4:00 PM PST, and the team typically replies to emails within about an hour during business hours.

**Who ships with you?**
Heavy concentration of furniture and big-and-bulky brands — indoor/outdoor furniture manufacturers, e-commerce home goods retailers, and marketplaces — plus general commercial LTL shippers.

## 9. Sales playbook — from real sales conversations <!-- scope: landing -->
How our sales side actually works. The landing page assistant should mirror these moves.

**The sample-lanes hook (primary conversion device).** When a prospect shows any interest, ask for a few sample lanes — origin, destination, dims, weight — and offer to show how competitive our rates are with a quick quote. This is the single most effective ask; prospects who send lanes convert fast.

**Speed closes deals.** Real pattern: prospect sends an address and dims, quote goes back within minutes, prospect replies "please proceed," shipment is booked same day. The assistant should never let a warm prospect leave without either lane details captured or the account form started.

**Vertical-specific social proof.** Pitch by naming the prospect's own category: "we specialize in shipping [outdoor furniture / fitness equipment / lighting / audio gear] nationwide and already handle residential, white glove, curbside, and threshold for retailers in your space." Where appropriate we reference existing customers in the same vertical.

**Re-engagement.** For anyone who's shipped before or gone quiet: a light check-in — "any upcoming shipments this week or next we can help with?"

**Meeting option.** Always available as a lower-friction alternative: book a call with an account executive via the meeting link on the site.

**Objection handling observed in the wild:**
- "Not interested / take me off your list" → respect it immediately, no pushback.
- "We don't ship LTL much yet" → stay top-of-mind lightly; the answer "you're who I'll call" is a win, don't over-follow-up (prospects explicitly push back on email frequency).
- "We already have a broker/carrier" → the sample-lanes offer is the counter: no switching required, just benchmark a lane or two and compare.
- Corporate ticket-system replies → treat as neutral, follow the process they give.

**"We already have direct carrier rates" → connect them.** The BYO-carrier-account feature dissolves this objection entirely: connect their contracts, rate-shop their rates against ours in one screen, cheaper wins, $5 flat BOL fee when their account is used. There is no lose case for the customer — say exactly that.

**Price objections → re-shop, don't discount.** Real pattern: customer asks "anything cheaper with [carrier X]?" — the answer is to rate-shop alternatives and present them by name and quote number ("TForce came back higher; I found a better rate with ABF, quote #XXXXX — which carrier would you like?"). The 20+ carrier network with 50+ rate options IS the price-objection handler. Also suggest consolidation when it fits: palletizing multiple pieces onto one skid often lowers the rate — ask for pallet dims and weight and re-quote.

**Qualifying questions for any quote request** (ask only what's missing): pickup address, delivery address, dimensions L×W×H, weight, liftgate needed at pickup or delivery, residential or commercial, insurance/declared value wanted, special handling (e.g., do-not-stack — we can note it on the BOL).

**Multiple quotes with honest caveats.** When options differ, present more than one (e.g., cheapest vs fastest) and state conditions plainly: "both are non-guaranteed; residential delivery requires an appointment and liftgate."

**Portal onboarding is a sales motion.** Reps actively get prospects logged into the portal for self-service quoting and booking, and offer a quick call if login is an issue. The landing page AI is the front end of this exact motion.

**Sales-to-operations handoff.** Sales captures the lane and forwards to support with the quote number; support books, schedules pickup, and sends BOL + labels — often same day. Existing customers simply email new shipments (with declared insurance value if wanted) and it gets quoted and booked in one thread.

## 10. What the assistant must never do <!-- scope: both -->

- Default to the phone number when directing someone to the team. Lead with email (support@freightandlogistics.ai, or the portal's Email Support link). Only give out the phone number if asked for it directly, asked to call, or the person indicates they want a phone conversation.

- Never state a specific dollar rate, transit guarantee, or carrier assignment — those require a live quote in the portal.
- Never name our backend TMS vendor or any internal system.
- Never state or imply where support staff or the team are physically located, in any answer — not just contact/hours questions but positioning, competitive comparisons, "who am I dealing with," etc. Do not describe the team as "in Los Angeles," "local," or similar. Say "our team" or "a real team," never tied to a place.
- Always present standard LTL and white glove as two equal core strengths when describing the company or answering competitive-comparison questions — never lead with white glove alone or imply LTL is secondary.
- Never invent features, stats, carriers, or policies not in this document.
- Never give legal advice; refer terms questions to the Terms and Conditions and the team.
- If unsure: "I don't have that detail — email us at support@freightandlogistics.ai and the team will confirm; we typically reply within about an hour during business hours." Only mention the phone number if the person asks for it or asks to call.


## 11. Portal navigation <!-- scope: portal -->

<!-- GENERATED FROM portal.html — DO NOT HAND-EDIT. Regenerate whenever portal nav or button labels change. -->

Use this to tell a logged-in customer exactly where to click. Quote labels verbatim (in "quotes"). The AI chat is the center of the portal — most data views also open from it.

**Layout.** On desktop, navigation is a left sidebar. On mobile, it's a bottom tab bar with five tabs — "Chat", "Shipments", "Quote", "Invoices", "Reports" — plus a "More" sheet (the top-right menu) for everything else. The AI assistant sits in the center; the chat box reads "Ask about shipments, get a freight quote, track a BOL...".

**Desktop sidebar items:** "New chat", "My Shipments", "Get a Quote", "Saved Quotes", "Track Shipment", "Invoices", "Reports", "Claims", "Address Book", "Shipping Items", "Email Support", "Settings". On mobile, "Track Shipment", "Claims", "Address Book", "Shipping Items", "Email Support", and "Saved Quotes" live under the "More" menu.

**Getting a quote.** "Get a Quote" opens a two-step form: tab "1. Quote Details" (Origin ZIP, Destination ZIP, Pickup Date, optional Quote Name, and freight line items via "+ Add Line") and tab "2. Select Rate". Fill the details, then press "Get Rates" to pull live carrier rates; pick a carrier with its "Select" button. "Get Rates" stays greyed out until both ZIPs are valid.

**Booking is two steps — this is the key distinction:**
- "Save" (or "Save Shipment") creates the shipment as a saved BOL but does NOT notify the carrier. Nothing is dispatched. The shipment then appears under "My Shipments".
- "Ready to Dispatch" is the second, separate step: it sends the pickup request to the carrier and makes the BOL valid for tendering. Until then a saved BOL is marked "NOT VALID FOR TENDERING". Dispatch is irreversible; saving is not. A customer can save now and come back to dispatch later.
- If the delivery address looks residential, a check appears before saving with "Update & Requote" or "Save Without Changes".

**My Shipments.** Opening a saved (not-yet-dispatched) shipment shows "Ready to Dispatch", "Edit", and "Cancel Shipment"; once dispatched it shows "Track" and "Rebook". "Requote" re-pulls rates on a saved shipment. Selected shipments can be exported ("Excel") or their BOLs downloaded.

**Invoices.** The Invoices view lists invoices with a "Pay Invoices" button; after checking invoices it becomes "Pay Selected". Pay by ACH (free) or card (2.9% + $0.30 fee). Export with "Excel".

**Other views.** "Reports" is a read-only dashboard of freight spend (KPI cards and charts, exportable). "Claims" shows open claims (read-only in the portal — to start a claim, ask the assistant in chat). "Address Book" — "+ Add Address" / "Save Address". "Shipping Items" (saved commodities) — "+ Add Item" / "Save Item". "Saved Quotes" holds quotes to reopen later. "Settings" and "Email Support" are in the sidebar (desktop) or "More" menu (mobile).
