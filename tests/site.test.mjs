/**
 * What GitHub Pages publishes (tools/build-site.mjs → .github/workflows/deploy.yml):
 *   - only the site: no tests, migrations, tools, docs or package files;
 *   - every page, script, style and icon the site refers to is in it (nothing 404s on the live site);
 *   - every library loaded from a CDN names an exact version (no floating "@2").
 *
 *   node tests/site.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { buildSite } from '../tools/build-site.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message.split('\n').join('\n    ')}`);
    process.exitCode = 1;
  }
}

const out = mkdtempSync(join(tmpdir(), 'onesolar-site-'));
const files = buildSite({ out, version: 'test-sha' });
const published = new Set(files);

/**
 * References the live site never loads, with the reason. Keep this list short.
 * Solar Evals imports the fake backend only on localhost with ?fake (evals/index.html, FAKE), so it is
 * deliberately not published.
 */
const NOT_PUBLISHED_ON_PURPOSE = new Set(['tools/fake-supabase.js']);

console.log('Published site');

test('only the site is published (no tests, migrations, tools, docs or package files)', () => {
  const bad = files.filter((f) => /^(tests|supabase|tools|docs|node_modules|\.github|evals\/dev)\//.test(f) ||
    /^(package(-lock)?\.json|README\.md|\.gitignore|\.nvmrc|playwright\.config\.mjs)$/.test(f));
  assert.deepEqual(bad, []);
  for (const must of ['index.html', 'orders/index.html', 'finances/index.html', 'sponsors/index.html', 'admin/index.html',
    'evals/index.html', 'gatorwire/index.html', 'scope-map/index.html', 'shared/config.js', 'hub/home.js']) {
    assert.ok(published.has(must), `${must} is missing from the site`);
  }
  assert.ok(existsSync(join(out, 'version.json')), 'version.json was not written');
  assert.equal(JSON.parse(readFileSync(join(out, 'version.json'), 'utf8')).sha, 'test-sha');
});

/** Local references in one published file, as site paths ("orders/js/api.js"). */
function referencesIn(file) {
  const text = readFileSync(join(out, file), 'utf8');
  const dir = posix.dirname(file);
  const refs = [];
  const add = (raw, base = dir) => {
    const ref = raw.trim().replace(/^['"]|['"]$/g, '');
    if (!ref || /^(https?:|mailto:|tel:|data:|blob:|javascript:|#|\/\/)/i.test(ref) || /[${}'"]|\s\+\s/.test(ref)) return; // built in code, not a fixed path
    const path = ref.split(/[?#]/)[0];
    if (!path) return;
    if (path.startsWith('/')) refs.push({ ref, resolved: null }); // absolute paths break under /one.solar/
    else refs.push({ ref, resolved: posix.normalize(posix.join(base, path)) });
  };
  const scripts = (code) => {
    for (const m of code.matchAll(/\bimport\s*(?:[\w*{}\s,]+\s*from\s*)?['"](\.{1,2}\/[^'"]+)['"]/g)) add(m[1]);
    for (const m of code.matchAll(/\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) add(m[1]);
    for (const m of code.matchAll(/new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) add(m[1]);
  };
  if (file.endsWith('.html')) {
    // The built GatorWire bundle is one minified file: only its <link>/<script src> tags are checked.
    for (const m of text.matchAll(/<(?:script|img|link|source|iframe)\b[^>]*?\s(?:src|href)=("[^"]*"|'[^']*')/gi)) add(m[1]);
    for (const m of text.matchAll(/<a\b[^>]*?\shref=("[^"]*"|'[^']*')/gi)) add(m[1]);
    if (!file.startsWith('gatorwire/')) for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) scripts(m[1]);
  } else if (/\.(m?js)$/.test(file)) {
    scripts(text);
  } else if (file.endsWith('.css')) {
    for (const m of text.matchAll(/url\(\s*([^)]+?)\s*\)/g)) add(m[1]);
  } else if (file.endsWith('.webmanifest')) {
    const manifest = JSON.parse(text);
    for (const icon of manifest.icons || []) add(icon.src);
    if (manifest.start_url) add(manifest.start_url);
  }
  return refs;
}

test('every local page, script, style and icon the site refers to is published', () => {
  const missing = [];
  for (const file of files) {
    if (!/\.(html|m?js|css|webmanifest)$/.test(file)) continue;
    for (const { ref, resolved } of referencesIn(file)) {
      if (resolved === null) { missing.push(`${file}: "${ref}" is an absolute path (breaks under /one.solar/)`); continue; }
      if (NOT_PUBLISHED_ON_PURPOSE.has(resolved)) continue;
      const ok = published.has(resolved) || published.has(posix.join(resolved, 'index.html')) || resolved === '.' ||
        (resolved.endsWith('/') && published.has(resolved + 'index.html'));
      if (!ok) missing.push(`${file}: "${ref}" → ${resolved}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('every library from a CDN names an exact version', () => {
  const floating = [];
  for (const file of files) {
    if (!/\.(html|m?js)$/.test(file)) continue;
    const text = readFileSync(join(out, file), 'utf8');
    for (const m of text.matchAll(/cdn\.jsdelivr\.net\/npm\/((?:@[\w.-]+\/)?[\w.-]+)(@[^/'"\s)]*)?/g)) {
      if (!/^@\d+\.\d+\.\d+$/.test(m[2] || '')) floating.push(`${file}: ${m[1]}${m[2] || ' (no version)'}`);
    }
  }
  assert.deepEqual(floating, []);
});

rmSync(out, { recursive: true, force: true });
console.log(`\n${passed} passed`);
