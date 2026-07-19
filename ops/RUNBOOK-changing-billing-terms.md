# Runbook — Changing a customer's billing terms

> **INTERNAL OPS DOC — not customer-facing.** Kept in `ops/` (blocked by the Cloudflare
> Pages middleware allowlist and excluded from the Jekyll build) and NOT in `KNOWLEDGE.md`
> (which is compiled into the customer-facing agent KB). Do not move this into `docs/` or
> `KNOWLEDGE.md` — both are served/surfaced.

**The portal resolves billing terms live at login and caches them for only ~60 seconds.** A change
you make in the ShipPrimus console is reflected automatically within about a minute — for granting
credit, changing a term, and reverting to Prepaid alike. **There is no required manual step.**

> ⚠️ **The ~60s TTL is load-bearing — do not raise it.** This short TTL is the entire mechanism that
> makes terms self-heal from the console without a manual purge. It is set in `terms-proxy/src/index.js`
> as `TERMS_TTL_MS`. Raising it back up reintroduces exactly the staleness gap this was built to close:
> a console change would be invisible to the portal for the length of the TTL, and someone would again
> have to run a manual purge to force it. If console search load ever becomes a concern, address that
> directly (see the rate-limit note) rather than lengthening this TTL. 60s is also Cloudflare KV's
> minimum, so it cannot go lower while keeping KV expiry.

## Normal flow

1. Change the customer's billing terms in the ShipPrimus admin console customer record, and **save**.
2. That's it. Within ~60 seconds the portal reflects the change. If the customer is looking right now,
   have them **reload the page** after a minute (a plain reload re-resolves terms; an in-app click keeps
   the stale in-memory verdict from before the reload).

**What the customer sees after it takes effect:**
- **PREPAID** → the **Payment Method** tile appears, and **Apply for Credit** opens the application.
- **Credit terms (e.g. Net 15)** → no Payment Method tile, and **Apply for Credit** opens the
  "already have credit terms" confirmation.

---

## Troubleshooting — only if the portal and console DISAGREE for more than a couple of minutes

Everything below is a diagnostic/force-refresh tool. You should not need it in normal operation; reach
for it only when a change hasn't taken effect well past the ~60s window.

### Force-refresh a single customer immediately (optional)
Purges that customer's cached entry so the very next lookup re-resolves from the console. Key-scoped,
production — `--remote` is required or wrangler edits the empty local store and nothing happens.

```
cd terms-proxy && npx wrangler kv key delete <primusCustomerId> \
  --namespace-id e003ea3bb58b42718cc73c000a729b0a --remote
```

*You need the **primusCustomerId** (the cache key). Example (Haynes Brothers Furniture): primusCustomerId
`1123086640`, code `5300`, name `Haynes Brothers Furniture`.*

### Check what the portal is actually getting

- **Cached (what the portal sees), with `&id=`:**
  ```
  curl -sS "https://terms-proxy.felipe-b80.workers.dev/terms?code=<code>&name=<url-encoded company>&id=<primusCustomerId>"
  ```
- **Console truth, cache bypassed (no `&id=`):**
  ```
  curl -sS "https://terms-proxy.felipe-b80.workers.dev/terms?code=<code>&name=<url-encoded company>"
  ```

### If they still disagree, check in this order

1. **The console change did not save.** Symptom: the **cache-bypassed** read (no `&id=`) still shows the
   old terms with `"source":"live"`. Fix: redo the console edit and save.
2. **Force-refresh didn't hit production.** Symptom: you ran the purge but the cached (`&id=`) read is
   unchanged. Cause: missing `--remote` (wrangler v4 defaults to the local `.wrangler` store). Fix:
   re-run the purge **with `--remote`**.
3. **Wrong key or namespace.** Symptom: purge reports success but nothing changes. Cause: the key must be
   the **primusCustomerId** (NOT billToCode/accountingId), namespace `e003ea3bb58b42718cc73c000a729b0a`.
   Fix: `npx wrangler kv key get <primusCustomerId> --namespace-id e003ea3bb58b42718cc73c000a729b0a --remote`
   to confirm, then re-purge the right key.
4. **Console outage serving a stale value.** Symptom: cache-bypassed read errors or shows `"source":"cache-stale"`.
   Cause: the console is unreachable, so the proxy is serving the last cached verdict (≤60s old) until it
   expires. Fix: wait — once the console recovers, the next lookup self-heals; nothing to do.

---

**Rule of thumb:** always confirm the **cache-bypassed** read (no `&id=`) is correct *before* trusting the
cached (`&id=`) read — that isolates "the console didn't save" from "the cache is stale."
