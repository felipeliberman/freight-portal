#!/usr/bin/env node
//
// LIVE RECIPIENT CHECK — run on purpose, never by the suite.
//
//     node invoice-sync/check-live-recipient.mjs                 # AR 1234, July 2026
//     node invoice-sync/check-live-recipient.mjs 2395 2026-08-01 2026-08-16
//
// ── WHY THIS IS NOT A TEST ───────────────────────────────────────────────────────────────────
//
// It talks to the live Primus REST API and the live master console. A check that goes red when
// Primus is having a bad morning is not a test — it is a flaky suite that teaches people to
// ignore red. The suite stays hermetic (every console and REST response in test/ is a stub); this
// script exists to confirm the stubs still describe reality, and it is run deliberately.
//
// ── WHAT IT DOES, AND WHAT IT CANNOT DO ──────────────────────────────────────────────────────
//
// READ-ONLY, END TO END, THROUGH THE REAL MODULES:
//
//     GET /invoice (window)  →  the first invoice carrying the ARCode
//     GET /invoice/{id}      →  customerInfo.customerId
//     console getShippingLocation + getAccounting  →  the customer record
//     recipient.js precedence →  the addresses and WHICH FIELD they came from
//
// IT SENDS NOTHING. There is no transport in this process: `invoice-sync` contains no SendGrid
// call at all, and this script imports only the read path. The one thing it proves that a stub
// cannot is that the shapes the tests assert are still the shapes Primus returns.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrimusClient } from './src/primus.js';
import { fetchInvoiceDetail } from './src/detail.js';
import { ConsoleSession } from './src/console-session.js';
import { InvoiceRecipients } from './src/invoice-recipient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── credentials ──────────────────────────────────────────────────────────────────────────────
// Env first, then .dev.vars (gitignored). Nothing is ever printed.

function loadVars() {
  const out = { ...process.env };
  try {
    for (const line of fs.readFileSync(path.join(HERE, '.dev.vars'), 'utf8').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i === -1) continue;
      const k = line.slice(0, i).trim();
      if (out[k]) continue;                                   // env wins
      out[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* env-only is fine */ }
  return out;
}

/**
 * The console credential is a SEPARATE secret by decision — it can write and delete shipping
 * locations, so it must be rotatable on its own. Locally it is usually not set, and the REST
 * credential is known to open a console session, so the script falls back — LOUDLY. A silent
 * fallback would let "the console secret works" go untested forever.
 */
function consoleCreds(v) {
  if (v.PRIMUS_CONSOLE_USER && v.PRIMUS_CONSOLE_PASS) {
    return { username: v.PRIMUS_CONSOLE_USER, password: v.PRIMUS_CONSOLE_PASS, via: 'PRIMUS_CONSOLE_USER' };
  }
  if (v.PRIMUS_USER && v.PRIMUS_PASS) {
    console.log('⚠  PRIMUS_CONSOLE_USER/PASS not set — falling back to the REST credential.');
    console.log('   That credential does open a console session, but the separate secret is the');
    console.log('   one production will hold, and this run does not exercise it.\n');
    return { username: v.PRIMUS_USER, password: v.PRIMUS_PASS, via: 'PRIMUS_USER (fallback)' };
  }
  throw new Error('No console credentials: set PRIMUS_CONSOLE_USER/PASS (or PRIMUS_USER/PASS).');
}

// ── a D1 stand-in ────────────────────────────────────────────────────────────────────────────
// ConsoleSession and PrimusClient cache their session/token in D1. Outside a Worker there is no
// D1, and this process is short-lived, so an in-memory map is the whole requirement. Deliberately
// NOT node:sqlite + schema.sql: this script must not be able to touch a real ledger.

function memoryDb() {
  const rows = new Map();
  const stmt = sql => ({
    args: [],
    bind(...a) { this.args = a; return this; },
    async first() {
      if (/FROM cache/i.test(sql)) {
        const r = rows.get(this.args[0]);
        return r ? { value: r.value, expires_at: r.expires_at } : null;
      }
      return null;
    },
    async run() {
      if (/INTO cache/i.test(sql)) rows.set(this.args[0], { value: this.args[1], expires_at: this.args[2] });
      return { success: true, meta: { changes: 1 } };
    },
    async all() { return { results: [] }; },
  });
  return { prepare: sql => stmt(sql) };
}

// ── the check ────────────────────────────────────────────────────────────────────────────────

const [, , argCode = '1234', argFrom = '2026-07-01', argTo = '2026-07-31'] = process.argv;
const MAX_PAGES = 30;

const vars = loadVars();
if (!vars.PRIMUS_USER || !vars.PRIMUS_PASS) throw new Error('Missing PRIMUS_USER / PRIMUS_PASS');

const db = memoryDb();
const primus = new PrimusClient(
  { username: vars.PRIMUS_USER, password: vars.PRIMUS_PASS, base: vars.PRIMUS_BASE || 'https://restapi.shipprimus.com/api/v1' },
  db
);

console.log(`Window ${argFrom} → ${argTo}, looking for ARCode ${argCode}\n`);

let row = null;
for (let page = 1; page <= MAX_PAGES && !row; page++) {
  const body = await primus.get('/invoice', { issuedFrom: argFrom, issuedTo: argTo, page, limit: 100 });
  const rows = (body && body.data && body.data.results) || [];
  row = rows.find(r => String(r.ARCode) === String(argCode)) || null;
  if (rows.length < 100) break;
}
if (!row) {
  console.log(`No invoice carrying ARCode ${argCode} in that window (scanned up to ${MAX_PAGES} pages).`);
  process.exit(1);
}

console.log(`invoice   #${row.invoiceNumber}  (id ${row.invoiceId})`);
console.log(`issued    ${row.issueDate}`);
console.log(`status    generated=${row.status?.generated}  sent=${row.status?.sent}  paid=${row.status?.paid}`
  + `   ${row.status?.generated && !row.status?.sent ? '← RED: a send candidate' : ''}`);

const detail = await fetchInvoiceDetail(primus, row.invoiceId);
console.log(`customer  customerInfo.customerId = ${detail.customerInfo?.customerId}`
  + `  (customerCode ${detail.customerInfo?.customerCode})\n`);

const creds = consoleCreds(vars);
const session = new ConsoleSession(creds, db);
// Wildcard bound ON PURPOSE: this is a read-only diagnostic and narrowing it here would make the
// script unable to check any customer but the pilot. Nothing it can do reaches a customer.
const recipients = new InvoiceRecipients(session, { all: true, codes: new Set() });

const result = await recipients.forInvoice(detail);

if (!result.ok) {
  console.log(`REFUSED  ${result.reason}`);
  console.log(`detail   ${JSON.stringify(result.detail)}`);
  process.exit(2);
}

console.log(`recipient        ${result.value.to.join(', ')}`);
console.log(`recipient_source ${result.value.source}`);
if (result.value.dropped.length) console.log(`dropped tokens   ${result.value.dropped.join(', ')}`);
console.log(`\nconsole credential via ${creds.via}`);
console.log('Nothing was sent — this process contains no transport.');
