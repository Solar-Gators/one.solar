/**
 * Creating an account when the site asks people to confirm their email: a "Check your email" screen with what to do
 * if it doesn't show up (a few minutes, Junk, Outlook's Other tab), "Send it again" once a minute, and the same
 * button when someone tries to sign in before confirming.
 * Fake backend only, told to act like "Confirm email" is on (localStorage sg-fake-confirm); nothing is really sent.
 */
import { test, expect } from '@playwright/test';
import { watch, open } from './helpers.mjs';

const NEW = { name: 'Nia Newcomer', email: 'nia-new@ufl.edu', password: 'fake-only-signup-pass-1' };
const shot = (page, name) => (process.env.PM_SHOTS ? page.screenshot({ path: `test-results/pm-shots/${name}.png` }) : null);
const mailTo = (page, email) => page.evaluate((e) => window.__fakeMail.filter((m) => m.email === e).length, email);
/** As if the minute has passed: the fake's own limit and the page's countdown (kept through a reload). */
async function aMinuteLater(page) {
  await page.evaluate(() => {
    window.__fakeMail.forEach((m) => { m.at = 0; });
    const c = JSON.parse(sessionStorage.getItem('sg-check-email') || 'null');
    if (c) sessionStorage.setItem('sg-check-email', JSON.stringify({ ...c, sentAt: 0 }));
  });
}

test('sign up → Check your email, with tips and Send it again; signing in early offers it too', async ({ page }) => {
  const problems = await watch(page);
  await page.addInitScript(() => localStorage.setItem('sg-fake-confirm', '1'));
  await open(page, '/orders/', '#auth-form');
  await page.locator('[data-mode="signup"]').first().click();
  await page.fill('#l-name', NEW.name);
  await page.fill('#l-email', NEW.email);
  await page.fill('#l-pass', NEW.password);
  await page.locator('#auth-form [type="submit"]').click();

  await expect(page.locator('h1')).toHaveText('Check your email');
  await expect(page.locator('.auth-sub')).toContainText(NEW.email);
  await expect(page.locator('.auth-tips')).toContainText('few minutes');
  await expect(page.locator('.auth-tips')).toContainText('Junk');
  await expect(page.locator('.auth-tips')).toContainText('Other');
  const again = page.locator('#c-resend');
  await expect(again).toBeDisabled();
  await expect(again).toContainText(/in \d+s/);
  await shot(page, 'signup-check-email');
  expect(await mailTo(page, NEW.email)).toBe(1);

  // still there after a reload, and the button works once the minute is up
  await aMinuteLater(page);
  await page.reload();
  await expect(page.locator('h1')).toHaveText('Check your email');
  await expect(again).toBeEnabled();
  await again.click();
  await expect(page.locator('#c-sent')).toContainText('Sent again');
  await expect(again).toBeDisabled();
  expect(await mailTo(page, NEW.email)).toBe(1);   // the fake keeps its mail log only until a reload

  // "Confirmed? Sign in" fills in the address; signing in before confirming offers to send it again
  await page.click('[data-go="signin"]');
  await expect(page.locator('#l-email')).toHaveValue(NEW.email);
  await page.fill('#l-pass', NEW.password);
  await page.locator('#auth-form [type="submit"]').click();
  await expect(page.locator('#auth-errors')).toContainText('confirm your email first');
  await aMinuteLater(page);
  await page.click('#l-resend');
  await expect(page.locator('h1')).toHaveText('Check your email');
  await expect(page.locator('#c-sent')).toContainText('Sent again');
  expect(await mailTo(page, NEW.email)).toBe(2);
  await shot(page, 'signup-sent-again');

  // "Wrong address? Start over" goes back to an empty Create an account form
  await page.click('[data-go="signup"]');
  await expect(page.locator('#l-name')).toBeVisible();
  await expect(page.locator('#l-email')).toHaveValue('');
  expect(problems.splice(0)).toEqual([]);
});
