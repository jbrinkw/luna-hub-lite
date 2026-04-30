import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

try {
  process.loadEnvFile(path.resolve(__dirname, '../../.env.test'));
} catch {
  /* env file optional */
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    sequence: { shuffle: true },
    setupFiles: ['./src/__tests__/setup.ts'],
    include: [
      'src/__tests__/unit/**/*.test.{ts,tsx}',
      'src/__tests__/property/**/*.test.{ts,tsx}',
      'src/__tests__/spec/**/*.test.{ts,tsx}',
      'src/__tests__/audit/**/*.test.{ts,tsx}',
      // RTL-based integration page tests (mocked Supabase, jsdom required)
      'src/__tests__/integration/pages/**/*.test.tsx',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/__tests__/**', 'src/main.tsx', 'src/vite-env.d.ts'],
    },
  },
});
