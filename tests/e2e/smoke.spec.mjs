/**
 * Smoke tests: every one.solar app opens without a JavaScript error, signed out and as an Admin, and
 * the shared navigation (app switcher, top-bar tabs) works. Runs on the fake backend (see
 * playwright.config.mjs); the account below exists only in this browser's fake database.
 *
 * Any uncaught page error, console error, or request to the real Supabase fails the test.
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';

const ADMIN = { name: 'Smoke Admin', email: 'smoke-admin@ufl.edu', password: 'fake-only-smoke-pass-1' };

/** Console messages that are expected and harmless. Keep this list short, with a reason for each. */
const IGNORED_CONSOLE = [
  /favicon\.ico/, // the dev server has no favicon at the site root
];

/** Watch a page: collect errors, and block (and record) any request to the real Supabase. */
async function watch(page) {
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
async function open(page, path, landmark) {
  await page.goto(path);
  await expect(page.locator(landmark).first()).toBeVisible();
  await page.waitForTimeout(500);
}

test.describe('signed out', () => {
  const PAGES = [
    ['home screen', '/?fake=out', '#apps .app-main'],
    ['Orders', '/orders/', '#auth-form'],
    ['Finances', '/finances/', '#auth-form'],
    ['Sponsors', '/sponsors/', '#auth-form'],
    ['Admin', '/admin/', '#auth-form'],
    ['Solar Evals', '/evals/?fake', '#siEmail'],
    ['GatorWire', '/gatorwire/', '#root > *'],
    ['CE Scope Map', '/scope-map/', '#pageTitle'],
  ];
  for (const [name, path, landmark] of PAGES) {
    test(`${name} loads`, async ({ page }) => {
      const problems = await watch(page);
      await open(page, path, landmark);
      expect(problems).toEqual([]);
    });
  }
});

/**
 * Fake mode swaps out orders/js/supabase.js, so the pinned supabase-js itself is checked here: the exact
 * version Orders, Finances, Sponsors and Admin import, created with the same options, talking to a stub
 * server (nothing reaches a real project).
 */
test('the pinned supabase-js loads and works with our client options', async ({ page }) => {
  const source = readFileSync(new URL('../../orders/js/supabase.js', import.meta.url), 'utf8');
  const url = source.match(/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@\d+\.\d+\.\d+\/\+esm/)?.[0];
  expect(url, 'orders/js/supabase.js must import an exact supabase-js version').toBeTruthy();

  const problems = await watch(page);
  const calls = [];
  await page.route('https://stub.example.test/**', (route) => {
    calls.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await open(page, '/scope-map/', '#pageTitle'); // any page of ours, for the origin
  const result = await page.evaluate(async (lib) => {
    const { createClient } = await import(lib);
    const sb = createClient('https://stub.example.test', 'sb_publishable_stub', {
      auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true },
    });
    const session = await sb.auth.getSession();
    const rows = await sb.from('app_settings').select('value').eq('key', 'general');
    const rpc = await sb.rpc('waiting_guests');
    return { noSession: session.data.session === null, rows: rows.data, rowsError: rows.error, rpcError: rpc.error };
  }, url);
  expect(result).toEqual({ noSession: true, rows: [], rowsError: null, rpcError: null });
  expect(calls).toEqual(['/rest/v1/app_settings', '/rest/v1/rpc/waiting_guests']);
  expect(problems).toEqual([]);
});

test.describe('signed in as an Admin', () => {
  test.describe.configure({ mode: 'serial' });
  /** @type {import('@playwright/test').Page} */
  let page;
  let problems;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    problems = await watch(page);
    // A new account (a Guest), then made an Admin directly in the fake database.
    await open(page, '/orders/', '#auth-form');
    await page.locator('[data-mode="signup"]').first().click();
    await page.fill('#l-name', ADMIN.name);
    await page.fill('#l-email', ADMIN.email);
    await page.fill('#l-pass', ADMIN.password);
    await page.locator('#auth-form [type="submit"]').click();
    await expect(page.locator('#auth-form')).toHaveCount(0);
    await page.evaluate((email) => window.fakeSql(
      `insert into profile_roles (user_id, role) select id, 'admin' from profiles where email = $1 on conflict do nothing`, [email]), ADMIN.email);
  });
  test.afterAll(async () => page?.close());
  test.afterEach(() => {
    const found = problems.splice(0);
    expect(found).toEqual([]);
  });

  test('Orders loads with the full menu', async () => {
    await open(page, '/orders/', '#main-nav a');
    await expect(page.locator('#account-btn')).toBeVisible();
    await expect(page.locator('#main-nav')).toContainText('Queue');
  });

  test('Finances loads', async () => {
    await open(page, '/finances/', '#app h1, #app h2');
    await expect(page.locator('#auth-form')).toHaveCount(0);
  });

  test('Sponsors loads', async () => {
    await open(page, '/sponsors/', '#app h1, #app h2');
    await expect(page.locator('#auth-form')).toHaveCount(0);
  });

  test('Admin loads the Users page', async () => {
    await open(page, '/admin/#/admin/users', '#app table');
    await expect(page.locator('#app')).toContainText(ADMIN.email);
  });

  test('Solar Evals loads', async () => {
    await open(page, '/evals/?fake', '#tabs');
    await expect(page.locator('#siEmail')).toHaveCount(0);
  });

  test('home screen shows the apps (its own stand-in backend)', async () => {
    await open(page, '/?fake=admin', '#apps .app-main');
    await expect(page.locator('#apps')).toContainText('Orders');
  });

  test('top-bar tabs move between Orders pages', async () => {
    await open(page, '/orders/', '#main-nav a');
    const requests = page.locator('#main-nav a[href*="requests"]').first();
    await requests.click();
    await expect(page).toHaveURL(/#\/requests/);
    await expect(page.locator('#app')).not.toBeEmpty();
  });

  test('the app switcher opens and goes to another app', async () => {
    await open(page, '/orders/', '#main-nav a');
    await page.locator('.os-switch-btn').click();
    const pop = page.locator('#os-switch-pop');
    await expect(pop).toBeVisible();
    await expect(pop.locator('.os-switch-grid a').first()).toBeVisible();
    await pop.locator('.os-switch-grid a', { hasText: 'Scope Map' }).first().click();
    await expect(page).toHaveURL(/\/scope-map\//);
    await expect(page.locator('#pageTitle')).toBeVisible();
  });

  test('GatorWire and the CE Scope Map load while signed in', async () => {
    await open(page, '/gatorwire/', '#root > *');
    await open(page, '/scope-map/', '#pageTitle');
  });
});
