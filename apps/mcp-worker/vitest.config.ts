import { defineConfig } from 'vitest/config';
import path from 'path';

try {
  process.loadEnvFile(path.resolve(__dirname, '../../.env.test'));
} catch {
  /* env file optional */
}

export default defineConfig({
  test: {
    include: [
      'src/__tests__/validate.test.ts',
      'src/__tests__/obsidian-parser.test.ts',
      'src/__tests__/tool-logger.test.ts',
      'src/__tests__/tool-executor.test.ts',
      'src/__tests__/sse.test.ts',
    ],
    environment: 'node',
    testTimeout: 30_000,
  },
});
