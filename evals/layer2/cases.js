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
];

module.exports = { cases };
