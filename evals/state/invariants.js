// The state invariants. Each one is a property that must hold after EVERY action — not a test for
// one bug. `catches` records which of the reported bugs the invariant would have caught, so the
// harness output doubles as the map from property to incident.
//
// `expectFail: true` means the invariant is KNOWN to fail on today's code and the commit that makes
// it pass is named in `fixedBy`. Expected failures are printed loudly, never skipped — an
// expected-fail that starts passing is just as interesting as a pass that starts failing.

const fx = require('./fixtures');

const A = {
  ok(cond, msg) { if (!cond) throw new Error(msg); },
  eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg + ' — got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); },
};

// ── helpers ───────────────────────────────────────────────────────────────────
function openQuote(w) { w.showQuoteForm({ originZip: fx.SHIPMENT.originZip, destZip: fx.SHIPMENT.destinationZip }, true); }
function rows(w) { const p = w.document.getElementById('right-panel'); return p ? [...p.querySelectorAll('.qt-line')] : []; }
function rowVals(w) { return rows(w).map(r => ['.li-qty', '.li-weight', '.li-len', '.li-wid', '.li-hgt', '.li-commodity'].map(s => { const el = r.querySelector(s); return el ? el.value : ''; }).join('|')); }

const invariants = [
  // ── 1 ───────────────────────────────────────────────────────────────────────
  {
    id: 1, name: 'chat party state === form party state',
    property: 'after a party write, collectBookingForm() and _quoteFormState() report the same shipper and consignee',
    catches: 'bug (a) — smart-paste "already filled in" while the form is empty',
    run(ctx) {
      const w = ctx.win;
      openQuote(w); // the agent-facing snapshot only reports with a quote form open
      w.showBookingPanel({ _name: 'JTS Express', _price: 388.1 }, { originZip: '90660', destZip: '33511', lineItems: fx.SHIPMENT.items });

      // The agent path: update_booking writes the panel.
      w._applyBookingFields({
        shipper:   { name: 'Michaels Furniture', address: '7240 Crider Ave', contact: 'Dana', phone: '5625551234' },
        consignee: { name: 'Haynes Brothers',    address: '1250 Main St',    contact: 'Rick', phone: '8135559876' },
      });
      const cmp = side => {
        const form = w.collectBookingForm()[side] || {};
        const chat = (w._quoteFormState()[side]) || {};
        ['name', 'contact', 'phone'].forEach(k => {
          const a = String(form[k] || ''), b = String(chat[k] || '');
          A.ok(a === b, side + '.' + k + ': panel has "' + a + '" but the agent-facing snapshot has "' + b + '" — the two paths disagree');
        });
        const fa = String(form.street || ''), ca = String(chat.address || '');
        A.ok(fa === ca, side + '.address: panel has "' + fa + '" but the snapshot has "' + ca + '"');
        A.ok(fa !== '', side + '.address was never actually written — a claim with no write');
      };
      cmp('shipper'); cmp('consignee');

      // applyPartyData must report only what it really wrote: a bad element id counts as nothing.
      const r = w.applyPartyData({ shipper: { name: 'Second Co' } }, { source: 'test' });
      A.ok(r.written.includes('shipper.name'), 'a real write was not reported');
      const r2 = w.applyPartyData({ shipper: { nosuchfield: 'x' } }, { source: 'test' });
      A.ok(r2.written.length === 0, 'reported a write that did not happen: ' + JSON.stringify(r2.written));
    },
  },
  // ── 2 ───────────────────────────────────────────────────────────────────────
  {
    id: 2, name: 'adding a line never rewrites an existing line',
    property: "mode 'append' always adds; 'auto' edits only when the target is unambiguous; prior rows are byte-identical",
    catches: 'bug (b) — a 3rd item overwrote item 1',
    run(ctx) {
      const w = ctx.win; openQuote(w);
      // Explicit intent — what the agent is now instructed to send when the customer ADDS freight.
      w.applyLineItems([{ pieces: 1, weight: 100, length: 48, width: 40, height: 40, commodity: 'Chairs' }], { mode: 'append' });
      const a1 = rowVals(w);
      w.applyLineItems([{ pieces: 2, weight: 200, length: 48, width: 40, height: 50, commodity: 'Tables' }], { mode: 'append' });
      const a2 = rowVals(w);
      A.ok(a2.length >= a1.length, 'row count dropped: ' + a1.length + ' -> ' + a2.length);
      A.eq(a2[0], a1[0], 'row 0 was rewritten by the second add');
      w.applyLineItems([{ pieces: 3, weight: 300, length: 60, width: 40, height: 40, commodity: 'Sofas' }], { mode: 'append' });
      const a3 = rowVals(w);
      A.ok(a3.length === a2.length + 1, 'third add did not create a row: ' + a2.length + ' -> ' + a3.length);
      A.eq(a3[0], a1[0], 'row 0 was rewritten by the third add');
      A.eq(a3[1], a2[1], 'row 1 was rewritten by the third add');

      // The reported bug, in 'auto': several rows already exist and one unmatched item arrives.
      // It must APPEND — this is the case that used to land on row 0.
      const before = rowVals(w);
      w.applyLineItems([{ pieces: 4, weight: 400, length: 70, width: 40, height: 40, commodity: 'Desks' }], { mode: 'auto' });
      const after = rowVals(w);
      A.ok(after.length === before.length + 1, "'auto' overwrote instead of appending with " + before.length + ' rows present');
      A.eq(after[0], before[0], "'auto' rewrote row 0");

      // Editing is still possible, two ways: an explicit row index, and the unambiguous
      // single-row/single-item correction.
      w.applyLineItems([{ row: 1, weight: 222 }], { mode: 'auto' });
      A.ok(rows(w)[1].querySelector('.li-weight').value === '222', 'explicit row targeting did not edit row 1');
      A.ok(rowVals(w).length === after.length, 'an explicit-row edit changed the row count');

      const w2 = ctx.win; // fresh single-row form: one row + one item is an unambiguous edit
      w2.resetShipmentState(false); openQuote(w2);
      w2.applyLineItems([{ pieces: 1, weight: 500 }], { mode: 'auto' });
      A.ok(rows(w2).length === 1, 'single-row correction appended instead of editing: ' + rows(w2).length + ' rows');
    },
  },
  // ── 3 ───────────────────────────────────────────────────────────────────────
  {
    id: 3, name: 'the booking lock never outlives its rate list',
    property: 'after any publish, _bookingLock.rate is a member of the current _lastRatesRaw, or null',
    catches: 'bug B mode 2 — a stale lock hijacked a fresh carrier selection',
    run(ctx) {
      const w = ctx.win; openQuote(w);
      w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
      const sel = w.selectRate({ carrier: 'JTS' }, { shipment: fx.SHIPMENT, open: false });
      A.ok(sel.ok, 'selectRate could not resolve JTS: ' + (sel.code || ''));
      A.ok(w._lastRatesRaw.indexOf(w._bookingLock.rate.id ? w._lastRatesRaw.find(r => r.id === w._bookingLock.rate.id) : null) >= 0
        || w._lastRatesRaw.some(r => r.id === w._bookingLock.rate.id), 'lock is not in the current list');
      w._publishRatesForAI(fx.RATES_REPULL, fx.SHIPMENT);   // re-quote
      const lock = w._bookingLock;
      A.ok(lock === null || w._lastRatesRaw.some(r => r.id === lock.rate.id),
        'after re-publish the lock points at ' + (lock && lock.rate.id) + ', absent from the new list');
      if (lock) A.ok(/JTS/i.test(lock.rate._name || lock.rate.name), 'carrier identity drifted on re-key to ' + (lock.rate._name || lock.rate.name));
    },
  },
  // ── 4 ───────────────────────────────────────────────────────────────────────
  {
    id: 4, name: 'accessorials survive as one set',
    property: 'accessorialSet(labels) yields every selected code; BOL set keeps LAD/APD/INS and drops RSO',
    catches: 'bug (C) — LAD, appointment and INS silently dropped between the chips and accessorialsList',
    // Updated for commit 30c045a: appointment's REAL Primus code is APD ('APT' was never a valid
    // code). APD is an ordinary accessorial that rides BOTH the rate and the book accessorialsList.
    run(ctx) {
      const w = ctx.win;
      const codes = w.accessorialSet(fx.SHIPMENT.accessorials.concat(['Residential Pickup']));
      ['RSD', 'LFD', 'LAD', 'APD', 'INS', 'RSO'].forEach(c => A.ok(codes.includes(c), c + ' lost by accessorialSet'));
      A.ok(!codes.includes('APT'), 'the fake APT code resurfaced — appointment must map to APD');
      const BOL = ctx.g('ACC_BOL_CODES'), RATEABLE = ctx.g('ACC_RATEABLE_CODES');
      const bol = codes.filter(c => BOL.has(c));
      ['RSD', 'LFD', 'LAD', 'APD', 'INS'].forEach(c => A.ok(bol.includes(c), c + ' missing from the BOL set'));
      A.ok(!bol.includes('RSO'), 'RSO must stay a shipper flag, not an accessorial code');
      const rateable = codes.filter(c => RATEABLE.has(c));
      ['LAD', 'INS', 'APD'].forEach(c => A.ok(rateable.includes(c), c + ' must survive to the rate call'));
    },
  },
  // ── 5 ───────────────────────────────────────────────────────────────────────
  {
    id: 5, name: 'insurance toggle and declared value move together',
    property: "insuranceState().status === 'added' iff a commodity id and a positive amount both exist",
    catches: 'bug (d) — the insurance question repeated across turns',
    run(ctx) {
      const w = ctx.win; openQuote(w); // the agent-facing snapshot only reports with a form open
      A.ok(typeof w.insuranceState === 'function', 'no canonical insuranceState() owner');
      A.ok(typeof w.setInsurance === 'function', 'no canonical setInsurance() writer');
      const coherent = st => (st.status === 'added') === (!!st.commodityId && Number(st.amount) > 0);

      A.ok(w.insuranceState().status === 'not-addressed', 'a fresh session should be not-addressed');
      A.ok(coherent(w.insuranceState()), 'incoherent when fresh');

      // A half-added write must be REFUSED, not recorded — that is the state the re-ask loop fed on.
      let st = w.setInsurance({ status: 'added', amount: 5000 });         // no commodity
      A.ok(st.status !== 'added', 'accepted an amount with no commodity id');
      st = w.setInsurance({ status: 'added', commodityId: 'abc' });        // no amount
      A.ok(st.status !== 'added', 'accepted a commodity id with no amount');

      st = w.setInsurance({ status: 'added', amount: 5000, commodityId: 'abc', commodityName: 'General Goods' });
      A.ok(st.status === 'added' && Number(st.amount) === 5000, 'a complete add did not stick: ' + JSON.stringify(st));
      A.ok(coherent(st), 'incoherent after add');

      // It must PERSIST — the agent reads this to decide whether to ask again.
      A.ok(w.insuranceState().status === 'added', 'status did not survive the call');
      A.ok(/added/.test(w._quoteFormState().insurance ? w._quoteFormState().insurance.status : ''), 'the agent snapshot does not report it as added');
      A.ok(/do not ask about cargo insurance again/i.test(w._liveStateBlock()), 'the live state block does not tell the agent to stop asking');

      st = w.setInsurance({ status: 'declined' });
      A.ok(st.status === 'declined' && Number(st.amount) === 0, 'decline left a value behind: ' + JSON.stringify(st));
      A.ok(coherent(st), 'incoherent after decline');
      A.ok(/declined/.test(w._liveStateBlock()), 'a decline is not surfaced to the agent, so it will re-offer');
    },
  },
  // ── 6 ───────────────────────────────────────────────────────────────────────
  {
    id: 6, name: 'the edit target is never a guessed id',
    property: '_editingBOLId is null or a value returned by resolveBOLId',
    catches: 'bug (e) — PUT /book/<BOLNumber> returned 404 "Booking not found"',
    run(ctx) {
      const src = require('./harness').appScript();
      const bad = src.split('\n').map((l, i) => [i + 1, l])
        .filter(([, l]) => /window\._editingBOLId\s*=/.test(l) && !/=\s*null/.test(l))
        .filter(([, l]) => !/=\s*res\.bolId/.test(l));
      A.ok(bad.length === 0, 'non-resolveBOLId assignment(s): ' + bad.map(([n, l]) => n + ': ' + l.trim()).join(' | '));
      const w = ctx.win;
      return w.resolveBOLId(fx.SAVED_SHIPMENT.BOLNumber, { shipment: fx.SAVED_SHIPMENT }).then(r => {
        A.ok(r.ok, 'resolveBOLId failed on a record it was handed');
        A.ok(r.bolId === fx.SAVED_SHIPMENT.BOLId, 'resolved to ' + r.bolId + ' — must be the BOLId, never the BOLNumber');
      });
    },
  },
  // ── 7 ───────────────────────────────────────────────────────────────────────
  {
    id: 7, name: 'no silent mutate-and-return',
    property: 'a turn that mutates state without reaching the agent must be typed a command by classifyChatTurn',
    catches: 'bugs (c) "remove liftgate" became shipper:name, (f) the insurance question was deflected',
    run(ctx) {
      const w = ctx.win;
      A.ok(typeof w.classifyChatTurn === 'function', 'classifyChatTurn does not exist — interceptors mutate and return with no gate');

      // R1 is absolute: every interrogative reaches the agent untouched.
      ['how does insurance work if the carrier damages our product?',
       'can you remove the liftgate?',
       'what happens if it arrives damaged',
       'do you cover cargo insurance'].forEach(q => {
        const v = w.classifyChatTurn(q, { ratesOnScreen: true, bookingPanelOpen: true, quoteFormOpen: true });
        A.ok(v.kind === 'question', '"' + q + '" typed ' + v.kind + '/' + v.intent + ' — must be question');
      });

      // An edit phrase is a command, never party data — even with the booking panel open.
      ['remove liftgate', 'take off the residential', 'remove insurance'].forEach(e => {
        const v = w.classifyChatTurn(e, { bookingPanelOpen: true, quoteFormOpen: true });
        A.ok(v.kind === 'command', '"' + e + '" typed ' + v.kind + ' — must be command');
        A.ok(v.intent !== 'party-field', '"' + e + '" would still be written as party data');
      });

      // Free text with no licence is never party data.
      const v2 = w.classifyChatTurn('sounds good', { bookingPanelOpen: true });
      A.ok(v2.kind === 'freetext', '"sounds good" typed ' + v2.kind + ' — must fall through to the agent');

      // parseBookingBlock no longer turns a one-word phrase into a name.
      A.ok(!w.parseBookingBlock('remove liftgate', '').name, 'parseBookingBlock still yields a name for an edit phrase');

      // The live property: drive handleInput and require that anything which mutated without
      // reaching the agent was typed a command.
      const snap = () => JSON.stringify({
        lock: !!w._bookingLock, ins: w._insCollecting || null, editing: w._editingBOLId || null,
        pu: (w.document.getElementById('bk-pu-name') || {}).value || null,
      });
      let sawAgent = false;
      w.aiConverse = async () => { sawAgent = true; };
      w.waybAgent = async () => { sawAgent = true; };
      w.showBookingPanel({ _name: 'JTS Express', _price: 388.1 }, { originZip: '90660', destZip: '33511', lineItems: fx.SHIPMENT.items });
      w._bookingPanelContainer = w.document.getElementById('right-panel');
      const probes = ['remove liftgate', 'how does insurance work if the carrier damages our product?', 'sounds good'];
      return probes.reduce((chain, msg) => chain.then(async () => {
        sawAgent = false; const before = snap();
        const verdict = w.classifyChatTurn(msg, { bookingPanelOpen: true, quoteFormOpen: !!w._quoteFormOpen, ratesOnScreen: false });
        try { await w.handleInput(msg); } catch (e) { /* downstream network stubs are not the subject */ }
        const mutated = snap() !== before;
        if (mutated && !sawAgent) A.ok(verdict.kind === 'command', '"' + msg + '" mutated state without reaching the agent, typed ' + verdict.kind + '/' + verdict.intent);
      }), Promise.resolve());
    },
  },
  // ── 8 ───────────────────────────────────────────────────────────────────────
  {
    id: 8, name: 'a save is only reported saved when the backend said so',
    property: 'every ok:true carries a backend BOL; every ok:false emits none',
    catches: 'bug G — "Saved as BOL 160135280" after a 404',
    run(ctx) {
      const w = ctx.win;
      // Prime a prior SUCCESSFUL booking, which is exactly what used to leak into the next report.
      w._lastBooked = { BOLId: 'BOLID-OLD', BOLNumber: '160135280', dispatched: false };
      ctx.routes.length = 0;
      ctx.routes.push({ match: u => /\/applet\/v1\/book/.test(u), reply: () => ({ status: 404, body: { message: 'Booking not found' } }) });
      return w._execSaveShipment({}).then(res => {
        A.ok(res.ok === false, 'a 404 save reported ok:' + res.ok);
        const blob = JSON.stringify(res) + ctx.messages.map(m => m.text).join(' ');
        A.ok(!/160135280/.test(blob), 'the previous shipment\'s BOL leaked into a failed save report');
        A.ok(!/\bSaved as BOL\b/i.test(blob), 'success wording emitted on a failed save');
      });
    },
  },
  // ── 9 ───────────────────────────────────────────────────────────────────────
  {
    id: 9, name: 'intercept-authored turns land in the agent transcript',
    property: 'every rendered user/bot bubble is recorded in chatHistory (appendMessage is the ONE writer); skipHistory renders without recording',
    catches: 'the QA booking loop — "jts" swallowed by an intercept never reached the transcript, so the agent re-asked the carrier forever',
    async run(ctx) {
      const w = ctx.win; openQuote(w);
      w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
      // The send path: bubble first (records), then the turn. A bare carrier name resolves in the
      // deterministic intercept and never reaches the agent — exactly the class that used to vanish.
      w.appendMessage('user', 'jts');
      await w.handleInput('jts');
      const hist = ctx.g('chatHistory');
      A.ok(hist.some(m => m.role === 'user' && m.content === 'jts'), "the user's carrier selection is missing from chatHistory");
      const lastBot = hist.slice().reverse().find(m => m.role === 'assistant');
      A.ok(lastBot && /JTS/i.test(String(lastBot.content)), 'the intercept reply is missing from chatHistory: ' + JSON.stringify(lastBot || null));
      // skipHistory renders a bubble WITHOUT recording (transient error copy).
      const n = ctx.g('chatHistory').length;
      w.appendMessage('bot', 'transient error line', { skipHistory: true });
      A.ok(ctx.g('chatHistory').length === n, 'a skipHistory line leaked into the transcript');
      // An identical double-render is absorbed, never double-recorded.
      w.appendMessage('bot', 'dup line');
      w.appendMessage('bot', 'dup line');
      A.ok(ctx.g('chatHistory').filter(m => m.content === 'dup line').length === 1, 'a double-render was recorded twice');
    },
  },
  // ── 10 ──────────────────────────────────────────────────────────────────────
  {
    id: 10, name: 'a booking panel rebuild preserves the party data',
    property: 'party fields written before showBookingPanel re-runs are back in the DOM after the rebuild',
    catches: 'root cause B — every repeated carrier selection rebuilt the form blank over the pasted parties',
    run(ctx) {
      const w = ctx.win; openQuote(w);
      w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
      let sel = w.selectRate({ carrier: 'JTS' }, { shipment: fx.SHIPMENT, source: 'test' });
      A.ok(sel.ok, 'could not select JTS: ' + (sel.code || ''));
      w.applyPartyData({
        shipper:   { name: 'Michaels Furniture', address: '7240 Crider Ave', phone: '5625551234' },
        consignee: { name: 'Haynes Brothers',    address: '1250 Main St',    phone: '8135559876' },
      }, { source: 'test' });
      // A DIFFERENT carrier re-selection rebuilds the panel — the data must survive the rebuild.
      sel = w.selectRate({ carrier: 'AAA Cooper' }, { shipment: fx.SHIPMENT, source: 'test' });
      A.ok(sel.ok, 'could not select AAA Cooper: ' + (sel.code || ''));
      const v = id => (w.document.getElementById(id) || {}).value || '';
      A.ok(v('bk-pu-name') === 'Michaels Furniture', 'shipper name wiped by the rebuild: "' + v('bk-pu-name') + '"');
      A.ok(v('bk-dl-name') === 'Haynes Brothers', 'consignee name wiped by the rebuild: "' + v('bk-dl-name') + '"');
      A.ok(v('bk-pu-street') === '7240 Crider Ave' && v('bk-dl-street') === '1250 Main St', 'a street address was wiped by the rebuild');
    },
  },
  // ── 11 ──────────────────────────────────────────────────────────────────────
  {
    id: 11, name: 'same-carrier re-selection is a no-rebuild',
    property: 're-stating the locked carrier keeps the SAME panel DOM (no wipe) and answers from real state',
    catches: 'root cause C — every repeated "jts" wiped the form and re-emitted the same hardcoded greeting',
    async run(ctx) {
      const w = ctx.win; openQuote(w);
      w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
      w.appendMessage('user', 'jts');
      await w.handleInput('jts');          // opens the JTS panel via the intercept
      w.applyPartyData({ shipper: { name: 'Michaels Furniture', address: '7240 Crider Ave' } }, { source: 'test' });
      const nodeBefore = w.document.getElementById('bk-pu-name');
      A.ok(nodeBefore, 'no booking panel after the first selection');
      ctx.reset();
      w.appendMessage('user', 'jts');
      await w.handleInput('jts');          // the SAME carrier again
      const nodeAfter = w.document.getElementById('bk-pu-name');
      A.ok(nodeAfter === nodeBefore, 'the panel was rebuilt on a same-carrier re-selection');
      A.ok(nodeAfter.value === 'Michaels Furniture', 'typed data lost on re-selection: "' + nodeAfter.value + '"');
      const reply = ctx.messages.filter(m => m.role === 'bot').map(m => m.text).join(' ');
      A.ok(/already set/i.test(reply), 'no state-truthful reply on re-selection — got: ' + reply);
      A.ok(reply.indexOf('I need the pickup and delivery details') < 0, 'the hardcoded greeting was re-emitted on re-selection');
    },
  },
  // ── 12 ──────────────────────────────────────────────────────────────────────
  {
    id: 12, name: 'a partial save needs ZIPs only',
    property: 'validateBookingPayload passes with both ZIPs and nothing else; fails only on a missing ZIP',
    catches: 'Path B conviction 67da612 — the name requirements blocked the documented save-partial-and-finish-later flow',
    run(ctx) {
      const w = ctx.win;
      const ok = w.validateBookingPayload({ shipper: { zipCode: '90660' }, consignee: { zipCode: '33511' } });
      A.ok(ok.ok === true, 'a partial save (ZIPs only, no names) was refused: ' + JSON.stringify(ok));
      const bad = w.validateBookingPayload({ shipper: { name: 'Michaels Furniture' }, consignee: { name: 'Haynes Brothers' } });
      A.ok(bad.ok === false, 'a save with NO ZIPs was allowed');
      A.ok((bad.fields || []).indexOf('pickup ZIP') >= 0 && (bad.fields || []).indexOf('delivery ZIP') >= 0,
        'missing-ZIP report wrong: ' + JSON.stringify(bad.fields));
      A.ok(!(bad.fields || []).some(f => /name/i.test(f)), 'name requirements resurfaced: ' + JSON.stringify(bad.fields));
    },
  },
  // ── 13 ──────────────────────────────────────────────────────────────────────
  {
    id: 13, name: 'equipment vocabulary does not deflect an LTL customer',
    property: 'only unambiguous truckload phrasing deflects to email; 877bc26 vocabulary (48 ft, oversized, hot shot) falls through to the quote path',
    catches: 'Path B conviction 877bc26 — normal customers bounced to email instead of quoted',
    async run(ctx) {
      const w = ctx.win;
      let sawAgent = false;
      w.aiConverse = async () => { sawAgent = true; };
      w.waybAgent = async () => { sawAgent = true; };
      const deflected = () => ctx.messages.some(m => m.role === 'bot' && /truckload/i.test(m.text) && /support@freightandlogistics/i.test(m.text));
      // Genuine truckload still deflects (69efeb6 behavior, plural fix intact).
      ctx.reset(); await w.handleInput('I need a full truckload to Dallas');
      A.ok(deflected(), 'a genuine truckload ask no longer deflects');
      ctx.reset(); await w.handleInput('2 full truckloads of furniture next week');
      A.ok(deflected(), "the 69efeb6 plural fix ('truckloads') did not survive the revert");
      // 877bc26 vocabulary must NOT deflect.
      ctx.reset(); sawAgent = false;
      await w.handleInput('shipping an oversized recliner, 48 ft from my dock to the store');
      A.ok(!deflected(), "'oversized' / '48 ft' deflected a normal LTL customer to email");
      ctx.reset(); sawAgent = false;
      await w.handleInput('can you move a hot shot order of chairs for me');
      A.ok(!deflected(), "'hot shot' deflected a normal customer to email");
    },
  },
  // ── 14 ──────────────────────────────────────────────────────────────────────
  {
    id: 14, name: 'the output gate never silences a reply',
    property: '_gateFinalText returns non-empty text for any non-empty input; a whole-turn strip delivers the original and flags wouldHaveStripped',
    catches: 'Path B conviction d9ff59d — a gate false positive made the agent say nothing at all',
    run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511' }, true);
      w.setInsurance({ status: 'added', amount: 5000, commodityId: 'abc', commodityName: 'General Goods' });
      // First catch still regenerates (unchanged).
      const g1 = w._gateFinalText('Would you like to add cargo insurance?', { regenDone: false });
      A.ok(g1.regenerate === true, 'the one-shot regeneration path was lost');
      // Post-regen, a bare re-ask used to strip to NOTHING — it must now deliver the original.
      const g2 = w._gateFinalText('Would you like to add cargo insurance?', { regenDone: true });
      A.ok(String(g2.text).trim().length > 0, 'the gate silenced a whole turn (empty text returned)');
      A.ok(g2.wouldHaveStripped === true, 'a delivered-instead-of-stripped turn was not flagged/logged');
      // A bare unbacked promise (no pull in flight, no rates) also must not vanish.
      const g3 = w._gateFinalText('Give me a moment.', { regenDone: true });
      A.ok(String(g3.text).trim().length > 0, 'a bare promise was silenced instead of delivered');
      // Partial strips still work: offending sentence removed, the rest delivered.
      const g4 = w._gateFinalText('Your quote is ready to review. Would you like to add cargo insurance?', { regenDone: true });
      A.ok(/quote is ready/i.test(g4.text), 'the surviving sentence was lost in a partial strip');
      A.ok(!/add cargo insurance\?/i.test(g4.text), 'the offending re-ask survived a partial strip');
    },
  },
  // ── 15 ──────────────────────────────────────────────────────────────────────
  {
    id: 15, name: 'the geocoder verdict never reaches the chat agent',
    property: 'with a residential verdict cached, no agent-facing surface (live state block, system prompt) carries the classification; only the RDI overlays/dispatch check may speak it',
    catches: 'product-rule regression born 80dd91f/9afbca9/834ec3c — chat challenged the customer with "comes back residential"',
    run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511' }, true);
      w._residentialStatus = { residential: true, liftgateRecommended: true, weight: 450 };
      const ls = w._liveStateBlock();
      A.ok(ls.indexOf('residentialStatus') < 0, 'residentialStatus is still surfaced to the agent');
      A.ok(ls.indexOf('residentialConflict') < 0, 'residentialConflict instructions are still surfaced to the agent');
      A.ok(!/residential/i.test(ls), 'the live state block still mentions residential classification: ' + (ls.match(/.{0,60}residential.{0,60}/i) || [''])[0]);
      const sys = ctx.g('_convoSysPrompt');
      A.ok(sys.indexOf('comes back residential') < 0, 'the "comes back residential" challenge wording survives in the system prompt');
      A.ok(sys.indexOf('RESIDENTIAL / LIFTGATE SAFEGUARD') < 0, 'the RESIDENTIAL / LIFTGATE SAFEGUARD rule survives in the system prompt');
      A.ok(/NEVER YOURS TO RAISE/i.test(sys), 'the never-mention-classification rule is missing from the system prompt');
    },
  },
  // ── 16 ──────────────────────────────────────────────────────────────────────
  {
    id: 16, name: 'a plain refusal exits the insurance flow at any point',
    property: '"no"/"skip"/"no insurance"/"never mind" ends collection immediately in BOTH the value and commodity stages, and the 31-item numbered list is never shown',
    catches: 'insurance flow trapping customers who declined mid-collection; the numbered-list UX',
    async run(ctx) {
      const w = ctx.win; openQuote(w);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      // Value stage: plain "no" exits.
      w._insCollecting = 'value'; w._insValueArmed = true;
      await w.handleInput('no');
      A.ok(w._insCollecting === null, '"no" did not exit the value stage: ' + w._insCollecting);
      // Commodity stage: bare "no" exits too (used to require "cancel"/"no thanks").
      w._insCollecting = 'commodity'; w._insTempValue = 5000;
      ctx.reset();
      await w.handleInput('no');
      A.ok(w._insCollecting === null, '"no" did not exit the commodity stage: ' + w._insCollecting);
      A.ok(ctx.messages.some(m => m.role === 'bot' && /left cargo insurance off|without insurance/i.test(m.text)), 'no exit confirmation after a commodity-stage refusal');
      // The numbered commodity list is gone: a captured value asks free-text, no "Reply with a number".
      w._insCollecting = 'value'; w._insValueArmed = true; w._insReaskCount = 0;
      ctx.reset();
      await w.handleInput('5000');
      A.ok(w._insCollecting === 'commodity', 'a bare number on a just-asked turn was not captured as the value');
      const ask = ctx.messages.filter(m => m.role === 'bot').map(m => m.text).join(' ');
      A.ok(!/reply with a number|^\s*1\./im.test(ask) && !/\b1\.\s/.test(ask), 'the numbered commodity list is still shown: ' + ask.slice(0, 120));
      A.ok(/what type of commodity/i.test(ask), 'the free-text commodity ask is missing: ' + ask.slice(0, 120));
    },
  },
  // ── 17 ──────────────────────────────────────────────────────────────────────
  {
    id: 17, name: 'address and measurement digits never capture as a declared value',
    property: 'value capture requires monetary intent ($, money words, or the one-turn just-asked arm) and always rejects address/measurement-shaped digits',
    catches: 'the "1145 s drive is for sure a residence" → $1,145 declared-value misparse class',
    async run(ctx) {
      const w = ctx.win; openQuote(w);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      // The exact reported string, even on a just-asked (armed) turn, must NOT capture.
      w._insCollecting = 'value'; w._insValueArmed = true; w._insTempValue = null; w._insReaskCount = 0;
      ctx.reset();
      await w.handleInput('1145 s drive is for sure a residence');
      A.ok(w._insTempValue !== 1145 && w._insCollecting !== 'commodity', 'an address captured as a $1,145 declared value');
      A.ok(!ctx.messages.some(m => m.role === 'bot' && /\$\s*1,?145/.test(m.text)), 'the bot echoed the address digits as money');
      // Measurement digits do not capture either.
      w._insCollecting = 'value'; w._insValueArmed = true; w._insTempValue = null; w._insReaskCount = 0;
      await w.handleInput('each pallet is 450 lbs');
      A.ok(w._insTempValue !== 450 && w._insCollecting !== 'commodity', 'a weight captured as a declared value');
      // Un-armed, un-monetary bare digits do not capture...
      w._insCollecting = 'value'; w._insValueArmed = false; w._insTempValue = null; w._insReaskCount = 0;
      await w.handleInput('7500');
      A.ok(w._insCollecting !== 'commodity', 'a bare number captured with no arm and no monetary intent');
      // ...but genuine monetary intent always does, armed or not.
      w._insCollecting = 'value'; w._insValueArmed = false; w._insTempValue = null; w._insReaskCount = 0;
      await w.handleInput('$7,500');
      A.ok(w._insTempValue === 7500 && w._insCollecting === 'commodity', 'an explicit $7,500 was not captured: ' + w._insTempValue);
    },
  },
];

module.exports = { invariants, A };
