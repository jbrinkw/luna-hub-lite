/**
 * Vitest config for tests/e2e — covers the invariant predicate unit
 * tests in `__tests__/`. Playwright scenarios under `scenarios/` are
 * NOT picked up here; they run via `pnpm test:e2e` against a live
 * Supabase + dev-server stack.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    globals: false,
    environment: 'node',
  },
});
