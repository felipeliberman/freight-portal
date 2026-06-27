/**
 * DOM-render regression test: booking-confirmation markdown links render as clickable <a>.
 *
 * Per the approved rule-4 adaptation for this bug: the assertion target is the ACTUAL
 * rendered DOM output of the REAL appendMessage function. No mocking of the function
 * under test, no reimplementation. This test loads portal.html, evaluates its real
 * <script>, runs the real appendMessage('bot', <confirmation text with a markdown link>),
 * and asserts on the real .msg-text DOM the function produces.
 *
 * THE BUG: appendMessage (portal.html ~4843-4849) only converts **bold** + newlines for
 * bot messages, else sets textContent. Markdown links [label](url) are never converted to
 * <a>, so a booking confirmation shows literal "[Bill of Lading](https://...)" instead of a
 * clickable link.
 *
 * ASSERTION (both cases): the produced .msg-text innerHTML
 *   - CONTAINS an anchor element  (/<a\s+[^>]*href=/i)
 *   - does NOT contain the literal markdown substring "]("
 *
 * USAGE: node test-confirmation-link-render.js [path-to-portal.html]   (default ./portal.html)
 *   Against broken HEAD -> both cases FAIL (no <a>, literal "](" present).
 *   Against fixed file  -> both cases PASS.
 *
 * STUBS (full disclosure — none is the function under test):
 *   1. jsdom page scaffold with <div id="messages"></div> — appendMessage appends its row here.
 *   2. VirtualConsole suppresses the page's console + DOMContentLoaded auto-init errors
 *      (unrelated to rendering; cannot cause a false PASS — assertion reads only the DOM).
 *   3. scrollBottom — no-op (UI chrome; appendMessage's final call; not under test).
 */

'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const PORTAL_PATH = process.argv[2] || path.join(__dirname, 'portal.html');

function extractAppScript(html) {
  const blocks = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/g) || [];
  let largest = '';
  for (const b of blocks) {
    const inner = b.replace(/<script\b[^>]*>/, '').replace(/<\/script>$/, '');
    if (inner.length > largest.length) largest = inner;
  }
  return largest;
}

function buildWindow(scriptText) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => {});
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="messages"></div></body></html>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://portal.test/', virtualConsole: vc }
  );
  const win = dom.window;
  win.eval(scriptText);
  win.scrollBottom = () => {}; // UI chrome; appendMessage's final call
  return win;
}

// Render via the REAL appendMessage, return the produced .msg-text innerHTML
function renderBot(win, text) {
  win.document.getElementById('messages').innerHTML = '';
  win.appendMessage('bot', text);
  const nodes = win.document.querySelectorAll('#messages .msg-text');
  const last = nodes[nodes.length - 1];
  return last ? last.innerHTML : '(no .msg-text produced)';
}

let pass = 0, fail = 0;
function assertLinkRendered(label, html) {
  const hasAnchor = /<a\s+[^>]*href=/i.test(html);
  const hasLiteralMd = html.includes('](');
  const ok = hasAnchor && !hasLiteralMd;
  console.log((ok ? '✅ PASS' : '❌ FAIL') + ' — ' + label);
  console.log('   produced innerHTML: ' + html);
  console.log('   has <a href>: ' + hasAnchor + '   contains literal "](": ' + hasLiteralMd);
  ok ? pass++ : fail++;
}

(function main() {
  console.log('=== DOM-RENDER REGRESSION TEST: confirmation markdown link -> clickable <a> ===');
  console.log('Portal file:', PORTAL_PATH);
  console.log('Assertion target: real appendMessage output in the real .msg-text DOM');
  console.log('');

  const html = fs.readFileSync(PORTAL_PATH, 'utf8');
  const win = buildWindow(extractAppScript(html));

  // Case 1: plain confirmation with a markdown link (no bold)
  const text1 = "You're all set with BOL 12345. Here's your [Bill of Lading](https://docs.shipprimus.com/bol/12345.pdf). Want me to dispatch it?";
  console.log('── Case 1: plain text + markdown link ──');
  assertLinkRendered('C1: [Bill of Lading](url) renders as <a href> link', renderBot(win, text1));
  console.log('');

  // Case 2: confirmation that also uses **bold** (exercises the other branch)
  const text2 = "**Booking confirmed.** Your [Bill of Lading](https://docs.shipprimus.com/bol/12345.pdf) is ready to view.";
  console.log('── Case 2: **bold** + markdown link ──');
  assertLinkRendered('C2: link renders as <a href> even alongside **bold**', renderBot(win, text2));
  console.log('');

  console.log('=== RESULTS ===');
  console.log('PASS:', pass, '  FAIL:', fail);
  process.exit(fail === 0 ? 0 : 1);
})();
