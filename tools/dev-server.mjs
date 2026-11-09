/**
 * Local development server for every OneSolar app (GitHub Pages serves the same files).
 *
 *   npm run dev            → http://localhost:5173/ (home screen), /orders/, /evals/, /gatorwire/, /scope-map/, /iv-analyzer/
 *                            talking to the real Supabase project
 *   npm run dev:fake       → no Supabase needed: Orders swaps orders/js/supabase.js for
 *                            tools/fake-supabase.js (every migration in an in-browser Postgres, PGlite),
 *                            and the home screen and Solar Evals use their own stand-ins. Data stays in your browser.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FAKE = process.argv.includes('--fake');
const PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) || process.env.PORT) || 5173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.sql': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  // Like GitHub Pages: /evals → /evals/ (so the page's relative links work).
  if (!path.endsWith('/') && !extname(path)) {
    res.writeHead(301, { Location: path + '/' + new URL(req.url, 'http://x').search }).end();
    return;
  }
  if (path.endsWith('/')) path += 'index.html';
  if (FAKE && path === '/orders/js/supabase.js') path = '/tools/fake-supabase.js';

  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT.replace(/[\\/]$/, '') + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`OneSolar dev server: http://localhost:${PORT}/${FAKE ? '  (FAKE backend — local data only)' : ''}`);
});
