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
      // Unknown commodity (no commodity on this quote) → the canonical NUMBERED LIST renders
      // (Option B), then a free-text everyday word still resolves via the synonym mapper.
      w._insCollecting = 'value'; w._insValueArmed = true; w._insReaskCount = 0;
      ctx.reset();
      await w.handleInput('5000');
      A.ok(w._insCollecting === 'commodity', 'a bare number on a just-asked turn was not captured as the value');
      const ask = ctx.messages.filter(m => m.role === 'bot').map(m => m.text).join(' ');
      A.ok(/reply with a number/i.test(ask), 'the numbered list did not render for an unknown commodity: ' + ask.slice(0, 120));
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
    id: 29, name: 'Option B: known commodity settles silently; the list only when unknown; meta-talk never selects',
    property: 'a mappable quote commodity settles insurance with the read-back and no ask; unknown → the canonical numbered list; the live complaint sentence can never select a category',
    catches: 'the live repro — "tables" on the quote yet we asked, then "you USED to present me" selected Used Aircraft Engines',
    async run(ctx) {
      const w = ctx.win;
      // KNOWN commodity ("tables" on the quote) → "$2500" settles silently in one turn.
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 250, pieces: 3, length: 58, width: 30, height: 49,
        lineItems: [{ qty: 3, type: 'PLT', weight: 250, length: 58, width: 30, height: 49, commodity: 'tables' }] }, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      w._doGetRates = () => {};
      w._insCollecting = 'value'; w._insValueArmed = true; w._insAskRendered = true; w._insPreRate = true;
      ctx.reset();
      await w.handleInput('$2500');
      const lqs = w.eval('lastQuotedShipment') || {};
      A.ok(lqs.insuranceEnabled === true && Number(lqs.insuranceAmount) === 2500, 'known commodity did not settle silently: ' + JSON.stringify(ctx.messages.map(m => m.text)));
      A.ok(/General Goods/i.test(lqs.insuranceCommodityName || ''), '"tables" mapped wrong: ' + lqs.insuranceCommodityName);
      const rb = ctx.messages.find(m => /Cargo insurance requested/.test(m.text));
      A.ok(rb && /\(tables\)/.test(rb.text) && /\$2,500\.00/.test(rb.text), 'read-back missing category (commodity) $X.XX: ' + (rb && rb.text));
      A.ok(!ctx.messages.some(m => /reply with a number|what type of commodity/i.test(m.text)), 'the list/ask rendered despite a known commodity');
      // The live complaint sentence can NEVER select a category ("used" → Used Aircraft Engines).
      A.ok(w._matchInsCommodity('I alrwady told you the commodity, you used to present me with a list of like 1 thru 18 where i had to choose the  commodity') === null,
        'the complaint sentence still fuzzy-matches a category');
      // Qualifiers still work INSIDE synonym rules.
      A.ok(/Used Household Electronics/.test((w._matchInsCommodity('used electronics') || {}).name || ''), '"used electronics" lost its mapping');
      A.ok(w._matchInsCommodity('used') === null, 'a bare qualifier still selects a category');
      // The chat list mirrors the form dropdown source exactly.
      const expected = ctx.g('REDKIK_COMMODITIES').map((c, i) => (i + 1) + '. ' + c.name).join('\n');
      A.ok(w._insCommodityListText() === expected, 'the chat list drifted from the canonical REDKIK_COMMODITIES source');
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
  // ── 31 ──────────────────────────────────────────────────────────────────────
  {
    id: 31, name: 'the insurance commodity is always correctable — even after insuranceEnabled',
    property: '"change the commodity to X" settles in one turn; "the commodity is wrong" re-opens the list; value preserved; cancel keeps it as is',
    catches: 'a mis-set category (Used Aircraft Engines on tables) that could not be fixed before a certificate',
    async run(ctx) {
      const w = ctx.win;
      w.showQuoteForm({ originZip: '90660', destZip: '33511', weight: 450, pieces: 1, length: 48, width: 40, height: 48 }, true);
      w.eval('lastQuotedShipment = lastQuotedShipment || {}');
      w._doGetRates = () => {};
      w.setInsurance({ status: 'added', amount: 2500, commodityId: ctx.g("REDKIK_COMMODITIES.find(c=>/Aircraft/.test(c.name)).id"), commodityName: 'Used Aircraft Engines' });
      // Inline correction settles in one turn, preserving the value.
      ctx.reset();
      await w.handleInput('change the commodity to electronics');
      let lqs = w.eval('lastQuotedShipment');
      A.ok(/Household Electronics/.test(lqs.insuranceCommodityName || ''), 'inline correction did not settle: ' + lqs.insuranceCommodityName);
      A.ok(Number(lqs.insuranceAmount) === 2500, 'the declared value was lost in correction: ' + lqs.insuranceAmount);
      // "the commodity is wrong" re-opens the list; a number fixes it; cancel keeps as-is.
      ctx.reset();
      await w.handleInput('the commodity is wrong');
      A.ok(ctx.messages.some(m => /reply with a number/i.test(m.text)), 'the correction list did not render');
      await w.handleInput('cancel');
      lqs = w.eval('lastQuotedShipment');
      A.ok(lqs.insuranceEnabled === true && /Household Electronics/.test(lqs.insuranceCommodityName || ''), 'cancel did not keep the existing insurance: ' + lqs.insuranceCommodityName);
      ctx.reset();
      await w.handleInput('the commodity is wrong');
      await w.handleInput('4'); // Beer, Wine, and Spirits per the canonical list order
      lqs = w.eval('lastQuotedShipment');
      A.ok(/Beer, Wine/.test(lqs.insuranceCommodityName || ''), 'a number did not apply the correction: ' + lqs.insuranceCommodityName);
      A.ok(Number(lqs.insuranceAmount) === 2500, 'the value drifted through the list correction: ' + lqs.insuranceAmount);
    },
  },
  // ── 32 ──────────────────────────────────────────────────────────────────────
  {
    id: 32, name: 'shipment-progress resolver: events win, monotonic stages',
    property: 'a pickup EVENT with no pickup-date field still lights Picked Up; the status string lights the right stages; a later stage is NEVER lit while an earlier one is dark',
    catches: 'BOL 160135234 — header "IN TRANSIT" while the timeline showed Picked Up / In Transit / Delivered all dark (status string vs date fields)',
    run(ctx) {
      const w = ctx.win;
      const mono = st => {
        const order = ['booked', 'dispatched', 'pickedUp', 'inTransit', 'delivered'];
        let seenDark = false;
        for (const k of order) { if (!st[k]) seenDark = true; else if (seenDark) return false; }
        return true;
      };
      // A pickup EVENT but NO pickup date field → Picked Up lights anyway (events win over dates).
      let p = w.resolveShipmentProgress({ status: 'BOOKED' }, [{ status: 'Picked up', remarks: 'Origin scan', date: '2026-07-24' }]);
      A.ok(p.stages.pickedUp === true, 'a pickup event with no pickup-date field did not light Picked Up');
      A.ok(p.stages.booked && p.stages.dispatched, 'earlier stages not backfilled under a pickup event');
      A.ok(mono(p.stages), 'non-monotonic stages: ' + JSON.stringify(p.stages));
      A.ok(p.dates.pickedUp === '2026-07-24', 'the actual pickup date was not harvested from the event');
      // The exact reported case: status IN TRANSIT, no pickup date, no events → pickedUp + inTransit lit.
      p = w.resolveShipmentProgress({ lastStatus: 'IN_TRANSIT', trackingInformation: {} }, []);
      A.ok(p.stages.pickedUp && p.stages.inTransit, 'status IN TRANSIT did not light Picked Up + In Transit');
      A.ok(!p.stages.delivered, 'In Transit wrongly lit Delivered');
      A.ok(mono(p.stages), 'non-monotonic on the reported case: ' + JSON.stringify(p.stages));
      // A delivery event backfills everything, monotonic.
      p = w.resolveShipmentProgress({ status: 'BOOKED' }, [{ status: 'Delivered', remarks: 'Signed for' }]);
      A.ok(p.stages.delivered && p.stages.inTransit && p.stages.pickedUp && p.stages.dispatched, 'delivered did not backfill all prior stages');
      A.ok(mono(p.stages), 'non-monotonic under delivery: ' + JSON.stringify(p.stages));
      // A brand-new saved shipment (no status, no events) → only Booked.
      p = w.resolveShipmentProgress({}, []);
      A.ok(p.stages.booked && !p.stages.dispatched && !p.stages.pickedUp, 'a fresh shipment lit more than Booked: ' + JSON.stringify(p.stages));
    },
  },
  // ── 33 ──────────────────────────────────────────────────────────────────────
  {
    id: 33, name: 'header status and timeline read the SAME resolver (single source)',
    property: 'the detail modal resolves progress ONCE and both the header status and the timeline render from that one call — no second reader',
    catches: 'the split-brain class: header read the status string, timeline read date fields',
    run(ctx) {
      const src = require('./harness').appScript();
      const modal = src.slice(src.indexOf('async function showShipmentDetail'), src.indexOf('async function openDocsModal'));
      A.ok((modal.match(/resolveShipmentProgress\(/g) || []).length === 1, 'the modal does not resolve progress exactly once');
      A.ok(/const rawSt = _progress\.displayStatus/.test(modal), 'the header status no longer derives from the resolver');
      A.ok(/_progress\.stages/.test(modal) && /_progress\.dates/.test(modal), 'the timeline no longer derives from the resolver');
      // The old independent readers must be gone from the modal.
      A.ok(!/detail\.lastStatus\s*\|\|\s*ti\.lastStatusExternal/.test(modal), 'the old header status reader survives');
      A.ok(!/done:\s*!!\(ti2?\.pickupDateActual/.test(modal), 'the old date-field timeline reader survives');
    },
  },
  // ── 34 ──────────────────────────────────────────────────────────────────────
  {
    id: 34, name: 'tracking URLs: verified carriers enabled (static links carry no PRO), disabled set exact',
    property: 'the five hand-verified carriers resolve to non-null static page links (no PRO interpolated); the disabled set is exactly {WARP, Pitt Ohio, Daylight, Dohrn, Oak Harbor}; the guard disables the button rather than opening a broken page',
    catches: 'AAA Cooper Track opened a 404; carrier URLs rot silently; a repoint must not fake a PRO deep-link',
    run(ctx) {
      const w = ctx.win;
      const SENTINEL = 'ZZPRO999';
      // The DISABLED set is EXACTLY these five (WARP unreachable + four with no active carrier account).
      const disabled = ['WTCH', 'PITD', 'DYLT', 'DHRN', 'OAKH'];
      disabled.forEach(scac => A.ok(w.getCarrierTrackingUrl(scac, SENTINEL) === null, scac + ' should be disabled (null)'));
      // Nothing ELSE is null: the five repointed carriers now resolve to a URL.
      ['CNWY', 'SEFL', 'RDFS', 'PAAF', 'FCSY'].forEach(scac => {
        A.ok(!!w.getCarrierTrackingUrl(scac, SENTINEL), scac + ' was repointed but still returns null');
      });
      // Repointed URLs match the hand-verified targets…
      const want = {
        CNWY: /xpo\.com\/track\//,
        SEFL: /sefl\.com\/Tracing\/index\.jsp/,
        RDFS: /freight\.rrts\.com\/Tools\/Tracking/,
        PAAF: /delivers\.maersk\.com\/track/,
        FCSY: /frontlinefreightinc-tracking\.com\/facts\.htm/,
      };
      Object.keys(want).forEach(scac => {
        const u = w.getCarrierTrackingUrl(scac, SENTINEL) || '';
        A.ok(want[scac].test(u), scac + ' points at the wrong URL: ' + u);
        // …and are STATIC page links by design — the PRO is NEVER interpolated (form POST, no deep-link).
        A.ok(u.indexOf(SENTINEL) < 0, scac + ' interpolated the PRO into a static-link URL: ' + u);
      });
      // AAA Cooper (prior commit) stays repointed and static, not the dead Track.aspx.
      const aaa = w.getCarrierTrackingUrl('AACT', SENTINEL) || '';
      A.ok(/aaacooper\.com\/track\/shipment-tracking/.test(aaa) && !/Track\.aspx/i.test(aaa) && aaa.indexOf(SENTINEL) < 0, 'AAA Cooper URL regressed: ' + aaa);
      // A PRO-deep-link carrier still interpolates the PRO (proves the static-link check is meaningful).
      A.ok((w.getCarrierTrackingUrl('EXLA', SENTINEL) || '').indexOf(SENTINEL) >= 0, 'a deep-link carrier stopped interpolating the PRO');
      // No PRO → no URL regardless of carrier.
      A.ok(w.getCarrierTrackingUrl('EXLA', '') === null, 'a missing PRO still produced a URL');
      // The guard disables (not just no-ops) the button when there is no URL.
      const src = require('./harness').appScript();
      const modal = src.slice(src.indexOf('async function showShipmentDetail'), src.indexOf('async function openDocsModal'));
      A.ok(/else\s*\{[\s\S]*?trackBtn\.disabled = true;[\s\S]*?trackBtn\.title/.test(modal), 'the no-URL Track button is not fully disabled with a truthful tooltip');
    },
  },
  // ── 35 ──────────────────────────────────────────────────────────────────────
  {
    id: 35, name: 'sort comparators: reliable direction, empties always last, typed money/date/string',
    property: '_cmpValues flips deterministically with dir and always sinks empties in BOTH directions; the money/date/string extractors normalize $, commas, blanks and invalid dates to a sortable value or null',
    catches: 'F4(c/d): a repeat click not flipping direction, a blank/null cell aborting or reordering the sort, currency and date strings sorting lexically',
    run(ctx) {
      const w = ctx.win;
      // Direction flips deterministically (eval c).
      A.ok(w._cmpValues('apple', 'banana', 'asc') < 0, 'asc a<b failed');
      A.ok(w._cmpValues('apple', 'banana', 'desc') > 0, 'desc did not flip');
      // Numeric-aware string compare: "10" sorts after "2", not before.
      A.ok(w._cmpValues('2', '10', 'asc') < 0, 'numeric-aware compare failed');
      // Empties ALWAYS last, regardless of direction (eval d).
      A.ok(w._cmpValues('', 'x', 'asc') > 0 && w._cmpValues('', 'x', 'desc') > 0, 'empty string not sunk in both directions');
      A.ok(w._cmpValues(null, 5, 'asc') > 0 && w._cmpValues(null, 5, 'desc') > 0, 'null not sunk in both directions');
      A.ok(w._cmpValues('', '', 'asc') === 0, 'two empties are not equal');
      // Money extractor strips $/commas; blank/null → null.
      A.ok(w._moneySortVal('$1,234.50') === 1234.5, 'money parse failed');
      A.ok(w._moneySortVal('') === null && w._moneySortVal(null) === null, 'blank money not null');
      // Money sorts numerically, not lexically: $1,000 > $900.
      A.ok(w._cmpValues(w._moneySortVal('$1,000.00'), w._moneySortVal('$900.00'), 'asc') > 0, 'money sorted lexically ($900 > $1,000)');
      // A blank money cell sinks below a real one in BOTH directions.
      A.ok(w._cmpValues(w._moneySortVal(''), w._moneySortVal('$5.00'), 'asc') > 0 &&
           w._cmpValues(w._moneySortVal(''), w._moneySortVal('$5.00'), 'desc') > 0, 'blank money not last in both directions');
      // Date extractor: valid → epoch number, invalid/blank → null.
      A.ok(typeof w._dateSortVal('2026-07-01') === 'number', 'valid date not numeric');
      A.ok(w._dateSortVal('') === null && w._dateSortVal('not a date') === null, 'invalid/blank date not null');
    },
  },
  // ── 36 ──────────────────────────────────────────────────────────────────────
  {
    id: 36, name: 'sort wiring: shipments field map aligns 1:1, Invoices Status sorts, FILTERS clear the persisted sort',
    property: 'the shipments header→field array matches the cols array position-for-position; sortAndRenderInvoices gives Status a real comparator (isPaid + date tiebreak), not a binary no-op; a genuine filter/show-all re-render clears the PERSISTED sort (window._shipSort/_invSort) so a filtered view shows default order — distinct from a sort-triggered re-render, which preserves it (see 40)',
    catches: 'F4(a/b/e): Status/Total sorting the wrong column (off-by-one), the Invoices Status column doing nothing, a stat-tile filter leaving a stale sort applied',
    run(ctx) {
      const src = require('./harness').appScript();
      // Field map is 1:1 with the 11 sortable cols (BOL#…Total).
      A.ok(/\['bol','status','mode','created','estPU','estDEL','shipper','consignee','carrier','pro','total'\]\[idx\]/.test(src),
        'shipments field array not aligned 1:1 with cols');
      // Invoices Status is a real comparator keyed off isPaid, with a deterministic date tiebreak.
      const invSort = src.slice(src.indexOf('function sortAndRenderInvoices'), src.indexOf('function sortAndRenderInvoices') + 1500);
      A.ok(/field === 'status'/.test(invSort) && /isPaid/.test(invSort) && /_dateSortVal/.test(invSort),
        'Invoices Status has no real comparator (still a binary label no-op)');
      A.ok(/return _cmpValues\(va, vb, dir\)/.test(invSort), 'invoice sort does not route through the one canonical comparator');
      // A genuine FILTER change clears the persisted sort (2 shipments filter sites + 1 invoices).
      A.ok((src.match(/window\._shipSort = null;/g) || []).length >= 3, 'shipments filter/query sites do not clear window._shipSort');
      A.ok((src.match(/window\._invSort = null;/g) || []).length >= 2, 'invoice filter/fetch sites do not clear window._invSort');
    },
  },
  // ── 37 ──────────────────────────────────────────────────────────────────────
  {
    id: 37, name: 'shipment counts show the backend total for the window, never the loaded-row count',
    property: 'fetchNextBatch stores pagingDetails.totalResults on shipCtx.total; presentShips forwards it as shipmentsBackendTotal ONLY when no client filter dropped rows (loaded === matched); renderShipments and the panel tab render that total over the loaded length; the invoice tab counts the active-range set',
    catches: 'F1: My Shipments header/tab reporting ~130 loaded rows as the total on a ~1,850-shipment window',
    run(ctx) {
      const src = require('./harness').appScript();
      A.ok(/shipCtx\.total = \(pd1&&pd1\.totalResults!=null\) \? pd1\.totalResults : null;/.test(src),
        'fetchNextBatch does not store the backend total on shipCtx.total');
      A.ok(/list\.length===shipCtx\.loaded\.length && shipCtx\.total!=null/.test(src),
        'presentShips forwards the backend total without the no-client-filter guard');
      A.ok(/shipmentsBackendTotal: _backendTotal/.test(src), 'presentShips does not pass shipmentsBackendTotal');
      const rs = src.slice(src.indexOf('function renderShipments'), src.indexOf('function renderShipments') + 1400);
      A.ok(/backendTotal > allShipments\.length\) \? backendTotal : allShipments\.length/.test(rs),
        'renderShipments header does not prefer the backend total');
      A.ok(/shipmentsBackendTotal != null \? extras\.shipmentsBackendTotal/.test(src),
        'the shipments tab title does not use the backend total');
      A.ok(/window\._currentInvoiceList \? window\._currentInvoiceList\.length/.test(src),
        'the invoice tab title does not use the active-range set');
    },
  },
  // ── 38 ──────────────────────────────────────────────────────────────────────
  {
    id: 38, name: 'both lists default to a 30-day window; the panel drains it instead of counting a truncated set',
    property: 'the shipments rolling default is 30 days (shipmentDays===30 and the runShipQuery window is -30); a plain unfiltered panel list drains the whole window rather than stopping at SHIP_PAGE; the invoice panel and its date input default their active range to the last 30 days',
    catches: 'F2: a 90-day default, and a panel that filtered an already-truncated 100-row set instead of refetching/loading the active range',
    run(ctx) {
      const src = require('./harness').appScript();
      A.ok(/let shipmentDays\s*=\s*30;/.test(src), 'shipmentDays is not 30');
      A.ok(/else \{ from=new Date\(now\); from\.setDate\(from\.getDate\(\)-30\); \}/.test(src),
        'the runShipQuery rolling default window is not 30 days');
      A.ok(/const _isPanelList = q\.action==='list' && !q\.limit/.test(src), 'no panel-list full-load branch');
      A.ok(/while\(!shipCtx\.done && Date\.now\(\)<_dl\)\{ await fetchNextBatch\(\); \}/.test(src),
        'the panel list does not drain the whole window');
      A.ok(/_i30\.setDate\(_i30\.getDate\(\) - 30\)/.test(src), 'the invoice date input default is not 30 days');
      A.ok(/_inv30\.setDate\(_inv30\.getDate\(\)-30\)/.test(src), 'the invoice nav path does not default to a 30-day active range');
      // My Shipments has a VISIBLE in-panel date-range control mirroring the Invoices inputs, and its
      // handlers refetch the whole window (recount from the backend total) rather than filtering.
      A.ok(/id="ship-date-from"/.test(src) && /id="ship-date-to"/.test(src) &&
           /id="ship-date-apply"/.test(src) && /id="ship-date-all"/.test(src),
        'My Shipments is missing the in-panel date-range control (from/to/apply/all)');
      A.ok(/async function _loadShipWindow\(dateFrom, dateTo\)/.test(src), 'no _loadShipWindow refetch helper');
      const lsw = src.slice(src.indexOf('async function _loadShipWindow'), src.indexOf('async function _loadShipWindow') + 1000);
      A.ok(/while\(!shipCtx\.done && Date\.now\(\)<_dl\)\{ await fetchNextBatch\(\); \}/.test(lsw) &&
           /return \{ list: list, total: shipCtx\.total \}/.test(lsw),
        '_loadShipWindow does not drain the window and return the backend total');
      A.ok(/_loadShipWindow\(_shFromEl\.value, _shToEl\.value\)/.test(src), 'Apply does not refetch via _loadShipWindow');
      A.ok(/renderShipments\(list, list, 0, false, total\)/.test(src) && /openRightPanel\(newEl/.test(src),
        'the in-panel control does not re-render + recount the panel in place');
    },
  },
  // ── 39 ──────────────────────────────────────────────────────────────────────
  {
    id: 39, name: 'endpoints page at the supported size (100) and invoices never render a false empty state',
    property: '/applet/v1/invoice is fetched at limit=100 (verified supported: resultsPerPage=100, pages=276) and /book pages at perPage=100, both ~10x fewer round-trips than 10; the /book page count derives from server pages or the ACTUAL returned page size (never the requested limit) so a clamp can never under-page; a zero invoice harvest while the backend total is non-zero — or every page errored / nothing responded — throws INVOICE_FETCH_INCOMPLETE instead of returning [], so the caller shows truthful copy rather than a false "No invoices found."',
    catches: 'the page-size regression (10 → 49s/67s loads) and a non-empty backend rendering as "No invoices found."',
    async run(ctx) {
      const w = ctx.win;
      const src = require('./harness').appScript();
      A.ok(/invoice\?limit=100&page=/.test(src), 'invoice fetch is not at the supported limit=100');
      A.ok(/const perPage=100, BATCH=6;/.test(src), '/book fetchNextBatch is not paging at perPage=100');
      A.ok(/shipCtx\.totalPages = \(pd1&&pd1\.pages!=null\) \? pd1\.pages/.test(src), '/book page count does not prefer the server page count (clamp-safe)');
      A.ok(/const _effPer = arr1\.length \|\| perPage;/.test(src), '/book page count is not derived from the actual returned page size');
      const route = (body) => { ctx.routes.length = 0; ctx.routes.push({ match: (u) => u.includes('/applet/v1/invoice'), reply: () => ({ status: 200, body }) }); };
      // A non-empty backend response can NEVER render as "No invoices found": empty pages under a
      // non-zero backend total must throw, not return [].
      route({ data: { pagingDetails: { totalResults: 2050, pages: 205 }, results: [] } });
      let threw = false;
      try { await w.fetchInvoices(); } catch (e) { threw = (e && e.message === 'INVOICE_FETCH_INCOMPLETE'); }
      A.ok(threw, 'empty pages under a non-zero backend total did not throw (would render a false empty state)');
      // A genuine zero (backend total 0) is a legitimate empty state → returns [].
      route({ data: { pagingDetails: { totalResults: 0, pages: 0 }, results: [] } });
      let r; try { r = await w.fetchInvoices(); } catch (e) { r = 'THREW'; }
      A.ok(Array.isArray(r) && r.length === 0, 'a genuine zero did not return an empty array');
    },
  },
  // ── 40 ──────────────────────────────────────────────────────────────────────
  {
    id: 40, name: 'sort survives a panel re-render and toggles on repeat clicks (both tables)',
    property: 'sort state persists on window._shipSort/_invSort, not the transient table element, so a re-render (which rebuilds the table) preserves both the direction and the sorted row order, and a second click on the same column flips direction; a fresh query/window/filter clears it back to default order',
    catches: 'R2: clicking Total sorted once then did nothing — a re-render reset the on-element sortField, so every click read null and re-sorted ascending',
    async run(ctx) {
      const w = ctx.win;
      const mk = (bol, cost) => ({ BOLNumber: String(bol), vendor: { cost: cost, name: 'Estes' }, consignee: { name: 'C' + bol }, shipper: { name: 'S' + bol }, trackingInformation: {}, status: 'BOOKED' });
      const ships = [mk(1, 500), mk(2, 100), mk(3, 900), mk(4, 300), mk(5, 700)];
      const totalOf = t => { const tr = t.querySelector('tbody tr'); const td = tr.querySelectorAll('td'); return td[td.length - 2].textContent.trim(); };
      const mount = () => { const el = w.renderShipments(ships, ships, 0, false, 5); w.document.body.innerHTML = ''; w.document.body.appendChild(el); return el.querySelector('table'); };
      const thTotal = t => [...t.querySelectorAll('th')].find(x => x.dataset.field === 'total');
      w._shipSort = null;
      let table = mount();
      thTotal(table).onclick();
      A.ok(w._shipSort && w._shipSort.field === 'total' && w._shipSort.dir === 'asc', 'sort not persisted to window._shipSort after first click');
      A.ok(totalOf(table) === '$100.00', 'first click did not sort ascending');
      // The re-render that happens live between clicks must PRESERVE the sort (state AND row order).
      table = mount();
      A.ok(table.sortField === 'total' && table.sortDir === 'asc', 're-render lost the persisted sort state');
      A.ok(totalOf(table) === '$100.00', 're-rendered rows are not in sorted order');
      // The second click on the SAME column must FLIP to descending — the core R2 regression.
      thTotal(table).onclick();
      A.ok(w._shipSort.dir === 'desc' && totalOf(table) === '$900.00', 'repeat click did not toggle to descending');
      // A fresh query clears the persisted sort (default order restored).
      ctx.routes.length = 0;
      ctx.routes.push({ match: (u) => u.includes('/applet/v1/book'), reply: () => ({ status: 200, body: { data: { pagingDetails: { totalResults: 0 }, results: [] } } }) });
      await w.runShipQuery({ action: 'list', sortField: 'date', sortDir: 'desc' });
      A.ok(w._shipSort === null, 'a fresh query did not clear the persisted sort');
      // Invoices carry the identical persistence wiring (read + write + clear).
      const src = require('./harness').appScript();
      A.ok(/window\._invSort = \{ field: table\.sortField, dir: table\.sortDir \}/.test(src), 'invoice sort is not persisted to window._invSort');
      A.ok(/table\.sortField = \(window\._invSort && window\._invSort\.field\)/.test(src), 'invoice table does not seed from the persisted sort');
    },
  },
  // ── 41 ──────────────────────────────────────────────────────────────────────
  {
    id: 41, name: 'the space-separated datetime format parses/filters/sorts, and no in-range invoice is dropped',
    property: 'parseFreightDate handles the exact Primus format "2024-07-17 14:41:38" (engine-independent, unlike new Date()); the invoice date filter keeps in-range invoices and excludes out-of-range ones through that one parser; a row whose date cannot be parsed is KEPT (never silently dropped); and a non-zero fetch that filters to zero renders truthful in-range copy, never a bare "No invoices found."',
    catches: 'FACT 2: all 2,050 fetched invoices dropped to "Invoices (0)" on a Safari-fragile date path; silently dropping undated rows; a false empty state',
    run(ctx) {
      const w = ctx.win;
      // The exact live format parses to a finite timestamp (and _dateSortVal delegates to it).
      const ts = w.parseFreightDate('2024-07-17 14:41:38');
      A.ok(typeof ts === 'number' && isFinite(ts), 'the space-separated datetime did not parse');
      A.ok(w._dateSortVal('2024-07-17 14:41:38') === ts, '_dateSortVal does not route through parseFreightDate');
      A.ok(w.parseFreightDate('') === null && w.parseFreightDate('garbage') === null, 'blank/garbage did not yield null');
      // Build enriched invoices with the live format; filter through renderInvoices.
      const inv = (n, issue) => ({ invoiceNumber: String(n), bolNum: String(n), issueDate: issue, invoiceDueDate: '', total: 100, status: { paid: false }, _enriched: { bolNum: String(n), shipper: 'Haynes', consignee: 'X', carrier: 'Estes' } });
      const rowsOf = el => { const b = el.querySelector('tbody'); return b ? b.querySelectorAll('tr').length : 0; };
      const mixed = [inv(1, '2024-07-17 14:41:38'), inv(2, '2026-07-20 09:00:00'), inv(3, '2026-07-25 10:00:00')];
      A.ok(rowsOf(w.renderInvoices(mixed, mixed, '2026-06-28', '2026-07-28')) === 2, '30-day window did not keep exactly the two in-range invoices');
      A.ok(rowsOf(w.renderInvoices(mixed, mixed, '2010-01-01', '2026-07-28')) === 3, 'All Time did not keep every invoice');
      // An unparseable date is KEPT, not dropped.
      const withBad = [inv(1, ''), inv(2, '2026-07-25 10:00:00')];
      A.ok(rowsOf(w.renderInvoices(withBad, withBad, '2026-06-28', '2026-07-28')) === 2, 'an undated row was silently dropped instead of kept');
      // A non-zero fetch filtered to zero shows truthful in-range copy, NOT a bare "No invoices found."
      const allOld = [inv(1, '2024-07-17 14:41:38'), inv(2, '2024-08-01 10:00:00')];
      const el = w.renderInvoices(allOld, allOld, '2026-06-28', '2026-07-28');
      const txt = el.textContent || '';
      A.ok(rowsOf(el) === 0, 'the all-out-of-range set should render zero rows');
      A.ok(/Widen the date range|None of your/.test(txt) && !/^\s*No invoices found\.\s*$/.test(txt),
        'a non-zero fetch filtered to zero showed a bare "No invoices found." instead of truthful in-range copy');
    },
  },
];

module.exports = { invariants, A };
