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
