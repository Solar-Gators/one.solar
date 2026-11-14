/**
 * orders/js/messages.js: what people read when something fails or a page is closed to them (U-2).
 *
 *   node tests/messages.test.mjs
 */
import assert from 'node:assert/strict';
import { friendlyMessage, needsText, permissionNames, rolesWith, OFFLINE_TEXT, PERMISSION_TEXT, EXPIRED_TEXT } from '../orders/js/messages.js';

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

console.log('Messages');

test('messages the database wrote for people are kept as they are', () => {
  assert.equal(friendlyMessage({ message: 'Only an Admin can give the Admin role.', code: '42501' }), 'Only an Admin can give the Admin role.');
  const conflict = 'Olive Other changed these settings at 3:42 PM, after you opened them. Reload…';
  assert.equal(friendlyMessage({ message: conflict, code: 'OS409' }), conflict);
});

test('raw Postgres permission errors become plain words', () => {
  assert.equal(friendlyMessage({ message: 'permission denied for table finance_rows', code: '42501' }), PERMISSION_TEXT);
  assert.equal(friendlyMessage({ message: 'new row violates row-level security policy for table "requests"' }), PERMISSION_TEXT);
  assert.equal(friendlyMessage({ message: '', code: '42501' }), PERMISSION_TEXT);
});

test('network failures say nothing was saved; expired sign-ins say to sign in again', () => {
  assert.equal(friendlyMessage(new TypeError('Failed to fetch')), OFFLINE_TEXT);
  assert.equal(friendlyMessage({ message: 'NetworkError when attempting to fetch resource.' }), OFFLINE_TEXT);
  assert.equal(friendlyMessage({ message: 'JWT expired', code: 'PGRST301' }), EXPIRED_TEXT);
  assert.match(friendlyMessage({}), /Something went wrong/);
  assert.equal(friendlyMessage('Plain text'), 'Plain text');
});

const permissions = [{ key: 'finances.view', label: 'See Finances' }, { key: 'finances.edit', label: 'Edit Finances' }];
const roles = [{ key: 'member', label: 'Member' }, { key: 'treasurer', label: 'Treasurer' }, { key: 'admin', label: 'Admin' }, { key: 'alumni', label: 'Former member' }, { key: 'guest', label: 'Guest' }];
const rolePermissions = [
  { role: 'treasurer', permission: 'finances.edit' }, { role: 'admin', permission: 'finances.view' },
  { role: 'alumni', permission: 'finances.view' }, { role: 'guest', permission: 'finances.view' },
];

test('a closed page names the permission and the roles that have it (never Guest or Former member)', () => {
  assert.equal(permissionNames(['finances.view', 'finances.edit'], permissions), '“See Finances” or “Edit Finances”');
  assert.deepEqual(rolesWith(['finances.view', 'finances.edit'], rolePermissions, roles), ['Treasurer', 'Admin']);
  assert.equal(needsText(['finances.view', 'finances.edit'], { permissions, rolePermissions, roles }),
    'This page needs “See Finances” or “Edit Finances”. People with it: Treasurer, Admin.');
  assert.match(needsText(['x.y'], { permissions, rolePermissions, roles }), /needs “x.y”\. No role has it right now/);
});

console.log(`\n${passed} passed`);
