/**
 * Database functions the website calls (RPCs), checked the way Supabase's API (PostgREST) dispatches them:
 * by function name plus the set of named arguments sent.
 *
 *   (a) no function the website can call has two versions (overloads): PostgREST can't choose between
 *       f(a, b) and f(a, b, c default …) and fails every call with PGRST203;
 *   (b) the signature of every callable function matches tests/rpc-signatures.json, so a signature change
 *       is always deliberate (node tests/rpc.test.mjs --update rewrites it after you check the diff);
 *   (c) every .rpc('name', { … }) / call("name", { … }) / checkedRpc('name', { … }) in the website names an existing function that the
 *       website may call, sends only argument names it has, and sends every argument without a default.
 *
 *   node tests/rpc.test.mjs [--update]
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { freshDb } from './support/supabase-stub.mjs';

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${String(err.message).split('\n').join('\n    ')}`);
    process.exitCode = 1;
  }
}

const ROOT = new URL('../', import.meta.url);
const SNAPSHOT = new URL('rpc-signatures.json', import.meta.url);
const db = await freshDb();

/** Every public function `authenticated` may execute (what signed-in browsers can call), with its arguments. */
const callable = (await db.query(`
  select p.proname as name, pg_get_function_identity_arguments(p.oid) as args, pg_get_function_result(p.oid) as result,
         p.pronargs as nargs, p.pronargdefaults as ndefaults, coalesce(p.proargnames, '{}') as argnames,
         coalesce(p.proargmodes::text[], '{}') as modes, has_function_privilege('anon', p.oid, 'execute') as anon
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
    and has_function_privilege('authenticated', p.oid, 'execute')
  order by 1, 2`)).rows;

console.log('Database functions the website calls');

await test('(a) no callable function has more than one version (PostgREST would fail with PGRST203)', () => {
  const counts = {};
  for (const f of callable) counts[f.name] = (counts[f.name] || 0) + 1;
  assert.deepEqual(Object.entries(counts).filter(([, n]) => n > 1), []);
});

const signatures = Object.fromEntries(callable.map((f) => [f.name, { args: f.args, returns: f.result, anon: f.anon }]));
if (process.argv.includes('--update')) {
  writeFileSync(SNAPSHOT, JSON.stringify(signatures, null, 1) + '\n');
  console.log(`  (wrote ${SNAPSHOT.pathname})`);
}
await test('(b) callable function signatures match tests/rpc-signatures.json', () => {
  const saved = JSON.parse(readFileSync(SNAPSHOT, 'utf8'));
  assert.deepEqual(signatures, saved, 'A callable function was added, removed or changed. If that is intended (and old pages still work: see docs/MAINTAINING.md → "Changing a database function"), run: node tests/rpc.test.mjs --update');
});

/** The input argument names of a callable function, and how many trailing ones have defaults. */
const inputsOf = (f) => {
  const names = f.argnames.filter((_, i) => !f.modes.length || ['i', 'b', 'v'].includes(f.modes[i]));
  return { names, required: names.slice(0, names.length - f.ndefaults) };
};

/** Top-level keys of a JS object literal starting at text[start] === '{' (shorthand and `key:` forms). */
function objectKeys(text, start) {
  let depth = 0, i = start, quote = null, body = '';
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote && text[i - 1] !== '\\') quote = null; if (depth === 1) body += ' '; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; if (depth === 1) body += ' '; continue; }
    if ('{[('.includes(c)) { depth++; if (depth === 1) continue; }
    if ('}])'.includes(c)) { depth--; if (depth === 0) break; }
    if (depth === 1) body += c;
  }
  return body.split(',').map((part) => part.trim().match(/^([A-Za-z_$][\w$]*)\s*(?::|$)/)?.[1]).filter(Boolean);
}

const sources = execFileSync('git', ['ls-files', 'orders/*.js', 'hub/*.js', 'shared/*.js', 'evals/*.html'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter((f) => f && !/fake/.test(f));
const calls = [];
for (const file of sources) {
  const text = readFileSync(new URL(file, ROOT), 'utf8');
  for (const m of text.matchAll(/(?:\.rpc|\bcall|\bcheckedRpc)\(\s*(['"])([a-z_]+)\1\s*(,\s*)?/g)) {
    const after = m.index + m[0].length;
    const line = text.slice(0, m.index).split('\n').length;
    const keys = m[3] && text[after] === '{' ? objectKeys(text, after) : m[3] ? null : [];
    calls.push({ where: `${file}:${line}`, name: m[2], keys }); // keys null = arguments passed in a variable
  }
}

await test(`(c) all ${calls.length} calls in the website match a callable function's arguments`, () => {
  const problems = [];
  const byName = Object.fromEntries(callable.map((f) => [f.name, f]));
  for (const c of calls) {
    const f = byName[c.name];
    if (!f) { problems.push(`${c.where}: ${c.name} doesn't exist or the website isn't allowed to call it`); continue; }
    if (c.keys === null) continue;
    const { names, required } = inputsOf(f);
    const unknown = c.keys.filter((k) => !names.includes(k));
    const missing = required.filter((k) => !c.keys.includes(k));
    if (unknown.length) problems.push(`${c.where}: ${c.name} has no argument ${unknown.join(', ')} (it takes ${names.join(', ') || 'none'})`);
    if (missing.length) problems.push(`${c.where}: ${c.name} needs ${missing.join(', ')}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(calls.length > 50, `only ${calls.length} calls found: is the pattern still right?`);
});

await db.close();
console.log(`\n${passed} passed`);
