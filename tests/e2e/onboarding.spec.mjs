/**
 * Onboarding (U-1, U-2): what a newcomer sees while waiting, once accepted, and on a page their role can't
 * open. Fake backend only; the account exists only in this browser's fake database.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, sql } from './helpers.mjs';

const NEW = { name: 'Nina Newcomer', email: 'nina-newcomer@ufl.edu', password: 'fake-only-onboard-pass-1' };

test.describe('onboarding', () => {
  test.describe.configure({ mode: 'serial' });
  /** @type {import('@playwright/test').Page} */
  let page;
  let problems;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    problems = await watch(page);
    await signUp(page, NEW); // a Guest
  });
  test.afterAll(async () => page?.close());
  test.afterEach(() => {
    const found = problems.splice(0);
    expect(found).toEqual([]);
  });

  test('a Guest sees whether their email is confirmed and who can accept them', async () => {
    await open(page, '/orders/', '.waiting-steps');
    await expect(page.locator('[data-email-confirmed="true"]')).toContainText('Email address confirmed');
    await expect(page.locator('#app')).toContainText(/Ask your .*Chief Engineer.* to accept you/);

    await sql(page, `update auth.users set email_confirmed_at = null where email = $1`, [NEW.email]);
    await page.locator('#account-btn').click();
    await page.getByRole('button', { name: /Sign out/ }).click();
    await expect(page.locator('#auth-form')).toBeVisible();
    await page.fill('#l-email', NEW.email);
    await page.fill('#l-pass', NEW.password);
    await page.locator('#auth-form [type="submit"]').click();
    await expect(page.locator('[data-email-confirmed="false"]')).toContainText('not confirmed yet');
    await open(page, '/evals/?fake', '[data-email-confirmed="false"]');
    await sql(page, `update auth.users set email_confirmed_at = now() where email = $1`, [NEW.email]);
  });

  test('a Member on a page their role can\'t open is told which permission it needs and who has it', async () => {
    await sql(page, `insert into profile_roles (user_id, role) select id, 'member' from profiles where email = $1 on conflict do nothing`, [NEW.email]);
    await open(page, '/finances/', '.no-access [data-needs]');
    await expect(page.locator('[data-needs]')).toContainText(/This page needs “.+”\. People with it: .*Treasurer/);
  });

  test('Help has "Your first week" for their roles', async () => {
    await open(page, '/orders/#/help', '#first-week');
    await expect(page.locator('#first-week h3')).toHaveText(['Member']);
  });

  test('the home screen says "You\'re in" once, until dismissed', async () => {
    await open(page, '/?fake=admin', '#welcome:not([hidden])');
    await expect(page.locator('#welcome')).toContainText("You're in");
    await page.locator('#welcome-done').click();
    await expect(page.locator('#welcome')).toBeHidden();
    await open(page, '/?fake=admin', '#apps .app-main');
    await expect(page.locator('#welcome')).toBeHidden();
  });
});
