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
import { resolveClaimedCustomers } from './customers.js';
import { newValueSink, formatValueSink, formatEmailDrops } from './detail.js';
import { ConsoleSession } from './console-session.js';
import { loadSendConfig } from './send-guard.js';
import { runSendPass, formatSendReport } from './send-pass.js';

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
  const ledger = new Ledger(cfg.db, cfg.mode, cfg.arAllowlist);
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

    // Phase 4 — resolve customers for whatever is now claimed. One QBO search plus one detail
    // call per DISTINCT customer, never per invoice (spec §3.2 subrequest budget).
    const valueSink = newValueSink();
    const customers = await resolveClaimedCustomers({ primus, db: cfg.db, ledger, valueSink });

    // ── THE SEND PASS ───────────────────────────────────────────────────────────────────────
    //
    // A SECOND WALK OF THE SAME WINDOW, and that is deliberate. pollWindow claims every generated
    // invoice for the Stripe spine; this selects the far smaller set that is RED and not yet sent
    // by us. Merging them would couple the Stripe path to the email path — one of them changing
    // its filter would silently change the other. The cost is a handful of extra list pages
    // against a bound of one customer, which is the cheap side of that trade.
    //
    // The console session is constructed here but LOGS IN LAZILY, on its first lookup. A run with
    // no candidates therefore establishes no master console session at all.
    const sendConfig = loadSendConfig(env);
    const send = await runSendPass({
      primus, ledger,
      session: new ConsoleSession(cfg.primusConsole, cfg.db),
      sendConfig,
      allowlist: cfg.arAllowlist,
      checkArCode,
      issuedFrom, issuedTo,
      sendFromDate: env.SEND_FROM_DATE || null,
      cap: clampSendCap(env.SEND_CAP),
      // NO TRANSPORT. None exists in this package yet; `dryrun` needs none, and any mode that
      // sends will throw here until one is wired — which is the fail-closed direction.
      sink: valueSink,
    });

    const optionalNulls = formatValueSink(valueSink);
    const emailDrops = formatEmailDrops(valueSink);
    const quarantined = await ledger.openQuarantines(50);

    console.log(JSON.stringify({
      evt: 'run.ok', mode: cfg.mode, runId, windowDays: days, ...summary, customers,
      recordsAudited: valueSink.records,
      quarantined: quarantined.length,
      optionalNulls,
      emailDrops,
      send: { ...send, report: undefined, unresolvedDetail: undefined },
      note: 'phases 5+ not built; rows claimed as intent, nothing written to Stripe',
    }));

    // The report is logged as LINES rather than folded into the JSON above: it is the artefact a
    // human reads before anything is allowed to send, and one address per line is what makes it
    // readable. It carries recipient addresses on purpose — a redacted version cannot answer the
    // only question it exists to answer — and it goes to the run log, which is inside the private
    // boundary. It must not be forwarded anywhere else.
    for (const line of formatSendReport(send.report)) console.log('[send] ' + line);
    for (const u of send.unresolvedDetail) {
      console.warn(`[send] SKIPPED #${u.invoiceNumber} — ${u.reason}`);
    }
    if (send.dropped) {
      console.warn(`[invoice-sync] send cap ${send.cappedAt} reached — ${send.dropped} candidate(s) not processed this run`);
    }

    // A data gap is not an operational failure, but it is still an invoice nobody is billing.
    if (quarantined.length) {
      console.warn(`[invoice-sync] ${quarantined.length} invoice(s) quarantined on null required values`);
    }

    // Conditions the summary alone would let someone scroll past. Each one means the window is
    // not covering what it is supposed to cover.
    if (summary.shortfall) {
      console.warn(`[invoice-sync] shortfall: Primus reported ${summary.totalResults} results, poll saw ${summary.unique} unique`);
    }
    if (summary.hitPageCap) console.warn('[invoice-sync] hit the pagination cap — window may be truncated');
    if (summary.nearMiss) console.warn(`[invoice-sync] ${summary.nearMiss} ARCode near-miss(es) — check AR_ALLOWLIST for a typo`);
    // A dropped address means an invoice reaches one fewer person, with nothing else saying so.
    if (emailDrops.length) console.warn(`[invoice-sync] discarded email tokens — ${emailDrops.join(' | ')}`);

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

/**
 * How many invoices one run may email. Bounded blast radius, not a tuning knob.
 *
 * Defaults LOW on purpose: an unset value should mean "a handful", never "everything the window
 * holds". The upper clamp exists so a fat-fingered value cannot turn one tick into a mailout.
 */
function clampSendCap(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 25;
  return Math.min(200, Math.max(1, Math.floor(n)));
}
