/**
 * Projects (051), clicked through like a person would, on the fake backend. The acceptance scenario:
 *   an Admin makes a project, two work types, a workflow with its own statuses and moves, custom fields and a
 *   form; a project manager sets up a board with its own column mapping; a member creates and updates an item
 *   with that form; moves the workflow doesn't allow are refused by the database; dependencies show on the
 *   timeline, a late item gives a warning and the critical path; the set-up is saved as a template; a second,
 *   very different project runs next to the first; personal and shared views; a Teams document linked by its
 *   address; an Orders request linked; a rule runs and is logged; the dashboard counts only what its reader may see.
 *
 * Everything is set up through the pages (no code or SQL changes a project's configuration). The accounts exist
 * only in this browser's fake database.
 */
import { test, expect } from '@playwright/test';
import { watch, open, signUp, sql, signOut } from './helpers.mjs';

const TEST_PASS = ['pm', 'fake', 'mode', 'only', '4826'].join('-');
const ADMIN = { name: 'Ada Admin', email: 'pm-admin@ufl.edu', password: TEST_PASS };
const MANAGER = { name: 'Pat Manager', email: 'pm-manager@ufl.edu', password: TEST_PASS };
const MEMBER = { name: 'Mia Member', email: 'pm-member@ufl.edu', password: TEST_PASS };
const GUEST = { name: 'Gus Guest', email: 'pm-guest@ufl.edu', password: TEST_PASS };

const dialog = (page) => page.locator('dialog[open]');
/** On an item's page: open the status dropdown and pick a move (by the move's name, shown beside the status). */
const move = async (page, name) => {
  await page.reload();   // the page refreshes itself after a change; start from the fresh one
  await expect(page.locator('.pm-status-btn [data-ie="status"]')).toBeVisible();
  await page.waitForTimeout(400);
  await page.locator('.pm-status-btn [data-ie="status"]').click();
  await page.locator('.pm-pick-opt', { hasText: name }).click();
};
const moves = (page) => page.locator('.pm-pick-opt');
const toast = (page) => page.locator('.pm-toast');
async function signIn(page, who) {
  await signOut(page);
  await page.fill('#l-email', who.email);
  await page.fill('#l-pass', who.password);
  await page.locator('#auth-form [type="submit"]').click();
  await expect(page.locator('#auth-form')).toHaveCount(0);
}
/** Call a database function as the signed-in person, the way any script could: { data, error }. */
const rpc = (page, fn, args) => page.evaluate(async ([f, a]) => {
  const { supabase } = await import('/orders/js/supabase.js');
  const { data, error } = await supabase.rpc(f, a);
  return { data, error: error ? error.message : null };
}, [fn, args]);
const one = async (page, query, params = []) => (await sql(page, query, params))[0];
const save = (page, name = 'Save') => dialog(page).getByRole('button', { name, exact: true }).click();
/** PM_SHOTS=1 keeps pictures of the main pages in test-results/pm-shots (for looking at, not compared). */
const shot = (page, name) => (process.env.PM_SHOTS ? page.screenshot({ path: `test-results/pm-shots/${name}.png`, fullPage: true }) : null);
/** Opens a toolbar menu on the timeline (Show, Plan) if it isn't open already. */
const openPop = async (page, name) => {
  const d = page.locator(`details.pm-pop[data-pop="${name}"]`);
  if (!(await d.evaluate((n) => n.open))) await d.locator('summary').click();
  await expect(d.locator('.pm-pop-body')).toBeVisible();
};
/** The ⋯ menu on a timeline row, then one of its items. */
const rowMenu = async (page, title, item) => {
  await page.locator('.pm-g-label', { hasText: title }).locator('[data-menu]').click();
  await page.locator(`.pm-g-menu ${item}`).click();
};
/** Clicks a toolbar control; if the C1–C10 tidy-up put it under a ⋯ / ▾ menu, opens that menu first. */
const tap = async (page, sel) => {
  const el = page.locator(sel).first();
  await el.waitFor({ state: 'attached' });
  const menu = page.locator(`details:not([open]):has(${sel}) > summary`).first();
  if (!(await el.isVisible()) && (await menu.count())) await menu.click();
  await el.click();
};
/** Opens the closed menu a control sits in (C1–C10: Filter ▾, ⋯), so it can be filled in or picked. */
const reveal = async (page, sel) => {
  const el = page.locator(sel).first();
  await el.waitFor({ state: 'attached' });
  const menu = page.locator(`details:not([open]):has(${sel}) > summary`).first();
  if (!(await el.isVisible()) && (await menu.count())) await menu.click();
  return el;
};
const noOverflow = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

test.describe('projects', () => {
  test.describe.configure({ mode: 'serial' });
  /** @type {import('@playwright/test').Page} */
  let page;
  let problems;
  let itemKey;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    problems = await watch(page);
    // Everyone signs up once (the fake database lives in this page's browser); then people sign in and out.
    await signUp(page, GUEST, []);
    await signOut(page);
    await signUp(page, MEMBER, ['member']);
    await signOut(page);
    await signUp(page, MANAGER, ['member']);
    await signOut(page);
    await signUp(page, ADMIN, ['admin', 'ce']);
    // an Orders request to link to later, and a CE division with a subsystem
    await sql(page, `insert into requests (request_number, title, status) values ('SG27-777', 'Nickel strip for the pack', 'Ordered')`);
    await sql(page, `with d as (insert into org_divisions (name) values ('Electrical') returning id) insert into org_subsystems (division_id, name) select id, 'Battery' from d`);
  });
  test.afterAll(async () => page?.close());
  test.afterEach(() => {
    const found = problems.splice(0);
    expect(found).toEqual([]);
  });

  test('an Admin creates a project from a template', async () => {
    await open(page, '/projects/#/projects/all', '#new-project');
    // 072: every subsystem already has its own Space (other test files may have added subsystems); otherwise none yet
    const auto = await sql(page, `select name from pm_projects where subsystem_id is not null and archived_at is null order by name`);
    if (auto.length) for (const { name } of auto) await expect(page.locator('.pm-project-grid')).toContainText(name);
    else await expect(page.locator('.empty')).toContainText('No spaces yet');
    await page.click('#new-project');
    await dialog(page).locator('#np-name').fill('Battery Engineering');
    await expect(dialog(page).locator('#np-key')).toHaveValue('BE');
    await dialog(page).locator('#np-key').fill('BAT');
    await dialog(page).locator('#np-template').selectOption({ label: 'Simple board' });
    await dialog(page).locator('#np-sub').selectOption({ label: 'Battery' });
    await save(page, 'Create space');
    await expect(page.locator('h1')).toContainText('Battery Engineering');
    await expect(page.locator('.pm-key').first()).toHaveText('BAT');
    await expect(page.locator('.os-toast')).toContainText('Project Administrator');
    await expect(page.locator('.pm-tabs')).toContainText('Settings');
  });

  test('two custom work-item types', async () => {
    await open(page, '/projects/#/projects/p/BAT/settings/types', '[data-new-type]');
    for (const [name, icon] of [['Design Task', '✎'], ['Design Review', '☑']]) {
      await tap(page, '[data-new-type]');
      await dialog(page).locator('#ty-name').fill(name);
      await dialog(page).locator('#ty-icon').fill(icon);
      await save(page);
      await expect(page.locator('.pm-settings table')).toContainText(name);
    }
  });

  test('a workflow with its own statuses and moves, drawn, previewed and saved as a new version', async () => {
    await open(page, '/projects/#/projects/p/BAT/settings/workflows', '[data-wf-save]');
    await expect(page.locator('.pm-wf-svg .pm-wf-node')).toHaveCount(4);
    // the simple board starts as "Any order", with its statuses in To do / In progress / Done columns
    await expect(page.locator('[data-mode="free"]')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('[data-lane="doing"] [data-s-name]')).toHaveCount(2);
    await shot(page, 'workflow-start');
    const names = page.locator('[data-wf-statuses] [data-s-name]');
    for (const [n, name] of [[0, 'Draft'], [1, 'In Design'], [3, 'Released']]) {
      await names.nth(n).fill(name);
      await names.nth(n).dispatchEvent('change');
    }
    await expect(page.locator('[data-wf-rule-pick]')).toContainText('Any status → Released'); // moves follow the new names
    await tap(page, '[data-s-add="doing"]');   // goes at the end of "In progress": before Released
    await names.nth(3).fill('Approved');
    await names.nth(3).dispatchEvent('change');
    await expect(names.nth(4)).toHaveValue('Released');
    // the ↑ at the top of a column moves it into the column before; ↓ brings it back
    await page.locator('[data-lane="doing"] [data-s]').first().locator('[data-s-up]').click();
    await expect(page.locator('[data-lane="todo"] [data-s-name]')).toHaveCount(2);
    await page.locator('[data-lane="todo"] [data-s]').nth(1).locator('[data-s-down]').click();
    await expect(page.locator('[data-lane="todo"] [data-s-name]')).toHaveCount(1);
    // "Step by step": forward and back one status at a time
    await tap(page, '[data-mode="steps"]');
    await expect(page.locator('[data-wf-rule-pick] option')).toHaveCount(9);
    // "Custom": exactly these moves
    await tap(page, '[data-mode="custom"]');
    while (await page.locator('[data-wf-moves] [data-t-del]').count()) await page.locator('[data-wf-moves] [data-t-del]').first().click();
    const move = async (name, from, to, extra = async () => {}) => {
      await tap(page, '[data-t-add]');
      await dialog(page).locator('#mv-name').fill(name);
      await dialog(page).locator('#mv-from').selectOption({ label: from });
      await dialog(page).locator('#mv-to').selectOption({ label: to });
      await extra(dialog(page));
      await save(page, 'Done');
      await expect(page.locator('[data-wf-moves]')).toContainText(name);
    };
    await move('Start design', 'Draft', 'In Design');
    await move('Send for review', 'In Design', 'In Review', (d) => d.locator('[name=req][value=owner]').check());
    await move('Approve', 'In Review', 'Approved', async (d) => {
      await d.locator('[name=approval]').check();
      await d.locator('[name=noself]').check();
    });
    await move('Release', 'Approved', 'Released', async (d) => {
      await d.getByLabel('Project Manager', { exact: true }).check();
      await d.getByLabel('Project Administrator', { exact: true }).check();
      await d.locator('[name=comment]').check();
    });
    await move('Reopen', 'Any status', 'Draft');
    await expect(page.locator('.pm-wf-svg .pm-wf-node')).toHaveCount(5);
    await expect(page.locator('.pm-wf-svg .pm-wf-line.is-gate')).toHaveCount(1); // the approval gate is dashed
    await shot(page, 'workflow');
    await expect(page.locator('[data-wf-dirty]')).toHaveText('Unsaved changes');
    await tap(page, '[data-wf-save]');
    await expect(dialog(page)).toContainText('Save this workflow?');
    await save(page, 'Save as a new version');
    await expect(toast(page)).toContainText('as version 2');
    expect((await sql(page, `select s.name from pm_statuses s join pm_types t on t.workflow_id = s.workflow_id join pm_projects p on p.id = t.project_id where p.key = 'BAT' and t.name = 'Task' order by s.sort`)).map((r) => r.name))
      .toEqual(['Draft', 'In Design', 'In Review', 'Approved', 'Released']);
    await expect(page.locator('details', { hasText: 'Earlier versions' })).toContainText('Version 1');
  });

  test('custom fields, and a form for one work type with a required field', async () => {
    await open(page, '/projects/#/projects/p/BAT/settings/fields', '[data-new-field]');
    await tap(page, '[data-new-field]');
    await dialog(page).locator('#fd-name').fill('Chemistry');
    await expect(dialog(page).locator('#fd-key')).toHaveValue('chemistry');
    await dialog(page).locator('#fd-type').selectOption('select');
    await dialog(page).locator('#fd-options').fill('NMC\nLFP\nLTO');
    await save(page);
    await expect(page.locator('.pm-settings table')).toContainText('Chemistry');
    await tap(page, '[data-new-field]');
    await dialog(page).locator('#fd-name').fill('Cell count');
    await dialog(page).locator('#fd-type').selectOption('integer');
    await dialog(page).locator('#fd-min').fill('1');
    await save(page);
    await expect(page.locator('.pm-settings table')).toContainText('Cell count');
    await tap(page, '[data-new-field]');
    await dialog(page).locator('#fd-name').fill('Cells per module');
    await dialog(page).locator('#fd-type').selectOption('formula');
    await dialog(page).locator('#fd-formula').fill('cell_count / nope');
    await expect(dialog(page).locator('[data-formula-check]')).toContainText('no field with the key "nope"');
    await dialog(page).locator('#fd-formula').fill('round(cell_count / 16, 1)');
    await expect(dialog(page).locator('[data-formula-check]')).toContainText('Reads fine');
    await save(page);

    await open(page, '/projects/#/projects/p/BAT/settings/forms', '[data-save-form]');
    await page.locator('[data-form-type]').selectOption({ label: 'Design Task' });
    await expect(page.locator('.chip-tone', { hasText: 'Using the default' })).toBeVisible();
    // keep Description and Owner, add the custom fields in their own section, make Chemistry required
    for (const label of ['Priority', 'Due date', 'Parent']) await page.locator('.pm-form-fields li', { hasText: label }).first().locator('[data-f-del]').click();
    await page.locator('.pm-form-fields li', { hasText: 'Chemistry' }).locator('[data-req]').check();
    await page.locator('.pm-form-sec').nth(1).locator('[data-sec-title]').fill('Cells');
    await expect(page.locator('[data-preview]')).toContainText('Chemistry');
    await tap(page, '[data-save-form]');
    await expect(toast(page)).toContainText('Form saved');
    await expect(page.locator('.chip-tone', { hasText: 'Has its own form' })).toBeVisible();
  });

  test('the Admin adds a project manager and a contributor; the manager sets up a board with its own columns', async () => {
    await open(page, '/projects/#/projects/p/BAT/settings/people', '[data-add]');
    for (const [who, role] of [[MANAGER, 'Project Manager'], [MEMBER, 'Contributor']]) {
      await page.locator('[data-add] .pm-person-add').click();   // only people not in the project yet
      await page.locator('.pm-pick-q').fill(who.name);
      await page.locator('.pm-pick-opt', { hasText: who.name }).click();
      await page.locator('[data-add] [name=role]').selectOption({ label: role });
      await page.locator('[data-add] [type=submit]').click();
      await expect(page.locator('.pm-settings table').first()).toContainText(who.name);
    }
    await signIn(page, MANAGER);
    await open(page, '/projects/#/projects/p/BAT/board', '.kanban-col');
    await expect(page.locator('.kanban-col h2')).toHaveText(['Draft', 'In Design', 'In Review', 'Approved', 'Released']);
    // the manager can't touch workflows (their role has no "Workflows"), but can share a board
    await expect(page.locator('.pm-tabs')).toContainText('Settings');
    await tap(page, '[data-board-settings]');   // C3: under the toolbar's ⋯ menu
    const cols = dialog(page).locator('.pm-col-edit');
    await cols.nth(2).locator('[data-remove]').click(); // In Review joins In Design
    await cols.nth(1).locator('[data-col-name]').fill('Working');
    await cols.nth(1).getByLabel('In Review', { exact: true }).check();
    await cols.nth(1).locator('[data-col-wip]').fill('2');
    await save(page, 'Apply');
    await expect(page.locator('.kanban-col h2')).toHaveText(['Draft', 'Working', 'Approved', 'Released']);
    await tap(page, '[data-view-new]');
    await dialog(page).locator('#pm-view-name').fill('Design board');
    await dialog(page).getByLabel('Everyone in this space').check();
    await dialog(page).locator('[name=is_default]').check();
    await save(page);
    await expect(page.locator('[data-view-pick]')).toContainText('Design board');
    const v = await one(page, `select sharing, config from pm_views where name = 'Design board'`);
    expect(v.sharing).toBe('project');
    expect(v.config.columns.map((c) => [c.name, c.status_ids.length, c.wip])).toEqual([['Draft', 1, null], ['Working', 2, 2], ['Approved', 1, null], ['Released', 1, null]]);
  });

  test('a member creates an item with the configured form, and updates it', async () => {
    await signIn(page, MEMBER);
    await open(page, '/projects/#/projects/p/BAT/board', '[data-new-item]');
    await expect(page.locator('.kanban-col h2')).toHaveText(['Draft', 'Working', 'Approved', 'Released']); // the shared board opens first
    await expect(page.locator('.pm-tabs')).not.toContainText('Settings');
    await tap(page, '[data-new-item]');
    await dialog(page).locator('#pm-new-type').selectOption({ label: '✎ Design Task' });
    await dialog(page).locator('#pm-new-title').fill('Pack layout');
    await expect(dialog(page).locator('[data-field="cf.chemistry"]')).toContainText('*');
    await expect(dialog(page).locator('[data-field="priority"]')).toHaveCount(0); // taken off this type's form
    await save(page, 'Create');
    await expect(dialog(page)).toBeVisible(); // Chemistry is required: the form doesn't go
    await dialog(page).locator('[name="f:cf.chemistry"]').selectOption('NMC');
    // W4: optional fields wait under "More fields"; required ones (Chemistry) stay in view
    await dialog(page).locator('.pm-create-more > summary').click();
    await dialog(page).locator('[name="f:cf.cell_count"]').fill('416');
    await save(page, 'Create');
    await expect(page.locator('.kcard', { hasText: 'Pack layout' })).toBeVisible();
    itemKey = (await one(page, `select key from pm_items where title = 'Pack layout'`)).key;
    expect(itemKey).toMatch(/^BAT-\d+$/);
    // the database insists too, whatever the page shows
    const type = (await one(page, `select t.id, t.project_id from pm_types t where t.name = 'Design Task'`));
    const direct = await rpc(page, 'pm_create_item', { p_op: crypto.randomUUID(), p: { project_id: type.project_id, type_id: type.id, title: 'No chemistry' } });
    expect(direct.error).toMatch(/Fill in: Chemistry/);

    await open(page, `/projects/#/projects/item/${itemKey}`, '.pm-item-side');
    await expect(page.locator('.pm-item-side')).toContainText('NMC');
    await expect(page.locator('.pm-item-side')).toContainText('26'); // 416 / 16, the calculated field
    await expect(page.locator('[data-edit]')).toHaveCount(0); // no Edit pop-up: everything changes where it shows
    // the description: click Edit beside it, type, Ctrl+Enter
    await page.locator('[data-edit-desc]').first().click();
    await page.locator('[data-desc] textarea').fill('Lay out **16 modules** of 26 cells.\n- thermal gaps\n- busbar routing');
    await page.locator('[data-desc] textarea').press('Control+Enter');
    await expect(page.locator('[data-desc] .pm-rich strong').first()).toHaveText('16 modules');
    // the due date: click it, type a day
    await page.locator('[data-row="due_date"] [data-ie="due"]').click();
    await page.locator('.pm-pick-date input').fill('2030-03-01');   // picking a day saves it
    await expect(page.locator('[data-row="due_date"]')).toContainText('2030');
    // a custom field: click its value, type, Enter
    await page.locator('[data-edit-field="cf.cell_count"]').click();
    await page.locator('.pm-ief [name="f:cf.cell_count"]').fill('0');
    await page.locator('.pm-ief [name="f:cf.cell_count"]').press('Enter');
    await expect(page.locator('.pm-ief')).toBeVisible(); // the field's own minimum stops it in the browser…
    const low = await rpc(page, 'pm_update_item', { p_id: (await one(page, 'select id from pm_items where key = $1', [itemKey])).id, p_version: null, p: { custom: { cell_count: 0 } } });
    expect(low.error).toMatch(/can't be less than 1/); // …and the database refuses it for anyone who skips the page
    await page.locator('.pm-ief [name="f:cf.cell_count"]').fill('432');
    await page.locator('.pm-ief [name="f:cf.cell_count"]').press('Enter');
    await expect(page.locator('.pm-ief')).toHaveCount(0);
    await expect(page.locator('.pm-item-side')).toContainText('27');
    expect((await one(page, `select custom->>'chemistry' c from pm_items where key = $1`, [itemKey])).c).toBe('NMC'); // the other custom fields are kept
    // a list field saves as soon as it's picked
    await page.locator('[data-edit-field="cf.chemistry"]').click();
    await page.locator('.pm-ief [name="f:cf.chemistry"]').selectOption('LFP');
    await expect(page.locator('[data-row="cf.chemistry"]')).toContainText('LFP');
    await page.locator('[data-activity-tab="history"]').click();
    await expect(page.locator('[data-feed]')).toContainText('Changed');
    await page.locator('[data-activity-tab="comments"]').click();
    // checklist and a comment that mentions the manager
    await page.locator('[data-check-add] input').fill('Check clearances');
    await page.locator('[data-check-add] input').press('Enter');
    await expect(page.locator('.pm-checklist')).toContainText('Check clearances');
    await page.locator('[data-comment] textarea').fill(`@${MANAGER.name} can you look at the gaps?`);
    await page.locator('[data-comment] [type=submit]').click();
    await expect(page.locator('[data-feed] .pm-mention')).toHaveText(`@${MANAGER.name}`);
    await shot(page, 'item');
  });

  test('the workflow is enforced: required fields, the approval gate, and moves limited to some roles', async () => {
    const id = (await one(page, `select id from pm_items where key = $1`, [itemKey])).id;
    const tr = Object.fromEntries((await sql(page, `select t.name, t.id from pm_transitions t join pm_projects p on p.id = t.project_id where p.key = 'BAT'`)).map((r) => [r.name, r.id]));
    // straight to "Release" from Draft: the database says no, whoever asks and however
    let res = await rpc(page, 'pm_transition', { p_id: id, p_transition: tr.Release, p: { comment: 'ship it' } });
    expect(res.error).toMatch(/is now "Draft", so "Release" doesn't apply/);
    await page.locator('.pm-status-btn [data-ie="status"]').click();
    await expect(moves(page)).toHaveCount(1); // only what the workflow offers from Draft
    // "View workflow" under the list: the drawing with this item's status marked, and where it can go from here
    await page.locator('[data-view-workflow]').click();
    await expect(dialog(page).locator('.pm-wf-node.is-current')).toContainText('Draft');
    await expect(dialog(page)).toContainText('From here it can go to');
    await expect(dialog(page)).toContainText('Project Manager');   // who can change it (070)
    await shot(page, 'view-workflow');
    await dialog(page).locator('[data-cancel]').click();
    await page.locator('.pm-status-btn [data-ie="status"]').click();
    await moves(page).filter({ hasText: 'Start design' }).click();
    await expect(toast(page)).toContainText('is now "In Design"');
    // "Send for review" needs an owner: the move asks for it (new items start with their creator as owner, so take it off first)
    await sql(page, `update pm_items set owner_id = null where id = $1`, [id]);
    await open(page, `/projects/#/projects/item/${itemKey}`, '.pm-status-btn');
    await move(page, 'Send for review');
    await expect(dialog(page).locator('[data-field="owner"]')).toContainText('*');
    await dialog(page).locator('[data-field="owner"] .pm-person-add').click();   // the same "Find a person" picker as everywhere
    await page.locator('.pm-pick-q').fill(MEMBER.name);
    await page.locator('.pm-pick-opt', { hasText: MEMBER.name }).click();
    await save(page, 'Send for review');
    await expect(toast(page)).toContainText('is now "In Review"');
    // "Approve" needs someone who may approve: the member's move waits
    await move(page, 'Approve');
    await expect(toast(page)).toContainText('Asked for approval');
    await expect(page.locator('.pm-approval')).toContainText('Waiting for approval');
    expect((await one(page, `select s.name from pm_items i join pm_statuses s on s.id = i.status_id where i.id = $1`, [id])).name).toBe('In Review');
    const appr = (await one(page, `select id from pm_approvals where item_id = $1 and status = 'pending'`, [id])).id;
    res = await rpc(page, 'pm_decide_approval', { p_id: appr, p_approve: true, p_note: '' });
    expect(res.error).toMatch(/needs "Approve"/);

    // the manager approves from My work; the manager was also told about the mention
    await signIn(page, MANAGER);
    await open(page, '/projects/#/projects', '[data-approve]');
    await expect(page.locator('#pm-unread')).toBeVisible();
    await tap(page, '[data-approve]');
    await expect(toast(page)).toContainText('Approved');
    expect((await one(page, `select s.name from pm_items i join pm_statuses s on s.id = i.status_id where i.id = $1`, [id])).name).toBe('Approved');
    await open(page, '/projects/#/projects/inbox', '.pm-inbox');
    await expect(page.locator('.pm-inbox')).toContainText('You were mentioned');
    await expect(page.locator('.pm-inbox')).toContainText('Needs your approval');

    // "Release" is for managers and administrators: the member is refused by the database, the manager isn't
    await signIn(page, MEMBER);
    await open(page, `/projects/#/projects/item/${itemKey}`, '.pm-item');
    await page.locator('.pm-status-btn [data-ie="status"]').click();
    await expect(moves(page).filter({ hasText: 'Release' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    res = await rpc(page, 'pm_transition', { p_id: id, p_transition: tr.Release, p: { comment: 'ship it' } });
    expect(res.error).toMatch(/Only Project .* can make the move "Release"/);
    res = await rpc(page, 'pm_update_item', { p_id: id, p_version: null, p: { status_id: (await one(page, `select id from pm_statuses where name = 'Released'`)).id } });
    expect((await one(page, `select s.name from pm_items i join pm_statuses s on s.id = i.status_id where i.id = $1`, [id])).name).toBe('Approved');
    // and nobody writes the tables directly
    const direct = await page.evaluate(async (itemId) => {
      const { supabase } = await import('/orders/js/supabase.js');
      const r = await supabase.rpc('pmx_set_status', { p_item: itemId });
      return r.error?.message || 'no error';
    }, id);
    expect(direct).not.toBe('no error');
  });

  test('dependencies show on the timeline; a late item gives a warning and the critical path; a what-if changes nothing', async () => {
    await signIn(page, MANAGER);
    await open(page, '/projects/#/projects/p/BAT/list', '[data-new-item]');
    const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const make = async (title, start, due) => {
      await tap(page, '[data-new-item]');
      await dialog(page).locator('#pm-new-type').selectOption({ label: '☑ Design Review' });
      await dialog(page).locator('#pm-new-title').fill(title);
      await dialog(page).locator('[name="f:due_date"]').fill(due);
      await save(page, 'Create');
      await expect(page.locator('.pm-table')).toContainText(title);
      await sql(page, `update pm_items set start_date = $2 where title = $1`, [title, start]);
    };
    await make('Cell selection', day(-20), day(-6));   // should have finished a week ago
    await make('Module design', day(-5), day(5));
    await make('Pack assembly', day(6), day(12));
    const key = async (title) => (await one(page, `select key from pm_items where title = $1`, [title])).key;
    // Module design waits on Cell selection; Pack assembly waits on Module design (through the item page)
    for (const [item, other] of [['Module design', 'Cell selection'], ['Pack assembly', 'Module design']]) {
      await open(page, `/projects/#/projects/item/${await key(item)}`, '[data-add-dep]');
      await expect(page.locator('h1')).toContainText(item); // the page for this item, not the one before it
      await tap(page, '[data-add-dep]');
      await dialog(page).locator('#dep-q').fill(other);
      await expect(dialog(page).locator('[name=other] option')).toHaveCount(1);
      await dialog(page).locator('[name=other]').selectOption({ index: 0 });
      await save(page, 'Add');
      await expect(page.locator('.pm-item-main')).toContainText(`${await key(other)} · ${other}`);
    }
    // a loop is refused
    await tap(page, '[data-add-dep]');
    await dialog(page).locator('#dep-q').fill('Cell selection');
    await expect(dialog(page).locator('[name=other] option')).toHaveCount(1);
    await dialog(page).locator('[name=other]').selectOption({ index: 0 });
    await dialog(page).getByLabel(/The other item waits on/).check(); // Cell selection ← Pack assembly would close the circle
    await save(page, 'Add');
    await expect(dialog(page).locator('.alert-error')).toContainText('would make a loop');
    await dialog(page).locator('[data-cancel]').click();

    await open(page, '/projects/#/projects/p/BAT/timeline', '.pm-gantt');
    await expect(page.locator('.pm-g-bar')).toHaveCount(4);
    await expect(page.locator('.pm-g-arrow')).toHaveCount(2);
    await expect(page.locator('.pm-g-today')).toHaveCount(1);
    // simple by default: no forecast or critical path until they're turned on under Plan
    await expect(page.locator('.pm-g-bar.is-critical')).toHaveCount(0);
    await openPop(page, 'plan');
    await page.locator('[data-plan="forecast"]').check();
    await openPop(page, 'plan');
    await page.locator('[data-plan="critical"]').check();
    // Cell selection is late, so everything after it is pushed: warnings, and the chain is the critical path
    const warnings = page.locator('.pm-summary .card', { hasText: 'Schedule warnings' });
    await expect(warnings).toContainText(`${await key('Cell selection')}`);
    await expect(warnings).toContainText('after its due date');
    await expect(warnings).toContainText(`${await key('Cell selection')} finishes too late`);
    await expect(page.locator('.pm-crit li')).toHaveText([/Cell selection/, /Module design/, /Pack assembly/]);
    await expect(page.locator('.pm-g-bar.is-critical')).toHaveCount(3);
    await expect(page.locator('.pm-g-late').first()).toBeVisible();
    await shot(page, 'timeline');
    // a what-if: give Module design two more weeks; the plan shows the effect but nothing is saved
    const before = await one(page, `select due_date::text d from pm_items where title = 'Module design'`);
    await openPop(page, 'plan');
    await page.locator('[data-plan="whatIf"]').check();
    await rowMenu(page, 'Module design', '[data-dates]');
    await dialog(page).locator('#gd-due').fill(day(19));
    await save(page, 'Try these dates');
    await expect(page.locator('.pm-whatif')).toContainText('Nothing is saved yet');
    await expect(page.locator('.pm-whatif')).toContainText(await key('Pack assembly'));
    expect((await one(page, `select due_date::text d from pm_items where title = 'Module design'`)).d).toBe(before.d);
    // a baseline, then apply the what-if: now it's saved, with history, and the baseline still shows the old plan
    await tap(page, '[data-discard]');
    await openPop(page, 'plan');
    await tap(page, '[data-save-baseline]');
    await dialog(page).locator('#ask-text').fill('Plan of record');
    await dialog(page).getByRole('button', { name: 'Save' }).click();
    await expect(toast(page)).toContainText('Baseline saved');
    await rowMenu(page, 'Module design', '[data-dates]');
    await dialog(page).locator('#gd-due').fill(day(19));
    await save(page, 'Try these dates');
    await tap(page, '[data-apply]');
    await dialog(page).locator('#ask-text').fill('Cells arrived late');
    await dialog(page).getByRole('button', { name: 'Apply to the plan' }).click();
    await expect(toast(page)).toContainText('Rescheduled 1 item');
    expect((await one(page, `select due_date::text d from pm_items where title = 'Module design'`)).d).toBe(day(19));
    await openPop(page, 'plan');
    await page.locator('[data-baseline]').selectOption({ index: 1 });
    await expect(page.locator('.pm-g-baseline')).toHaveCount(4);
    await openPop(page, 'plan');
    await page.locator('[data-plan="whatIf"]').uncheck();
    // 062: click a bar for its details panel; save a change there, then Undo puts it back
    const pack = (await one(page, `select id from pm_items where title = 'Pack assembly'`)).id;
    await page.locator(`.pm-g-bar[data-bar="${pack}"]`).click();
    await expect(page.locator('.pm-g-panel [data-panel-title]')).toHaveValue('Pack assembly');
    // each field saves when it's changed: progress through its picker
    await page.locator('.pm-g-panel [data-ie="progress"]').click();
    await page.locator('.pm-pick-num input').fill('40');
    await page.locator('.pm-pick-num button').click();
    await expect(toast(page)).toContainText('progress changed');
    await expect.poll(async () => (await one(page, `select progress from pm_items where title = 'Pack assembly'`)).progress).toBe(40);
    // present: the chart as a slide
    await tap(page, '[data-present]');
    await expect(page.locator('.pm-present-chart svg')).toBeVisible();
    await expect(page.locator('.pm-present-chart svg')).toContainText('WORK PACKAGE');
    await shot(page, 'timeline-present');
    await tap(page, '[data-present-exit]');
    await expect(page.locator('.pm-gantt')).toBeVisible();
    // light / dark follows the site's own setting (account menu), not a separate switch
    await expect(page.locator('[data-g-theme]')).toHaveCount(0);
    const bg = () => page.locator('.pm-gantt').evaluate((n) => getComputedStyle(n).backgroundColor);
    const light = await bg();
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await expect.poll(bg).not.toBe(light);
    await shot(page, 'timeline-dark');
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
    await noOverflow(page);

    // Zoom: the chart fills the page's width; presets, − / +, and Fit
    const chart = () => page.locator('[data-scroll]').evaluate((n) => ({ w: n.clientWidth, full: n.scrollWidth, left: n.scrollLeft }));
    const pane = await page.locator('.pm-gantt').evaluate((n) => n.clientWidth);
    await page.selectOption('[data-zoom-pick]', '0.9');
    await expect(page.locator('[data-zoom-pick] option:checked')).toHaveText('Year');
    await expect(page.locator('.pm-g-right .pm-g-month').first()).toHaveText(/^20\d\d$/);   // years over months
    // names that don't fit in their bar sit beside it, in the same row and inside the chart
    await openPop(page, 'show');
    await page.check('[data-show="labels"]');
    await expect.poll(() => page.locator('.pm-g-right .pm-g-barlabel.is-out').count()).toBeGreaterThan(0);
    const outside = await page.locator('.pm-g-right .pm-g-barlabel.is-out').evaluateAll((ls) => ls.map((l) => {
      const r = l.getBoundingClientRect();
      const box = l.offsetParent.getBoundingClientRect();
      const row = parseFloat(getComputedStyle(l.offsetParent).getPropertyValue('--row')) || parseFloat(l.style.height);
      return { inRow: r.height <= row + 1, inChart: r.left >= box.left - 1 && r.right <= box.left + l.offsetParent.scrollWidth + 1 };
    }));
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.filter((o) => !o.inRow || !o.inChart)).toEqual([]);
    await openPop(page, 'show');
    await page.uncheck('[data-show="labels"]');
    await expect(page.locator('.pm-g-right .pm-g-barlabel')).toHaveCount(0);
    await expect.poll(async () => (await chart()).w).toBeGreaterThan(pane - 400);   // not the old 900-pixel guess
    await tap(page, '[data-zoom-step="1"]');
    await expect(page.locator('[data-zoom-pick] option:checked')).toHaveText(/Custom|Fitted/);   // between presets
    await page.selectOption('[data-zoom-pick]', '40');
    await expect(page.locator('[data-zoom-pick] option:checked')).toHaveText('Days');
    await expect(page.locator('.pm-g-wk.is-day').first()).toBeVisible();
    await tap(page, '[data-pop=fit] summary');
    await tap(page, '[data-fit="all"]');
    await expect(page.locator('[data-pop=fit] summary')).toContainText('Everything shown');
    await expect.poll(async () => { const c = await chart(); return c.full - c.w - c.left; }).toBeLessThanOrEqual(2);   // the work, to its end, with no scrolling
    await tap(page, '[data-pop=fit] summary');
    await page.fill('[data-fit-from]', '2027-01-01');
    await page.fill('[data-fit-to]', '2027-03-31');
    await tap(page, '[data-fit-custom]');
    await expect(page.locator('[data-pop=fit] summary')).toContainText('Fit:');
    await page.selectOption('[data-zoom-pick]', '18');   // back to Weeks for the tests after this one
    await expect(page.locator('[data-zoom-pick] option:checked')).toHaveText('Weeks');

    // Rows: group by status, order by start date, pack rows; the row under the mouse lights up on both sides
    const rowCount = () => page.locator('.pm-g-left .pm-g-label').count();
    const rowsBefore = await rowCount();
    await openPop(page, 'rows');
    await page.selectOption('[data-group-by]', 'status');
    await expect(page.locator('.pm-g-label.is-group-by').first()).toBeVisible();
    await openPop(page, 'rows');
    await page.selectOption('[data-sort-by]', 'start');
    await openPop(page, 'rows');
    await page.check('[data-row-opt="pack"]');
    await expect(page.locator('[data-pop=rows] summary')).toContainText('•');
    expect(await rowCount()).toBeLessThanOrEqual(rowsBefore + 3);   // a header per status, fewer rows of work
    await shot(page, 'timeline-rows');
    await page.locator('.pm-g-left [data-ri="1"]').hover();
    await expect(page.locator('.pm-g-body [data-ri="1"]')).toHaveClass(/is-hover/);
    await openPop(page, 'rows');
    await page.uncheck('[data-row-opt="pack"]');
    await openPop(page, 'rows');
    await page.selectOption('[data-sort-by]', 'rank');
    await openPop(page, 'rows');
    await page.selectOption('[data-group-by]', 'structure');
    await expect(page.locator('.pm-g-label.is-group-by')).toHaveCount(0);
    await expect.poll(rowCount).toBe(rowsBefore);
  });

  test('backlog, calendar and the board all show the same items; the board makes real workflow moves', async () => {
    await open(page, '/projects/#/projects/p/BAT/backlog', '.pm-bl');
    await expect(page.locator('.pm-bl-row')).toHaveCount(4); // everything that isn't finished: Pack layout (Approved) and the three reviews
    await open(page, '/projects/#/projects/p/BAT/calendar', '.pm-cal');
    await shot(page, 'calendar');
    await page.locator('[data-mode=agenda]').click();
    await expect(page.locator('.pm-agenda')).toContainText('Pack assembly');
    await open(page, '/projects/#/projects/p/BAT/board', '.kanban');
    const card = page.locator('.kcard', { hasText: 'Module design' });
    await expect(page.locator('.kanban-col').nth(0)).toContainText('Module design');
    // the card's ⋯ menu (what phones and keyboards use instead of dragging) offers only the workflow's moves from Draft
    await card.locator('[data-card-menu]').click();
    await expect(page.locator('.pm-float-menu button', { hasText: 'Move to' })).toHaveText(['Move to In Design']);
    await page.locator('.pm-float-menu button', { hasText: 'Move to In Design' }).click();
    await expect(toast(page)).toContainText('is now "In Design"');
    await expect(page.locator('.kanban-col').nth(1)).toContainText('Module design');
    // dragging to a column the workflow has no move to is refused with the reason
    await page.locator('.kcard', { hasText: 'Pack assembly' }).dragTo(page.locator('.kanban-col').nth(3).locator('[data-drop]'));
    await expect(toast(page)).toContainText('the workflow has no move from "Draft" to "Released"');
    await expect(page.locator('.kanban-col').nth(0)).toContainText('Pack assembly');
    // dragging along an allowed move works
    await page.locator('.kcard', { hasText: 'Pack assembly' }).dragTo(page.locator('.kanban-col').nth(1).locator('[data-drop]'));
    await expect(toast(page)).toContainText('is now "In Design"');
    await expect(page.locator('.kanban-col').nth(1).locator('.kcard')).toHaveCount(2);
    await shot(page, 'board');
    // swimlanes
    await page.locator('[data-lane]').selectOption('owner');
    await expect(page.locator('.pm-lane')).not.toHaveCount(0);
    await page.locator('[data-lane]').selectOption('');
    // W1: a card opens over the board (the address says which), and Esc goes back to the board
    await page.locator('.kcard', { hasText: 'Pack assembly' }).locator('.kcard-name').click();
    await expect(page.locator('.peek h1')).toContainText('Pack assembly');
    await expect(page).toHaveURL(/\/board\?item=BAT-\d+$/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.peek')).toHaveCount(0);
    await expect(page).toHaveURL(/\/board$/);
  });

  test('change things where they show, with Undo; add with a title; change several at once; Ctrl+K and the shortcuts', async () => {
    const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    const item = (title) => one(page, `select id, key, owner_id, due_date::text due, priority, archived_at from pm_items where title = $1`, [title]);
    await open(page, '/projects/#/projects/p/BAT/list', '.pm-table');
    const row = (title) => page.locator('.pm-table tr', { hasText: title });
    // owner: click it, pick a person; it's saved at once, and Undo puts it back
    const before = await item('Module design');
    const mia = (await one(page, `select id from profiles where full_name = 'Mia Member'`)).id;
    await row('Module design').locator('[data-ie="owner"]').click();
    await page.locator('.pm-pick-q').fill('Mia');
    await page.locator('.pm-pick-opt', { hasText: 'Mia Member' }).click();
    await expect(row('Module design').locator('[data-ie="owner"]')).toContainText('Mia Member');   // on the page straight away
    await expect(toast(page)).toContainText('owner changed to Mia Member');
    await expect.poll(async () => (await item('Module design')).owner_id).toBe(mia);
    await page.locator('.pm-toast-undo').click();
    await expect.poll(async () => (await item('Module design')).owner_id).toBe(before.owner_id);
    // due date: the common choices are one click
    const dueBefore = (await item('Pack assembly')).due;
    await row('Pack assembly').locator('[data-ie="due"]').click();
    await page.locator('.pm-pick-opt', { hasText: 'In two weeks' }).click();
    await expect.poll(async () => (await item('Pack assembly')).due).not.toBe(dueBefore);
    expect(Math.abs(Date.parse((await item('Pack assembly')).due) - Date.parse(day(14)))).toBeLessThanOrEqual(864e5);   // two weeks from today (local day)
    await page.locator('.pm-toast-undo').click();
    await expect.poll(async () => (await item('Pack assembly')).due).toBe(dueBefore);
    // quick add: a title and Enter; I'm its owner; Undo takes it away again
    await page.locator('.pm-qa input[type="text"]').fill('Busbar torque check');
    await page.locator('.pm-qa input[type="text"]').press('Enter');
    await expect(toast(page)).toContainText('Added BAT-');
    const added = await item('Busbar torque check');
    expect(added.owner_id).toBe((await one(page, `select id from profiles where full_name = 'Pat Manager'`)).id);
    await expect(row('Busbar torque check')).toBeVisible();
    await page.locator('.pm-toast-undo').click();
    await expect.poll(async () => !!(await item('Busbar torque check')).archived_at).toBe(true);
    // several at once: tick two, the bar appears, change their priority
    await expect(row('Module design')).toBeVisible();
    await row('Module design').locator('[data-select]').check();
    await row('Pack assembly').locator('[data-select]').check();
    await expect(page.locator('.pm-bulkbar')).toContainText('2 selected');
    await page.locator('.pm-bulkbar [data-b="priority"]').click();
    await page.locator('.pm-pick-opt', { hasText: 'High' }).click();
    await expect(toast(page)).toContainText('Changed 2 items');
    await expect.poll(async () => (await item('Pack assembly')).priority).toBe('high');
    await expect(page.locator('.pm-bulkbar')).toBeHidden();
    await row('Module design').locator('[data-select]').check();
    await row('Pack assembly').locator('[data-select]').check();
    await page.locator('.pm-bulkbar [data-b="priority"]').click();
    await page.locator('.pm-pick-opt', { hasText: 'Medium' }).click();
    await expect.poll(async () => (await item('Module design')).priority).toBe('medium');
    // a shortcut on the row under the mouse: P opens its priority
    await row('Cell selection').hover();
    await page.keyboard.press('p');
    await expect(page.locator('.pm-pick')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.pm-pick')).toHaveCount(0);
    // ? lists the shortcuts
    await page.keyboard.press('?');
    await expect(dialog(page)).toContainText('Keyboard shortcuts');
    await dialog(page).locator('[data-cancel]').click();
    // Ctrl+K: type an item's name, Enter opens it
    await page.keyboard.press('Control+k');
    await expect(page.locator('.pm-cmd')).toBeVisible();
    await page.locator('.pm-cmd-q').fill('Pack assembly');
    await expect(page.locator('.pm-cmd-row', { hasText: 'Pack assembly' })).toBeVisible();
    await page.locator('.pm-cmd-row', { hasText: 'Pack assembly' }).first().click();
    await expect(page).toHaveURL(/#\/projects\/item\/BAT-/);
    await expect(page.locator('h1')).toContainText('Pack assembly');
    // on the item page: the title renames in place, the due date is a click away
    await page.locator('[data-rename-title]').click();
    await page.locator('.pm-title-input').fill('Pack assembly (v2)');
    await page.locator('.pm-title-input').press('Enter');
    await expect(toast(page)).toContainText('title changed');
    await expect.poll(async () => !!(await item('Pack assembly (v2)'))?.id).toBe(true);
    await page.locator('.pm-toast-undo').click();
    await expect.poll(async () => !!(await item('Pack assembly'))?.id).toBe(true);
    await noOverflow(page);
  });

  test('a document is linked by pasting its Teams address; an Orders request is linked and shows its status', async () => {
    await open(page, `/projects/#/projects/item/${itemKey}`, '.pm-key');
    await expect(page.locator('.pm-key')).toHaveText(itemKey);   // the last test ended on another item's page (same document, so its button shows at once)
    await tap(page, '[data-add-doc]');
    const url = 'https://uflorida.sharepoint.com/:x:/r/sites/SolarGators/Shared%20Documents/Battery/Pack_sizing-v3.xlsx?d=wabc&csf=1&web=1';
    await dialog(page).locator('#doc-url').fill('javascript:alert(1)');
    await expect(dialog(page).locator('[data-read]')).toContainText('Only https:// links');
    await dialog(page).locator('#doc-url').fill(url);
    await expect(dialog(page).locator('[data-read]')).toContainText('SharePoint');
    await expect(dialog(page).locator('#doc-title')).toHaveValue('Pack sizing v3');
    await expect(dialog(page).locator('#doc-cat')).toHaveValue('Analysis');
    await save(page, 'Link it');
    const link = page.locator('.pm-docs a.pm-doc');
    await expect(link).toHaveAttribute('href', url);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    // the document library
    await open(page, '/projects/#/projects/p/BAT/docs', '.pm-table');
    await expect(page.locator('.pm-table')).toContainText('Pack sizing v3');
    await expect(page.locator('.pm-table')).toContainText(itemKey);

    await open(page, `/projects/#/projects/item/${itemKey}`, '.pm-key');
    await tap(page, '[data-add-ref]');   // V1: one "A record from another app", the kind picked inside
    await dialog(page).locator('[data-ref-kind="order"]').click();
    await dialog(page).locator('#ref-q').fill('nickel');
    await expect(dialog(page).locator('[name=ref] option')).toHaveCount(1);
    await dialog(page).locator('[name=ref]').selectOption({ index: 0 });
    await save(page, 'Link it');
    const refs = page.locator('.card.pm-links');   // C2: "Links & files" holds records from other apps too
    await expect(refs).toContainText('SG27-777 · Nickel strip for the pack');
    await expect(refs.locator('.chip-tone')).toHaveText('Ordered');
    expect((await one(page, `select status from requests where request_number = 'SG27-777'`)).status).toBe('Ordered'); // Orders is untouched
  });

  test('a rule runs when its trigger happens, and the run is logged', async () => {
    await open(page, '/projects/#/projects/p/BAT/settings/rules', '[data-new-rule]');
    await tap(page, '[data-new-rule]');
    await dialog(page).locator('#ru-name').fill('In review → tell the manager');
    await dialog(page).locator('[name=trigger]').selectOption('status');
    await dialog(page).locator('[name=to]').selectOption({ label: 'In Review' });
    await dialog(page).locator('[data-k=to]').selectOption('lead');
    await dialog(page).locator('[data-k=message]').fill('{key} is ready for review');
    await dialog(page).locator('[data-add-action]').click();
    await dialog(page).locator('[data-a="1"][data-k=type]').selectOption('add_label');
    await dialog(page).locator('[data-a="1"][data-k=label]').fill('in-review');
    await dialog(page).locator('[data-try]').click();
    await expect(dialog(page).locator('[data-try-out]')).toContainText('match the conditions right now');
    await save(page);
    await expect(page.locator('.pm-settings table').first()).toContainText('In review → tell the manager');
    expect((await one(page, `select count(*)::int c from pm_automation_runs`)).c).toBe(0);

    const key = (await one(page, `select key from pm_items where title = 'Module design'`)).key;
    await sql(page, `update pm_items set owner_id = (select id from profiles where email = $1) where key = $2`, [MEMBER.email, key]);
    await open(page, `/projects/#/projects/item/${key}`, '.pm-status-btn');
    await move(page, 'Send for review');
    await expect(toast(page)).toContainText('is now "In Review"');
    await expect(page.locator('.pm-item-side')).toContainText('in-review');
    await open(page, '/projects/#/projects/p/BAT/settings/rules', '[data-new-rule]');
    const log = page.locator('.card', { hasText: 'Run log' });
    await expect(log).toContainText('Ran');
    await expect(log).toContainText('notified; labelled in-review');
  });

  test('the set-up is saved as a template; a project made from it works the same; a second, different project runs independently', async () => {
    await signIn(page, ADMIN);
    await open(page, '/projects/#/projects/p/BAT/settings/templates', '[data-save-template]');
    await tap(page, '[data-save-template]');
    await dialog(page).locator('#st-name').fill('Battery design process');
    await save(page, 'Save template');
    await expect(toast(page)).toContainText('Template saved');

    await open(page, '/projects/#/projects/templates', '.pm-template');
    await expect(page.locator('.pm-template', { hasText: 'Battery design process' })).toBeVisible();
    await page.locator('.pm-template', { hasText: 'Battery design process' }).locator('[data-use]').click();
    await dialog(page).locator('#np-name').fill('Battery v2');
    await dialog(page).locator('#np-key').fill('BAT2');
    await save(page, 'Create space');
    await expect(page.locator('h1')).toContainText('Battery v2');
    await open(page, '/projects/#/projects/p/BAT2/board', '.kanban-col');
    await expect(page.locator('.kanban-col h2')).toHaveText(['Draft', 'Working', 'Approved', 'Released']); // the shared board came too, on its own statuses
    await tap(page, '[data-new-item]');
    await dialog(page).locator('#pm-new-type').selectOption({ label: '✎ Design Task' });
    await expect(dialog(page).locator('[data-field="cf.chemistry"]')).toContainText('*');
    await dialog(page).locator('[data-cancel]').click();

    // a very different project from another template
    await open(page, '/projects/#/projects/all', '#new-project');
    await page.click('#new-project');
    await dialog(page).locator('#np-name').fill('Aerobody Manufacturing');
    await dialog(page).locator('#np-key').fill('AERO');
    await dialog(page).locator('#np-template').selectOption({ label: 'Manufacturing' });
    await save(page, 'Create space');
    await expect(page.locator('h1')).toContainText('Aerobody Manufacturing');
    await open(page, '/projects/#/projects/p/AERO/board', '.kanban-col');
    await expect(page.locator('.kanban-col h2')).toHaveText(['Planned', 'Material Ready', 'In Manufacturing', 'Inspection', 'Complete']);
    await tap(page, '[data-new-item]');
    await dialog(page).locator('#pm-new-type').selectOption({ label: '⚙ Manufacturing Job' });
    await dialog(page).locator('#pm-new-title').fill('Top shell mold');
    await expect(dialog(page).locator('.pm-create-more > summary')).toContainText('More fields');
    await dialog(page).locator('.pm-create-more > summary').click();
    await expect(dialog(page).locator('[data-field="cf.process"]')).toBeVisible();
    await expect(dialog(page).locator('[data-field="cf.chemistry"]')).toHaveCount(0);
    await save(page, 'Create');
    const card = page.locator('.kcard', { hasText: 'Top shell mold' });
    await card.locator('[data-card-menu]').click();
    await expect(page.locator('.pm-float-menu button', { hasText: 'Move to' })).toHaveText(['Move to Material Ready']);
    await page.keyboard.press('Escape');
    // neither project changed the other
    const statuses = async (k) => (await sql(page, `select s.name from pm_statuses s join pm_projects p on p.id = s.project_id where p.key = $1 order by s.sort`, [k])).map((r) => r.name);
    expect(await statuses('BAT')).toEqual(['Draft', 'In Design', 'In Review', 'Approved', 'Released']);
    expect(await statuses('BAT2')).toEqual(['Draft', 'In Design', 'In Review', 'Approved', 'Released']);
    expect((await one(page, `select count(*)::int c from pm_statuses a join pm_statuses b on a.id = b.id join pm_projects p on p.id = a.project_id join pm_projects q on q.id = b.project_id where p.key = 'BAT' and q.key = 'BAT2'`)).c).toBe(0);

    // bring one part of a template into the running Aerobody project, after a preview
    await open(page, '/projects/#/projects/p/AERO/settings/templates', '[data-apply]');
    await page.locator('[data-from]').selectOption({ label: 'Battery design process' });
    await tap(page, '[data-apply]');
    for (const part of ['types', 'workflows']) await dialog(page).locator(`[name=part][value=${part}]`).uncheck();
    await save(page, 'Preview');
    await expect(dialog(page).locator('[data-preview]')).toContainText('Chemistry');
    expect((await one(page, `select count(*)::int c from pm_fields f join pm_projects p on p.id = f.project_id where p.key = 'AERO' and f.key = 'chemistry'`)).c).toBe(0);
    await save(page, 'Apply these changes');
    await expect(toast(page)).toContainText('Applied');
    expect((await one(page, `select count(*)::int c from pm_fields f join pm_projects p on p.id = f.project_id where p.key = 'AERO' and f.key in ('chemistry', 'process')`)).c).toBe(2);
    expect(await statuses('AERO')).toEqual(['Planned', 'Material Ready', 'In Manufacturing', 'Inspection', 'Complete']);
  });

  test('a personal view stays personal; the shared board is everyone\'s; lists page and filter', async () => {
    await signIn(page, MEMBER);
    await open(page, '/projects/#/projects/p/BAT/list', '[data-view-pick]');
    await (await reveal(page, '[data-f=priority]')).selectOption('medium');
    await page.locator('[data-f=q]').fill('design');
    await expect(page.locator('.pm-table tbody tr')).toHaveCount(1);
    await tap(page, '[data-more-filters]');
    await dialog(page).locator('[data-field-pick]').selectOption('cf.chemistry');
    await save(page, 'Apply');
    await expect(page.locator('.empty')).toContainText('No items match'); // "Module design" has no chemistry
    await tap(page, '[data-clear-filters]');
    await page.locator('[data-f=owner]').selectOption('me');
    await tap(page, '[data-view-new]');
    await dialog(page).locator('#pm-view-name').fill('Mine in Battery');
    await expect(dialog(page).getByLabel('Everyone in this space')).toHaveCount(0); // a contributor can't share with the project
    await save(page);
    await expect(page.locator('[data-view-pick]')).toContainText('Mine in Battery');
    expect((await one(page, `select sharing from pm_views where name = 'Mine in Battery'`)).sharing).toBe('private');
    await signIn(page, MANAGER);
    await open(page, '/projects/#/projects/p/BAT/list', '[data-view-pick]');
    await expect(page.locator('[data-view-pick]')).not.toContainText('Mine in Battery');
    await open(page, '/projects/#/projects/p/BAT/board', '[data-view-pick]');
    await expect(page.locator('[data-view-pick]')).toContainText('Design board');
    // My work, on a phone
    await page.setViewportSize({ width: 390, height: 800 });
    await open(page, '/projects/#/projects', '.pm-head');
    await noOverflow(page);
    await shot(page, 'mywork-phone');
    await open(page, '/projects/#/projects/p/BAT/board', '.kanban');
    await noOverflow(page);
    await open(page, `/projects/#/projects/item/${itemKey}`, '.pm-item');
    await noOverflow(page);
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  test('the dashboard counts only what its reader may see; a guest gets nothing', async () => {
    // the Admin makes a private project with an item in it
    await signIn(page, ADMIN);
    await open(page, '/projects/#/projects/all', '#new-project');
    await page.click('#new-project');
    await dialog(page).locator('#np-name').fill('Sponsor talks');
    await dialog(page).locator('#np-key').fill('SEC');
    await dialog(page).locator('#np-vis').selectOption('private');
    await save(page, 'Create space');
    await expect(page.locator('h1')).toContainText('Sponsor talks');
    await tap(page, '[data-new-item]');
    await dialog(page).locator('#pm-new-title').fill('Confidential offer');
    await save(page, 'Create');
    await open(page, '/projects/#/projects/dashboards', '.pm-dash');
    const projects = page.locator('.pm-widget', { hasText: 'Spaces: progress' });
    await expect(projects).toContainText('Sponsor talks');
    await expect(projects).toContainText('Battery Engineering');
    await expect(page.locator('.pm-widget', { hasText: 'Progress by CE division' })).toContainText('Battery');
    await expect(page.locator('.pm-widget', { hasText: 'Schedule slippage' })).toContainText('Battery Engineering');
    await shot(page, 'dashboard');
    const adminOpen = Number(await page.locator('.pm-big span').first().locator('strong').textContent());
    await open(page, '/projects/#/projects/dashboards/review', '.pm-review');
    await expect(page.locator('.pm-review')).toContainText('Dates that moved');
    await expect(page.locator('.pm-review .card', { hasText: 'Dates that moved' })).toContainText('Module design');
    await open(page, '/projects/#/projects/dashboards/workload', '.pm-load');
    await expect(page.locator('.pm-load')).toContainText(MEMBER.name);

    await signIn(page, MEMBER);
    await open(page, '/projects/#/projects/dashboards', '.pm-dash');
    await expect(page.locator('.pm-widget', { hasText: 'Spaces: progress' })).toContainText('Battery Engineering');
    await expect(page.locator('#app')).not.toContainText('Sponsor talks');
    expect(Number(await page.locator('.pm-big span').first().locator('strong').textContent())).toBe(adminOpen - 1);
    await open(page, '/projects/#/projects/all', '.pm-project');
    await expect(page.locator('#app')).not.toContainText('Sponsor talks');
    await page.goto('/projects/#/projects/p/SEC');
    await expect(page.locator('.no-access')).toContainText('No space "SEC"');
    const rows = await page.evaluate(async () => {
      const { supabase } = await import('/orders/js/supabase.js');
      const [items, search] = await Promise.all([supabase.from('pm_items').select('title').eq('title', 'Confidential offer'), supabase.rpc('pm_search', { p: { q: 'Confidential' } })]);
      return [items.data.length, search.data.total];
    });
    expect(rows).toEqual([0, 0]);

    await signIn(page, GUEST);
    await page.goto('/projects/#/projects/all');
    await expect(page.locator('.no-access')).toContainText('Almost in');
    const guest = await rpc(page, 'pm_search', { p: {} });
    expect(guest.error).toMatch(/accepted/);
    expect(await page.evaluate(async () => {
      const { supabase } = await import('/orders/js/supabase.js');
      return (await supabase.from('pm_projects').select('id')).data.length;
    })).toBe(0);
  });

  test('share with alumni (052): a project manager shares a draft; the hub\'s editor sees where it came from; a project is shared and unshared', async () => {
    // The project manager can edit the item but not the alumni hub: it goes to the hub as a draft.
    await signIn(page, MANAGER);
    await open(page, `/projects/#/projects/item/${itemKey}`, '.pm-item');
    await expect(page.locator('[data-alumni-card]')).toHaveCount(0);   // not shared yet: it's in the ⋯ menu
    await page.locator('.pm-more > summary').click();
    page.once('dialog', (d) => d.accept());
    await page.locator('[data-share-alumni]').click();
    await expect(toast(page)).toContainText('Shared with alumni');
    await expect(page.locator('[data-alumni-card]')).toContainText('a draft (not public yet)');
    await expect(page.locator('[data-alumni-card] a')).toHaveCount(0);   // drafts aren't on the hub for them
    // Someone who can only see the project gets no card: the team's view-only role on AERO.
    await signIn(page, MEMBER);
    const aeroItem = (await one(page, `select key from pm_items where title = 'Top shell mold'`)).key;
    const aeroId = (await one(page, `select id from pm_projects where key = 'AERO'`)).id;
    expect((await rpc(page, 'pm_my_caps', {})).data[aeroId]).not.toContain('edit');
    await open(page, `/projects/#/projects/item/${aeroItem}`, '.pm-item-side');
    await expect(page.locator('[data-alumni-card]')).toHaveCount(0);
    expect((await rpc(page, 'sgaa_share_from_projects', { p_project: null, p_item: (await one(page, `select id from pm_items where key = $1`, [aeroItem])).id, p_on: true })).error).toMatch(/can't share this/);

    // An Admin ("Edit the alumni hub") goes from the item to the need, which links back.
    await signIn(page, ADMIN);
    await open(page, `/projects/#/projects/item/${itemKey}`, '[data-alumni-card]');
    await tap(page, '[data-alumni-card] a:has-text("Edit it on the alumni hub")');
    await expect(page.locator('form[data-form="need"] .alert-info')).toContainText(`Shared from Workbench: ${itemKey} · Pack layout`);
    await expect(page.locator('form[data-form="need"] .alert-info a')).toHaveAttribute('href', new RegExp(`projects/#/projects/item/${itemKey}$`));
    await open(page, '/sgaa/#/manage/needs', 'table');
    await expect(page.locator('tr', { hasText: 'Pack layout' })).toContainText('From Workbench');

    // Shared by an editor, a whole project goes up as public; stopping takes it off again (archived once public).
    const aero = `select n.status from sgaa_needs n join pm_projects p on p.id = n.pm_project_id where p.key = 'AERO' and n.pm_item_id is null`;
    await open(page, '/projects/#/projects/p/AERO', '[data-alumni-card]');
    await tap(page, '[data-alumni-share="1"]');
    await expect(page.locator('[data-alumni-card]')).toContainText('public');
    expect(await one(page, aero)).toEqual({ status: 'open' });
    page.once('dialog', (d) => d.accept());
    await tap(page, '[data-alumni-share="0"]');
    await expect(page.locator('[data-alumni-share="1"]')).toBeVisible();
    expect(await one(page, aero)).toEqual({ status: 'archived' });
  });

  test('planning in the Gantt: add an item and things under it, nest and un-nest them, and they show in List', async () => {
    const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
    await signIn(page, ADMIN);
    await open(page, '/projects/#/projects/p/AERO/timeline', '.pm-g-toolbar');
    await page.locator('.pm-g-toolbar [data-add-root]').click();
    await dialog(page).locator('#ga-kind').selectOption({ index: 0 });   // the highest level first
    await dialog(page).locator('#ga-title').fill('Wind tunnel campaign');
    await dialog(page).locator('#ga-start').fill(day(2));
    await dialog(page).locator('#ga-due').fill(day(30));
    await save(page, 'Add');
    const top = page.locator('.pm-g-label', { hasText: 'Wind tunnel campaign' });
    await expect(top).toBeVisible();
    for (const [title, a, z] of [['Scale model', 2, 10], ['Test runs', 11, 20]]) {
      await rowMenu(page, 'Wind tunnel campaign', '[data-add-child]');
      await dialog(page).locator('#ga-title').fill(title);
      await dialog(page).locator('#ga-start').fill(day(a));
      await dialog(page).locator('#ga-due').fill(day(z));
      await save(page, 'Add');
      await expect(page.locator('.pm-g-label', { hasText: title })).toBeVisible();
    }
    const parentOf = (title) => one(page, `select (select title from pm_items p where p.id = i.parent_id) parent from pm_items i where title = $1`, [title]);
    expect(await parentOf('Test runs')).toEqual({ parent: 'Wind tunnel campaign' });
    // its own dates hold what's under it: one outlined parent bar, no second bracket under it
    await expect(page.locator('.pm-g-bar.is-parent')).toHaveCount(1);
    await expect(page.locator('.pm-g-sum')).toHaveCount(0);
    await rowMenu(page, 'Test runs', '[data-outdent]');
    await expect(toast(page)).toContainText('moved out a level');
    expect(await parentOf('Test runs')).toEqual({ parent: null });
    // 061: rename in place; an undated item gets its dates by drawing on its row (a what-if, then Apply)
    await page.locator('.pm-g-label', { hasText: 'Test runs' }).locator('[data-rename]').dblclick();
    await page.locator('.pm-g-rename').fill('Test runs (tunnel)');
    await page.locator('.pm-g-rename').press('Enter');
    await expect(toast(page)).toContainText('Renamed');
    await expect(page.locator('.pm-g-label', { hasText: 'Test runs (tunnel)' })).toBeVisible();
    await page.locator('.pm-g-toolbar [data-add-root]').click();
    await dialog(page).locator('#ga-title').fill('Data review');
    await dialog(page).locator('#ga-start').fill('');
    await dialog(page).locator('#ga-due').fill('');
    await save(page, 'Add');
    await expect(page.locator('.pm-g-label', { hasText: 'Data review' })).toBeVisible();
    await tap(page, '[data-filters]');
    await page.locator('[data-opt="undated"]').check();
    const { id } = await one(page, `select id from pm_items where title = 'Data review'`);
    const row = page.locator(`.pm-g-row[data-draw="${id}"]`);
    await expect(row).toHaveCount(1);
    const box = await row.boundingBox();
    await page.mouse.move(box.x + 200, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    // 062: drawing saves straight away, with an Undo
    await expect(page.locator('.pm-toast-undo')).toBeVisible();
    await expect.poll(() => one(page, `select start_date is not null and due_date > start_date as ok from pm_items where title = 'Data review'`)).toEqual({ ok: true });
    await page.locator('[data-opt="undated"]').uncheck();
    await shot(page, 'timeline-planning');
    await open(page, '/projects/#/projects/p/AERO/list', 'table');
    await expect(page.locator('table')).toContainText('Scale model');
    await expect(page.locator('table')).toContainText('Test runs');
    await noOverflow(page);
  });

  test('063: a lead adds a kind of work to every project; car cycles; the team timeline opens on my subsystem with levels above it', async () => {
    // kinds of work: one list for the team, changed by leads only
    await signIn(page, MANAGER);
    await open(page, '/projects/#/projects/kinds', 'h1');
    await expect(page.locator('h1')).toHaveText('Kinds of work');
    await expect(page.locator('[data-new-kind]')).toHaveCount(0);
    await signIn(page, ADMIN);
    await open(page, '/projects/#/projects/kinds', '[data-new-kind]');
    await tap(page, '[data-new-kind]');
    await dialog(page).locator('#kd-name').fill('Calc');
    await dialog(page).locator('#kd-icon').fill('∑');
    await dialog(page).locator('.pm-kind-color', { has: page.locator('input[value="purple"]') }).click();
    await save(page, 'Add to every space');
    await expect(toast(page)).toContainText('Calc is now in every space');
    await expect(page.locator('.pm-kinds')).toContainText('Calc');
    const missing = await sql(page, `select p.key from pm_projects p where p.archived_at is null
      and not exists (select 1 from pm_types t where t.project_id = p.id and t.name = 'Calc' and t.color = 'purple' and t.kind_id is not null)`);
    expect(missing).toEqual([]);
    await open(page, '/projects/#/projects/p/BAT/settings/types', '.pm-table');
    await expect(page.locator('.pm-table tr', { hasText: 'Calc' }).first()).toContainText('Team');   // C7: Fields share this page now

    // car cycles (074): spaces last across cars; each item has its car, and the switcher filters the work
    const epicType = await one(page, `select t.id, t.project_id from pm_types t join pm_projects p on p.id = t.project_id where p.key = 'BAT' and t.name = 'Epic'`);
    await rpc(page, 'pm_create_item', { p_op: crypto.randomUUID(), p: { project_id: epicType.project_id, type_id: epicType.id, title: 'Before cars' } });   // no car cycles yet: no car
    await open(page, '/projects/#/projects/all', '#new-program');
    await expect(page.locator('.pm-cycles')).toHaveCount(0);   // no switcher on the Spaces page
    await page.click('#new-program');
    await dialog(page).locator('#cy-name').fill('Car 7');
    await dialog(page).locator('#cy-start').fill('2025-08-20');
    await save(page);
    await expect(page.locator('.pm-cycle-chip', { hasText: 'Car 7' })).toBeVisible();
    await page.click('#new-program');
    await dialog(page).locator('#nc-name').fill('Car 8');
    await dialog(page).locator('#nc-start').fill('2027-01-11');
    await save(page, 'Start it');
    await expect(page.locator('.os-toast', { hasText: 'Car 8 is ready' })).toBeVisible();
    await expect(page.locator('.pm-project[data-project="BAT"]')).toBeVisible();   // nothing copied: the same spaces
    await expect(page.locator('.pm-project[data-project="AERO"]')).toBeVisible();
    expect((await one(page, `select count(*)::int c from pm_projects where program_id is not null`)).c).toBe(0);
    // in a space, the switcher shows Car 8 (just started): BAT's work so far has no car, so it's the current car's (Car 7)
    await open(page, '/projects/#/projects/p/BAT/list', '.pm-cycles');
    await expect(page.locator('[data-cycle]', { hasText: 'Car 8' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('main')).not.toContainText('Before cars');
    // new work here is for Car 8
    await tap(page, '[data-new-item]');
    await dialog(page).locator('#pm-new-type').selectOption({ label: '◆ Epic' });
    await dialog(page).locator('#pm-new-title').fill('Pack for Car 8');
    await save(page, 'Create');
    expect((await one(page, `select g.name from pm_items i join pm_programs g on g.id = i.program_id where i.title = 'Pack for Car 8'`)).name).toBe('Car 8');
    await expect(page.locator('main')).toContainText('Pack for Car 8');
    await page.locator('[data-cycle]', { hasText: 'Car 7' }).click();
    await expect(page.locator('main')).toContainText('Before cars');
    await expect(page.locator('main')).not.toContainText('Pack for Car 8');
    await page.locator('[data-cycle="both"]').click();
    await expect(page.locator('main')).toContainText('Pack for Car 8');
    await expect(page.locator('main')).toContainText('Before cars');
    await shot(page, 'car-cycles');
    // the item says its car, and it can move to the other car right there
    const k8 = (await one(page, `select key from pm_items where title = 'Pack for Car 8'`)).key;
    await open(page, `/projects/#/projects/item/${k8}`, '.pm-status-btn');
    await expect(page.locator('.pm-item-car')).toHaveText('Car 8');
    await page.locator('[data-edit-field="car"]').click();
    await page.locator('[name="f:car"]').selectOption({ label: 'Car 7' });
    await expect.poll(async () => (await one(page, `select g.name from pm_items i join pm_programs g on g.id = i.program_id where i.key = $1`, [k8])).name).toBe('Car 7');

    // levels: BAT is the Battery subsystem's; I'm in Battery, so the team timeline opens there
    const { id: battery, division_id: elec } = await one(page, `select id, division_id from org_subsystems where name = 'Battery'`);
    await sql(page, `update pm_projects set subsystem_id = $1, division_id = $2 where key = 'BAT'`, [battery, elec]);
    const { id: me } = await one(page, `select id from auth.users where email = $1`, [ADMIN.email]);
    await sql(page, `insert into person_org (user_id, division_id, subsystem_id, main) values ($1, $2, $3, true) on conflict do nothing`, [me, elec, battery]);
    await page.goto('/projects/#/projects/timeline');
    await page.reload();   // a fresh start for the timeline (it remembers where you were while the page is open)
    await expect(page.locator('.pm-g-crumbs')).toContainText('Battery', { timeout: 30000 });
    await expect(page.locator('.pm-g-label.is-car')).toHaveCount(0);   // 074: cars aren't a level above spaces any more
    // each car cycle is a band behind the chart, named in the header (Car 7 has no end: it runs until Car 8 starts)
    await expect(page.locator('.pm-g-keyhead.is-cycle', { hasText: 'Car 7' })).toBeVisible();
    await expect(page.locator('.pm-g-cycle').first()).toBeAttached();
    await expect(page.locator('.pm-g-label.is-header', { hasText: 'Aero' })).toHaveCount(0);   // not in Battery
    await page.locator('.pm-g-crumbs [data-focus=""]').click();
    await expect(page.locator('.pm-g-crumbs [aria-current]')).toHaveText('Everything');
    await expect(page.locator('.pm-g-label.is-division', { hasText: 'Electrical' }).first()).toBeVisible();
    await page.locator('[data-level="project"]').click();
    await expect(page.locator('[data-level="project"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.pm-g-label:not(.is-header)')).toHaveCount(0);   // folded down to projects: no work rows
    await page.locator('.pm-g-crumbs .pm-g-crumb-mine').click();
    await expect(page.locator('.pm-g-crumbs [aria-current]')).toHaveText('Battery');
    await shot(page, 'timeline-levels');
    // the legend offers a new kind to leads
    await page.locator('[data-level="work"]').click();
    await expect(page.locator('[data-new-kind]')).toBeVisible();
    await noOverflow(page);
  });

  test('070: a type that shares a workflow gets a copy of its own; its items keep their status', async () => {
    await signIn(page, ADMIN);
    await open(page, '/projects/#/projects/p/BAT/settings/types', '[data-new-type]');
    const bug = page.locator('.pm-settings tr', { hasText: 'Bug' });
    await bug.locator('[data-own-flow]').click();
    await save(page, 'Make a copy for it');
    await expect(toast(page)).toContainText('Bug has its own workflow now');
    await expect(page.locator('.pm-settings tr', { hasText: 'Bug' })).toContainText('Bug workflow');
    await expect(page.locator('.pm-settings tr', { hasText: 'Bug' }).locator('[data-own-flow]')).toHaveCount(0);
    await page.locator('.pm-settings tr', { hasText: 'Bug' }).getByRole('link', { name: 'Bug workflow' }).click();
    await expect(page.locator('[data-wf-pick]')).toHaveValue(/.+/);
    await expect(page.locator('.pm-settings')).toContainText('Used by Bug');
  });

  test('073: an item (and what is under it) and a whole space can be deleted for good', async () => {
    await signIn(page, ADMIN);
    const type = await one(page, `select t.id, t.project_id from pm_types t join pm_projects p on p.id = t.project_id where p.key = 'AERO' order by t.level, t.sort limit 1`);
    const top = (await rpc(page, 'pm_create_item', { p_op: crypto.randomUUID(), p: { project_id: type.project_id, type_id: type.id, title: 'Throwaway' } })).data;
    const sub = await one(page, `select id from pm_types where project_id = $1 and level > (select level from pm_types where id = $2) order by level, sort limit 1`, [type.project_id, type.id]);
    const under = await rpc(page, 'pm_create_item', { p_op: crypto.randomUUID(), p: { project_id: type.project_id, type_id: sub.id, title: 'Under it', parent_id: top.id } });
    expect(under.error).toBeFalsy();
    await open(page, `/projects/#/projects/item/${top.key}`, '.pm-status-btn');
    await page.locator('.pm-more > summary').click();
    await page.locator('[data-delete-item]').click();
    await expect(dialog(page)).toContainText('the 1 item under it');
    await expect(dialog(page)).toContainText("can't be undone");
    await save(page, 'Delete');
    await expect(page.locator('.os-toast')).toContainText(`Deleted ${top.key} and 1 item under it`);
    expect((await one(page, `select count(*)::int c from pm_items where title in ('Throwaway', 'Under it')`)).c).toBe(0);
    // the whole space: type its key to confirm
    await open(page, '/projects/#/projects/p/AERO/settings/details', '[data-delete-space]');
    await page.locator('[data-delete-space]').click();
    await dialog(page).locator('#del-key').fill('WRONG');
    await save(page, 'Delete this space');
    await expect(dialog(page)).toBeVisible();   // the key doesn't match: nothing happens
    await dialog(page).locator('#del-key').fill('AERO');
    await save(page, 'Delete this space');
    await expect(page.locator('.os-toast')).toContainText('Deleted AERO');
    expect((await one(page, `select count(*)::int c from pm_projects where key = 'AERO'`)).c).toBe(0);
  });
});
