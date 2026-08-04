// Spec phase 5 — the mapper. First code that could put data in front of a customer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStripeInvoice, classifyLine, customerVisibleNumber, assertPayloadClean,
  unverifiedRecipients, assertSendable, shortenForField,
} from '../src/mapper.js';
import { parseEmails } from '../src/customers.js';
import { newValueSink, formatEmailDrops } from '../src/detail.js';
import { narrowBooking } from '../src/booking.js';
import { narrowInvoiceDetail } from '../src/detail.js';
import { toCents } from '../src/invoices.js';
import { readdir, readFile } from 'node:fs/promises';

/** Narrowed booking for BOL 160133377, the invoice we map. */
const BOOKING = narrowBooking({ data: { results: {
  BOLNumber: '160133377', shipmentMode: 'LTL', totalWeight: 82, totalPieces: 1,
  freightInfo: [{ qty: 1, weight: 82, class: 70, commodity: 'rug', hazmat: false }],
  trackingInformation: { pickupDateEstimated: '2026-06-22', deliveryDateActual: '2026-07-09 00:00:00', lastStatusExternal: 'POD' },
  pickupInformation: { timeFrom: '09:00:00', timeTo: '14:00:00' },
  shipper: { name: 'Momeni Rugs', city: 'ADAIRSVILLE', state: 'GA' },
  consignee: { name: 'Megan Cappiello', city: 'BALDWIN PLACE', state: 'NY' },
  vendor: { name: 'Pilot Freight Services', serviceLevel: 'Hd basic - signature release', cost: 273.57 },
  accountingInformation: { GPActual: 9.74313, profitUSDActual: 29.32 },
} } });

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
  // On a PRIMARY the description folds onto the freight line; on a REBILL it moves to memo
  // context. Today it is only carried out unplaced.
  //
  // Folded as a BARE NAME — HOLD #5, spec §5.3. This assertion used to expect "Incl.", which
  // would have re-taught the held format to whoever eventually builds the §4.3 classifier. A todo
  // is still a specification of intent, so it has to carry the hold like any other.
  assert.match(payload.lines[0].description, /· LIFTGATE AT DESTINATION/);
  assert.doesNotMatch(payload.lines[0].description, /Incl\./, 'HELD: no "Incl." prefix');
});

test('§5.3 lane description: origin → destination, commodity, class, pickup date', () => {
  // Was a {todo} until the booking join existed. Now REAL — an inflated todo count stops being a
  // usable inventory of what is genuinely unbuilt.
  const { payload } = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER, { booking: BOOKING });
  assert.match(payload.lines[0].description,
    /LTL \u00b7 .+ \u2192 .+ \u00b7 .+ lbs \u00b7 Class /);
});

// ── the customer reference: fourth custom field ──────────────────────────────────────────────

test('the fourth slot is the CUSTOMER reference — Carrier took the third, not the fourth', () => {
  // The reference is the only field on the invoice that belongs to them rather than to us, and it
  // is what their AP matches on. Carrier displaced CONSIGNEE (2026-08-03), never this.
  const { payload } = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { customerReference: '129320', booking: BOOKING });
  const names = payload.invoice.custom_fields.map(f => f.name);
  assert.deepEqual(names, ['BOL #', 'PRO #', 'Carrier', 'Your Ref #']);
  assert.equal(payload.invoice.custom_fields[3].value, '129320');
  assert.ok(names.length <= 4, 'Stripe allows exactly four');
});

test('an absent customer reference drops the field rather than printing an empty one', () => {
  for (const ref of [null, undefined, '', '   ']) {
    const { payload } = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
      { customerReference: ref, booking: BOOKING });
    assert.deepEqual(payload.invoice.custom_fields.map(f => f.name), ['BOL #', 'PRO #', 'Carrier']);
    assert.ok(!payload.invoice.custom_fields.some(f => f.name === 'Your Ref #'));
  }
});

// ── recipient verification ───────────────────────────────────────────────────────────────────

test('an unverified recipient blocks SENDING, not building', () => {
  // The payload must still be reviewable; what must not happen is a send.
  const { payload } = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { verifiedRecipients: ['nickz@paylessrugs.com'] });
  assert.ok(payload, 'the payload is still built for review');
  assert.match(payload.send_blocked.reason, /unverified_recipient/);
  assert.ok(payload.send_blocked.all.some(b =>
    b.reason === 'unverified_recipient' && b.addresses.join() === 'ap@paylessrugs.com'));
  assert.throws(() => assertSendable(payload), /Refusing to send.*ap@paylessrugs\.com/);
});

test('every recipient verified clears the block', () => {
  // A dispute notice must also be supplied — §5.5 send-blocks without one, independently.
  const { payload } = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { disputeNotice: 'NOTICE', verifiedRecipients: ['nickz@paylessrugs.com', 'AP@PaylessRugs.com'] });
  assert.equal(payload.send_blocked, undefined);
  assert.doesNotThrow(() => assertSendable(payload));
});

test('verification FAILS CLOSED — no list means nothing is verified', () => {
  // "No list configured" must never read as "everyone is fine".
  for (const list of [null, undefined, []]) {
    const { payload } = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER, { verifiedRecipients: list });
    assert.match(payload.send_blocked.reason, /unverified_recipient/);
    const b = payload.send_blocked.all.find(x => x.reason === 'unverified_recipient');
    assert.deepEqual(b.addresses.sort(), ['ap@paylessrugs.com', 'nickz@paylessrugs.com']);
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

// ── §5.3 line description, footer, and the custom-field swap ────────────────────────────────

test('§5.3 renders the accepted lane shape, enriching the ONE existing line', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { customerReference: '129320', booking: BOOKING });
  assert.equal(r.payload.lines.length, 1, 'still a 1:1 mirror of invoiceBreakdown — nothing synthesized');
  assert.equal(r.payload.lines[0].description,
    'Freight \u2014 LTL \u00b7 Adairsville, GA \u2192 Baldwin Place, NY \u00b7 1 pc Rug \u00b7 82 lbs \u00b7 Class 70 \u00b7 PU 06/22/26');
});

test('the Primus line text leads, so the mirror stays visible', () => {
  const d = narrowInvoiceDetail(rawDetail({
    invoiceBreakdown: [{ code: '', description: 'FREIGHT CHARGE', qty: '1.00', rate: 300.93, total: 300.93 }],
  }));
  const r = buildStripeInvoice(d, CUSTOMER, { booking: BOOKING });
  assert.match(r.payload.lines[0].description, /^FREIGHT CHARGE \u2014 LTL/);
});

test('without a booking the description degrades to the Primus text alone', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER, { booking: null });
  assert.equal(r.payload.lines[0].description, 'Freight');
});

test('the description stays inside Stripe\'s 500-character limit', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER, { booking: BOOKING });
  assert.ok(r.payload.lines[0].description.length <= 500);
});

test('custom fields are BOL # · PRO # · Carrier · Your Ref #', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { customerReference: '129320', booking: BOOKING });
  assert.deepEqual(r.payload.invoice.custom_fields.map(f => f.name),
    ['BOL #', 'PRO #', 'Carrier', 'Your Ref #']);
  assert.equal(r.payload.invoice.custom_fields[2].value, 'Pilot Freight Services');
  assert.equal(r.payload.invoice.custom_fields[3].value, '129320');
  assert.ok(!r.payload.invoice.custom_fields.some(f => f.name === 'Consignee'), 'Consignee displaced by Carrier');
});

test('the consignee NAME survives in the footer — demoted, not omitted', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER, { booking: BOOKING });
  const f = r.payload.invoice.footer;
  assert.match(f, /Consignee: Megan Cappiello, Baldwin Place, NY/, 'name and place read as one thing');
  assert.match(f, /Carrier: Pilot Freight Services/);
  assert.match(f, /Service: Hd basic - signature release/);
  assert.match(f, /Pickup 06\/22\/26 09:00\u201314:00/);
  assert.match(f, /Delivered 07\/09\/26/);
  assert.match(f, /Shipper: Momeni Rugs, Adairsville, GA/);
});

test('NO booking margin data reaches the Stripe payload', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { customerReference: '129320', booking: BOOKING });
  const s = JSON.stringify(r.payload);
  for (const leak of ['273.57', '9.74313', '29.32', 'cost', 'GPActual', 'profitUSD', 'accountingInformation']) {
    assert.ok(!s.includes(leak), `payload leaked: ${leak}`);
  }
});

test('assertPayloadClean now also rejects the BOOKING hostile names', () => {
  assert.throws(() => assertPayloadClean({ invoice: { cost: 273.57 } }), /forbidden field/);
  assert.throws(() => assertPayloadClean({ a: { GPActual: 9.7 } }), /forbidden field/);
});

test('a multi-item booking aggregates on the invoice line', () => {
  const multi = narrowBooking({ data: { results: {
    BOLNumber: '160134786', shipmentMode: 'LTL', totalWeight: 176, totalPieces: 2,
    freightInfo: [{ qty: 1, weight: 64, class: 70, commodity: 'rug' },
                  { qty: 1, weight: 112, class: 85, commodity: 'rug' }],
    trackingInformation: { pickupDateEstimated: '2026-06-22' }, pickupInformation: {},
    shipper: { name: 'Momeni Rugs', city: 'ADAIRSVILLE', state: 'GA' },
    consignee: { name: 'A Customer', city: 'BALDWIN PLACE', state: 'NY' },
    vendor: { name: 'Pilot Freight Services', serviceLevel: 'x' },
  } } });
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER, { booking: multi });
  assert.match(r.payload.lines[0].description, /2 pcs Rug \u00b7 176 lbs \u00b7 Class 70, 85/);

  // THE POINT WHERE AGGREGATION AND FAITHFUL-MIRROR COULD DISAGREE: freightInfo has 2 items,
  // invoiceBreakdown has 1. The line count follows invoiceBreakdown, ALWAYS — freight items are
  // aggregated INTO the description, never expanded into extra lines.
  assert.equal(r.payload.lines.length, 1, 'lines follow invoiceBreakdown, not freightInfo');
  assert.equal(multi.freight.length, 2, 'while the booking genuinely has two freight items');
});

test('line count follows invoiceBreakdown even when it has MORE lines than freight items', () => {
  // The mirror is 1:1 with invoiceBreakdown in both directions.
  const d = narrowInvoiceDetail(rawDetail({
    invoiceBreakdown: [
      { code: '', description: 'FREIGHT CHARGE', qty: '1.00', rate: 200, total: 200 },
      { code: 'FSC', description: 'FUEL SURCHARGE', qty: '1.00', rate: 100.93, total: 100.93 },
    ],
  }));
  const r = buildStripeInvoice(d, CUSTOMER, { booking: BOOKING });
  assert.equal(r.payload.lines.length, 2);
  assert.equal(BOOKING.freight.length, 1, 'one freight item, two invoice lines');
  // Both lines carry the same shipment context — it describes the shipment, not the charge.
  for (const l of r.payload.lines) assert.match(l.description, /LTL \u00b7 Adairsville, GA/);
});

// ── §5.1 placement and §5.5 memo ─────────────────────────────────────────────────────────────

const ZERO_LINES = {
  invoiceBreakdown: [
    { code: '', description: 'FREIGHT CHARGE', qty: '1.00', rate: 300.93, total: 300.93 },
    { code: 'LFD', description: 'LIFTGATE AT DESTINATION', qty: '1.00', rate: 0, total: 0 },
  ],
};

test('§5.1 PRIMARY folds zero-dollar descriptions into the freight line', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail(ZERO_LINES)), CUSTOMER,
    { booking: BOOKING, classification: 'primary' });
  assert.equal(r.payload.lines.length, 1, 'still never a line');
  assert.match(r.payload.lines[0].description, /· LIFTGATE AT DESTINATION/);
  // HOLD #5 (spec §5.3) — the accessorial renders as a BARE NAME. "Incl." asserts it was included
  // at no charge, which is a commercial claim the owner has not made, and a later rebill of the
  // same accessorial would contradict it in writing on the customer's invoice.
  //
  // This assertion IS the hold. It previously asserted the prefix, which is how the held behaviour
  // drifted back into live rendered output on 2026-08-04 — the comment said one thing and the test
  // enforced the other. Do not relax it until the owner answers priced-or-included.
  assert.doesNotMatch(r.payload.lines[0].description, /Incl\./,
    'HELD: no "Incl." prefix — see spec §5.3 HOLD #5');
  assert.equal(r.payload.zero_dollar_placement, 'folded-into-line');
  assert.equal(r.payload.rebill_context, undefined);
});

test('carrier custom field: abbreviated to the portal\'s own name, never cut mid-word', () => {
  // Live 2026-08-04: "Metropolitan Warehouse & Deliv" reached rendered output — a chopped word.
  assert.equal(shortenForField('Metropolitan Warehouse & Delivery Corp'), 'Metro W&D');
  assert.equal(shortenForField('Metropolitan Warehouse and Delivery'), 'Metro W&D');
  // Short names pass through untouched.
  assert.equal(shortenForField('Estes Express'), 'Estes Express');
  assert.equal(shortenForField('Pilot Freight Services'), 'Pilot Freight Services');
  // No abbreviation available → word boundary + ellipsis, never a mid-word cut.
  const ORIGINAL = 'Some Extremely Long Carrier Name Incorporated';
  const long = shortenForField(ORIGINAL);
  assert.ok(long.length <= 30, `must fit the field: got ${long.length}`);
  assert.ok(long.endsWith('…'), 'ellipsis marks the truncation');
  const stem = long.slice(0, -1);
  assert.ok(ORIGINAL.startsWith(stem), 'the kept portion is a prefix of the original');
  // THE point of the fix: the character after the kept portion in the ORIGINAL is a space, i.e.
  // we stopped at a word boundary. ("Metropolitan Warehouse & Deliv" stopped mid-word.)
  assert.equal(ORIGINAL.charAt(stem.length), ' ', 'cut lands at a word boundary, not mid-word');
});

test('§5.1 REBILL moves them to memo context, never onto the line', () => {
  // On a rebill the customer is scrutinising the line list; a folded "includes" would read as part
  // of what they are being charged for now.
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail(ZERO_LINES)), CUSTOMER,
    { booking: BOOKING, classification: 'rebill' });
  assert.ok(!r.payload.lines[0].description.includes('Incl.'));
  assert.equal(r.payload.rebill_context, 'Originally billed: LIFTGATE AT DESTINATION');
  assert.equal(r.payload.zero_dollar_placement, 'memo-context');
});

test('§5.1 UNCLASSIFIED leaves them unplaced rather than guessing', () => {
  for (const c of [null, 'hold']) {
    const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail(ZERO_LINES)), CUSTOMER,
      { booking: BOOKING, classification: c });
    assert.equal(r.payload.zero_dollar_placement, 'unplaced');
    assert.ok(!r.payload.lines[0].description.includes('Incl.'));
    assert.equal(r.payload.rebill_context, undefined);
    assert.deepEqual(r.payload.zero_dollar_descriptions, ['LIFTGATE AT DESTINATION']);
  }
});

test('§5.5 a MISSING dispute notice send-blocks — it is a required element, not copy', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { booking: BOOKING, verifiedRecipients: ['nickz@paylessrugs.com', 'ap@paylessrugs.com'] });
  assert.ok(r.payload, 'still builds, so it can be read');
  assert.equal(r.payload.send_blocked.reason, 'missing_dispute_notice');
  assert.throws(() => assertSendable(r.payload), /Refusing to send/);
  assert.match(r.payload.invoice.description, /PENDING OWNER WORDING/,
    'the gap is visible in the rendered memo, not hidden');
});

test('§5.5 a supplied notice clears that block and leads the memo', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { booking: BOOKING, disputeNotice: 'Report discrepancies within 3 business days.',
      verifiedRecipients: ['nickz@paylessrugs.com', 'ap@paylessrugs.com'] });
  assert.equal(r.payload.send_blocked, undefined);
  assert.match(r.payload.invoice.description, /^Report discrepancies within 3 business days\./,
    'the notice LEADS — on any surface that truncates it must be what survives');
  assert.match(r.payload.invoice.description, /accounting@freightandlogistics\.ai/);
});

test('§5.5 an over-length memo send-blocks rather than being silently truncated', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { booking: BOOKING, disputeNotice: 'x'.repeat(600),
      verifiedRecipients: ['nickz@paylessrugs.com', 'ap@paylessrugs.com'] });
  assert.equal(r.payload.send_blocked.reason, 'memo_over_limit');
  assert.throws(() => assertSendable(r.payload));
});

test('the memo goes to invoice.description — email, PDF AND hosted page', () => {
  // The footer is PDF-only, which is why the dispute notice cannot live there.
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { booking: BOOKING, disputeNotice: 'NOTICE' });
  assert.equal(typeof r.payload.invoice.description, 'string');
  assert.ok(!r.payload.invoice.footer.includes('NOTICE'), 'not on the PDF-only surface');
});

test('EVERY send-blocker is reported, not just the last one', () => {
  // One overwritten field hides the others and makes clearing one look like clearing all.
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { booking: BOOKING, verifiedRecipients: [] });   // no notice AND no verified recipients
  assert.match(r.payload.send_blocked.reason, /unverified_recipient/);
  assert.match(r.payload.send_blocked.reason, /missing_dispute_notice/);
  assert.equal(r.payload.send_blocked.all.length, 2);
  assert.throws(() => assertSendable(r.payload));
});

// ── the fourth field is CONDITIONAL on classification ────────────────────────────────────────

test('a REBILL replaces Your Ref # with the Original Invoice pointer', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { booking: BOOKING, classification: 'rebill', primaryInvoiceNumber: 140061, customerReference: '129320' });
  const f = r.payload.invoice.custom_fields;
  assert.deepEqual(f.map(x => x.name), ['BOL #', 'PRO #', 'Carrier', 'Original Invoice']);
  assert.equal(f[3].value, '140061');
  assert.ok(!f.some(x => x.name === 'Your Ref #'), 'Your Ref # is duplicated from the primary');
});

test('a PRIMARY keeps Your Ref # — swapping it there would lose it for nothing', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { booking: BOOKING, classification: 'primary', primaryInvoiceNumber: null, customerReference: '129320' });
  const f = r.payload.invoice.custom_fields;
  assert.deepEqual(f.map(x => x.name), ['BOL #', 'PRO #', 'Carrier', 'Your Ref #']);
  assert.equal(f[3].value, '129320');
});

test('NEGATIVE: a rebill with NO derivable original OMITS the pointer, never guesses', () => {
  // Chosen over quarantine: the invoice is otherwise complete and correct, and withholding a valid
  // bill over a pointer field would be worse than shipping it without one.
  for (const n of [null, undefined, '', '   ']) {
    const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
      { booking: BOOKING, classification: 'rebill', primaryInvoiceNumber: n, customerReference: '129320' });
    const f = r.payload.invoice.custom_fields;
    assert.ok(!f.some(x => x.name === 'Original Invoice'), `${JSON.stringify(n)} must not render a pointer`);
    assert.equal(f[3].name, 'Your Ref #', 'falls back rather than leaving an empty slot');
    assert.equal(r.ok, true, 'and the invoice still builds');
  }
});

test('an UNCLASSIFIED invoice keeps Your Ref # — the pointer is rebill-only', () => {
  for (const c of [null, 'hold', 'primary']) {
    const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
      { booking: BOOKING, classification: c, primaryInvoiceNumber: 140061, customerReference: '129320' });
    assert.ok(!r.payload.invoice.custom_fields.some(x => x.name === 'Original Invoice'),
      `classification ${c} must not render a pointer even when one is supplied`);
  }
});

test('the pointer is normalised like any customer-visible number', () => {
  const r = buildStripeInvoice(narrowInvoiceDetail(rawDetail()), CUSTOMER,
    { booking: BOOKING, classification: 'rebill', primaryInvoiceNumber: '140061.0' });
  assert.equal(r.payload.invoice.custom_fields[3].value, '140061');
});
