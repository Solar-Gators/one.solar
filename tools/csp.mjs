/**
 * The Content-Security-Policy every one.solar page carries (S-6), as a <meta> tag. It limits what an
 * injected script could do: run code from anywhere but here and jsDelivr, or send data anywhere but our
 * Supabase project.
 *
 *   node tools/csp.mjs          # write the tag into every app page (after changing the policy or the URL)
 *   node tools/csp.mjs --check  # fail if a page's tag is missing or out of date (tests/site.test.mjs runs it)
 *
 * Why each part is there:
 *   script-src  'unsafe-inline'     Solar Evals and the CE Scope Map are single pages with inline scripts.
 *               'wasm-unsafe-eval'  the local fake backend (PGlite) is WebAssembly; never used on the live site.
 *               cdn.jsdelivr.net    supabase-js and ExcelJS, at exact versions.
 *   style-src   'unsafe-inline'     style="" attributes and inline <style> blocks are everywhere.
 *   img-src     https:              logos and attachment previews can be links to other sites.
 *   connect-src the Supabase project (database, sign-in, storage, Edge Functions), https and wss.
 * GatorWire is a built bundle and isn't changed here.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
export const PAGES = ['index.html', 'orders/index.html', 'finances/index.html', 'sponsors/index.html', 'admin/index.html', 'evals/index.html', 'scope-map/index.html'];

export function supabaseUrl() {
  const src = readFileSync(new URL('shared/config.js', ROOT), 'utf8');
  return src.match(/SUPABASE_URL\s*=\s*'([^']+)'/)[1];
}

export function cspFor(url = supabaseUrl()) {
  const host = new URL(url).host;
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' https://${host} wss://${host}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

export const cspMeta = (url) => `<meta http-equiv="Content-Security-Policy" content="${cspFor(url)}">`;
const TAG = /[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n/;

/** The page with the tag in place: replaced if there, otherwise right after <meta charset>. */
export function withCsp(html, url) {
  if (TAG.test(html)) return html.replace(TAG, (m) => `${m.match(/^[ \t]*/)[0]}${cspMeta(url)}\n`);
  return html.replace(/([ \t]*)(<meta charset="utf-8">)(\r?\n)/i, (_, indent, charset, nl) => `${indent}${charset}${nl}${indent}${cspMeta(url)}${nl}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const stale = [];
  for (const page of PAGES) {
    const file = new URL(page, ROOT);
    const html = readFileSync(file, 'utf8');
    const next = withCsp(html);
    if (next === html) continue;
    if (check) stale.push(page);
    else writeFileSync(file, next);
  }
  if (check && stale.length) {
    console.error(`Content-Security-Policy missing or out of date in: ${stale.join(', ')}. Run: node tools/csp.mjs`);
    process.exit(1);
  }
  if (!check) console.log('Content-Security-Policy written to', PAGES.length, 'pages.');
}
