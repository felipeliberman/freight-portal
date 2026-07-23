'use strict';
/**
 * run.js — send each question through the REAL agent and record the answer.
 *
 * The system prompt is assembled exactly as the anthropic-proxy Worker will assemble it
 * once KB injection lands (Step 3):
 *     knowledgeFor(audience)  +  "\n\n---\n\n"  +  behavioralPrompt(audience)
 * If that join order changes in the Worker, change it here too — the eval is only honest
 * if it feeds the model the same system the customer's agent gets.
 *
 * Input:  ./questions.generated.json  (or --seed to run the raw seed file directly)
 * Output: ./results/answers.<n>.json
 *
 * Run:  ANTHROPIC_API_KEY=... node evals/run.js [--seed] [--audience=landing|portal]
 */
const fs = require('fs');
const path = require('path');
const { ask } = require('./client');
const { knowledgeFor } = require('./knowledge');
const { behavioralPrompt } = require('./agent-prompt');

const RESULTS_DIR = path.join(__dirname, 'results');
const GEN_PATH = path.join(__dirname, 'questions.generated.json');
const SEED_PATH = path.join(__dirname, '..', 'real-questions-seed.json');
const CASES_PATH = (aud) => path.join(__dirname, `cases.${aud}.json`);

const args = process.argv.slice(2);
const useSeed = args.includes('--seed');
const audience = (args.find((a) => a.startsWith('--audience=')) || '--audience=landing').split('=')[1];

// Structured behavioral cases (cases.<audience>.json). Unlike the seed corpus these carry the LIVE
// PORTAL STATE the agent would really have, plus their own pass/fail criteria — some behaviours only
// exist in context and cannot be reproduced by a bare question.
function loadCases(aud) {
  const p = CASES_PATH(aud);
  if (!fs.existsSync(p)) return [];
  const { cases } = JSON.parse(fs.readFileSync(p, 'utf8'));
  return (cases || []).map((c) => ({
    audience: c.audience || aud,
    category: c.category || 'behavioral',
    id: c.id,
    question: (c.messages && c.messages.length ? c.messages[c.messages.length - 1].content : ''),
    messages: c.messages,
    context: c.context || '',
    must: c.must || [],
    must_not: c.must_not || [],
    why: c.why || '',
  }));
}

function loadQuestions() {
  if (!useSeed && fs.existsSync(GEN_PATH)) return JSON.parse(fs.readFileSync(GEN_PATH, 'utf8'));
  // Fall back to the raw seed corpus (no generation step needed).
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const out = [];
  for (const [category, questions] of Object.entries(seed.categories)) {
    for (const q of questions) out.push({ audience, category, seed: q, question: q });
  }
  return out;
}

function buildSystem(aud) {
  return `${knowledgeFor(aud)}\n\n---\n\n${behavioralPrompt(aud)}`;
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const onlyCases = args.includes('--cases');
  const cases = loadCases(audience);
  const questions = onlyCases ? cases
    : loadQuestions().filter((q) => (q.audience || audience) === audience).concat(cases);
  const system = buildSystem(audience);
  console.log(`Running ${questions.length} question(s) | audience=${audience} | ${cases.length} structured case(s) | system=${system.length} chars`);

  const answers = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    try {
      // A case's `context` is appended to the system the same way the portal appends the live state
      // block — second system section, after the behavioral prompt. Feeding it as a user turn would
      // let the model treat it as something the CUSTOMER said, which is not what happens in the app.
      const answer = await ask({
        system: q.context ? `${system}\n\n${q.context}` : system,
        maxTokens: 700,
        messages: q.messages && q.messages.length ? q.messages : [{ role: 'user', content: q.question }],
      });
      answers.push({ ...q, answer });
    } catch (e) {
      answers.push({ ...q, answer: null, error: e.message });
      console.warn(`  ! ${q.category} #${i}: ${e.message}`);
    }
    if ((i + 1) % 10 === 0) console.log(`  …${i + 1}/${questions.length}`);
  }

  // Deterministic filename (no Date.now — pick the next free index).
  let n = 0;
  while (fs.existsSync(path.join(RESULTS_DIR, `answers.${n}.json`))) n++;
  const out = path.join(RESULTS_DIR, `answers.${n}.json`);
  fs.writeFileSync(out, JSON.stringify({ audience, system, answers }, null, 2));
  console.log(`\nWrote ${answers.length} answers → ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
