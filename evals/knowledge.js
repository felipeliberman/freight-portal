'use strict';
/**
 * knowledge.js — parse KNOWLEDGE.md and split it by scope tag.
 *
 * SINGLE SOURCE OF TRUTH for the scope-tag split. The anthropic-proxy Worker uses
 * the SAME rules to decide what each agent sees, so this file and the Worker must
 * agree. If you change the split here, mirror it in the Worker (see anthropic-proxy).
 *
 * Scope model (from KNOWLEDGE.md header):
 *   - Landing page agent  → ALL sections.
 *   - Portal agent        → `scope: both` sections + section 12 (`scope: portal`).
 *                           Excludes `scope: landing` (sales playbook, onboarding, etc.).
 *
 * A section header looks like:  `## 8. FAQ ... <!-- scope: both -->`
 */
const fs = require('fs');
const path = require('path');

const KNOWLEDGE_PATH = path.join(__dirname, '..', 'KNOWLEDGE.md');

/** Which scopes each audience receives. */
function includesScope(audience, scope) {
  if (audience === 'landing') return true;                       // landing gets everything
  if (audience === 'portal') return scope === 'both' || scope === 'portal';
  throw new Error(`unknown audience: ${audience} (expected "landing" or "portal")`);
}

/**
 * Parse KNOWLEDGE.md into { preamble, sections: [{ num, title, scope, body, raw }] }.
 * `preamble` is everything before section 1, minus the internal "Scope tags"
 * maintenance block (that block instructs the developer, not the agent).
 */
function parseKnowledge(md) {
  const lines = md.split('\n');
  const headerRe = /^##\s+(\d+)\.\s+(.*?)\s*<!--\s*scope:\s*(both|landing|portal)\s*-->\s*$/;

  const sections = [];
  let preambleLines = [];
  let cur = null;
  let sawFirstSection = false;

  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) {
      sawFirstSection = true;
      if (cur) sections.push(cur);
      cur = { num: Number(m[1]), title: m[2].trim(), scope: m[3], body: [], raw: [line] };
      continue;
    }
    if (cur) {
      cur.body.push(line);
      cur.raw.push(line);
    } else if (!sawFirstSection) {
      preambleLines.push(line);
    }
  }
  if (cur) sections.push(cur);

  // Strip the "**Scope tags.**" maintenance bullet block from the preamble — it is
  // developer-facing doc-maintenance guidance, not a fact the agent should recite.
  const cleanedPreamble = stripScopeTagBlock(preambleLines).join('\n').trim();

  for (const s of sections) {
    s.body = s.body.join('\n').trim();
    s.raw = s.raw.join('\n').trim();
  }
  return { preamble: cleanedPreamble, sections };
}

function stripScopeTagBlock(lines) {
  const out = [];
  let skipping = false;
  for (const line of lines) {
    if (/^\*\*Scope tags\.\*\*/.test(line)) { skipping = true; continue; }
    if (skipping) {
      // The block is the bullet list immediately following; end it at the first
      // horizontal rule or blank-then-nonbullet boundary.
      if (/^---\s*$/.test(line)) { skipping = false; out.push(line); continue; }
      if (/^\s*-\s/.test(line) || line.trim() === '') continue;
      skipping = false;
    }
    out.push(line);
  }
  return out;
}

/**
 * Build the knowledge-base text a given audience should receive.
 * Returns the concatenated preamble + in-scope sections as a single string.
 */
function knowledgeFor(audience, md) {
  const source = md != null ? md : fs.readFileSync(KNOWLEDGE_PATH, 'utf8');
  const { preamble, sections } = parseKnowledge(source);
  const kept = sections.filter((s) => includesScope(audience, s.scope));
  return [preamble, ...kept.map((s) => s.raw)].filter(Boolean).join('\n\n');
}

module.exports = { KNOWLEDGE_PATH, includesScope, parseKnowledge, knowledgeFor };

// CLI: `node evals/knowledge.js landing|portal` prints the bundle; no arg prints a summary.
if (require.main === module) {
  const audience = process.argv[2];
  if (audience === 'landing' || audience === 'portal') {
    process.stdout.write(knowledgeFor(audience) + '\n');
  } else {
    const { sections } = parseKnowledge(fs.readFileSync(KNOWLEDGE_PATH, 'utf8'));
    const line = (a) => sections.filter((s) => includesScope(a, s.scope)).map((s) => s.num).join(', ');
    console.log(`Sections parsed: ${sections.map((s) => `${s.num}(${s.scope})`).join('  ')}`);
    console.log(`landing → §${line('landing')}`);
    console.log(`portal  → §${line('portal')}`);
    console.log('\nUsage: node evals/knowledge.js landing|portal   # print that bundle');
  }
}
