import { defineConfig } from 'vitest/config';

// Standalone vitest config for mutation-gate fixtures. Kept separate from
// every workspace vitest.config.ts so fixtures never leak into the real
// test suites.
export default defineConfig({
  test: {
    include: ['*.test.ts'],
    environment: 'node',
  },
});
