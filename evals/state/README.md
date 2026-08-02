# /evals/state — state invariants

Headless. No browser, no network, no credentials. `harness.js` loads portal.html's application
script into jsdom and drives the **real** functions; every `fetch` is answered from `fixtures.js`.

```bash
node evals/state/run.js        # all
node evals/state/run.js 2 7    # by id
```

Exit 1 only on an unexpected FAIL or an UNEXPECTED-PASS. Expected failures alone exit 0.

## Why invariants, not bug tests

Every bug in the July batch was the same shape: two paths held separate copies of one piece of
state, one path updated, the other did not, and the customer was told something untrue. A test per
bug finds the bug that already happened. An invariant is a property that must hold after *every*
action, so it fails on the next instance of the class too.

## Expected failures are the specification

An invariant marked `expectFail` is a property the code does not yet satisfy, with the commit that
will satisfy it named in `fixedBy`. They print loudly rather than being skipped — and an
expected-fail that starts passing is reported as UNEXPECTED-PASS, because that is equally worth a
look. Do not add an invariant already green when its surface has not been built.

| # | property | catches | status |
|---|---|---|---|
| 1 | chat party state === form party state | smart-paste "already filled in" on an empty form | expected-fail → S6 |
| 2 | adding a line never rewrites an existing line | 3rd item overwrote item 1 | pass |
| 3 | the lock never outlives its rate list | stale lock hijacked a fresh selection | pass |
| 4 | accessorials survive as one set | LAD/APT/INS dropped before accessorialsList | pass |
| 5 | insurance toggle and value move together | the insurance re-ask loop | expected-fail → S7 |
| 6 | the edit target is never a guessed id | PUT /book/<BOLNumber> → 404 | pass |
| 7 | no silent mutate-and-return | "remove liftgate" became shipper:name; insurance question deflected | expected-fail → S8 |
| 8 | a save is reported saved only when the backend said so | "Saved as BOL ####" after a 404 | pass |

Invariant 7 is the general one: it is a property of the router, so it fails on *any* future
interceptor added without a gate — not just the four that exist today.

## Wire tests — `wire.js`

Run automatically by `run.js` (skipped when a subset of invariants is requested by id), or
standalone with `node evals/state/wire.js`.

Invariants assert on state. **Wire tests assert on the captured outgoing request and the mounted
DOM.** That distinction is the whole point: the stale-state defects of Jul–Aug 2026 left every
in-memory variable looking plausible and diverged only at the request boundary — a rate pull whose
lane and weight belonged to the *previous* shipment, a consignee whose city and ZIP came from
different shipments. Nothing readable from a variable would have caught either.

| # | asserts | catches |
|---|---|---|
| 1a | a cold-boot tab restore opens the quote form silently and stamps no dedupe window | the 2s boot timer swallowing a real "Get a Quote" click, leaving the restored form live |
| 1b | a stale `doGetRates` closure refuses to pull; a reset disarms `window._doGetRates` | rating a detached form — a detached container keeps every input value |
| 1c | a requote rates ITS OWN freight | the requote that rated whatever was left in the DOM (weight 100 from the prior customer) |
| 2a | a rebuild never grafts a stale city, and the ZIP field is actually populated | `city=PICO RIVERA` + `zip=90035`; and the empty-ZIP fallthrough to the prior shipment's ZIP |
| 2b | a divergent city/ZIP pair is refused before the write; a matching pair passes | Primus 400 "consignee information does not match the quote record" |
| 2c | a ZIP-lookup outage writes nothing, logs loudly, and the guard fails OPEN | a silent `.catch(()=>{})` leaving a stale city; and a geocoder outage blocking every save |
| 4 | the `[WRITE]` tracer traces when armed, is silent when not | regressions in the `?fpdebug=1` field tracer |

Case 2a earned its keep on first run: it failed on `zip=""` and exposed that **both** booking ZIP
fields had been permanently empty, because `field()`'s 4th argument is a *placeholder* and the
`getElementById` that set the value ran before the section was appended to the document.
