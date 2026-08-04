// ARCode normalisation — the (mode, ar_code) join must hold, or the design it justifies is broken.
//
// THESE ARE RED BECAUSE A DEFECT REPRODUCES, not because the code is unbuilt. Run against
// 3fc5dad before normalizeArCode existed, they fail there.
//
// WHY THIS MATTERS MORE THAN IT LOOKS. There is deliberately NO stripe_customer_id column on
// `ledger`: the customer is one-to-many against invoices, so a copy would be N duplicates of one
// fact, and the adoption path would become a fan-out UPDATE. That argument is only sound if the
// read-time join actually resolves. It did not:
//
//   Ledger.claim            stored String(arCode)          -- raw
//   StripeCustomers.claim   stored String(arCode).trim()   -- trimmed, not uppercased
//   checkArCode / cache key / idempotency key / DisplayName match   -- .trim().toUpperCase()
//
// Five sites agreed on trim+uppercase and three did not, so the join held only for ARCodes that
// happen to be plain digits. Every ARCode seen so far — 5406, 1234, 2395 — is plain digits, which
// hid it completely. The code already anticipates alphanumeric codes; that is why checkArCode
// bothers to uppercase at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeArCode } from '../src/arcode.js';
import { Ledger } from '../src/ledger.js';
import { StripeCustomers } from '../src/stripe-customer.js';
import { checkArCode, loadArAllowlist } from '../src/config.js';
import { resolveCustomer } from '../src/customers.js';
import { freshDb } from './helpers.mjs';

// ── the function itself ──────────────────────────────────────────────────────────────────────

test('normalizeArCode is trim then uppercase, and nothing else', () => {
  assert.equal(normalizeArCode(' abc1 '), 'ABC1');
  assert.equal(normalizeArCode('ABC1'), 'ABC1');
  assert.equal(normalizeArCode('5406'), '5406');
  assert.equal(normalizeArCode(5406), '5406', 'numbers normalise like their string form');
  assert.equal(normalizeArCode(null), '');
  assert.equal(normalizeArCode(undefined), '');
});

test('EXCLUSION: leading zeros are PRESERVED — checkArCode uses that difference as a typo signal', () => {
  // config.js:139-142 reports `near_miss` when a code differs from an allowlist entry only by
  // leading zeros, because that is a config typo rather than a business fact. Folding zero-
  // stripping into normalisation would make them equal and DELETE the detection mechanism.
  assert.notEqual(normalizeArCode('0123'), normalizeArCode('123'));

  const allowlist = loadArAllowlist({ AR_ALLOWLIST: '123' });
  assert.deepEqual(checkArCode(allowlist, '0123'), { allowed: false, reason: 'near_miss' },
    'the typo signal must survive normalisation');
});

test('EXCLUSION: internal whitespace is PRESERVED — bad data must not be silently accepted', () => {
  // An ARCode with a space inside is junk, not a formatting variant. Leaving it distinct makes it
  // fail the allowlist, which is the correct direction. Consistency across the join is what
  // matters, not aggressiveness — both sides applying the SAME function agree regardless.
  assert.equal(normalizeArCode(' ab c1 '), 'AB C1');
  const allowlist = loadArAllowlist({ AR_ALLOWLIST: 'ABC1' });
  assert.equal(checkArCode(allowlist, ' ab c1 ').allowed, false);
});

// ── the join, which is the whole point ───────────────────────────────────────────────────────

test('REGRESSION: the (mode, ar_code) join resolves across whitespace and case', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const customers = new StripeCustomers(db, 'test');

  // The same customer, written through two different doors, spelled two different ways — which is
  // exactly what happens when one value comes off a Primus list and another off a config or a
  // hand-created dashboard record.
  await ledger.claim({ primusInvoiceId: 'I1', arCode: ' abc1 ' });
  const { row } = await customers.claim({ arCode: 'ABC1' });
  await customers.attach(row.id, 'cus_ABC1');

  const joined = db.rows(
    `SELECT l.primus_invoice_id AS inv, c.stripe_customer_id AS cus
       FROM ledger l LEFT JOIN stripe_customer c ON c.mode = l.mode AND c.ar_code = l.ar_code`
  );
  assert.equal(joined.length, 1);
  assert.equal(joined[0].cus, 'cus_ABC1',
    'a NULL here means the create path would refuse with no_stripe_customer for a customer that exists');
});

test('REGRESSION: one ARCode yields ONE stripe_customer row, however it is spelled', async () => {
  const customers = new StripeCustomers(freshDb(), 'test');

  const a = await customers.claim({ arCode: 'abc1' });
  const b = await customers.claim({ arCode: 'ABC1' });
  const c = await customers.claim({ arCode: ' Abc1 ' });

  assert.equal(a.claimed, true, 'first claim wins');
  assert.equal(b.claimed, false, 'a case variant is the SAME customer, not a second one');
  assert.equal(c.claimed, false, 'a whitespace variant likewise');
  assert.equal(b.row.id, a.row.id);
  assert.equal(c.row.id, a.row.id);

  // Why two rows would be worse than untidy: both variants share ONE idempotency key
  // (`test-primus-ar-ABC1`), so the second Stripe create returns the FIRST customer, attach binds
  // one id to two rows, and the partial unique index throws a raw UNIQUE error. A data quirk
  // surfaces as a mis-join alarm.
});

test('REGRESSION: idFor finds the customer regardless of how the caller spells the code', async () => {
  const customers = new StripeCustomers(freshDb(), 'test');
  const { row } = await customers.claim({ arCode: 'ABC1' });
  await customers.attach(row.id, 'cus_1');

  for (const spelling of ['ABC1', 'abc1', ' abc1 ', ' ABC1']) {
    assert.equal(await customers.idFor(spelling), 'cus_1', `idFor(${JSON.stringify(spelling)})`);
  }
});

test('the ledger stores the canonical form, so the column itself is join-ready', async () => {
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  await ledger.claim({ primusInvoiceId: 'I1', arCode: ' abc1 ' });
  assert.equal(db.rows('SELECT ar_code FROM ledger')[0].ar_code, 'ABC1');
});

test('a null ARCode still stores NULL, not an empty string', async () => {
  // claim() permits a null arCode — the poll only reaches it for allowlisted invoices, and
  // resolveClaimedCustomers filters on `ar_code IS NOT NULL`. Normalising null to '' would put a
  // row into that sweep that does not belong there.
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  await ledger.claim({ primusInvoiceId: 'I1', arCode: null });
  assert.equal(db.rows('SELECT ar_code FROM ledger')[0].ar_code, null);
});

test('a BLANK ARCode stores NULL, not an empty string', async () => {
  // '' would land the row in resolveClaimedCustomers' `ar_code IS NOT NULL` sweep, which would then
  // do a QBO lookup for the empty string. An empty ARCode is not an ARCode.
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  await ledger.claim({ primusInvoiceId: 'I1', arCode: '   ' });
  assert.equal(db.rows('SELECT ar_code FROM ledger')[0].ar_code, null);
});

// ── the deliberate loosening at customers.js:192 ─────────────────────────────────────────────

function fakeCustomerApi({ qboRows, detail }) {
  return {
    async get(path) {
      if (path === '/quickbooks/customers') return { data: { results: qboRows ?? [] } };
      if (path.startsWith('/invoice/')) return { data: detail };
      throw new Error(`unexpected path ${path}`);
    },
  };
}

test('DELIBERATE LOOSENING: the Primus cross-check compares the two endpoints on the same terms', async () => {
  // customers.js:192 refuses the join when the invoice LIST's ARCode and the invoice DETAIL's
  // customerInfo.customerCode disagree — the guard that exists because those two endpoints CAN
  // diverge (spec §3.1). It compared with .trim() only, so 'abc1' vs 'ABC1' read as a disagreement.
  //
  // This is a SAFETY check becoming slightly more permissive, taken as a decision by the owner
  // 2026-08-04, not as housekeeping: the trade is that a case variant now matches, in exchange for
  // the two endpoints being compared on the same terms as every other ARCode comparison.
  const db = freshDb();
  const ledger = new Ledger(db, 'test');
  const primus = fakeCustomerApi({
    qboRows: [{
      Id: '58', DisplayName: 'Acme-ABC1',
      PrimaryEmailAddr: { Address: 'ap@acme.com' },
      BillAddr: { Line1: '1 Main', City: 'LA', CountrySubDivisionCode: 'CA', PostalCode: '90001' },
    }],
    detail: {
      invoiceId: 1, invoiceNumber: 'INV-1', total: '10.00', invoiceDueDate: '2026-08-30',
      status: { generated: true, sent: false, paid: false },
      shipment: { BOLNumber: 'B1' },
      customerInfo: { customerId: 701567, customerCode: 'abc1', customerName: 'Acme' },
      invoiceBreakdown: [{ description: 'FREIGHT', total: '10.00' }],
    },
  });

  const r = await resolveCustomer({ primus, db, ledger, arCode: 'ABC1', sampleInvoiceId: '1' });
  assert.ok(r, 'a case difference between the two Primus endpoints is not a disagreement');
  assert.equal(r.primusCustomerId, 701567);

  // The guard itself must still fire on a REAL disagreement — the loosening is case, not meaning.
  const db2 = freshDb();
  const ledger2 = new Ledger(db2, 'test');
  const primus2 = fakeCustomerApi({
    qboRows: [{
      Id: '58', DisplayName: 'Acme-ABC1',
      PrimaryEmailAddr: { Address: 'ap@acme.com' },
      BillAddr: { Line1: '1 Main', City: 'LA', CountrySubDivisionCode: 'CA', PostalCode: '90001' },
    }],
    detail: {
      invoiceId: 1, invoiceNumber: 'INV-1', total: '10.00', invoiceDueDate: '2026-08-30',
      status: { generated: true, sent: false, paid: false },
      shipment: { BOLNumber: 'B1' },
      customerInfo: { customerId: 701567, customerCode: 'ZZZZ', customerName: 'Acme' },
      invoiceBreakdown: [{ description: 'FREIGHT', total: '10.00' }],
    },
  });
  assert.equal(await resolveCustomer({ primus: primus2, db: db2, ledger: ledger2, arCode: 'ABC1', sampleInvoiceId: '1' }), null,
    'a genuine disagreement must still fail closed');
});
