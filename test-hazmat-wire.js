/**
 * Wire-level regression test: hazmat UN + packing group reach the Primus
 * POST /applet/v1/book body as STRUCTURED lineItem fields — REAL CODE.
 *
 * Does NOT reimplement any portal logic. It loads portal.html, evaluates its
 * actual <script>, and drives the REAL booking builders, asserting against each
 * builder's ACTUAL outbound POST body to /applet/v1/book.
 *
 * Three builders, three call paths (the form-vs-agent split that has caused
 * repeated regressions), each covered by its own scenario:
 *   S1  submitBookingOnly  — the form Book button (showBookingPanel -> #bk-submit-btn
 *                            onclick -> submitBookingOnly), UN picked from the lookup.
 *   S2  submitBooking      — the chat "confirm" booking path, called directly with the
 *                            real globals seeded as a user's form would leave them.
 *   S3  _execBookShipment  — the agent book_shipment tool path, called with a hazmat
 *                            input. (Production agent cannot yet supply hazmat — the
 *                            book_shipment tool schema has no hazmat fields — so this
 *                            proves the BUILDER mapping, not an end-to-end agent flow.
 *                            End-to-end agent hazmat is a separate future commit.)
 *   S4  submitBookingOnly  — form path, customer TYPES "UN1993" instead of picking from
 *                            the dropdown; the leading "UN" must be stripped to "1993".
 *
 * ASSERTION (each scenario, against the real intercepted POST body):
 *   A) body.lineItems[<hazmat line>].UN         === entered UN ('1993')
 *   B) body.lineItems[<hazmat line>].UNPKGGroup === entered packing group ('III')
 *      (S4 omits B — a typed UN with no lookup has no packing group)
 *   C) body.BOLInstructions does NOT contain '1993' or 'UN1993'
 *
 * The real UN lookup (wireUNTypeahead, portal.html:2577) writes the raw untable
 * UNNumber ('1993', no prefix) to #bk-haz-un.value and the packing group to
 * #bk-haz-un.dataset.unPg. Scenarios simulate exactly that.
 *
 * USAGE: node test-hazmat-wire.js [path-to-portal.html]   (default: ./portal.html)
 *   Against HEAD (no fix) -> every scenario FAILs A/B/C.
 *   Against fixed file    -> every scenario PASSes.
 *
 * STUBS (full disclosure — none is logic under test): window.fetch is the interception
 * point + capture (answers login / zippopotam / geocodio / rate-save with benign
 * fixtures, captures the /applet/v1/book POST body, returns a fake BOL result);
 * window.alert no-op; auth state (currentCustomer/primusToken/primusExpiry) and a
 * __seedGlobals(o) setter are appended INTO the script's eval so the real const/let
 * bindings (incl. lastQuotedShipment/bookingRate/bookingData) can be seeded as TEST
 * INPUT; UI-chrome helpers (appendMessage/showTyping/removeTyping/showChatArea/
 * addRecent/applyDefaultCommodity/applyDefaultAccessorials/showShipmentSavedModal/lookupZipCity) are no-ops;
 * openRightPanel is shimmed to attach the real booking container to document so the
 * real getElementById-based handlers resolve. Every builder + handler runs as written.
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORTAL_PATH = process.argv[2] || path.join(__dirname, 'portal.html');

const ENTERED_UN  = '1993';   // raw UNNumber the lookup writes to #bk-haz-un.value
const ENTERED_PKG = 'III';    // PKGGroup the lookup writes to #bk-haz-un.dataset.unPg
const TYPED_UN    = 'UN1993'; // what a customer types instead of picking from the list

function extractAppScript(html) {
  const blocks = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/g) || [];
  let largest = '';
  for (const b of blocks) {
    const inner = b.replace(/<script\b[^>]*>/, '').replace(/<\/script>$/, '');
    if (inner.length > largest.length) largest = inner;
  }
  return largest;
}

function makeRes(body, ok = true, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok, status, json: async () => JSON.parse(text), text: async () => text };
}

function buildWindow(scriptText) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="main"></div><div id="welcome"></div><div id="chat-area"></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://portal.test/', virtualConsole: vc }
  );
  const win = dom.window;
  win.alert = () => {};

  let capturedBookBody = null;
  win.fetch = async (url, opts) => {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';
    if (u.includes('/api/v1/login'))      return makeRes({ data: { accessToken: 'test-token' } });
    if (u.includes('api.zippopotam.us'))  return makeRes({ places: [{ 'place name': 'Los Angeles', 'state abbreviation': 'CA' }] });
    if (u.includes('api.geocod.io'))      return makeRes({ results: [{ fields: { zip4: { residential: false } } }] });
    if (u.includes('/applet/v1/rate/save')) return makeRes({ data: { quoteNumber: 'Q-TEST' } });
    if (u.includes('/api/v1/database/untable')) return makeRes({ data: { results: [{ UNNumber: '1993', description: 'Paint', HAZClass: '3', PKGGroup: 'III' }] } });
    if (u.includes('/applet/v1/book') && (method === 'POST' || method === 'PUT')) {
      if (capturedBookBody === null) {
        try { capturedBookBody = JSON.parse(opts.body); } catch (e) { capturedBookBody = { _parseError: String(e), _raw: opts.body }; }
      }
      return makeRes({ data: { results: [{ BOLId: 'TEST-BOL-1', BOLNmbr: 'BOL123', documents: [] }] } });
    }
    return makeRes({}, true, 200);
  };

  const seed = '\n;currentCustomer={primusUser:"test@x.com",primusPass:"pw",primusCustomerId:1123086640};'
             + 'primusToken="test-token";primusExpiry=Date.now()+3600000;'
             + 'window.__seedGlobals=function(o){'
             + ' if(o.lastQuotedShipment!==undefined) lastQuotedShipment=o.lastQuotedShipment;'
             + ' if(o.bookingRate!==undefined) bookingRate=o.bookingRate;'
             + ' if(o.bookingData!==undefined) bookingData=o.bookingData; };';
  win.eval(scriptText + seed);

  win.appendMessage = () => {};
  win.showTyping = () => {};
  win.removeTyping = () => {};
  win.showChatArea = () => {};
  win.addRecent = () => {};
  win.applyDefaultCommodity = () => {};
  win.applyDefaultAccessorials = () => {};
  win.showShipmentSavedModal = () => {};
  win.lookupZipCity = () => {};
  win.openRightPanel = (el) => { win.__bkContainer = el; win.document.body.appendChild(el); };

  return { win, getBookBody: () => capturedBookBody };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
function setVal(win, id, val) { const el = win.document.getElementById(id); if (el) el.value = String(val); return el; }

const HAZ_LINE = { qty: 1, weight: 500, length: 48, width: 40, height: 48, dimType: 'PLT', freightClass: '85', commodity: 'Paint, flammable', hazmat: true };

// ── S1 / S4: form path (submitBookingOnly) via the real Book button ────────────
async function formScenario(scriptText, { unValue, pkgViaLookup }) {
  const { win, getBookBody } = buildWindow(scriptText);
  const shipmentData = {
    originZip: '90660', destZip: '90035',
    originCity: 'Pico Rivera', originState: 'CA',
    destinationCity: 'Los Angeles', destinationState: 'CA',
    weight: 500, pieces: 1, accessorials: [],
    lineItems: [Object.assign({}, HAZ_LINE)]
  };
  const rate = { _name: 'Estes', name: 'Estes', rateType: 'LTL', billTo: { total: 441 } };

  win.showBookingPanel(rate, shipmentData);
  await sleep(50);

  const unEl = win.document.getElementById('bk-haz-un');
  if (!unEl) throw new Error('#bk-haz-un did not render — hazmat section missing');

  setVal(win, 'bk-pu-name', 'Acme Origin LLC');
  setVal(win, 'bk-pu-street', '100 Industrial Way');
  setVal(win, 'bk-pu-city', 'Pico Rivera'); setVal(win, 'bk-pu-state', 'CA'); setVal(win, 'bk-pu-zip', '90660');
  setVal(win, 'bk-pu-contact', 'Joe Shipper'); setVal(win, 'bk-pu-phone', '5625551000');
  setVal(win, 'bk-pu-date', '2026-07-06'); setVal(win, 'bk-pu-open', '09:00'); setVal(win, 'bk-pu-close', '17:00');
  setVal(win, 'bk-dl-name', 'Haynes Brothers Furniture');
  setVal(win, 'bk-dl-street', '200 Commerce Blvd');
  setVal(win, 'bk-dl-city', 'Los Angeles'); setVal(win, 'bk-dl-state', 'CA'); setVal(win, 'bk-dl-zip', '90035');
  setVal(win, 'bk-dl-contact', 'Jane Consignee'); setVal(win, 'bk-dl-phone', '3105552000');

  // Simulate the UN field as the customer + lookup leave it.
  unEl.value = unValue;
  if (pkgViaLookup) { unEl.dataset.unPg = ENTERED_PKG; unEl.dataset.unClass = '3'; }
  setVal(win, 'bk-haz-contact', 'TEST CONTACT');
  setVal(win, 'bk-haz-phone', '800-555-0100');

  const bookBtn = win.document.getElementById('bk-submit-btn');
  if (!bookBtn || typeof bookBtn.onclick !== 'function') throw new Error('#bk-submit-btn or its onclick missing');
  await bookBtn.onclick();
  await sleep(150);
  return getBookBody();
}

// ── S2: chat path (submitBooking) — seed the real globals, call the real builder ──
async function chatScenario(scriptText) {
  const { win, getBookBody } = buildWindow(scriptText);
  win._resWarnShown = true; // skip the chat-path residential guard (not under test)
  win.__seedGlobals({
    lastQuotedShipment: {
      originZip: '90660', destinationZip: '90035',
      originCity: 'Pico Rivera', originState: 'CA',
      destinationCity: 'Los Angeles', destinationState: 'CA',
      accessorials: ['RSD'],
      items: [Object.assign({ pieces: 1 }, HAZ_LINE)]
    },
    bookingRate: { name: 'Estes', rateType: 'LTL', billTo: { total: 441 } }, // no id -> no real saveRate dependency
    bookingData: {
      shipperName: 'Acme Origin LLC', shipperStreet: '100 Industrial Way', shipperCity: 'Pico Rivera',
      shipperState: 'CA', shipperZip: '90660', shipperContact: 'Joe Shipper', shipperPhone: '5625551000',
      consigneeName: 'Haynes Brothers Furniture', consigneeStreet: '200 Commerce Blvd', consigneeCity: 'Los Angeles',
      consigneeState: 'CA', consigneeZip: '90035', consigneeContact: 'Jane Consignee', consigneePhone: '3105552000',
      pickupDate: '2026-07-06', pickupOpen: '09:00', pickupClose: '17:00', accessorials: ['RSD'], specialInstructions: '',
      isHazmat: true, hazUnNumber: ENTERED_UN, hazPkgGroup: ENTERED_PKG, hazContact: 'TEST CONTACT', hazPhone: '800-555-0100'
    }
  });
  await win.submitBooking();
  await sleep(150);
  return getBookBody();
}

// ── S3: agent path (_execBookShipment) — frozen lock + hazmat input ────────────
async function agentScenario(scriptText) {
  const { win, getBookBody } = buildWindow(scriptText);
  win._lastBooked = null;
  win._bookingPanelOpen = false;
  win._resWarnShown = true;
  win._bookingLock = {
    rate: { name: 'Estes', rateType: 'LTL', billTo: { total: 441 } },
    shipment: {
      originZip: '90660', destinationZip: '90035',
      originCity: 'Pico Rivera', originState: 'CA',
      destinationCity: 'Los Angeles', destinationState: 'CA',
      accessorials: ['RSD'],
      items: [Object.assign({ pieces: 1 }, HAZ_LINE)]
    }
  };
  const res = await win._execBookShipment({
    rank: 1,
    shipper: { name: 'Acme Origin LLC', address: '100 Industrial Way', city: 'Pico Rivera', state: 'CA', contact: 'Joe Shipper', phone: '5625551000' },
    consignee: { name: 'Haynes Brothers Furniture', address: '200 Commerce Blvd', city: 'Los Angeles', state: 'CA', contact: 'Jane Consignee', phone: '3105552000' },
    pickupDate: '2026-07-06', pickupOpen: '09:00', pickupClose: '17:00',
    isHazmat: true, hazUnNumber: ENTERED_UN, hazPkgGroup: ENTERED_PKG, hazContact: 'TEST CONTACT', hazPhone: '800-555-0100'
  });
  await sleep(150);
  const body = getBookBody();
  if (!body && res && res.ok === false) throw new Error('_execBookShipment returned error before POST: ' + res.error);
  return body;
}

// ── Results ────────────────────────────────────────────────────────────────────
let totalPass = 0, totalFail = 0;
function hazLine(body) {
  const items = (body && body.lineItems) || [];
  return items.find(li => li && (li.UN !== undefined || li.UNPKGGroup !== undefined)) || items[0] || {};
}
function check(label, cond, detail) {
  const ok = cond === true;
  console.log('   ' + (ok ? '✅ PASS' : '❌ FAIL') + ' — ' + label);
  if (!ok && detail) console.log('      ' + detail);
  ok ? totalPass++ : totalFail++;
}
function assertScenario(name, body, { expectPkg }) {
  console.log('── ' + name + ' ──');
  if (!body) { console.log('   ❌ FAIL — no /applet/v1/book POST captured'); totalFail++; return; }
  const li = hazLine(body);
  console.log('   lineItems[haz]:', JSON.stringify(li));
  console.log('   BOLInstructions:', JSON.stringify(body.BOLInstructions));
  console.log('   emergencyContact/Phone:', JSON.stringify(body.emergencyContact), JSON.stringify(body.emergencyPhone));
  check('A: lineItems[].UN === ' + JSON.stringify(ENTERED_UN), li.UN === ENTERED_UN, 'got: ' + JSON.stringify(li.UN));
  if (expectPkg) check('B: lineItems[].UNPKGGroup === ' + JSON.stringify(ENTERED_PKG), li.UNPKGGroup === ENTERED_PKG, 'got: ' + JSON.stringify(li.UNPKGGroup));
  const bol = typeof body.BOLInstructions === 'string' ? body.BOLInstructions : '';
  check('C1: BOLInstructions HAS UN + class', bol.indexOf('UN1993') !== -1 && /class\s*3\b/i.test(bol), 'BOLInstructions: ' + JSON.stringify(body.BOLInstructions));
  check('C2: BOLInstructions has NO emergency contact (no duplication)', bol.indexOf('TEST CONTACT') === -1 && bol.indexOf('800-555-0100') === -1 && !/emergency/i.test(bol), 'BOLInstructions: ' + JSON.stringify(body.BOLInstructions));
  console.log('');
}

(async () => {
  console.log('=== WIRE-LEVEL TEST (REAL CODE): hazmat UN + packing group in POST /applet/v1/book ===');
  console.log('Portal file:', PORTAL_PATH);
  console.log('Assertion target: outbound POST body to /applet/v1/book (per builder)');
  console.log('');
  const html = fs.readFileSync(PORTAL_PATH, 'utf8');
  const scriptText = extractAppScript(html);
  console.log('App script extracted:', scriptText.length, 'chars');
  console.log('');

  const s1 = await formScenario(scriptText, { unValue: ENTERED_UN, pkgViaLookup: true });
  assertScenario('S1 submitBookingOnly (form Book button, UN from lookup)', s1, { expectPkg: true });

  const s2 = await chatScenario(scriptText);
  assertScenario('S2 submitBooking (chat confirm path)', s2, { expectPkg: true });

  const s3 = await agentScenario(scriptText);
  assertScenario('S3 _execBookShipment (agent book_shipment path)', s3, { expectPkg: true });

  const s4 = await formScenario(scriptText, { unValue: TYPED_UN, pkgViaLookup: false });
  assertScenario('S4 submitBookingOnly (customer typed "UN1993" -> "1993")', s4, { expectPkg: false });

  console.log('=== RESULTS ===');
  console.log('PASS:', totalPass, '  FAIL:', totalFail);
  process.exit(totalFail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e && e.stack || e); process.exit(2); });
