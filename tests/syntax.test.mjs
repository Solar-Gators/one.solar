/**
 * Every script on the site parses: the apps' .js files and the scripts inside each page.
 * A syntax error in any one of them blanks that app (even the sign-in page), so this runs first.
 *
 *   node --experimental-vm-modules tests/syntax.test.mjs
 */
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync('git ls-files "*.js" "*.mjs" "*.html"', { encoding: 'utf8' })
  .split('\n')
  .filter((f) => f && !f.startsWith('node_modules/'));
let bad = 0;
const check = (f, code, module) => {
  try {
    if (module) new vm.SourceTextModule(code);
    else new vm.Script(code);
  } catch (e) {
    bad++;
    console.error(`  ✗ ${f}: ${e.message}`);
  }
};
for (const f of files) {
  const code = readFileSync(f, 'utf8');
  if (f.endsWith('.html')) {
    for (const [, attrs, body] of code.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type="(?!module|text\/javascript)/.test(attrs)) continue; // JSON and templates
      check(f, body, /module/.test(attrs));
    }
  } else {
    let ok = true;
    try { new vm.SourceTextModule(code.replace(/^#!.*/, '')); } catch { ok = false; }
    if (!ok) check(f, code, false);
  }
}
console.log(bad ? `${bad} file(s) don't parse` : `${files.length} files parse`);
if (bad) process.exitCode = 1;
