import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60_000,
    globalSetup: './src/__tests__/helpers/setup.ts',
  },
});
