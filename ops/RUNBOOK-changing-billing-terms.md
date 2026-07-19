# Runbook — Changing a customer's billing terms

> **INTERNAL OPS DOC — not customer-facing.** Kept in `ops/` (blocked by the Cloudflare
> Pages middleware allowlist and excluded from the Jekyll build) and NOT in `KNOWLEDGE.md`
> (which is compiled into the customer-facing agent KB). Do not move this into `docs/` or
> `KNOWLEDGE.md` — both are served/surfaced.

**The terms cache TTL is 4 hours.** If you skip the purge below, the portal keeps showing the
customer's OLD terms for up to **4 hours** — that is the worst case, not "until someone notices."

**The purge in Step 2 is MANDATORY on every terms change** — granting credit, changing a term,
**and reverting to Prepaid.** Reverting counts just as much as granting: a skipped purge on a
revert is exactly how a downgraded customer keeps seeing credit-only UI. Do the steps in order.

**You need:**
- **primusCustomerId** — the KV cache key.
- **billToCode / accountingId** and **company name** — for the verification lookup.

*Example (Haynes Brothers Furniture): primusCustomerId `1123086640`, code `5300`, name `Haynes Brothers Furniture`.*

---

## Steps — in this order

### 1. Console (do this first)
Change the customer's billing terms in the ShipPrimus admin console customer record, and **save**.

### 2. Purge the one cache key (MANDATORY)
Key-scoped, production. `--remote` is required — without it wrangler edits the empty local store and nothing changes.

```
cd terms-proxy && npx wrangler kv key delete <primusCustomerId> \
  --namespace-id e003ea3bb58b42718cc73c000a729b0a --remote
```

### 3. Verify (also repopulates the cache with the new value)
```
curl -sS "https://terms-proxy.felipe-b80.workers.dev/terms?code=<code>&name=<url-encoded company>&id=<primusCustomerId>"
```
Expect the **new** terms — e.g. `"termsCode":"PRE","isPrepaid":true` after reverting to Prepaid, or
`"termsCode":"NET15"` after granting Net 15.

### 4. Confirm in the portal
**A reload is enough — no logout needed.** Reload re-runs login-from-session and re-resolves terms;
a plain in-app click keeps the stale in-memory verdict, so do a full page reload.
- **PREPAID** → the **Payment Method** tile appears, and **Apply for Credit** opens the application.
- **Credit terms** → no Payment Method tile, and **Apply for Credit** opens the "already have credit terms" confirmation.

---

## Troubleshooting — the verification curl (Step 3) still returns the OLD value

Check in this order (most common first):

1. **Purge ran against the local store, not production.**
   Symptom: the delete "succeeded" but the value is unchanged.
   Cause: missing `--remote` (wrangler v4 defaults to the local `.wrangler` store).
   Fix: re-run Step 2 **with `--remote`**.

2. **Wrong key or namespace id.**
   Symptom: delete reports success but nothing changed, or the key you read differs from the one you purged.
   Cause: the key must be the **primusCustomerId** (NOT billToCode/accountingId), and the namespace must be `e003ea3bb58b42718cc73c000a729b0a`.
   Fix: confirm the key — `npx wrangler kv key get <primusCustomerId> --namespace-id e003ea3bb58b42718cc73c000a729b0a --remote` — then re-purge the correct key.

3. **The console change did not save.**
   Symptom: the **cache-bypassed** read (no `&id=`) still shows the old terms:
   ```
   curl -sS "https://terms-proxy.felipe-b80.workers.dev/terms?code=<code>&name=<url-encoded company>"
   ```
   If this shows the OLD terms with `"source":"live"`, the console edit didn't persist.
   Fix: redo Step 1 in the console and save, then purge again (Step 2).

4. **Re-cached a stale console read between the change and the purge.**
   Symptom: the cache-bypassed read shows the NEW terms, but the cached (`&id=`) read shows the OLD one again.
   Cause: a lookup (someone logging in, or an earlier verify) repopulated the cache from the console **before** the console change actually saved — or you purged before saving.
   Fix: confirm console truth is correct (the no-`&id=` read above), then purge once more (Step 2) and re-resolve (Step 3 with `&id=`); this time the repopulate picks up the correct value.

---

**Rule of thumb:** always confirm the **cache-bypassed** read (no `&id=`) is correct *before* trusting the cached (`&id=`) read — that isolates "the console didn't save" from "the cache is stale."
