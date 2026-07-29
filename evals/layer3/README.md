# Layer-3 — adversarial persona suite (phase 1)

A live **customer model** improvises difficult customers against the **real portal agent** (real
`aiConverse` tool-loop + real `_gateFinalText`, driven through the existing `window.flAnthropic`
seam), in jsdom over real `portal.html`. Deterministic invariants are checked on **state and
captured payloads** after every agent turn — never on agent wording. This is a **nightly /
pre-release** suite, not per-diff. No live Primus, no bookings, no accounts, nothing pointed at
production; every Primus response comes from a fixture that **varies by parameter signature** so
"price didn't move" bugs are detectable.

## Run

```
# Live (needs a key) — nightly:
ANTHROPIC_API_KEY=... node evals/layer3/run.js [--persona=A] [--episodes=1] [--replay=3]

# No key — crafted self-test of the invariants + report (NOT a model run, NOT a discovered bug):
node evals/layer3/run.js --smoke
```

Reports land in `evals/layer3/report/findings-<ts>.md` (+ `.json`).

## Phase 1 — what's built (all deterministic)

- **Harness** (`harness.js`) — `boot3()` on top of layer-2 `boot2()`; varying rate fixture
  (`ratemodel.js`); agent driver (`agent.js` — injects `knowledgeFor('portal')`, strips
  `web_search`, `temperature: 0`); customer driver (`customer.js` — persona brief + visible
  transcript only, returns utterance + structured `intentDelta` as invariant-3 ground truth);
  episode loop + N=3 replay.
- **Invariants** (`invariants.js`):
  - **2 — Freshness:** rates presented (deterministic `_summarizeRatesToChat`) while
    `_rateParamSig() !== _lastRatesSig` → stale. Reuses portal.html's own signatures.
  - **3 — Change propagation:** a new `/rate/multiple` must carry the agreed codes, drop removed
    codes, and reflect the requested weight (the RSD/RSO under-quote class).
  - **4 — No internals:** customer-facing text carries no internal code or backend name. The banned
    set is **derived from the source** (`banned.js`, from `ACC_VALID_CODES`/`ACC_CODE_OF` + backend
    identifiers) — not hand-maintained.
  - **Single-ask:** the deterministic cargo-insurance question is not duplicated in one turn.
- **Reporting** (`report.js`) — grouped by **root cause** (not one row per symptom), ranked by
  **customer harm** (wrong price / false claim first, cosmetics last), each finding classified
  **REAL (≥2/3) / INTERMITTENT (1/3) / FLAKE (0/3)** by replay, with model version + date, full
  transcript, and captured `/rate/multiple` payloads. Every report repeats **what this does NOT
  catch** — a green run is evidence, not proof.

## Phase 2 — Inv-1 (claim/state) judge, GATED (designed, not built)

Inv-1 ("the agent never asserts a field/accessorial/value is set unless the form reads that way") is
the hard one and is **not built this pass**. Its mechanism: a judge model *extracts* the agent's
factual claims into structured rows; the harness *compares* them deterministically against the true
snapshot. Before the judge's findings may count, it must pass a **hand-labeled calibration set**:

```
node evals/layer3/calibration/calibrate.js
```

Label by copying `calibration/labels.sample.json` → `labels.json` and setting each `label` to
`TRUE`/`FALSE` — **no judge code involved**. The sample already contains tonight's two known-FALSE
claims ("…residential delivery and liftgate delivery are both active"; "length was already at 96
inches") plus TRUE templates to fill. The judge (a future `calibration/judge.js` exporting
`classifyClaim`) counts only after scoring the labeled set at 100%.

## What layer 3 will NOT catch (kept honest in every report)

Fabricated rationales (phase-2 judge territory); prose quality; real-Primus-specific behavior;
latency/concurrency bugs; `web_search`/terminal paths; booking/dispatch/tracking/invoices unless a
persona drives there; the prose half of Inv-4 (narrating internal gating); anything the customer
model didn't try; and anything a future model version changes.
