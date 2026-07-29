// Agent driver: make the REAL portal agent run against a live model through the existing
// window.flAnthropic seam. window.parent === window in jsdom, so replacing w.flAnthropic intercepts
// every AI turn. We take the exact request portal.html built, replicate the deployed proxy's KB
// injection (knowledgeFor('portal')), STRIP the web_search server tool (keeps the suite scoped to
// quoting and bounded to the model API — no live web), pin temperature:0, and forward to the model.
// The parsed response is returned verbatim (portal.html's flAnthropic returns r.json()).

const { knowledgeFor } = require('../knowledge');

let _KB_PORTAL = null;
function kbPortal() { if (_KB_PORTAL == null) _KB_PORTAL = knowledgeFor('portal'); return _KB_PORTAL; }

// Transform the portal-built request body into a direct Messages API request.
function transformBody(body) {
  const out = Object.assign({}, body);
  delete out.kb; // proxy-only routing field; not an API param
  out.temperature = 0;

  // KB injection — mirror the proxy: prepend the portal knowledge base as a cached system block.
  const sys = Array.isArray(out.system) ? out.system.slice() : (out.system ? [{ type: 'text', text: String(out.system) }] : []);
  sys.unshift({ type: 'text', text: kbPortal(), cache_control: { type: 'ephemeral' } });
  out.system = sys;

  // Strip web_search (and any server tool) — keep only the portal's client tools.
  if (Array.isArray(out.tools)) {
    out.tools = out.tools.filter(t => t && typeof t.type === 'string'
      ? !/^web_search|^web_fetch|^code_execution/.test(t.type)
      : true);
  }
  return out;
}

function installAgentDriver(ctx, model) {
  const w = ctx.win;
  ctx.agentCalls = ctx.agentCalls || [];
  const driver = async (url, options) => {
    let body = {};
    try { body = JSON.parse(options && options.body); } catch (e) {}
    const reqBody = transformBody(body);
    const resp = await model.call(reqBody);
    ctx.agentCalls.push({ url: String(url), stop_reason: resp.stop_reason, usage: resp.usage, model: resp.model });
    return resp; // aiConverse consumes data.content / data.stop_reason directly
  };
  w.flAnthropic = driver;
  try { w.parent.flAnthropic = driver; } catch (e) {}
  return driver;
}

module.exports = { installAgentDriver, transformBody, kbPortal };
