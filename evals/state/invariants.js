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
    property: 'collectBookingForm().shipper equals _quoteFormState().shipper (and consignee)',
    catches: 'bug (a) — smart-paste "already filled in" while the form is empty',
    expectFail: true, fixedBy: 'S6 applyPartyData (routing alone is not enough)',
    run(ctx) {
      const w = ctx.win;
      w.showBookingPanel({ _name: 'JTS Express', _price: 388.1 }, { originZip: '90660', destZip: '33511', lineItems: fx.SHIPMENT.items });
      // The agent path writes the panel DOM only.
      w._applyBookingFields({ shipper: { name: 'Michaels Furniture', address: '7240 Crider Ave' } });
      const form = w.collectBookingForm().shipper.name;
      const chat = (w._quoteFormState().shipper || {}).name || '';
      A.ok(form === chat, 'panel has "' + form + '" but the agent-facing snapshot has "' + chat + '" — the two paths disagree');
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
    property: 'accessorialSet(labels) yields every selected code; BOL set keeps LAD/APT/INS and drops RSO',
    catches: 'bug (C) — LAD, APT and INS silently dropped between the chips and accessorialsList',
    run(ctx) {
      const w = ctx.win;
      const codes = w.accessorialSet(fx.SHIPMENT.accessorials.concat(['Residential Pickup']));
      ['RSD', 'LFD', 'LAD', 'APT', 'INS', 'RSO'].forEach(c => A.ok(codes.includes(c), c + ' lost by accessorialSet'));
      const BOL = ctx.g('ACC_BOL_CODES'), RATEABLE = ctx.g('ACC_RATEABLE_CODES');
      const bol = codes.filter(c => BOL.has(c));
      ['RSD', 'LFD', 'LAD', 'APT', 'INS'].forEach(c => A.ok(bol.includes(c), c + ' missing from the BOL set'));
      A.ok(!bol.includes('RSO'), 'RSO must stay a shipper flag, not an accessorial code');
      const rateable = codes.filter(c => RATEABLE.has(c));
      A.ok(!rateable.includes('APT'), 'APT must be dropped from the RATE call only');
      A.ok(rateable.includes('LAD') && rateable.includes('INS'), 'LAD/INS must survive to the rate call');
    },
  },
  // ── 5 ───────────────────────────────────────────────────────────────────────
  {
    id: 5, name: 'insurance toggle and declared value move together',
    property: "insuranceState().status === 'added' iff a commodity id and a positive amount both exist",
    catches: 'bug (d) — the insurance question repeated across turns',
    expectFail: true, fixedBy: 'S7 insuranceState',
    run(ctx) {
      const w = ctx.win;
      A.ok(typeof w.insuranceState === 'function', 'no canonical insuranceState() owner exists yet — the toggle lives in _insCollecting/_insDecided and the value in lastQuotedShipment, with no single reader');
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
    expectFail: true, fixedBy: 'S8 classifyChatTurn',
    run(ctx) {
      const w = ctx.win;
      A.ok(typeof w.classifyChatTurn === 'function',
        'classifyChatTurn does not exist — interceptors at handleInput (SmartPaste, insurance intent, booking panel, wizard) mutate state and return with no gate');
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
];

module.exports = { invariants, A };
