// THE MASTER CONSOLE SESSION — cookie auth against ShipPrimus's admin console.
//
// The billing Remit-To email that decides who an invoice is emailed to is NOT on the REST API
// (verified 2026-08-16: the shipping-location record returns `billingInfo: { termsId }` and
// nothing else). It exists only on the console customer record, which is reached the way
// `terms-proxy` reaches billing terms: a PHPSESSID from a master login. This module holds that
// session for the unattended sync.
//
// ── WHAT THIS CREDENTIAL CAN DO, STATED PLAINLY ──────────────────────────────────────────────
//
// A console session is NOT a scoped API token. Anyone able to POST to `manage.php` with this
// cookie reaches the console's write surface — `SaveShippingLocation`, `DeleteShippingLocation`,
// `saveInvoice` and the rest. This is a materially bigger credential than the REST bearer, and it
// is held by a cron nobody is watching. Four mitigations, all load-bearing:
//
//   1. READ ACTIONS ONLY, structurally. `post()` is the only way out and it checks the action
//      against an allowlist. `login` is NOT on it — logging in is confined to `_login()` below,
//      so no caller can drive an authentication request with parameters of its own.
//   2. LAZY. Nothing here runs until a caller actually needs a record. On a run with no send
//      candidates the cron establishes no console session at all.
//   3. SHORT TTL. See SESSION_TTL_MS — deliberately shorter than terms-proxy's, because the cached
//      value is a live master session and the cost of re-logging in is one request.
//   4. THE COOKIE NEVER LEAVES THIS FILE. It is not returned, not logged, and not put in a
//      refusal. Tests assert all three.
//
// ── THE EXPIRY SIGNAL, AND WHY IT IS THE WHOLE DESIGN ────────────────────────────────────────
//
// Measured live 2026-08-16, with no cookie and again with a bogus PHPSESSID:
//
//     HTTP 200 · Content-Type: text/html · body: `No session started.`
//
// AN EXPIRED SESSION IS A 200. Not a 401, not a redirect. Any staleness check written against the
// status code reads a dead session as a successful lookup that returned no customer — and the
// recipient resolver then refuses for a reason that has nothing to do with what actually happened.
// Detection is by BODY, and it is the reason this module exists rather than an inline fetch.
//
// ── AND THE COOKIE COMES FROM THE SEED, NOT FROM LOGIN ───────────────────────────────────────
//
// Also measured: the login response carries NO `Set-Cookie` header at all. PHP starts the session
// on the seed request (`GET /`) and `action=login` merely blesses that existing PHPSESSID. An
// implementation that reads the cookie off the login response holds nothing. The seed is therefore
// mandatory, not best-effort.

import { refuse, allow, REFUSAL_REASONS } from './refusals.js';

const DEFAULT_BASE = 'https://shipprimus.com/PRIMUS/trunk';

export const CONSOLE_SESSION_CACHE_KEY = 'console:session';

/** The body an expired or absent session returns, verbatim. */
export const LOST_SESSION_BODY = 'No session started.';

/**
 * Cached for well under any plausible server-side lifetime — but the number is a HINT, not the
 * mechanism.
 *
 * The real `session.gc_maxlifetime` is not observable from here: the cookie carries no `Expires`
 * or `Max-Age` (it is a plain PHP session cookie), and terms-proxy's "~50min" is a comment, not a
 * measurement. Correctness therefore comes from DETECTING a lost session and re-logging in, never
 * from this constant being right. It is short because the cached value is a live master session,
 * and holding one for 45 minutes to save a single request is a bad trade.
 */
export const SESSION_TTL_MS = 20 * 60 * 1000;

/**
 * READ ACTIONS ONLY. Every entry must be a read.
 *
 * Structural, the same discipline as PrimusClient's path allowlist: there is no exported method
 * that takes an arbitrary action, so a typo or a careless caller cannot reach `SaveShippingLocation`.
 * `login` is deliberately absent — see `_login()`.
 */
const ALLOWED_ACTIONS = Object.freeze(new Set([
  'getShippingLocation',    // the customer record: accountingContacts, remitToSL, billingEmail, email
  'getShippingLocations',   // name/code search, for diagnosis
]));

/** Whitespace- and case-insensitive, because the body is prose from PHP and not a protocol value. */
export function isLostSession(text) {
  return String(text ?? '').trim().toLowerCase() === LOST_SESSION_BODY.toLowerCase();
}

/** The PHPSESSID pair out of a Set-Cookie header, or null. */
function pickCookie(setCookie) {
  const m = /PHPSESSID=[^;]+/.exec(setCookie || '');
  return m ? m[0] : null;
}

export class ConsoleSession {
  /**
   * @param {{username:string, password:string, base?:string}} creds  PRIMUS_CONSOLE_USER /
   *   PRIMUS_CONSOLE_PASS. A SEPARATE secret from the REST credential even where the value is the
   *   same today: the two carry different authority and must be independently rotatable.
   * @param {D1Database} db  the ledger database — the same one holding `cache` and the Primus
   *   bearer. Not the links database: that one is read by the public Worker, and a live master
   *   session cookie has no business inside its blast radius.
   * @param {{fetchImpl?:Function}} [opts]  injected for tests. There is no other seam — a module
   *   that reached for a global would be untestable without monkey-patching it.
   */
  constructor(creds, db, { fetchImpl } = {}) {
    const username = (creds && creds.username) || '';
    const password = (creds && creds.password) || '';
    if (!username || !password) {
      throw new Error(
        'ConsoleSession requires PRIMUS_CONSOLE_USER and PRIMUS_CONSOLE_PASS. Never defaulted and ' +
        'never shared with the REST credential: a console session can write and delete shipping ' +
        'locations, and it must be rotatable on its own.'
      );
    }
    this.creds = { username, password, base: ((creds && creds.base) || DEFAULT_BASE).replace(/\/+$/, '') };
    this.db = db;
    this.fetchImpl = fetchImpl || ((...a) => fetch(...a));
    this._cookie = null;   // isolate-local memo; the D1 row is the cross-isolate cache
  }

  get _manage() { return `${this.creds.base}/manage.php`; }

  /**
   * POST one allowlisted read action.
   *
   * RE-LOGIN HAPPENS AT MOST ONCE, and only when the session we used was one we did NOT just
   * establish. Both halves matter:
   *   - zero retries means a run dies on a session that expired mid-pass, which is the ordinary
   *     case for a cron whose window is longer than the console's session;
   *   - unbounded retries mean a credential problem turns one cron tick into a login storm against
   *     a shared production console, and a fresh session answering "No session started." is not a
   *     staleness problem at all — it is the console not honouring logins.
   *
   * @returns {{ok:true, value:{json:object}}|{ok:false, reason:string, detail?:object}}
   */
  async post(action, params = {}, { now = Date.now() } = {}) {
    if (!ALLOWED_ACTIONS.has(action)) {
      // A THROW, not a refusal: reaching for a write action is a programming error, and a caller
      // able to write `if (!r.ok)` past it is a caller that can ignore it.
      throw new Error(
        `Refusing a non-allowlisted console action: ${JSON.stringify(action)}. This session is ` +
        `read-only by construction (allowed: ${[...ALLOWED_ACTIONS].join(', ')}).`
      );
    }

    let cookie = this._cookie || await this._readCache(now);
    let fresh = false;
    if (!cookie) {
      const got = await this._login(now);
      if (!got.ok) return got;
      cookie = got.value;
      fresh = true;
    }

    let res = await this._send(action, params, cookie);

    if (res.kind === 'lost' && !fresh) {
      this._forget();
      const got = await this._login(now);
      if (!got.ok) return got;
      res = await this._send(action, params, got.value);
    }

    if (res.kind === 'json') return allow({ json: res.json });
    if (res.kind === 'lost') {
      // Either the retry also came back dead, or the session was minutes old. Neither is fixed by
      // logging in again.
      this._forget();
      return refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'session', action });
    }
    return refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'request', action, status: res.status ?? null });
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────

  /**
   * Seed, then log in.
   *
   * Confined to this method precisely so no caller can drive an authentication request: `login` is
   * not on ALLOWED_ACTIONS, and this is the only place credentials are ever put on the wire.
   *
   * @returns {{ok:true, value:string}|{ok:false, ...}} the value is the cookie, never logged.
   */
  async _login(now) {
    let cookie = null;

    // MANDATORY. PHP starts the session here and login sets no cookie of its own.
    //
    // The seed gets its OWN refusal stage. Both a failed seed and a seed that simply set no cookie
    // end in the same place — no session, nothing sent — but at 2am they are different problems:
    // `seed` means the console did not answer, `no_cookie` means it answered and handed over no
    // session. Collapsing them into one signal costs the first ten minutes of the diagnosis.
    try {
      const seeded = await this.fetchImpl(`${this.creds.base}/`, { redirect: 'manual' });
      // `>= 400`, NOT `!res.ok`. Measured 2026-08-16 the seed is a plain 200, but `ok` is false for
      // a 3xx too — and a redirect that still carries Set-Cookie is a working seed. Refusing on
      // `!ok` would manufacture a failure out of a response that gave us everything we needed.
      if (seeded.status >= 400) {
        return refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'seed', status: seeded.status });
      }
      cookie = pickCookie(seeded.headers.get('set-cookie'));
    } catch {
      return refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'seed' });
    }

    let res;
    try {
      res = await this.fetchImpl(this._manage, {
        method: 'POST',
        headers: { ...formHeaders(), ...(cookie ? { Cookie: cookie } : {}) },
        body: new URLSearchParams({
          action: 'login',
          loginUsername: this.creds.username,
          loginPassword: this.creds.password,
          browser: 'Firefox', browserVersion: '120', os: 'Mac',
        }).toString(),
        redirect: 'manual',
      });
    } catch {
      return refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'login' });
    }

    if (!res.ok) {
      return refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'login', status: res.status });
    }

    const blessed = pickCookie(res.headers.get('set-cookie'));
    if (blessed) cookie = blessed;      // not observed live, honoured if it ever appears

    const body = await res.text();
    // A REGEX, NOT JSON.parse. The success body is `{success: true}` — an UNQUOTED key, which is
    // not valid JSON. "Tidying" this into a parse breaks login and the failure looks like bad
    // credentials.
    if (!/success['"]?\s*:\s*true/i.test(body)) {
      // The body is not echoed: it is an upstream response (spec §6.3) and may carry session or
      // account detail.
      return refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'login', status: res.status });
    }
    if (!cookie) {
      // Fail closed. Without a cookie the next call goes out unauthenticated and comes back
      // "No session started." — a confusing way to discover the seed failed.
      return refuse(REFUSAL_REASONS.RECIPIENT_LOOKUP_FAILED, { stage: 'no_cookie' });
    }

    this._cookie = cookie;
    await this._writeCache(cookie, now + SESSION_TTL_MS);
    return allow(cookie);
  }

  /**
   * One request. Classifies rather than decides — `post()` owns the retry policy, so the rule
   * about how many times we may log in lives in exactly one place.
   *
   * @returns {{kind:'json', json:object}|{kind:'lost'}|{kind:'fail', status?:number}}
   */
  async _send(action, params, cookie) {
    let res;
    try {
      res = await this.fetchImpl(this._manage, {
        method: 'POST',
        headers: { ...formHeaders(), Cookie: cookie },
        body: new URLSearchParams({ action, ...stringify(params) }).toString(),
        redirect: 'manual',
      });
    } catch {
      return { kind: 'fail' };
    }

    if (!res.ok) return { kind: 'fail', status: res.status };

    const text = await res.text();
    if (isLostSession(text)) return { kind: 'lost' };

    try {
      return { kind: 'json', json: JSON.parse(text) };
    } catch {
      // 200 with a body that is neither the lost-session line nor JSON — a maintenance page, an
      // error page, a shape change. Not a session problem, so it must not trigger a re-login.
      return { kind: 'fail', status: res.status };
    }
  }

  _forget() {
    this._cookie = null;
  }

  async _readCache(now) {
    try {
      const row = await this.db
        .prepare('SELECT value, expires_at FROM cache WHERE key = ?')
        .bind(CONSOLE_SESSION_CACHE_KEY)
        .first();
      if (!row || Number(row.expires_at) <= now) return null;
      this._cookie = row.value;
      return row.value;
    } catch {
      return null;   // a cache miss costs one login; it must never take down a run
    }
  }

  async _writeCache(cookie, expiresAt) {
    try {
      await this.db
        .prepare(
          'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
        )
        .bind(CONSOLE_SESSION_CACHE_KEY, cookie, expiresAt)
        .run();
    } catch { /* non-fatal, see above */ }
  }
}

function formHeaders() {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Requested-With': 'XMLHttpRequest',
  };
}

/** URLSearchParams stringifies anyway; this drops nulls so they don't arrive as "null". */
function stringify(params) {
  const out = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}
