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
];

module.exports = { cases };
