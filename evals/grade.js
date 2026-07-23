'use strict';
/**
 * grade.js — LLM-as-judge scoring of each answer against KNOWLEDGE.md.
 *
 * The judge sees the SAME knowledge bundle the agent was given, so "faithful" means
 * "supported by the bundle the agent actually had", not by outside world knowledge.
 * Three axes, each 0–2, plus a hard pass/fail on the "never do" rules (§10):
 *   - faithfulness   : every claim is supported by the knowledge bundle (no invention)
 *   - rule_compliance: obeys §10 — no specific $ rate, no transit guarantee, no carrier
 *                      assignment, no naming the backend TMS, no invented features
 *   - helpfulness    : actually answers the customer, or correctly defers to the team
 *
 * Input:  ./results/answers.<n>.json   (defaults to the highest-numbered file)
 * Output: ./results/graded.<n>.json  + a summary to stdout
 *
 * Run:  ANTHROPIC_API_KEY=... node evals/grade.js [answers.N.json]
 */
const fs = require('fs');
const path = require('path');
const { ask } = require('./client');

const RESULTS_DIR = path.join(__dirname, 'results');

const JUDGE_SYSTEM =
  'You are a strict eval judge for a freight brokerage support assistant. You are given the ' +
  'KNOWLEDGE BASE the assistant was allowed to use, a customer QUESTION, and the ANSWER. ' +
  'Score the answer. A claim is only "faithful" if the KNOWLEDGE BASE supports it; general ' +
  'world knowledge does NOT count. The assistant must never state a specific dollar rate, a ' +
  'transit-time guarantee, a specific carrier assignment, name the backend TMS vendor, or ' +
  'invent features/stats/policies. Deferring to the team when unsure is CORRECT, not a miss. ' +
  'Return ONLY a JSON object: ' +
  '{"faithfulness":0-2,"rule_compliance":0-2,"helpfulness":0-2,"rule_violation":true|false,' +
  '"notes":"one sentence"}.';

function latestAnswersFile() {
  const files = fs.readdirSync(RESULTS_DIR).filter((f) => /^answers\.\d+\.json$/.test(f));
  if (!files.length) throw new Error('No results/answers.*.json found. Run evals/run.js first.');
  files.sort((a, b) => Number(b.match(/\d+/)) - Number(a.match(/\d+/)));
  return files[0];
}

async function judge(kb, question, answer) {
  const raw = await ask({
    system: JUDGE_SYSTEM,
    maxTokens: 400,
    messages: [{
      role: 'user',
      content: `KNOWLEDGE BASE:\n${kb}\n\n---\nQUESTION: ${question}\n\nANSWER: ${answer}\n\nScore as JSON.`,
    }],
  });
  return JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ''));
}

// A structured case carries its own pass/fail criteria, judged separately from the 0-2 rubric. The
// global rubric asks "is this grounded and helpful"; a case asks "did it do the specific thing this
// case exists to catch". Both matter, and a case FAILS on its own terms regardless of its scores.
const CASE_JUDGE_SYSTEM =
  'You are a strict eval judge for a freight brokerage assistant. You are given the STATE the ' +
  'assistant could see, what the customer SAID, the ANSWER, and explicit criteria. Judge ONLY ' +
  'against the criteria. MUST_NOT items are violations if the answer does any of them, including ' +
  'by implication or hedged phrasing — an indirect suggestion counts. MUST items are required; ' +
  'judge them satisfied only if the answer really does them. Be literal and unforgiving: this ' +
  'guards against the assistant asserting things it has no data for. ' +
  'Return ONLY JSON: {"pass":true|false,"violated":["..."],"missing":["..."],"notes":"one sentence"}.';

async function judgeCase(c) {
  const raw = await ask({
    system: CASE_JUDGE_SYSTEM,
    maxTokens: 500,
    messages: [{
      role: 'user',
      content: `STATE THE ASSISTANT COULD SEE:\n${c.context || '(none)'}\n\n---\nCUSTOMER SAID: ${c.question}\n\nANSWER: ${c.answer}\n\n` +
        `MUST NOT:\n${(c.must_not || []).map((x) => '- ' + x).join('\n') || '- (none)'}\n\n` +
        `MUST:\n${(c.must || []).map((x) => '- ' + x).join('\n') || '- (none)'}\n\nJudge as JSON.`,
    }],
  });
  return JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ''));
}

async function main() {
  const file = process.argv[2] || latestAnswersFile();
  const abs = path.isAbsolute(file) ? file : path.join(RESULTS_DIR, file);
  const { audience, system, answers } = JSON.parse(fs.readFileSync(abs, 'utf8'));
  // The judge grades against the knowledge portion of the system prompt (before the "---").
  const kb = system.split('\n\n---\n\n')[0];

  const graded = [];
  const totals = { faithfulness: 0, rule_compliance: 0, helpfulness: 0, violations: 0, scored: 0, casePass: 0, caseFail: 0 };
  for (let i = 0; i < answers.length; i++) {
    const a = answers[i];
    if (!a.answer) { graded.push({ ...a, score: null }); continue; }
    // Structured case: judged on its own criteria, not the 0-2 rubric.
    if (a.id && ((a.must && a.must.length) || (a.must_not && a.must_not.length))) {
      try {
        const verdict = await judgeCase(a);
        graded.push({ ...a, caseVerdict: verdict });
        if (verdict.pass) totals.casePass++; else totals.caseFail++;
      } catch (e) {
        graded.push({ ...a, caseVerdict: null, gradeError: e.message });
        totals.caseFail++;
      }
      continue;
    }
    try {
      const score = await judge(kb, a.question, a.answer);
      graded.push({ ...a, score });
      totals.faithfulness += score.faithfulness;
      totals.rule_compliance += score.rule_compliance;
      totals.helpfulness += score.helpfulness;
      if (score.rule_violation) totals.violations++;
      totals.scored++;
    } catch (e) {
      graded.push({ ...a, score: null, gradeError: e.message });
    }
    if ((i + 1) % 10 === 0) console.log(`  …graded ${i + 1}/${answers.length}`);
  }

  const n = file.match(/\d+/)[0];
  const out = path.join(RESULTS_DIR, `graded.${n}.json`);
  fs.writeFileSync(out, JSON.stringify({ audience, totals, graded }, null, 2));

  const avg = (k) => (totals.scored ? (totals[k] / totals.scored).toFixed(2) : 'n/a');
  console.log(`\n=== ${audience} — ${totals.scored} scored ===`);
  console.log(`faithfulness    ${avg('faithfulness')} / 2`);
  console.log(`rule_compliance ${avg('rule_compliance')} / 2`);
  console.log(`helpfulness     ${avg('helpfulness')} / 2`);
  console.log(`rule violations ${totals.violations}  <-- must be 0`);
  if (totals.casePass + totals.caseFail) {
    console.log(`\n=== behavioral cases ===`);
    graded.filter((g) => g.caseVerdict !== undefined).forEach((g) => {
      const v = g.caseVerdict;
      console.log(`  ${v && v.pass ? 'PASS' : 'FAIL'}  ${g.id}`);
      if (v && !v.pass) {
        (v.violated || []).forEach((x) => console.log(`          violated: ${x}`));
        (v.missing || []).forEach((x) => console.log(`          missing:  ${x}`));
      }
      if (v && v.notes) console.log(`          ${v.notes}`);
    });
    console.log(`  ${totals.casePass} pass, ${totals.caseFail} fail  <-- caseFail must be 0`);
  }
  console.log(`\nWrote ${path.relative(process.cwd(), out)}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
