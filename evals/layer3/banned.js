// Invariant 4 support: the set of tokens that must NEVER appear in customer-facing text is DERIVED
// from the canonical code/name sets in portal.html — not a hand-maintained list. If the source adds
// a new accessorial code or backend name, this picks it up automatically on the next run.

const { appScript } = require('../state/harness');

function _extractSet(src, constName) {
  // Matches: const NAME = new Set(['A','B',...]) — returns the string members.
  const re = new RegExp('const\\s+' + constName + '\\s*=\\s*new Set\\(\\[([^\\]]*)\\]', 'm');
  const m = src.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map(x => x[1] || x[2]);
}
function _extractObjValues(src, constName) {
  // Matches the VALUES of a code map like ACC_CODE_OF = { 'LABEL':'CODE', ... } — the codes.
  const re = new RegExp('const\\s+' + constName + '\\s*=\\s*\\{([\\s\\S]*?)\\};', 'm');
  const m = src.match(re);
  if (!m) return [];
  return [...m[1].matchAll(/:\s*'([A-Z]{2,4})'/g)].map(x => x[1]);
}

// Build the banned set from source. Two classes:
//  - CODES: internal accessorial codes (RSD/LFD/LAO/…) — the system prompt forbids ever saying one.
//  - NAMES: backend/proxy identifiers the source itself flags as never-surface.
function buildBanned() {
  const src = appScript();
  const codes = new Set([
    ..._extractSet(src, 'ACC_VALID_CODES'),
    ..._extractObjValues(src, 'ACC_CODE_OF'),
    ..._extractSet(src, 'ACC_RATEABLE_CODES'),
    ..._extractSet(src, 'ACC_BOL_CODES'),
  ]);
  // Backend / internal names. Seeded from identifiers the source treats as never-surface
  // (Primus/ShipPrimus are forbidden verbatim in _srcdocSysPmt), plus the workers.dev hosts and
  // internal field/function names that appear in the source. Distinctive strings only.
  const names = new Set(['Primus', 'ShipPrimus', 'Redkik', 'REDKIK', 'Geocodio', 'zippopotam',
    'shippingLocation', 'flAnthropic', 'anthropic-proxy', 'workers.dev', '_insHeldPull',
    '_ratePullInFlight', '_lastRatesSig', 'doGetRates', '_gateFinalText']);
  return { codes: [...codes], names: [...names] };
}

// Scan one customer-facing message for banned tokens. Codes match WHOLE-WORD uppercase (so the
// agent saying "RSD" is caught, while lowercase words like "residential"/"inside" are not).
// Names match case-insensitively as substrings (distinctive enough not to false-positive).
function scanMessage(text, banned) {
  const hits = [];
  const t = String(text || '');
  banned.codes.forEach(code => { if (new RegExp('\\b' + code + '\\b').test(t)) hits.push({ kind: 'code', token: code }); });
  banned.names.forEach(name => { if (t.toLowerCase().indexOf(name.toLowerCase()) >= 0) hits.push({ kind: 'name', token: name }); });
  return hits;
}

module.exports = { buildBanned, scanMessage };
