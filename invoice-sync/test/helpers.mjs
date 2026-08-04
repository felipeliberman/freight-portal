// Shared test scaffolding: a D1-shaped adapter over node:sqlite, and a fake Primus list endpoint.
// Kept out of src/ so the worker carries no test-only code.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '..', 'schema.sql'), 'utf8');

class D1Stmt {
  constructor(stmt) { this.stmt = stmt; this.args = []; }
  bind(...args) { this.args = args.map(v => (v === undefined ? null : v)); return this; }
  run() { const r = this.stmt.run(...this.args); return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }
  first() { const r = this.stmt.get(...this.args); return r === undefined ? null : r; }
  all() { return { results: this.stmt.all(...this.args) }; }
}

class D1Like {
  constructor(db) { this.db = db; this.raw = db; }
  prepare(sql) { return new D1Stmt(this.db.prepare(sql)); }
  /** test-only convenience */
  rows(sql) { return this.db.prepare(sql).all(); }
  count(table) { return this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; }
}

/**
 * Allowlist fixtures. `Ledger` and `StripeCustomers` now REQUIRE one — the pilot bound is held by
 * the object the way `mode` is, so it cannot be forgotten at a call site (spec §3.1).
 *
 * ANY_AR is the wildcard, for the many tests that are not about the bound. Tests that ARE about it
 * use onlyAr(...) and assert the refusal explicitly.
 */
export const ANY_AR = { all: true, codes: new Set() };
export const onlyAr = (...codes) => ({ all: false, codes: new Set(codes.map(c => String(c).trim().toUpperCase())) });

export function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return new D1Like(db);
}

/** One invoice-list record in the shape spec §1 documents. */
export function inv(id, over = {}) {
  return {
    invoiceId: id,
    invoiceNumber: `INV-${id}`,
    ARCode: '5406',
    total: 1234.56,
    status: { generated: true, sent: false, paid: false },
    shipment: { BOLNumber: `BOL${id}`, carrierPRO: `PRO${id}` },
    ...over,
  };
}

function wrap(envelope, rows, totalResults) {
  switch (envelope) {
    case 'data.results': return { data: { results: rows, totalResults } };
    case 'data.array': return { data: rows, totalResults };
    case 'results': return { results: rows, totalResults };
    case 'bare': return rows;
    default: throw new Error(`unknown envelope ${envelope}`);
  }
}

/**
 * Fake Primus system API. Serves /invoice with real pagination semantics so the poll's
 * termination conditions are exercised rather than mocked away.
 */
export function fakePrimus(invoices, opts = {}) {
  const { envelope = 'data.results', totalResults = invoices.length } = opts;
  const calls = [];
  return {
    calls,
    async get(path, params = {}) {
      calls.push({ path, params });
      if (path !== '/invoice') throw new Error(`unexpected path ${path}`);
      const page = Number(params.page || 1);
      const limit = Number(params.limit || 100);
      const rows = invoices.slice((page - 1) * limit, (page - 1) * limit + limit);
      return wrap(envelope, rows, totalResults);
    },
  };
}
