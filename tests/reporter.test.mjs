/**
 * shared/error-reporter.js: what a report may contain (no tokens, emails, sign-in codes), and the
 * Diagnostics page's grouping.
 *
 *   node tests/reporter.test.mjs
 */
import assert from 'node:assert/strict';
import { scrub, pagePath, shortStack } from '../shared/error-reporter.js';
import { groupErrors } from '../orders/js/errorGroups.js';

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

console.log('Error reports');

test('tokens and email addresses are blanked; text is cut to length', () => {
  assert.equal(scrub('Bad JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc_DEF-123 for riley@ufl.edu', 500), 'Bad JWT [token] for [email]');
  assert.equal(scrub('x'.repeat(50), 10), 'x'.repeat(10));
  assert.equal(scrub(undefined, 10), '');
});

test('the page is the path and #route only: no query string, no sign-in codes or tokens after the route', () => {
  assert.equal(pagePath({ pathname: '/orders/', hash: '#/requests/SG27-001' }), '/orders/#/requests/SG27-001');
  assert.equal(pagePath({ pathname: '/orders/', hash: '#access_token=eyJabc&type=recovery' }), '/orders/#access_token');
  assert.equal(pagePath({ pathname: '/', hash: '' }), '/');
});

test('stacks are short: site-relative file:line, at most 8 lines', () => {
  const stack = ['Error: boom', ...Array.from({ length: 12 }, (_, i) => `    at f${i} (https://site.test/orders/js/api.js?v=2:${i + 10}:5)`)].join('\n');
  const short = shortStack(stack, 'https://site.test').split('\n');
  assert.equal(short.length, 8);
  assert.equal(short[1], 'at f0 (orders/js/api.js:10)');
});

{
  test('Diagnostics groups the same message and version, adding up the counts', () => {
    const rows = [
      { kind: 'error', message: 'A', version: 'v1', at: '2026-11-01', last_at: '2026-11-02', count: 2, app: 'orders', user_id: 'u1' },
      { kind: 'error', message: 'A', version: 'v1', at: '2026-10-30', last_at: '2026-11-03', count: 1, app: 'hub', user_id: null },
      { kind: 'error', message: 'A', version: 'v2', at: '2026-11-04', last_at: '2026-11-04', count: 1, app: 'orders', user_id: 'u1' },
    ];
    const [latest, older] = groupErrors(rows);
    assert.deepEqual([latest.version, latest.count], ['v2', 1]);
    assert.deepEqual([older.count, older.first, older.last, [...older.apps].sort(), older.people.size], [3, '2026-10-30', '2026-11-03', ['hub', 'orders'], 2]);
  });
}

console.log(`\n${passed} passed`);
