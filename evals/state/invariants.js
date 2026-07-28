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
      await new Promise(r => setTimeout(r, 350)); // the state-aware panel greeting lands ~250ms after open
      const hist = ctx.g('chatHistory');
      A.ok(hist.some(m => m.role === 'user' && m.content === 'jts'), "the user's carrier selection is missing from chatHistory");
      const lastBot = hist.slice().reverse().find(m => m.role === 'assistant');
      A.ok(lastBot && /JTS/i.test(String(lastBot.content)), 'the selection outcome is missing from chatHistory: ' + JSON.stringify(lastBot || null));
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
      // Everyday words map to their Redkik CATEGORY — the list has no "furniture" entry, so the
      // brokerage's most common answer must resolve via the synonym mapper, not re-ask.
      ctx.reset();
      await w.handleInput('furniture');
      const lqs = w.eval('lastQuotedShipment') || {};
      A.ok(lqs.insuranceEnabled === true, '"furniture" did not resolve to a commodity category (insurance not enabled)');
      A.ok(/General Goods/i.test(lqs.insuranceCommodityName || ''), '"furniture" mapped to the wrong category: ' + lqs.insuranceCommodityName);
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
  // ── 18 ──────────────────────────────────────────────────────────────────────
  {
    id: 18, name: 'a rate promise with no pull behind it fires exactly one canonical pull',
    property: 'gate-detected rate promise + no settled/in-flight pull + ready form → exactly one _doGetRates; a pull already in flight fires nothing extra',
    catches: 'the live repro — "Rates are being pulled — I\'ll have them in a moment!" over a panel where no pull ever fired',
    run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      w._insDecided = true; // insurance already settled — enforcement must go straight to the pull
      let pulls = 0;
      w._doGetRates = () => { pulls++; w._ratePullInFlight = true; };
      const promise = "Rates are being pulled — I'll have them for you in just a moment!";
      const g = w._gateFinalText(promise, { regenDone: true });
      A.ok(pulls === 1, 'expected exactly one gate-enforced pull, got ' + pulls);
      A.ok(String(g.text).trim().length > 0, 'the backed promise was not delivered');
      A.ok(g.enforced === true, 'the enforcement was not flagged (console triage marker missing)');
      // (b) same promise with a pull already in flight → nothing extra fires.
      const g2 = w._gateFinalText(promise, { regenDone: true });
      A.ok(pulls === 1, 'a second pull was stacked while one was in flight: ' + pulls);
      A.ok(String(g2.text).trim().length > 0, 'the in-flight promise was not delivered');
    },
  },
  // ── 19 ──────────────────────────────────────────────────────────────────────
  {
    id: 19, name: 'a rate promise on an unready form becomes a truthful missing-fields ask',
    property: 'form open but missing weight/dims → the promise is replaced by the exact missing list; no pull fires',
    catches: 'delivering "I\'ll have them in a moment" over a form that cannot pull',
    run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511' }, true); // no weight, no dims
      w._insDecided = true;
      let pulls = 0;
      w._doGetRates = () => { pulls++; };
      const g = w._gateFinalText("Pulling your rates now — I'll have them in just a moment!", { regenDone: true });
      A.ok(pulls === 0, 'a pull fired on an unready form');
      A.ok(!/moment/i.test(g.text), 'the false promise survived: ' + g.text);
      A.ok(/still need/i.test(g.text) && /weight/i.test(g.text) && /dimensions/i.test(g.text),
        'the truthful missing-fields ask is wrong: ' + g.text);
    },
  },
  // ── 20 ──────────────────────────────────────────────────────────────────────
  {
    id: 20, name: 'a save promise is enforced via the canonical save, or replaced with the gap',
    property: 'promised save + lock + ZIPs → exactly one _execSaveShipment; no lock → truthful "I haven\'t saved anything yet" replacement',
    catches: 'the "saving it now" class — announced saves that never called the save path',
    async run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
      const sel = w.selectRate({ carrier: 'JTS' }, { shipment: fx.SHIPMENT, open: false, source: 'test' });
      A.ok(sel.ok, 'setup: could not select JTS');
      let saves = 0;
      w._execSaveShipment = async () => { saves++; return { ok: true, BOLNumber: '160135280', message: 'Shipment saved. BOL 160135280 is in My Shipments — dispatch when ready.' }; };
      w._turnToolCalls = { save: false, book: false, dispatch: false };
      const g = w._gateFinalText("Saving it now — you'll see it in My Shipments.", { regenDone: true });
      await new Promise(r => setTimeout(r, 20)); // the enforced save is async fire-and-announce
      A.ok(saves === 1, 'expected exactly one gate-enforced save, got ' + saves);
      A.ok(g.enforced === true, 'the save enforcement was not flagged');
      A.ok(ctx.messages.some(m => m.role === 'bot' && /BOL 160135280/.test(m.text)), 'the real save outcome was never announced');
      // Not performable (no carrier lock) → truthful replacement, no fire.
      w._bookingLock = null; w._gateSaveInFlight = false; saves = 0;
      w._turnToolCalls = { save: false, book: false, dispatch: false };
      const g2 = w._gateFinalText('Saving it now.', { regenDone: true });
      A.ok(saves === 0, 'a save fired with no carrier selected');
      A.ok(/haven'?t saved anything/i.test(g2.text) && /carrier/i.test(g2.text), 'no truthful replacement: ' + g2.text);
      // A save that really ran this turn is left alone.
      w._turnToolCalls = { save: true, book: false, dispatch: false };
      const g3 = w._gateFinalText('Saving it now.', { regenDone: true });
      A.ok(saves === 0 && /Saving it now/.test(g3.text), 'a genuinely-backed save promise was altered: ' + g3.text);
    },
  },
  // ── 21 ──────────────────────────────────────────────────────────────────────
  {
    id: 21, name: 'a book/dispatch promise is never gate-fired',
    property: 'irreversible actions are never fired by the gate — the promise is delivered with a truthful correction line instead',
    catches: 'the enforcement class over-reaching into irreversible writes',
    run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      w._insDecided = true;
      let books = 0, dispatches = 0;
      w._execBookShipment = async () => { books++; return { ok: true }; };
      w._execDispatchShipment = async () => { dispatches++; return { ok: true }; };
      w._turnToolCalls = { save: false, book: false, dispatch: false };
      const g = w._gateFinalText('Booking it now with JTS Express.', { regenDone: true });
      A.ok(books === 0 && dispatches === 0, 'the gate fired an irreversible action: books=' + books + ' dispatches=' + dispatches);
      A.ok(/haven'?t sent anything yet/i.test(g.text) && /book it/i.test(g.text), 'no truthful correction on an unbacked book promise: ' + g.text);
      // A book that really ran this turn gets no correction.
      w._turnToolCalls = { save: false, book: true, dispatch: false };
      const g2 = w._gateFinalText('Booking it now with JTS Express.', { regenDone: true });
      A.ok(!/haven'?t sent anything/i.test(g2.text), 'a genuinely-backed book promise was corrected: ' + g2.text);
    },
  },
  // ── 22 ──────────────────────────────────────────────────────────────────────
  {
    id: 22, name: 'the insurance ask fires for every quote — once, after hazmat, before the first pull',
    property: 'a getRates with insurance undecided renders the ask exactly once and pulls NOTHING; decline fires the single pull; the gate-enforced path obeys the same contract',
    catches: "tonight's repro — hazmat answered, pull fired immediately, the mandatory ask never rendered (born d9ff59d)",
    async run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      let pulls = 0; w._doGetRates = () => { pulls++; w._ratePullInFlight = true; };
      const asks = () => ctx.messages.filter(m => m.role === 'bot' && /cargo insurance/i.test(m.text)).length;
      w._applyQuoteFields({ getRates: true });        // the agent tries to pull, insurance undecided
      await new Promise(r => setTimeout(r, 600));      // past the 450ms pull timer — nothing may fire
      A.ok(pulls === 0, 'the pull fired before the mandatory insurance ask: ' + pulls);
      A.ok(asks() === 1, 'expected exactly one insurance ask, got ' + asks());
      A.ok(w._insCollecting === 'value' && w._insAskRendered === true, 'the collector armed without its rendered ask');
      w._applyQuoteFields({ getRates: true });        // second attempt mid-collection: held, no second ask
      await new Promise(r => setTimeout(r, 600));
      A.ok(pulls === 0 && asks() === 1, 'a mid-collection getRates pulled or re-asked: pulls=' + pulls + ' asks=' + asks());
      await w.handleInput('no');                       // only the customer can decline → the single pull fires
      await new Promise(r => setTimeout(r, 30));
      A.ok(pulls === 1, 'the decline did not fire the single pull: ' + pulls);
      A.ok(asks() === 1, 'the ask re-rendered after the decline');
      A.ok(w._insDecided === true, 'the decline was not recorded as permanent');
      // The gate-ENFORCED path on a fresh quote respects the same contract.
      w.resetShipmentState(false);
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      let pulls2 = 0; w._doGetRates = () => { pulls2++; w._ratePullInFlight = true; };
      ctx.reset();
      const g = w._gateFinalText('Pulling your rates now.', { regenDone: true });
      A.ok(pulls2 === 0, 'the enforcer pulled past an undecided insurance ask: ' + pulls2);
      A.ok(ctx.messages.filter(m => /cargo insurance/i.test(m.text)).length === 1, 'the enforcer did not fire the standard ask exactly once');
      A.ok(g.enforced === true, 'the enforcer hold was not flagged');
    },
  },
  // ── 23 ──────────────────────────────────────────────────────────────────────
  {
    id: 23, name: 'a ghost-armed value capture releases instead of eating the message',
    property: 'the collector may only hold a turn when its ask actually rendered; otherwise the message routes normally',
    catches: 'tonight\'s repro — armed with no ask ever rendered; "jts" became "I did not catch a dollar amount"',
    async run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
      w._insCollecting = 'value'; w._insValueArmed = true; w._insAskRendered = false; // the ghost
      w.appendMessage('user', 'jts');
      await w.handleInput('jts');
      A.ok(!ctx.messages.some(m => /did not catch a dollar amount/i.test(m.text)), 'the ghost collector ate the carrier selection');
      A.ok(w._insCollecting === null, 'the ghost collection did not release: ' + w._insCollecting);
      A.ok(!!w.document.getElementById('bk-pu-name'), 'the released "jts" did not select the carrier');
    },
  },
  // ── 24 ──────────────────────────────────────────────────────────────────────
  {
    id: 24, name: 'while armed WITH a rendered ask, a carrier name still releases and selects',
    property: 'command-shaped input (a carrier pick) routes as the command, never into value capture',
    async run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
      w.appendMessage('user', 'add insurance');
      await w.handleInput('add insurance');            // real intent ask: renders + arms in one turn
      A.ok(w._insCollecting === 'value' && w._insAskRendered === true, 'setup: the intent ask did not arm-with-render');
      ctx.reset();
      w.appendMessage('user', 'jts');
      await w.handleInput('jts');
      A.ok(!ctx.messages.some(m => /did not catch a dollar amount/i.test(m.text)), '"jts" was eaten by the value collector');
      A.ok(!!w.document.getElementById('bk-pu-name'), '"jts" did not select the carrier');
    },
  },
  // ── 25 ──────────────────────────────────────────────────────────────────────
  {
    id: 25, name: 'an insurance decline with no INS on the completed pull fires zero pulls',
    property: 'no pull may fire that cannot change the result — decline over an uninsured settled pull acknowledges and presents the existing rates',
    catches: "tonight's repro — \"no\" re-pulled the identical 51 carriers",
    async run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      w._publishRatesForAI(fx.RATES, fx.SHIPMENT);      // settled_with_rates, insurance NOT on the pull
      let pulls = 0; w._doGetRates = () => { pulls++; };
      w._insCollecting = 'value'; w._insValueArmed = true; w._insAskRendered = true; w._insPreRate = true; // tonight's exact state
      ctx.reset();
      await w.handleInput('no');
      A.ok(pulls === 0, 'a redundant pull fired on the decline: ' + pulls);
      A.ok(ctx.messages.some(m => /unchanged/i.test(m.text)), 'no acknowledge-with-existing-rates message: ' + JSON.stringify(ctx.messages.map(m => m.text)));
      A.ok(w._insDecided === true, 'the decline was not recorded as final');
    },
  },
  // ── 26 ──────────────────────────────────────────────────────────────────────
  {
    id: 26, name: 'prices render with two decimals on every surface',
    property: 'fmtMoney is canonical ($287.5 → $287.50, thousands separators) and the chat summary/greeting/choice-line surfaces use it',
    catches: 'the "$287.5" chat rate summary',
    run(ctx) {
      const w = ctx.win;
      A.ok(w.fmtMoney(287.5) === '$287.50', 'fmtMoney(287.5) => ' + w.fmtMoney(287.5));
      A.ok(w.fmtMoney(1234.5) === '$1,234.50', 'fmtMoney(1234.5) => ' + w.fmtMoney(1234.5));
      A.ok(w.fmtMoney('$287.5') === '$287.50', 'string input => ' + w.fmtMoney('$287.5'));
      w._lastRates = { lane: 'x', count: 1, options: [{ rank: 1, carrier: 'JTS Express', price: 287.5, transitDays: 4 }] };
      ctx.reset();
      w._summarizeRatesToChat();
      const msg = ctx.messages.map(m => m.text).join(' ');
      A.ok(/\$287\.50/.test(msg), 'the chat rate summary rendered: ' + msg);
      A.ok(!/\$287\.5(?!0)/.test(msg), 'a one-decimal price survives in the summary: ' + msg);
      A.ok(/\$287\.50/.test(w._bookingGreeting('JTS Express', 287.5)), 'greeting price not two-decimal');
      A.ok(/\$1,234\.50/.test(w._rateChoiceLine({ name: 'X', total: 1234.5 }, 1)), 'choice-line price not two-decimal');
    },
  },
  // ── 27 ──────────────────────────────────────────────────────────────────────
  {
    id: 27, name: 'one booking greeting per open, and it tells the truth about the form',
    property: 'panel open emits exactly one greeting whose content matches the DOM fill state; a filled panel is never asked for its own details',
    catches: "tonight's repro — two messages on open, the second demanding details over a fully filled panel",
    async run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511' }, true);
      w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
      w._quotedContacts = {
        shipper:   { name: 'Michaels Furniture', address: '7240 Crider Ave', phone: '5625551234' },
        consignee: { name: 'Haynes Brothers',    address: '1250 Main St',    phone: '8135559876' },
      };
      w._pendingContactRestore = { lane: fx.SHIPMENT.originZip + '->' + fx.SHIPMENT.destinationZip };
      const sel = w.selectRate({ carrier: 'JTS' }, { shipment: fx.SHIPMENT, source: 'test' });
      A.ok(sel.ok, 'setup: could not select JTS');
      await new Promise(r => setTimeout(r, 350));
      const greets = ctx.messages.filter(m => m.role === 'bot' && /^Booking .* at \$/.test(m.text));
      A.ok(greets.length === 1, 'expected exactly one greeting, got ' + greets.length + ': ' + JSON.stringify(ctx.messages.map(m => m.text)));
      A.ok(/carried over/i.test(greets[0].text), 'a filled panel was not acknowledged: ' + greets[0].text);
      A.ok(!/tell me the shipper name/i.test(greets[0].text), 'a filled panel was asked for its own details');
      A.ok(ctx.messages.every(m => m.text.indexOf('I need the pickup and delivery details') < 0), 'the deleted hardcoded line resurfaced');
      // A DIFFERENT lane on a fresh quote: the lane-stamped contacts must NOT bleed in — the
      // panel opens genuinely empty and the greeting gives the full ask, exactly once.
      w.resetShipmentState(false);
      const LANE2 = Object.assign({}, fx.SHIPMENT, { originZip: '10001', destinationZip: '60601', originCity: 'New York', destinationCity: 'Chicago' });
      w.showQuoteForm({ originZip: '10001', destZip: '60601' }, true);
      w._publishRatesForAI(fx.RATES, LANE2);
      w._quotedContacts._lane = '90660->33511'; // stamped for the FIRST shipment's lane
      ctx.reset();
      const sel2 = w.selectRate({ carrier: 'AAA Cooper' }, { shipment: LANE2, source: 'test' });
      A.ok(sel2.ok, 'setup: could not select AAA Cooper');
      await new Promise(r => setTimeout(r, 350));
      const v2 = id => (w.document.getElementById(id) || {}).value || '';
      A.ok(!v2('bk-pu-name') && !v2('bk-dl-name'), 'another lane\'s contacts bled into the new panel: ' + v2('bk-pu-name') + '/' + v2('bk-dl-name'));
      const greets2 = ctx.messages.filter(m => m.role === 'bot' && /^Booking .* at \$/.test(m.text));
      A.ok(greets2.length === 1, 'expected one greeting on the empty open, got ' + greets2.length);
      A.ok(/tell me the shipper name/i.test(greets2[0].text), 'the empty-panel greeting lost its ask: ' + greets2[0].text);
    },
  },
  // ── 28 ──────────────────────────────────────────────────────────────────────
  {
    id: 28, name: 'a combined insurance answer resolves value AND commodity in one turn',
    property: '"furniture, $2500", "$2500, furniture", and "furniture worth $2500" each settle insurance in a single turn with zero re-asks',
    catches: 'tonight\'s repro — "furniture, $2500" captured the value, discarded the commodity, then re-asked with "for example furniture"',
    async run(ctx) {
      const w = ctx.win;
      for (const answer of ['furniture, $2500', '$2500, furniture', 'furniture worth $2500']) {
        w.resetShipmentState(false);
        w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
        w.eval('lastQuotedShipment = lastQuotedShipment || {}');
        w._doGetRates = () => {};
        w._insCollecting = 'value'; w._insValueArmed = true; w._insAskRendered = true; w._insPreRate = true;
        ctx.reset();
        await w.handleInput(answer);
        const lqs = w.eval('lastQuotedShipment') || {};
        A.ok(lqs.insuranceEnabled === true && Number(lqs.insuranceAmount) === 2500,
          '"' + answer + '" did not settle value+commodity in one turn: enabled=' + lqs.insuranceEnabled + ' amount=' + lqs.insuranceAmount);
        A.ok(/General Goods/i.test(lqs.insuranceCommodityName || ''), '"' + answer + '" mapped commodity wrong: ' + lqs.insuranceCommodityName);
        A.ok(!ctx.messages.some(m => /what type of commodity/i.test(m.text)), '"' + answer + '" still re-asked for the commodity');
      }
    },
  },
  // ── 29 ──────────────────────────────────────────────────────────────────────
  {
    id: 29, name: 'a re-ask never offers an example the customer already used',
    property: 'the commodity ask and the no-match re-ask exclude any example term present in the customer\'s own prior messages',
    catches: 're-asking "for example furniture" right after the customer said furniture',
    async run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      w.appendMessage('user', 'it is furniture mostly'); // the term is now in the conversation
      // Value-only answer whose remainder maps to nothing → the commodity ask fires, minus "furniture".
      w._insCollecting = 'value'; w._insValueArmed = true; w._insAskRendered = true;
      ctx.reset();
      await w.handleInput('the total is $500 even');
      const ask = ctx.messages.filter(m => m.role === 'bot' && /commodity/i.test(m.text)).map(m => m.text).join(' ');
      A.ok(ask.length > 0, 'no commodity ask rendered');
      A.ok(!/furniture/i.test(ask), 'the ask offered a term the customer already used: ' + ask);
      A.ok(/electronics/i.test(ask), 'the ask lost its remaining examples: ' + ask);
      // No-match re-ask excludes it too.
      ctx.reset();
      await w.handleInput('blorptastic widgets');
      const reask = ctx.messages.filter(m => m.role === 'bot' && /could not match/i.test(m.text)).map(m => m.text).join(' ');
      A.ok(reask.length > 0, 'no no-match re-ask rendered');
      A.ok(!/furniture/i.test(reask), 'the re-ask offered a used term: ' + reask);
    },
  },
  // ── 30 ──────────────────────────────────────────────────────────────────────
  {
    id: 30, name: 'the greeting is sequenced after the restore chain, not timed',
    property: 'with full _quotedContacts present and a deliberately SLOW restore, the greeting still reports a filled panel — it waits for the chain, it does not race it',
    catches: 'tonight\'s repro — "I still need the delivery name…" over a panel whose restore landed a beat later',
    async run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511' }, true);
      w._publishRatesForAI(fx.RATES, fx.SHIPMENT);
      w._quotedContacts = {
        _lane: fx.SHIPMENT.originZip + '->' + fx.SHIPMENT.destinationZip,
        shipper:   { name: 'Michaels Furniture', address: '7240 Crider Ave', phone: '5625551234' },
        consignee: { name: 'Haynes Brothers',    address: '1250 Main St',    phone: '8135559876' },
      };
      // SLOW restore: the real fill happens 300ms later, returned as a promise. Sequencing (not a
      // timer) is the only way the greeting can still tell the truth.
      const _realFill = () => {
        const s = (id, v) => { const el = w.document.getElementById(id); if (el && !el.value) el.value = v; };
        const qc = w._quotedContacts;
        s('bk-pu-name', qc.shipper.name); s('bk-pu-street', qc.shipper.address); s('bk-pu-phone', qc.shipper.phone);
        s('bk-dl-name', qc.consignee.name); s('bk-dl-street', qc.consignee.address); s('bk-dl-phone', qc.consignee.phone);
      };
      w._restoreBookingFromQuoted = () => new Promise(res => setTimeout(() => { _realFill(); res(); }, 300));
      ctx.reset();
      const sel = w.selectRate({ carrier: 'JTS' }, { shipment: fx.SHIPMENT, source: 'test' });
      A.ok(sel.ok, 'setup: could not select JTS');
      // Poll for the greeting (it must arrive only after the slow restore resolves).
      let greet = null;
      for (let i = 0; i < 30 && !greet; i++) {
        await new Promise(r => setTimeout(r, 50));
        greet = ctx.messages.find(m => m.role === 'bot' && /^Booking .* at \$/.test(m.text)) || null;
      }
      A.ok(greet, 'no greeting arrived within 1.5s');
      A.ok(/carried over/i.test(greet.text), 'the greeting raced the slow restore and reported missing fields: ' + greet.text);
      A.ok(!/still need/i.test(greet.text), 'the greeting named fields the restore was about to fill: ' + greet.text);
      const v = id => (w.document.getElementById(id) || {}).value || '';
      A.ok(v('bk-dl-name') === 'Haynes Brothers', 'the slow restore itself did not land: ' + v('bk-dl-name'));
    },
  },
];

module.exports = { invariants, A };
