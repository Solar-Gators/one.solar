/**
 * The GitHub Actions workflows keep their safety properties:
 *   - every pull request and branch push runs npm test and the browser smoke tests;
 *   - the deploy publishes only after the tests pass (a failed or skipped test job stops it), and only once
 *     the repository variable PAGES_FROM_ACTIONS is "true";
 *   - nothing is allowed to keep going after a failure (no continue-on-error, no always()).
 *
 * The last test replays GitHub's documented rule ("a default status check of success() is applied unless
 * you include one of these functions"; a job runs only when the jobs it needs succeeded) over these files.
 * It is a model of GitHub, not GitHub: docs/RELEASING.md has the one-time live check.
 *
 *   node tests/workflows.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The YAML parser that ships inside @playwright/test (pinned in package.json), so no extra dependency.
const { yaml } = require('playwright-core/lib/utilsBundle');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message.split('\n').join('\n    ')}`);
    process.exitCode = 1;
  }
}

const load = (file) => yaml.parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), 'utf8'));
const ci = load('ci.yml');
const deploy = load('deploy.yml');
const needsOf = (job) => [].concat(job.needs || []);
const runs = (job) => (job.steps || []).map((s) => s.run || s.uses || '').join('\n');

console.log('GitHub Actions workflows');

test('CI runs on pull requests and branch pushes, and can be called by the deploy', () => {
  assert.ok('pull_request' in ci.on);
  assert.deepEqual(ci.on.push['branches-ignore'], ['main']);
  assert.equal(ci.on.workflow_call.inputs.simulate_test_failure.type, 'boolean');
  assert.equal(ci.on.workflow_call.inputs.simulate_test_failure.default, false);
});

test('CI installs exactly from the lockfile and runs every test suite', () => {
  const text = runs(ci.jobs.test);
  for (const cmd of ['npm ci', 'npm test', 'npm run test:smoke']) assert.ok(text.includes(cmd), `missing "${cmd}"`);
  assert.equal(ci.jobs.test.steps.find((s) => s.uses?.startsWith('actions/setup-node'))?.with['node-version-file'], '.nvmrc');
});

test('the simulated failure is the first step and really fails', () => {
  const first = ci.jobs.test.steps[0];
  assert.match(first.if, /inputs\.simulate_test_failure/);
  assert.match(first.run, /exit 1/);
});

test('nothing continues after a failure (no continue-on-error, no always()/failure() gates on publishing)', () => {
  for (const [file, wf] of [['ci.yml', ci], ['deploy.yml', deploy]]) {
    for (const [id, job] of Object.entries(wf.jobs)) {
      assert.ok(!job['continue-on-error'], `${file} job ${id} has continue-on-error`);
      for (const step of job.steps || []) assert.ok(!step['continue-on-error'], `${file} ${id} step "${step.name || step.uses}" has continue-on-error`);
    }
  }
  for (const id of ['build', 'deploy']) {
    assert.doesNotMatch(String(deploy.jobs[id].if || ''), /always\(\)|failure\(\)|cancelled\(\)/, `deploy.yml ${id} could run after a failure`);
  }
});

test('the deploy is test → build → deploy, from main only, one at a time', () => {
  assert.deepEqual(deploy.on.push.branches, ['main']);
  assert.equal(deploy.jobs.test.uses, './.github/workflows/ci.yml');
  assert.deepEqual(needsOf(deploy.jobs.build), ['test']);
  assert.deepEqual(needsOf(deploy.jobs.deploy).sort(), ['build', 'test']);
  assert.equal(deploy.concurrency['cancel-in-progress'], false);
  assert.deepEqual(deploy.permissions, { contents: 'read' });
  assert.deepEqual(deploy.jobs.deploy.permissions, { pages: 'write', 'id-token': 'write' });
});

test('the deploy publishes only the built site folder, stamped with the commit', () => {
  const text = runs(deploy.jobs.build);
  assert.match(text, /node tools\/build-site\.mjs --out=_site --version=\$\{\{ github\.sha \}\}/);
  assert.equal(deploy.jobs.build.steps.find((s) => s.uses?.startsWith('actions/upload-pages-artifact')).with.path, '_site');
  assert.ok(runs(deploy.jobs.deploy).includes('actions/deploy-pages'));
});

test('publishing waits for the switch (PAGES_FROM_ACTIONS), so merging this changes nothing by itself', () => {
  assert.match(deploy.jobs.deploy.if, /vars\.PAGES_FROM_ACTIONS == 'true'/);
});

/**
 * Which jobs would run, by GitHub's rules: a job runs when every job it needs succeeded and its `if`
 * (with success() implied when it has no status function) is true. Only the expressions these files use
 * are understood; anything else fails the test so the model can't silently drift.
 */
function simulate(wf, { testResult, vars = {}, inputs = {} }) {
  const result = {};
  const evalIf = (expr, needsOk) => {
    if (expr === undefined) return needsOk;
    let e = String(expr).replace(/^\$\{\{\s*|\s*\}\}$/g, '').trim();
    const hasStatus = /\b(success|failure|always|cancelled)\(\)/.test(e);
    e = e
      .replace(/success\(\)/g, String(needsOk))
      .replace(/vars\.(\w+)\s*==\s*'([^']*)'/g, (_, k, v) => String(vars[k] === v))
      .replace(/inputs\.(\w+)/g, (_, k) => String(!!inputs[k]));
    assert.match(e, /^[\s()!&|truefals]+$/, `the simulator doesn't understand: ${expr}`);
    const value = Function(`return (${e});`)();
    return hasStatus ? value : needsOk && value;
  };
  for (const [id, job] of Object.entries(wf.jobs)) {
    if (id === 'test') { result.test = testResult; continue; }
    const needsOk = needsOf(job).every((n) => result[n] === 'success');
    result[id] = evalIf(job.if, needsOk) ? 'success' : 'skipped';
  }
  return result;
}

test('by GitHub\'s rules: failed tests deploy nothing; passing tests deploy only after the switch', () => {
  const on = { PAGES_FROM_ACTIONS: 'true' };
  assert.deepEqual(simulate(deploy, { testResult: 'failure', vars: on }), { test: 'failure', build: 'skipped', deploy: 'skipped' });
  assert.deepEqual(simulate(deploy, { testResult: 'cancelled', vars: on }), { test: 'cancelled', build: 'skipped', deploy: 'skipped' });
  assert.deepEqual(simulate(deploy, { testResult: 'success', vars: {} }), { test: 'success', build: 'success', deploy: 'skipped' });
  assert.deepEqual(simulate(deploy, { testResult: 'success', vars: on }), { test: 'success', build: 'success', deploy: 'success' });
});

console.log(`\n${passed} passed`);
