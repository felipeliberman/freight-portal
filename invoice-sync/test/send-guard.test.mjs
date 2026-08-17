// PIECE (b) — THE SEND GUARD (Phase 1, deliver-and-inform).
//
//     node --test invoice-sync/test/send-guard.test.mjs
//
// NO NETWORK, AND NO TRANSPORT ANYWHERE. `invoice-sync` contains no SendGrid call today (grepped
// 2026-08-17: the only hits in the whole package are comments), and this guard is deliberately
// built BEFORE one exists. §8.869 is the reason: STOP 1 was believed to be two independent layers
// — "no key" and "no code that calls Stripe" — and was actually one, because nobody had checked
// the second. The guard lands first so the check means something.
//
// ── WHAT THIS FILE DEFENDS ───────────────────────────────────────────────────────────────────
//
// Email egress is the irreversible action in Phase 1. A Stripe draft can be deleted; a delivered
// email cannot be recalled, and the failure is silent — the customer simply has it. Three ways
// that happens, one section each:
//
//   1. THE MODE IS WRONG          — unset, misspelt, or armed by a flag that governs something
//                                   else entirely (the Stripe switch)
//   2. THE RECIPIENT IS REAL      — a non-live run reaching an actual customer
//   3. THE SAME INVOICE GOES TWICE — no UNIQUE constraint protects this; the guard is all there is

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SEND_MODES, resolveSendMode, loadSendConfig, envelopeFor, SendGuard,
} from '../src/send-guard.js';
import { REFUSAL_REASONS } from '../src/refusals.js';
import { RECIPIENT_SOURCES } from '../src/recipient.js';
import { VERIFIED_RECIPIENTS } from '../src/mapper.js';
import { Ledger } from '../src/ledger.js';
import { ANY_AR, freshDb } from './helpers.mjs';

// NOT a literal. A redirected message is an invoice arriving at this mailbox, so the address has
// to be one CLEARED to receive invoices — and the tests take it from the same list the guard
// checks against, so a change to that list cannot leave these passing against a stale value.
const INTERNAL = VERIFIED_RECIPIENTS[0];
const CUSTOMER = 'accounting@bisoncommerce.com';

/** A resolved recipient, as InvoiceRecipients.forInvoice returns it. */
const resolved = (over = {}) => ({
  to: [CUSTOMER], source: RECIPIENT_SOURCES.BILLING_EMAIL, dropped: [],
  arCode: '2395', customerId: '123301', ...over,
});

const env = (over = {}) => ({
  SEND_MODE: 'dryrun', INTERNAL_SEND_ADDRESS: INTERNAL, ...over,
});

/** A transport double. Records calls; `fail` makes it behave like a rejected SendGrid request. */
function fakeTransport({ fail = null } = {}) {
  const calls = [];
  return {
    calls,
    async send(envelope) {
      calls.push(envelope);
      if (fail) return { ok: false, status: fail.status ?? 502, error: fail.error ?? 'upstream' };
      return { ok: true, status: 202, messageId: 'msg_abc123' };
    },
  };
}

async function seed(db, over = {}) {
  const ledger = new Ledger(db, 'test', ANY_AR);
  const { row } = await ledger.claim({
    primusInvoiceId: over.id || 'I1', primusInvoiceNumber: '141385',
    bolNumber: '160134043', arCode: '1234', totalCents: 100,
  });
  return { ledger, row };
}

const val = r => { assert.equal(r.ok, true, `expected success, got refusal ${r.reason}`); return r.value; };
const no = r => { assert.equal(r.ok, false, 'expected a refusal'); return r; };

// ── 1. THE MODE ──────────────────────────────────────────────────────────────────────────────

test('SEND_MODE is never defaulted — unset throws', () => {
  assert.throws(() => resolveSendMode({}), /SEND_MODE/);
  assert.throws(() => resolveSendMode({ SEND_MODE: '' }), /SEND_MODE/);
  assert.throws(() => resolveSendMode({ SEND_MODE: '   ' }), /SEND_MODE/);
});

test('an unknown or misspelt mode throws rather than falling back to something safe-looking', () => {
  for (const bad of ['DRYRUN', 'dry-run', 'test', 'off', 'production']) {
    assert.throws(() => resolveSendMode({ SEND_MODE: bad }), /SEND_MODE/, bad);
  }
});

test('the three modes are the closed set', () => {
  assert.deepEqual([...SEND_MODES], ['dryrun', 'internal', 'live']);
  assert.equal(resolveSendMode({ SEND_MODE: 'dryrun' }), 'dryrun');
  assert.equal(resolveSendMode({ SEND_MODE: 'internal' }), 'internal');
});

test('live requires a SECOND switch', () => {
  assert.throws(() => resolveSendMode({ SEND_MODE: 'live' }), /ALLOW_LIVE_SEND/);
  assert.throws(() => resolveSendMode({ SEND_MODE: 'live', ALLOW_LIVE_SEND: 'false' }), /ALLOW_LIVE_SEND/);
  assert.throws(() => resolveSendMode({ SEND_MODE: 'live', ALLOW_LIVE_SEND: '1' }), /ALLOW_LIVE_SEND/);
  assert.throws(() => resolveSendMode({ SEND_MODE: 'live', ALLOW_LIVE_SEND: 'TRUE' }), /ALLOW_LIVE_SEND/);
  assert.equal(resolveSendMode({ SEND_MODE: 'live', ALLOW_LIVE_SEND: 'true' }), 'live');
});

test('THE STRIPE SWITCH DOES NOT ARM EMAIL — the two are decoupled on purpose', () => {
  // ALLOW_LIVE_MODE gates Stripe (config.js). If email shared it, flipping Stripe to live would
  // silently arm customer email in the same edit — two irreversible actions behind one flag.
  assert.throws(() => resolveSendMode({ SEND_MODE: 'live', ALLOW_LIVE_MODE: 'true' }), /ALLOW_LIVE_SEND/);
  assert.equal(resolveSendMode({ SEND_MODE: 'dryrun', ALLOW_LIVE_MODE: 'true' }), 'dryrun');
});

test('ALLOW_LIVE_SEND on its own arms nothing', () => {
  assert.throws(() => resolveSendMode({ ALLOW_LIVE_SEND: 'true' }), /SEND_MODE/);
  assert.equal(resolveSendMode({ SEND_MODE: 'dryrun', ALLOW_LIVE_SEND: 'true' }), 'dryrun');
});

test('a non-live mode REQUIRES the internal address — there is nowhere else for it to go', () => {
  for (const mode of ['dryrun', 'internal']) {
    assert.throws(() => loadSendConfig({ SEND_MODE: mode }), /INTERNAL_SEND_ADDRESS/, mode);
    assert.throws(() => loadSendConfig({ SEND_MODE: mode, INTERNAL_SEND_ADDRESS: 'not-an-address' }),
      /INTERNAL_SEND_ADDRESS/, `${mode}: a value that is not an address is not a configuration`);
  }
  assert.equal(loadSendConfig(env()).internalAddress, INTERNAL);
});

test('THE INTERNAL ADDRESS MUST BE A CLEARED RECIPIENT, not merely address-shaped', () => {
  // VERIFIED_RECIPIENTS is the set cleared to RECEIVE invoices (mapper.js, owner assertion). A
  // redirected message IS an invoice arriving at that mailbox, so allowing any well-formed string
  // would be the recipient-verification rule holding for customers and not for us — and a typo in
  // a config value would send real invoice content somewhere nobody decided on.
  for (const mode of ['dryrun', 'internal']) {
    assert.throws(
      () => loadSendConfig({ SEND_MODE: mode, INTERNAL_SEND_ADDRESS: 'someone.else@example.com' }),
      /VERIFIED_RECIPIENTS/, `${mode}: an uncleared address must not be accepted`);
  }
});

test('the cleared address is accepted, and matching is case-insensitive', () => {
  assert.equal(loadSendConfig(env({ INTERNAL_SEND_ADDRESS: INTERNAL })).internalAddress, INTERNAL);
  const shouty = INTERNAL.toUpperCase();
  assert.equal(loadSendConfig(env({ INTERNAL_SEND_ADDRESS: shouty })).internalAddress, shouty,
    'an address differing only in case is the same mailbox');
});

test('LIVE mode needs no internal address at all — nothing is redirected', () => {
  const cfg = loadSendConfig({ SEND_MODE: 'live', ALLOW_LIVE_SEND: 'true' });
  assert.equal(cfg.internalAddress, null);
});

// ── 2. THE RECIPIENT ─────────────────────────────────────────────────────────────────────────

test('INTERNAL MODE REPLACES THE RECIPIENT — the customer address is not in the envelope', () => {
  const e = envelopeFor(loadSendConfig(env({ SEND_MODE: 'internal' })), resolved());
  assert.deepEqual(e.to, [INTERNAL]);
  assert.ok(!JSON.stringify(e.to).includes(CUSTOMER), 'the customer address reached the envelope');
});

test('the override RECORDS BOTH FACTS — who it went to, and what it would have been', () => {
  // `invoice_send.recipient` means "the address as sent", so it holds the internal one. The real
  // source is not lost: it rides in recipient_source, which is the column that answers "how did
  // this reach the wrong person".
  const e = envelopeFor(loadSendConfig(env({ SEND_MODE: 'internal' })), resolved());
  assert.equal(e.recipientSource, `internal_override:${RECIPIENT_SOURCES.BILLING_EMAIL}`);
});

test('LIVE mode uses the resolved recipient, every address of it', () => {
  const cfg = loadSendConfig({ SEND_MODE: 'live', ALLOW_LIVE_SEND: 'true' });
  const e = envelopeFor(cfg, resolved({ to: ['ap@x.com', 'ap2@x.com'] }));
  assert.deepEqual(e.to, ['ap@x.com', 'ap2@x.com']);
  assert.equal(e.recipientSource, RECIPIENT_SOURCES.BILLING_EMAIL);
});

// ── the guard ────────────────────────────────────────────────────────────────────────────────

test('DRY RUN: nothing is sent, and the row records who WOULD have received it', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  const transport = fakeTransport();
  const guard = new SendGuard(ledger, loadSendConfig(env()), { transport });

  const v = val(await guard.send({ row, recipient: resolved() }));

  assert.equal(v.sent, false);
  assert.equal(transport.calls.length, 0, 'DRY RUN CALLED THE TRANSPORT');

  const sends = db.rows('SELECT * FROM invoice_send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].outcome, 'refused');
  assert.equal(sends[0].recipient, CUSTOMER, 'the row must name who would have been emailed');
  assert.equal(sends[0].recipient_source, RECIPIENT_SOURCES.BILLING_EMAIL);

  const after = await ledger.get('I1');
  assert.equal(after.first_sent_at, null, 'a dry run must not consume the invoice');
});

test('a dry run needs no transport at all', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  const guard = new SendGuard(ledger, loadSendConfig(env()));   // no transport
  assert.equal(val(await guard.send({ row, recipient: resolved() })).sent, false);
});

test('INTERNAL: sends to the internal address, stamps first_sent_at', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  const transport = fakeTransport();
  const guard = new SendGuard(ledger, loadSendConfig(env({ SEND_MODE: 'internal' })), { transport });

  const v = val(await guard.send({ row, recipient: resolved() }));

  assert.equal(v.sent, true);
  assert.equal(transport.calls.length, 1);
  assert.deepEqual(transport.calls[0].to, [INTERNAL]);
  assert.ok(!JSON.stringify(transport.calls[0]).includes(CUSTOMER),
    'the customer address must not appear anywhere in a non-live envelope');

  const sends = db.rows('SELECT * FROM invoice_send');
  assert.equal(sends[0].outcome, 'sent');
  assert.equal(sends[0].recipient, INTERNAL);
  assert.equal(sends[0].recipient_source, `internal_override:${RECIPIENT_SOURCES.BILLING_EMAIL}`);
  assert.equal(sends[0].provider_message_id, 'msg_abc123');

  assert.ok((await ledger.get('I1')).first_sent_at > 0);
});

test('LIVE: the real recipient, and only with both switches', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  const transport = fakeTransport();
  const cfg = loadSendConfig({ SEND_MODE: 'live', ALLOW_LIVE_SEND: 'true' });
  await new SendGuard(ledger, cfg, { transport }).send({ row, recipient: resolved() });
  assert.deepEqual(transport.calls[0].to, [CUSTOMER]);
});

test('a mode that sends REQUIRES a transport — missing one throws, it is a misconfiguration', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  const guard = new SendGuard(ledger, loadSendConfig(env({ SEND_MODE: 'internal' })));
  await assert.rejects(() => guard.send({ row, recipient: resolved() }), /transport/i);
});

// ── 3. NEVER TWICE ───────────────────────────────────────────────────────────────────────────

test('AN INVOICE ALREADY SENT IS REFUSED — the transport is never reached', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  await ledger.markFirstSent(row.id);

  const transport = fakeTransport();
  const guard = new SendGuard(ledger, loadSendConfig(env({ SEND_MODE: 'internal' })), { transport });
  const r = no(await guard.send({ row: await ledger.get('I1'), recipient: resolved() }));

  assert.equal(r.reason, REFUSAL_REASONS.ALREADY_SENT);
  assert.equal(transport.calls.length, 0, 'a second send was attempted');
});

test('RECONCILIATION: a successful send whose stamp was lost RE-STAMPS, it does not re-send', async () => {
  // recordSend writes invoice_send and THEN stamps first_sent_at — two writes, no transaction. If
  // the stamp fails, the invoice looks unsent and the next run would email the customer twice.
  const db = freshDb();
  const { ledger, row } = await seed(db);

  // A delivered send whose stamp never landed.
  await ledger.recordSend({
    ledgerId: row.id, primusInvoiceId: 'I1', recipient: CUSTOMER,
    recipientSource: RECIPIENT_SOURCES.BILLING_EMAIL, outcome: 'sent', provider: 'sendgrid',
  });
  db.raw.prepare('UPDATE ledger SET first_sent_at = NULL WHERE id = ?').run(row.id);
  assert.equal((await ledger.get('I1')).first_sent_at, null, 'precondition');

  const transport = fakeTransport();
  const guard = new SendGuard(ledger, loadSendConfig(env({ SEND_MODE: 'internal' })), { transport });
  const r = no(await guard.send({ row: await ledger.get('I1'), recipient: resolved() }));

  assert.equal(r.reason, REFUSAL_REASONS.ALREADY_SENT);
  assert.equal(r.detail.reconciled, true, 'the refusal must say the anchor was repaired');
  assert.equal(transport.calls.length, 0, 'THE CUSTOMER WOULD HAVE BEEN EMAILED TWICE');
  assert.ok((await ledger.get('I1')).first_sent_at > 0, 'the anchor was not re-stamped');
});

test('a dry-run row is NOT a prior send — it must not block the real one', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  await new SendGuard(ledger, loadSendConfig(env()), {}).send({ row, recipient: resolved() });

  const transport = fakeTransport();
  const guard = new SendGuard(ledger, loadSendConfig(env({ SEND_MODE: 'internal' })), { transport });
  assert.equal(val(await guard.send({ row: await ledger.get('I1'), recipient: resolved() })).sent, true);
});

// ── failure ──────────────────────────────────────────────────────────────────────────────────

test('A FAILED SEND IS RECORDED AND RETRIABLE — the anchor stays null', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  const transport = fakeTransport({ fail: { status: 502, error: 'upstream' } });
  const guard = new SendGuard(ledger, loadSendConfig(env({ SEND_MODE: 'internal' })), { transport });

  const r = no(await guard.send({ row, recipient: resolved() }));
  assert.equal(r.reason, REFUSAL_REASONS.SEND_FAILED);

  const sends = db.rows('SELECT * FROM invoice_send');
  assert.equal(sends[0].outcome, 'failed');
  assert.equal(sends[0].provider_status, 502);
  assert.equal((await ledger.get('I1')).first_sent_at, null,
    'a failure must leave the invoice selectable next run');
});

test('a transport that throws is a failure, not an escape', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  const transport = { async send() { throw new Error('socket hang up'); } };
  const guard = new SendGuard(ledger, loadSendConfig(env({ SEND_MODE: 'internal' })), { transport });

  const r = no(await guard.send({ row, recipient: resolved() }));
  assert.equal(r.reason, REFUSAL_REASONS.SEND_FAILED);
  assert.equal(db.rows('SELECT * FROM invoice_send')[0].outcome, 'failed');
});

test('an upstream body never reaches the send log (spec §6.3)', async () => {
  const db = freshDb();
  const { ledger, row } = await seed(db);
  const transport = fakeTransport({ fail: { status: 400, error: 'UPSTREAM-BODY-MARKER '.repeat(40) } });
  await new SendGuard(ledger, loadSendConfig(env({ SEND_MODE: 'internal' })), { transport })
    .send({ row, recipient: resolved() });
  const err = db.rows('SELECT error FROM invoice_send')[0].error || '';
  assert.ok(err.length <= 300, 'the error column must be truncated');
});

// ── the structural guard ─────────────────────────────────────────────────────────────────────

test('NO TRANSPORT EXISTS IN invoice-sync — asserted, not assumed (§8.869)', () => {
  // STOP 1 was believed to be two layers and was one, because nobody checked the second. This is
  // that check, standing: the guard is armed before any code can send, and this fails the moment
  // a mail endpoint appears in src/ without being noticed.
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = join(here, '..', 'src');
  const offenders = [];
  for (const f of readdirSync(srcDir).filter(n => n.endsWith('.js'))) {
    const body = readFileSync(join(srcDir, f), 'utf8')
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))     // comments discuss SendGrid; code must not
      .join('\n');
    if (/api\.sendgrid\.com|\/v3\/mail\/send|sendgrid-proxy/.test(body)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `a mail transport appeared in src/: ${offenders.join(', ')}. The guard must be reviewed before it ships.`);
});
