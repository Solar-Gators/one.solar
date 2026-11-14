/**
 * Smoke tests: every one.solar app opens without a JavaScript error, signed out and as an Admin, and
 * the shared navigation (app switcher, top-bar tabs) works. Runs on the fake backend (see
 * playwright.config.mjs); the account below exists only in this browser's fake database.
 *
 * Any uncaught page error, console error, or request to the real Supabase fails the test.
 */
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { watch, open, signUp } from './helpers.mjs';

const ADMIN = { name: 'Smoke Admin', email: 'smoke-admin@ufl.edu', password: 'fake-only-smoke-pass-1' };

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
test.describe('supabase-js', () => {
// It talks to a stub server, which the page's Content-Security-Policy would (rightly) block.
test.use({ bypassCSP: true });
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
});

test.describe('signed in as an Admin', () => {
  test.describe.configure({ mode: 'serial' });
  /** @type {import('@playwright/test').Page} */
  let page;
  let problems;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    problems = await watch(page);
    await signUp(page, ADMIN, ['admin']); // a new account (a Guest), then made an Admin in the fake database
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

  test('lists show every request even past Supabase\'s per-request row cap (paging)', async () => {
    // Supabase returns at most "Max rows" (1000) per request; the fake does the same, here capped at 3.
    await open(page, '/orders/', '#main-nav a');
    await page.evaluate(async () => {
      const season = `(select value ->> 'season' from app_settings where key = 'general')`;
      for (let i = 1; i <= 8; i++) {
        await window.fakeSql(`insert into requests (request_number, title, status, season) values ($1, $2, 'Submitted', ${season}) on conflict do nothing`,
          [`PAGE-${i}`, `Paging test ${i}`]);
      }
      await window.fakeSql(`insert into requests (request_number, title, status, season) values ('PAGE-OLD', 'Old season', 'Received', '2019-2020') on conflict do nothing`);
      localStorage.setItem('fake-max-rows', '3');
    });
    try {
      await open(page, '/orders/#/requests', '#app a[href="#/requests/PAGE-1"]');
      await expect(page.locator('#app a[href^="#/requests/PAGE-"]')).toHaveCount(8);
      await expect(page.locator('#app option', { hasText: '2019-2020' })).toHaveCount(1); // seasons are paged too
    } finally {
      await page.evaluate(() => localStorage.removeItem('fake-max-rows'));
    }
  });

  test('an error in a page reaches Admin → Diagnostics, and Report a problem works (046)', async () => {
    await open(page, '/orders/', '#main-nav a');
    await page.evaluate(() => setTimeout(() => { throw new Error('Smoke test: deliberate error for riley@ufl.edu'); }));
    await expect.poll(() => page.evaluate(async () =>
      (await window.fakeSql(`select message from client_errors where message like '%Smoke test%'`)).map((r) => r.message.replace(/^Uncaught (Error: )?/, '')))).toEqual(['Smoke test: deliberate error for [email]']); // the address was blanked
    // That error was the point of this test, not a problem with the page.
    const thrown = problems.splice(0);
    expect(thrown).toEqual(['page error: Smoke test: deliberate error for riley@ufl.edu']);

    await page.locator('#account-btn').click();
    await page.locator('#menu-report').click();
    await page.fill('#os-report-text', 'The queue page looked empty');
    await page.locator('.os-report-dialog [type="submit"]').click();
    await expect(page.locator('.os-report-msg')).toHaveText('Thanks, an Admin will see this.');
    await page.locator('.os-report-dialog [data-report-cancel]').click();

    await open(page, '/admin/#/admin/diagnostics', '#app h2');
    await expect(page.locator('#app')).toContainText('Smoke test: deliberate error for [email]');
    await expect(page.locator('#app')).toContainText('The queue page looked empty');
    await expect(page.locator('[data-diag-count]').first()).toHaveText('2');
  });

  test('saving settings someone else changed meanwhile says so instead of overwriting them (045)', async () => {
    await open(page, '/admin/#/admin/season', '#settings-form #s-team');
    // Someone else saves the team settings while this page is open.
    await page.evaluate(async () => {
      await window.fakeSql(`insert into auth.users (email, raw_user_meta_data, password) values ('other-admin@ufl.edu', '{"full_name":"Olive Other"}', 'x') on conflict do nothing`);
      await window.fakeSql(`update app_settings set value = value || '{"teamName":"Their name"}',
        updated_by = (select id from profiles where email = 'other-admin@ufl.edu') where key = 'general'`);
    });
    await page.fill('#s-team', 'My name');
    await page.locator('#settings-form [type="submit"]').click();
    await expect(page.locator('#settings-errors')).toContainText('Olive Other changed these settings');
    const name = await page.evaluate(async () => (await window.fakeSql(`select value->>'teamName' t from app_settings where key = 'general'`))[0].t);
    expect(name).toBe('Their name'); // theirs wasn't overwritten
    // After a reload the page has their version, and saving works.
    await page.reload();
    await expect(page.locator('#settings-form #s-team')).toHaveValue('Their name');
    await page.fill('#s-team', 'Solar Gators');
    await page.locator('#settings-form [type="submit"]').click();
    await expect(page.locator('.alert-success')).toContainText('Team settings saved');
  });

  test('a database behind or ahead of the page shows the version banner (shared/version-check.js)', async () => {
    const setSchema = (delta) => page.evaluate(async (d) => {
      const { SCHEMA_VERSION } = await import('/shared/version.js');
      await window.fakeSql(`update app_settings set value = jsonb_set(value, '{schemaVersion}', to_jsonb($1::int)) where key = 'general'`, [SCHEMA_VERSION + d]);
    }, delta);
    await open(page, '/orders/', '#main-nav a');
    await expect(page.locator('#os-version-banner')).toHaveCount(0); // in step: nothing
    try {
      await setSchema(-1);
      await open(page, '/orders/', '#os-version-banner.updating');
      await open(page, '/evals/?fake', '#os-version-banner.updating');
      await setSchema(+1);
      await open(page, '/orders/', '#os-version-banner.reload');
    } finally {
      await setSchema(0);
    }
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
