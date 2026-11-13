import { defineConfig } from '@playwright/test';

/**
 * Browser acceptance suite. Runs against the real local stack (API :3001, web :5173).
 * Starts both if they are not already running.
 */
export default defineConfig({
  testDir: '.',
  testMatch: ['e2e/**/*.spec.ts', 'tests/e2e/**/*.spec.ts'],
  // Temporary working copies used by parallel builders hold a second copy of every spec; never run those.
  testIgnore: ['**/.claude/**', '**/node_modules/**'],
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'reports/evidence/e2e-results.json' }]],
  use: { baseURL: process.env.E2E_WEB ?? 'http://127.0.0.1:5173', viewport: { width: 1440, height: 900 }, trace: 'off', screenshot: 'only-on-failure' },
  // With E2E_WEB/E2E_API set, an isolated stack (scripts/dev-isolated.mjs) is already running: start nothing.
  webServer: process.env.E2E_WEB || process.env.E2E_API ? undefined : [
    { command: 'pnpm --filter @iss/api start', url: 'http://127.0.0.1:3001/api/v1/health', reuseExistingServer: true, timeout: 120_000 },
    { command: 'pnpm --filter @iss/web dev', url: 'http://127.0.0.1:5173/projects', reuseExistingServer: true, timeout: 120_000 },
  ],
});
