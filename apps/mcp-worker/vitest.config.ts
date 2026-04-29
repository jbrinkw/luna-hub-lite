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
      'src/__tests__/voice-ack.test.ts',
      'src/__tests__/chat-streaming.test.ts',
      'src/__tests__/session-logging.test.ts',
      'src/__tests__/test-extension-creds.test.ts',
      // MCP-HIGH-4.1: unit tests for authenticateApiKey revoked/expired/DB-error paths
      'src/__tests__/auth.test.ts',
      // D-01: session lifecycle, OAuth TTL proxy, SSE concurrent-connection, dispatch error paths
      'src/__tests__/durable-object.test.ts',
    ],
    environment: 'node',
    testTimeout: 30_000,
  },
});
