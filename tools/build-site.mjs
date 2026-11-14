/**
 * Builds the folder GitHub Pages publishes (used by .github/workflows/deploy.yml).
 *
 *   node tools/build-site.mjs [--out=_site] [--version=<commit sha>]
 *
 * Copies only the site itself: git-tracked files under SITE_PATHS. Everything else in the repo
 * (docs/, supabase/, tests/, tools/, package files, README) stays on GitHub and is not published.
 * With --version it also writes version.json ({ sha, builtAt }) so you can see which commit is live.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, copyFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What the live site is made of: the home screen, every app folder, and what they share. */
export const SITE_PATHS = [
  'index.html',
  '.nojekyll',
  'hub/',
  'orders/',
  'finances/',
  'sponsors/',
  'admin/',
  'evals/',
  'gatorwire/',
  'scope-map/',
  'shared/',
];

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The git-tracked files that belong on the site (paths relative to the repo root, forward slashes). */
export function siteFiles() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
  return tracked.filter((f) => SITE_PATHS.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}

export function buildSite({ out = join(ROOT, '_site'), version = '' } = {}) {
  rmSync(out, { recursive: true, force: true });
  const files = siteFiles();
  for (const f of files) {
    const to = join(out, f);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(ROOT, f), to);
  }
  if (version) {
    writeFileSync(join(out, 'version.json'), JSON.stringify({ sha: version, builtAt: new Date().toISOString() }) + '\n');
    // …and into the page code, so an open page can tell a newer build went live (shared/version-check.js).
    const stamp = join(out, 'shared', 'version.js');
    const code = readFileSync(stamp, 'utf8');
    if (!code.includes("export const VERSION = 'dev';")) throw new Error('shared/version.js: VERSION line not found');
    writeFileSync(stamp, code.replace("export const VERSION = 'dev';", `export const VERSION = ${JSON.stringify(version)};`));
  }
  return files;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const out = arg('out') ? join(process.cwd(), arg('out')) : join(ROOT, '_site');
  const files = buildSite({ out, version: arg('version') || '' });
  if (!existsSync(join(out, 'index.html'))) throw new Error('The built site has no index.html');
  console.log(`Built ${files.length} files into ${out}`);
}
