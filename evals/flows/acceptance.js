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
