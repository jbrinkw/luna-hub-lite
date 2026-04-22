/**
 * Stryker-specific vitest config for the apps/web workspace.
 *
 * Why this file exists:
 * Stryker's vitest-runner creates a Vitest context with `root` set to the
 * SANDBOX ROOT (the temporary copy of the whole monorepo), not to
 * apps/web/. When vitest loads apps/web/vitest.config.ts directly, its
 * `setupFiles: ['./src/__tests__/setup.ts']` resolves relative to root —
 * i.e. to `<sandbox>/src/__tests__/setup.ts`, which does not exist —
 * and every test file fails to load with "Cannot find module .../setup.ts".
 *
 * We cannot edit apps/web/vitest.config.ts (that's owned by the web
 * workspace), and Stryker's vitest-runner options don't expose a way to
 * override setupFiles. So instead we use THIS config for Stryker runs,
 * which resolves every relative path against __dirname (absolute), and
 * explicitly uses absolute paths for include + setupFiles.
 *
 * Only used by stryker.web-shared.conf.json. The real apps/web test suite
 * continues to use apps/web/vitest.config.ts unchanged.
 */

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

const WEB_ROOT = path.resolve(__dirname, '../../../apps/web');

try {
  process.loadEnvFile(path.resolve(__dirname, '../../../.env.test'));
} catch {
  /* env file optional */
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(WEB_ROOT, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    // Absolute paths so Stryker's sandbox root override doesn't break resolution.
    setupFiles: [path.resolve(WEB_ROOT, 'src/__tests__/setup.ts')],
    include: [path.resolve(WEB_ROOT, 'src/__tests__/unit/**/*.test.{ts,tsx}')],
  },
});
