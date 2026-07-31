// Layer-2 flow cases — CHAT + QUOTING only. Each drives the REAL portal turn pipeline and asserts on
// STATE and CAPTURED PAYLOADS, never on agent prose. Case shape mirrors evals/state/invariants.js:
//   { id, name, catches, expectFail?, fixedBy?, async run(h) }  — h is the boot2 context.
// A run() that does not throw = PASS (or, if expectFail, UNEXPECTED-PASS → suite fails).

const { A, sleep, text, toolUse, turn, appScript, fx, L2FX } = require('./harness');

// Poll until fn() is truthy or the budget elapses (no fake timers in this suite).
async function waitFor(fn, ms) {
  const budget = ms || 1500;
  for (let i = 0; i < budget / 25; i++) { if (fn()) return true; await sleep(25); }
  return !!fn();
}
const READY = { originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 };

// The BOL behind case 25 — booked at $161 with NO accessorials, i.e. BOL 160135778 as it stood when
// the customer answered the residential hold. Shared so both requote doors start identically once
// the second door (the hold) exists; see the numbering note at case 25.
const L2FX_REQUOTE_SHIP = {
  BOLId: 'BOLID-778899', BOLNumber: '160135778',
  shipper:   { name: 'Michaels Furniture', address1: '7240 Crider Ave', city: 'Pico Rivera', state: 'CA', zipCode: '90660' },
  consignee: { name: 'Dana Whitfield', address1: '1145 S Clark Dr', city: 'Los Angeles', state: 'CA', zipCode: '90035' },
  freightInfo: [{ qty: 1, weight: 450, length: 48, width: 40, height: 48, class: '175', commodity: 'Furniture', dimType: 'PLT' }],
  accessorials: [], pickupInformation: { date: '2026-08-04' },
};

// Mid-booking, ready to write: a selected rate, the booking panel rendered and FILLED, and a book
// route shaped like Primus's (data.results[0]) so submitBookingOnly reaches a real POST. Used by the
// draft-save consent cases, which have to distinguish "did not write" from "could not write".
async function openBookingReady(h) {
  const w = h.win;
  h.routes.unshift({
    match: (u, m) => /\/applet\/v1\/book(\?|$)/.test(u) && m === 'POST',
    reply: () => ({ status: 200, body: { data: { results: [{ BOLId: 'BOLID-SAVE42', BOLNumber: '160042042' }] } } }),
  });
  w._lastRatesRaw = [{ id: 'R1', name: 'JTS Express', total: 161 }];
  w.selectRate(w._lastRatesRaw[0], { shipment: { originZip: '90660', destinationZip: '90035' }, list: w._lastRatesRaw, open: false, source: 'test' });
  w.showBookingPanel({ id: 'R1', name: 'JTS Express', total: 161, _name: 'JTS Express', _price: 161 },
    { originZip: '90660', destZip: '90035', accessorials: [] });
  await sleep(300);
  const set = (id, v) => { const e = w.document.getElementById(id); if (e) e.value = v; };
  set('bk-pu-name', 'Michaels Furniture'); set('bk-pu-street', '7240 Crider Ave'); set('bk-pu-city', 'Pico Rivera');
  set('bk-pu-state', 'CA'); set('bk-pu-zip', '90660'); set('bk-pu-contact', 'Jo'); set('bk-pu-phone', '5625550100');
  set('bk-dl-name', 'Dana Whitfield'); set('bk-dl-street', '1145 S Clark Dr'); set('bk-dl-city', 'Los Angeles');
  set('bk-dl-state', 'CA'); set('bk-dl-zip', '90035'); set('bk-dl-contact', 'Dana'); set('bk-dl-phone', '3105550101');
  w._bookingPanelContainer = w._bookingPanelContainer || w.document.getElementById('right-panel');
}

const cases = [
  // ── 1 ────────────────────────────────────────────────────────────────────────
  {
    id: 1, name: 'transcript single-writer: chatHistory == what appendMessage recorded, matches DOM',
    catches: 'the booking-loop duplicate/ghost-transcript regression — a second writer or a skipHistory turn leaking into chatHistory',
    async run(h) {
      const w = h.win;
      w.appendMessage('user', 'I need a quote for furniture');
      w.appendMessage('bot', 'Sure — what are the dimensions and weight?');
      // A REAL agent turn: tool_use (update_quote) then a text reply — exercises the ensure-not-push
      // guard (14234) and the one-writer path through _recordTurn. As in production (handleInput), the
      // visible user turn is recorded via appendMessage BEFORE aiConverse runs.
      const userTurn = 'furniture, 450 lbs, 48x40x48, 90660 to 33511';
      h.scriptAI([
        turn([toolUse('update_quote', { originZip: '90660', destZip: '33511', items: [{ pieces: 1, weight: 450, length: 48, width: 40, height: 48, commodity: 'furniture', type: 'PLT' }] })]),
        turn([text('Your quote form is open with the furniture details.')]),
      ]);
      w.appendMessage('user', userTurn);
      await w.aiConverse(userTurn);
      await sleep(400);
      // skipHistory error copy renders a bubble but must NEVER be recorded.
      const failMsg = h.g('AGENT_FAIL_MSG');
      w.appendMessage('bot', failMsg, { skipHistory: true });
      // Trailing-dedupe: the same bot line twice records once.
      w.appendMessage('bot', 'Anything else before I pull rates?');
      w.appendMessage('bot', 'Anything else before I pull rates?');

      const ch = h.g('chatHistory');
      const shown = h.messages.map(m => m.text);
      A.ok(Array.isArray(ch) && ch.length > 0, 'chatHistory empty');
      A.ok(ch.every(e => e.role === 'user' || e.role === 'assistant'), 'chatHistory has a non-user/assistant role: ' + JSON.stringify(ch.map(e => e.role)));
      // Ghost check: every recorded entry was actually shown to the customer.
      ch.forEach(e => A.ok(shown.indexOf(e.content) >= 0, 'chatHistory carries a turn never shown in the DOM: ' + JSON.stringify(e)));
      // skipHistory leak check.
      A.ok(shown.indexOf(failMsg) >= 0, 'setup: the skipHistory failure bubble was not shown');
      A.ok(!ch.some(e => e.content === failMsg), 'the skipHistory failure copy leaked into chatHistory');
      // Duplicate check: the doubled bot line recorded exactly once; the aiConverse user turn once.
      A.eq(ch.filter(e => e.content === 'Anything else before I pull rates?').length, 1, 'trailing-dedupe failed — the doubled line recorded twice');
      A.eq(ch.filter(e => e.role === 'user' && e.content === userTurn).length, 1, 'the agent-turn user message was double-recorded');
      A.eq(ch.filter(e => e.content === 'Your quote form is open with the furniture details.').length, 1, 'the agent reply was double-recorded');
    },
  },

  // ── 2 ────────────────────────────────────────────────────────────────────────
  {
    id: 2, name: 'promise-without-action: an unbacked "pulling rates" claim fires the real pull, not silence',
    catches: 'agent claims it is pulling rates with no tool call — the enforcer must fire doGetRates and never silently delete the claim',
    async run(h) {
      const w = h.win;
      w.showQuoteForm(READY, true);          // ready form (weight + dims) → _gateRateReadiness().ok
      // Leave the REAL doGetRates in place (do NOT install the pull stub) so the outbound
      // /applet/v1/rate/multiple is captured. Insurance decided so the gate proceeds to the pull.
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      w._insDecided = true;
      h.reset();
      h.scriptAI([turn([text('Let me pull those rates for you right now.')], 'end_turn')]);
      await w.aiConverse('can you get me rates?');
      await waitFor(() => h.rateRequests().length >= 1, 2000);

      const pulls = h.rateRequests();
      A.eq(pulls.length, 1, 'the enforcer did not fire exactly one real rate pull (promise-without-action not enforced): ' + pulls.length);
      const bots = h.bots();
      A.ok(bots.length >= 1, 'the turn was silenced — no reply delivered');
      A.ok(bots.some(t => /pull/i.test(t) && t.trim().length > 0), 'the promise text was silently deleted instead of delivered: ' + JSON.stringify(bots));
    },
  },

  // ── 3 ────────────────────────────────────────────────────────────────────────
  {
    id: 3, name: 'residential: geocoder verdict never reaches chat; only the RDI dispatch check speaks it',
    catches: 'geocoder residential classification leaking into the chat agent / rate payload (product-rule regression)',
    async run(h) {
      const w = h.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511' }, true);
      // (i) A cached residential verdict must not surface to the agent (invariant 15 contract).
      w._residentialStatus = { residential: true, liftgateRecommended: true, weight: 450 };
      const ls = w._liveStateBlock();
      A.ok(!/residential/i.test(ls), 'the live state block leaks the residential classification to the agent: ' + (ls.match(/.{0,50}residential.{0,50}/i) || [''])[0]);
      const sys = h.g('_convoSysPrompt');
      A.ok(sys.indexOf('comes back residential') < 0, 'the "comes back residential" challenge wording is in the system prompt');
      A.ok(/NEVER YOURS TO RAISE/i.test(sys), 'the never-raise-classification rule is missing from the system prompt');

      // (ii) checkRDIBeforeDispatch IS the surface that speaks the verdict — geocodio residential=true
      // → it does the lookup and raises the RDI overlay (not the chat).
      h.routes.unshift({ match: u => u.indexOf('geocodio') >= 0 && u.indexOf('zip4') >= 0, reply: () => ({ status: 200, body: { results: [{ address_components: { city: 'Brandon', state: 'FL' }, fields: { zip4: { residential: true } } }] } }) });
      h.reset();
      let requoted = null;
      w.checkRDIBeforeDispatch('1250 Main St', '', 'Brandon', 'FL', '33511', [], () => {}, codes => { requoted = codes; });
      await waitFor(() => h.requests.some(r => /geocodio/.test(r.url) && /zip4/.test(r.url)), 1500);
      A.ok(h.requests.some(r => /geocodio/.test(r.url) && /zip4/.test(r.url)), 'checkRDIBeforeDispatch did not perform the residential lookup');
      await sleep(150);
      const overlay = w.document.body.textContent || '';
      A.ok(/residential/i.test(overlay), 'the RDI overlay (the sole surface allowed to speak the verdict) did not render');

      // (iii) Customer-ESTABLISHED residential correctly produces RSD in the rate payload — VALID, not
      // forbidden. With residential established and no RSD on the form, the under-quote guard adds it.
      w.resetShipmentState(false);
      w.showQuoteForm(READY, true);            // weight + dims so doGetRates actually pulls
      w._residentialStatus = { residential: true };
      w._insDecided = true;
      h.reset();                               // drop the form-open auto-pull; capture only our pull
      await w._doGetRates();
      await waitFor(() => h.rateRequests().length >= 1, 2000);
      const req = h.rateRequests()[0];
      A.ok(req, 'no rate pull captured for the established-residential case');
      A.ok(req.accessorials.indexOf('RSD') >= 0, 'customer-established residential did NOT add RSD to the payload (under-quote guard failed): ' + JSON.stringify(req.accessorials));
    },
  },

  // ── 4 ────────────────────────────────────────────────────────────────────────
  {
    id: 4, name: 'insurance: asked once after hazmat before the first pull; known settles silently; unknown lists once',
    catches: 'hazmat answered then pull fired without the mandatory insurance ask; wrong list/silent behavior by commodity knownness',
    async run(h) {
      const w = h.win;
      const asks = () => h.messages.filter(m => m.role === 'bot' && /cargo insurance/i.test(m.text)).length;
      // (a) ORDER (gate-enforced): with insurance undecided, a promise-to-pull is HELD for the mandatory
      // ask — exactly one ask, ZERO pulls (countable via a stub _doGetRates). This is the deterministic
      // "insurance after hazmat, before the first pull" contract, independent of form auto-pull.
      w.showQuoteForm(READY, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      let heldPulls = 0; w._doGetRates = () => { heldPulls++; w._ratePullInFlight = true; };
      h.reset();
      const g = w._gateFinalText('Pulling your rates now.', { regenDone: true });
      A.eq(heldPulls, 0, 'the enforcer pulled past an undecided insurance ask');
      A.eq(asks(), 1, 'expected exactly one insurance ask before the pull, got ' + asks());
      A.ok(g.enforced === true, 'the enforcer hold was not flagged');

      // (b) KNOWN commodity ("tables") → "$2500" settles SILENTLY with the read-back, no list.
      w.resetShipmentState(false);
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 250, pieces: 3, length: 58, width: 30, height: 49,
        lineItems: [{ qty: 3, type: 'PLT', weight: 250, length: 58, width: 30, height: 49, commodity: 'tables' }] }, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      h.installPullStub();
      w._insCollecting = 'value'; w._insValueArmed = true; w._insAskRendered = true; w._insPreRate = true;
      h.reset();
      await w.handleInput('$2500');
      const lqs = w.eval('lastQuotedShipment') || {};
      A.ok(lqs.insuranceEnabled === true && Number(lqs.insuranceAmount) === 2500, 'known commodity did not settle silently: ' + JSON.stringify(h.bots()));
      const rb = h.messages.find(m => /Cargo insurance requested/.test(m.text));
      A.ok(rb && /\$2,500\.00/.test(rb.text), 'the read-back is missing or malformed: ' + (rb && rb.text));
      A.ok(!h.messages.some(m => /^\s*1\.\s/m.test(m.text)), 'the numbered commodity list rendered for a KNOWN commodity');

      // (c) UNKNOWN commodity → the numbered list renders exactly once, no silent settle.
      w.resetShipmentState(false);
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 250, pieces: 1, length: 40, width: 40, height: 40,
        lineItems: [{ qty: 1, type: 'PLT', weight: 250, length: 40, width: 40, height: 40, commodity: 'zzqx nonsense widget' }] }, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      h.installPullStub();
      w._insCollecting = 'value'; w._insValueArmed = true; w._insAskRendered = true; w._insPreRate = true;
      h.reset();
      A.ok(w._matchInsCommodity('zzqx nonsense widget') === null, 'setup: the "unknown" commodity actually maps');
      await w.handleInput('$2500');
      const listText = w._insCommodityListText();
      const listShown = h.messages.filter(m => m.text.indexOf(listText) >= 0);
      A.eq(listShown.length, 1, 'the numbered list did not render exactly once for an unknown commodity: ' + listShown.length);
      A.ok(w._insCollecting === 'commodity', 'the flow did not advance to commodity collection for an unknown commodity: ' + w._insCollecting);
    },
  },

  // ── 5a ───────────────────────────────────────────────────────────────────────
  {
    id: 5, name: 'accessorial fidelity: agreed deliverable codes reach the rate payload exactly, no silent drop',
    catches: 'the multi-code drop bug — a captured payload carried only ["RSD","LFD"] though the chat confirmed more',
    async run(h) {
      const w = h.win;
      w.showQuoteForm(READY, true); // real doGetRates (no stub) so the outbound payload is captured
      w._insDecided = true;         // no insurance hold
      const AGREED = ['RSD', 'RSO', 'LFD', 'LFO', 'IND', 'LAO', 'LAD', 'APD'];
      w._applyQuoteFields({ addAccessorials: AGREED.slice() });
      // The form is the agreed source of truth — read the active chips it actually holds.
      const chips = [...w._quoteContainer.querySelectorAll('.qt-acc.acc-active')].map(b => b.dataset.code);
      AGREED.forEach(c => A.ok(chips.indexOf(c) >= 0, 'agreed code ' + c + ' never made it onto the form as a chip: ' + JSON.stringify(chips)));
      h.reset();
      await w._doGetRates();
      await waitFor(() => h.rateRequests().length >= 1, 2000);
      const req = h.rateRequests()[0];
      A.ok(req, 'no rate pull captured');
      // Every agreed, rateable code reaches the payload — no silent under-quote between chips and pull.
      AGREED.forEach(c => A.ok(req.accessorials.indexOf(c) >= 0, 'agreed code ' + c + ' was dropped from the rate payload (silent under-quote): ' + JSON.stringify(req.accessorials)));
      // And no phantom code the form did not carry.
      req.accessorials.forEach(c => A.ok(chips.indexOf(c) >= 0, 'the payload invented an accessorial not on the form: ' + c));
    },
  },

  // ── 5b ───────────────────────────────────────────────────────────────────────
  {
    id: 6, name: 'accessorial loud-fail: an undeliverable code rejects the whole quote — never a silent pull',
    catches: 'a physically-required accessorial that Primus rejects on this account must fail loud, not ship the freight without it',
    async run(h) {
      const w = h.win;
      // INO (Inside Pickup) is a REAL Primus code but undeliverable on this account (absent from the
      // rateable AND BOL sets); the outbound guard (portal.html:3068-3084) rejects the whole quote.
      // INO has no quote-form chip, so it reaches the rater the way a re-quoted saved BOL would — the
      // shipment's accessorials list carries it into fetchRates, where the guard fires before any fetch.
      h.reset();
      const shipment = Object.assign({}, fx.SHIPMENT, { accessorials: ['Liftgate Delivery', 'Inside Pickup'] });
      let threw = null;
      try { await w.fetchRates(shipment); } catch (e) { threw = e; }
      await sleep(120);
      A.eq(h.rateRequests().length, 0, 'a rate request went out despite an undeliverable code (silent under-quote path taken)');
      A.ok(threw && /RATE_REJECTED_GUARD/.test(String(threw && threw.message)), 'fetchRates did not throw the loud-fail guard: ' + (threw && threw.message));
      const err = w._lastRatePullError || {};
      A.ok(err.kind === 'rejected' && err.accessorialReject === true, 'the loud-fail guard did not mark a rejected pull: ' + JSON.stringify(err));
      A.ok((err.codes || []).indexOf('INO') >= 0, 'the reject did not name the undeliverable code INO: ' + JSON.stringify(err.codes));
    },
  },

  // ── 6 ────────────────────────────────────────────────────────────────────────
  {
    id: 7, name: 're-quote preservation: each of the three exit paths snapshots, restore refills field-for-field',
    catches: 'a booking panel abandoned via back/tab/sidebar losing the customer\'s entered pickup+delivery on re-quote',
    async run(h) {
      const w = h.win;
      const FILL = L2FX.PARTY_FILL;
      const set = (id, v) => { const el = w.document.getElementById(id); if (el) { el.value = v; } };
      const get = id => { const el = w.document.getElementById(id); return el ? String(el.value || '').trim() : null; };

      // Build a live booking panel (materializes the bk-* fields).
      function buildPanel() {
        w.showQuoteForm({ originZip: '90660', destZip: '33511' }, true);
        w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
        const sel = w.selectRate({ carrier: 'JTS' }, { shipment: fx.SHIPMENT, source: 'test' });
        A.ok(sel && sel.ok, 'setup: could not open the booking panel via selectRate');
      }
      async function roundTrip(label, doSnapshot) {
        w.resetShipmentState(true);            // full wipe incl. _quotedContacts
        buildPanel();
        await sleep(350);
        A.ok(w.document.getElementById('bk-pu-name'), label + ': booking panel fields never rendered');
        Object.keys(FILL).forEach(id => set(id, FILL[id]));
        doSnapshot();                          // the exit-path trigger under test
        const qc = w._quotedContacts || {};
        A.ok(qc.shipper && qc.shipper.name === FILL['bk-pu-name'], label + ': snapshot did not capture the shipper: ' + JSON.stringify(qc.shipper));
        A.ok(qc.consignee && qc.consignee.name === FILL['bk-dl-name'], label + ': snapshot did not capture the consignee');
        // Clear the live fields, then restore from the snapshot. _restoreBookingFromQuoted owns the
        // party/contact/instruction fields; city/state are ZIP-derived and intentionally not restored.
        const RESTORE_FIELDS = ['bk-pu-name', 'bk-pu-street', 'bk-pu-contact', 'bk-pu-phone', 'bk-pu-ref',
          'bk-dl-name', 'bk-dl-street', 'bk-dl-contact', 'bk-dl-phone', 'bk-special-instructions'];
        Object.keys(FILL).forEach(id => set(id, ''));
        w._restoreBookingFromQuoted();
        RESTORE_FIELDS.forEach(id => A.eq(get(id), FILL[id], label + ': field ' + id + ' not restored field-for-field'));
      }

      // Path 1 — Back to Rates button (portal.html:17905 → _snapshotBookingToQuoted directly).
      await roundTrip('back-button', () => w._snapshotBookingToQuoted('90660', '33511'));
      // Path 2 — Chrome tab bar switch (portal.html:~22186 → _snapshotOpenBookingTab). Ensure the tab
      // state the real bar carries is present so the helper is exercised functionally.
      await roundTrip('chrome-tab', () => {
        try { w.eval("if (typeof rpState !== 'undefined') { rpState.tabs = [{ title: 'Book Shipment', lane: '90660->33511' }]; }"); } catch (e) {}
        w._snapshotOpenBookingTab();
      });
      // Path 3 — Sidebar "Get a Quote" (portal.html:19185 → _snapshotOpenBookingTab before reset).
      await roundTrip('sidebar', () => {
        try { w.eval("if (typeof rpState !== 'undefined') { rpState.tabs = [{ title: 'Book Shipment', lane: '90660->33511' }]; }"); } catch (e) {}
        w._snapshotOpenBookingTab();
      });

      // Wiring proof: all three real call sites are bound to a snapshot before teardown.
      const src = appScript();
      A.ok(/bk-back-btn[\s\S]{0,600}_snapshotBookingToQuoted/.test(src), 'the Back-to-Rates button is no longer wired to _snapshotBookingToQuoted');
      A.ok(/_snapshotOpenBookingTab\s*\(\)/.test(src), 'the tab/sidebar snapshot helper call site is gone');
    },
  },

  // ── 7a ───────────────────────────────────────────────────────────────────────
  {
    id: 8, name: 'fmtMoney: every price on the fmtMoney-routed quote surfaces is $#,###.## exact',
    catches: '$NaN / $287.5 / $1145.00 (missing trailing zero or thousands separator) on a customer-facing quote price',
    async run(h) {
      const w = h.win;
      // fmtMoney itself on the two hard cases.
      A.ok(L2FX.MONEY_RE.test(w.fmtMoney(1145.5)), 'fmtMoney(1145.5) is not canonical: ' + w.fmtMoney(1145.5));
      A.ok(L2FX.MONEY_RE.test(w.fmtMoney(287.5)), 'fmtMoney(287.5) is not canonical: ' + w.fmtMoney(287.5));
      A.eq(w.fmtMoney(1145.5), '$1,145.50', 'fmtMoney lost the thousands separator');
      A.eq(w.fmtMoney(287.5), '$287.50', 'fmtMoney lost the trailing zero');

      // The chat quote list (renderQuotes → priceDiv, portal.html:6415) renders through fmtMoney.
      // renderQuotes returns a detached node the caller mounts — query the returned node directly.
      const wrap = w.renderQuotes(L2FX.MONEY_RATES, false);
      const prices = [...wrap.querySelectorAll('div')]
        .filter(n => n.childElementCount === 0 && /^\$/.test((n.textContent || '').trim()))
        .map(n => n.textContent.trim());
      A.ok(prices.length >= L2FX.MONEY_RATES.length, 'rendered quote prices not found (expected >= ' + L2FX.MONEY_RATES.length + ', got ' + prices.length + ')');
      prices.forEach(p => A.ok(L2FX.MONEY_RE.test(p), 'a rendered quote price is non-canonical: ' + p));
    },
  },

  // ── 7b ───────────────────────────────────────────────────────────────────────
  {
    id: 9, name: 'fmtMoney gap (KNOWN): three rate-detail surfaces bypass fmtMoney',
    catches: 'rate-breakdown modal + Rate Saved! confirmation + post-save booking line render raw $/toFixed instead of fmtMoney',
    expectFail: true,
    fixedBy: 'route portal.html:19956 (Rate Saved!), :19971 (post-save "Booking with"), and :19984/:20012/:20022 (breakdown modal totals) through fmtMoney; then remove this expectFail flag',
    run(h) {
      // Structural (source-scan, like invariants 6/33/34/…): these three surfaces must route through
      // fmtMoney. They do NOT today, so run() throws → EXPECTED-FAIL. When fixed, all pass →
      // UNEXPECTED-PASS → the suite fails and asks for the flag to be removed.
      const src = appScript();
      // 1) post-save "Booking with … at $" line (portal.html:19971)
      const seg = (src.match(/Booking with[^\n;]*price[^\n;]*/) || [''])[0];
      A.ok(/fmtMoney\(/.test(seg), 'post-save booking line still bypasses fmtMoney (portal.html:19971): ' + seg);
      // 2) "Rate Saved!" confirmation price (portal.html:19956)
      A.ok(!/Rate Saved![\s\S]{0,400}\$'\s*\+\s*price/.test(src), 'Rate Saved! confirmation still uses "$"+price instead of fmtMoney (portal.html:19956)');
      // 3) rate-breakdown modal totals (portal.html:19984/20012/20022)
      A.ok(!/qt-breakdown-modal[\s\S]{0,1200}toFixed\(2\)/.test(src), 'rate-breakdown modal totals still use toFixed(2) instead of fmtMoney (portal.html:19984/20012/20022)');
    },
  },

  // ── 8 ────────────────────────────────────────────────────────────────────────
  {
    id: 10, name: 'booking greeting truthfulness: the greeting matches the actual DOM form state',
    catches: 'a greeting claiming details are set (or asking for details already present) — must read the live bk-* fields',
    async run(h) {
      const w = h.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511' }, true);
      w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
      const sel = w.selectRate({ carrier: 'JTS' }, { shipment: fx.SHIPMENT, source: 'test' });
      A.ok(sel && sel.ok, 'setup: booking panel did not open');
      await sleep(300);
      const set = (id, v) => { const el = w.document.getElementById(id); if (el) el.value = v; };

      // Fully filled → the "carried over" variant, no ask.
      ['bk-pu-name', 'bk-pu-street', 'bk-pu-phone', 'bk-dl-name', 'bk-dl-street', 'bk-dl-phone'].forEach(id => set(id, id.indexOf('phone') >= 0 ? '5625551234' : 'X'));
      const full = w._bookingGreeting('JTS Express', 388.1);
      A.ok(/^Booking JTS Express at \$388\.10 — /.test(full), 'greeting head malformed: ' + full);
      A.ok(/carried over/i.test(full) && !/tell me the shipper name/i.test(full), 'a fully-filled panel was still asked for its details: ' + full);

      // Partially filled (delivery phone blank) → the greeting names the missing field, truthfully.
      set('bk-dl-phone', '');
      const partial = w._bookingGreeting('JTS Express', 388.1);
      A.ok(/delivery phone/i.test(partial), 'the greeting did not name the empty delivery phone: ' + partial);
      A.ok(!/your pickup and delivery details are carried over/i.test(partial), 'the greeting claimed all details present while delivery phone is empty: ' + partial);

      // Empty panel → the full ask.
      ['bk-pu-name', 'bk-pu-street', 'bk-pu-phone', 'bk-dl-name', 'bk-dl-street'].forEach(id => set(id, ''));
      const empty = w._bookingGreeting('JTS Express', 388.1);
      A.ok(/tell me the shipper name/i.test(empty), 'the empty-panel greeting lost its ask: ' + empty);
    },
  },

  // ── 11 ─────────────────────────────────────────────────────────────────────
  {
    id: 11, name: 'pre-gate accessorial survives the insurance gate: released pull carries the agreed code',
    catches: 'an accessorial agreed BEFORE a gate (insurance/RDI/hazmat) dropped on gate release — the RSD/RSO under-quote class',
    async run(h) {
      const w = h.win;
      // Mirror the agent path (portal.html:12086): suppress showQuoteForm's 400ms prefill auto-run so
      // it cannot fire a rescue pull that masks the gate-release bug (the live agent path suppresses it).
      w._suppressQuoteAutoRun = true;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      // 1) A prior settled pull with NO accessorial (the customer's "manual quote"), uninsured.
      w._insDecided = true;
      await w._doGetRates();
      await waitFor(() => (w._lastRates && w._lastRates.count > 0) || h.rateRequests().length >= 1, 2000);
      const firstCount = h.rateRequests().length;
      A.ok(firstCount >= 1, 'setup: the manual pull never fired');
      A.ok(h.rateRequests()[firstCount - 1].accessorials.indexOf('RSD') < 0, 'setup: the manual pull should not carry RSD');

      // 2) Agree an accessorial (class-level: a representative code) and rerun — insurance UNDECIDED
      //    so the gate holds; then decline. The RELEASED pull must carry the agreed code.
      w._insDecided = false; w._insHeldPull = false;
      const AGREED = 'RSD';                     // representative; the contract is per-code, not RSD-only
      w._applyQuoteFields({ addAccessorials: [AGREED], getRates: true });
      await sleep(150);
      A.ok(/cargo insurance/i.test((h.bots().slice(-1)[0] || '')), 'setup: the insurance gate did not hold the pull / ask');
      h.reset();                                // isolate the RELEASE pull
      await w.handleInput('no');                // decline → gate release
      const settled = await waitFor(() => h.rateRequests().length >= 1, 2000);

      // The class assertion: on release the newer request supersedes — the pull that reaches Primus
      // must carry the agreed accessorial, never the stale pre-gate rates.
      A.ok(settled, 'gate release presented stale rates without re-pulling (no /rate/multiple fired after decline)');
      const released = h.rateRequests().slice(-1)[0];
      A.ok(released.accessorials.indexOf(AGREED) >= 0,
        'the agreed accessorial ' + AGREED + ' did not survive the insurance gate — released payload: ' + JSON.stringify(released.accessorials));
    },
  },

  // ── 12 ─────────────────────────────────────────────────────────────────────
  {
    id: 12, name: 'compound gate answer: insurance answer + accessorial add — the add is not dropped',
    catches: 'a customer turn that ANSWERS a pending gate AND makes a new request loses the request — the deterministic insurance collector swallows the whole utterance (portal.html:16575-16590)',
    async run(h) {
      const w = h.win;
      w._suppressQuoteAutoRun = true;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48,
        lineItems: [{ qty: 1, type: 'PLT', weight: 450, length: 48, width: 40, height: 48, commodity: 'furniture' }] }, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      w._applyQuoteFields({ addAccessorials: ['RSD'] }); // residential already on (mirrors the live repro)
      // The cargo-insurance gate is pending — the value question has just been asked.
      w._insCollecting = 'value'; w._insValueArmed = true; w._insAskRendered = true; w._insPreRate = true;
      // The forwarded remainder reaches the real agent; script its turn (layer-2 has no live model).
      h.scriptAI([
        turn([toolUse('update_quote', { addAccessorials: ['LFD'], getRates: true })]),
        turn([text('Liftgate delivery added — pulling updated rates.')]),
      ]);
      h.reset();

      // ONE compound turn: it ANSWERS the insurance gate AND asks to add liftgate delivery.
      await w.handleInput("Yes add cargo insurance, declared value $1,200. And also add liftgate delivery while you're at it.");
      await waitFor(() => h.rateRequests().some(r => r.accessorials.indexOf('LFD') >= 0), 2500);

      // The insurance answer must apply...
      A.ok(h.bots().some(t => /Cargo insurance requested/.test(t) && /\$1,200\.00/.test(t)), 'the insurance value was not applied from the compound answer');
      // ...AND the bundled "add liftgate delivery" must survive into the released pull (the remainder
      // was forwarded to the agent, not discarded).
      const pull = h.rateRequests().slice(-1)[0];
      A.ok(pull, 'no rate pull fired after the compound answer');
      A.ok(pull.accessorials.indexOf('LFD') >= 0,
        'the bundled "add liftgate delivery" was dropped — the gate answer discarded the remainder. Released pull accessorials: ' + JSON.stringify(pull.accessorials));
    },
  },

  // ── 13 ─────────────────────────────────────────────────────────────────────
  {
    id: 13, name: 'empty-residual gate answer ("furniture, $2500") is unchanged — no extra message, no extra pull',
    catches: 'the remainder-forwarding fix must not disturb a pure combined answer (value + commodity, nothing else) — no spurious forward, message, or re-pull',
    async run(h) {
      const w = h.win;
      w._suppressQuoteAutoRun = true;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 250, pieces: 3, length: 58, width: 30, height: 49,
        lineItems: [{ qty: 3, type: 'PLT', weight: 250, length: 58, width: 30, height: 49, commodity: 'furniture' }] }, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      w._insCollecting = 'value'; w._insValueArmed = true; w._insAskRendered = true; w._insPreRate = true;
      h.scriptAI([]);          // if the agent is (wrongly) invoked, ctx.aiRequests records it
      h.reset();

      await w.handleInput('furniture, $2500');
      await sleep(400);

      // Settles silently with the read-back (Option B), and NOTHING else.
      const readbacks = h.bots().filter(t => /Cargo insurance requested/.test(t));
      A.eq(readbacks.length, 1, 'expected exactly one insurance read-back');
      A.ok(/\$2,500\.00/.test(readbacks[0]), 'the value was not applied: ' + readbacks[0]);
      A.eq(h.aiRequests.length, 0, 'a pure combined answer must NOT be forwarded to the agent (no residual): ' + h.aiRequests.length);
      A.eq(h.rateRequests().length, 1, 'a pure combined answer must fire exactly one (insurance) pull, not a spurious extra one: ' + h.rateRequests().length);
      A.ok(!h.bots().some(t => /didn'?t catch the rest|other change|restate/i.test(t)), 'a spurious "remainder" prompt was shown for an empty residual');
    },
  },

  // ── 14 ─────────────────────────────────────────────────────────────────────
  {
    id: 14, name: 'insurance held: the deterministic ask speaks; the model does not also speak or narrate the mechanism',
    catches: 'BUG A / Defect 2 — when the mandatory insurance ask fires (held pull), aiConverse feeds the model the held-pull result and lets it emit a SECOND turn that re-asks and narrates internal gating (portal.html:14564-14568, 14700-14705)',
    async run(h) {
      const w = h.win;
      w._suppressQuoteAutoRun = true;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      // Insurance undecided (default). Script the agent: pull rates, then (the buggy second turn) narrate.
      h.scriptAI([
        turn([toolUse('update_quote', { getRates: true })]),
        turn([text('The system is still processing your insurance decline and will pull rates automatically right after — could you type "no insurance" one more time so it captures it?')]),
      ]);
      h.reset();
      await w.handleInput('go ahead and pull the rates');
      await sleep(300);

      // The deterministic gate asked exactly once...
      A.ok(h.bots().some(t => /cargo insurance/i.test(t)), 'the deterministic insurance ask did not render');
      // ...and the model must NOT be invoked a second time to narrate after the gate already spoke.
      A.eq(h.aiRequests.length, 1, 'the model spoke again after the gate already asked (the held pull did not end the turn): ' + h.aiRequests.length + ' model calls');
      A.ok(!h.bots().some(t => /processing your insurance|type "no insurance" one more time|the system (is )?(still )?(processing|holding|finaliz|captures)/i.test(t)),
        'the model narrated internal gating mechanics to the customer');
    },
  },

  // ── 15 ─────────────────────────────────────────────────────────────────────
  {
    id: 15, name: 'a deterministic agent exception does not tell the customer to retry something that will fail again',
    catches: 'BUG B — a swallowed NON-transient exception surfaces the generic "give it another try" copy (portal.html:14799-14805) even though a retry will fail identically',
    async run(h) {
      const w = h.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511' }, true);
      // A DETERMINISTIC (non-transient) model failure — a code error, not a 5xx/429/network blip.
      const boom = async () => { throw new TypeError('cannot read properties of undefined (reading foo)'); };
      w.flAnthropic = boom; try { w.parent.flAnthropic = boom; } catch (e) {}
      h.reset();
      const USERMSG = 'here are my dimensions: 48x40x48, 450 lbs — what transit times do you see?';
      await w.handleInput(USERMSG);
      await sleep(300);

      const bots = h.bots();
      A.ok(bots.length >= 1, 'no failure message rendered (the exception path was not reached)');
      // B2 (the real bug): the customer's message must survive the failed turn, or the next turn treats
      // their just-supplied details (the dimensions here) as "missing".
      const ch = h.g('chatHistory');
      A.ok(ch.some(e => e.role === 'user' && e.content === USERMSG),
        'the customer message was rolled back on failure — the next turn would treat their dimensions as missing');
      // B3: a deterministic error must not tell the customer to retry something that will fail again.
      A.ok(!bots.some(t => /give it another try|try again in a moment/i.test(t)),
        'a DETERMINISTIC error told the customer to retry something that will fail again: ' + JSON.stringify(bots));
    },
  },

  // ── 16 ───────────────────────────────────────────────────────────────────────
  {
    id: 16, name: 'insurance decline bundled with a request: the gate honors the in-turn decline, never re-asks',
    catches: 'the A3 residual — _insGateBeforeRates asks the mandatory insurance question even though the customer already declined insurance in the SAME turn (a gate must never ask a question already answered this turn)',
    async run(h) {
      const w = h.win;
      const asks = () => h.messages.filter(m => m.role === 'bot' && /cargo insurance/i.test(m.text)).length;
      w.showQuoteForm(READY, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      w._insDecided = false; w._insCollecting = null; w._insPreRate = false;
      let pulls = 0; w._doGetRates = () => { pulls++; w._ratePullInFlight = true; return Promise.resolve(); };
      h.reset();
      // The customer's CURRENT turn declines insurance while also asking for another change.
      w.appendMessage('user', 'no insurance, and also add liftgate');
      const held = w._insGateBeforeRates(w.eval('lastQuotedShipment'), '');
      // FIXED CONTRACT: the in-turn decline is honored — zero re-asks, insurance settled declined,
      // rates pulled without insurance, and the gate owns the pull (returns true).
      A.eq(asks(), 0, 'the gate re-asked the insurance question the customer already declined this turn (asks=' + asks() + ')');
      A.ok(w._insDecided === true, 'the in-turn decline was not settled (window._insDecided !== true)');
      A.ok(pulls >= 1, 'rates were not pulled without insurance after the honored decline (pulls=' + pulls + ')');
      A.ok(held === true, '_insGateBeforeRates must return true when it owns the pull via the decline settle');
    },
  },

  // ── 17 ───────────────────────────────────────────────────────────────────────
  {
    id: 17, name: 'affirmative insurance is never mis-read as a decline (tightened detector)',
    catches: 'a bundled message that declines a DIFFERENT accessorial but ADDS insurance (with a declared value) must not be treated as an insurance decline',
    async run(h) {
      const w = h.win;
      w.showQuoteForm(READY, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      w._insDecided = false; w._insCollecting = null; w._insPreRate = false;
      let pulls = 0; w._doGetRates = () => { pulls++; w._ratePullInFlight = true; return Promise.resolve(); };
      h.reset();
      w.appendMessage('user', 'no liftgate, and yes add insurance $1,200');
      w._insGateBeforeRates(w.eval('lastQuotedShipment'), '');
      // The affirmative insurance signal ($ value + "add insurance") must NOT settle a decline.
      A.ok(w._insDecided !== true, 'an affirmative-insurance message was wrongly settled as an insurance decline');
      // Unit-level guard on the detector itself (present only after the Part 4 fix lands).
      if (typeof w._utteranceDeclinesInsurance === 'function') {
        A.ok(w._utteranceDeclinesInsurance('no liftgate, and yes add insurance $1,200') === false,
          'detector wrongly classified an affirmative-insurance message as a decline');
        A.ok(w._utteranceDeclinesInsurance('no insurance, and also add liftgate') === true,
          'detector failed to classify a clear insurance decline');
        A.ok(w._utteranceDeclinesInsurance('no liftgate needed, please pull rates') === false,
          'detector wrongly treated an unrelated "no liftgate" as an insurance decline');
      }
    },
  },

  // ── 18 ───────────────────────────────────────────────────────────────────────
  {
    id: 18, name: 'prose is never truth: an unbacked "residential + liftgate added" claim writes NO shipment state',
    catches: 'the over-quote class — _gateFinalText 2d wrote accessorials AND _residentialStatus from the agent\'s own prose, with no customer request and no tool call, silently over-charging the customer',
    async run(h) {
      const w = h.win;
      w.showQuoteForm(READY, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      w._insDecided = true;        // no insurance hold in the way
      w._residentialStatus = null; // nothing established by customer or geocoder
      const active = () => [...w._quoteContainer.querySelectorAll('.qt-acc.acc-active')].map(b => b.dataset.code);
      A.ok(active().indexOf('RSD') < 0 && active().indexOf('LFD') < 0, 'setup: form already carried RSD/LFD before the gate');
      h.reset();
      // The agent CLAIMS in prose that it added them — but there was NO update_quote and NO customer request.
      const g = w._gateFinalText("I've added residential delivery and liftgate to your quote.", { regenDone: true });
      // CONTRACT: agent prose is never a source of truth for shipment state — nothing is written.
      A.ok(active().indexOf('RSD') < 0, 'a prose claim wrote RSD onto the form (silent over-quote): ' + JSON.stringify(active()));
      A.ok(active().indexOf('LFD') < 0, 'a prose claim wrote LFD onto the form (silent over-quote): ' + JSON.stringify(active()));
      A.ok(w._residentialStatus == null, 'a prose claim set _residentialStatus from the agent\'s own words (RDI-contract violation): ' + JSON.stringify(w._residentialStatus));
      // …and the unbacked claim is corrected, not silently accepted as true.
      A.ok(/not added|could not add|haven'?t added|didn'?t add|tell me to add|add (it|them) on the panel/i.test(g.text),
        'the unbacked accessorial claim was neither made false nor corrected: ' + JSON.stringify(g.text));
    },
  },

  // ── 19 ───────────────────────────────────────────────────────────────────────
  {
    id: 19, name: 'insurance value reachable AFTER a decline: "set the declared value to $1,200" settles + prices',
    catches: 'the Tier-1 gap — once the insurance gate declines, there was no chat path to set a declared value; the agent had no tool and improvised',
    async run(h) {
      const w = h.win;
      w.showQuoteForm(READY, true);              // real doGetRates so the outbound pull is captured
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      // Gate already CLOSED by a decline.
      w._insDecided = true; w._insCollecting = null;
      w.eval('lastQuotedShipment.insuranceEnabled = false');
      h.reset();
      await w.handleInput("set the declared value to $1,200, it's furniture");
      await waitFor(() => { const l = w.eval('lastQuotedShipment') || {}; return l.insuranceEnabled === true; }, 2500);
      const lqs = w.eval('lastQuotedShipment') || {};
      A.ok(lqs.insuranceEnabled === true, 'declared value after a decline did not enable insurance: ' + JSON.stringify({en:lqs.insuranceEnabled, amt:lqs.insuranceAmount}));
      A.eq(Number(lqs.insuranceAmount), 1200, 'declared value not recorded as 1200: ' + lqs.insuranceAmount);
      await waitFor(() => h.rateRequests().some(r => r.insurance && Number(r.insurance.amount) === 1200), 2500);
      const insPull = h.rateRequests().filter(r => r.insurance && Number(r.insurance.amount) === 1200);
      A.ok(insPull.length >= 1, 'the re-pull did not carry the insurance premium (declared value): ' + JSON.stringify(h.rateRequests().map(r=>r.insurance)));
    },
  },

  // ── 20 ───────────────────────────────────────────────────────────────────────
  {
    id: 20, name: 'insurance cancel is atomic: "cancel the insurance" after a settle clears state AND drops the premium',
    catches: 'the split-brain — removeAccessorials:[\'INS\'] cleared the chip/DOM but left lastQuotedShipment.insuranceEnabled true, so the customer cancelled coverage and was still billed the premium',
    async run(h) {
      const w = h.win;
      w.showQuoteForm(READY, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      // Insurance already SETTLED (added) — chip on, value + commodity on the form via the sole writer.
      w.eval("setInsurance({ status: 'added', amount: 2500, commodityId: REDKIK_COMMODITIES[0].id, commodityName: REDKIK_COMMODITIES[0].name })");
      // The last pull carried the premium (the real state after a settle) — so cancel must re-pull to drop it.
      w.eval("window._lastRatesShipment = { insuranceEnabled: true }");
      const insBtnOn = () => !![...w._quoteContainer.querySelectorAll('.qt-acc')].find(b => b.dataset.code === 'INS' && b.classList.contains('acc-active'));
      A.ok(insBtnOn(), 'setup: INS chip was not active after settle');
      const before = h.rateRequests().length;
      h.reset();
      await w.handleInput('cancel the insurance');
      await waitFor(() => { const l = w.eval('lastQuotedShipment') || {}; return l.insuranceEnabled === false; }, 2500);
      const lqs = w.eval('lastQuotedShipment') || {};
      A.ok(lqs.insuranceEnabled === false, 'cancel left lastQuotedShipment.insuranceEnabled true (split-brain — billed after cancel)');
      A.ok(!insBtnOn(), 'cancel left the INS chip active');
      await waitFor(() => h.rateRequests().length > before, 2500);
      const after = h.rateRequests().slice(before);
      A.ok(after.length >= 1, 'cancel did not re-pull without insurance');
      A.ok(after.every(r => !r.insurance || !(Number(r.insurance.amount) > 0)), 'the post-cancel pull STILL carried an insurance premium: ' + JSON.stringify(after.map(r=>r.insurance)));
    },
  },

  // ── 21 ───────────────────────────────────────────────────────────────────────
  {
    id: 21, name: 'inline enable in ONE turn: "add insurance for $1,200, it\'s furniture" settles with no re-ask',
    catches: 'fix #2 — the enable path discarded an inline value and re-asked "what is the total value?" forcing the customer to repeat a revenue action',
    async run(h) {
      const w = h.win;
      w.showQuoteForm(READY, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      w._insDecided = false; w._insCollecting = null;
      h.reset();
      await w.handleInput("add insurance for $1,200, it's furniture");
      await waitFor(() => { const l = w.eval('lastQuotedShipment') || {}; return l.insuranceEnabled === true; }, 2500);
      const lqs = w.eval('lastQuotedShipment') || {};
      A.ok(lqs.insuranceEnabled === true, 'one-turn enable did not settle insurance: ' + JSON.stringify({en:lqs.insuranceEnabled, amt:lqs.insuranceAmount}));
      A.eq(Number(lqs.insuranceAmount), 1200, 'inline declared value not captured: ' + lqs.insuranceAmount);
      A.ok(!!lqs.insuranceCommodityId, 'inline commodity ("furniture") not mapped: ' + JSON.stringify(lqs.insuranceCommodityId));
      A.ok(w._insCollecting == null, 'the enable re-armed the collector instead of settling in one turn: ' + w._insCollecting);
      A.ok(!h.messages.some(m => m.role === 'bot' && /what is the total value|need the total|need two things/i.test(m.text)),
        'the enable RE-ASKED for the value the customer already gave: ' + JSON.stringify(h.bots()));
    },
  },

  // ── 22 ───────────────────────────────────────────────────────────────────────
  {
    id: 22, name: 'insurance read-back shows the matched commodity, never the customer\'s raw sentence',
    catches: 'display bug — the read-back echoed the whole utterance as the commodity name ("… (Actually insure it for $1,200, it\'s furniture) …"); the parenthetical must carry the matched phrase ("furniture") or nothing',
    async run(h) {
      const w = h.win;
      w.showQuoteForm(READY, true);              // READY has no commodity — the word comes from the sentence
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      w._insDecided = false; w._insCollecting = null;
      h.reset();
      await w.handleInput("Actually insure it for $1,200, it's furniture");
      await waitFor(() => h.bots().some(t => /Cargo insurance requested/.test(t)), 2500);
      const rb = h.bots().find(t => /Cargo insurance requested/.test(t));
      A.ok(rb, 'no insurance read-back rendered: ' + JSON.stringify(h.bots()));
      // Correct category still named, and the declared value still shown in the value clause.
      A.ok(/General Goods &\/or Merchandise/.test(rb), 'read-back dropped the matched category: ' + rb);
      A.ok(/declared value \$1,200\.00/.test(rb), 'read-back lost the declared value: ' + rb);
      // The parenthetical carries the matched commodity word, NOT the raw sentence.
      A.ok(/\(furniture\)/.test(rb), 'read-back parenthetical did not show the matched commodity "(furniture)": ' + rb);
      A.ok(!/insure it for/i.test(rb) && !/actually/i.test(rb), 'read-back echoed the customer\'s raw sentence: ' + rb);
    },
  },

  // ── 23 ───────────────────────────────────────────────────────────────────────
  {
    id: 23, name: 'the residential hold SPEAKS fixed copy from code, ends the turn, and dispatches nothing',
    catches: 'two live failures. 2c2cfef raised checkRDIBeforeDispatch\'s overlay from inside the dispatch_shipment tool call — its only exits are click callbacks, so the tool never returned and the customer got a pop-up with zero words. ef5f751/BOL 160135771: when the AGENT was left to word the hold, aiConverse dropped the text half of the assistant message that also carried a tool call, so the customer saw no "not dispatched", no residence, no service names — just a stray rate summary from the pull that tool fired.',
    async run(h) {
      const w = h.win;
      h.routes.unshift({
        match: (u, m) => /\/applet\/v1\/book\//.test(u) && (!m || m === 'GET'),
        reply: () => ({ status: 200, body: { data: { results: L2FX_REQUOTE_SHIP } } }),
      });
      // Geocodio says residential; the BOL carries no accessorials (see L2FX_REQUOTE_SHIP).
      h.routes.unshift({
        match: (u) => /geocodio-proxy/.test(u),
        reply: () => ({ status: 200, body: { results: [{ formatted_address: '1145 S Clark Dr, Los Angeles, CA 90035', fields: { zip4: { residential: true } } }] } }),
      });
      w._lastBooked = { BOLId: 'BOLID-778899', BOLNumber: '160135778', carrier: 'JTS Express', price: 161, dispatched: false };
      h.reset();
      const r = await w._execDispatchShipment({ BOLId: 'BOLID-778899' });

      // ── Held, not dispatched, and the turn is owned by the tool.
      A.ok(r && r.residentialHold === true, 'the hold did not fire on a residential address with no RSD: ' + JSON.stringify(r).slice(0, 300));
      A.eq(r.ok, false, 'a held dispatch did not fail closed');
      A.ok(r._turnHandled === true, 'the hold did not claim the turn — the agent could restate or truncate it');
      A.eq(h.requests.filter(q => /\/applet\/v2\/dispatch\//.test(q.url)).length, 0, 'the shipment was dispatched despite the hold');
      // ── NO overlay. This is the 2c2cfef regression: a modal from inside a tool call.
      A.eq(w.document.querySelectorAll('#rdi-proceed, #rdi-requote').length, 0, 'the hold raised the blocking RDI overlay from inside the tool call');
      // ── The copy is the ONE definition, rendered verbatim by code.
      const said = h.bots().find(t => t === w._rdiHoldMessage(['residential delivery', 'liftgate delivery']));
      A.ok(said, 'the hold copy did not render verbatim from _rdiHoldMessage: ' + JSON.stringify(h.bots()));
      A.ok(/haven't dispatched this yet/i.test(said), 'the copy does not say it was not dispatched: ' + said);
      A.ok(/residential delivery/.test(said) && /liftgate delivery/.test(said), 'the copy does not name both missing services: ' + said);
      // ── The narrowed rule: states what is missing, never how we know.
      A.ok(!/comes back|lookup|look ?up|verif|check(ed)? the address|geocod/i.test(said), 'the copy mentions an address lookup/check: ' + said);
      A.ok(!/\b(RSD|LFD|RSO|LFO|residentialStatus|zip4)\b/.test(said), 'the copy leaks an internal code or field name: ' + said);
    },
  },

  // ── 24 / 25 — shared body: a booked-undispatched shipment with a requote pending ─────────────
  // Both chat entrances to a requote (the residential hold and the requote_shipment tool) funnel
  // through requoteSavedShipment, so both arrive at book_shipment in the same state and are held to
  // identical assertions. Ids preserved from ddb66ea so they map 1:1 onto that commit.
  ...[
    { id: 24, door: 'the residential hold', open: async (w) => {
        // The hold answered "add them": dispatch_shipment{addDeliveryServices:true} runs the reopen.
        w._rdiPending = { BOLId: 'BOLID-778899', codes: ['RSD'], ship: L2FX_REQUOTE_SHIP };
        await w._execDispatchShipment({ BOLId: 'BOLID-778899', addDeliveryServices: true });
      } },
    { id: 25, door: 'the requote_shipment tool', open: async (w) => {
        // The pre-existing door: "requote BOL 160135778" on a booked, undispatched shipment.
        await w._execRequoteShipment({ bol_id: '160135778' });
      } },
  ].map(v => ({
    id: v.id,
    name: 'requote via ' + v.door + ' is WRITTEN to the BOL (PUT), never swallowed as "already booked"',
    catches: 'the BOL 160135778 money bug — the duplicate-booking guard returned alreadyBooked with the OLD price the moment _lastBooked was set and undispatched, so a requote that re-rated at $304.75 with residential never reached the BOL and dispatch went to the carrier at the original $161 with no residential. Pre-existing in requote_shipment; the residential hold is the second, high-traffic door to the same hole.',
    async run(h) {
      const w = h.win;
      h.routes.unshift({
        match: (u, m) => /\/applet\/v1\/book\//.test(u) && (!m || m === 'GET'),
        reply: () => ({ status: 200, body: { data: { results: L2FX_REQUOTE_SHIP } } }),
      });
      w._lastBooked = { BOLId: 'BOLID-778899', BOLNumber: '160135778', carrier: 'JTS Express', price: 161, dispatched: false };
      w._rdiAnsweredBOL = 'BOLID-778899'; // hold already answered — not what this case is about
      await v.open(w);
      await sleep(900);                    // requoteSavedShipment applies fields on a 500ms timer
      // The requote marker is the thing that makes the guard treat this as an update, not a dupe.
      A.eq(w._requoteWriteBOL, 'BOLID-778899', 'requoteSavedShipment did not arm the requote marker');
      // Booking panel open on the new rate, as it is when the customer picks a carrier post-requote.
      w._bookingPanelOpen = true;
      h.reset();
      const r = await w._execBookShipment({});
      await sleep(300);
      // ── The write actually happened, as a PUT to THIS BOL — not a POST, not a no-op.
      const writes = h.requests.filter(q => /\/applet\/v1\/book\//.test(q.url) && q.method === 'PUT');
      const creates = h.requests.filter(q => /\/applet\/v1\/book(\?|$)/.test(q.url) && q.method === 'POST');
      A.ok(!r.alreadyBooked, 'the guard still swallowed the requote as "already booked": ' + JSON.stringify(r).slice(0, 300));
      A.ok(writes.length >= 1, 'no PUT was issued for the requote — nothing reached the BOL. requests: ' + JSON.stringify(h.requests.map(q => q.method + ' ' + q.url)));
      A.eq(creates.length, 0, 'a duplicate shipment was created (POST) instead of updating the existing BOL');
      A.ok(/BOLID-778899/.test(writes[0].url), 'the PUT went to the wrong BOL: ' + writes[0].url);
      // ── The marker is consumed by the successful write, so it cannot leak into a later booking.
      A.eq(w._requoteWriteBOL, null, 'the requote marker survived a successful write');
    },
  })),

  // ── 27 ───────────────────────────────────────────────────────────────────────
  {
    id: 27, name: 'the hold asks ONCE, honors a decline as-is, and fails OPEN on a geocoder outage',
    catches: 'the three ways a dispatch guard turns into a hard block on live freight: re-asking forever so the customer can never dispatch (the flag written below the return); a decline that silently adds services anyway or re-asks; and a Geocodio outage that blocks a legitimate dispatch instead of proceeding.',
    async run(h) {
      const w = h.win;
      const bookRoute = {
        match: (u, m) => /\/applet\/v1\/book\//.test(u) && (!m || m === 'GET'),
        reply: () => ({ status: 200, body: { data: { results: L2FX_REQUOTE_SHIP } } }),
      };
      const resiRoute = {
        match: (u) => /geocodio-proxy/.test(u),
        reply: () => ({ status: 200, body: { results: [{ fields: { zip4: { residential: true } } }] } }),
      };
      const booked = () => ({ BOLId: 'BOLID-778899', BOLNumber: '160135778', carrier: 'JTS Express', price: 161, dispatched: false });

      // ── A. ASKED ONCE. Second dispatch on the same BOL must go through, not re-ask.
      h.routes.unshift(bookRoute); h.routes.unshift(resiRoute);
      w._rdiAnsweredBOL = null; w._rdiPending = null; w._lastBooked = booked();
      h.reset();
      const first = await w._execDispatchShipment({ BOLId: 'BOLID-778899' });
      A.ok(first && first.residentialHold === true, 'the first dispatch did not hold: ' + JSON.stringify(first).slice(0, 200));
      A.eq(w._rdiAnsweredBOL, 'BOLID-778899', 'the answered flag was not set BEFORE the hold returned — the customer would be re-asked forever and could never dispatch');
      h.reset();
      const second = await w._execDispatchShipment({ BOLId: 'BOLID-778899' });
      A.ok(!second.residentialHold, 'the hold fired TWICE for the same shipment: ' + JSON.stringify(second).slice(0, 200));
      A.ok(!h.bots().some(t => /haven't dispatched this yet — one thing to flag/.test(t)), 'the hold copy was rendered a second time');

      // ── B. DECLINE HONORED. "dispatch as-is" reaches the real dispatch and adds nothing.
      A.eq(h.requests.filter(q => /\/applet\/v2\/dispatch\//.test(q.url)).length, 1, 'a declined hold did not proceed to a real dispatch: ' + JSON.stringify(h.requests.map(q => q.method + ' ' + q.url)));
      A.eq(w._rdiPending, null, 'the pending hold survived a decline — a later call could apply services the customer refused');
      const declineWrites = h.requests.filter(q => /\/applet\/v1\/book/.test(q.url) && (q.method === 'PUT' || q.method === 'POST'));
      A.eq(declineWrites.length, 0, 'a decline silently WROTE accessorials the customer refused: ' + JSON.stringify(declineWrites.map(q => q.method + ' ' + q.url)));

      // ── C. FAIL OPEN. A Geocodio outage must never hold a dispatch — in ANY of its shapes.
      // 'hang' is the one a try/catch alone cannot see: the socket accepts and never answers, so
      // without the AbortController the dispatch stalls behind a spinner instead of proceeding.
      // That is the same outage as an error from the customer's side, so it takes the same exit.
      for (const outage of [
        { name: '500', reply: () => ({ status: 500, body: {} }) },
        { name: 'throw', reply: () => { throw new Error('network down'); } },
        { name: 'malformed', reply: () => ({ status: 200, body: { results: null } }) },
        { name: 'hang (abort)', reply: () => ({ hang: true }) },
      ]) {
        h.routes.unshift(bookRoute);
        h.routes.unshift({ match: (u) => /geocodio-proxy/.test(u), reply: outage.reply });
        w._rdiAnsweredBOL = null; w._rdiPending = null; w._lastBooked = booked();
        h.reset();
        const r = await w._execDispatchShipment({ BOLId: 'BOLID-778899' });
        A.ok(!r.residentialHold, 'geocoder ' + outage.name + ' BLOCKED the dispatch instead of failing open: ' + JSON.stringify(r).slice(0, 200));
        A.eq(h.requests.filter(q => /\/applet\/v2\/dispatch\//.test(q.url)).length, 1, 'geocoder ' + outage.name + ' did not reach a real dispatch');
      }
    },
  },

  // ── 41 ───────────────────────────────────────────────────────────────────────
  {
    id: 41, name: 'one confirmation per save: when code speaks, the tool owns the turn and the agent does not say it again',
    catches: 'live on BOL 160135795: code rendered "Saved as BOL 160135795 — it\'s in My Shipments. Tell me when you want it dispatched." and the agent then said the same thing again in OLDER wording, including "hit Ready to Dispatch" — copy removed in d21d861 and reproduced from the model\'s memory. On an edit the two outright contradicted each other. Two confirmations for one save is confusing; two that disagree are worse than either alone.',
    async run(h) {
      const w = h.win;
      h.routes.unshift({
        match: (u, m) => /\/applet\/v1\/book(\?|$)/.test(u) && m === 'POST',
        reply: () => ({ status: 200, body: { data: { results: [{ BOLId: 'BOLID-SAVE2', BOLNumber: '160000002' }] } } }),
      });
      w._quotedContacts = {
        shipper:   { name: 'Michaels Furniture', address: '7240 Crider Ave', city: 'Pico Rivera', state: 'CA', zip: '90660', contact: 'Jo', phone: '5625550100' },
        consignee: { name: 'Dana Whitfield', address: '1145 S Clark Dr', city: 'Los Angeles', state: 'CA', zip: '90035', contact: 'Dana', phone: '3105550101' },
      };
      w._lastRatesRaw = [{ id: 'R1', name: 'JTS Express', total: 161 }];
      w.selectRate(w._lastRatesRaw[0], { shipment: { originZip: '90660', destinationZip: '90035' }, list: w._lastRatesRaw, open: false, source: 'test' });

      h.reset();
      const r = await w._execSaveShipment({});
      await sleep(400);
      A.ok(r && r.ok === true, 'setup: the chat save did not succeed: ' + JSON.stringify(r).slice(0, 200));

      // ── The tool owns the turn, so the agent gets no completion to restate it in.
      A.ok(r._turnHandled === true, 'the save did not claim the turn — the agent is free to say it again in its own words');
      A.ok(r.saveConfirmed === true, 'the result does not mark itself as already-confirmed');

      // ── And the customer WAS told, exactly once, by code.
      const said = h.bots().filter(t => /Saved as BOL/i.test(t));
      A.eq(said.length, 1, 'the save confirmation appeared ' + said.length + ' times: ' + JSON.stringify(h.bots()));
      // The BUTTON INSTRUCTION, not the phrase: the sanctioned R4 copy legitimately contains
      // "when you're ready to dispatch". What must never come back is "hit Ready to Dispatch".
      A.ok(!h.bots().some(t => /hit Ready to Dispatch|My Shipments and hit/i.test(t)), 'the removed button instruction is back in a confirmation: ' + JSON.stringify(h.bots()));

      // ── A FAILED save must NOT own the turn — the agent has to relay the real message.
      h.routes.unshift({
        match: (u, m) => /\/applet\/v1\/book(\?|$)/.test(u) && m === 'POST',
        reply: () => ({ status: 500, body: {} }),
      });
      h.reset();
      const bad = await w._execSaveShipment({});
      await sleep(300);
      A.ok(bad && bad.ok === false, 'setup: expected the save to fail');
      A.ok(!bad._turnHandled, 'a FAILED save silenced the agent — the customer would never hear why it failed');

      // ── The allow-list carries it, so the turn genuinely ends in aiConverse.
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'portal.html'), 'utf8');
      A.ok(/result\.saveConfirmed/.test(src), 'saveConfirmed is not in the _turnHandled allow-list — the flag would be set but never honoured');
    },
  },

  // ── 40 ───────────────────────────────────────────────────────────────────────
  {
    id: 40, name: 'a validated address is never overwritten by a low-confidence parse, and "PO #123" is not a street',
    catches: 'the worst defect of the session and the only one that reached a carrier. On BOL 160135795 the message "pickup 8/3/26 PO #123" parsed as an address — number 26 from the DATE, name "PO ", suffix "#", trailer 123 — overwriting the validated shipper address 7240 Crider Ave with "26 PO #123". The shipment DISPATCHED to JTS that way. Two independent causes: "#" was in the street-suffix alternation, and applyPartyData overwrote a non-empty address unconditionally.',
    async run(h) {
      const w = h.win;

      // ── LAYER 1: the parser. "#" and bare unit designators are not street suffixes.
      const p = (t) => (w.parseBookingBlock(t, '') || {}).address;
      A.ok(!p('pickup 8/3/26 PO #123'), 'the exact live message STILL parses as an address: ' + JSON.stringify(p('pickup 8/3/26 PO #123')));
      A.ok(!p('PO #123'), '"PO #123" still parses as an address: ' + JSON.stringify(p('PO #123')));
      A.ok(!p('ref 26 PO'), '"ref 26 PO" still parses as an address: ' + JSON.stringify(p('ref 26 PO')));
      // Recall must survive — precision is worthless if real addresses stop landing.
      ['7240 Crider Ave', '1145 S Clark Drive', '100 Beville Rd', '200 Commerce Blvd'].forEach(a => {
        A.ok(p(a), 'a REAL address no longer parses — the tightening went too far: ' + a);
      });

      // ── LAYER 2: the write. Independent of how the value was produced, because a parser is
      // always beatable and this is the layer that has to hold when it is.
      const street = () => { const el = w.document.getElementById('bk-pu-street'); return el ? el.value : null; };
      w.showBookingPanel({ id: 'R1', name: 'JTS Express', total: 161, _name: 'JTS Express', _price: 161 },
        { originZip: '90660', destZip: '90035', accessorials: [] });
      await sleep(300);
      if (!w.document.getElementById('bk-pu-street')) { A.ok(false, 'setup: the booking panel did not render'); return; }
      w.document.getElementById('bk-pu-street').value = '7240 Crider Ave';

      // No address instruction in the message → the validated address must survive.
      h.reset();
      w.applyPartyData({ shipper: { address: '26 PO #123' } }, { source: 'test', sourceText: 'pickup 8/3/26 PO #123' });
      A.eq(street(), '7240 Crider Ave', 'the validated pickup address was OVERWRITTEN — this is what reached the carrier');
      A.ok(h.bots().some(t => /left the pickup address as it was/i.test(t)), 'the refusal was SILENT — an ignored instruction is the same class as the overwrite: ' + JSON.stringify(h.bots()));

      // An EXPLICIT address instruction still updates it — the guard must not block real corrections.
      w.applyPartyData({ shipper: { address: '999 Newport Blvd' } }, { source: 'test', sourceText: 'change the address to 999 Newport Blvd' });
      A.eq(street(), '999 Newport Blvd', 'an explicit address change was refused — the guard is now blocking legitimate corrections');

      // An EMPTY address still fills with no instruction needed.
      w.document.getElementById('bk-pu-street').value = '';
      w.applyPartyData({ shipper: { address: '7240 Crider Ave' } }, { source: 'test', sourceText: 'Michaels Furniture 7240 Crider Ave' });
      A.eq(street(), '7240 Crider Ave', 'filling an EMPTY address now requires an instruction — first-time fill is broken');
    },
  },

  // ── 39 ───────────────────────────────────────────────────────────────────────
  {
    id: 39, name: 'a chat-initiated save is answered in chat — no modal to dismiss — but the parcel picker and the prepaid disclosure still appear',
    catches: 'a save asked for in chat raised a confirmation modal the customer had to click away before they could get back to the conversation they were already having. It costs nothing to skip — the modal renders only BOL number, carrier, price and pickup date, never docs (a save has none; documents are a DISPATCH artifact) — but two carve-outs are load-bearing: the same modal doubles as the parcel pickup PICKER, and the prepaid charge disclosure renders INTO it, which is where a PRE customer sees the exact charge before it fires.',
    async run(h) {
      const w = h.win;
      const src0 = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'portal.html'), 'utf8');
      const seenModal = () => !!w.document.getElementById('bk-saved-overlay');
      // A create returns data.results as an ARRAY (bookShipment reads results[0]); without this the
      // save fails and the modal assertions would pass for the wrong reason.
      h.routes.unshift({
        match: (u, m) => /\/applet\/v1\/book(\?|$)/.test(u) && m === 'POST',
        reply: () => ({ status: 200, body: { data: { results: [{ BOLId: 'BOLID-SAVE1', BOLNumber: '160000001' }] } } }),
      });
      const setup = () => {
        w._quotedContacts = {
          shipper:   { name: 'Michaels Furniture', address: '7240 Crider Ave', city: 'Pico Rivera', state: 'CA', zip: '90660', contact: 'Jo', phone: '5625550100' },
          consignee: { name: 'Dana Whitfield', address: '1145 S Clark Dr', city: 'Los Angeles', state: 'CA', zip: '90035', contact: 'Dana', phone: '3105550101' },
        };
        w._lastRatesRaw = [{ id: 'R1', name: 'JTS Express', total: 161 }];
        w.selectRate(w._lastRatesRaw[0], { shipment: { originZip: '90660', destinationZip: '90035' }, list: w._lastRatesRaw, open: false, source: 'test' });
        try { const o = w.document.getElementById('bk-saved-overlay'); if (o) o.remove(); } catch (e) {}
      };

      // ── CHAT SAVE — no modal, and the customer is still told the outcome in chat.
      setup(); h.reset();
      const r = await w._execSaveShipment({});
      await sleep(400);
      A.ok(r && r.ok === true, 'setup: the chat save did not succeed: ' + JSON.stringify(r).slice(0, 200));
      A.ok(!seenModal(), 'a chat-initiated save raised a modal the customer must dismiss to get back to chat');
      A.ok(h.bots().some(t => /Saved as BOL/i.test(t)), 'the chat save went silent — suppressing the modal must not remove the confirmation: ' + JSON.stringify(h.bots()));

      // ── FORM SAVE — unchanged. The modal is the confirmation on that surface.
      setup(); h.reset();
      await w.submitBookingOnly();
      await sleep(400);
      A.ok(seenModal(), 'the FORM save lost its confirmation modal — only chat saves were meant to change');

      // ── CARVE-OUT 1: PREPAID. Asserted at SOURCE, not driven, and the reason matters: currentCustomer
      // is a script-scope `let` (portal.html:2268), so a test cannot set termsCode from outside —
      // assigning w.currentCustomer only makes an unrelated window property. The shared harness does
      // exactly that, which means it has never actually given the app a logged-in customer. Reported
      // separately rather than fixed here: repointing it would hand every existing case a real
      // currentCustomer where it has had null, and that is not a change to make inside this commit.
      A.ok(/_isPreSave/.test(src0) && /!_isPreSave/.test(src0), 'the prepaid carve-out is gone — a PRE customer would lose the surface where the exact charge is disclosed');
      A.ok(/termsCode === 'PRE'/.test(src0), 'the prepaid check no longer keys off termsCode');

      // ── CARVE-OUT 2: PARCEL. Asserted at source — the same modal is the pickup-handling PICKER,
      // a functional input rather than a restatement, and must survive on that path.
      const src = src0;
      A.ok(/_isParcelSave/.test(src) && /!_isParcelSave/.test(src), 'the parcel carve-out is gone — the pickup picker would stop appearing on a chat save');
      A.ok(/parcelPickerShown/.test(src), 'the parcel pickup picker path was removed');
    },
  },

  // ── 38 ───────────────────────────────────────────────────────────────────────
  {
    id: 38, name: 'chat owns the write: a deterministic party-fill offers to save instead of pointing at the panel button, and writes nothing',
    catches: 'live, twice in one flow: "I\'ve filled 1 field in the booking form\'s pickup section. Review it and hit Save Shipment when ready." That line is generated by CODE, not the agent — these interceptors write the fields and then return, ending the turn before the agent runs — so no prompt change could ever have fixed it. The system did the work and then handed the customer a button.',
    async run(h) {
      const w = h.win;
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'portal.html'), 'utf8');

      // ── No deterministic chat reply may point at the Save button. Asserted at source because
      // these are typed-input intercept paths, and the copy IS the reply on those turns.
      const botSaveBtn = (src.match(/appendMessage\('bot'[^;]{0,400}hit Save Shipment/g) || []);
      A.eq(botSaveBtn.length, 0, 'a deterministic chat reply still tells the customer to hit Save Shipment: ' + JSON.stringify(botSaveBtn).slice(0, 300));

      // ── And it offers instead, so the customer stays in chat.
      A.ok(/Tell me when you want it saved/.test(src), 'the party-fill copy no longer offers to save from chat');

      // ── The PREPAID path is deliberately untouched: My Shipments is where the exact charge is
      // disclosed before it fires, and routing that into chat would bypass a consent surface.
      A.ok(/open it in My Shipments to review the exact charge/.test(src), 'the prepaid disclosure handoff was removed — that one is a consent surface, not a handoff');

      // ── It must still WRITE NOTHING. Offering is not saving; nobody asked for a write here, and
      // an unrequested write is the failure mode the rest of tonight removed. Driven through the
      // real typed-input entry so this is behaviour, not a source grep.
      h.reset();
      await w.handleInput('Michaels Furniture 7240 Crider Ave Pico Rivera CA 90660 contact Juan 5625550100');
      await sleep(400);
      const writes = h.requests.filter(q => /\/applet\/v1\/book/.test(q.url) && (q.method === 'POST' || q.method === 'PUT'));
      A.eq(writes.length, 0, 'a party-fill turn WROTE to the backend — it must offer to save, never save on its own: ' + JSON.stringify(writes.map(q => q.method + ' ' + q.url)));
      A.ok(!h.bots().some(t => /hit Save Shipment/i.test(t)), 'the rendered reply still points at the Save button: ' + JSON.stringify(h.bots()));
    },
  },

  // ── 37 ───────────────────────────────────────────────────────────────────────
  {
    id: 37, name: 'an invented cause for a failed write is replaced with what the system actually said — and a TRUE cause passes untouched',
    catches: 'third live appearance. The tool returned "No shipment matching 1908657679 is on this account. Tell the customer you could not find that shipment and ask them to double-check the BOL number" and the agent said "the system flagged that a state is needed on the delivery address" — discarding a specific, correct instruction and inventing an unrelated validation failure, attributed to "the system". The copy was already right, so this can only be enforced after generation.',
    async run(h) {
      const w = h.win;
      const REAL_404 = 'No shipment matching 1908657679 is on this account. Tell the customer you could not find that shipment and ask them to double-check the BOL number.';
      const REAL_ZIP = 'Your shipment was not saved — pickup ZIP and delivery ZIP are needed. Please add it and try again, or email support@freightandlogistics.ai.';
      // Set through the writer where it exists, else directly — so the BEHAVIOURAL assertions below
      // still execute against pre-fix code and the control fails on the fabrication surviving,
      // rather than dying on a missing helper and proving nothing. Production discipline is
      // unaffected: the one-writer rule is asserted at source further down.
      const setFail = (op, msg) => {
        if (typeof w._setTurnWriteFail === 'function') w._setTurnWriteFail(op, msg);
        else w._turnWriteFail = { op: op, message: msg };
      };

      // ── THE LIVE FABRICATION — verbatim from the transcript. Must be replaced.
      setFail('save_shipment', REAL_404);
      // Verbatim shape from the transcript — deliberately NOT phrased as a save promise, which
      // would be claimed by enforcer 2b first and prove nothing about this one.
      const bad = w._gateFinalText('The system flagged that a state is needed on the delivery address.', {});
      A.eq(bad.text, REAL_404, 'the invented cause survived — the customer is still told a validation failure that never happened: ' + bad.text);

      // ── THE FALSE-POSITIVE DIRECTION. This is the one that would make the guard worse than the
      // bug: a GENUINE validation failure makes the same sentence shape TRUE and useful.
      setFail('save_shipment', REAL_ZIP);
      const good = 'The system needs a delivery ZIP before it will go through.';
      const kept = w._gateFinalText(good, {});
      A.eq(kept.text, good, 'a TRUE cause was rewritten — the guard is now worse than the defect it fixes: ' + kept.text);

      // A cause the message does not support is still caught even when another field DOES match.
      setFail('save_shipment', REAL_ZIP);
      const mixed = w._gateFinalText('The system needs a delivery ZIP and a state on the address.', {});
      A.eq(mixed.text, REAL_ZIP, 'a partly-invented cause survived (state is nowhere in the message): ' + mixed.text);

      // ── NO FAILED WRITE THIS TURN → the gate must not touch ordinary conversation.
      w._turnWriteFail = null;
      const clean = 'The system needs a delivery ZIP before this can go through.';
      A.eq(w._gateFinalText(clean, {}).text, clean, 'the gate rewrote a reply with NO failed write this turn');

      // ── CLEARED ON EVERY PATH. A stale failure must never gate a later clean turn.
      w._setTurnWriteFail('save_shipment', REAL_404);
      w._clearTurnWriteFail();
      A.ok(!w._turnWriteFail, 'the clear writer did not clear the record');

      // Cleared at TURN START — asserted at source, since aiConverse cannot be driven synchronously.
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'portal.html'), 'utf8');
      const turnInit = src.slice(src.indexOf('window._turnToolCalls = { save: false'), src.indexOf('window._turnToolCalls = { save: false') + 400);
      A.ok(/_clearTurnWriteFail\(\)/.test(turnInit), 'the record is not cleared at turn start — a failure would gate every later turn in the chat');

      // Cleared by a LATER SUCCESS in the same turn (a failed save then a successful retry).
      const hook = src.slice(src.indexOf('Record what the SYSTEM said about a failed write'), src.indexOf('Record what the SYSTEM said about a failed write') + 900);
      A.ok(/else _clearTurnWriteFail\(\)/.test(hook), 'a write that SUCCEEDS after a failure does not clear the record — the success would be rewritten as the failure');

      // ── ONE WRITER, asserted at source.
      // Anchor the tail on the block that FOLLOWS both helpers — splitting on the clear function's
      // own name leaves its body inside "outside" and reports its own null assignment as a stray.
      const outside = src.split('function _setTurnWriteFail')[0] + src.split('// ── THE ONE WRITER of the requote-write pair')[1];
      const stray = (outside.match(/window\._turnWriteFail\s*=(?!=)/g) || []).length;
      A.eq(stray, 0, 'window._turnWriteFail is assigned outside its one writer (' + stray + ' site(s))');
    },
  },

  // ── 36 ───────────────────────────────────────────────────────────────────────
  {
    id: 36, name: 'a shipment reference resolves whether it is a BOLId or a BOL number — no caller has to know which it holds',
    catches: 'the 404 that has now been fixed one call site at a time THREE times (7bee6c1, 4510640, and live on 1908657679 via _execSaveShipment -> setEditingBOLId -> resolveBOLId). fetchBookingByBOL is by-NUMBER only: /bolnumber/{ref} 404s on an id and the fallback scan matches BOLNumber first for every row, so it can never recover — it burns its full ~12s deadline and returns null. Both shapes are all-digit, so no caller can tell them apart and no heuristic can either.',
    async run(h) {
      const w = h.win;
      const REC = { BOLId: '1908657679', BOLNumber: '1103613008', consignee: { zipCode: '90035' }, shipper: { zipCode: '90660' }, freightInfo: [{ qty: 1, weight: 10 }], accessorials: [] };
      const seen = [];
      // by-NUMBER endpoint: 404s on an id, exactly like production.
      h.routes.unshift({
        match: (u) => /\/applet\/v1\/book\/bolnumber\//.test(u),
        reply: (u) => { seen.push('bynumber'); return /1103613008/.test(u) ? { status: 200, body: { data: { results: REC } } } : { status: 404, body: {} }; },
      });
      // by-ID endpoint: the one _preChargeInfo and the RDI guard already use live.
      h.routes.unshift({
        match: (u, m) => /\/applet\/v1\/book\/\d+$/.test(u) && (!m || m === 'GET'),
        reply: (u) => { seen.push('byid'); return /1908657679/.test(u) ? { status: 200, body: { data: { results: REC } } } : { status: 404, body: {} }; },
      });

      // ── A BOLId resolves. This is the live failure: previously a 404 then a dead 12s scan.
      const byId = await w.resolveBOLId('1908657679');
      A.ok(byId && byId.ok === true, 'a BOLId did not resolve — the third instance of this same 404: ' + JSON.stringify(byId).slice(0, 200));
      A.eq(byId.bolId, '1908657679', 'resolved to the wrong id');
      A.eq(byId.bolNumber, '1103613008', 'the BOL number did not come back with it');

      // ── A BOL NUMBER still resolves, through the by-number path. No regression.
      seen.length = 0;
      const byNum = await w.resolveBOLId('1103613008');
      A.ok(byNum && byNum.ok === true, 'a BOL number stopped resolving — the by-number path regressed: ' + JSON.stringify(byNum).slice(0, 200));
      A.eq(byNum.bolId, '1908657679', 'the number path returned the wrong canonical id');
      A.ok(seen.indexOf('bynumber') >= 0, 'the by-number path was never reached for a genuine BOL number');

      // ── SELF-VERIFYING: the id probe must REJECT a record whose id is not what was asked for,
      // which is what makes trying it first safe rather than a way to grab the wrong shipment.
      h.routes.unshift({
        match: (u, m) => /\/applet\/v1\/book\/\d+$/.test(u) && (!m || m === 'GET'),
        reply: () => ({ status: 200, body: { data: { results: { BOLId: '999999', BOLNumber: '888888' } } } }),
      });
      const mismatch = await w.resolveBOLId('1103613008');
      A.ok(!(mismatch.ok && mismatch.bolId === '999999'), 'the id probe accepted a record whose id did NOT match the reference — it can grab the wrong shipment');

      // ── Neither shape matches → a real miss, reported rather than silent.
      const miss = await w.resolveBOLId('4040404040');
      A.ok(miss && miss.ok === false, 'an unknown reference reported success');
      A.ok(/BOL_NOT_FOUND|LOOKUP_TIMEOUT/.test(miss.code || ''), 'an unknown reference returned an unexpected code: ' + miss.code);
    },
  },

  // ── 35 ───────────────────────────────────────────────────────────────────────
  {
    id: 35, name: 'a price hold closes the loop: steering reaches the agent, updateToCurrentRate writes and reports without dispatching, and the hold line clears itself',
    catches: 'the live dead end. Both price guards blocked correctly and then nothing happened — the customer said "well?" and got the identical copy again, because the tool result\'s steering never reaches the model (convo is rebuilt from history every turn) and no code performed the recovery. A guard that blocks forever is an outage with good manners.',
    async run(h) {
      const w = h.win;
      const mk = (id, name, total) => ({ id, name, total, rateBreakdown: [{ name: 'FREIGHT CHARGE', total }] });
      const pull1 = [mk('R-p1-jts', 'JTS Express', 161)];
      const pull3 = [mk('R-p3-jts', 'JTS Express', 396.75), mk('R-p3-warp', 'WARP', 120.19)];
      h.routes.unshift({ match: (u, m) => /\/applet\/v1\/book\//.test(u) && (!m || m === 'GET'), reply: () => ({ status: 200, body: { data: { results: L2FX_REQUOTE_SHIP } } }) });

      // Divergence: the written price and the selected price disagree — the case guard 2 makes live.
      w._lastRatesRaw = pull3;
      w._lastRatesShipment = { accessorials: ['RSD', 'LFD'], items: L2FX_REQUOTE_SHIP.freightInfo, originZip: '90660', destinationZip: '90035' };
      // Party data via _quotedContacts, which IS a window global. lastQuotedShipment is a
      // script-scope `let`, so assigning w.lastQuotedShipment would only make an unrelated property
      // and the save would fail ZIP validation — the same trap that bit case 29's setup.
      w._quotedContacts = {
        shipper:   { name: 'Michaels Furniture', address: '7240 Crider Ave', city: 'Pico Rivera', state: 'CA', zip: '90660', contact: 'Jo', phone: '5625550100' },
        consignee: { name: 'Dana Whitfield', address: '1145 S Clark Dr', city: 'Los Angeles', state: 'CA', zip: '90035', contact: 'Dana', phone: '3105550101' },
      };
      w.selectRate(pull3[0], { shipment: w._lastRatesShipment, list: pull3, open: false, source: 'test' });
      w._lastBooked = { BOLId: 'BOLID-778899', BOLNumber: '160135778', carrier: 'JTS Express', price: 161, dispatched: false };
      w._rdiAnsweredBOL = 'BOLID-778899';

      // ── 1. The hold fires, and the STEERING reaches the agent via the live state block.
      h.reset();
      const blocked = await w._execDispatchShipment({ BOLId: 'BOLID-778899' });
      A.ok(blocked && blocked.rateDiverged === true, 'setup: expected the divergence hold: ' + JSON.stringify(blocked).slice(0, 200));
      const ls1 = w._liveStateBlock();
      A.ok(/priceHold:/.test(ls1), 'the agent is told NOTHING about the hold — this is the dead end: ' + ls1.slice(0, 200));
      A.ok(/updateToCurrentRate/.test(ls1), 'the steering does not name the tool that resolves it');
      A.ok(/do not repeat the question/i.test(ls1), 'the steering does not stop the agent re-asking what code already asked');

      // ── 2. updateToCurrentRate WRITES and REPORTS, and does NOT dispatch.
      h.reset();
      const upd = await w._execDispatchShipment({ BOLId: 'BOLID-778899', updateToCurrentRate: true });
      await sleep(300);
      A.ok(upd && upd.ok === true, 'the resolution call failed: ' + JSON.stringify(upd).slice(0, 250));
      A.ok(upd.updatedToCurrentRate === true, 'the result does not report that it updated');
      A.eq(h.requests.filter(q => /\/applet\/v2\/dispatch\//.test(q.url)).length, 0, 'it DISPATCHED — the price changed, so consent must be re-obtained first');
      A.ok(h.requests.some(q => /\/applet\/v1\/book\//.test(q.url) && q.method === 'PUT'), 'no PUT — the new rate never reached the shipment: ' + JSON.stringify(h.requests.map(q => q.method + ' ' + q.url)));
      A.eq(h.requests.filter(q => /\/applet\/v1\/book(\?|$)/.test(q.url) && q.method === 'POST').length, 0, 'it created a duplicate instead of updating');
      A.ok(/^\$[\d,]+\.\d{2}$/.test(upd.priceStr || ''), 'the new price came back without an exact priceStr: ' + upd.priceStr);
      A.eq(upd.priceStr, '$396.75', 'the reported price is not the current rate: ' + upd.priceStr);

      // ── 3. THE HOLD LINE CLEARS ITSELF. Nothing clears it — it is recomputed, so it cannot linger
      // and steer the agent to re-fix what is already fixed.
      const ls2 = w._liveStateBlock();
      A.ok(!/priceHold:/.test(ls2), 'the hold line SURVIVED the write — stale steering would push the agent to redo a completed fix: ' + (ls2.match(/priceHold:.*/) || [''])[0]);

      // ── 4. And dispatch now goes through.
      h.reset();
      const ok = await w._execDispatchShipment({ BOLId: 'BOLID-778899' });
      A.ok(!ok.rateDiverged && !ok.rateStale, 'still held after the write: ' + JSON.stringify(ok).slice(0, 200));
      A.eq(h.requests.filter(q => /\/applet\/v2\/dispatch\//.test(q.url)).length, 1, 'the confirmed dispatch did not reach the carrier');

      // ── 5. The residential hold carries NO steering — it never arrived and the flow works without
      // it, and invariant 15 forbids that classification on the live-state surface.
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'portal.html'), 'utf8');
      const resReturn = src.slice(src.indexOf('return { ok: false, residentialHold: true'));
      A.ok(!/message:/.test(resReturn.slice(0, 200)), 'the residential hold still carries steering text nobody reads');
      A.ok(!/residential/i.test(w._liveStateBlock()), 'invariant 15 broken: the live state block now mentions residential classification');
    },
  },

  // ── 33 ───────────────────────────────────────────────────────────────────────
  {
    id: 33, name: 'the requote-write pair has ONE writer and is cleared on EVERY completion path — a stale intent flag can never refuse a legitimate booking',
    catches: 'new state on the write path is exactly how tonight\'s defects were born — globals with more than one writer and no staleness invariant. _requoteIntent fails CLOSED, so an intent flag left set after a reset, a save, or a create would turn the next legitimate booking into a refusal. That is a self-inflicted outage, not a guard.',
    async run(h) {
      const w = h.win;
      const SHIP = { BOLId: 'BOLID-900', BOLNumber: '160000900', consignee: { zipCode: '90035' }, shipper: { zipCode: '90660' }, freightInfo: [{ qty: 1, weight: 10 }], accessorials: [], pickupInformation: { date: '2026-08-04' } };
      h.routes.unshift({ match: (u, m) => /\/applet\/v1\/book\//.test(u) && (!m || m === 'GET'), reply: () => ({ status: 200, body: { data: { results: SHIP } } }) });

      // ── ARM with an id: both halves of the pair set together.
      w._setRequotePending('BOLID-900');
      A.eq(w._requoteIntent, true, 'arming did not set the intent flag');
      A.eq(w._requoteWriteBOL, 'BOLID-900', 'arming did not record which BOL');

      // ── ARM with NO id: intent still arms. This is the whole point — the marker cannot.
      w._setRequotePending('');
      A.eq(w._requoteIntent, true, 'intent did not arm when the id was missing — the refusal it feeds would be fiction');
      A.eq(w._requoteWriteBOL, null, 'a missing id must leave no marker');

      // ── CLEARED BY resetShipmentState (new chat / fresh quote).
      w._setRequotePending('BOLID-900');
      w.resetShipmentState(false);
      A.eq(w._requoteIntent, false, 'resetShipmentState left the intent flag SET — the next fresh booking would be refused');
      A.eq(w._requoteWriteBOL, null, 'resetShipmentState left the marker set');

      // ── CLEARED BY a successful save (submitBookingOnly's write-success chokepoint). Driven the
      // way the real flow does it — requoteSavedShipment arms, then the booked-shipment path writes
      // — because a save that never completes would clear nothing and prove nothing.
      h.routes.unshift({ match: (u, m) => /\/applet\/v1\/book\//.test(u) && (!m || m === 'GET'), reply: () => ({ status: 200, body: { data: { results: L2FX_REQUOTE_SHIP } } }) });
      w._lastBooked = { BOLId: 'BOLID-778899', BOLNumber: '160135778', carrier: 'JTS Express', price: 161, dispatched: false };
      w._rdiAnsweredBOL = 'BOLID-778899';
      await w._execRequoteShipment({ bol_id: '160135778' });
      await sleep(900);
      A.eq(w._requoteIntent, true, 'setup: requoteSavedShipment did not arm the pending state');
      w._bookingPanelOpen = true;
      h.reset();
      await w._execBookShipment({});
      await sleep(300);
      A.ok(h.requests.some(q => /\/applet\/v1\/book\//.test(q.url) && q.method === 'PUT'), 'setup: the save never completed, so clearing proves nothing');
      A.eq(w._requoteIntent, false, 'a successful save left the intent flag SET — every later booking in this chat would be refused');
      A.eq(w._requoteWriteBOL, null, 'a successful save left the marker set');

      // ── CLEARED BY a create (a fresh POST supersedes any pending requote).
      w._setRequotePending('BOLID-900');
      w._clearRequotePending();
      A.eq(w._requoteIntent, false, 'the clear writer did not clear intent');

      // ── ONE WRITER, asserted at source: nothing outside the two helpers assigns either global.
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'portal.html'), 'utf8');
      const setter = src.slice(src.indexOf('function _setRequotePending'), src.indexOf('function requoteSavedShipment'));
      const outside = src.split('function _setRequotePending')[0] + src.split('function requoteSavedShipment')[1];
      // (?!=) so an equality COMPARISON (=== / ==) is not counted as an assignment — the same
      // backtracking/first-char trap that made an earlier source assertion report false positives.
      const strayIntent = (outside.match(/window\._requoteIntent\s*=(?!=)/g) || []).length;
      const strayMarker = (outside.match(/window\._requoteWriteBOL\s*=(?!=)/g) || []).length;
      A.eq(strayIntent, 0, 'window._requoteIntent is assigned outside the one writer (' + strayIntent + ' site(s)) — the pair can drift');
      A.eq(strayMarker, 0, 'window._requoteWriteBOL is assigned outside the one writer (' + strayMarker + ' site(s)) — the pair can drift');
      A.ok(/_requoteIntent\s*=\s*true/.test(setter) && /_requoteWriteBOL\s*=/.test(setter), 'the setter no longer writes both halves together');
    },
  },

  // ── 34 ───────────────────────────────────────────────────────────────────────
  {
    id: 34, name: 'a save meant to UPDATE refuses when it has no target instead of POSTing a duplicate, and both price guards ASK rather than promise',
    catches: 'two silent failures. bookShipment picks PUT vs POST purely on editBolId, so a lost target became a CREATE — a second BOL for freight that already had one (live: 160135790/160135791). And both price-guard messages promised an action nothing performed — "Let me put the carrier back on...", "Let me get the shipment updated..." — so the customer said "well?" and got the identical copy again. Promise-without-action in FIXED COPY is worse than the agent doing it, because the copy is the part that is supposed to be trustworthy.',
    async run(h) {
      const w = h.win;

      // ── PART 1: neither price guard may promise an action the system does not perform.
      const stale = w._rateStaleMessage(), div = w._rateDivergedMessage();
      [['stale', stale], ['divergence', div]].forEach(([name, msg]) => {
        A.ok(/haven't dispatched this yet/i.test(msg), name + ' copy no longer says it was not dispatched: ' + msg);
        A.ok(!/\b(let me|i'll go ahead|i will now)\b[^.?!]*\b(update|put the carrier|get the shipment)\b/i.test(msg),
          name + ' copy still PROMISES an action nothing performs: ' + msg);
        A.ok(/\?\s*$/.test(msg.trim()) || /\?/.test(msg), name + ' copy does not ask the customer anything — it dead-ends: ' + msg);
        A.ok(!/[$€£]|\d/.test(msg), name + ' copy leaks a raw number: ' + msg);
      });
      // ── HALF A: intent armed, no edit target → refuse, write NOTHING.
      w._setRequotePending('');            // the no-id case: marker null, intent true
      w._editingBOLId = null;
      h.reset();
      const r = await w._execSaveShipment({});
      await sleep(200);
      A.ok(r && r.ok === false, 'the save did not fail closed: ' + JSON.stringify(r).slice(0, 200));
      const posts = h.requests.filter(q => /\/applet\/v1\/book(\?|$)/.test(q.url) && q.method === 'POST');
      const puts = h.requests.filter(q => /\/applet\/v1\/book\//.test(q.url) && q.method === 'PUT');
      A.eq(posts.length, 0, 'a DUPLICATE BOL was created despite having no edit target: ' + JSON.stringify(h.requests.map(q => q.method + ' ' + q.url)));
      A.eq(puts.length, 0, 'a PUT was issued with no target');
      const said = h.bots().find(t => /won't create a second shipment/.test(t));
      A.ok(said, 'the refusal was silent — the customer saw nothing: ' + JSON.stringify(h.bots()));
      A.ok(!/\b(BOLId|_requoteWriteBOL|_editingBOLId|PUT|POST|primus)\b/i.test(said), 'the refusal copy leaks an internal name: ' + said);
      // The pending state SURVIVES a refusal, so retrying after the race resolves still works.
      A.eq(w._requoteIntent, true, 'the refusal cleared the pending intent — a legitimate retry would then POST a duplicate');

    },
  },

  // ── 32 ───────────────────────────────────────────────────────────────────────
  {
    id: 32, name: 'every price crossing into the model carries an exact two-decimal priceStr, and the numeric price survives for the guards',
    catches: 'live 2026-07-30: the agent said "$368" for a rate whose exact figure carried cents. A raw JS float is what reaches the model — 368.10 arrives as 368.1, trailing zero already gone — and no prompt rule required exactness. The customer consents to one number and is billed another, and NO guard catches it: the staleness and divergence checks compare state against state and never see the spoken number. Same class as prose-with-no-state-backing, in the READ direction.',
    async run(h) {
      const w = h.win;
      const two = /^\$[\d,]+\.\d{2}$/;

      // ── fmtMoney is the canonical formatter these all route through.
      A.eq(w.fmtMoney(368.1), '$368.10', 'fmtMoney dropped the trailing zero — the exact bug this guards');
      A.eq(w.fmtMoney(1234.5), '$1,234.50', 'fmtMoney lost the thousands separator or a decimal');

      // ── 1. read_rates / _lastRates options — the main crossing point.
      w._publishRatesForAI(
        [{ id: 'R1', name: 'JTS Express', total: 368.1, rateBreakdown: [{ name: 'FREIGHT CHARGE', total: 368.1 }] },
         { id: 'R2', name: 'WARP', total: 1234.5, rateBreakdown: [{ name: 'FREIGHT CHARGE', total: 1234.5 }] }],
        { originZip: '90660', destinationZip: '90035' });
      const opts = (w._lastRates && w._lastRates.options) || [];
      A.eq(opts.length, 2, '_publishRatesForAI did not publish both options');
      opts.forEach((o, i) => {
        A.ok(o.priceStr, 'option ' + i + ' has no priceStr — the model would receive a raw float: ' + JSON.stringify(o));
        A.ok(two.test(o.priceStr), 'option ' + i + ' priceStr is not exact two-decimal: ' + o.priceStr);
        A.eq(o.priceStr, w.fmtMoney(o.price), 'option ' + i + ' priceStr disagrees with its own numeric price');
        A.eq(typeof o.price, 'number', 'option ' + i + ' lost its NUMERIC price — the guards compare on it');
      });
      A.eq(opts[0].priceStr, '$368.10', 'the live case: 368.1 must be spoken as $368.10, not $368');
      A.eq(opts[1].priceStr, '$1,234.50', 'thousands separator lost on the second option');

      // ── 2. The live state block the agent reads EVERY turn must not print a raw float.
      const ls = w._liveStateBlock();
      A.ok(/\$368\.10/.test(ls), 'the live state block does not carry the exact price: ' + (ls.match(/ratesOnScreen:.*/) || [''])[0]);
      A.ok(!/\$368\.1(?!0)/.test(ls), 'a one-decimal price survives in the live state block: ' + (ls.match(/ratesOnScreen:.*/) || [''])[0]);

      // ── 3. Tool results that carry a price.
      const ub = await w._execUpdateBooking({ carrier: 'JTS Express' });
      await sleep(200);
      A.ok(ub && ub.priceStr && two.test(ub.priceStr), 'update_booking returned no exact priceStr: ' + JSON.stringify(ub).slice(0, 200));
      A.eq(typeof ub.price, 'number', 'update_booking lost its numeric price');

      w._lastBooked = { BOLId: 'BOLID-1', BOLNumber: '160000001', carrier: 'JTS Express', price: 368.1, dispatched: false };
      const already = await w._execBookShipment({});
      A.ok(already && already.alreadyBooked, 'setup: expected the duplicate-booking guard to answer');
      A.ok(already.priceStr && two.test(already.priceStr), 'the alreadyBooked result returned no exact priceStr: ' + JSON.stringify(already).slice(0, 200));
      A.eq(already.priceStr, '$368.10', 'alreadyBooked spoke a rounded price: ' + already.priceStr);
      A.eq(typeof already.price, 'number', 'alreadyBooked lost its numeric price');

      // ── 4. The prompt requires verbatim relay, same contract as the prepaid disclosure.
      const sys = h.g('_convoSysPrompt');
      A.ok(/priceStr/.test(sys), 'the system prompt never mentions priceStr, so nothing tells the model to use it');
      A.ok(/NEVER ROUNDED|never round/i.test(sys), 'the system prompt has no anti-rounding rule');
    },
  },

  // ── 31 ───────────────────────────────────────────────────────────────────────
  {
    id: 31, name: 'hold -> requote -> save UPDATES the existing BOL even when the fetched shipment omits its own id',
    catches: 'the duplicate-BOL defect, live 2026-07-30: 160135790 orphaned at $161 and 160135791 created at $368 — two BOLs for one chair, either dispatchable or invoiceable on its own. The hold branch had the authoritative BOLId in _rdiPending and passed only the fetched object, so if the Primus response omits BOLId then requoteSavedShipment derives an EMPTY id for both the requote marker and _requoteContext.bolId, _requoteOverrides skips setEditingBOLId, and the save silently degrades from PUT to POST.',
    async run(h) {
      const w = h.win;
      // The response body deliberately has NO BOLId / bolId — the shape that caused the duplicate.
      const SHIP_NO_ID = {
        BOLNumber: '160135790',
        shipper:   { name: 'Michaels Furniture', address1: '7240 Crider Ave', city: 'Pico Rivera', state: 'CA', zipCode: '90660' },
        consignee: { name: 'Dana Whitfield', address1: '1145 S Clark Dr', city: 'Los Angeles', state: 'CA', zipCode: '90035' },
        freightInfo: [{ qty: 1, weight: 10, length: 48, width: 40, height: 48, class: '175', commodity: 'Furniture', dimType: 'PLT' }],
        accessorials: [], pickupInformation: { date: '2026-08-04' },
      };
      h.routes.unshift({
        match: (u, m) => /\/applet\/v1\/book\//.test(u) && (!m || m === 'GET'),
        reply: () => ({ status: 200, body: { data: { results: SHIP_NO_ID } } }),
      });
      w._lastBooked = { BOLId: 'BOLID-790', BOLNumber: '160135790', carrier: 'JTS Express', price: 161, dispatched: false };
      w._rdiAnsweredBOL = 'BOLID-790';
      // The hold is pending on this BOL; _rdiPending carries the id the GET URL was built from.
      w._rdiPending = { BOLId: 'BOLID-790', codes: ['RSD', 'LFD'], ship: SHIP_NO_ID };
      h.reset();
      await w._execDispatchShipment({ BOLId: 'BOLID-790', addDeliveryServices: true });
      await sleep(900);   // requoteSavedShipment applies fields on a 500ms timer

      // ── The id survived the handoff, so BOTH derived values are real.
      A.eq(w._requoteWriteBOL, 'BOLID-790', 'the requote marker did not arm — the authoritative BOLId was dropped in the handoff, so a later book/save cannot route to a PUT');

      // ── And the write lands on the EXISTING BOL, not a new one.
      w._bookingPanelOpen = true;
      h.reset();
      const r = await w._execBookShipment({});
      await sleep(300);
      const puts = h.requests.filter(q => /\/applet\/v1\/book\//.test(q.url) && q.method === 'PUT');
      const posts = h.requests.filter(q => /\/applet\/v1\/book(\?|$)/.test(q.url) && q.method === 'POST');
      A.eq(posts.length, 0, 'a SECOND BOL was created (POST) — this is the duplicate: ' + JSON.stringify(h.requests.map(q => q.method + ' ' + q.url)));
      A.ok(puts.length >= 1, 'no PUT was issued — nothing reached the existing BOL. requests: ' + JSON.stringify(h.requests.map(q => q.method + ' ' + q.url)));
      A.ok(/BOLID-790/.test(puts[0].url), 'the PUT went to the wrong BOL: ' + puts[0].url);
      A.ok(!r.alreadyBooked, 'the requote was swallowed as "already booked": ' + JSON.stringify(r).slice(0, 200));
    },
  },

  // ── 29 ───────────────────────────────────────────────────────────────────────
  {
    id: 29, name: 'guard 2: the selection tracks every publish — re-keyed onto the fresh rate, dropped when the carrier is gone, and the lock is never re-armed',
    catches: 'the root cause under BOL 160135789. _execBookShipment nulls _bookingLock on success, so _rekeyLockOnPublish hit its !wantName exit on every later publish and bookingRate stayed frozen on the pull-1 object — which is exactly what _selectedRateForPayload reads FIRST and what every write serializes. Re-keying the lock alone fixes nothing: a non-null bookingRate shadows it.',
    async run(h) {
      const w = h.win;
      const mk = (id, name, total) => ({ id, name, total, rateBreakdown: [{ name: 'FREIGHT CHARGE', total }] });
      const pull1 = [mk('R-p1-jts', 'JTS Express', 161)];
      const pull3 = [mk('R-p3-jts', 'JTS Express', 396.75), mk('R-p3-warp', 'WARP', 120.19)];
      const priceOf = r => r ? Number((r.billTo && r.billTo.total) || r.total || r._price || 0) : null;

      // ── A. THE LIVE CASE — booked, so NO lock; a later publish must still move bookingRate.
      w._lastRatesRaw = pull1;
      w.selectRate(pull1[0], { shipment: {}, list: pull1, open: false, source: 'test' });
      w._bookingLock = null;                       // exactly what _execBookShipment does on success
      A.eq(priceOf(w._selectedRateForPayload().rate), 161, 'setup: the selection should start at the booked rate');
      w._lastRatesRaw = pull3;
      w._rekeyLockOnPublish(pull3, {});
      const after = w._selectedRateForPayload().rate;
      A.eq(String(after && (after.id || after.rateId)), 'R-p3-jts', 'bookingRate was NOT re-keyed onto the fresh rate — this is the BOL 160135789 defect');
      A.eq(priceOf(after), 396.75, 'the re-keyed selection did not carry the new price');
      // R5 — the lock must NOT be re-armed by a post-book re-key.
      A.ok(!w._bookingLock, '_bookingLock was RE-ARMED post-book — _execBookShipment\'s reuse branch would then ignore input.carrier, and _gateFinalText could fire an unrequested save');

      // ── B. R2 — CARRIER DRIFT. The carrier is gone; a similarly-named one must NOT be substituted.
      w._lastRatesRaw = pull1;
      w.selectRate(pull1[0], { shipment: {}, list: pull1, open: false, source: 'test' });
      w._bookingLock = null;
      const noJts = [mk('R-p4-jtsx', 'JTS Logistics', 200), mk('R-p4-warp', 'WARP', 130)];
      w._lastRatesRaw = noJts;
      w._rekeyLockOnPublish(noJts, {});
      const dropped = w._selectedRateForPayload().rate;
      A.ok(!dropped, 'the selection survived a publish that did not contain its carrier — a write would serialize a rateId this list cannot honour');
      A.ok(w._lockDropped && /JTS Express/.test(w._lockDropped.carrier || ''), '_lockDropped was not set, so the agent cannot tell the customer which carrier went');

      // ── E. NOTHING SELECTED — a further publish must not invent one. Runs HERE, continuing from
      // the real null B just produced: bookingRate is a script-scope `let`, so a test cannot clear
      // it by assigning w.bookingRate (that only makes an unrelated window property).
      w._rekeyLockOnPublish(pull3, {});
      A.ok(!w._selectedRateForPayload().rate, 'a publish invented a selection out of nothing');
      A.ok(!w._bookingLock, 'a publish armed a lock with nothing selected');

      // ── C. LOCK PRESERVED when there WAS one (mid-booking re-pull, pre-book).
      w._lastRatesRaw = pull1;
      w.selectRate(pull1[0], { shipment: {}, list: pull1, open: false, source: 'test' });   // arms the lock
      A.ok(!!w._bookingLock, 'setup: a normal selectRate should arm the lock');
      w._lastRatesRaw = pull3;
      w._rekeyLockOnPublish(pull3, {});
      A.ok(!!(w._bookingLock && w._bookingLock.rate), 'a pre-book re-key wrongly DROPPED the lock — mid-booking continuation would break');
      A.eq(String(w._bookingLock.rate.id), 'R-p3-jts', 'the lock was not re-keyed onto the fresh rate');
      A.eq(priceOf(w._selectedRateForPayload().rate), 396.75, 'bookingRate did not follow the lock on a pre-book re-key');

      // ── D. NO-OP when the selection is already in the published list (hot path stays quiet).
      const before = w._selectedRateForPayload().rate;
      w._rekeyLockOnPublish(pull3, {});
      A.eq(String(w._selectedRateForPayload().rate.id), 'R-p3-jts', 'a re-publish of the SAME list changed the selection');
      A.eq(priceOf(w._selectedRateForPayload().rate), priceOf(before), 'a no-op re-key altered the price');

    },
  },

  // ── 30 ───────────────────────────────────────────────────────────────────────
  {
    id: 30, name: 'guard 2 restores the divergence backstop, and R5: selectRate stays the ONE writer of a non-null bookingRate',
    catches: 'two ways this could rot. The divergence backstop went blind once bookingRate froze — both its inputs derived from the same object and agreed to the cent; with the selection tracking publishes it must detect the residential case on its own again. And a future edit assigning bookingRate directly from the re-key would re-break the single-writer contract selectRate documents.',
    async run(h) {
      const w = h.win;
      const mk = (id, name, total) => ({ id, name, total, rateBreakdown: [{ name: 'FREIGHT CHARGE', total }] });
      const pull1 = [mk('R-p1-jts', 'JTS Express', 161)];
      const pull3 = [mk('R-p3-jts', 'JTS Express', 396.75)];

      // ── DIVERGENCE BACKSTOP FIRES ON ITS OWN for the residential path ($396.75 vs $161).
      w._lastRatesRaw = pull1;
      w.selectRate(pull1[0], { shipment: {}, list: pull1, open: false, source: 'test' });
      w._bookingLock = null;
      w._lastBooked = { BOLId: 'BOLID-789', BOLNumber: '160135789', carrier: 'JTS Express', price: 161, dispatched: false };
      w._rdiAnsweredBOL = 'BOLID-789';
      w._lastRatesRaw = pull3;
      w._rekeyLockOnPublish(pull3, {});           // guard 2 moves the selection to $396.75
      h.reset();
      const r = await w._execDispatchShipment({ BOLId: 'BOLID-789' });
      A.ok(r && (r.rateDiverged === true || r.rateStale === true), 'neither price guard fired after a re-key: ' + JSON.stringify(r).slice(0, 250));
      A.ok(r.rateDiverged === true, 'the DIVERGENCE backstop did not fire on its own once the selection tracked the publish — it should now see $396.75 vs the written $161: ' + JSON.stringify(r).slice(0, 250));
      A.eq(h.requests.filter(q => /\/applet\/v2\/dispatch\//.test(q.url)).length, 0, 'the shipment was tendered despite the divergence');

      // ── R5 — SOURCE ASSERTION. _rekeyLockOnPublish may null bookingRate (fail-closed) but must
      // never ASSIGN it a rate directly; every non-null assignment stays inside selectRate.
      const src = w.__APP_SRC__ || require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'portal.html'), 'utf8');
      const fn = src.slice(src.indexOf('function _rekeyLockOnPublish'));
      const body = fn.slice(0, fn.indexOf('\n}\n'));
      // Lookahead placed immediately after '=' so \s* cannot backtrack to empty and let ' null'
      // slip through as a non-null assignment (it did, and reported the two fail-closed nulls).
      const assigns = (body.match(/bookingRate\s*=(?!\s*null)/g) || []);
      A.eq(assigns.length, 0, '_rekeyLockOnPublish assigns bookingRate directly (' + assigns.length + ' non-null assignment(s)) — route it through selectRate so it stays the ONE writer');
      A.ok(/lock:\s*hadLock/.test(body), 'the re-key no longer passes lock:hadLock — it would re-arm _bookingLock post-book');
    },
  },

  // ── 28 ───────────────────────────────────────────────────────────────────────
  {
    id: 28, name: 'stale selection cannot be tendered: a rate not in the CURRENT list blocks dispatch; a fresh one does not',
    catches: 'the BOL 160135789 money loss — booked JTS at $161 with zero accessorials, the residential hold was answered yes, rates re-pulled twice (RSD+LFD then +APD), the agent said "confirmed at $396.75", and the tender went out at $161 with an EMPTY accessorial list. The divergence backstop was structurally blind: after a book _bookingLock is null so nothing updates bookingRate on a publish, both of its inputs stayed the same frozen object, and $161 == $161. The only thing that moved was the price the agent SPOKE, which has no representation in state.',
    async run(h) {
      const w = h.win;
      const mkRate = (id, name, total) => ({ id, name, total, rateBreakdown: [{ name: 'FREIGHT CHARGE', total }] });
      // Pull 1 — no accessorials. This is the rate that gets selected and booked.
      const pull1 = [mkRate('R-pull1-jts', 'JTS Express', 161)];
      // Pull 3 — after RSD+LFD+APD. Primus mints FRESH ids per pull, so the booked rate's id is gone.
      const pull3 = [mkRate('R-pull3-jts', 'JTS Express', 396.75), mkRate('R-pull3-warp', 'WARP', 120.19)];

      // ── A. FRESH SELECTION — the selected rate IS in the current list. Must not fire.
      w._lastRatesRaw = pull1;
      w._lastBooked = { BOLId: 'BOLID-789', BOLNumber: '160135789', carrier: 'JTS Express', price: 161, dispatched: false };
      w._bookingLock = { rate: pull1[0], shipment: {} };
      w._rdiAnsweredBOL = 'BOLID-789';   // isolate from the residential hold
      h.reset();
      const clean = await w._execDispatchShipment({ BOLId: 'BOLID-789' });
      A.ok(!clean.rateStale, 'the guard fired on a selection that IS in the current list: ' + JSON.stringify(clean).slice(0, 200));
      A.ok(!h.bots().some(t => /rates were refreshed after this shipment/.test(t)), 'stale copy rendered on a healthy flow');

      // ── B. THE LIVE BUG — rates re-pulled after the book; the selection predates the new list.
      // Prices deliberately AGREE (161 vs 161) so this proves the guard catches what the divergence
      // backstop cannot: it is the identity of the rate that is wrong, not the number.
      w._lastRatesRaw = pull3;
      w._lastBooked = { BOLId: 'BOLID-789', BOLNumber: '160135789', carrier: 'JTS Express', price: 161, dispatched: false };
      w._bookingLock = { rate: pull1[0], shipment: {} };   // still the pull-1 object, exactly as live
      h.reset();
      const bad = await w._execDispatchShipment({ BOLId: 'BOLID-789' });
      A.ok(bad && bad.rateStale === true, 'the guard did NOT fire on a selection from a superseded pull: ' + JSON.stringify(bad).slice(0, 300));
      A.eq(bad.ok, false, 'a stale dispatch did not fail closed');
      A.ok(bad._turnHandled === true, 'the stale guard did not claim the turn');
      A.eq(h.requests.filter(q => /\/applet\/v2\/dispatch\//.test(q.url)).length, 0, 'the shipment was TENDERED on a stale rate');
      // Proof it is not the divergence backstop firing under another name.
      A.ok(!bad.rateDiverged, 'this was caught as divergence, not staleness — the prices agree, so divergence must be silent here');
      // Customer-safe copy from the one definition: no figure, no carrier, no internals.
      const said = h.bots().find(t => t === w._rateStaleMessage());
      A.ok(said, 'the stale copy did not render verbatim: ' + JSON.stringify(h.bots()));
      A.ok(!/[$€£]|\d/.test(said), 'the stale copy leaks a raw number: ' + said);
      A.ok(!/\b(RSD|LFD|APD|BOL|BOLId|rate ?id|bookingRate|primus|geocod)\b/i.test(said), 'the stale copy leaks an internal name: ' + said);
      A.ok(/haven't dispatched this yet/i.test(said), 'the stale copy does not say it was not dispatched: ' + said);

      // ── C. FAIL OPEN where it cannot know: no rates pulled this session (saved shipment dispatch).
      w._lastRatesRaw = null;
      w._lastBooked = { BOLId: 'BOLID-789', BOLNumber: '160135789', carrier: 'JTS Express', price: 161, dispatched: false };
      w._bookingLock = { rate: pull1[0], shipment: {} };
      h.reset();
      const noRates = await w._execDispatchShipment({ BOLId: 'BOLID-789' });
      A.ok(!noRates.rateStale, 'the guard blocked a dispatch with no rate list to judge against — it must fail open');
      A.eq(h.requests.filter(q => /\/applet\/v2\/dispatch\//.test(q.url)).length, 1, 'the no-rates path did not reach a real dispatch');

      // ── D. FAIL OPEN with no selection at all (the edit-panel path nulls bookingRate before dispatch).
      w._lastRatesRaw = pull3;
      w._lastBooked = { BOLId: 'BOLID-789', BOLNumber: '160135789', carrier: 'JTS Express', price: 161, dispatched: false };
      w._bookingLock = null; w.bookingRate = null;
      h.reset();
      const noSel = await w._execDispatchShipment({ BOLId: 'BOLID-789' });
      A.ok(!noSel.rateStale, 'the guard blocked a dispatch with no rate selected — it must fail open');
      A.eq(h.requests.filter(q => /\/applet\/v2\/dispatch\//.test(q.url)).length, 1, 'the no-selection path did not reach a real dispatch');
    },
  },

  // ── 26 ───────────────────────────────────────────────────────────────────────
  {
    id: 26, name: 'divergence backstop: blocks dispatch when the written rate disagrees with the quoted one, and is silent on a clean flow',
    catches: 'the failure mode that let BOL 160135778 reach a carrier — chat said $304.75 with residential, the BOL said $161 without, and dispatch fired anyway. Also guards the other direction: a normal book-then-dispatch must never trip this.',
    async run(h) {
      const w = h.win;
      // ── A. CLEAN FLOW — booked price and selected rate agree. The backstop must not fire.
      w._lastBooked = { BOLId: 'BOLID-778899', BOLNumber: '160135778', carrier: 'JTS Express', price: 388.10, dispatched: false };
      w._bookingLock = { rate: { id: 'R1', name: 'JTS Express', total: 388.10 }, shipment: {} };
      h.reset();
      const clean = await w._execDispatchShipment({ BOLId: 'BOLID-778899' });
      A.ok(!clean.rateDiverged, 'the backstop fired on a healthy book-then-dispatch: ' + JSON.stringify(clean).slice(0, 200));
      A.ok(!h.bots().some(t => /doesn't match the one I just quoted/.test(t)), 'divergence copy rendered on a clean flow: ' + JSON.stringify(h.bots()));

      // ── B. DIVERGENCE — the quoted rate moved, the BOL never did. Must block and speak.
      w._lastBooked = { BOLId: 'BOLID-778899', BOLNumber: '160135778', carrier: 'JTS Express', price: 161, dispatched: false };
      w._bookingLock = { rate: { id: 'R2', name: 'JTS Express', total: 304.75 }, shipment: {} };
      h.reset();
      const bad = await w._execDispatchShipment({ BOLId: 'BOLID-778899' });
      A.ok(bad && bad.rateDiverged === true, 'the backstop did NOT fire on a real divergence: ' + JSON.stringify(bad).slice(0, 300));
      A.ok(bad.ok === false, 'a diverged dispatch did not fail closed');
      // Fails CLOSED: nothing tendered.
      A.eq(h.requests.filter(q => /\/applet\/v2\/dispatch\//.test(q.url)).length, 0, 'the shipment was dispatched despite the divergence');
      // Customer-safe copy, from the one definition, with the never-surface rules applied.
      const said = h.bots().find(t => t === w._rateDivergedMessage());
      A.ok(said, 'the divergence copy did not render verbatim: ' + JSON.stringify(h.bots()));
      A.ok(!/[$€£]|\d/.test(said), 'the divergence copy leaks a raw number: ' + said);
      A.ok(!/\b(RSD|LFD|BOL|BOLId|primus|shipprimus|geocodio|_lastBooked|rate ?id)\b/i.test(said), 'the divergence copy leaks an internal name: ' + said);
      A.ok(/haven't dispatched this yet/i.test(said), 'the divergence copy does not say it was not dispatched: ' + said);
    },
  },

  // ── 42 ───────────────────────────────────────────────────────────────────────
  {
    id: 42, name: 'an ambiguous "save" mid-booking asks before it writes, and the answer is honoured deterministically on both sides',
    catches: 'live: with the booking panel open a customer typed "save quote for now" and the chat silently ran the SHIPMENT save — submitBookingOnly created a real BOL that appeared under My Shipments as "Saved". They meant Saved Quotes, were told nothing about a shipment, and concluded the save had failed. A draft shipment is the more useful thing to save mid-booking, so the write is not the defect; acting on an ambiguous word with no confirmation is. Covers all THREE routes into submitBookingOnly from chat — the save_shipment tool call, the _gateFinalText 2b prose enforcer (which fires the identical write off the agent merely SAYING "saving it for you now", and which a tool-layer guard cannot see), and the consent answer itself.',
    async run(h) {
      const w = h.win;
      const COPY = h.g('SAVE_DRAFT_CONFIRM');
      const bookPosts = () => h.requests.filter(q => /\/applet\/v1\/book(\?|$)/.test(q.url) && q.method === 'POST').length;
      await openBookingReady(h);

      // ── 1. THE ASK. The agent reaches for save_shipment; code intercepts before submitBookingOnly.
      h.scriptAI([turn([toolUse('save_shipment', {})]), turn([text('All set, it is saved.')])]);
      h.reset();
      w.appendMessage('user', 'save quote for now');
      await w.handleInput('save quote for now');
      await sleep(400);
      A.eq(bookPosts(), 0, 'an ambiguous "save quote for now" WROTE a BOL — this is the live defect');
      A.eq(h.bots().filter(t => t === COPY).length, 1, 'the consent copy did not render verbatim exactly once: ' + JSON.stringify(h.bots()));
      // The tool owns the turn: the agent gets no completion, so it cannot restate or contradict it.
      A.ok(!h.bots().some(t => /All set, it is saved/i.test(t)), 'the agent got a turn and spoke over the consent question: ' + JSON.stringify(h.bots()));
      // Anti-fabrication: an INTENT, never an outcome, and never the wrong surface.
      A.ok(!/saved as bol|saved quotes/i.test(COPY), 'the consent copy states an outcome or names Saved Quotes: ' + COPY);
      A.ok(!/submitBookingOnly|_exec|primus|shipprimus|BOLId/i.test(COPY), 'the consent copy leaks an internal name: ' + COPY);
      // Recomputed, not stored: derivable right now with nothing having been set on the write path.
      A.ok(w._pendingDraftSaveConsent() === true, 'consent state is not pending after the question rendered');

      // ── 2. YES → the real save runs, and the EXISTING confirmation copy is unchanged (R4 owns it).
      h.scriptAI([turn([text('')])]);
      h.reset();
      w.appendMessage('user', 'yes');
      await w.handleInput('yes');
      await sleep(600);
      A.eq(bookPosts(), 1, 'the affirmative did NOT run the save through submitBookingOnly');
      A.ok(h.bots().some(t => /Saved as BOL 160042042/i.test(t)), 'the save produced no confirmation naming the backend BOL: ' + JSON.stringify(h.bots()));
      A.ok(!h.bots().some(t => /saved quotes/i.test(t)), 'the confirmation names Saved Quotes: ' + JSON.stringify(h.bots()));
      // submitBookingOnly nulls the panel container on success, so the consent state falsifies itself.
      A.ok(w._pendingDraftSaveConsent() === false, 'consent state survived a completed save — it is not recomputed');

      // ── 3. DECLINE → no save, and the state is false on the following turn.
      await openBookingReady(h);
      h.scriptAI([turn([toolUse('save_shipment', {})])]);
      h.reset();
      w.appendMessage('user', 'save it');
      await w.handleInput('save it');
      await sleep(400);
      A.eq(bookPosts(), 0, 'setup: the ask wrote a BOL');
      A.ok(w._pendingDraftSaveConsent() === true, 'setup: the question is not pending');
      h.scriptAI([turn([toolUse('save_shipment', {})]), turn([text('Okay — nothing saved.')])]);
      h.reset();
      w.appendMessage('user', 'no, I meant my saved quotes');
      await w.handleInput('no, I meant my saved quotes');
      await sleep(400);
      A.eq(bookPosts(), 0, 'a DECLINED save still wrote a BOL — the tool refusal is not holding');
      A.ok(w._pendingDraftSaveConsent() === false, 'consent state is still pending after a decline — it is not recomputed');

      // ── 4. SUBJECT CHANGE instead of answering → no save, state false.
      await openBookingReady(h);
      h.scriptAI([turn([toolUse('save_shipment', {})])]);
      h.reset();
      w.appendMessage('user', 'save the quote for now');
      await w.handleInput('save the quote for now');
      await sleep(400);
      A.ok(w._pendingDraftSaveConsent() === true, 'setup: the question is not pending');
      h.scriptAI([turn([text('The pickup is set for Tuesday.')])]);
      h.reset();
      w.appendMessage('user', 'remind me what day the pickup is on');
      await w.handleInput('remind me what day the pickup is on');
      await sleep(400);
      A.eq(bookPosts(), 0, 'a subject change wrote a BOL');
      A.ok(w._pendingDraftSaveConsent() === false, 'consent state survived a subject change');

      // ── 5. THE PROSE ROUTE. No tool call at all — the agent just SAYS it saved. _gateFinalText 2b
      // would otherwise fire the identical write, which is why the guard is not tool-layer-only.
      await openBookingReady(h);
      h.scriptAI([turn([text("Sure — I'll save it for you now.")])]);
      h.reset();
      w.appendMessage('user', 'can you just save the quote for now?');
      await w.handleInput('can you just save the quote for now?');
      await sleep(500);
      A.eq(bookPosts(), 0, 'the gate fired a write off agent PROSE for an ambiguous save — the second entrance is open');
      A.ok(h.bots().some(t => t === COPY), 'the prose route did not render the consent copy: ' + JSON.stringify(h.bots()));
      A.ok(!h.bots().some(t => /I'll save it for you now/i.test(t)), 'the unbacked promise was delivered to the customer: ' + JSON.stringify(h.bots()));

      // ── 6. AMBIGUOUS REPHRASE while the question is pending. Found by the pre/post repro: the two
      // enforcement sites each computed their own answer, so "pending" made the tool route refuse
      // while the prose route sailed through and WROTE. One evaluator, one verdict — re-ask, never write.
      A.ok(w._pendingDraftSaveConsent() === true, 'setup: the question is not pending after step 5');
      h.scriptAI([turn([text("Of course — I'll save it for you now.")])]);
      h.reset();
      w.appendMessage('user', 'yeah just save the quote');
      await w.handleInput('yeah just save the quote');
      await sleep(600);
      A.eq(bookPosts(), 0, 'an ambiguous REPHRASE while the question was pending wrote a BOL');
      A.ok(h.bots().some(t => t === COPY), 'the rephrase did not re-ask: ' + JSON.stringify(h.bots()));

      // ── 7. EXPLICIT UPGRADE while the question is pending is CONSENT, not a decline. A refusal here
      // would strand the customer: they answered in the clearest possible terms and got nothing.
      A.ok(w._pendingDraftSaveConsent() === true, 'setup: the question is not pending after step 6');
      h.scriptAI([turn([toolUse('save_shipment', {})])]);
      h.reset();
      w.appendMessage('user', 'yes, save it as a shipment');
      await w.handleInput('yes, save it as a shipment');
      await sleep(600);
      A.eq(bookPosts(), 1, 'an EXPLICIT shipment save answering the question was refused — the customer is stranded');
      A.ok(h.bots().some(t => /Saved as BOL/i.test(t)), 'the explicit upgrade produced no confirmation: ' + JSON.stringify(h.bots()));
    },
  },

  // ── 43 ───────────────────────────────────────────────────────────────────────
  {
    id: 43, name: 'an EXPLICIT shipment save still writes immediately, and the ambiguity test does not fire on working phrasings',
    catches: 'the regression risk on the other side of case 42. A consent gate that also catches "save shipment" adds a question to the path that was always correct, and one that catches "show my saved quotes" or "save the shipper contact" breaks unrelated working flows. Both are the over-eager-parse class already recorded against parseQuoteChat matching a bare /\\bappointment\\b/.',
    async run(h) {
      const w = h.win;
      const COPY = h.g('SAVE_DRAFT_CONFIRM');
      const bookPosts = () => h.requests.filter(q => /\/applet\/v1\/book(\?|$)/.test(q.url) && q.method === 'POST').length;

      // ── The predicate itself, in both directions.
      ['save quote for now', 'save the quote for now', 'save it', 'save for now', 'just save it for now',
       'can you save the quote?', 'save this quote', 'save the rate'].forEach(s => {
        A.ok(w._isAmbiguousSaveIntent(s) === true, 'an ambiguous save was NOT caught, so it would write silently: ' + s);
      });
      // FALSE POSITIVES — the phrasings most likely to regress a working path.
      ['save shipment', 'save it as a shipment', 'save the shipment for now', 'save this as a draft shipment',
       'save the booking', 'show my saved quotes', 'my saved quotes', 'save the shipper contact',
       'save the shipper details', 'what did you save'].forEach(s => {
        A.ok(w._isAmbiguousSaveIntent(s) === false, 'a working phrasing was caught by the consent gate: ' + s);
      });

      // ── And the explicit shipment save: the guard stands down and the write goes straight through.
      // Asserted at the WRITE layer (the layer R4 and case 39 use), not by driving "save shipment"
      // through handleInput, because that phrasing dead-ends in this harness on UNMODIFIED HEAD too
      // — 0 book POSTs and the agent-fail line, identical before and after this change. That is a
      // pre-existing routing/scripting artifact, not something this case should encode or chase.
      await openBookingReady(h);
      h.reset();
      w.appendMessage('user', 'save shipment');
      A.ok(w._chatSaveNeedsConsent() === false, 'the consent guard claimed an EXPLICIT shipment save — it is over-firing');
      const r = await w._execSaveShipment({});
      await sleep(500);
      A.ok(r && r.ok === true, 'the explicit save did not succeed: ' + JSON.stringify(r).slice(0, 200));
      A.eq(bookPosts(), 1, 'an EXPLICIT "save shipment" no longer writes — the guard is over-firing');
      A.ok(!h.bots().some(t => t === COPY), 'an explicit shipment save was made to ask for consent: ' + JSON.stringify(h.bots()));
      A.ok(h.bots().some(t => /Saved as BOL 160042042/i.test(t)), 'the explicit save produced no confirmation: ' + JSON.stringify(h.bots()));
    },
  },

  // ── 44 ───────────────────────────────────────────────────────────────────────
  {
    id: 44, name: 'a completed book_shipment says SAVED, in the canonical words, from code — never "Booked", never an unprompted dispatch offer',
    catches: 'live 2026-07-31, BOL 160135825. The customer answered the draft-save question, the agent reached for book_shipment instead of save_shipment, and _execBookShipment wrote the BOL while rendering NOTHING — so the agent composed the sentence itself: "Booked — BOL 160135825, TForce Freight at $207.22, picking up August 3rd. Want me to dispatch it now and get your shipping docs?" Two defects: "Booked" tells a customer their freight is moving when nothing has gone to the carrier, and it volunteers DISPATCH — the irreversible write — one beat after a save nobody asked to dispatch. Both came out of that tool\'s own result string ("Shipment booked and set up in our system, ready to dispatch"). a37ea40 closed this on save_shipment only; book_shipment performs the same class of write and bypassed it. NOTE THE ASSERTION LAYER: this reads the RENDERED transcript, not the return value — R4 asserts _execSaveShipment\'s returned message and never sees what reached chat, which is exactly why it stayed green while the customer read "Booked".',
    async run(h) {
      const w = h.win;
      const CANON = w._savedConfirmMessage('160135825');
      const bookPosts = () => h.requests.filter(q => /\/applet\/v1\/book(\?|$)/.test(q.url) && q.method === 'POST').length;

      h.routes.unshift({
        match: (u, m) => /\/applet\/v1\/book(\?|$)/.test(u) && m === 'POST',
        reply: () => ({ status: 200, body: { data: { results: [{ BOLId: 'B825', BOLNumber: '160135825' }] } } }),
      });
      w._lastRatesRaw = [{ id: 'R1', name: 'TForce Freight', total: 207.22 }];
      w.selectRate(w._lastRatesRaw[0], { shipment: { originZip: '90660', destinationZip: '90035' }, list: w._lastRatesRaw, open: false, source: 'test' });
      w.showBookingPanel({ id: 'R1', name: 'TForce Freight', total: 207.22, _name: 'TForce Freight', _price: 207.22 },
        { originZip: '90660', destZip: '90035', accessorials: [] });
      await sleep(300);
      const set = (id, v) => { const e = w.document.getElementById(id); if (e) e.value = v; };
      ['bk-pu-name:Michaels Furniture', 'bk-pu-street:7240 Crider Ave', 'bk-pu-city:Pico Rivera', 'bk-pu-state:CA',
       'bk-pu-zip:90660', 'bk-pu-contact:Jo', 'bk-pu-phone:5625550100', 'bk-dl-name:Dana Whitfield',
       'bk-dl-street:1145 S Clark Dr', 'bk-dl-city:Los Angeles', 'bk-dl-state:CA', 'bk-dl-zip:90035',
       'bk-dl-contact:Dana', 'bk-dl-phone:3105550101'].forEach(p => { const i = p.indexOf(':'); set(p.slice(0, i), p.slice(i + 1)); });
      w._bookingPanelContainer = w._bookingPanelContainer || w.document.getElementById('right-panel');

      h.reset();
      const r = await w._execBookShipment({});
      await sleep(400);
      A.ok(r && r.ok === true, 'setup: the book did not succeed: ' + JSON.stringify(r).slice(0, 220));
      A.eq(bookPosts(), 1, 'setup: no BOL was actually written, so this proves nothing about a completed save');

      // ── THE RENDERED TRANSCRIPT — what the customer actually read.
      A.eq(h.bots().filter(t => t === CANON).length, 1, 'the canonical save confirmation was not rendered from code exactly once: ' + JSON.stringify(h.bots()));
      A.ok(!h.bots().some(t => /\bbooked\b/i.test(t)), 'the customer was told "booked" for a shipment that has NOT gone to the carrier: ' + JSON.stringify(h.bots()));
      A.ok(h.bots().some(t => /nothing has gone to the carrier/i.test(t)), 'nothing told the customer the shipment has not gone to the carrier: ' + JSON.stringify(h.bots()));
      // Bug 2 — no unsolicited offer of the irreversible write.
      A.ok(!h.bots().some(t => /want me to dispatch|dispatch it now|shall i dispatch|ready to dispatch/i.test(t)),
        'a dispatch offer followed a save the customer never asked to dispatch: ' + JSON.stringify(h.bots()));

      // ── THE TURN ENDS, so the agent gets no completion to say it again in its own words.
      A.ok(r._turnHandled === true, 'the book did not claim the turn — the agent is free to restate it as "Booked"');
      A.ok(r.saveConfirmed === true, 'the result does not mark itself as already-confirmed');
      const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'portal.html'), 'utf8');
      A.ok(/result\.saveConfirmed/.test(src), 'saveConfirmed is not in the _turnHandled allow-list — the flag would be set but never honoured');
      // The tool message may still be read on paths that do not end the turn; it must not reintroduce either defect.
      A.ok(!/\bbooked\b/i.test(String(r.message || '')), 'the tool message still says "booked": ' + r.message);
      A.ok(!/ready to dispatch/i.test(String(r.message || '')), 'the tool message still volunteers dispatch: ' + r.message);

      // ── Fields layer-2 787/1250/1351/1396 read must survive the change.
      A.eq(r.priceStr, '$207.22', 'the exact two-decimal priceStr was lost: ' + r.priceStr);
      A.eq(r.BOLNumber, '160135825', 'the backend BOL number was lost');
      A.eq(typeof r.price, 'number', 'the numeric price was lost');
      A.ok(r.carrier, 'the carrier was lost');
    },
  },

  // ── 45 ───────────────────────────────────────────────────────────────────────
  {
    id: 45, name: 'ONE definition of the save sentence: both write routes render the identical words, and a37ea40 still holds in front of them',
    catches: 'the split-brain that produced the defect in the first place — book_shipment and save_shipment each describing the same write in their own words, one saying "Saved ... nothing has gone to the carrier", the other "Booked ... ready to dispatch". A per-route copy is how the two drifted. Also guards the phrasing that exposed it: the consent question answered with bare "save", which is outside the affirmative list, so it reaches the agent and the agent may pick EITHER tool — the customer must read the same sentence whichever it picks.',
    async run(h) {
      const w = h.win;
      const bookPosts = () => h.requests.filter(q => /\/applet\/v1\/book(\?|$)/.test(q.url) && q.method === 'POST');

      // ── ONE SOURCE. Both routes render the string this function returns, byte for byte.
      const CANON = w._savedConfirmMessage('160042042');
      A.ok(/^Saved as BOL 160042042 — /.test(CANON), 'the canonical sentence changed shape: ' + CANON);
      // It must still satisfy every R4 rule, since R4 governs these exact words.
      A.ok(/160042042/.test(CANON), 'the canonical sentence does not name the BOL: ' + CANON);
      A.ok(/tell me when|say the word|whenever you'?re ready/i.test(CANON), 'the canonical sentence no longer invites dispatch in chat: ' + CANON);
      A.ok(!/come back|go to my shipments|open it there|hit ready to dispatch/i.test(CANON), 'the canonical sentence hands the customer off: ' + CANON);
      A.ok(/nothing has gone to the carrier/i.test(CANON), 'the canonical sentence no longer says the shipment has not gone out: ' + CANON);
      A.ok(!/\b(?:has been|was|is) dispatched\b|\bon its way\b|\bpicked up\b|\bbooked\b/i.test(CANON), 'the canonical sentence implies the shipment is moving: ' + CANON);
      A.ok(!/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/.test(CANON), 'the canonical sentence carries a phone number: ' + CANON);

      // ── a37ea40 REGRESSION: an ambiguous save still asks and still writes nothing.
      // The ask is driven with "save quote for now" rather than the bare "save" from the live
      // transcript: bare "save" dead-ends before the tool dispatch in this harness on unmodified
      // HEAD too (same pre-existing artifact as "save shipment", noted in a37ea40). The predicate is
      // asserted directly just below, so the phrasing that exposed the defect is still covered.
      await openBookingReady(h);
      h.reset();
      w.appendMessage('user', 'save');
      A.eq(w._draftSaveVerdict(), 'ask', 'bare "save" is no longer an ambiguous save request — the live phrasing would write silently');
      h.scriptAI([turn([toolUse('save_shipment', {})])]);
      h.reset();
      w.appendMessage('user', 'save quote for now');
      await w.handleInput('save quote for now');
      await sleep(400);
      A.eq(bookPosts().length, 0, 'an ambiguous save wrote a BOL before any affirmative — a37ea40 regressed');
      A.ok(w._pendingDraftSaveConsent() === true, 'setup: the consent question is not pending');

      // ── The save_shipment route renders exactly the canonical sentence.
      h.reset();
      w.appendMessage('user', 'yes');
      await w.handleInput('yes');
      await sleep(600);
      const viaSave = h.bots().filter(t => /^Saved as BOL/.test(t));
      A.eq(viaSave.length, 1, 'the save_shipment route did not render one canonical confirmation: ' + JSON.stringify(h.bots()));
      A.eq(viaSave[0], w._savedConfirmMessage('160042042'), 'the save_shipment route no longer uses the one definition: ' + viaSave[0]);
      A.ok(!h.bots().some(t => /\bbooked\b/i.test(t)), 'the save route said "booked": ' + JSON.stringify(h.bots()));

      // ── And the book_shipment route renders the SAME sentence for the SAME BOL. Same words, or the
      // two routes are describing one write differently again — which is the whole defect.
      await openBookingReady(h);
      // A DIFFERENT shipment, not a second write on the same one: _lastBooked still holds the BOL the
      // save route just created, and the duplicate-booking guard would correctly answer alreadyBooked
      // (no write, nothing rendered) instead of exercising the success path being compared here.
      w._lastBooked = null;
      h.reset();
      w.appendMessage('user', 'save');
      const rb = await w._execBookShipment({});
      await sleep(400);
      A.ok(rb && rb.ok === true, 'setup: the book route did not succeed: ' + JSON.stringify(rb).slice(0, 200));
      const viaBook = h.bots().filter(t => /^Saved as BOL/.test(t));
      A.eq(viaBook.length, 1, 'the book_shipment route did not render one canonical confirmation: ' + JSON.stringify(h.bots()));
      A.eq(viaBook[0], viaSave[0], 'the two write routes describe the SAME save in DIFFERENT words:\n  save: ' + viaSave[0] + '\n  book: ' + viaBook[0]);
      A.ok(!h.bots().some(t => /want me to dispatch|dispatch it now|ready to dispatch/i.test(t)),
        'the book route offered dispatch unprompted: ' + JSON.stringify(h.bots()));
    },
  },
];

module.exports = { cases };
