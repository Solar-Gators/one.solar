/**
 * Solar Evals → Summary (#/summary): average scores and team makeup, only for people who can "See all evals".
 * Fake backend only; the accounts and evals exist only in this browser's fake database.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, sql, signOut } from './helpers.mjs';

const LEAD = { name: 'Vera Viewer', email: 'vera-viewer@ufl.edu', password: 'fake-only-summary-pass-1' };
const MEMBER = { name: 'Milo Member', email: 'milo-member@ufl.edu', password: 'fake-only-summary-pass-2' };

/** Finished Member evals: Electrical/BMS and Aero/Body in two semesters, with known ratings. */
async function seed(page) {
  await sql(page, `
    with t as (select id, label, rubric from eval_templates where track_id = 'master' order by created_at desc limit 1),
         c as (select t.*, (select jsonb_agg(cr -> 'id') from jsonb_array_elements(t.rubric -> 'pages') p, jsonb_array_elements(p -> 'criteria') cr) ids from t),
         rows(sem, div, sub, who, score) as (values
           ('Fall 2026', 'Electrical', 'BMS', 'E One', 4), ('Fall 2026', 'Electrical', 'BMS', 'E Two', 2), ('Fall 2026', 'Aero / Structures', 'Body', 'A One', 5),
           ('Spring 2027', 'Electrical', 'BMS', 'E One', 5), ('Spring 2027', 'Aero / Structures', 'Body', 'A One', 3))
    insert into evals (template_id, template_label, rubric, member_name, semester, division, subsystem, evaluator_id, ratings, status, kind, type_id, type_settings, finalized_at)
    select c.id, 'Member eval · ' || c.label, c.rubric, r.who, r.sem, r.div, r.sub, (select id from profiles where email = '${LEAD.email}'),
           (select jsonb_object_agg(i #>> '{}', r.score) from jsonb_array_elements(c.ids) i), 'final', 'ce', 'member',
           (select settings from eval_types where id = 'member'), now()
    from c, rows r`);
}

test.describe('eval summary', () => {
  test.describe.configure({ mode: 'serial' });
  /** @type {import('@playwright/test').Page} */
  let page;
  let problems;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    problems = await watch(page);
    await signUp(page, LEAD, ['ce']); // CEs can "See all evals"
    await sql(page, `update profiles set accepted_at = now() where email = $1`, [LEAD.email]);
    await seed(page);
  });
  test.afterAll(async () => page?.close());
  test.afterEach(() => {
    const found = problems.splice(0);
    expect(found).toEqual([]);
  });

  test('someone who can see all evals gets averages by semester, division and subsystem', async () => {
    await open(page, '/evals/?fake#/summary', '.sum');
    await expect(page.locator('#tabSum')).toBeVisible();
    const team = page.locator('table.heat tr.team td.c');
    await expect(team.nth(0)).toContainText('3.67');   // Fall 2026: (4 + 2 + 5) / 3
    await expect(team.nth(1)).toContainText('4.00');   // Spring 2027: (5 + 3) / 2
    await expect(page.locator('table.heat tr.team td.delta')).toContainText('▲ 0.33');
    await page.click('[data-act="sumOpen"][data-k="Electrical"]');
    await expect(page.locator('table.heat tr.sub td.g')).toHaveText(['BMS']);
    await expect(page.locator('table.heat tr.sub td.c').first()).toContainText('3.00');
    await expect(page.locator('svg.trend circle')).not.toHaveCount(0);
  });

  test('team makeup counts each person once by division and subsystem, and lists positions', async () => {
    await page.click('[data-act="sumTab"][data-k="makeup"]');
    await page.selectOption('[data-act="sumSem"]', 'Fall 2026');
    await expect(page.locator('.kpi').first()).toContainText('3');
    await expect(page.locator('.mk-div', { hasText: 'Electrical' })).toContainText('BMS');
    await expect(page.locator('.mk-div', { hasText: 'Electrical' }).locator('h4')).toContainText('2');
    await expect(page.locator('.mk-pos')).toContainText('Chief Engineer');
  });

  test('a member without "See all evals" has no Summary tab and can\'t open it by address', async () => {
    await signOut(page);
    await signUp(page, MEMBER, ['member']);
    await sql(page, `update profiles set accepted_at = now() where email = $1`, [MEMBER.email]);
    await open(page, '/evals/?fake#/summary', '#tabs');
    await expect(page.locator('#tabSum')).toBeHidden();
    await expect(page.locator('.sum')).toHaveCount(0);
  });
});
