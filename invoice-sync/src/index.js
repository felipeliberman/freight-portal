// invoice-sync — Primus → Stripe invoice sync.
// Spec: ops/SPEC-primus-stripe-invoice-sync.md
//
// Build state: spec phases 1-3 complete (scaffold, mode-aware config, Primus auth + token cache,
// D1 ledger + idempotency layers, windowed invoice poll with pagination + allowlist + claim).
// Phases 4+ (customer resolution, mapping, draft creation, reconcile) are NOT built — a run claims
// ledger rows in 'intent' and stops before any detail fetch or Stripe call.

import { loadConfig, checkArCode } from './config.js';
import { PrimusClient } from './primus.js';
import { Ledger } from './ledger.js';
import { windowFor, pollWindow } from './invoices.js';

const LEASE_NAME = 'sync';
const LEASE_TTL_MS = 10 * 60 * 1000;

export default {
  async fetch(request) {
    // Deliberately minimal. This worker holds Stripe write credentials and runs unattended; it
    // has no reason to expose a request surface beyond a liveness probe. /health reports nothing
    // about mode, counts, or configuration.
    const { pathname } = new URL(request.url);
    if (pathname === '/health') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
};

export async function run(env) {
  // Resolve everything up front so a misconfiguration fails on line one rather than midway
  // through a window, holding a lease, with invoices half-processed.
  const cfg = loadConfig(env);
  const ledger = new Ledger(cfg.db, cfg.mode);
  const runId = crypto.randomUUID();

  if (!cfg.stripeRestricted) {
    // Not fatal — but an unattended cron holding an unrestricted secret key is a standing risk,
    // and this is the only place anyone would notice.
    console.warn('[invoice-sync] Stripe key is NOT a restricted key (rk_). Expected invoice-write + customer-read only.');
  }

  const acquired = await ledger.acquireLease(LEASE_NAME, runId, LEASE_TTL_MS);
  if (!acquired) {
    console.log(JSON.stringify({ evt: 'run.skipped', reason: 'lease_held', mode: cfg.mode }));
    return { skipped: true };
  }

  try {
    const primus = new PrimusClient(cfg.primus, cfg.db);
    const days = clampWindowDays(env.POLL_WINDOW_DAYS);
    const { issuedFrom, issuedTo } = windowFor(Date.now(), days);

    const summary = await pollWindow({
      primus, ledger,
      allowlist: cfg.arAllowlist,
      checkArCode,
      issuedFrom, issuedTo,
    });

    console.log(JSON.stringify({
      evt: 'run.ok', mode: cfg.mode, runId, windowDays: days, ...summary,
      note: 'phases 4+ not built; rows claimed as intent, nothing written to Stripe',
    }));

    // Conditions the summary alone would let someone scroll past. Each one means the window is
    // not covering what it is supposed to cover.
    if (summary.shortfall) {
      console.warn(`[invoice-sync] shortfall: Primus reported ${summary.totalResults} results, poll saw ${summary.unique} unique`);
    }
    if (summary.hitPageCap) console.warn('[invoice-sync] hit the pagination cap — window may be truncated');
    if (summary.nearMiss) console.warn(`[invoice-sync] ${summary.nearMiss} ARCode near-miss(es) — check AR_ALLOWLIST for a typo`);

    return { ok: true, mode: cfg.mode, ...summary };
  } catch (err) {
    // Never embed an upstream response body in a log line (spec §6.3) — the Primus client already
    // strips them, and this must not undo that.
    console.error(JSON.stringify({ evt: 'run.failed', mode: cfg.mode, runId, error: String(err && err.message || err) }));
    throw err;
  } finally {
    await ledger.releaseLease(LEASE_NAME, runId);
  }
}

/**
 * The overlapping window is what absorbs page-shift skips (spec §3), so a too-narrow value
 * quietly defeats the design. Floor at 2 days; cap so a fat-fingered value can't sweep a year.
 */
function clampWindowDays(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 7;
  return Math.min(90, Math.max(2, Math.floor(n)));
}
