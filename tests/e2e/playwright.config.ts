/**
 * Phase 2 e2e harness — 15 user-level scenarios with Playwright + Pi simulator.
 *
 * Architecture
 * ------------
 * - Boots local Supabase (assumed already running via `supabase start`).
 * - Drives the React SPA through Playwright against the existing `pnpm dev`
 *   server on port 5173 (reused with the rest of the e2e infrastructure).
 * - Uses an in-process TypeScript Pi simulator that talks directly to the
 *   `shelf-ingest` edge function via x-api-key. See `fixtures/pi-simulator.ts`
 *   for the rationale (option (b) in the Phase-2 spec — fast setup, full
 *   HTTP fidelity at the edge-function boundary).
 *
 * Each scenario file under `scenarios/` is one Playwright spec covering one
 * end-to-end chain. Scenarios are independent and parallel-safe.
 *
 * To run:
 *   pnpm test:e2e
 * or, if invoking playwright directly:
 *   npx playwright test --config tests/e2e/playwright.config.ts
 */
import { defineConfig, devices } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env.test from repo root so SUPABASE_* are populated before web-server
// boot. Helpers under `helpers/` re-load on import for in-test use.
try {
  process.loadEnvFile(path.resolve(__dirname, '../../.env.test'));
} catch {
  // .env.test optional in CI where vars are injected by the runner
}

export default defineConfig({
  testDir: './scenarios',
  // Scenarios share the same Supabase + dev server but each creates its own
  // user, so they're independent. Workers=1 avoids fighting over the dev
  // server boot when reuseExistingServer is off.
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // Each scenario asserts state convergence with realtime delays — give it
  // headroom but cap at 90 s so a stuck spec doesn't hide a regression.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.resolve(__dirname, '../../playwright-report-e2e') }],
  ],
  outputDir: path.resolve(__dirname, '../../test-results-e2e'),
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @luna-hub/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      cwd: path.resolve(__dirname, '../../'),
      timeout: 120_000,
    },
  ],
});
