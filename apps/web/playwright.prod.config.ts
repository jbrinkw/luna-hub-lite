/**
 * Playwright config for running E2E tests against production Supabase.
 *
 * Usage:
 *   SUPABASE_URL=https://... \
 *   SUPABASE_ANON_KEY=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   npx playwright test --config playwright.prod.config.ts
 *
 * This config:
 *   1. Passes SUPABASE env vars as VITE_ prefixed vars to the dev server
 *   2. Enables session injection in seedFullAndLogin (bypasses UI login rate limits)
 *   3. Passes Supabase vars to the MCP worker via --var flags
 */
import { defineConfig, devices } from '@playwright/test';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
  throw new Error('Production E2E requires SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY env vars');
}

// Enable session injection in seed helpers (bypasses browser login rate limits)
process.env.E2E_SESSION_INJECTION = '1';

// Build wrangler --var flags to pass Supabase bindings to the MCP worker
const varFlags = [
  `SUPABASE_URL:${supabaseUrl}`,
  `SUPABASE_SERVICE_ROLE_KEY:${supabaseServiceRoleKey}`,
  `SUPABASE_ANON_KEY:${supabaseAnonKey}`,
]
  .map((v) => `--var ${v}`)
  .join(' ');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 2,
  workers: 2,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: 'html',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        VITE_SUPABASE_URL: supabaseUrl,
        VITE_SUPABASE_ANON_KEY: supabaseAnonKey,
      },
    },
    {
      command: `pnpm --filter @luna-hub/mcp-worker exec wrangler dev --port 8787 ${varFlags}`,
      url: 'http://localhost:8787/health',
      reuseExistingServer: !process.env.CI,
      cwd: '../../',
    },
  ],
});
