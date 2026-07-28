'use strict';
// ── THE TEN-STEP ACCEPTANCE FLOW, EXECUTED MECHANICALLY ───────────────────────
// The product owner's live acceptance script, run end-to-end in the jsdom harness against the
// real portal code. Every scripted expectation is asserted; a step failure fails the suite.
//
// EMULATION BOUNDARY (documented per step): the LLM cannot run headlessly, so agent-authored
// turns are emulated by the TOOL CALL the agent is contractually required to make
// (_execUpdateQuote / _execUpdateBooking / _execSaveShipment); customer-typed turns that the
// DETERMINISTIC layer owns run through the real handleInput. The rate pull is stubbed at the
// window._doGetRates seam with a stub that honors the doGetRates contract (in-flight flag,
// INS-panel read, publishRates, _onRatesReady) so pulls are countable and deterministic.

const path = require('path');
const { boot } = require(path.join(__dirname, '..', 'state', 'harness'));
const fx = require(path.join(__dirname, '..', 'state', 'fixtures'));

const A = {
  ok(cond, msg) { if (!cond) throw new Error(msg); },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// doGetRates-contract stub: counts pulls, reads the form's INS panel exactly like the real pull,
// publishes fixture rates for the CURRENT form lane, and fires _onRatesReady.
function installPullStub(sh) {
  const w = sh.ctx.win;
  w._doGetRates = () => {
    sh.pulls++;
    w._ratePullInFlight = true;
    const q = w._quoteFormState();
    const qc = w._quoteContainer;
    const insSel = qc && qc.querySelector('#qt-ins-commodity');
    const insVal = qc && qc.querySelector('#qt-ins-value');
    const insOn = !!(insSel && insSel.value && insVal && parseFloat(insVal.value) > 0);
    sh.lastPullInsured = insOn;
    const insName = insOn ? ((sh.ctx.g('REDKIK_COMMODITIES').find(c => c.id === insSel.value) || {}).name || '') : '';
    const shipment = Object.assign({}, fx.SHIPMENT, {
      originZip: q.origin || fx.SHIPMENT.originZip,
      destinationZip: q.destination || fx.SHIPMENT.destinationZip,
      insuranceEnabled: insOn,
      insuranceCommodityId: insOn ? insSel.value : '',
      insuranceCommodityName: insName,
      insuranceAmount: insOn ? parseFloat(insVal.value) : 0,
      items: [{ pieces: 3, weight: 250, length: 58, width: 30, height: 49, packageType: 'PLT', freightClass: '70', description: q.commodity || 'tables' }],
    });
    w.publishRates(fx.RATES, shipment, { paint: false });
    w._ratePullInFlight = false;
    const cb = w._onRatesReady; w._onRatesReady = null;
    if (cb) { try { cb(fx.RATES); } catch (e) {} }
  };
}

const bots = sh => sh.ctx.messages.filter(m => m.role === 'bot').map(m => m.text);
const greetings = sh => bots(sh).filter(t => /^Booking .* at \$/.test(t));
const el = (sh, id) => sh.ctx.win.document.getElementById(id);
const val = (sh, id) => { const e = el(sh, id); return e ? String(e.value || '').trim() : ''; };
// Two-decimal audit: every $-figure in customer-visible text carries exactly two decimals.
function assertTwoDecimalMoney(sh, scope) {
  const bad = bots(sh).map(t => (t.match(/\$\d[\d,]*(?:\.\d+)?/g) || []).filter(m => !/\.\d\d$/.test(m))).flat();
  A.ok(bad.length === 0, scope + ': one-decimal money rendered: ' + JSON.stringify(bad));
}

const steps = [
  {
    id: 1, name: 'paste → form + parties fill, one greeting, no pallet/STC question',
    async run(sh) {
      const w = sh.ctx.win;
      // Emulated agent extraction of the Michaels Furniture paste (the agent's mandatory tool call).
      w._execUpdateQuote({
        originZip: '90660', destZip: '90035',
        items: [{ pieces: 3, weight: 250, length: 58, width: 30, height: 49, commodity: 'tables', type: 'PLT' }],
        shipper:   { name: 'Michaels Furniture', address: '7240 Crider Ave', city: 'Pico Rivera', state: 'CA', contact: 'Juan Ortiz', phone: '8888888888' },
        consignee: { name: 'Mike Smith', address: '1145 S Clark Drive', city: 'Los Angeles', state: 'CA', contact: 'Mike Smith', phone: '5555555555' },
      });
      await sleep(700); // the form-open path defers field application (~350ms)
      installPullStub(sh); // the form open reassigned window._doGetRates — restub after
      const q = w._quoteFormState();
      A.ok(q.origin === '90660' && q.destination === '90035', 'ZIPs not on the form: ' + q.origin + '/' + q.destination);
      A.ok(String(q.weight) === '250' && /tables/i.test(q.commodity || ''), 'freight not on the form: ' + q.weight + '/' + q.commodity);
      const qc = w._quotedContacts || {};
      A.ok(qc.shipper && qc.shipper.name === 'Michaels Furniture', 'shipper not captured');
      A.ok(qc.consignee && qc.consignee.name === 'Mike Smith', 'consignee not captured');
      A.ok(qc._lane === '90660->90035', 'party capture not lane-stamped: ' + qc._lane);
      A.ok(sh.pulls === 0, 'a pull fired during intake: ' + sh.pulls);
      // The agent path opens the form SILENTLY (the agent's own prose is the greeting, which the
      // harness cannot run) — the deterministic guarantee here is NO duplicate deterministic
      // greeting. The explicit-click greeting is asserted mechanically in step 10.
      const opens = bots(sh).filter(t => /Quote form is open/i.test(t));
      A.ok(opens.length <= 1, 'duplicate quote-form greetings: ' + opens.length);
      A.ok(!bots(sh).some(t => /how many (boxes|pieces)/i.test(t)), 'the retired STC intake question rendered');
      A.ok(/VOLUNTEERED ONLY, NEVER ASKED/.test(sh.ctx.g('_convoSysPrompt')), 'the STC volunteered-only prompt rule is missing');
    },
  },
  {
    id: 2, name: 'residence/liftgate/hazmat answered → pull attempt HELD for the insurance ask',
    async run(sh) {
      const w = sh.ctx.win;
      // The customer's "residence, no liftgate, not hazardous" is agent prose (sanctioned echo);
      // its deterministic footprint is the accessorial toggle plus the pull attempt.
      w._execUpdateQuote({ addAccessorials: ['RSD'], getRates: true });
      await sleep(700); // past the 450ms pull timer — nothing may fire
      A.ok(sh.pulls === 0, 'the pull fired before the mandatory insurance ask: ' + sh.pulls);
      const asks = bots(sh).filter(t => /cargo insurance/i.test(t));
      A.ok(asks.length === 1, 'expected exactly one insurance ask, got ' + asks.length);
      A.ok(w._insCollecting === 'value' && w._insAskRendered === true, 'the collector is not armed-with-render');
      A.ok((w._quoteFormState().accessorialCodes || []).indexOf('RSD') >= 0, 'RSD did not land on the form');
    },
  },
  {
    id: 3, name: '"$2500" settles via the known commodity (tables → General Goods) in ONE turn',
    async run(sh) {
      const w = sh.ctx.win;
      w.appendMessage('user', '$2500');
      await w.handleInput('$2500');
      await sleep(50);
      const rb = bots(sh).find(t => /Cargo insurance requested/.test(t));
      A.ok(rb, 'no insurance read-back rendered: ' + JSON.stringify(bots(sh)));
      A.ok(/General Goods &\/or Merchandise \(tables\)/.test(rb), 'read-back missing category (commodity): ' + rb);
      A.ok(/\$2,500\.00/.test(rb), 'declared value not two-decimal in read-back: ' + rb);
      A.ok(!bots(sh).some(t => /reply with a number|what type of commodity/i.test(t)), 'the commodity was re-asked despite being known');
      A.ok(sh.pulls === 1, 'expected exactly one pull, got ' + sh.pulls);
      A.ok(sh.lastPullInsured === true, 'INS was not on the pull');
      A.ok(bots(sh).some(t => /include cargo insurance on the declared \$2,500\.00/.test(t)), 'no evidence-gated inclusion line');
      A.ok(bots(sh).some(t => /\$388\.10/.test(t)), 'the rate summary price is missing/misformatted');
      assertTwoDecimalMoney(sh, 'step 3');
    },
  },
  {
    id: 4, name: '"jts" → ONE truthful greeting: both sides carried over, asks only date/PO',
    async run(sh) {
      const w = sh.ctx.win;
      w.appendMessage('user', 'jts');
      await w.handleInput('jts');
      let greet = null;
      for (let i = 0; i < 30 && !greet; i++) { await sleep(50); greet = greetings(sh)[0] || null; }
      A.ok(greetings(sh).length === 1, 'expected one booking greeting, got ' + greetings(sh).length + ': ' + JSON.stringify(greetings(sh)));
      A.ok(/^Booking JTS Express at \$388\.10 — /.test(greet), 'greeting header wrong: ' + greet);
      A.ok(/carried over/i.test(greet), 'greeting blind to the carried-over parties: ' + greet);
      A.ok(/pickup date/i.test(greet) && /PO number/i.test(greet), 'greeting does not ask date/PO: ' + greet);
      A.ok(!/tell me the shipper name/i.test(greet), 'greeting re-asked for filled details');
      A.ok(val(sh, 'bk-pu-name') === 'Michaels Furniture' && val(sh, 'bk-dl-name') === 'Mike Smith', 'parties not in the panel DOM');
      sh.panelNode = el(sh, 'bk-pu-name');
      assertTwoDecimalMoney(sh, 'step 4');
    },
  },
  {
    id: 5, name: '"po1234" captured, no carrier re-ask',
    async run(sh) {
      const w = sh.ctx.win;
      // Agent-owned turn: the PO reaches the panel via the agent's mandatory update_booking call.
      const r = await w._execUpdateBooking({ referenceNumber: 'po1234' });
      A.ok(r && r.ok, 'update_booking failed: ' + JSON.stringify(r));
      A.ok(val(sh, 'bk-pu-ref') === 'po1234', 'the PO did not land: ' + val(sh, 'bk-pu-ref'));
      A.ok(/JTS/i.test((w._bookingLock && w._bookingLock.rate && w._bookingLock.rate._name) || ''), 'the carrier lock drifted');
    },
  },
  {
    id: 6, name: '"jts" again → no wipe, no re-greet, state-truthful',
    async run(sh) {
      const w = sh.ctx.win;
      const before = greetings(sh).length;
      w.appendMessage('user', 'jts');
      await w.handleInput('jts');
      await sleep(400);
      A.ok(el(sh, 'bk-pu-name') === sh.panelNode, 'the panel was rebuilt on same-carrier re-selection');
      A.ok(val(sh, 'bk-pu-ref') === 'po1234' && val(sh, 'bk-dl-name') === 'Mike Smith', 'fields wiped on re-selection');
      A.ok(bots(sh).some(t => /already set at \$388\.10/.test(t)), 'no state-truthful reply');
      A.ok(greetings(sh).length === before, 'the booking greeting re-fired on re-selection');
    },
  },
  {
    id: 7, name: 'partial save (delivery contact cleared) → real backend BOL, no invented number',
    async run(sh) {
      const w = sh.ctx.win;
      const e = el(sh, 'bk-dl-contact'); if (e) e.value = '';
      sh.ctx.routes.push(
        { match: u => /\/applet\/v1\/rate\/save/.test(u), reply: () => ({ status: 200, body: { data: { results: { quoteNumber: 'Q-FLOW-1' } } } }) },
        { match: u => /\/applet\/v1\/book/.test(u),       reply: () => ({ status: 200, body: { data: { results: [{ BOLId: 'BOLID-FLOW1', BOLNmbr: '160177777', documents: [] }] } } }) },
      );
      // "Save the quote for now, don't book it yet" is agent-owned → the mandatory save_shipment call.
      const r = await w._execSaveShipment({});
      A.ok(r && r.ok === true, 'the save did not go through: ' + JSON.stringify(r));
      A.ok(r.BOLNumber === '160177777', 'BOL number is not the backend\'s: ' + r.BOLNumber);
      A.ok(sh.ctx.requests.some(rq => /\/applet\/v1\/book/.test(rq.url) && rq.method === 'POST'), 'no booking POST reached the backend path');
      const numbers = bots(sh).join(' ').match(/\b1601\d{5}\b/g) || [];
      A.ok(numbers.every(n => n === '160177777'), 'an invented BOL number appeared: ' + JSON.stringify(numbers));
    },
  },
  {
    id: 8, name: '"what carriers came back?" answered from existing rates, zero new pulls',
    async run(sh) {
      const w = sh.ctx.win;
      sh.agentCalls = 0;
      w.aiConverse = async () => { sh.agentCalls++; };
      w.waybAgent = async () => { sh.agentCalls++; };
      const pullsBefore = sh.pulls;
      w.appendMessage('user', 'what carriers came back?');
      await w.handleInput('what carriers came back?');
      A.ok(sh.pulls === pullsBefore, 'a rate question fired a new pull');
      A.ok(sh.agentCalls === 1, 'the question did not reach exactly one agent: ' + sh.agentCalls);
      const lr = w._lastRates;
      A.ok(lr && lr.count === fx.RATES.length, 'the existing rates are not available to answer from');
    },
  },
  {
    id: 9, name: 'alternate entry path → one bubble, one answer',
    async run(sh) {
      const w = sh.ctx.win;
      sh.agentCalls = 0;
      w._submitUserTurn('thanks, looks good');
      for (let i = 0; i < 30 && w._turnInFlight; i++) await sleep(25);
      const bubbles = sh.ctx.messages.filter(m => m.role === 'user' && m.text === 'thanks, looks good');
      A.ok(bubbles.length === 1, 'expected exactly one user bubble, got ' + bubbles.length);
      A.ok(sh.agentCalls === 1, 'expected exactly one agent turn, got ' + sh.agentCalls);
    },
  },
  {
    id: 10, name: 'programmatic Get a Quote → acknowledged, clean form, single reset/show fire',
    async run(sh) {
      const w = sh.ctx.win;
      let resets = 0, shows = 0;
      const r0 = w.resetShipmentState, s0 = w.showQuoteForm;
      w.resetShipmentState = x => { resets++; return r0(x); };
      w.showQuoteForm = (a, b) => { shows++; return s0(a, b); };
      sh.ctx.reset();
      w.startQuote();
      await sleep(150);
      w.resetShipmentState = r0; w.showQuoteForm = s0;
      A.ok(resets === 1 && shows === 1, 'reset/show multi-fired: resets=' + resets + ' shows=' + shows);
      A.ok(bots(sh).filter(t => /Quote form is open/i.test(t)).length === 1, 'the explicit open was not acknowledged exactly once');
      const q = w._quoteFormState();
      A.ok(q.quoteFormOpen && !q.origin && !q.destination, 'the fresh form is not clean: ' + q.origin + '/' + q.destination);
      const rows = sh.ctx.win.document.getElementById('right-panel').querySelectorAll('.qt-line');
      A.ok(rows.length === 1 && !String(rows[0].querySelector('.li-weight').value || '').trim(), 'ghost line-item survived the reset');
    },
  },
];

const negativeSteps = [
  {
    id: 'N1', name: 'unknown commodity → the canonical numbered list renders, zero pulls',
    async run(sh) {
      const w = sh.ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      await sleep(100);
      installPullStub(sh);
      w._applyQuoteFields({ getRates: true }); // agent pull attempt, insurance undecided
      await sleep(700);
      A.ok(sh.pulls === 0, 'a pull fired before the ask: ' + sh.pulls);
      A.ok(bots(sh).filter(t => /cargo insurance/i.test(t)).length === 1, 'no single insurance ask');
      w.appendMessage('user', '$2500');
      await w.handleInput('$2500');
      const listMsg = bots(sh).find(t => /Reply with a number/i.test(t));
      A.ok(listMsg, 'the numbered list did not render for an unknown commodity');
      const expected = sh.ctx.g('REDKIK_COMMODITIES').map((c, i) => (i + 1) + '. ' + c.name).join('\n');
      A.ok(listMsg.indexOf(expected) >= 0, 'the chat list does not mirror the canonical dropdown source');
      A.ok(sh.pulls === 0, 'a pull fired mid-collection');
    },
  },
  {
    id: 'N2', name: '"3" selects item 3 from the canonical list and settles',
    async run(sh) {
      const w = sh.ctx.win;
      w.appendMessage('user', '3');
      await w.handleInput('3');
      await sleep(50);
      const lqs = sh.ctx.g('lastQuotedShipment') || {};
      const third = sh.ctx.g('REDKIK_COMMODITIES')[2].name;
      A.ok(lqs.insuranceEnabled === true && lqs.insuranceCommodityName === third, '"3" did not select item 3 (' + third + '): ' + lqs.insuranceCommodityName);
      A.ok(sh.pulls === 1, 'the settle did not fire exactly one pull: ' + sh.pulls);
    },
  },
  {
    id: 'N3', name: 'the exact complaint sentence selects nothing; "no insurance" exits',
    async run(sh) {
      const w = sh.ctx.win;
      w.resetShipmentState(false);
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      await sleep(100);
      installPullStub(sh); sh.pulls = 0;
      w._applyQuoteFields({ getRates: true });
      await sleep(700);
      w.appendMessage('user', '$2500');
      await w.handleInput('$2500');
      sh.ctx.reset();
      const complaint = 'I alrwady told you the commodity, you used to present me with a list of like 1 thru 18 where i had to choose the  commodity';
      w.appendMessage('user', complaint);
      await w.handleInput(complaint);
      const lqs = sh.ctx.g('lastQuotedShipment') || {};
      A.ok(lqs.insuranceEnabled !== true, 'the complaint sentence settled insurance');
      // No SETTLE message may fire (the canonical list legitimately re-renders and itself contains
      // "Used Aircraft Engines" as row 10 — only a settle line would be a selection).
      A.ok(!bots(sh).some(t => /Cargo insurance requested/i.test(t)), 'the complaint selected a category: ' + JSON.stringify(bots(sh)));
      w.appendMessage('user', 'no insurance');
      await w.handleInput('no insurance');
      await sleep(50);
      A.ok(w._insCollecting === null, '"no insurance" did not exit the flow: ' + w._insCollecting);
      A.ok(w._insDecided === true, 'the decline was not recorded');
    },
  },
];

// ── Resilience & copy (Findings 1–3): each step gets its own fresh session ────
const PHONE_RE = /\(?800\)?[\s.\-]?687[\s.\-]?3713|8006873713/;
const resilienceSteps = [
  {
    id: 'R1', name: 'transient agent failure retries once and recovers — no error copy shown',
    async run() {
      const ctx = boot(); const w = ctx.win;
      try {
        let calls = 0;
        ctx.routes.push({ match: u => /anthropic-proxy/.test(u), reply: () => {
          calls++;
          return calls === 1
            ? { status: 503, body: { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } } }
            : { status: 200, body: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All set — anything else I can help with?' }] } };
        } });
        w.appendMessage('user', 'thanks');
        await w.aiConverse('thanks');
        const msgs = ctx.messages.filter(m => m.role === 'bot').map(m => m.text);
        A.ok(calls >= 2, 'the transient failure did not trigger a retry: calls=' + calls);
        A.ok(msgs.some(t => /anything else/i.test(t)), 'the recovered reply was not shown: ' + JSON.stringify(msgs));
        A.ok(!msgs.some(t => /hit a snag|trouble connecting/i.test(t)), 'error copy leaked despite recovery: ' + JSON.stringify(msgs));
      } finally { ctx.dom.window.close(); }
    },
  },
  {
    id: 'R2', name: 'hard failure → email-support copy, never a phone number, state preserved',
    async run() {
      const ctx = boot(); const w = ctx.win;
      try {
        w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 250, pieces: 3, length: 58, width: 30, height: 49 }, true);
        w._quotedContacts = { _lane: '90660->33511', shipper: { name: 'Michaels Furniture', address: '7240 Crider Ave' }, consignee: { name: 'Mike Smith', address: '1145 S Clark Drive' } };
        await sleep(50);
        ctx.routes.push({ match: u => /anthropic-proxy/.test(u), reply: () => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'invalid request' } } }) });
        w.appendMessage('user', 'is this thing on');
        await w.aiConverse('is this thing on');
        const msgs = ctx.messages.filter(m => m.role === 'bot').map(m => m.text);
        A.ok(msgs.some(t => /support@freightandlogistics\.ai/.test(t)), 'no email-support copy on hard failure: ' + JSON.stringify(msgs));
        A.ok(!msgs.some(t => PHONE_RE.test(t)), 'a phone number appeared in failure copy: ' + JSON.stringify(msgs));
        A.ok(msgs.some(t => /nothing you entered was lost|still here/i.test(t)), 'failure copy does not reassure data is safe: ' + JSON.stringify(msgs));
        // Quote/booking state must survive the failed turn.
        const q = w._quoteFormState();
        A.ok(q.origin === '90660' && q.destination === '33511', 'quote form state was lost on failure');
        A.ok(w._quotedContacts && w._quotedContacts.shipper && w._quotedContacts.shipper.name === 'Michaels Furniture', 'captured contacts were lost on failure');
        // A structured diagnostic was emitted (Finding 1b) — verify the stable prefix is reachable.
        A.ok(typeof w._agentTurnFailed === 'function', 'the structured failure logger is missing');
      } finally { ctx.dom.window.close(); }
    },
  },
  {
    id: 'R3', name: 'no customer-facing chat/error/toast string contains a phone number',
    async run() {
      const src = require(path.join(__dirname, '..', 'state', 'harness')).appScript();
      // Every line that RENDERS a bot chat bubble / error toast / chat error panel must not carry
      // the phone number. Formal document footers and the nav chrome phone link are out of scope.
      const renderRe = /appendMessage\(\s*['"]bot['"]|appendMsg\(\s*['"]bot['"]|showFormStatus\(\s*['"]error['"]|class="track-msg"|id="qt-rates-empty"|RATE_SUPPORT\s*=/;
      const offenders = src.split('\n')
        .map((l, i) => [i + 1, l])
        .filter(([, l]) => PHONE_RE.test(l) && renderRe.test(l));
      A.ok(offenders.length === 0, 'phone number in customer-facing chat/error copy: ' + offenders.map(([n, l]) => n + ': ' + l.trim().slice(0, 90)).join(' | '));
      // The canonical failure copy and rate-support constant carry no phone.
      const ctx = boot();
      try {
        A.ok(!PHONE_RE.test(ctx.g('AGENT_FAIL_MSG')), 'AGENT_FAIL_MSG contains a phone number');
        A.ok(!PHONE_RE.test(ctx.g('RATE_SUPPORT')), 'RATE_SUPPORT contains a phone number');
      } finally { ctx.dom.window.close(); }
    },
  },
  {
    id: 'R4', name: 'save confirmation points to My Shipments for dispatch (no phone, no "just ask")',
    async run() {
      const ctx = boot(); const w = ctx.win;
      try {
        w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 250, pieces: 3, length: 58, width: 30, height: 49 }, true);
        w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
        w.selectRate({ carrier: 'JTS' }, { shipment: fx.SHIPMENT, open: false, source: 'test' });
        ctx.routes.push(
          { match: u => /\/applet\/v1\/rate\/save/.test(u), reply: () => ({ status: 200, body: { data: { results: { quoteNumber: 'Q-R4' } } } }) },
          { match: u => /\/applet\/v1\/book/.test(u),        reply: () => ({ status: 200, body: { data: { results: [{ BOLId: 'BOLID-R4', BOLNmbr: '160188888', documents: [] }] } } }) },
        );
        const r = await w._execSaveShipment({});
        A.ok(r && r.ok === true && r.BOLNumber === '160188888', 'the save did not return the backend BOL: ' + JSON.stringify(r));
        A.ok(/My Shipments/.test(r.message), 'save copy does not point to My Shipments: ' + r.message);
        A.ok(/when you'?re ready to dispatch/i.test(r.message), 'save copy lost the dispatch instruction: ' + r.message);
        A.ok(!/come back and let me know|just come back/i.test(r.message), 'save copy still implies dispatch-by-asking: ' + r.message);
        A.ok(!PHONE_RE.test(r.message), 'save copy contains a phone number: ' + r.message);
      } finally { ctx.dom.window.close(); }
    },
  },
];

// ── Voice lifecycle (Finding 4): two sequential captures each complete cleanly ─
const voiceSteps = [
  {
    id: 'V1', name: 'two sequential voice captures each complete cleanly — no self-interrupt',
    async run() {
      const ctx = boot(); const w = ctx.win;
      try {
        // Mock the Web Speech recognizer: records start/abort, lets the test drive result/end.
        w.eval([
          'window.__recs = [];',
          'window.MockSR = function(){ var self=this; self.aborted=false; self.started=false;',
          '  self.onresult=null; self.onend=null; self.onerror=null; self.onstart=null;',
          '  self.continuous=false; self.interimResults=false; self.lang="";',
          '  self.start=function(){ self.started=true; };',
          '  self.stop=function(){ if(self.onend) self.onend(); };',
          '  self.abort=function(){ self.aborted=true; };',
          '  window.__recs.push(self); };',
          'window.SpeechRecognition = window.MockSR;'
        ].join('\n'));
        const recs = () => w.eval('window.__recs');
        const live = () => recs().filter(r => r.started && !r.aborted);
        const fireResult = (rec, txt) => rec.onresult({ resultIndex: 0, results: { 0: { isFinal: true, 0: { transcript: txt } }, length: 1 } });
        const submits = [];
        w._submitUserTurn = (t) => { submits.push(t); };
        w._vm.active = true; w._vm.state = 'listen';

        // Capture 1
        w._vmStartListen();
        A.ok(recs().length === 1 && live().length === 1, 'capture 1 did not open exactly one recognizer');
        const rec0 = recs()[0];
        fireResult(rec0, 'first message');
        rec0.onend();
        A.ok(submits.length === 1 && submits[0] === 'first message', 'capture 1 did not submit its transcript: ' + JSON.stringify(submits));
        A.ok(rec0.aborted, 'capture 1 recognizer was not released after its turn');

        // Simulate the post-reply relisten (what the speak tail does).
        w._vm.state = 'listen';
        w._vmStartListen();
        const rec1 = live()[0];
        A.ok(rec1 && rec1 !== rec0, 'capture 2 did not open a fresh recognizer');
        A.ok(live().length === 1, 'more than one recognizer is live at capture 2: ' + live().length);
        A.ok(w._vm.restartTimer === null, 'a stale restart timer survived into capture 2 — it can interrupt mid-word');

        // Capture 2 receives speech. A stale restart scheduled mid-capture must NOT tear it down.
        fireResult(rec1, 'second message');
        w._vmScheduleRestart(0);        // simulate a stray restart landing during the live capture
        await sleep(40);
        A.ok(!rec1.aborted, 'the live second capture was interrupted by a stale restart (self-interrupt)');
        A.ok(live().length === 1 && live()[0] === rec1, 'capture 2 was swapped for another recognizer mid-word');
        rec1.onend();
        A.ok(submits.length === 2 && submits[1] === 'second message', 'capture 2 did not submit cleanly: ' + JSON.stringify(submits));

        // Re-entrancy: a rapid double trigger cannot open two captures.
        w._vm.state = 'listen';
        const before = recs().length;
        w._vm.starting = true;          // pretend a start is mid-flight
        w._vmStartListen();             // must be ignored
        w._vm.starting = false;
        A.ok(recs().length === before, 're-entrancy guard failed — a second start opened another capture');
        w._vmTeardown();
      } finally { ctx.dom.window.close(); }
    },
  },
  {
    id: 'V2', name: 'self-echo is discarded during playback+tail; genuine barge-in is accepted and stops TTS',
    async run() {
      const ctx = boot(); const w = ctx.win;
      try {
        w.eval([
          'window.__recs = [];',
          'window.MockSR = function(){ var self=this; self.aborted=false; self.started=false;',
          '  self.onresult=null; self.onend=null; self.onerror=null; self.onstart=null;',
          '  self.continuous=false; self.interimResults=false; self.lang="";',
          '  self.start=function(){ self.started=true; };',
          '  self.stop=function(){ if(self.onend) self.onend(); };',
          '  self.abort=function(){ self.aborted=true; };',
          '  window.__recs.push(self); };',
          'window.SpeechRecognition = window.MockSR;'
        ].join('\n'));
        const recs = () => w.eval('window.__recs');
        const submits = [];
        w._submitUserTurn = (t) => { submits.push(t); };
        // fake result event with confidence
        const ev = (txt, conf) => ({ resultIndex: 0, results: { 0: { isFinal: false, 0: { transcript: txt, confidence: conf } }, length: 1 } });

        // Enter "speaking" state with a known TTS utterance and a fake audio handle we can watch.
        const spoken = 'booking jts express at three hundred dollars i need the pickup and delivery details';
        let paused = false;
        w._vm.active = true; w._vm.state = 'speak';
        w._vm.audio = { pause: () => { paused = true; } };
        w._vm.speakingText = spoken;
        w._vm.echoUntil = Infinity;                 // playback active
        w._vm.playStartedAt = Date.now() - w.eval('VM_LEADIN_MS') - 50; // past the lead-in guard
        w._vmStartBargeDetector();
        const brec = recs()[recs().length - 1];

        // (a) ECHO during playback — a transcript of our own TTS — is discarded; zero turns, no barge.
        brec.onresult(ev('the pickup and delivery details', 0.9));
        await sleep(20);
        brec.onresult(ev('i need the pickup and delivery', 0.9));
        A.ok(w._vm.state === 'speak', 'echo tripped a barge-in (state left speak)');
        A.ok(!paused, 'echo stopped the TTS');
        A.ok(submits.length === 0, 'echo was submitted as a turn: ' + JSON.stringify(submits));

        // (b) NON-matching speech during playback IS accepted → barge-in stops TTS and switches to listen.
        w._vm.bargeCandidateAt = 0;
        brec.onresult(ev('actually hold on stop', 0.9));   // candidate starts
        await sleep(w.eval('VM_BARGE_MIN_MS') + 60);        // persist past the duration floor
        brec.onresult(ev('actually hold on stop please', 0.9));
        A.ok(paused === true, 'a genuine barge-in did not stop the TTS');
        A.ok(w._vm.state === 'listen', 'a genuine barge-in did not switch to listening: ' + w._vm.state);

        // (c) after the decay tail, echo rejection is off (normal sensitivity resumes).
        A.ok(typeof w._vmEchoActive === 'function', '_vmEchoActive missing');
        w._vm.echoUntil = Date.now() + w.eval('VM_ECHO_TAIL_MS');
        A.ok(w._vmEchoActive() === true, 'echo should still be active within the decay tail');
        w._vm.echoUntil = Date.now() - 1;              // tail elapsed
        A.ok(w._vmEchoActive() === false, 'echo rejection did not lift after the decay tail');
        w._vmTeardown();
      } finally { ctx.dom.window.close(); }
    },
  },
  {
    id: 'V3', name: 'mic acquisition always carries echoCancellation + noiseSuppression + autoGainControl',
    async run() {
      const ctx = boot(); const w = ctx.win;
      try {
        let captured = null;
        w.navigator.mediaDevices = { getUserMedia: (c) => { captured = c; return Promise.resolve({ getTracks: () => [{ stop: () => {} }] }); } };
        w.eval('window.SpeechRecognition = function(){ this.start=function(){}; this.abort=function(){}; this.stop=function(){}; };');
        await w._vmAcquireMicStream();
        A.ok(captured && captured.audio, 'getUserMedia was called without an audio constraint');
        A.ok(captured.audio.echoCancellation === true, 'echoCancellation not requested');
        A.ok(captured.audio.noiseSuppression === true, 'noiseSuppression not requested');
        A.ok(captured.audio.autoGainControl === true, 'autoGainControl not requested');
        // The stream is held for the session and released on teardown.
        A.ok(w._vm.micStream, 'the AEC stream was not held for the session');
        w._vm.active = true; w._vmTeardown();
        A.ok(w._vm.micStream === null, 'the AEC stream was not released on teardown');
      } finally { ctx.dom.window.close(); }
    },
  },
];

async function runFlow() {
  const results = [];
  // The main ten-step flow shares ONE session, exactly like the live acceptance run.
  const ctx = boot();
  const sh = { ctx, pulls: 0, lastPullInsured: null };
  installPullStub(sh);
  let dead = false;
  for (const s of steps) {
    if (dead) { results.push({ id: s.id, name: s.name, status: 'SKIP', error: 'earlier step failed' }); continue; }
    try { await s.run(sh); results.push({ id: s.id, name: s.name, status: 'PASS' }); }
    catch (e) { results.push({ id: s.id, name: s.name, status: 'FAIL', error: String(e.message || e) }); dead = true; }
  }
  ctx.dom.window.close();
  // The negative flow gets its own fresh session.
  const ctx2 = boot();
  const sh2 = { ctx: ctx2, pulls: 0, lastPullInsured: null };
  let dead2 = false;
  for (const s of negativeSteps) {
    if (dead2) { results.push({ id: s.id, name: s.name, status: 'SKIP', error: 'earlier step failed' }); continue; }
    try { await s.run(sh2); results.push({ id: s.id, name: s.name, status: 'PASS' }); }
    catch (e) { results.push({ id: s.id, name: s.name, status: 'FAIL', error: String(e.message || e) }); dead2 = true; }
  }
  ctx2.dom.window.close();
  // Resilience/copy + voice steps each own their session (they simulate failures / mock APIs).
  for (const s of resilienceSteps.concat(voiceSteps)) {
    try { await s.run(); results.push({ id: s.id, name: s.name, status: 'PASS' }); }
    catch (e) { results.push({ id: s.id, name: s.name, status: 'FAIL', error: String(e.message || e) }); }
  }
  return results;
}

module.exports = { runFlow };

if (require.main === module) {
  runFlow().then(results => {
    for (const r of results) {
      console.log('  ' + (r.status === 'PASS' ? 'PASS' : r.status === 'SKIP' ? 'SKIP' : 'FAIL') + '  ' + r.id + '. ' + r.name + (r.error ? '\n        ' + r.error : ''));
    }
    const fails = results.filter(r => r.status !== 'PASS').length;
    console.log('\n  FLOW: ' + (results.length - fails) + '/' + results.length + ' steps green');
    process.exit(fails ? 1 : 0);
  });
}
