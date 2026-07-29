# Layer-2 — chat + quoting flow simulations

Deterministic jsdom simulations that drive the **real** portal turn pipeline (chat + quoting only —
no tracking, reports, invoices, or landing page). Where layer 1 (`evals/state`) proves per-action
invariants and bypasses the LLM by calling the `_exec*` tools directly, **layer 2 stubs the single AI
seam (`window.flAnthropic`) with hand-authored assistant turns** — text and/or `tool_use` blocks — so
the real `aiConverse` tool-loop and the real `_gateFinalText` enforcer run exactly as in production.

Nothing here touches the network or the real model. `ANTHROPIC_API_KEY` is never read; every outbound
call (anthropic-proxy, Primus rates/book/dispatch, geocodio, zippopotam, terms-proxy) is answered from
fixtures via the recording fetch router inherited from `evals/state/harness.js`. Assertions target
**application state and captured outbound payloads — never agent prose**.

## Run

```
node evals/layer2/run.js          # all cases
node evals/layer2/run.js 2 5      # a subset by id
```

Exit code is `1` on any `FAIL` or `UNEXPECTED-PASS`. An `expectFail` case that starts **passing** fails
the suite (the documented bug is fixed → remove the flag).

Full green bar for a change touching the chat/quoting surfaces:

```
node evals/state/run.js     # 45 state invariants + the 20-step acceptance flow
node evals/layer2/run.js    # these flow simulations
```

## Files

- `harness.js` — `boot2()` wraps `../state/harness` `boot()` and adds: `scriptAI(turns)` (the
  flAnthropic queue), `openQuote()`, `seedZips()` (preseed `zipCache` so ZIP resolution needs no
  fetch), `rateRequests()` (captured `/rate/multiple` payloads with the query parsed), a copy of the
  acceptance-flow `installPullStub`, and the AI-turn builders `text`/`toolUse`/`turn`.
- `fixtures.js` — the money regex, money-render rates (4-digit + half-dollar), and Haynes-shaped
  booking party fill. Rate/geo/book responses live in `harness.js` routes. Never Simply Nursery.
- `cases.js` — the flow cases (below).
- `run.js` — the runner (mirrors `evals/state/run.js`, incl. the `unhandledRejection` teardown guard).

## Cases (mapped to this sprint's bug classes)

| id | case | asserts |
|----|------|---------|
| 1  | transcript single-writer | `chatHistory` grows only via `appendMessage`; `skipHistory` renders but is not recorded; no duplicates; every entry shown in the DOM |
| 2  | promise-without-action | an unbacked "pulling rates" claim makes `_gateFinalText` fire exactly one real `/rate/multiple`; the reply is delivered, never silenced |
| 3  | residential not raised by chat | geocoder verdict absent from `_liveStateBlock()`/`_convoSysPrompt`; `checkRDIBeforeDispatch` is the sole surface that speaks it; customer-**stated** residential correctly adds RSD (valid, not forbidden) |
| 4  | insurance after hazmat | undecided insurance holds the pull and asks once (gate-enforced); known commodity settles silently with the read-back and no list; unknown commodity lists exactly once |
| 5  | accessorial fidelity | agreed deliverable codes reach the `/rate/multiple` payload exactly — no silent drop, no phantom code |
| 6  | accessorial loud-fail | an undeliverable code (INO — a real Primus code, disabled on the Haynes account) makes `fetchRates` reject the whole quote before any fetch |
| 7  | re-quote preservation | each of the three exit paths (back button, chrome tab, sidebar) snapshots to `_quotedContacts`; `_restoreBookingFromQuoted` refills the fields it owns, field-for-field |
| 8  | fmtMoney (canonical) | every price on the fmtMoney-routed quote surfaces matches `^\$\d{1,3}(,\d{3})*\.\d{2}$` |
| 9  | fmtMoney gap — **KNOWN (expectFail)** | documents three rate-detail surfaces that bypass fmtMoney: `portal.html:19956` (Rate Saved!), `:19971` (post-save "Booking with"), `:19984/:20012/:20022` (breakdown modal). Fix those through fmtMoney, then remove the flag |
| 10 | booking greeting truthfulness | `_bookingGreeting` reflects the live `bk-*` DOM state — never claims an empty field is set, never re-asks a filled one |

### Reused layer-1 invariants
The flow cases reuse the property contracts proven by layer-1 invariants as per-step checks:
**9** (single transcript writer) → case 1; **18/22** (rate-promise fires one pull; insurance once
before the pull) → cases 2, 4; **15** (geocoder verdict not in chat) → case 3; **29/16** (Option B
silent settle / list only when unknown) → case 4; **4/45** (accessorial-set survival / under-quote
guard) → cases 5, 6; **26** (two-decimal money) → case 8; **27/30** (one truthful greeting) →
cases 7, 10.
