import { defineConfig } from 'vitest/config';
import path from 'path';

// Standalone Vitest config for the extension tool packages (Home Assistant,
// Todoist, Obsidian). The extension sources import `@luna-hub/app-tools` for
// shared tool helpers/types; that package is resolved via the repo-root
// node_modules workspace symlink, so no extra alias is required here.
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@luna-hub/app-tools': path.resolve(__dirname, '../packages/app-tools/src'),
    },
  },
});
