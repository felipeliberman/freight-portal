// STEP 3 — the possession route on pay.freightandlogistics.ai (spec §8.878, §8.880).
//
//     node --test pay/test/route.test.mjs
//
// THE FIRST THING WE HAVE EVER EXPOSED PUBLICLY. It is unauthenticated by design, so every
// assertion below is about what it REFUSES as much as what it renders.
//
// ── WHICH REDS ARE WHICH, STATED PLAINLY ─────────────────────────────────────────────────────
//
// This is NEW CONSTRUCTION. There is no defect to reproduce, so every failure here before the
// route exists is RED BY ABSENCE — much weaker evidence than a reproduced defect, and it is
// labelled rather than dressed up. The tests become real the moment the route exists and they
// still pass.
//
// The exception is the SHIPPABILITY test, which is red by DESIGN and stays red until the owner
// supplies the copy. Stop 2 (§8.55) holds: no customer-facing wording is written by the assistant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// The SCHEMA is owned by invoice-sync — the WRITER owns the migration (§8.879). This Worker only
// reads, and reading the same file is what keeps the two from drifting.
const LINKS_SCHEMA = readFileSync(join(HERE, '..', '..', 'invoice-sync', 'schema-links.sql'), 'utf8');

class D1Stmt {
  constructor(s) { this.s = s; this.a = []; }
  bind(...a) { this.a = a.map(v => (v === undefined ? null : v)); return this; }
  run() { const r = this.s.run(...this.a); return { success: true, meta: { changes: r.changes } }; }
  first() { const r = this.s.get(...this.a); return r === undefined ? null : r; }
  all() { return { results: this.s.all(...this.a) }; }
}
class D1Like {
  constructor(db) { this.db = db; this.raw = db; }
  prepare(sql) { return new D1Stmt(this.db.prepare(sql)); }
}
function linksDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(LINKS_SCHEMA);
  return new D1Like(db);
}

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';           // 22 base64url chars, the real shape
const OTHER = 'ZzZzZzZzZzZzZzZzZzZzZz';

async function worker() { return import('../src/index.js'); }

/** Seed one link the way a mint would. */
function seed(db, over = {}) {
  db.prepare(
    `INSERT INTO invoice_link (mode, token, primus_invoice_id, ar_code, invoice_number,
       issue_date, due_date, total_cents, bol_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(over.mode || 'live', over.token || TOKEN, 'I1', '1234', '141604',
         '2026-07-13', '2026-08-12', 27357, '160133693', 0).run();
  return db;
}

function env(db, mode = 'live') { return { LINKS: db, LINK_MODE: mode }; }
const req = (path, init) => new Request('https://pay.freightandlogistics.ai' + path, init);

// ── the route surface ────────────────────────────────────────────────────────────────────────

test('RED-BY-ABSENCE: the Worker exists and exports a fetch handler', async () => {
  const w = await worker().catch(() => null);
  assert.ok(w, 'pay/src/index.js does not exist yet');
  assert.equal(typeof w.default.fetch, 'function');
});

test('a valid token renders the possession tier', async () => {
  const w = await worker();
  const res = await w.default.fetch(req('/i/' + TOKEN), env(seed(linksDb())));
  assert.equal(res.status, 200);
  const html = await res.text();
  for (const v of ['141604', '160133693', '273.57']) {
    assert.ok(html.includes(v), `possession field ${v} missing from the page`);
  }
});

test('SESSION-TIER DATA IS NEVER IN THE HTML — the tier is enforced by what the DB holds', async () => {
  const w = await worker();
  const db = seed(linksDb());
  // If any of these ever appear, either the schema grew a column or the query stopped being explicit.
  const res = await w.default.fetch(req('/i/' + TOKEN), env(db));
  const html = (await res.text()).toLowerCase();
  for (const forbidden of ['consignee', 'shipper', 'commodity', 'accessorial', 'customer_reference', 'line item']) {
    assert.ok(!html.includes(forbidden), `${forbidden} reached an unauthenticated page`);
  }
});

test('only GET and HEAD are accepted', async () => {
  const w = await worker();
  const db = seed(linksDb());
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await w.default.fetch(req('/i/' + TOKEN, { method }), env(db));
    assert.equal(res.status, 405, `${method} was not refused`);
  }
  assert.equal((await w.default.fetch(req('/i/' + TOKEN, { method: 'HEAD' }), env(db))).status, 200);
});

test('every other path is 404 — there is no health route and no second surface', async () => {
  const w = await worker();
  const db = seed(linksDb());
  for (const p of ['/', '/healthz', '/i/', '/i/' + TOKEN + '/documents', '/d/' + TOKEN, '/../etc']) {
    assert.equal((await w.default.fetch(req(p), env(db))).status, 404, `${p} was not 404`);
  }
});

test('query parameters cannot change behaviour — they are ignored, not validated', async () => {
  const w = await worker();
  const db = seed(linksDb());
  const plain = await (await w.default.fetch(req('/i/' + TOKEN), env(db))).text();
  const spiked = await (await w.default.fetch(
    req('/i/' + TOKEN + '?bolId=136013091&invoice=999&mode=test&format=json'), env(db))).text();
  assert.equal(spiked, plain, 'a query parameter altered the response');
});

// ── the three scenarios, and they must be INDISTINGUISHABLE ──────────────────────────────────

test('unknown, revoked and malformed tokens are ONE response — the route is not an oracle', async () => {
  const w = await worker();
  const db = seed(linksDb());
  db.prepare('UPDATE invoice_link SET revoked_at = 1 WHERE token = ?').bind(TOKEN).run();
  seed(db, { token: OTHER });                    // an active link, so the table is not simply empty
  db.prepare('UPDATE invoice_link SET revoked_at = 1 WHERE token = ?').bind(OTHER).run();

  const unknown   = await w.default.fetch(req('/i/QqWwEeRrTtYyUuIiOoPpAa'), env(db));
  const revoked   = await w.default.fetch(req('/i/' + TOKEN), env(db));
  const malformed = await w.default.fetch(req('/i/short'), env(db));

  const bodies = [];
  for (const r of [unknown, revoked, malformed]) {
    assert.equal(r.status, 404, 'all three must be 404');
    bodies.push(await r.text());
  }
  assert.equal(bodies[0], bodies[1], 'revoked is distinguishable from unknown — that is an oracle');
  assert.equal(bodies[1], bodies[2], 'malformed is distinguishable from revoked');
});

test('a token from the OTHER MODE is not found, not rejected — the mode is in the query', async () => {
  const w = await worker();
  const db = seed(linksDb(), { mode: 'test' });                 // a TEST link
  const res = await w.default.fetch(req('/i/' + TOKEN), env(db, 'live'));   // asked of a LIVE worker
  assert.equal(res.status, 404);
  const other = await w.default.fetch(req('/i/QqWwEeRrTtYyUuIiOoPpAa'), env(db, 'live'));
  assert.equal(await res.text(), await other.text(), 'a cross-mode token is distinguishable from an unknown one');
});

// ── headers: asserted, not set and trusted ───────────────────────────────────────────────────

test('Cache-Control and Referrer-Policy are set on EVERY response, 200 and 404 alike', async () => {
  const w = await worker();
  const db = seed(linksDb());
  for (const path of ['/i/' + TOKEN, '/i/nope', '/anything']) {
    const res = await w.default.fetch(req(path), env(db));
    assert.equal(res.headers.get('cache-control'), 'private, no-store',
      `a possession page cached at the edge and served to the wrong person is the worst failure this route has (${path})`);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer',
      `the token is IN THE URL and the CTA links to the portal — a default policy hands it to the next origin (${path})`);
  }
});

// ── stop 2: the copy is the owner's ──────────────────────────────────────────────────────────

test('RED BY DESIGN until the owner supplies copy: no PENDING sentinel may ship', async () => {
  const { COPY, isShippable } = await import('../src/copy.js');
  const pending = Object.entries(COPY).filter(([, v]) => String(v).includes('PENDING OWNER WORDING'));
  assert.deepEqual(pending.map(([k]) => k), [],
    'customer-facing prose is still a placeholder. Stop 2 (§8.55) holds: no customer-facing wording ' +
    'is written by the assistant. The owner fills these and this test goes green.');
  assert.equal(isShippable(), true);
});

test('the 404 copy is EMAIL-ONLY — no phone number, per the no-phone-as-fallback contract', async () => {
  const w = await worker();
  const html = await (await w.default.fetch(req('/i/nope'), env(linksDb()))).text();
  assert.ok(!/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\(\d{3}\)|tel:/.test(html),
    'a phone number reached error copy — this is failure copy and the contract is email-only');
});

// ── the as-sent label (owner decision 4) ─────────────────────────────────────────────────────

test('the amount is labelled AS SENT, with its date — a stale link must be honestly stale', async () => {
  const w = await worker();
  const html = await (await w.default.fetch(req('/i/' + TOKEN), env(seed(linksDb())))).text();
  assert.ok(html.includes('2026-07-13'),
    'the issue date is not shown beside the amount. If Primus revises the invoice the portal will ' +
    'differ, and the customer must be able to tell which is which rather than concluding one is wrong.');
});

test('the CTA has a destination — a button that goes nowhere is worse than no button', async () => {
  const w = await worker();
  const html = await (await w.default.fetch(req('/i/' + TOKEN), env(seed(linksDb())))).text();
  assert.ok(/<a href="https:\/\/www\.freightandlogistics\.ai\/portal">/.test(html),
    'the CTA is not a link. D2 is unbuilt, so it points at the portal until the deep link exists.');
});

test('the as-sent date comes from the SNAPSHOT, never a live read', async () => {
  const w = await worker();
  const html = await (await w.default.fetch(req('/i/' + TOKEN), env(seed(linksDb())))).text();
  assert.ok(html.includes('Amount as invoiced on 2026-07-13.'), 'the as-sent line did not interpolate the snapshot date');
  assert.ok(html.includes('the amount in your account is current'), 'the secondary line is missing — it is the one that does the work');
});
