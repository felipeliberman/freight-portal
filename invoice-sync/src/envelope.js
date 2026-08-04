// Primus response envelopes.
//
// The field NAMES inside are verified (spec §1); the envelope around them is not documented and
// differs by endpoint, so this accepts the plausible shapes and fails loudly on anything else.
// A silent empty result would be indistinguishable from "no records" — which, for an invoice
// poll, reads as a quiet week and for a customer lookup reads as a missing customer.
//
// Observed live 2026-08-03 on /invoice: {data:{pagingDetails,results,message}}.

/** Key names ONLY, never values — these strings reach logs and error messages (spec §6.3). */
export function describeShape(body) {
  if (body === null || body === undefined) return String(body);
  if (Array.isArray(body)) return `array[${body.length}]`;
  if (typeof body !== 'object') return typeof body;
  const keys = Object.keys(body);
  // The truncation MUST be visible. An earlier version silently cut at 12 keys, and the truncated
  // list was then read as the complete field set — leading to a claim that a field was absent from
  // a response when it had simply fallen off the end of the description.
  const shown = keys.slice(0, 12).join(',');
  return keys.length > 12 ? `{${shown},…+${keys.length - 12} more}` : `{${shown}}`;
}

/**
 * Locate the rows array in a Primus response.
 * @returns {{rows:Array, shape:string, keys:string}}
 * @throws when no array can be found — never returns an empty array as a guess.
 */
export function findRows(body, what = 'response') {
  const candidates = [
    ['data.results', body && body.data && body.data.results],
    ['data.data', body && body.data && body.data.data],
    ['data', body && body.data],
    ['results', body && body.results],
    ['bare', body],
  ];
  let hit = candidates.find(([, v]) => Array.isArray(v));

  // Envelope depth is not uniform across endpoints. Observed live 2026-08-03:
  //   /invoice              → {data:{pagingDetails,results:[…],message}}
  //   /quickbooks/customers → {data:{results:{customers:[…]},message}}
  //
  // So when the expected position holds an object rather than an array, descend into it — but
  // only when EXACTLY ONE of its properties is an array, which makes the choice unambiguous
  // rather than a guess. Failing that, treat the object as a single record.
  //
  // Both fallbacks are safe because every caller re-verifies what it picked (the QBO lookup
  // demands an exact DisplayName suffix). A wrongly-unwrapped container fails that check and
  // becomes an exception — never a wrong customer.
  if (!hit) {
    const obj = candidates.find(([k, v]) => k !== 'bare' && v && typeof v === 'object' && !Array.isArray(v));
    if (obj) {
      const arrays = Object.entries(obj[1]).filter(([, v]) => Array.isArray(v));
      hit = arrays.length === 1
        ? [`${obj[0]}.${arrays[0][0]}`, arrays[0][1]]
        : [`${obj[0]}#single`, [obj[1]]];
    }
  }

  if (!hit) {
    // Describe one level down as well. A bare "{data}" says nothing about why the match failed,
    // and this message is the only diagnostic available for an endpoint whose envelope is unknown.
    const inner = body && typeof body === 'object' ? describeShape(body.data) : 'n/a';
    throw new Error(`Unrecognised Primus ${what} envelope: ${describeShape(body)}→${inner}`);
  }

  const [shape, rows] = hit;
  const container = shape.startsWith('data') && body && body.data ? body.data : body;
  const paging = container && container.pagingDetails;
  return {
    rows,
    shape,
    keys: `${describeShape(body)}→${describeShape(container)}` + (paging ? `→paging${describeShape(paging)}` : ''),
  };
}

/**
 * Locate a SINGLE record in a Primus response — the detail endpoints nest as inconsistently as
 * the list ones. Observed live 2026-08-03: /invoice/{id} returns {data:{results:{…invoice…}}},
 * i.e. one level deeper than the top-level `data` the field list in spec §1 might suggest.
 *
 * `requireKey` makes the choice self-verifying rather than positional: among the candidate
 * positions, prefer the object that actually carries that field. Reading the wrong nesting level
 * yields an object full of undefined — which narrows to a record of nulls and looks like a
 * customer with no data, rather than failing.
 */
export function findRecord(body, requireKey = null) {
  const candidates = [
    body && body.data && body.data.results,
    body && body.data && body.data.data,
    body && body.data,
    body && body.results,
    body,
  ];
  const objects = candidates
    .map(c => (Array.isArray(c) ? c[0] : c))
    .filter(c => c && typeof c === 'object' && !Array.isArray(c));

  // No fallback when a key was required. Returning the first object anyway would hand back
  // exactly the record-of-nulls this parameter exists to prevent.
  if (requireKey) {
    return objects.find(o => o[requireKey] !== undefined && o[requireKey] !== null) ?? null;
  }
  return objects[0] ?? null;
}

/**
 * The result count, when the endpoint reports one.
 *
 * Live shape puts it in data.pagingDetails.totalResults. Deliberately does NOT match `pages`,
 * which sits right beside it — a page count read as a result count would make the shortfall guard
 * fire on every run. Nor a bare `total` beside `results`, which is the invoice money field.
 */
export function findTotalResults(body) {
  const paging = body && body.data && body.data.pagingDetails;
  const n = [
    paging && paging.totalResults,
    paging && paging.totalRecords,
    paging && paging.totalCount,
    paging && paging.total,
    body && body.data && body.data.totalResults,
    body && body.totalResults,
  ].map(Number).find(Number.isFinite);
  return Number.isFinite(n) ? n : null;
}
