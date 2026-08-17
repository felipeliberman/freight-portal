// THE SEND GUARD — the stop over email egress.
//
// Email is the irreversible action in Phase 1. A Stripe draft can be deleted and a ledger row can
// be rewritten; a delivered email cannot be recalled, and the failure is silent — nobody reports
// receiving something they should not have. STOP 1 guards Stripe object creation and says nothing
// about this, so email needs its own stop, and this is it.
//
// ── BUILT BEFORE THE TRANSPORT, DELIBERATELY ─────────────────────────────────────────────────
//
// `invoice-sync` contains no SendGrid call at all (grepped 2026-08-17; the only hits in the whole
// package are comments). That is not an accident of sequencing — §8.869 is the record of STOP 1
// being believed to be two independent layers, "no key" AND "no code that calls Stripe", when it
// was only ever one, because the second was never checked. The guard lands first so that check is
// worth making, and a test asserts no mail endpoint has appeared in src/.
//
// The transport, when it exists, is INJECTED. This module constructs no request.
//
// ── WHICH TRANSPORT PIECE (d) BUILDS — decided 2026-08-17, so it is not re-argued ────────────
//
// A NEW DIRECT SendGrid call inside invoice-sync. NOT `sendgrid-proxy`, and the reasons are about
// that Worker rather than about preference:
//
//   * it has NO SOURCE IN THIS REPO — deploy-only and opaque, so nothing here could review or
//     test a change to it;
//   * it already carries two live callers on the portal's support path, plus an eval that fails
//     if `sendViaEmail` is deleted. It is load-bearing for a job it already does, and widening it
//     puts that job at risk;
//   * it has no reason to grow server-side PDF attachment support, which the invoice email needs.
//
// `stripe-payments` sets the precedent — its own direct `api.sendgrid.com` call — and
// wrangler.toml:8 says these Workers are not to be merged. A second direct caller follows that
// isolation rather than fighting it.
//
// ── TWO SWITCHES, AND WHY THEY ARE NOT THE STRIPE ONES ───────────────────────────────────────
//
// `SEND_MODE` + `ALLOW_LIVE_SEND`, mirroring `STRIPE_MODE` + `ALLOW_LIVE_MODE` in config.js —
// same pattern, SEPARATE PAIR. Sharing `ALLOW_LIVE_MODE` would put two unrelated irreversible
// actions behind one flag: flipping Stripe to live would arm customer email in the same edit,
// which is exactly the single-fat-fingered-var failure the two-switch shape exists to prevent.

import { refuse, allow, REFUSAL_REASONS } from './refusals.js';
import { businessDate } from './ledger.js';
import { VERIFIED_RECIPIENTS } from './mapper.js';

/** The closed set. 'off' is deliberately absent — `dryrun` is the off switch, and it leaves a record. */
export const SEND_MODES = Object.freeze(['dryrun', 'internal', 'live']);

/** Modes in which the customer's own address may appear in an envelope. Exactly one. */
const LIVE_MODES = Object.freeze(new Set(['live']));

/**
 * Resolve the send mode. Explicit only — never inferred from the presence of a key, an
 * environment name, or anything else that can drift.
 */
export function resolveSendMode(env) {
  const mode = String((env && env.SEND_MODE) || '').trim();
  if (!SEND_MODES.includes(mode)) {
    throw new Error(
      `SEND_MODE must be exactly one of ${SEND_MODES.join(', ')} (got ` +
      `${JSON.stringify(env && env.SEND_MODE)}). It is never defaulted: an unset value meaning ` +
      `"don't send" would make an accidental deploy silent, and meaning "send" would be worse.`
    );
  }
  if (mode === 'live' && String((env && env.ALLOW_LIVE_SEND) || '').trim() !== 'true') {
    throw new Error(
      `SEND_MODE='live' requires ALLOW_LIVE_SEND='true' as a second, deliberate switch.\n\n` +
      `NOTE: this is NOT ALLOW_LIVE_MODE, which gates Stripe. They are separate on purpose — one ` +
      `flag arming two irreversible actions is the mistake the two-switch pattern exists to stop.`
    );
  }
  return mode;
}

/** Deliberately strict: a value without an `@` and a dotted domain is a typo, not a configuration. */
function isAddress(v) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(String(v || '').trim());
}

/**
 * Resolve everything the guard needs, failing on line one rather than midway through a run.
 *
 * @returns {{mode:string, internalAddress:string|null}}
 */
export function loadSendConfig(env) {
  const mode = resolveSendMode(env);
  const internalAddress = String((env && env.INTERNAL_SEND_ADDRESS) || '').trim();

  if (!LIVE_MODES.has(mode)) {
    if (!isAddress(internalAddress)) {
      throw new Error(
        `SEND_MODE='${mode}' requires INTERNAL_SEND_ADDRESS to be a real address (got ` +
        `${JSON.stringify(env && env.INTERNAL_SEND_ADDRESS)}). In a non-live mode every message is ` +
        `redirected there; without it there is nowhere for a redirected send to go, and the ` +
        `fallback anyone would reach for is the customer's own address.`
      );
    }
    // ── AND IT MUST BE A CLEARED RECIPIENT, not merely well-formed ────────────────────────────
    //
    // VERIFIED_RECIPIENTS is the set cleared to RECEIVE invoices (mapper.js — a record of an owner
    // decision, not the output of a process). A redirected message IS an invoice arriving at that
    // mailbox, so accepting any address-shaped string would be the C2 recipient-verification rule
    // holding for customers and not for us — and a typo in a config value would put real invoice
    // content somewhere nobody decided on, with the send log faithfully recording that it went.
    //
    // Case-insensitive: an address differing only in case is the same mailbox, and refusing it
    // would be a configuration failing for a reason nobody could see.
    const cleared = VERIFIED_RECIPIENTS.map(a => a.toLowerCase());
    if (!cleared.includes(internalAddress.toLowerCase())) {
      throw new Error(
        `INTERNAL_SEND_ADDRESS ${JSON.stringify(internalAddress)} is not in VERIFIED_RECIPIENTS ` +
        `(${VERIFIED_RECIPIENTS.join(', ')}). A redirected message is an invoice arriving at that ` +
        `mailbox, so it has to be an address cleared to receive one. Add it there deliberately — ` +
        `with the same scrutiny a customer's address would get — rather than widening this check.`
      );
    }
  }
  return { mode, internalAddress: internalAddress || null };
}

/**
 * What would actually be put on the wire, and what the send log should record about it.
 *
 * ── THE OVERRIDE, AND THE ONE COLUMN IT HAS TO SHARE ─────────────────────────────────────────
 *
 * `invoice_send.recipient` means "the address as sent", so in a redirected mode it holds the
 * INTERNAL address — anything else would make the log lie about where a message went. The real
 * source is not lost: it rides in `recipient_source` as `internal_override:<source>`, which keeps
 * both facts in the two columns that exist without inventing a third.
 *
 * @param {{mode:string, internalAddress:string|null}} cfg
 * @param {{to:string[], source:string}} recipient  a resolved recipient (invoice-recipient.js)
 */
export function envelopeFor(cfg, recipient) {
  if (LIVE_MODES.has(cfg.mode)) {
    return { to: [...recipient.to], recipientSource: recipient.source };
  }
  return {
    to: [cfg.internalAddress],
    recipientSource: `internal_override:${recipient.source}`,
  };
}

export class SendGuard {
  /**
   * @param {Ledger} ledger
   * @param {{mode:string, internalAddress:string|null}} cfg  from loadSendConfig
   * @param {{transport?:{send:Function}}} [opts]  injected; this module builds no request. A
   *   transport is not needed for `dryrun`, which never reaches one.
   */
  constructor(ledger, cfg, { transport = null } = {}) {
    this.ledger = ledger;
    this.cfg = cfg;
    this.transport = transport;
  }

  /**
   * Send one invoice, or decline to.
   *
   * @param {{row:object, recipient:{to:string[], source:string}, token?:string}} args
   *   `row` is a ledger row; `recipient` is what invoice-recipient.js resolved.
   * @returns {{ok:true, value:{sent:boolean, mode:string, to:string[]}}
   *          |{ok:false, reason:string, detail:object}}
   */
  async send({ row, recipient, token = null }) {
    // ── CLAIM BEFORE SEND ───────────────────────────────────────────────────────────────────
    // There is no UNIQUE constraint on invoice_send (a resend is legitimate), so this is the only
    // thing preventing a second delivery.
    if (row.first_sent_at != null) {
      return refuse(REFUSAL_REASONS.ALREADY_SENT, {
        primusInvoiceId: row.primus_invoice_id, firstSentAt: row.first_sent_at, reconciled: false,
      });
    }

    // The anchor can be missing on an invoice that WAS delivered: recordSend writes the log row
    // and then stamps, two writes with no transaction. Repair rather than re-send.
    const prior = await this.ledger.successfulSendFor(row.id);
    if (prior) {
      await this.ledger.markFirstSent(row.id, Number(prior.attempted_at) || Date.now());
      return refuse(REFUSAL_REASONS.ALREADY_SENT, {
        primusInvoiceId: row.primus_invoice_id, reconciled: true,
      });
    }

    const envelope = envelopeFor(this.cfg, recipient);

    // ── DRY RUN ─────────────────────────────────────────────────────────────────────────────
    // Records WHO WOULD HAVE BEEN EMAILED — the resolved address and its real source, not the
    // override — because the point of a dry run is a reviewable list of real recipients. Nothing
    // is sent, nothing is stamped, and the transport is not reached even when one is supplied.
    if (this.cfg.mode === 'dryrun') {
      await this.ledger.recordSend({
        ledgerId: row.id, primusInvoiceId: row.primus_invoice_id, token,
        recipient: recipient.to.join(', '), recipientSource: recipient.source,
        outcome: 'refused', error: 'dryrun: not sent',
      });
      return allow({ sent: false, mode: this.cfg.mode, to: [...recipient.to] });
    }

    if (!this.transport || typeof this.transport.send !== 'function') {
      // A misconfiguration, not a data condition: a caller able to handle this past an `if` is a
      // caller that can ship a sending mode with nothing to send through.
      throw new Error(
        `SEND_MODE='${this.cfg.mode}' requires a transport, and none was injected. Only 'dryrun' ` +
        `runs without one.`
      );
    }

    let result;
    try {
      result = await this.transport.send({ ...envelope, invoiceId: row.primus_invoice_id });
    } catch (err) {
      result = { ok: false, status: null, error: String((err && err.message) || err) };
    }

    if (!result || !result.ok) {
      await this.ledger.recordSend({
        ledgerId: row.id, primusInvoiceId: row.primus_invoice_id, token,
        recipient: envelope.to.join(', '), recipientSource: envelope.recipientSource,
        outcome: 'failed', provider: 'sendgrid',
        providerStatus: (result && result.status) ?? null,
        // Reason only, truncated — never an upstream body (spec §6.3).
        error: String((result && result.error) || 'send failed').slice(0, 300),
      });
      return refuse(REFUSAL_REASONS.SEND_FAILED, {
        primusInvoiceId: row.primus_invoice_id, status: (result && result.status) ?? null,
      });
    }

    // Success. recordSend stamps first_sent_at write-once as its own last act.
    await this.ledger.recordSend({
      ledgerId: row.id, primusInvoiceId: row.primus_invoice_id, token,
      recipient: envelope.to.join(', '), recipientSource: envelope.recipientSource,
      outcome: 'sent', provider: 'sendgrid',
      providerMessageId: result.messageId ?? null,
      providerStatus: result.status ?? null,
    });

    return allow({ sent: true, mode: this.cfg.mode, to: [...envelope.to] });
  }
}

/** Re-exported so a caller stamping its own row uses the same zone rule. */
export { businessDate };
