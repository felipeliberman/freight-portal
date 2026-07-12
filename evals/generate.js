'use strict';
/**
 * generate.js — expand the hand-written seed questions into a larger, realistic
 * question set. Each seed becomes N paraphrased variants that keep the same intent
 * but vary phrasing, verbosity, and customer voice.
 *
 * Input:  ../real-questions-seed.json   (the seed corpus, kept at repo root)
 * Output: ./questions.generated.json    ({ audience, category, seed, question }[])
 *
 * Run:  ANTHROPIC_API_KEY=... node evals/generate.js [variantsPerSeed]
 */
const fs = require('fs');
const path = require('path');
const { ask } = require('./client');

const SEED_PATH = path.join(__dirname, '..', 'real-questions-seed.json');
const OUT_PATH = path.join(__dirname, 'questions.generated.json');
const VARIANTS = Number(process.argv[2] || 8); // seed file targets 50–100/category total

const GEN_SYSTEM =
  'You paraphrase customer support questions for an eval set. Given one question, return ' +
  'realistic variants a real freight customer might type — same intent, different wording, ' +
  'varied length and tone (some terse, some rambling, some with typos). Return ONLY a JSON ' +
  'array of strings, no prose.';

async function variantsFor(question, n) {
  const raw = await ask({
    system: GEN_SYSTEM,
    maxTokens: 800,
    messages: [{ role: 'user', content: `Question: ${question}\n\nReturn ${n} variants as a JSON array.` }],
  });
  try {
    const arr = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ''));
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch {
    console.warn(`  ! could not parse variants for: ${question.slice(0, 50)}…`);
    return [];
  }
}

async function main() {
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const out = [];
  for (const [category, questions] of Object.entries(seed.categories)) {
    for (const q of questions) {
      out.push({ audience: 'landing', category, seed: q, question: q }); // keep the original
      const variants = await variantsFor(q, VARIANTS);
      for (const v of variants) out.push({ audience: 'landing', category, seed: q, question: v });
      console.log(`  ${category}: ${q.slice(0, 45)}… → +${variants.length}`);
    }
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${out.length} questions → ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
