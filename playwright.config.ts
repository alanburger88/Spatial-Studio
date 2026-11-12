import { defineConfig } from '@playwright/test';

/**
 * Browser acceptance suite. Runs against the real local stack (API :3001, web :5173).
 * Starts both if they are not already running.
 */
export default defineConfig({
  testDir: '.',
  testMatch: ['e2e/**/*.spec.ts', 'tests/e2e/**/*.spec.ts'],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'reports/evidence/e2e-results.json' }]],
  use: { baseURL: 'http://127.0.0.1:5173', viewport: { width: 1440, height: 900 }, trace: 'off', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'pnpm --filter @iss/api start', url: 'http://127.0.0.1:3001/api/v1/health', reuseExistingServer: true, timeout: 120_000 },
    { command: 'pnpm --filter @iss/web dev', url: 'http://127.0.0.1:5173/projects', reuseExistingServer: true, timeout: 120_000 },
  ],
});
