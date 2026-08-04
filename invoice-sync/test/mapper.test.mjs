// Spec phase 5 — the mapper. First code that could put data in front of a customer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStripeInvoice, classifyLine, customerVisibleNumber, assertPayloadClean,
  unverifiedRecipients, assertSendable,
} from '../src/mapper.js';
import { parseEmails } from '../src/customers.js';
import { newValueSink, formatEmailDrops } from '../src/detail.js';
import { narrowInvoiceDetail } from '../src/detail.js';
import { toCents } from '../src/invoices.js';

function rawDetail(over = {}) {
  return {
    data: {
      invoiceId: '1591052345',
      invoiceNumber: 140488,
      ARCode: '5406',
      total: 300.93,
      issueDate: '2026-07-15 09:12:00',
      invoiceDueDate: '2026-08-14',
      invoiceRemarks: 'Delivered to dock',
      status: { generated: true, sent: true, paid: false },
      shipment: { BOLNumber: '160133377', carrierPRO: 'PRO9', consigneeName: 'A Customer' },
      customerInfo: { customerId: 701567, customerName: 'Payless Rugs', customerCode: '5406' },
      // Live shape verified 2026-08-03: total/rate are numbers, qty is a STRING.
      invoiceBreakdown: [{ code: '', description: 'Freight', qty: '1.00', rate: 300.93, total: 300.93 }],

      costBreakdown: [{ code: 'CARRIER', description: 'DISCOUNT 94.00%', total: 41.2 }],
      payableBreakdown: [{ carrier: 'Some Carrier', amount: 41.2 }],
      profitSummary: { cost: 41.2, sell: 300.93, profit: 259.73, gpPercent: 86.3 },
      invoiceInternalRemarks: 'rebill customer, our cost was 41.20',
      ...over,
    },
  };
}

const CUSTOMER = {
  arCode: '5406',
  displayName: 'Payless Rugs-5406',
  primaryEmail: 'nickz@paylessrugs.com',
  ccEmails: ['ap@paylessrugs.com'],
  primusCustomerId: 701567,
};

const build = (over) => buildStripeInvoice(narrowInvoiceDetail(rawDetail(over)), CUSTOMER);

// ── the invoice number override ──────────────────────────────────────────────────────────────

test('the customer-visible number is the PRIMUS number, explicitly set', () => {
  // Without an explicit override Stripe assigns its own, and Payless AP cannot match it.
  const { payload } = build();
  assert.equal(payload.invoice.number, '140488');
  assert.equal(payload.invoice.metadata.primus_invoice_number, '140488');
});

test('a spurious trailing decimal is normalised off the customer-visible number', () => {
  // The ".0" seen earlier was OUR SQLite TEXT affinity, not Primus — but the invoice must not
  // render one regardless of where it came from.
  assert.equal(customerVisibleNumber('139875.0'), '139875');
  assert.equal(customerVisibleNumber(139875), '139875');
  assert.equal(customerVisibleNumber('140488.00'), '140488');
  assert.equal(customerVisibleNumber(null), null);
  assert.equal(customerVisibleNumber('  '), null);
});

test('metadata carries both ids so a later surprise costs a read, not a migration', () => {
  const { payload } = build();
  assert.equal(payload.customer_ref.metadata.ar_code, '5406');
  assert.equal(payload.customer_ref.metadata.primus_customer_id, '701567');
  assert.deepEqual(Object.keys(payload.invoice.metadata).sort(),
    ['ar_code', 'bol_number', 'primus_invoice_id', 'primus_invoice_number']);
});

// ── line amounts: toCents, integer cents, no float comparison ────────────────────────────────

test('line totals go through toCents and land as integer cents', () => {
  const { payload } = build();
  assert.equal(payload.lines.length, 1);
  assert.equal(payload.lines[0].amount_cents, 30093);
  assert.ok(Number.isInteger(payload.lines[0].amount_cents));
  assert.equal(payload.lines[0].description, 'Freight');
});

test('classifyLine routes through toCents — not documented in prose, actually on the path', () => {
  // The §5.1 mandate has to be executable, not written down. This is the assertion that it is.
  assert.equal(classifyLine({ total: 300.93 }).cents, toCents(300.93));
  assert.equal(classifyLine({ total: '1,234.56' }).cents, toCents('1,234.56'));
  assert.equal(classifyLine({ total: '1,234.56' }).cents, 123456);
});

test('a formatted zero is classified zero, not priced — the string coercion door', () => {
  // "$0.00" == 0 is FALSE. Without toCents this becomes a PRICED line on a customer's invoice.
  assert.equal('$0.00' == 0, false);
  assert.equal(classifyLine({ total: '$0.00' }).kind, 'zero');
  assert.equal(classifyLine({ total: '0.00' }).kind, 'zero');
  assert.equal(classifyLine({ total: 0 }).kind, 'zero');
});

test('a null total is unusable, never zero — the null coercion door', () => {
  assert.equal(null >= 0, true, 'the trap: null looks like zero under >=');
  assert.equal(classifyLine({ total: null }).kind, 'unusable');
  assert.equal(classifyLine({ total: undefined }).kind, 'unusable');
  assert.equal(classifyLine({}).kind, 'unusable');
});

test('an unparseable total is unusable, not silently zero', () => {
  const v = classifyLine({ total: 'ask accounting' });
  assert.equal(v.kind, 'unusable');
  assert.match(v.reason, /unparseable/);
});

test('a $0 line never becomes a Stripe line item', () => {
  // A printed "LIFTGATE — $0.00" contradicts you later if that accessorial gets rebilled.
  const { payload } = build({
    invoiceBreakdown: [
      { code: '', description: 'Freight', qty: '1.00', rate: 300.93, total: 300.93 },
      { code: 'LFD', description: 'LIFTGATE AT DESTINATION', qty: '1.00', rate: 0, total: 0 },
    ],
  });
  assert.equal(payload.lines.length, 1);
  assert.deepEqual(payload.zero_dollar_descriptions, ['LIFTGATE AT DESTINATION']);
  assert.ok(!JSON.stringify(payload.lines).includes('LIFTGATE'));
});

test('quantity is not taken from the string qty field', () => {
  // Primus qty is "1.00" (a string). The line amount is already the total, so quantity is 1 and
  // the string is never coerced into an arithmetic path.
  const { payload } = build();
  assert.equal(payload.lines[0].quantity, 1);
  assert.equal(typeof payload.lines[0].quantity, 'number');
});

// ── the required-value gate ──────────────────────────────────────────────────────────────────

test('an invoice with a null required value returns a quarantine verdict, not a payload', () => {
  const r = build({ invoiceNumber: null });
  assert.equal(r.ok, false);
  assert.equal(r.payload, undefined, 'no payload may exist for a quarantined invoice');
  assert.equal(r.quarantine.reason, 'null_required_value');
  assert.ok(r.quarantine.fields.includes('invoiceNumber'));
});

test('quarantine does not throw — one bad record must not stop the run', () => {
  assert.doesNotThrow(() => build({ total: null, invoiceNumber: null }));
});

test('the claimed ARCode gates the build — no fallback to the detail', async () => {
  // The authoritative ARCode is the one the LIST carried and the ledger stored. A detail-derived
  // value would be a second path that can disagree silently.
  const detail = narrowInvoiceDetail(rawDetail());
  for (const bad of [null, undefined, '', '   ']) {
    const r = buildStripeInvoice(detail, { ...CUSTOMER, arCode: bad });
    assert.equal(r.ok, false, `arCode ${JSON.stringify(bad)} must quarantine`);
    assert.equal(r.quarantine.reason, 'missing_claimed_ar_code');
    assert.equal(r.payload, undefined);
  }
});

test('the payload ar_code comes from the customer, never from the detail', () => {
  // Detail says 9999, ledger/claim says 5406. The claimed value must win everywhere.
  const detail = narrowInvoiceDetail(rawDetail({ ARCode: '9999' }));
  const { payload } = buildStripeInvoice(detail, CUSTOMER);
  assert.equal(payload.invoice.metadata.ar_code, '5406');
  assert.equal(payload.customer_ref.ar_code, '5406');
  assert.equal(payload.customer_ref.metadata.ar_code, '5406');
  assert.ok(!JSON.stringify(payload).includes('9999'));
});

test('an invoice whose detail carries no ARCode still builds', () => {
  const raw = rawDetail();
  delete raw.data.ARCode;
  const r = buildStripeInvoice(narrowInvoiceDetail(raw), CUSTOMER);
  assert.equal(r.ok, true);
  assert.equal(r.payload.invoice.metadata.ar_code, '5406');
});

// ── the banned-field assertion ───────────────────────────────────────────────────────────────

test('no banned field name survives into the payload', () => {
  const { payload } = build();
  const serialized = JSON.stringify(payload);
  for (const k of ['costBreakdown', 'payableBreakdown', 'profitSummary', 'invoiceInternalRemarks', '_sourceKeys']) {
    assert.ok(!serialized.includes(k), `payload carries ${k}`);
  }
});

test('no margin VALUE survives into the payload', () => {
  const serialized = JSON.stringify(build().payload);
  for (const leak of ['DISCOUNT 94.00%', '259.73', '86.3', 'our cost was', 'Some Carrier', '41.2']) {
    assert.ok(!serialized.includes(leak), `payload leaked: ${leak}`);
  }
});

test('assertPayloadClean THROWS rather than trusting the input was narrowed', () => {
  // The guard must not rely on §6.1 having run upstream — that assumption stops being true the day
  // someone passes a raw record in.
  assert.throws(() => assertPayloadClean({ invoice: { profitSummary: { gpPercent: 86.3 } } }),
    /forbidden field: \$\.invoice\.profitSummary/);
  assert.throws(() => assertPayloadClean({ a: { b: [{ _sourceKeys: '{x}' }] } }),
    /forbidden field/);
  assert.doesNotThrow(() => assertPayloadClean({ invoice: { number: '140488' } }));
});

// ── drafts only ──────────────────────────────────────────────────────────────────────────────

test('the invoice is a draft that never auto-advances', () => {
  const { payload } = build();
  assert.equal(payload.invoice.auto_advance, false);
  assert.equal(payload.invoice.collection_method, 'send_invoice');
});

test('the mapper holds no Stripe key and constructs no live object', async () => {
  // Structural: the module must not import a Stripe client or reference an API host.
  const src = await (await import('node:fs/promises')).readFile(
    new URL('../src/mapper.js', import.meta.url), 'utf8');
  assert.ok(!/api\.stripe\.com/.test(src));
  assert.ok(!/STRIPE_RK|STRIPE_SK/.test(src));
  assert.ok(!/from ['"]stripe['"]/.test(src));
});

// ── mandates still prose-only ────────────────────────────────────────────────────────────────
// These fail until the thing they describe is real. They are here so an unimplemented spec
// mandate is visible in test output rather than only in a document nobody re-reads.

test('§5.1 primary-vs-rebill fold: zero-dollar descriptions are placed, not just collected', { todo: 'needs the §4.3 classifier — not built' }, () => {
  const { payload } = build({
    invoiceBreakdown: [
      { code: '', description: 'Freight', qty: '1.00', rate: 300.93, total: 300.93 },
      { code: 'LFD', description: 'LIFTGATE AT DESTINATION', qty: '1.00', rate: 0, total: 0 },
    ],
  });
  // On a PRIMARY the description must be folded into the freight line's "Includes:" list; on a
  // REBILL it must move to memo context. Today it is only carried out unplaced.
  assert.match(payload.lines[0].description, /Incl\./);
});

test('§5.3 lane description: origin → destination, commodity, class, pickup date', { todo: 'needs the booking join — a separate §6.1 boundary, not built' }, () => {
  const { payload } = build();
  assert.match(payload.lines[0].description, /LTL · .+ → .+ · .+ lbs · Class /);
});

// ── the customer reference: fourth custom field ──────────────────────────────────────────────

test('the fourth custom field is the CUSTOMER reference, not carrier', () => {
  // The only thing on the invoice that belongs to them rather than to us, and what their AP
  // matches on. Carrier is ours and appears elsewhere.
  const { payload } = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { customerReference: '129320' });
  const names = payload.invoice.custom_fields.map(f => f.name);
  assert.deepEqual(names, ['BOL #', 'PRO #', 'Consignee', 'Your Ref #']);
  assert.equal(payload.invoice.custom_fields[3].value, '129320');
  assert.ok(names.length <= 4, 'Stripe allows exactly four');
});

test('an absent customer reference drops the field rather than printing an empty one', () => {
  for (const ref of [null, undefined, '', '   ']) {
    const { payload } = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER, { customerReference: ref });
    assert.equal(payload.invoice.custom_fields.length, 3);
    assert.ok(!payload.invoice.custom_fields.some(f => f.name === 'Your Ref #'));
  }
});

// ── recipient verification ───────────────────────────────────────────────────────────────────

test('an unverified recipient blocks SENDING, not building', () => {
  // The payload must still be reviewable; what must not happen is a send.
  const { payload } = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { verifiedRecipients: ['nickz@paylessrugs.com'] });
  assert.ok(payload, 'the payload is still built for review');
  assert.equal(payload.send_blocked.reason, 'unverified_recipient');
  assert.deepEqual(payload.send_blocked.addresses, ['ap@paylessrugs.com']);
  assert.throws(() => assertSendable(payload), /Refusing to send.*ap@paylessrugs\.com/);
});

test('every recipient verified clears the block', () => {
  const { payload } = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { verifiedRecipients: ['nickz@paylessrugs.com', 'AP@PaylessRugs.com'] });
  assert.equal(payload.send_blocked, undefined);
  assert.doesNotThrow(() => assertSendable(payload));
});

test('verification FAILS CLOSED — no list means nothing is verified', () => {
  // "No list configured" must never read as "everyone is fine".
  for (const list of [null, undefined, []]) {
    const { payload } = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER, { verifiedRecipients: list });
    assert.equal(payload.send_blocked.reason, 'unverified_recipient');
    assert.deepEqual(payload.send_blocked.addresses.sort(), ['ap@paylessrugs.com', 'nickz@paylessrugs.com']);
    assert.throws(() => assertSendable(payload));
  }
});

test('unverifiedRecipients matching is case-insensitive and whitespace-tolerant', () => {
  const ref = { email: ' Nickz@PaylessRugs.com ', cc: ['AP@paylessrugs.COM'] };
  assert.deepEqual(unverifiedRecipients(ref, ['nickz@paylessrugs.com', 'ap@paylessrugs.com']), []);
});

// ── parseEmails negative controls, against real QBO field shapes ─────────────────────────────
// Each shape currently either parses correctly or yields no recipient (→ quarantine). What must
// never happen is a plausible-looking WRONG address, which delivers successfully and looks perfect.

test('semicolon separators parse', () => {
  const e = parseEmails('nickz@paylessrugs.com; ap@paylessrugs.com');
  assert.equal(e.primary, 'nickz@paylessrugs.com');
  assert.deepEqual(e.cc, ['ap@paylessrugs.com']);
});

test('display-name form parses to the address, not the name', () => {
  const e = parseEmails('Nick Zerbe <nickz@paylessrugs.com>, AP <ap@paylessrugs.com>');
  assert.equal(e.primary, 'nickz@paylessrugs.com');
  assert.deepEqual(e.cc, ['ap@paylessrugs.com']);
});

test('a comma INSIDE a display name does not corrupt the result', () => {
  // Splits into "Zerbe" (no address, dropped) and "Nick <nickz@…>" (address extracted).
  const e = parseEmails('Zerbe, Nick <nickz@paylessrugs.com>, ap@paylessrugs.com');
  assert.equal(e.primary, 'nickz@paylessrugs.com');
  assert.deepEqual(e.cc, ['ap@paylessrugs.com']);
});

test('surrounding whitespace is trimmed', () => {
  const e = parseEmails('   nickz@paylessrugs.com  ,   ap@paylessrugs.com   ');
  assert.equal(e.primary, 'nickz@paylessrugs.com');
  assert.deepEqual(e.cc, ['ap@paylessrugs.com']);
});

test('a single address with no separator parses', () => {
  const e = parseEmails('nickz@paylessrugs.com');
  assert.equal(e.primary, 'nickz@paylessrugs.com');
  assert.deepEqual(e.cc, []);
});

test('duplicates are deduped case-insensitively, first position wins', () => {
  const e = parseEmails('nickz@paylessrugs.com, NICKZ@PAYLESSRUGS.COM, ap@paylessrugs.com');
  assert.equal(e.primary, 'nickz@paylessrugs.com');
  assert.deepEqual(e.cc, ['ap@paylessrugs.com'], 'the duplicate must not occupy a CC slot');
});

test('an empty or whitespace-only field yields NO recipient — quarantine, not a guess', () => {
  for (const v of [null, undefined, '', '   ', ' , ; ', ',,,']) {
    const e = parseEmails(v);
    assert.equal(e.primary, null, `${JSON.stringify(v)} must not produce a recipient`);
    assert.deepEqual(e.cc, []);
  }
});

test('junk that is not an address is dropped, never guessed at', () => {
  const e = parseEmails('Accounts Payable, see attached, ap@paylessrugs.com');
  assert.equal(e.primary, 'ap@paylessrugs.com');
  assert.deepEqual(e.cc, []);

  assert.equal(parseEmails('Accounts Payable Dept').primary, null, 'no address at all → nothing');
  assert.equal(parseEmails('nick@localhost').primary, null, 'no dotted domain → not a business address');
});

test('position is the ONLY signal — reordering silently changes who is invoiced', () => {
  // Pinned so the assumption is visible as behaviour, not just as a comment. Spec §5.6.
  const a = parseEmails('nickz@paylessrugs.com, ap@paylessrugs.com');
  const b = parseEmails('ap@paylessrugs.com, nickz@paylessrugs.com');
  assert.equal(a.primary, 'nickz@paylessrugs.com');
  assert.equal(b.primary, 'ap@paylessrugs.com');
  assert.notEqual(a.primary, b.primary);
});

// ── ENFORCEMENT: assertSendable must be on every send path ───────────────────────────────────
//
// "Any send path must call assertSendable()" was prose. Prose is what §5.1's toCents() mandate was
// before it became executable, and nobody writing the first real send path next week would know
// the rule existed. This is the enforcement.

import { readdir, readFile } from 'node:fs/promises';

/** Anything that could finalise, send, or otherwise make a Stripe invoice reachable. */
const SEND_SURFACE = [
  /api\.stripe\.com/,
  /\/invoices\/[^'"`]*\/(send|finalize|pay)/,
  /auto_advance\s*:\s*true/,
  /sendInvoice|finalizeInvoice|send_invoice_now/,
];

async function srcFiles() {
  const dir = new URL('../src/', import.meta.url);
  const names = await readdir(dir);
  const out = [];
  for (const n of names.filter(n => n.endsWith('.js'))) {
    out.push({ name: n, text: await readFile(new URL(n, dir), 'utf8') });
  }
  return out;
}

test('any file touching a Stripe send surface MUST call assertSendable', async () => {
  // Passes vacuously today because no send path exists. It fails the moment one is written
  // without the gate — which is the point.
  const offenders = [];
  for (const f of await srcFiles()) {
    const touchesSend = SEND_SURFACE.some(rx => rx.test(f.text));
    if (!touchesSend) continue;
    if (!/assertSendable\s*\(/.test(f.text)) offenders.push(f.name);
  }
  assert.deepEqual(offenders, [],
    `these files can send but never call assertSendable(): ${offenders.join(', ')}`);
});

test('assertSendable is exported and throws — the gate is real, not advisory', () => {
  assert.equal(typeof assertSendable, 'function');
  assert.throws(() => assertSendable({ send_blocked: { reason: 'unverified_recipient', addresses: ['x@y.com'] } }));
  assert.doesNotThrow(() => assertSendable({ invoice: { number: '1' } }));
});

test('no send path exists yet — this todo is the reminder that the gate is untested in anger',
  { todo: 'phase 6+ builds the first send path; it must call assertSendable and must not catch it' },
  async () => {
    const found = (await srcFiles()).filter(f => SEND_SURFACE.some(rx => rx.test(f.text)));
    assert.ok(found.length > 0, 'no send path exists yet');
  });

// ── email drops are counted, never silent ────────────────────────────────────────────────────

test('a dropped address is counted by reason, with its own denominator', () => {
  // "Dropped" and "never existed" must not look the same downstream: ap@paylessrugs (no TLD)
  // drops silently and the invoice quietly reaches one fewer person.
  const sink = newValueSink();
  parseEmails('nickz@paylessrugs.com, ap@paylessrugs', sink);      // second has no TLD
  parseEmails('accounts payable, ap@paylessrugs.com', sink);        // first has no @
  parseEmails('a@x.com, , b@x.com', sink);                          // empty token

  assert.equal(sink.emailParses, 3);
  assert.equal(sink.emailDrops.no_dotted_domain, 1);
  assert.equal(sink.emailDrops.no_at, 1);
  assert.equal(sink.emailDrops.empty, 1);

  const lines = formatEmailDrops(sink);
  assert.ok(lines.some(l => l.startsWith('email.dropped.no_dotted_domain: 1/3 (33.3%)')), lines.join(' | '));
});

test('duplicates are counted as drops too', () => {
  const sink = newValueSink();
  parseEmails('a@x.com, A@X.COM', sink);
  assert.equal(sink.emailDrops.duplicate, 1);
});

test('email drops do NOT share the invoice-record denominator', () => {
  // Drops happen once per customer resolution, not once per invoice. A shared denominator would
  // produce a rate that looks precise and means nothing.
  const sink = newValueSink();
  sink.records = 500;
  parseEmails('bad@nodomain', sink);
  assert.equal(sink.emailParses, 1);
  assert.ok(formatEmailDrops(sink).some(l => l.endsWith('1/1 (100.0%)')), formatEmailDrops(sink).join(' | '));
});

test('a clean field records a parse and no drops', () => {
  const sink = newValueSink();
  parseEmails('nickz@paylessrugs.com, ap@paylessrugs.com', sink);
  assert.equal(sink.emailParses, 1);
  assert.deepEqual(Object.keys(sink.emailDrops), []);
  assert.deepEqual(formatEmailDrops(sink), []);
});
