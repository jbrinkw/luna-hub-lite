import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Resolve .env.test from the worktree root first; if not found (in isolated
// worktrees the root path differs from the main repo root), fall back to the
// canonical location at the monorepo root.
const envCandidates = [path.resolve(__dirname, '../../.env.test'), '/home/jeremy/luna-hub-lite/.env.test'];
for (const p of envCandidates) {
  try {
    process.loadEnvFile(p);
    break;
  } catch {
    /* try next candidate */
  }
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Allow TSX integration tests to import test helpers without
      // explicit .ts extension. Vitest's node-env module runner evaluates
      // transformed TSX as ESM, and Node.js ESM can't infer .ts extension
      // from extensionless relative imports. Mapping these paths through
      // an alias routes them through vite's resolver (which does add .ts).
      '../../setup.integration': path.resolve(__dirname, './src/__tests__/setup.integration.ts'),
      '../../test-helpers': path.resolve(__dirname, './src/__tests__/test-helpers.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    sequence: { shuffle: true },
    setupFiles: ['./src/__tests__/setup.integration.ts'],
    include: ['src/__tests__/integration/**/*.test.{ts,tsx}', 'src/__tests__/flows/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
