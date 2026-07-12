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

const args = process.argv.slice(2);
const useSeed = args.includes('--seed');
const audience = (args.find((a) => a.startsWith('--audience=')) || '--audience=landing').split('=')[1];

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
  const questions = loadQuestions().filter((q) => (q.audience || audience) === audience);
  const system = buildSystem(audience);
  console.log(`Running ${questions.length} questions | audience=${audience} | system=${system.length} chars`);

  const answers = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    try {
      const answer = await ask({
        system,
        maxTokens: 700,
        messages: [{ role: 'user', content: q.question }],
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
