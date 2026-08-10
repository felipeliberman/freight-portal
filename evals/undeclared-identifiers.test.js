#!/usr/bin/env node
'use strict';
// UNDECLARED-IDENTIFIER AUDIT for portal.html. Spec §8.881, §8.885.
//
//     node evals/undeclared-identifiers.test.js [path-to-html]
//
// EXIT CODE: 0 when the findings match the ACCEPTED list below, 1 when a NEW name appears. It is a
// gate, not a report — a tool nobody runs is how `_lastInvoiceSend` survived 57 days on a live site.
//
// WHY: `_lastInvoiceSend` was referenced three times and declared nowhere, so its handler threw
// ReferenceError on its first statement and never worked — for 57 days, silently, on a live site.
// `node --check` catches syntax, not scope, so nothing in the gates would find a second one.
//
// WHAT THIS DOES: real scope resolution, not a flat "is this name declared anywhere" grep.
//   - var / function declarations hoist to the nearest FUNCTION or Program scope.
//   - let / const / class are bound to the nearest BLOCK scope.
//   - parameters, catch params, named function expressions and class expressions are bound.
// So it finds BOTH the `_lastInvoiceSend` class (declared nowhere) AND the harder cross-scope case
// (declared in function A, referenced from unrelated function B).
//
// WHAT IT CANNOT DO, stated rather than implied:
//   - It cannot know which browser/library globals are legitimately present at runtime, so those
//     come from a list below. A name missing from that list is a CANDIDATE, not a defect.
//   - An implicit global (`x = 1` with no declaration, sloppy mode) CREATES the binding when it
//     runs. So a name that is assigned somewhere is only a defect if a READ can execute first —
//     which is an ordering question this cannot answer. Those are reported SEPARATELY.

const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const walk = require('acorn-walk');

// Defaults to portal.html so the gate runs with no arguments, like every other eval here.
const file = process.argv[2] || path.join(__dirname, '..', 'portal.html');
const html = fs.readFileSync(file, 'utf8');

// ── extract the largest <script> block, the same one the commit gate checks ───────────────────
const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(m => !/\bsrc=/i.test(m[1]))
  .map(m => ({ code: m[2], start: m.index + m[0].indexOf(m[2]) }));
// ALL inline blocks, not just the largest. At runtime they SHARE ONE GLOBAL SCOPE, so a function
// declared in block 1 and called from block 2 resolves fine — scanning one block alone reports it
// as undeclared and that is a false positive, not a finding.
const lineOfIn = (blk, off) => html.slice(0, blk.start + off).split('\n').length;

console.log(`file        ${file}`);
console.log(`inline <script> blocks (no src): ${blocks.length}`);
for (const b of blocks) {
  b.ast = acorn.parse(b.code, { ecmaVersion: 'latest', sourceType: 'script', locations: false });
  console.log(`  block: ${String(b.code.length).padStart(8)} chars, from line ${lineOfIn(b, 0)}`);
}

// ── pass 1: build the scope map ──────────────────────────────────────────────────────────────
const scopeOf = new Map();               // scope node -> Set of names bound in it
const bind = (node, name) => {
  if (!scopeOf.has(node)) scopeOf.set(node, new Set());
  scopeOf.get(node).add(name);
};
const isFn = (n) => /Function(Declaration|Expression)|ArrowFunctionExpression/.test(n.type);
const isBlockScope = (n) =>
  n.type === 'BlockStatement' || n.type === 'Program' || n.type === 'SwitchStatement' ||
  n.type === 'ForStatement' || n.type === 'ForInStatement' || n.type === 'ForOfStatement' ||
  n.type === 'CatchClause' || n.type === 'StaticBlock';

/** Nearest enclosing function-or-program scope: where `var` and function declarations land. */
const fnScope = (anc) => { for (let i = anc.length - 2; i >= 0; i--) if (isFn(anc[i]) || anc[i].type === 'Program') return anc[i]; return anc[0]; };
/** Nearest enclosing block-ish scope: where `let`/`const`/`class` land. */
const blkScope = (anc) => { for (let i = anc.length - 2; i >= 0; i--) if (isBlockScope(anc[i]) || isFn(anc[i])) return anc[i]; return anc[0]; };

/** Every name a binding pattern introduces (destructuring, defaults, rest). */
function patternNames(p, out = []) {
  if (!p) return out;
  switch (p.type) {
    case 'Identifier': out.push(p.name); break;
    case 'ObjectPattern': p.properties.forEach(pr => patternNames(pr.value || pr.argument, out)); break;
    case 'ArrayPattern': p.elements.forEach(e => patternNames(e, out)); break;
    case 'AssignmentPattern': patternNames(p.left, out); break;
    case 'RestElement': patternNames(p.argument, out); break;
  }
  return out;
}

for (const B of blocks) walk.ancestor(B.ast, {
  VariableDeclaration(node, _st, anc) {
    const target = node.kind === 'var' ? fnScope(anc) : blkScope(anc);
    node.declarations.forEach(d => patternNames(d.id).forEach(n => bind(target, n)));
  },
  FunctionDeclaration(node, _st, anc) {
    if (node.id) bind(fnScope(anc), node.id.name);
  },
  ClassDeclaration(node, _st, anc) {
    if (node.id) bind(blkScope(anc), node.id.name);
  },
  // A named function/class EXPRESSION binds its own name inside itself.
  FunctionExpression(node) { if (node.id) bind(node, node.id.name); },
  ClassExpression(node) { if (node.id) bind(node, node.id.name); },
  CatchClause(node) { patternNames(node.param).forEach(n => bind(node, n)); },
});
// Parameters bind in the function node itself.
for (const B of blocks) walk.full(B.ast, (node) => {
  if (isFn(node)) node.params.forEach(p => patternNames(p).forEach(n => bind(node, n)));
});

// ── the SHARED GLOBAL scope: top-level declarations from EVERY block, plus window.X = ... ─────
const GLOBAL_BINDINGS = new Set();
for (const B of blocks) {
  for (const n of (scopeOf.get(B.ast) || [])) GLOBAL_BINDINGS.add(n);
  walk.simple(B.ast, {
    AssignmentExpression(node) {
      const l = node.left;
      if (l.type === 'MemberExpression' && !l.computed && l.property.type === 'Identifier' &&
          l.object.type === 'Identifier' && (l.object.name === 'window' || l.object.name === 'globalThis')) {
        GLOBAL_BINDINGS.add(l.property.name);
      }
    },
  });
}

// ── pass 2: resolve every reference ──────────────────────────────────────────────────────────
const GLOBALS = new Set(`
globalThis window document navigator location history screen console alert confirm prompt
setTimeout clearTimeout setInterval clearInterval requestAnimationFrame cancelAnimationFrame
queueMicrotask structuredClone fetch Headers Request Response FormData URL URLSearchParams Blob File
FileReader XMLHttpRequest WebSocket EventSource AbortController AbortSignal Notification
localStorage sessionStorage indexedDB caches crypto performance atob btoa
Object Array String Number Boolean Symbol BigInt Function Math JSON Date RegExp Error TypeError
RangeError SyntaxError ReferenceError EvalError URIError AggregateError Promise Proxy Reflect Map Set
WeakMap WeakSet WeakRef FinalizationRegistry Intl Infinity NaN undefined globalThis
parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent encodeURI decodeURI eval
ArrayBuffer SharedArrayBuffer DataView Int8Array Uint8Array Uint8ClampedArray Int16Array Uint16Array
Int32Array Uint32Array Float32Array Float64Array BigInt64Array BigUint64Array TextEncoder TextDecoder
Event CustomEvent MouseEvent KeyboardEvent Element HTMLElement Node NodeList Image Audio Option
DOMParser XPathResult MutationObserver IntersectionObserver ResizeObserver CSS getComputedStyle
matchMedia scrollTo scrollBy open close print focus blur getSelection
arguments this Stripe google gtag dataLayer jQuery $ marked html2canvas jspdf Chart
`.trim().split(/\s+/));

const unresolved = new Map();            // name -> [offsets]
const assignedSomewhere = new Set();     // names that appear as an assignment TARGET

function resolvable(name, anc) {
  for (let i = anc.length - 1; i >= 0; i--) {
    const s = scopeOf.get(anc[i]);
    if (s && s.has(name)) return true;
  }
  return false;
}

for (const B of blocks) walk.ancestor(B.ast, {
  Identifier(node, _st, anc) {
    const parent = anc[anc.length - 2];
    if (!parent) return;
    // Not a reference: property keys, non-computed member props, declaration ids, params, labels.
    if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
    if (parent.type === 'Property' && parent.key === node && !parent.computed && parent.shorthand !== true) return;
    if (parent.type === 'PropertyDefinition' && parent.key === node && !parent.computed) return;
    if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) return;
    if (parent.type === 'VariableDeclarator' && parent.id === node) return;
    if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' ||
         parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression') && parent.id === node) return;
    if (isFn(parent) && parent.params.includes(node)) return;
    if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return;
    if (parent.type === 'AssignmentPattern' && parent.left === node) return;
    if (parent.type === 'RestElement' || parent.type === 'ObjectPattern' || parent.type === 'ArrayPattern') return;
    if (parent.type === 'CatchClause' && parent.param === node) return;
    if (parent.type === 'ExportSpecifier' || parent.type === 'ImportSpecifier') return;

    if (GLOBALS.has(node.name)) return;
    // Interface constructors are numerous and uninteresting; match by shape, not by list.
    if (/^(HTML|SVG|CSS|IDB|RTC|WebGL)\w*$/.test(node.name)) return;
    if (GLOBAL_BINDINGS.has(node.name)) return;
    if (resolvable(node.name, anc)) return;

    // Is this an assignment target? Then it CREATES an implicit global when it runs.
    if (parent.type === 'AssignmentExpression' && parent.left === node) assignedSomewhere.add(node.name);
    if (!unresolved.has(node.name)) unresolved.set(node.name, []);
    unresolved.get(node.name).push(lineOfIn(B, node.start));
  },
});

// ── THE ACCEPTED BASELINE ────────────────────────────────────────────────────────────────────
//
// Every name here was checked BY HAND on 2026-08-10 and is not a live defect. The reason is
// recorded per name, because "it was on the list" is not a reason and the next person needs to be
// able to re-derive the judgement rather than trust it.
//
// A NAME NOT ON THIS LIST FAILS THE GATE. That is the point: the list is a record of what was
// examined, not a mute-button. Adding to it means doing the same check and writing the same note.
const ACCEPTED = {
  // External libraries, loaded via <script src>. Genuinely global at runtime.
  XLSX:       'sheetjs, loaded from cdn.sheetjs.com',
  grecaptcha: 'google recaptcha, loaded from google.com/recaptcha/api.js',

  // Guarded by `typeof X === 'function'`, which NEVER throws on an undeclared name. Deliberate
  // cross-page defensive code — these exist on the landing page, not here.
  checkResidential: 'typeof-guarded at the call site',
  switchTab:        'typeof-guarded at the call site',
  killMovie:        'typeof-guarded at the call site',
  appendMsg:        'typeof-guarded at the call site',

  // UNGUARDED but UNREACHABLE. Landing-page click-delegation copied into portal.html: the five
  // functions are defined nowhere in this file, but the trigger attributes (data-ask, data-send,
  // data-action=signup|closeOnOverlay|closeSignup|submitForm) appear ONLY inside the handler's own
  // selector strings — there is no such markup here, so closest() always returns null.
  //
  // DEAD BUT ARMED. Adding any of that markup to portal.html turns five ReferenceErrors live at
  // once. Left in place rather than removed: deleting live-looking code is its own risk, and the
  // gate now names it every run.
  expandAndAsk: 'unreachable: landing-page click delegation, no matching markup in portal.html',
  sendMsg:      'unreachable: landing-page click delegation, no matching markup in portal.html',
  showSignup:   'unreachable: landing-page click delegation, no matching markup in portal.html',
  closeSignup:  'unreachable: landing-page click delegation, no matching markup in portal.html',
  submitForm:   'unreachable: landing-page click delegation, no matching markup in portal.html',

  // CROSS-SCOPE, and dead. `const sysPrompt` is declared inside aiFreightAnswer (marked DEAD CODE —
  // NO LIVE CALLERS) and read inside clientSideSearch, a sibling function with no call site. This
  // is the harder class the audit exists for: declared, but not where it is read.
  sysPrompt: 'cross-scope read in clientSideSearch; both it and aiFreightAnswer are dead code',
};

// ── report ───────────────────────────────────────────────────────────────────────────────────
const rows = [...unresolved.entries()].sort((a, b) => b[1].length - a[1].length);
const hard = rows.filter(([n]) => !assignedSomewhere.has(n));
const soft = rows.filter(([n]) => assignedSomewhere.has(n));

console.log(`\ntotal unresolved names: ${rows.length}  (${hard.length} never assigned, ${soft.length} assigned somewhere)`);

console.log(`\n══ NEVER ASSIGNED ANYWHERE — a read here is a ReferenceError, the _lastInvoiceSend class ══`);
if (!hard.length) console.log('  (none)');
for (const [name, offs] of hard) {
  console.log(`  ${name}  ×${offs.length}  first at portal.html:${offs[0]}${offs.length > 1 ? `  (also ${offs.slice(1, 4).join(', ')}${offs.length > 4 ? ', …' : ''})` : ''}`);
}

console.log(`\n══ ASSIGNED SOMEWHERE — implicit globals. Legal in sloppy mode; ORDER-DEPENDENT ══`);
if (!soft.length) console.log('  (none)');
for (const [name, offs] of soft) {
  console.log(`  ${name}  ×${offs.length}  first at portal.html:${offs[0]}`);
}

// ── THE GATE ─────────────────────────────────────────────────────────────────────────────────
const unexpected = rows.filter(([n]) => !(n in ACCEPTED));
const stale = Object.keys(ACCEPTED).filter(n => !unresolved.has(n));

console.log('\n' + '─'.repeat(94));
if (stale.length) {
  // Not a failure: a name leaving the file is good. But an ACCEPTED entry that no longer matches
  // anything is dead weight that makes the list look more considered than it is.
  console.log(`NOTE: ${stale.length} ACCEPTED entr${stale.length === 1 ? 'y is' : 'ies are'} no longer present and can be removed: ${stale.join(', ')}`);
}
if (!unexpected.length) {
  console.log(`PASS — ${rows.length} unresolved name(s), all on the accepted list.`);
  process.exit(0);
}
console.log(`FAIL — ${unexpected.length} UNDECLARED IDENTIFIER(S) NOT ON THE ACCEPTED LIST:\n`);
for (const [name, offs] of unexpected) {
  console.log(`  ${name}  ×${offs.length}  first at portal.html:${offs[0]}`);
}
console.log(`
  Each of these is read but never declared in any scope that reaches it. If a read EXECUTES, it
  throws ReferenceError — and that failure is SILENT in a click handler: no dialog, no console
  entry the user sees, the control simply does nothing. That is exactly how \`_lastInvoiceSend\`
  survived 57 days on a live site (spec §8.881).

  DO NOT SILENCE THIS BY ADDING THE NAME TO ACCEPTED. Check it first, three questions:
    1. Is it a runtime global from a <script src>?           -> add to GLOBALS
    2. Is every read \`typeof\`-guarded, or unreachable?       -> add to ACCEPTED with the reason
    3. Neither?                                              -> IT IS A DEFECT. Fix the code.
`);
process.exit(1);
