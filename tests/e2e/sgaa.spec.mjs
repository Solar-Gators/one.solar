/**
 * SGAA (sgaa/): an editor publishes a need, an event and a contact; signed out, everyone sees the need and
 * the event but not the contact's name, and is asked to sign in to contact or RSVP; a team member RSVPs and
 * messages the contact. Fake backend only (playwright.config.mjs).
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, signOut } from './helpers.mjs';

const EDITOR = { name: 'Cory Coordinator', email: 'sgaa-editor@ufl.edu', password: 'fake-only-sgaa-pass-1' };
const MEMBER = { name: 'Mia Member', email: 'sgaa-member@ufl.edu', password: 'fake-only-sgaa-pass-2' };

test.describe.configure({ mode: 'serial' });

test('the alumni hub: publish, see it signed out, RSVP and contact', async ({ page }) => {
  test.setTimeout(180000);
  const problems = await watch(page);

  // An editor (Business Coordinator: "Edit the alumni hub") sets things up.
  await signUp(page, EDITOR, ['coordinator']);
  await open(page, '/sgaa/?fake#/manage/contacts/new', 'form[data-form="contact-edit"]');
  await page.selectOption('#ct-user', { label: EDITOR.name });
  await page.fill('#ct-title', 'Business Coordinator');
  await page.fill('#ct-blurb', 'Sponsorships and giving');
  await page.click('form[data-form="contact-edit"] [type=submit]');
  await expect(page.locator('table')).toContainText('Business Coordinator');

  await open(page, '/sgaa/?fake#/manage/needs/new', 'form[data-form="need"]');
  await page.fill('#n-title', 'Carbon fiber prepreg');
  await page.fill('#n-summary', 'For the new aero shell');
  await page.fill('#n-cost', '2500');
  await page.fill('#n-body', 'We need **20 yards**.\n\n- 3k twill\n- Out-of-autoclave');
  await page.selectOption('#n-contact', { index: 1 });
  await page.selectOption('#n-status', 'open');
  await page.click('form[data-form="need"] [type=submit]');
  await expect(page.locator('.alert-success')).toContainText('Saved');

  await open(page, '/sgaa/?fake#/manage/events/new', 'form[data-form="event"]');
  await page.fill('#e-title', 'Alumni night');
  await page.fill('#e-start', '2099-03-14T18:00');
  await page.fill('#e-cap', '10');
  await page.check('form[data-form="event"] [name=published]');
  await page.click('form[data-form="event"] [type=submit]');
  await expect(page.locator('.alert-success')).toContainText('Saved');
  await signOut(page);

  // Signed out: the need and the event are public; names and Manage aren't.
  await open(page, '/sgaa/?fake', '.hero h1');
  await expect(page.locator('.need-grid')).toContainText('Carbon fiber prepreg');
  await expect(page.locator('#nav-manage')).toBeHidden();
  await page.click('text=Carbon fiber prepreg');
  await expect(page.locator('.prose strong')).toHaveText('20 yards');
  await expect(page.locator('.need-side')).toContainText('$2,500');
  await expect(page.locator('.need-side')).toContainText('Sign in to contact');
  await open(page, '/sgaa/?fake#/help', '.contacts');
  await expect(page.locator('.contacts')).toContainText('Business Coordinator');
  await expect(page.locator('.contacts')).not.toContainText(EDITOR.name);
  await open(page, '/sgaa/?fake#/events', '.event');
  await expect(page.locator('.event')).toContainText('Sign in to RSVP');

  // A team member RSVPs and contacts the team.
  await signUp(page, MEMBER, ['member']);
  await open(page, '/sgaa/?fake#/events', '.event');
  await page.click('.event [data-act=rsvp]');
  await page.selectOption('#r-guests', '1');
  await page.click('form[data-form="rsvp"] [type=submit]');
  await expect(page.locator('.event')).toContainText("You're going (+1)");
  await expect(page.locator('.event')).toContainText('2 going');

  await open(page, '/sgaa/?fake#/help', '.contacts');
  await expect(page.locator('.contacts')).toContainText(EDITOR.name);
  await page.click('.contacts a.btn');
  await page.fill('#c-body', 'Happy to help with layups.');
  await page.click('form[data-form="contact"] [type=submit]');
  await expect(page.locator('.alert-success')).toContainText('Sent');
  const sent = await page.evaluate(() => window.fakeSql(`select to_name, body from sgaa_messages`));
  expect(sent).toEqual([{ to_name: EDITOR.name, body: 'Happy to help with layups.' }]);

  // Messages: the sender sees what they sent; the contact sees it with "Reply by email" to the sender.
  await open(page, '/sgaa/?fake#/messages', '.message');
  await expect(page.locator('.message')).toContainText(`You → ${EDITOR.name}`);
  await expect(page.locator('.message')).toContainText('Happy to help with layups.');
  await expect(page.locator('.message a', { hasText: 'Reply by email' })).toHaveCount(0);
  await signIn(page, EDITOR);
  await open(page, '/sgaa/?fake#/messages', '.message');
  await expect(page.locator('.message')).toContainText(`${MEMBER.name} → you`);
  await expect(page.locator('.message a', { hasText: 'Reply by email' })).toHaveAttribute('href', /^mailto:sgaa-member%40ufl\.edu\?subject=Re%3A/);

  expect(problems).toEqual([]);
});

const ALUM = { name: 'Alex Alum', email: 'alex.alum@gmail.com', password: 'fake-only-sgaa-pass-3' };
const GRAD = { name: 'Gina Grad', email: 'sgaa-grad@ufl.edu', password: 'fake-only-sgaa-pass-4' };
const CHIEF = { name: 'Cam Chief', email: 'sgaa-ce@ufl.edu', password: 'fake-only-sgaa-pass-5' };

async function signIn(page, who) {
  await signOut(page);
  await page.fill('#l-email', who.email);
  await page.fill('#l-pass', who.password);
  await page.locator('#auth-form [type="submit"]').click();
  await expect(page.locator('#auth-form')).toHaveCount(0);
}

test('alumni accounts: join with any email, approval, Graduated, switching email', async ({ page }) => {
  test.setTimeout(180000);
  const problems = await watch(page);

  // An alum who was never on one.solar joins from the hub with a personal address (not @ufl.edu).
  await open(page, '/sgaa/?fake#/join', 'form[data-form="join-signup"]');
  await page.fill('#j-name', ALUM.name);
  await page.fill('#j-email', ALUM.email);
  await page.fill('#j-pass', ALUM.password);
  await page.fill('#j-roles', 'Strategy lead');
  await page.click('form[data-form="join-signup"] [type=submit]');
  await expect(page.locator('.form-error')).toContainText('What year did you graduate');
  await page.fill('#j-year', '2019');
  await page.click('form[data-form="join-signup"] [type=submit]');
  await expect(page.locator('main')).toContainText("Thanks! You're on the list");
  await expect(page.locator('main')).toContainText('Strategy lead');
  // Orders sends them back to the hub instead of "waiting to join the team".
  await open(page, '/orders/', '#app h1');
  await expect(page.locator('#app h1')).toHaveText('Your alumni account is waiting for approval');

  // A member who's about to graduate, and a Chief Engineer (approves alumni, manages people).
  await signOut(page);
  await signUp(page, GRAD, ['member']);
  await signOut(page);
  await signUp(page, CHIEF, ['ce']);

  await open(page, '/sgaa/?fake#/manage/alumni', '.alum-req');
  await expect(page.locator('.alum-req')).toContainText('Class of 2019 · Strategy lead');
  await page.click('[data-act=alum-approve]');
  await expect(page.locator('.alert-success')).toContainText(`${ALUM.name} is now an alum`);
  await expect(page.locator('.alum-req')).toHaveCount(0);

  // Admin → Users: Graduated.
  await open(page, '/admin/#/admin/users', '#app table');
  await page.click(`tr:has-text("${GRAD.email}") [data-graduate]`);
  await page.fill('#ask-text', 'Spring 2027');
  await page.click('.ask-dialog [type=submit]');
  await expect(page.locator('#app .flash')).toContainText(`${GRAD.name} is now an alum`);
  await expect(page.locator(`tr:has-text("${GRAD.email}")`)).toContainText('Alum');
  await expect(page.locator(`tr:has-text("${ALUM.email}")`)).toContainText('Alum');

  // The graduate can still sign in; the hub asks them to switch from their UF address, and Orders changes it.
  await signIn(page, GRAD);
  await open(page, '/sgaa/?fake', '.hero h1');
  await expect(page.locator('.email-banner')).toContainText(GRAD.email);
  await page.click('.email-banner a');
  await expect(page.locator('#email .alert-warning')).toContainText('Switch to a personal email');
  await page.fill('#a-email', 'gina.grad@gmail.com');
  await page.click('#email-form [type=submit]');
  await expect(page.locator('#app .flash')).toContainText('Your email is now gina.grad@gmail.com');
  expect(await page.evaluate(() => window.fakeSql(`select email from profiles where full_name = 'Gina Grad'`))).toEqual([{ email: 'gina.grad@gmail.com' }]);
  await open(page, '/sgaa/?fake', '.hero h1');
  await expect(page.locator('.email-banner')).toHaveCount(0);
  await expect(page.locator('#account')).toContainText('Alum');

  // The approved alum signs in: Orders welcomes them and points to the hub.
  await signIn(page, ALUM);
  await open(page, '/orders/', '#app h1');
  await expect(page.locator('#app h1')).toHaveText('Welcome back, Alex!');

  expect(problems).toEqual([]);
});
