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

  expect(problems).toEqual([]);
});
