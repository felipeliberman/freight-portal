#!/usr/bin/env node
'use strict';
/**
 * TIER A (spec §8.877) — no document URL may reach the model.
 *
 *     node evals/tool-result-urls.test.js
 *
 * WHY. Primus document URLs are UNAUTHENTICATED (spec §8.876 layer 2): `curl -I` with no
 * Authorization header returns the PDF. They are therefore bearer credentials in URL form, and the
 * portal was putting them into tool results, which are `JSON.stringify`d and posted to the Anthropic
 * API — leaving our infrastructure, to a third party, for no benefit to the customer they belong to,
 * on a path nobody chose. `validDocs` carries `url` only because `_documentsFor()` returns it.
 *
 * The agent needs to know a document EXISTS and what TYPE it is. It has never needed the link, and
 * `get_documents` (portal.html ~:24172) already proves the pattern by returning `{type, label}`.
 *
 * THIS IS A BOUNDARY CONTROL, NOT A PATCH ON TWO CALL SITES. There are THREE places a tool result is
 * serialised — grep found two, the source check below found the third — so a fix aimed at the two
 * producing lines would have left the property unenforced on one site today and on every tool added
 * later. That is the whole argument for asserting the boundary rather than the callers. The assertion below is
 * shaped like mapper.js `assertPayloadClean`: it walks a whole payload and fails on the forbidden
 * shape wherever it appears, at any depth.
 *
 * SCOPE, STATED HONESTLY. This proves the scrubber's behaviour and that the real dispatch-shaped
 * payload survives it clean. It does NOT drive a full live agent turn, so it cannot prove the
 * scrubber is *invoked* on every future boundary — that is what the source check at the end is for,
 * and a source check is weaker than a runtime one.
 */

const { boot } = require('./state/harness');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { failures++; console.log('  FAIL ' + name + '\n         ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ── the negative control, assertPayloadClean-shaped ──────────────────────────────────────────
// Walks the WHOLE payload. Checks NAMES and VALUES, per the standing rule (§8.55): a key called
// `url` is one leak shape, and a Documents.php link hiding in a differently-named field is another.
const URL_KEYS = ['url', 'fileUrl', 'documentUrl', 'link', 'href'];
function findUrlLeaks(node, path, out) {
  out = out || [];
  path = path || '$';
  if (node === null || typeof node !== 'object') {
    if (typeof node === 'string' && /Documents\.php|shipprimus\.com\/Documents/i.test(node)) {
      out.push(path + ' → document link in a value');
    }
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => findUrlLeaks(v, path + '[' + i + ']', out));
    return out;
  }
  for (const k of Object.keys(node)) {
    if (URL_KEYS.includes(k) && typeof node[k] === 'string' && node[k]) {
      out.push(path + '.' + k + ' → forbidden key');
    }
    findUrlLeaks(node[k], path + '.' + k, out);
  }
  return out;
}

const DOCS_FIXTURE = [
  { type: 'BOL', name: 'Bill of Lading', url: 'https://www.shipprimus.com/Documents.php?id=NDxx&t=abc' },
  { type: 'POD', name: 'Proof of Delivery', url: 'https://www.shipprimus.com/Documents.php?id=NDyy&t=def' },
];

(async function main() {
  const ctx = boot();
  const g = ctx.g;

  // Seed the document cache the way a real booking does.
  ctx.win._rememberBOLDocuments('1362360734', DOCS_FIXTURE);

  console.log('\nTIER A — no document URL may reach the model\n');

  // 1 ─ THE LEAK ITSELF, at the boundary that actually sends it.
  //
  //     PROVENANCE — this was RED BY DEFECT on HEAD (fcfd880), before any scrubber existed. The
  //     producing shape is portal.html ~:14372, `documents: validDocs` where
  //     validDocs = _documentsFor(...), and HEAD serialised it with a bare JSON.stringify(result).
  //     First run, verbatim:
  //
  //       FAIL: the payload that gets JSON.stringify'd to the model contains 4 document link(s):
  //             $.documents[0].url → forbidden key;  $.documents[0].url → document link in a value;
  //             $.documents[1].url → forbidden key;  $.documents[1].url → document link in a value
  //
  //     It now asserts the BOUNDARY property rather than the producer's, because the producer must
  //     keep its URLs — the client renderer needs them (see the negative control below). An earlier
  //     draft of this test asserted the producer was clean, which was both the "one particular call"
  //     shape this file exists to avoid AND in direct contradiction with that control.
  check('THE LEAK: what reaches the model carries no document URL', () => {
    assert(typeof ctx.win._toolResultSafe === 'function', 'no boundary control exists');
    const produced = { ok: true, confirmation: 'C1', PRO: 'P1', documents: ctx.win._documentsFor('1362360734') };
    assert(findUrlLeaks(produced).length > 0, 'fixture is not exercising the leak — the producer should still carry URLs');
    const sent = JSON.parse(JSON.stringify(ctx.win._toolResultSafe(produced)));
    const leaks = findUrlLeaks(sent);
    assert(leaks.length === 0,
      'the payload that gets JSON.stringify\'d to the model contains ' + leaks.length +
      ' document link(s): ' + leaks.join('; '));
  });

  // 2 ─ RED BY ABSENCE until the boundary scrubber exists.
  check('RED-BY-ABSENCE: a boundary scrubber exists', () => {
    assert(typeof ctx.win._toolResultSafe === 'function',
      '_toolResultSafe is not defined — there is no boundary control, only two patched call sites');
  });

  // 3 ─ the GENERAL property. Not "this call was cleaned" — any payload, any depth, any future tool.
  check('GENERAL: the scrubber removes document links at any depth, in arrays and nested objects', () => {
    assert(typeof ctx.win._toolResultSafe === 'function', 'scrubber missing');
    const gnarly = {
      ok: true,
      documents: DOCS_FIXTURE,
      nested: { deeper: { docs: DOCS_FIXTURE, note: 'see https://www.shipprimus.com/Documents.php?id=NDzz' } },
      list: [{ a: [{ url: 'https://www.shipprimus.com/Documents.php?id=NDaa' }] }],
    };
    const leaks = findUrlLeaks(ctx.win._toolResultSafe(gnarly));
    assert(leaks.length === 0, 'scrubber left ' + leaks.length + ' leak(s): ' + leaks.join('; '));
  });

  check('GENERAL: the scrubber preserves everything the agent actually needs', () => {
    assert(typeof ctx.win._toolResultSafe === 'function', 'scrubber missing');
    const out = ctx.win._toolResultSafe({ ok: true, confirmation: 'C1', PRO: 'P1', documents: DOCS_FIXTURE });
    assert(out.ok === true && out.confirmation === 'C1' && out.PRO === 'P1', 'non-document fields were altered');
    assert(Array.isArray(out.documents) && out.documents.length === 2, 'document COUNT must survive — the agent needs to know they exist');
    assert(out.documents[0].type === 'BOL' && out.documents[1].type === 'POD', 'document TYPE must survive');
  });

  // 4 ─ NEGATIVE CONTROL IN THE OTHER DIRECTION. The client RENDERS from _documentsFor() and
  //     downloadDoc() needs the URL, so the fix must be scoped to the model boundary. If this ever
  //     goes green-by-stripping-everywhere, the Documents modal has silently lost its links.
  check('NEGATIVE CONTROL: _documentsFor() still returns URLs — the client needs them', () => {
    const docs = ctx.win._documentsFor('1362360734');
    assert(docs.length === 2, 'cache read broken');
    assert(typeof docs[0].url === 'string' && docs[0].url.length > 0,
      'the client renderer lost its URLs — the strip was applied too broadly');
  });

  // 5 ─ SOURCE CHECK. Weaker than runtime, and labelled so. It exists because the two serialisation
  //     points are what make this a boundary property at all.
  check('SOURCE: every tool_result serialisation point routes through the scrubber', () => {
    const fs = require('fs');
    const html = fs.readFileSync(require('path').join(__dirname, '..', 'portal.html'), 'utf8');
    const sites = [...html.matchAll(/type:\s*'tool_result'[\s\S]{0,200}?content:\s*JSON\.stringify\(([^)]*)\)/g)];
    assert(sites.length >= 2, 'expected at least 2 tool_result serialisation sites, found ' + sites.length);
    const unguarded = sites.map(m => m[1].trim()).filter(a => !/_toolResultSafe\s*\(/.test(a));
    assert(unguarded.length === 0,
      unguarded.length + ' of ' + sites.length + ' tool_result site(s) serialise an unscrubbed payload: ' + unguarded.join(' | '));
  });

  ctx.dom.window.close();
  console.log('\n' + (failures ? failures + ' FAILING' : 'all passing') + '\n');
  process.exit(failures ? 1 : 0);
})();
