// Load portal.html's application script into jsdom so the REAL functions can be driven headlessly.
//
// Why not just unit-test extracted helpers: the bugs this harness exists to catch are all
// cross-surface — one path writes, another reads, and they disagree. That only reproduces when the
// actual functions run against an actual DOM. No live browser and no network: every fetch is
// answered from evals/state/fixtures.js, so this runs in CI with no credentials.

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORTAL = path.join(__dirname, '..', '..', 'portal.html');

function appScript() {
  const html = fs.readFileSync(PORTAL, 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  if (!blocks.length) throw new Error('no inline <script> found in portal.html');
  return blocks.reduce((a, b) => (a.length > b.length ? a : b));
}

// Minimal shell. The quote form and booking panel BUILD their own DOM (showQuoteForm /
// showBookingPanel), so only the mount points and the chat plumbing need to pre-exist.
const SHELL = `<!doctype html><html><body>
  <div id="main"></div>
  <div id="right-panel"></div>
  <div id="messages"></div>
  <div id="welcome"></div>
  <div id="chat-area"></div>
  <textarea id="input-textarea"></textarea>
</body></html>`;

function boot(opts) {
  opts = opts || {};
  const vc = new VirtualConsole(); // swallow page console noise; harness prints its own
  const dom = new JSDOM(SHELL, {
    runScripts: 'dangerously', pretendToBeVisual: true,
    url: 'https://www.freightandlogistics.ai/portal', virtualConsole: vc,
  });
  const w = dom.window;

  const ctx = {
    win: w, dom,
    messages: [],       // everything appendMessage would have shown the customer
    requests: [],       // every fetch the app attempted
    routes: opts.routes || [],
  };

  w.alert = () => {}; w.scrollTo = () => {}; w.confirm = () => true;
  w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });

  w.fetch = (url, init) => {
    const u = String(url); const method = (init && init.method) || 'GET';
    ctx.requests.push({ url: u, method, body: init && init.body ? safeJson(init.body) : null });
    for (const r of ctx.routes) {
      if (r.match(u, method)) {
        const res = r.reply(u, method, init);
        return Promise.resolve(mkResponse(res));
      }
    }
    return Promise.resolve(mkResponse({ status: 200, body: {} }));
  };

  const script = w.document.createElement('script');
  script.textContent = appScript();
  w.document.body.appendChild(script);

  // Wrap (not replace) the chat sink AFTER load: capture what the customer would see, then
  // DELEGATE to the app's real appendMessage so its transcript recording (the ONE chatHistory
  // writer) runs exactly as in production — invariants 9–11 depend on the real wiring.
  const _appAppend = w.appendMessage;
  w.appendMessage = function (role, text, extras) {
    ctx.messages.push({ role, text: String(text == null ? '' : text) });
    try { if (typeof _appAppend === 'function') return _appAppend(role, text, extras); } catch (e) {}
  };
  w.showTyping = () => {}; w.removeTyping = () => {}; w.showChatArea = () => {};
  w.getToken = () => Promise.resolve('test-token');
  w.flashField = () => {};
  w.currentCustomer = { name: 'Haynes Brothers Furniture', code: 'HAYNES', primusCustomerId: '1123086640' };

  // Top-level `const`/`let` in a classic script live in the global LEXICAL scope, not on window —
  // ACC_BOL_CODES and friends are invisible to `w.NAME`. A global eval can see them.
  ctx.g = expr => w.eval(expr);
  ctx.reset = () => { ctx.messages.length = 0; ctx.requests.length = 0; };
  return ctx;
}

function mkResponse(res) {
  const status = res.status == null ? 200 : res.status;
  const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body == null ? {} : res.body);
  return { ok: status >= 200 && status < 300, status, text: () => Promise.resolve(text), json: () => Promise.resolve(JSON.parse(text || '{}')) };
}
function safeJson(b) { try { return JSON.parse(b); } catch (e) { return String(b).slice(0, 400); } }

module.exports = { boot, appScript, PORTAL };
