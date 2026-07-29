// Layer-2 harness — CHAT + QUOTING flow simulations in jsdom.
//
// Layer 1 (evals/state) proves per-action invariants and BYPASSES the LLM by calling the _exec*
// tools directly. Layer 2 drives the REAL turn pipeline: it stubs the single AI seam
// (window.flAnthropic, 9135) with hand-authored assistant turns — text and/or tool_use blocks —
// so the real aiConverse tool-loop (dispatch 14465-14666) and the real _gateFinalText enforcer
// (14708) run exactly as in production. Nothing here touches the network or the real model.
//
// It reuses the layer-1 loader wholesale: require('../state/harness').boot() gives the jsdom
// window, the recording fetch router (ctx.requests/ctx.routes), the getToken stub, and ctx.g()
// (w.eval seam for lexical-scope globals like chatHistory / REDKIK_COMMODITIES / _convoSysPrompt).

const path = require('path');
const { boot, appScript, PORTAL } = require(path.join(__dirname, '..', 'state', 'harness'));
const fx = require(path.join(__dirname, '..', 'state', 'fixtures'));
const L2FX = require('./fixtures');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── canned AI turn builders ───────────────────────────────────────────────────
// A "turn" is the parsed JSON object flAnthropic returns (aiConverse consumes data.content /
// data.stop_reason). text() and toolUse() build content blocks; turn() infers stop_reason.
const text = t => ({ type: 'text', text: t });
const toolUse = (name, input, id) => ({ type: 'tool_use', id: id || ('tu-' + name + '-' + Math.floor(input && input._n || 0)), name, input: input || {} });
function turn(blocks, stop) {
  const arr = Array.isArray(blocks) ? blocks : [blocks];
  return { content: arr, stop_reason: stop || (arr.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn'), usage: { input_tokens: 0, output_tokens: 0 } };
}

// Default fetch routes — every in-scope host answered from fixtures so no live endpoint is hit and
// ZIP/rate resolution succeeds. Cases push overrides onto ctx.routes (e.g. residential=true).
function defaultRoutes() {
  const has = (u, s) => u.indexOf(s) >= 0;
  return [
    { match: u => has(u, '/applet/v1/rate/multiple'), reply: () => ({ status: 200, body: { data: { results: { rates: fx.RATES } } } }) },
    { match: u => has(u, '/applet/v1/rate/save'),     reply: () => ({ status: 200, body: { data: { rateId: 'SAVED-RATE-1' } } }) },
    { match: (u, m) => /\/applet\/v1\/book(\/|\?|$)/.test(u) && m !== 'GET', reply: () => ({ status: 200, body: { BOLId: fx.SAVED_SHIPMENT.BOLId, BOLNumber: fx.SAVED_SHIPMENT.BOLNumber } }) },
    { match: u => /\/applet\/v1\/book\//.test(u),      reply: () => ({ status: 200, body: fx.SAVED_SHIPMENT }) },
    { match: u => has(u, '/applet/v2/dispatch/'),      reply: () => ({ status: 200, body: { ok: true } }) },
    { match: u => has(u, '/database/untable'),          reply: () => ({ status: 200, body: { data: { results: [] } } }) },
    // geocodio residential probe — default NON-residential; case 3 overrides to residential=true.
    { match: u => has(u, 'geocodio') && has(u, 'zip4'), reply: () => ({ status: 200, body: { results: [{ address_components: { city: 'Brandon', state: 'FL' }, fields: { zip4: { residential: false } } }] } }) },
    { match: u => has(u, 'geocodio'),                   reply: () => ({ status: 200, body: { results: [{ address_components: { city: 'Brandon', state: 'FL' } }] } }) },
    { match: u => has(u, 'zippopotam'),                 reply: () => ({ status: 200, body: { places: [{ 'place name': 'Brandon', 'state abbreviation': 'FL' }] } }) },
    { match: u => has(u, 'terms-proxy'),                reply: () => ({ status: 200, body: { termsCode: '', isPrepaid: false } }) },
  ];
}

// doGetRates-contract pull stub (verbatim from evals/flows/acceptance.js) — counts pulls, reads the
// INS panel, publishes fixture rates for the current lane, fires _onRatesReady. The form-open path
// reassigns window._doGetRates, so re-install AFTER every showQuoteForm.
function installPullStub(h) {
  const w = h.win;
  w._doGetRates = () => {
    h.pulls++;
    w._ratePullInFlight = true;
    const q = w._quoteFormState();
    const qc = w._quoteContainer;
    const insSel = qc && qc.querySelector('#qt-ins-commodity');
    const insVal = qc && qc.querySelector('#qt-ins-value');
    const insOn = !!(insSel && insSel.value && insVal && parseFloat(insVal.value) > 0);
    h.lastPullInsured = insOn;
    const insName = insOn ? ((h.g('REDKIK_COMMODITIES').find(c => c.id === insSel.value) || {}).name || '') : '';
    const shipment = Object.assign({}, fx.SHIPMENT, {
      originZip: q.origin || fx.SHIPMENT.originZip,
      destinationZip: q.destination || fx.SHIPMENT.destinationZip,
      insuranceEnabled: insOn, insuranceCommodityId: insOn ? insSel.value : '',
      insuranceCommodityName: insName, insuranceAmount: insOn ? parseFloat(insVal.value) : 0,
      items: [{ pieces: 1, weight: 450, length: 48, width: 40, height: 48, packageType: 'PLT', freightClass: '70', description: q.commodity || 'furniture' }],
    });
    w.publishRates(fx.RATES, shipment, { paint: false });
    w._ratePullInFlight = false;
    const cb = w._onRatesReady; w._onRatesReady = null;
    if (cb) { try { cb(fx.RATES); } catch (e) {} }
  };
}

// boot2 — boot() plus the layer-2 seams. Returns an augmented ctx (`h`).
function boot2(opts) {
  opts = opts || {};
  const ctx = boot({ routes: (opts.routes || []).concat(defaultRoutes()) });
  const w = ctx.win;

  ctx.pulls = 0;
  ctx.lastPullInsured = false;
  ctx.aiRequests = [];

  // Preseed the ZIP cache so fetchRates ZIP resolution succeeds WITHOUT a lookup fetch (zipCache is a
  // top-level const, reachable via w.eval). Default: the two fixture lanes resolve.
  ctx.seedZips = map => w.eval('Object.assign(zipCache, ' + JSON.stringify(map) + ')');
  ctx.seedZips({
    '90660': { city: 'Pico Rivera', state: 'CA', ok: true, reason: 'ok' },
    '33511': { city: 'Brandon',     state: 'FL', ok: true, reason: 'ok' },
    '90035': { city: 'Los Angeles', state: 'CA', ok: true, reason: 'ok' },
  });

  // scriptAI — install the flAnthropic queue. Each call shifts one canned turn (empty queue → benign
  // end_turn). Records request bodies to ctx.aiRequests. window.parent === window in jsdom, but set
  // both so the `window.parent.flAnthropic || fetch` seam always resolves to the stub.
  ctx.scriptAI = turns => {
    const q = (turns || []).slice();
    const stub = (url, opts2) => {
      let body = null; try { body = JSON.parse(opts2 && opts2.body); } catch (e) {}
      ctx.aiRequests.push({ url: String(url), body });
      const t = q.length ? q.shift() : turn([text('')], 'end_turn');
      return Promise.resolve(t);
    };
    w.flAnthropic = stub;
    try { w.parent.flAnthropic = stub; } catch (e) {}
  };

  // openQuote — materialize the quote form. stubPull:true installs the countable pull stub (default);
  // false leaves the REAL doGetRates in place so the outbound /rate/multiple payload is captured.
  ctx.openQuote = o => {
    o = o || {};
    w.showQuoteForm({ originZip: o.originZip || fx.SHIPMENT.originZip, destZip: o.destZip || fx.SHIPMENT.destinationZip }, true);
    if (o.stubPull !== false) installPullStub(ctx);
    return w._quoteContainer;
  };

  // Captured outbound rate requests, with the query parsed into a map (accessorialsList split on |).
  ctx.rateRequests = () => ctx.requests.filter(r => /\/applet\/v1\/rate\/multiple/.test(r.url)).map(r => {
    const qs = r.url.split('?')[1] || '';
    const out = { url: r.url, accessorials: [], insurance: null, freightInfo: null };
    qs.split('&').forEach(kv => {
      const i = kv.indexOf('='); const k = kv.slice(0, i); const v = decodeURIComponent(kv.slice(i + 1) || '');
      if (k === 'accessorialsList[]') out.accessorials = v.split('|').filter(Boolean);
      else if (k === 'commodityInsurance') out.insurance = Object.assign(out.insurance || {}, { commodityId: v });
      else if (k === 'insuranceAmount') out.insurance = Object.assign(out.insurance || {}, { amount: Number(v) });
      else if (k === 'freightInfo') { try { out.freightInfo = JSON.parse(v); } catch (e) {} }
    });
    return out;
  });

  ctx.installPullStub = () => installPullStub(ctx);
  ctx.bots = () => ctx.messages.filter(m => m.role === 'bot').map(m => m.text);
  ctx.close = () => ctx.dom.window.close();
  return ctx;
}

// Assertion helper (same shape as evals/state/invariants.js `A`).
const A = {
  ok(cond, msg) { if (!cond) throw new Error(msg); },
  eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg + ' — got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b)); },
};

module.exports = { boot2, A, sleep, text, toolUse, turn, appScript, PORTAL, fx, L2FX };
