/**
 * Shared by the browser tests (tests/e2e/*.spec.mjs). Everything runs on the fake backend: accounts made
 * here exist only in that browser's in-page database.
 */
import { expect } from '@playwright/test';

/** Console messages that are expected and harmless. Keep this list short, with a reason for each. */
export const IGNORED_CONSOLE = [
  /favicon\.ico/, // the dev server has no favicon at the site root
];

/** Watch a page: collect errors, and block (and record) any request to the real Supabase. */
export async function watch(page) {
  const problems = [];
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !IGNORED_CONSOLE.some((re) => re.test(msg.text()))) problems.push(`console error: ${msg.text()}`);
  });
  await page.route(/^https:\/\/[^/]*\.supabase\.co\//, (route) => {
    problems.push(`request to the real Supabase: ${route.request().url()}`);
    return route.abort();
  });
  return problems;
}

/** Open a page, wait for its landmark, then give late scripts a moment to throw. */
export async function open(page, path, landmark) {
  await page.goto(path);
  await expect(page.locator(landmark).first()).toBeVisible();
  await page.waitForTimeout(500);
}

/** Sign up on the Orders sign-in page (a Guest), then give the account roles directly in the fake database. */
export async function signUp(page, { name, email, password }, roles = []) {
  await open(page, '/orders/', '#auth-form');
  await page.locator('[data-mode="signup"]').first().click();
  await page.fill('#l-name', name);
  await page.fill('#l-email', email);
  await page.fill('#l-pass', password);
  await page.locator('#auth-form [type="submit"]').click();
  await expect(page.locator('#auth-form')).toHaveCount(0);
  for (const role of roles) {
    await page.evaluate(([e, r]) => window.fakeSql(
      `insert into profile_roles (user_id, role) select id, $2 from profiles where email = $1 on conflict do nothing`, [e, r]), [email, role]);
  }
  if (roles.length) await page.reload(); // the page read the roles at sign-in
}

/** Run SQL as the database owner (fake mode only). */
export const sql = (page, query, params = []) => page.evaluate(([q, p]) => window.fakeSql(q, p), [query, params]);
