import { defineConfig } from 'vitest/config';
import path from 'path';

try {
  process.loadEnvFile(path.resolve(__dirname, '../../.env.test'));
} catch {
  /* env file optional */
}

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.integration.ts'],
    include: ['src/__tests__/integration/**/*.test.ts', 'src/__tests__/flows/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
