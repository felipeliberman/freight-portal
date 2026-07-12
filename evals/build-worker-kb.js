'use strict';
/**
 * build-worker-kb.js — regenerate the embedded KB bundles in the anthropic-proxy worker
 * from KNOWLEDGE.md. Run after any KNOWLEDGE.md edit, then redeploy the worker:
 *
 *     node evals/build-worker-kb.js && (cd anthropic-proxy && wrangler deploy)
 *
 * Uses evals/knowledge.js as the single source of the scope split, so the worker and the
 * eval harness can never drift. Rewrites only the region between the KB-EMBED markers.
 */
const fs = require('fs');
const path = require('path');
const { knowledgeFor } = require('./knowledge');

const WORKER_PATH = path.join(__dirname, '..', 'anthropic-proxy', 'src', 'index.js');
const START = '// >>> KB-EMBED (generated — do not hand-edit) >>>';
const END = '// <<< KB-EMBED <<<';

function build() {
  const landing = knowledgeFor('landing');
  const portal = knowledgeFor('portal');
  const region =
    `${START}\n` +
    `const KB_LANDING = ${JSON.stringify(landing)};\n` +
    `const KB_PORTAL = ${JSON.stringify(portal)};\n` +
    `${END}`;

  const src = fs.readFileSync(WORKER_PATH, 'utf8');
  const s = src.indexOf(START);
  const e = src.indexOf(END);
  if (s === -1 || e === -1) throw new Error(`KB-EMBED markers not found in ${WORKER_PATH}`);
  const next = src.slice(0, s) + region + src.slice(e + END.length);
  fs.writeFileSync(WORKER_PATH, next);
  console.log(`Embedded KB → ${path.relative(process.cwd(), WORKER_PATH)}`);
  console.log(`  KB_LANDING: ${landing.length} chars`);
  console.log(`  KB_PORTAL:  ${portal.length} chars`);
}

build();
