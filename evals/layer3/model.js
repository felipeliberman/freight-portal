// Thin Anthropic Messages API client (raw fetch — no SDK dependency) plus a usage/cost accumulator.
// Used by BOTH the agent driver (agent.js) and the customer driver (customer.js). Live calls only;
// nothing here touches Primus or the deployed proxy. temperature is settable on claude-sonnet-4-6,
// so callers pin temperature:0 (agent/judge) for determinism — the Anthropic API has no seed param,
// which is exactly why the N=3 replay classification exists.

const API_URL = 'https://api.anthropic.com/v1/messages';

// claude-sonnet-4-6 pricing (USD per token). Cache reads ~0.1x input; cache writes ~1.25x (5m TTL).
const PRICE = { in: 3 / 1e6, out: 15 / 1e6, cacheRead: 0.3 / 1e6, cacheWrite: 3.75 / 1e6 };

function costOf(usage) {
  if (!usage) return 0;
  return (usage.input_tokens || 0) * PRICE.in
    + (usage.output_tokens || 0) * PRICE.out
    + (usage.cache_read_input_tokens || 0) * PRICE.cacheRead
    + (usage.cache_creation_input_tokens || 0) * PRICE.cacheWrite;
}

// A live model. `call(body)` posts `body` (a Messages API request) and returns the parsed response
// object ({content, stop_reason, usage, model, ...}). Records usage + cost + the resolved model id.
function makeLiveModel(apiKey, opts) {
  opts = opts || {};
  const acc = { calls: 0, cost: 0, models: new Set() };
  async function call(body) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error('AI ' + res.status + ': ' + t.slice(0, 300));
    }
    const data = await res.json();
    acc.calls++; acc.cost += costOf(data.usage);
    if (data.model) acc.models.add(data.model);
    return data;
  }
  return { call, acc, live: true, label: opts.label || 'live' };
}

module.exports = { makeLiveModel, costOf, PRICE };
