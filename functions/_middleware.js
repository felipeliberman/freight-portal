// Cloudflare Pages middleware — ALLOWLIST the customer-facing site.
//
// This project's build output is the whole repo, which also contains source, tooling,
// and internal knowledge (KNOWLEDGE.md, CLAUDE.md, evals/, anthropic-proxy/, qbo-api/,
// Node scripts, package manifests). Middleware runs BEFORE static-asset serving, so any
// path not explicitly allowed below returns 404 and is never publicly readable at
// www.freightandlogistics.ai — regardless of what else lands in the repo.
//
// Servable, and nothing else: the customer-facing HTML pages (index, portal, admin,
// apply), logo.png, logo-white.png, sample-slip.png, and the logos/ + docs/ image
// directories.
//
// NOTE: Pages serves the HTML at clean URLs (/portal, /) and 308-redirects the
// .html forms to them, so both forms are allowed here — allowing the .html form just lets
// the redirect happen; allowing the clean form lets the page actually serve.

const ALLOWED_EXACT = new Set([
  '/', '/index', '/index.html',
  '/portal', '/portal.html',
  '/admin', '/admin.html',
  '/apply', '/apply.html',
  '/logo.png', '/logo-white.png', '/sample-slip.png',
]);
const ALLOWED_PREFIXES = ['/logos/', '/docs/'];

export const onRequest = async (context) => {
  const url = new URL(context.request.url);

  // Normalize for matching: drop a trailing slash (except root), lowercase so that
  // case variants (e.g. /KNOWLEDGE.md, /Knowledge.MD) can't slip past the allowlist.
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  path = path.toLowerCase();

  const allowed =
    ALLOWED_EXACT.has(path) ||
    ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));

  if (!allowed) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  return context.next();
};
