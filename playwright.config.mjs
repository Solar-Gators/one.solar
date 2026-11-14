/**
 * Browser smoke tests (tests/e2e/). They run against the local FAKE backend (npm run dev:fake): an
 * in-browser Postgres with every migration, so no real Supabase is touched. Requests to *.supabase.co
 * are blocked and fail the test.
 *
 *   npx playwright install chromium   # once
 *   npm run test:smoke
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 5199;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0, // a flaky smoke test is a bug to fix, not to retry
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: `node tools/dev-server.mjs --fake --port=${PORT}`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
