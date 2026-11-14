/**
 * The "out of date" banner (shared/version-check.js): when it says Reload, when it says the database is
 * being updated, and that the version the front end expects follows the migrations.
 *
 *   node tests/version.test.mjs
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { verdict } from '../shared/version-check.js';
import { SCHEMA_VERSION } from '../shared/version.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('Version check');

test('SCHEMA_VERSION is the newest migration', () => {
  const newest = readdirSync(new URL('../supabase/migrations/', import.meta.url)).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort().at(-1);
  assert.equal(SCHEMA_VERSION, Number(newest.slice(0, 3)), 'bump SCHEMA_VERSION in shared/version.js');
});

const live = { version: 'abc123', expected: 43 };
test('same build, same database: nothing to say', () => {
  assert.equal(verdict({ liveSha: 'abc123', schemaVersion: 43 }, live), '');
});
test('a newer build is live: reload', () => {
  assert.equal(verdict({ liveSha: 'def456', schemaVersion: 43 }, live), 'reload');
});
test('the database is newer than this page: reload (an old page may save things wrongly)', () => {
  assert.equal(verdict({ liveSha: 'abc123', schemaVersion: 44 }, live), 'reload');
});
test('the database is older than this page: it is being updated', () => {
  assert.equal(verdict({ liveSha: 'abc123', schemaVersion: '42' }, live), 'updating');
});
test("unknown (offline, signed out before 001, the repo's 'dev' build): say nothing wrong", () => {
  assert.equal(verdict({ liveSha: '', schemaVersion: null }, live), '');
  assert.equal(verdict({ liveSha: 'def456', schemaVersion: 43 }, { version: 'dev', expected: 43 }), ''); // local: no version.json check
});

console.log(`\n${passed} passed`);
