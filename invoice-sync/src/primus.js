// Primus system API client — authentication, token caching, and GET-only reads.
//
// Spec §1: the `claude` user is shared with terms-proxy and the prepaid check, and it holds broad
// WRITE access including bookDelete. This sync must never call a write endpoint. "Read-only by
// discipline" is not enough on its own, so it is enforced structurally here:
//
//   * there is no exported function that takes a method — `get()` is the only way out;
//   * the path is checked against an allowlist, so a typo cannot reach an unintended endpoint;
//   * login is the single exception and is confined to `authenticate()`.
//
// QBO owns payment state. Never call PUT /invoice/{id}/paid.

const TOKEN_CACHE_KEY = 'primus:token';
// Refresh a little before expiry so a long run doesn't die holding a token that expires mid-pass.
const TOKEN_SKEW_SEC = 300;

// Spec §1 "Endpoints in use". Extend deliberately; every entry must be a GET.
const ALLOWED_PATHS = [
  /^\/invoice(\?|$)/,
  /^\/invoice\/[A-Za-z0-9_-]+$/,
  /^\/book\/bolnumber\/[A-Za-z0-9_-]+$/,
  /^\/quickbooks\/customers(\?|$)/,
  /^\/document\/bolnumber\/[A-Za-z0-9_-]+$/,
  /^\/document\/filetype$/,
];

export class PrimusClient {
  /**
   * @param {{username:string,password:string,base:string}} creds
   * @param {D1Database} db  used for the cross-isolate token cache
   */
  constructor(creds, db) {
    this.creds = creds;
    this.db = db;
    this._token = null;      // isolate-local memo; the D1 row is the cross-isolate cache
    this._tokenExp = 0;
  }

  async authenticate({ force = false } = {}) {
    const now = Math.floor(Date.now() / 1000);
    if (!force && this._token && this._tokenExp - TOKEN_SKEW_SEC > now) return this._token;

    if (!force) {
      const cached = await this._readCachedToken(now);
      if (cached) return cached;
    }

    const res = await fetch(`${this.creds.base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: this.creds.username, password: this.creds.password }),
    });
    if (!res.ok) {
      // Deliberately does not include the response body — see spec §6.3. Upstream bodies get
      // embedded in exception messages and end up in Cloudflare tail.
      throw new Error(`Primus login failed: HTTP ${res.status}`);
    }
    const body = await res.json();
    const token = body && body.data && body.data.accessToken;
    const exp = body && body.data && Number(body.data.exp);
    if (!token) throw new Error('Primus login returned no accessToken');

    this._token = token;
    // Fall back to a conservative 12h if `exp` is missing/garbage rather than trusting a bad value.
    this._tokenExp = Number.isFinite(exp) && exp > now ? exp : now + 12 * 3600;
    await this._writeCachedToken(this._token, this._tokenExp);
    return this._token;
  }

  /**
   * GET a system-API path. The ONLY request method this client exposes.
   * @param {string} path   e.g. '/invoice' or '/invoice/141886'
   * @param {object} [params] query params; undefined/null values are dropped
   */
  async get(path, params) {
    const qs = buildQuery(params);
    const full = path + qs;
    if (!ALLOWED_PATHS.some(rx => rx.test(full))) {
      throw new Error(`Refusing to call non-allowlisted Primus path: ${path} (read-only allowlist, spec §1)`);
    }
    return this._sendWithRetry(full);
  }

  async _sendWithRetry(full, { attempt = 0, reauthed = false } = {}) {
    const token = await this.authenticate();
    const res = await fetch(this.creds.base + full, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });

    // A cached token can outlive its server-side session; retry once on a fresh login.
    if (res.status === 401 && !reauthed) {
      await this.authenticate({ force: true });
      return this._sendWithRetry(full, { attempt, reauthed: true });
    }

    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(8000, 500 * 2 ** attempt);
      await sleep(delayMs);
      return this._sendWithRetry(full, { attempt: attempt + 1, reauthed });
    }

    if (!res.ok) throw new Error(`Primus GET ${full.split('?')[0]} failed: HTTP ${res.status}`);
    return res.json();
  }

  async _readCachedToken(now) {
    try {
      const row = await this.db
        .prepare('SELECT value, expires_at FROM cache WHERE key = ?')
        .bind(TOKEN_CACHE_KEY)
        .first();
      if (!row) return null;
      if (Number(row.expires_at) - TOKEN_SKEW_SEC <= now) return null;
      this._token = row.value;
      this._tokenExp = Number(row.expires_at);
      return this._token;
    } catch {
      // A cache miss must never take down a run — worst case is one extra login.
      return null;
    }
  }

  async _writeCachedToken(token, exp) {
    try {
      await this.db
        .prepare(
          'INSERT INTO cache (key, value, expires_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at'
        )
        .bind(TOKEN_CACHE_KEY, token, exp)
        .run();
    } catch {
      /* non-fatal, see above */
    }
  }
}

function buildQuery(params) {
  if (!params) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.append(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
