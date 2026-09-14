# RUNBOOK — verifying a Worker deploy

For `stripe-payments` and the other `*.felipe-b80.workers.dev` Workers. Written 2026-09-14, after a
deploy that passed every check in this file's predecessor and still broke bank linking for every
customer.

---

## Order: Worker first, then Pages. Rollback is the REVERSE.

**Deploy:** Worker → verify → Pages → verify.
The new `portal.html` calls routes that must already exist. Pages first means every browser hits a
404 on a route the Worker has not got yet.

**Rollback:** Pages → then Worker.
Rolling the Worker back first strands the new `portal.html` calling routes that no longer exist —
the exact 404 the deploy order exists to prevent.

---

## 1. Preflight — THE CHECK THAT MATTERS FOR ANY AUTHENTICATED ROUTE

**Run this whenever a route sends a header other than `Content-Type`.**

```bash
curl -sS -i -X OPTIONS https://stripe-payments.felipe-b80.workers.dev/<route> \
  -H 'Origin: https://www.freightandlogistics.ai' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type' \
  | grep -i '^access-control-'
```

**Pass:** `access-control-allow-headers` names EVERY header the client sends — for the
`/ach-link/*` and `/payment/abandon` routes that means both `Content-Type` AND `Authorization`.

**Why this and not `curl -X POST`:** curl does not enforce CORS. A POST probe returning 401 proves
the route exists and proves NOTHING about whether a browser can reach it. On 2026-09-14 all four new
routes answered 401 to curl while every real browser was blocked — preflight 200, POST refused,
0 bytes transferred, "Failed to fetch" in the panel. `Access-Control-Allow-Headers` said
`Content-Type` and the routes sent `Authorization`.

**A check that cannot fail the way production fails is worse than no check: it manufactures
confidence.** That is what the POST probe did.

`evals/ach-bank-link.test.js` now asserts the same relationship statically (every header
`portal.html` sends appears in the Worker's Allow-Headers, and any route gating on `primusIdentity`
implies `Authorization` is permitted), so it fails before a deploy rather than after. Run the eval
AND this probe — the eval covers headers only, not origins, methods, or credentialed-request rules.

---

## 2. Route existence

```bash
for r in ach-link/status ach-link/start ach-link/pending payment/abandon; do
  printf '%-22s ' "/$r"
  curl -sS -o /dev/null -X POST "https://stripe-payments.felipe-b80.workers.dev/$r" \
    -H 'Content-Type: application/json' -d '{}' -w 'HTTP_STATUS=%{http_code}\n'
done
curl -sS -o /dev/null -X POST https://stripe-payments.felipe-b80.workers.dev/unknown-route \
  -H 'Content-Type: application/json' -d '{}' -w 'unknown-route HTTP_STATUS=%{http_code}\n'
```

**Pass:** 401 on authenticated routes (the identity gate refusing), 400 on unauthenticated ones,
**404 on `/unknown-route`**. Probe the unknown route too — without it a 401 could be a permissive
fallback rather than a real handler. This says the route EXISTS. It does not say a browser can call
it; that is §1.

---

## 3. Bundle drift

```bash
ACCT=b800adf3aeb0eb8ecbf33032450a24a2
TOK=$(python3 -c "import re;print(re.search(r'oauth_token\s*=\s*\"([^\"]+)\"',open('$HOME/Library/Preferences/.wrangler/config/default.toml').read()).group(1))")
curl -sS -H "Authorization: Bearer $TOK" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/stripe-payments" -o /tmp/dep.raw
python3 - <<'PY'
raw=open('/tmp/dep.raw','rb').read()
b=raw.split(b'\r\n',1)[0].strip()          # boundary from the response, never hardcoded
for p in raw.split(b):
    if b'name="index.js"' in p:
        open('/tmp/dep.js','wb').write(p.split(b'\r\n\r\n',1)[1].rstrip(b'\r\n-'))
PY
cd ~/freight-portal/stripe-payments && npx wrangler deploy --dry-run --outdir /tmp/repo
diff /tmp/dep.js /tmp/repo/index.js
```

**Pass:** the ONLY difference is the missing trailing newline after `//# sourceMappingURL=index.js.map`
— the API strips it on every pull. The shasums therefore DIFFER; that is expected. `diff` is
authoritative, not shasum equality. To prove it:
`printf '%s' "$(cat /tmp/repo/index.js)" > /tmp/t.js && cmp /tmp/t.js /tmp/dep.js`

Compare bundle-to-bundle. Do NOT de-bundle the deployed script by regex — it invents differences.

**Blind spot:** config that changes runtime without changing the bundle (`compatibility_date`,
service-binding `environment`). Read those from the API, not from the toml.

---

## 4. Pages, after the Worker passes

```bash
for u in https://www.freightandlogistics.ai/portal.html \
         https://freight-portal.pages.dev/portal.html \
         https://felipeliberman.github.io/freight-portal/portal.html; do
  curl -sSL -H 'Cache-Control: no-cache' "$u?cb=$(date +%s)$RANDOM" -o /tmp/p.html
  echo "$u  $(shasum -a 256 /tmp/p.html | cut -c1-16)"
done
shasum -a 256 ~/freight-portal/portal.html | cut -c1-16
```

**Pass:** all three match local. `github.io` is the legacy GitHub Pages mirror and trails Cloudflare
Pages by 10–30 seconds — re-poll, do not call an early mismatch a failure.

Add a grep for whatever the change introduced, and one for what it removed. The removal check is the
load-bearing one: it proves no browser is still served the old path.

---

## 5. Rollback

```bash
# Pages FIRST: dashboard -> Workers & Pages -> freight-portal -> Deployments -> Rollback. <1 min.
# Worker SECOND:
cd ~/freight-portal/stripe-payments
npx wrangler rollback <version-id> -m "reason"
```
Seconds to take effect — it re-points at an existing version, no rebuild.

Find the live version and its predecessor:
```bash
curl -sS -H "Authorization: Bearer $TOK" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCT/workers/scripts/stripe-payments/deployments"
```

**Not undone by a rollback:** KV keys (`achlink:`, `payguard:inv:`, `qbo:posted:`) and any Stripe
objects created. KV is inert under older code that never reads those prefixes. List with
`npx wrangler kv key list --remote --namespace-id <id> --prefix <p>` — `--remote` is required,
wrangler v4 defaults to the LOCAL store.
