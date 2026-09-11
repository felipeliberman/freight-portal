# RUNBOOK — checking for real [FP-ERR] captures

Since 2026-09-11 the portal ships browser-side exceptions to
`anthropic-proxy` at `POST /_clienterr`, which logs one line per report with the
stable prefix `[FP-ERR]`. `anthropic-proxy` has Workers Logs enabled with
`persist: true` and `head_sampling_rate: 1`, declared in
`anthropic-proxy/wrangler.toml` so a deploy re-asserts it rather than wiping it.

Run this once a day. It answers: how many captures landed, what they were,
whether any are truncated or degraded, and which signatures recur.

---

## The daily command

Needs one API token, minted once (see "Minting the token" below), exported as
`CF_OBS_TOKEN`.

```sh
CF_OBS_TOKEN=<token> ACCT=b800adf3aeb0eb8ecbf33032450a24a2 HOURS=24 sh -c '
curl -sS -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/observability/telemetry/query" \
  -H "Authorization: Bearer $CF_OBS_TOKEN" -H "Content-Type: application/json" \
  -d "$(python3 - <<PY
import json,time
now=int(time.time()*1000); frm=now-int("$HOURS")*3600*1000
print(json.dumps({"queryId":"fp-err-daily","timeframe":{"from":frm,"to":now},
 "parameters":{"datasets":["cloudflare-workers"],"limit":200,
  "filters":[{"key":"$metadata.message","operation":"includes","value":"FP-ERR","type":"string"}]},
 "view":"events"}))
PY
)" | python3 -c "
import sys,json,re,collections
d=json.load(sys.stdin)
if not d.get(\"success\"):
    print(\"QUERY FAILED:\", json.dumps(d.get(\"errors\"))[:300]); raise SystemExit(1)
ev=(d.get(\"result\") or {}).get(\"events\") or (d.get(\"result\") or {}).get(\"rows\") or []
recs=[]
for e in ev:
    blob=json.dumps(e)
    m=re.search(r\"\\[FP-ERR\\] (\{.*?\})(?:\\\\n|\\\"\\s*[,}])\", blob)
    if not m: continue
    try: outer=json.loads(m.group(1).encode().decode(\"unicode_escape\"))
    except Exception: continue
    try: rep=json.loads(outer.get(\"report\") or \"{}\")
    except Exception: rep={\"_unparseable\":True}
    recs.append((outer,rep))
print(\"[FP-ERR] captures in window: %d\" % len(recs))
if not recs: raise SystemExit(0)
print()
for outer,rep in recs:
    print(\"  %-22s %-10s %-18s %s\" % (rep.get(\"errName\"), rep.get(\"phase\"), rep.get(\"fn\"), rep.get(\"tsUtc\")))
    print(\"      %s\" % str(rep.get(\"errMessage\"))[:140])
tr=[1 for o,r in recs if o.get(\"truncated\")]
dg=[1 for o,r in recs if r.get(\"degraded\")]
print()
print(\"  truncated:true -> %d    degraded -> %d\" % (len(tr), len(dg)))
print()
g=collections.Counter((r.get(\"errName\"), r.get(\"fn\")) for o,r in recs)
print(\"  grouped by errName + fn:\")
for (n,f),c in g.most_common(): print(\"    %4d  %s | %s\" % (c,n,f))
"'
```

### Minting the token

Dashboard -> My Profile -> API Tokens -> Create Token -> Custom token.
Permission: **Account / Workers Observability / Read**, scoped to this account.
Store it outside the repo, e.g. `~/.cf_obs_token`, and read it inline:
`CF_OBS_TOKEN=$(cat ~/.cf_obs_token)`.

**Honesty note, 2026-09-11:** the command above was NOT executed end to end. The
endpoint returned `401 code 10000` with both tokens available at the time — the
read-only `~/.cf_workers_read_token` (Workers Scripts: Read) and the cached
wrangler OAuth token — neither of which carries the observability scope. What WAS
verified is that the underlying data exists and is queryable: the dashboard Logs
view for `anthropic-proxy` renders retained `[FP-ERR]` lines. If the response
shape differs from what the parser expects, drop the `| python3 ...` half and look
at the raw JSON first; the query itself is the part that matters.

---

## No-setup alternative, verified 2026-09-11

If you do not want to mint a token, open the Logs view pre-filtered. This is a
single command and needs nothing but a browser session:

```sh
open 'https://dash.cloudflare.com/b800adf3aeb0eb8ecbf33032450a24a2/workers/services/view/anthropic-proxy/production/observability/events?needle=%7B%22value%22%3A%22FP-ERR%22%7D&timeframe=24h&calculations=%5B%7B%22operator%22%3A%22count%22%7D%5D&filterCombination=%22and%22&conditions=%7B%7D&conditionCombination=%22and%22'
```

`needle` is the search term, `timeframe` accepts `1h` / `24h` / `7d`, and
`calculations` with `count` puts the total on the chart. Equivalently: Workers &
Pages -> anthropic-proxy -> Observability -> Logs, and type `FP-ERR` in the
"Search with query language..." box.

This gives items 1-3 directly. Grouping by signature (item 4) it does not do —
that is what the API command is for.

---

## Reading the output

- **`errName` + `fn` is the signature.** `fn` is the capture site: `_agentTurnFailed`
  (the agent turn machinery — proxy failures and tool-executor throws) or
  `doGetRates` (the Primus rate-pull class, which never reaches the agent path).
  A repeat of the same pair is one bug, not several.
- **`truncated: true`** on the OUTER object means the Worker received a body at or
  over its 8192-byte cap and cut it, so `report` will not parse. The client bounds
  its own payload, so this should not happen — if it does, something new is being
  serialized unbounded. Do not raise the cap; find what grew.
- **`degraded: true`** with a `snapshotError` means the client could not serialize
  the full report and fell back to the survivable fields. The error itself is still
  trustworthy; only the draft/rate-error detail is missing.
- **`draft`** is the redacted quote state: ZIPs, weight, class, accessorial codes,
  residential and hazmat flags. No names, streets, emails or phones — by design,
  and it must stay that way.
- **`lastRatePullError.rawDropped`** is a number when the bulk Primus `noRates`
  array was trimmed, and `null` when there was no such array. A number is not a
  problem; it is the trim working.
- **Send caps:** 3 per `errName|fn` and 20 per browser session, in memory only. A
  recurring bug therefore shows at most 3 lines per session, not hundreds. Absence
  past 3 is the cap, not the bug stopping.

## Limits

- `wrangler tail` is live-only; there is no `wrangler logs` query command. It is
  useful for watching a reproduction, not for a daily check.
- Workers Logs retention is limited (days, not weeks). A daily cadence is the point.
- As of 2026-09-11 the reporter has never fired on a REAL failure — only on probes
  and a unit harness. The first organic capture is still outstanding.
