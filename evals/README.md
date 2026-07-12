# /evals — agent knowledge & faithfulness harness

Tests that the AI assistants only say things grounded in `KNOWLEDGE.md`, obey the
"never do" rules (§10), and correctly defer to the team when they don't know.

The harness feeds the model the **same system prompt the anthropic-proxy Worker will
assemble** once KB injection lands: the scope-filtered knowledge bundle plus the real
behavioral prompt pulled from the live HTML. Keep the two in sync — the eval is only
meaningful if the model under test sees what the customer's agent sees.

## Scope model (single source of truth: `knowledge.js`)

| Audience | Sections received |
|----------|-------------------|
| `landing` (index.html sales/onboarding agent) | ALL (§1–11) |
| `portal` (portal.html logged-in agent) | `scope: both` + §11 only — excludes the `landing`-tagged §3, 6, 7, 9 |

`knowledge.js` parses the `<!-- scope: … -->` tags and is the same logic the Worker must
use. Change the split in one place and mirror it in the other.

## Files

| File | Role |
|------|------|
| `knowledge.js` | Parse + scope-split `KNOWLEDGE.md`. `node evals/knowledge.js portal` prints the portal bundle. **Working / tested.** |
| `agent-prompt.js` | Extract the real `SYSTEM_PROMPT` (index.html) / `_convoSysPrompt` (portal.html). |
| `client.js` | Minimal direct Anthropic Messages client (`ANTHROPIC_API_KEY`). |
| `generate.js` | Expand `../real-questions-seed.json` into paraphrased variants → `questions.generated.json`. |
| `run.js` | Run questions through the agent → `results/answers.<n>.json`. |
| `grade.js` | LLM-judge each answer vs the knowledge bundle → `results/graded.<n>.json` + summary. |
| `results/` | Output (gitignored). |

## Run

```bash
export ANTHROPIC_API_KEY=sk-ant-...          # direct API: the proxy rejects localhost
node evals/knowledge.js portal                # sanity-check the scope split
node evals/generate.js 8                       # optional: expand seeds to ~8 variants each
node evals/run.js --audience=landing           # or --seed to skip generation, or --audience=portal
node evals/grade.js                            # grades the newest results file
```

## Status — scaffold

- `knowledge.js` is complete and verified against the current `KNOWLEDGE.md`.
- `generate.js` / `run.js` / `grade.js` are wired end-to-end but **untested against the live
  API** (no key in this environment). Open items before trusting scores:
  - Tune the judge rubric in `grade.js` (the 0–2 axes are a first pass).
  - `agent-prompt.js` extracts the template literal verbatim; if a prompt carries heavy
    `${…}` runtime context, extract it more precisely.
  - Decide whether the seed file should move into `evals/` (currently read from repo root).
