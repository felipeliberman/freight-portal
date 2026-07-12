'use strict';
/**
 * client.js — tiny Anthropic Messages API client shared by the eval stages.
 *
 * The browser talks to the model through the anthropic-proxy Worker, but that proxy
 * rejects localhost origins (see project memory: "Proxy CORS on localhost"), so the
 * harness calls the Anthropic API directly with a key from the environment. This is a
 * dev/eval-only path — never ship a key to the client.
 *
 *   ANTHROPIC_API_KEY   required
 *   EVAL_MODEL          optional, defaults to the portal's model (claude-sonnet-4-6)
 */
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';

function requireKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not set. Export it before running the eval harness.');
  }
  return key;
}

/**
 * One non-streaming Messages call. `opts`: { system, messages, model, maxTokens, tools }.
 * Returns the parsed response JSON.
 */
async function messages(opts) {
  const body = {
    model: opts.model || process.env.EVAL_MODEL || DEFAULT_MODEL,
    max_tokens: opts.maxTokens || 1024,
    messages: opts.messages,
  };
  if (opts.system) body.system = opts.system;
  if (opts.tools) body.tools = opts.tools;

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': requireKey(),
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`Anthropic ${resp.status}: ${detail.slice(0, 300)}`);
  }
  return resp.json();
}

/** Convenience: return just the concatenated text of the first assistant message. */
async function ask(opts) {
  const data = await messages(opts);
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

module.exports = { DEFAULT_MODEL, messages, ask };
