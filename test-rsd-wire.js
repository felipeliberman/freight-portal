/**
 * Wire-level regression test: RSD reaches the Primus rate URL — REAL CODE.
 *
 * Unlike the prior version, this test does NOT reimplement any portal logic.
 * It loads portal.html, evaluates its actual <script>, and drives the REAL
 * functions:
 *   - showQuoteForm()          (creates the real container, sets window._quoteContainer,
 *                               defines and exposes the real doGetRates closure)
 *   - applyRequoteAccessorials (the form-requote path, line ~7321)
 *   - _applyQuoteFields()      (the agent update_quote path; contains the real toggleAcc, line ~9340)
 *   - doGetRates()             (the real closure; builds the real Primus URL via fetchRates)
 *
 * ASSERTION TARGET: the actual outbound fetch URL to /applet/v1/rate/multiple.
 *   Assert it contains accessorialsList[]=RSD (raw or %5B%5D-encoded).
 *
 * THE BUG: when the quote-form container is detached from document (the booking
 * panel is the active right-panel tab), applyRequoteAccessorials and toggleAcc
 * query document instead of the detached container, never click the RSD button,
 * and doGetRates sends a URL with no accessorialsList.
 *
 * USAGE:
 *   node test-rsd-wire.js [path-to-portal.html]   (default: ./portal.html)
 *   Run against HEAD's file (no fix) -> A1,C1 FAIL, B1 PASS  (proves test detects the bug)
 *   Run against fixed file           -> A1,B1,C1 PASS
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * WHAT IS STUBBED, AND WHY (full disclosure — none of it is logic under test):
 *
 *   1. window.fetch — REQUIRED. This is the interception point. It answers three
 *      real calls the production code makes and captures the rate URL:
 *        - POST /api/v1/login        -> { data: { accessToken } }   (primusLogin/getToken)
 *        - api.zippopotam.us/us/{zip} -> { places:[{place name,state abbreviation}] } (lookupZip)
 *        - /applet/v1/rate/multiple   -> capture URL; return one fake rate (fetchRates)
 *      No portal function is replaced — fetch is an external boundary.
 *
 *   2. window.alert — jsdom does not implement alert; doGetRates calls it only on a
 *      validation failure. The form is filled so validation passes; alert is a no-op
 *      safety net. Not logic under test.
 *
 *   3. currentCustomer / primusToken / primusExpiry — seeded INTO the same eval as
 *      the script (appended source), because the script declares them as const/let
 *      confined to that eval scope. This is TEST INPUT (a logged-in account + a live
 *      token so getToken short-circuits), not a reimplementation of any function.
 *      The real getToken/primusLogin/fetchRates still run and read these values.
 *
 *   4. Form field VALUES (origin/dest/weight/dims) — set directly on the real
 *      container's real inputs so doGetRates' validation passes. This is the
 *      shipment INPUT a user would type; the functions processing it are real.
 *
 *   5. UI-CHROME helpers stubbed to no-ops AFTER eval (all are global function
 *      declarations; none is in the accessorial→URL path):
 *        - showChatArea            (toggles #welcome/#chat-area visibility)
 *        - addRecent               (re-renders the session list)
 *        - applyDefaultCommodity   (fires in a setTimeout; cosmetic defaults)
 *        - applyDefaultAccessorials(fires in a setTimeout; cosmetic defaults)
 *        - appendMessage           (writes a bot message into the chat log)
 *      openRightPanel is NOT stubbed — it runs for real so the container is pushed
 *      into rpState.tabs, which the test reads as a version-agnostic container handle
 *      (HEAD has no window._quoteContainer). showQuoteForm still creates the REAL
 *      container, builds the REAL form DOM, and defines the REAL doGetRates.
 *      rpState is exposed via window.__rpState (appended to the same eval).
 *
 *   6. jsdom VirtualConsole suppresses the page's own console output and the
 *      DOMContentLoaded auto-init listener errors (unrelated to the path under test;
 *      that init code is gated on the real login flow that does not run here). It
 *      does NOT swallow assertion results — the assertion reads only the captured URL,
 *      so a hidden throw can only produce a (debuggable) FAIL, never a false PASS.
 *
 *   Nothing else is faked. applyRequoteAccessorials, toggleAcc, doGetRates,
 *   fetchRates, showQuoteForm, _applyQuoteFields all run as written in portal.html.
 * ──────────────────────────────────────────────────────────────────────────────
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORTAL_PATH = process.argv[2] || path.join(__dirname, 'portal.html');

// ── Extract the largest <script> block (the application script) ────────────────
function extractAppScript(html) {
  const blocks = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/g) || [];
  let largest = '';
  for (const b of blocks) {
    const inner = b.replace(/<script\b[^>]*>/, '').replace(/<\/script>$/, '');
    if (inner.length > largest.length) largest = inner;
  }
  return largest;
}

// ── A fake fetch Response supporting both .json() and .text() ──────────────────
function makeRes(body, ok = true, status = 200) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { ok, status, json: async () => JSON.parse(text), text: async () => text };
}

// ── Build a fresh sandboxed window with the real portal script evaluated ───────
function buildWindow(scriptText) {
  // Stub 6: suppress in-page console + DOMContentLoaded init listener errors
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="main"></div><div id="welcome"></div><div id="chat-area"></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://portal.test/', virtualConsole: vc }
  );
  const win = dom.window;

  // Stub 2: alert (jsdom throws "not implemented")
  win.alert = () => {};

  // Stub 1: fetch — the interception point
  let capturedUrl = null;
  win.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/v1/login'))            return makeRes({ data: { accessToken: 'test-token' } });
    if (u.includes('api.zippopotam.us'))        return makeRes({ places: [{ 'place name': 'Pico Rivera', 'state abbreviation': 'CA' }] });
    if (u.includes('api.geocod.io'))            return makeRes({ results: [] });
    if (u.includes('/applet/v1/rate/multiple')) { capturedUrl = u; return makeRes({ data: { results: { rates: [ { name: 'Estes', billTo: { total: 441 }, rateType: 'LTL' } ] } } }); }
    return makeRes({}, true, 200);
  };

  // Evaluate the real application script in this window's global scope, with auth
  // state seeded in the SAME eval scope. The script declares currentCustomer/
  // primusToken/primusExpiry as const/let — those bindings are confined to this
  // eval's scope (only `function` decls leak to window), so the seed MUST be in the
  // same eval for the real closures (primusLogin/getToken/fetchRates) to read it.
  // Function declarations (function foo(){}) still become window.foo.
  // window.__rpState exposes the panel state so the test can grab the REAL quote
  // container in a VERSION-AGNOSTIC way (HEAD has no window._quoteContainer; both
  // versions push the container into rpState.tabs via the real openRightPanel).
  const seed = '\n;currentCustomer={primusUser:"test@x.com",primusPass:"pw",primusCustomerId:1123086640};'
             + 'primusToken="test-token";primusExpiry=Date.now()+3600000;'
             + 'window.__rpState=rpState;';
  win.eval(scriptText + seed);

  // Stub 5: UI-chrome no-ops (override the real global function declarations).
  // openRightPanel is intentionally NOT stubbed — it runs for real so the container
  // lands in rpState.tabs. showQuoteForm builds the real container and real doGetRates.
  win.showChatArea = () => {};
  win.addRecent = () => {};
  win.applyDefaultCommodity = () => {};
  win.applyDefaultAccessorials = () => {};
  win.appendMessage = () => {};

  return { win, getUrl: () => capturedUrl };
}

// ── Version-agnostic handle to the REAL quote container (works on HEAD and fixed) ──
function getContainer(win) {
  const st = win.__rpState;
  const tab = st && st.tabs && st.tabs.find(t => t.title === 'Get a Quote');
  if (!tab || !tab.el) throw new Error('quote container not found in rpState.tabs — showQuoteForm/openRightPanel did not run');
  return tab.el;
}

// ── Fill the real container's real inputs so doGetRates validation passes ──────
function fillForm(c) {
  const set = (sel, val) => { const el = c.querySelector(sel); if (el) { el.value = String(val); } };
  set('#qt-origin', '90660');
  set('#qt-dest', '90035');
  const row = c.querySelector('.qt-line');
  if (row) {
    const setIn = (sel, val) => { const el = row.querySelector(sel); if (el) el.value = String(val); };
    setIn('.li-qty', '1'); setIn('.li-weight', '10');
    setIn('.li-len', '5'); setIn('.li-wid', '5'); setIn('.li-hgt', '5');
  }
}

function rsdInUrl(url) {
  if (!url) return false;
  return url.includes('accessorialsList[]=RSD') || url.includes('accessorialsList%5B%5D=RSD');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Results ────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function assertTrue(label, actual) {
  const ok = actual === true;
  console.log((ok ? '✅ PASS' : '❌ FAIL') + ' — ' + label);
  if (!ok) console.log('   expected RSD in outbound URL: true   got: ' + actual);
  ok ? pass++ : fail++;
}

// ── Scenario A: form-requote path, container DETACHED ──────────────────────────
async function scenarioA(scriptText) {
  console.log('── Scenario A: applyRequoteAccessorials, container DETACHED (booking panel active) ──');
  const { win, getUrl } = buildWindow(scriptText);
  win.showQuoteForm(); // no prefill: avoid the origin+dest+weight auto-fire (line ~15079)
  await sleep(50);
  const c = getContainer(win);
  fillForm(c);
  // Detach the quote container, exactly as renderPanel does when another tab is active.
  if (c.parentNode) c.remove();

  win.applyRequoteAccessorials(['RSD']);
  await sleep(1600); // 400ms dispatch + login/zip/rate fetches

  const url = getUrl();
  console.log('  captured rate URL:', url ? '?' + url.split('?')[1].slice(0, 200) + '…' : '(none)');
  assertTrue('A1: RSD present in Primus URL when container is detached', rsdInUrl(url));
  console.log('');
}

// ── Scenario B: control — container ATTACHED to document ───────────────────────
async function scenarioB(scriptText) {
  console.log('── Scenario B: applyRequoteAccessorials, container ATTACHED (control) ──');
  const { win, getUrl } = buildWindow(scriptText);
  win.showQuoteForm(); // no prefill: avoid the origin+dest+weight auto-fire (line ~15079)
  await sleep(50);
  const c = getContainer(win);
  fillForm(c);
  // Ensure attached (the real renderPanel already appended it to #rp-body)
  if (!c.parentNode) win.document.body.appendChild(c);

  win.applyRequoteAccessorials(['RSD']);
  await sleep(1600);

  const url = getUrl();
  console.log('  captured rate URL:', url ? '?' + url.split('?')[1].slice(0, 200) + '…' : '(none)');
  assertTrue('B1: RSD present in Primus URL when container is in document', rsdInUrl(url));
  console.log('');
}

// ── Scenario C: agent update_quote path (real toggleAcc), container DETACHED ───
async function scenarioC(scriptText) {
  console.log('── Scenario C: _applyQuoteFields/toggleAcc agent path, container DETACHED ──');
  const { win, getUrl } = buildWindow(scriptText);
  win.showQuoteForm(); // no prefill: avoid the origin+dest+weight auto-fire (line ~15079)
  await sleep(50);
  const c = getContainer(win);
  fillForm(c);
  if (c.parentNode) c.remove();

  // Real agent path: update_quote({addAccessorials:['RSD'], getRates:true})
  // Form is already open, so _execUpdateQuote routes to _applyQuoteFields, which
  // runs the real toggleAcc and the real getRates -> _doGetRates dispatch.
  win._applyQuoteFields({ addAccessorials: ['RSD'], getRates: true });
  await sleep(1700);

  const url = getUrl();
  console.log('  captured rate URL:', url ? '?' + url.split('?')[1].slice(0, 200) + '…' : '(none)');
  assertTrue('C1: RSD present in Primus URL via agent toggleAcc path when detached', rsdInUrl(url));
  console.log('');
}

// ── Main ───────────────────────────────────────────────────────────────────────
(async () => {
  console.log('=== WIRE-LEVEL REGRESSION TEST (REAL CODE): RSD in Primus rate URL ===');
  console.log('Portal file:', PORTAL_PATH);
  console.log('Assertion target: outbound fetch URL to /applet/v1/rate/multiple');
  console.log('');

  const html = fs.readFileSync(PORTAL_PATH, 'utf8');
  const scriptText = extractAppScript(html);
  console.log('App script extracted:', scriptText.length, 'chars');
  console.log('');

  await scenarioA(scriptText);
  await scenarioB(scriptText);
  await scenarioC(scriptText);

  console.log('=== RESULTS ===');
  console.log('PASS:', pass, '  FAIL:', fail);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR:', e && e.stack || e); process.exit(2); });
