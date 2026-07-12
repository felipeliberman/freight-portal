'use strict';
/**
 * agent-prompt.js — pull the REAL behavioral system prompt out of the live HTML so
 * the eval exercises the same agent customers hit, not a paraphrase.
 *
 *   landing → `SYSTEM_PROMPT`  in index.html   (sales/onboarding assistant)
 *   portal  → `_convoSysPrompt` in portal.html (logged-in customer assistant)
 *
 * The full system the model receives at eval time =
 *     knowledgeFor(audience)  +  "\n\n---\n\n"  +  behavioralPrompt(audience)
 * which mirrors what the anthropic-proxy Worker will assemble once KB injection lands
 * (Step 3). Keep the join order identical in both places.
 *
 * NOTE: these are template literals in the source. Any `${…}` runtime interpolation is
 * left verbatim here — fine for eval realism, but if a prompt grows heavy dynamic
 * context, extract it more precisely. Scaffold-level extractor.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = {
  landing: { file: 'index.html', varName: 'SYSTEM_PROMPT' },
  portal: { file: 'portal.html', varName: '_convoSysPrompt' },
};

/** Extract the first backtick-delimited literal assigned to `varName`. */
function extractTemplateLiteral(src, varName) {
  const assignRe = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\``);
  const m = assignRe.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let out = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') { out += src[i] + src[i + 1]; i += 2; continue; }
    if (ch === '`') break;
    out += ch;
    i++;
  }
  return out;
}

function behavioralPrompt(audience) {
  const spec = SOURCES[audience];
  if (!spec) throw new Error(`unknown audience: ${audience}`);
  const src = fs.readFileSync(path.join(ROOT, spec.file), 'utf8');
  const lit = extractTemplateLiteral(src, spec.varName);
  if (!lit) {
    throw new Error(`Could not find ${spec.varName} in ${spec.file}. The extractor may need updating.`);
  }
  return lit;
}

module.exports = { behavioralPrompt };

if (require.main === module) {
  const audience = process.argv[2] || 'landing';
  const p = behavioralPrompt(audience);
  console.log(`${audience} behavioral prompt: ${p.length} chars\n---`);
  console.log(p.slice(0, 500) + (p.length > 500 ? '\n… (truncated)' : ''));
}
