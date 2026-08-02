// ── WIRE TESTS — stale form state, and city/ZIP ownership ────────────────────
//
//   node evals/state/wire.js      # standalone
//   node evals/state/run.js       # chained after the acceptance flow, every run
//
// Headless. No browser, no network, no credentials, no Primus writes. harness.js loads portal.html's
// real application script into jsdom and CAPTURES every fetch, so each assertion runs against the
// ACTUAL outgoing request rather than an intermediate variable.
//
// Why these exist, and why they are wire-level rather than unit tests: the July/August batch of
// corrupted saves were all "the payload disagreed with the form the customer was looking at". That
// is only observable at the request boundary — every one of these bugs left every in-memory variable
// looking plausible. Each case below asserts on a captured request or on the mounted DOM, never on
// an internal.
//
//   1a  a cold-boot tab restore opens the quote form silently and stamps no dedupe window
//   1b  a stale doGetRates closure refuses to pull, and a reset disarms the entrypoint
//   1c  a requote rates ITS OWN freight — zero residue from the previously-open shipment
//   2a  a panel rebuild never grafts a stale city, and the ZIP field is actually populated
//   2b  a divergent city/ZIP pair is refused BEFORE the write; a matching pair passes
//   2c  a ZIP-lookup outage writes nothing, logs loudly, and the guard fails OPEN
//   4   the [WRITE] tracer traces when armed and is silent when not

const { boot } = require('./harness');

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── fixtures ─────────────────────────────────────────────────────────────────
const RATES = { status: 200, body: { data: { results: [
  { id: 'R-saia-1', name: 'Saia LTL Freight', carrierName: 'Saia LTL Freight', serviceLevel: 'LTL Standard',
    total: 228.36, billTo: { total: 228.36 }, transitDays: 3, SCAC: 'SAIA' } ] } } };

const ZIPS = { '90035': ['Los Angeles', 'CA'], '90660': ['Pico Rivera', 'CA'],
               '33101': ['Miami', 'FL'], '30301': ['Atlanta', 'GA'], '90232': ['Culver City', 'CA'] };

function routes(opts) {
  opts = opts || {};
  return [
    { match: u => u.includes('zippopotam.us'), reply: u => {
        if (opts.zipOutage) return { status: 503, body: {} };
        const m = ZIPS[u.split('/').pop()];
        return m ? { status: 200, body: { places: [{ 'place name': m[0], 'state abbreviation': m[1] }] } }
                 : { status: 404, body: {} };
      } },
    // Geocodio is lookupZip's fallback — it must also be down to simulate a true ZIP-lookup outage.
    { match: u => u.includes('geocodio'),
      reply: () => opts.zipOutage ? { status: 503, body: {} } : { status: 404, body: {} } },
    { match: u => u.includes('/applet/v1/rate/multiple'), reply: () => RATES },
    { match: (u, m) => u.includes('/applet/v1/book') && (m === 'POST' || m === 'PUT'),
      reply: () => ({ status: 200, body: { data: { results: [{ BOLId: '999001', BOLNmbr: 'BOL-TEST-1' }] } } }) },
  ];
}

const CUSTOMER = 'currentCustomer = { name: "Haynes Brothers Furniture", code: "HAYNES", primusCustomerId: "1123086640" }';
const rateReqs = ctx => ctx.requests.filter(q => q.url.includes('/applet/v1/rate/multiple'));
const bookReqs = ctx => ctx.requests.filter(q => q.url.includes('/applet/v1/book'));
function freightOf(req) {
  const m = /[?&]freightInfo=([^&]*)/.exec(req.url);
  return m ? JSON.parse(decodeURIComponent(m[1])) : null;
}

// ── runner ───────────────────────────────────────────────────────────────────
async function runWire() {
  const results = [];
  const t = (id, name, fn) => ({ id, name, fn });
  const cases = [];

  cases.push(t('1a', 'cold boot: tab restore opens the quote form silently, stamps no dedupe window', async () => {
    const ctx = boot({ routes: routes() });
    const w = ctx.win;
    // currentCustomer is a top-level `let` — LEXICAL, not on window. restoreTabState early-returns
    // without it, so it must be assigned through a global eval, not w.currentCustomer.
    ctx.g(CUSTOMER);
    w.localStorage.setItem('rp_tabs', JSON.stringify([{ title: 'Get a Quote' }]));
    w.localStorage.setItem('rp_active_title', 'Get a Quote');
    ctx.reset();
    w.restoreTabState();
    await sleep(150);
    const tabs = ctx.g('rpState.tabs').map(x => x.title);
    assert(tabs.some(x => /Get a Quote/.test(x)), 'boot restore did not open the quote form; tabs=' + JSON.stringify(tabs));
    const greeted = ctx.messages.filter(m => /Quote form is open/i.test(m.text));
    assert(greeted.length === 0, 'boot restore greeted the customer (' + greeted.length + ' bubbles)');
    assert(w._qfLastBareOpen == null,
      '_qfLastBareOpen was stamped by the boot restore (' + w._qfLastBareOpen + ') — a real click landing '
      + 'within 600ms would be deduped and silently keep the restored form live');
    ctx.dom.window.close();
  }));

  cases.push(t('1b', 'a stale doGetRates closure refuses to pull; a reset disarms the entrypoint', async () => {
    const ctx = boot({ routes: routes() });
    const w = ctx.win;
    w.showQuoteForm({ originZip: '90660', destZip: '90035', lineItems: [
      { qty: 1, type: 'PLT', weight: 100, length: 48, width: 40, height: 40, stack: 'N', freightClass: '70' }] }, true);
    await sleep(150);
    const stale = w._doGetRates;                    // capture the OLD closure, exactly as callers do
    assert(typeof stale === 'function', 'showQuoteForm did not arm window._doGetRates');
    w.resetShipmentState(true);
    assert(w._doGetRates == null, 'resetShipmentState left window._doGetRates armed');
    assert(w._qfLastBareOpen == null, 'resetShipmentState left window._qfLastBareOpen stamped');
    ctx.reset();
    try { await stale(); } catch (e) {}             // fire the stale closure directly
    await sleep(300);
    const pulls = rateReqs(ctx);
    assert(pulls.length === 0,
      'a stale closure pulled rates (' + pulls.length + '): ' + pulls.map(p => p.url.slice(0, 120)).join(' | '));
    ctx.dom.window.close();
  }));

  cases.push(t('1c', 'a requote rates its own freight — zero residue from the open shipment', async () => {
    const ctx = boot({ routes: routes() });
    const w = ctx.win;
    // Shipment A — the "previous customer" left on the form.
    w.showQuoteForm({ originZip: '90660', destZip: '90035', lineItems: [
      { qty: 1, type: 'PLT', weight: 100, length: 48, width: 40, height: 40, stack: 'N', freightClass: '70' }] }, true);
    await sleep(150);
    ctx.reset();
    // Shipment B — requoted through the REAL Requote button on the saved-shipment modal.
    const B = { originZip: '33101', destinationZip: '30301', destZip: '30301',
      pickupDate: '2026-08-10', accessorials: [],
      freightInfo: [{ qty: 2, pieces: 2, weight: 250, length: 40, width: 40, height: 40,
                      dimType: 'PLT', class: '85', commodity: 'Chairs' }] };
    w.showSavedShipmentDispatchModal({ s: B, BOLId: '160100001', BOLNumber: 'BOL-B' });
    await sleep(80);
    const btn = [...w.document.querySelectorAll('button')].find(b => /^Requote$/.test(b.textContent.trim()));
    assert(btn, 'Requote button did not render');
    btn.click();
    await sleep(1000);                              // prefill build + the 500ms auto-rate
    const pulls = rateReqs(ctx);
    assert(pulls.length === 1, 'expected exactly one rate pull, got ' + pulls.length);
    const fi = freightOf(pulls[0]);
    const it = Array.isArray(fi) ? fi[0] : fi;
    assert(it && Number(it.weight) === 250,
      'requote rated the RESIDUAL weight instead of shipment B: weight=' + (it && it.weight) + ' (expected 250)');
    assert(it && Number(it.length) === 40 && Number(it.width) === 40 && Number(it.height) === 40,
      'requote rated residual dims: ' + (it && [it.length, it.width, it.height].join('x')) + ' (expected 40x40x40)');
    assert(!pulls[0].url.includes('90660') && !pulls[0].url.includes('90035'),
      'previous shipment ZIPs leaked into the requote rate request');
    ctx.dom.window.close();
  }));

  cases.push(t('2a', 'a panel rebuild never grafts a stale city, and the ZIP field is populated', async () => {
    const ctx = boot({ routes: routes() });
    const w = ctx.win;
    // bookingData holds a PREVIOUS shipment's party, including its city and ZIP.
    ctx.g('bookingData = ' + JSON.stringify({
      shipperName: 'Michaels Furniture', shipperStreet: '100 Main St', shipperCity: 'Pico Rivera',
      shipperState: 'CA', shipperZip: '90660', shipperContact: 'Ann', shipperPhone: '555-0100',
      consigneeName: 'John Smith', consigneeStreet: '8859 Horner Street', consigneeCity: 'PICO RIVERA',
      consigneeState: 'CA', consigneeZip: '90660', consigneeContact: 'John', consigneePhone: '555-0111'
    }));
    // Open on a 90660 → 90035 lane. 90035 is Los Angeles, NOT Pico Rivera.
    w.showBookingPanel({ id: 'R-saia-1', _name: 'Saia LTL Freight', _price: 228.36, total: 228.36 },
      { originZip: '90660', destZip: '90035', weight: 100, pieces: 1,
        lineItems: [{ qty: 1, weight: 100, length: 48, width: 40, height: 40, dimType: 'PLT', freightClass: '70' }] });
    await sleep(800);                               // let the async ZIP lookups land
    const g = id => { const e = w.document.getElementById(id); return e ? String(e.value || '') : '(missing)'; };
    const blank = ['name', 'street', 'city', 'state', 'zip', 'contact', 'phone']
      .filter(k => !g('bk-dl-' + k).trim());
    assert(blank.length === 0, 'consignee block is incomplete — blank: ' + JSON.stringify(blank));
    assert(g('bk-dl-city') === 'Los Angeles',
      'consignee city is not the ZIP-canonical city: ' + g('bk-dl-city') + ' (stale value was "PICO RIVERA")');
    assert(g('bk-dl-zip') === '90035',
      'consignee ZIP is not the lane ZIP: "' + g('bk-dl-zip') + '" — an empty ZIP field lets '
      + 'collectBookingForm fall through to the PREVIOUS shipment\'s ZIP');
    assert(g('bk-dl-state') === 'CA', 'consignee state does not match the ZIP: ' + g('bk-dl-state'));
    // The restore must not be over-narrowed: real party data still comes back.
    assert(g('bk-dl-name') === 'John Smith' && g('bk-dl-street') === '8859 Horner Street',
      'party restore was over-narrowed — name/street did not come back');
    ctx.dom.window.close();
  }));

  cases.push(t('2b', 'a divergent city/ZIP pair is refused before the write; a matching pair passes', async () => {
    const ctx = boot({ routes: routes() });
    const w = ctx.win;
    ctx.reset();
    let threw = null;
    try {
      await w.bookShipment({ shipper: { zipCode: '90660', city: 'Pico Rivera' },
                             consignee: { zipCode: '90035', city: 'PICO RIVERA' } }, {});
    } catch (e) { threw = e; }
    assert(threw && threw.code === 'CITY_ZIP_MISMATCH',
      'a divergent city/ZIP pair was not refused (threw: ' + (threw && (threw.code || threw.message)) + ')');
    assert(bookReqs(ctx).length === 0, 'a divergent pair still reached Primus');
    assert(/Los Angeles/.test(threw.message), 'the refusal does not name the rated city: ' + threw.message);
    ctx.reset();
    let res = null, err = null;
    try {
      res = await w.bookShipment({ shipper: { zipCode: '90660', city: 'Pico Rivera' },
                                   consignee: { zipCode: '90035', city: 'Los Angeles' } }, {});
    } catch (e) { err = e; }
    assert(!err && res && res.BOLId === '999001', 'a MATCHING pair was blocked: ' + (err && err.message));
    assert(bookReqs(ctx).length === 1, 'matching pair produced ' + bookReqs(ctx).length + ' writes, expected 1');
    ctx.dom.window.close();
  }));

  cases.push(t('2c', 'a ZIP-lookup outage writes nothing, logs loudly, and the guard fails OPEN', async () => {
    const ctx = boot({ routes: routes({ zipOutage: true }) });
    const w = ctx.win;
    const warns = [];
    w.console.warn = (...a) => warns.push(a.map(String).join(' '));
    w.document.body.insertAdjacentHTML('beforeend',
      '<input id="t-city" value="STALE CITY"><input id="t-state" value="ZZ">');
    await w.lookupZipCity('90035', 't-city', 't-state');
    assert(w.document.getElementById('t-city').value === 'STALE CITY',
      'an outage overwrote city/state with an unresolved value');
    assert(warns.some(s => /lookupZipCity/.test(s) && /could not resolve/i.test(s)),
      'an outage was not logged loudly; warns=' + JSON.stringify(warns.slice(0, 3)));
    // FAIL OPEN: a geocoder outage must not block every save.
    ctx.reset();
    let threw = null;
    try {
      await w.bookShipment({ shipper: { zipCode: '90660', city: 'Pico Rivera' },
                             consignee: { zipCode: '90035', city: 'PICO RIVERA' } }, {});
    } catch (e) { threw = e; }
    assert(!(threw && threw.code === 'CITY_ZIP_MISMATCH'),
      'the city/ZIP guard failed CLOSED on a lookup outage — a provider hiccup would block every save');
    assert(bookReqs(ctx).length === 1, 'the write did not proceed during a lookup outage');
    ctx.dom.window.close();
  }));

  cases.push(t('4', 'the [WRITE] tracer traces when armed and is silent when not', async () => {
    const armed = async on => {
      const ctx = boot({ routes: routes() });
      const w = ctx.win;
      if (on) w.localStorage.setItem('fp_debug', '1'); else w.localStorage.removeItem('fp_debug');
      w._fpDebugForced = null;
      const traces = [];
      w.console.trace = (...a) => traces.push(a.map(String).join(' '));
      w.showQuoteForm({ originZip: '90660', destZip: '90035', lineItems: [
        { qty: 1, type: 'PLT', weight: 100, length: 48, width: 40, height: 40, stack: 'N' }] }, true);
      await sleep(150);
      w._applyQuoteFields({ originZip: '33101', items: [{ weight: 250 }] });
      await sleep(150);
      ctx.dom.window.close();
      return traces.filter(x => /\[WRITE\]/.test(x));
    };
    const on = await armed(true);
    assert(on.length > 0, 'the tracer produced no [WRITE] traces when armed');
    assert(on.some(x => /qt-origin/.test(x)), 'no trace named the origin field: ' + on.slice(0, 3).join(' || '));
    assert(on.some(x => /li-weight/.test(x)), 'no trace named the weight field');
    const off = await armed(false);
    assert(off.length === 0, 'the tracer emitted ' + off.length + ' traces while disarmed');
  }));

  for (const c of cases) {
    try { await c.fn(); results.push({ id: c.id, name: c.name, status: 'PASS' }); }
    catch (e) { results.push({ id: c.id, name: c.name, status: 'FAIL', error: String(e && e.message || e) }); }
  }
  return results;
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

module.exports = { runWire };

if (require.main === module) {
  const C = process.stdout.isTTY
    ? { g: s => '\x1b[32m' + s + '\x1b[0m', r: s => '\x1b[31m' + s + '\x1b[0m' }
    : { g: s => s, r: s => s };
  process.on('unhandledRejection', () => {});   // post-teardown jsdom async, same as run.js
  runWire().then(rs => {
    console.log('\n  WIRE TESTS — evals/state/wire.js\n');
    rs.forEach(r => console.log((r.status === 'PASS' ? C.g('  PASS') : C.r('  FAIL')) + '  ' + r.id + '. ' + r.name
      + (r.error ? '\n        ' + C.r(r.error.slice(0, 400)) : '')));
    const bad = rs.filter(r => r.status !== 'PASS').length;
    console.log('\n  WIRE: ' + C[bad ? 'r' : 'g']((rs.length - bad) + '/' + rs.length + ' green') + '\n');
    process.exit(bad ? 1 : 0);
  });
}
