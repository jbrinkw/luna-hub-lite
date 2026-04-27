import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/',
      '**/node_modules/',
      '**/.turbo/',
      '**/.wrangler/',
      '**/.vite/',
      '**/.vercel/',
      'legacy/',
      '.claude/',
      '.stryker-tmp/',
      '.stryker-tmp-*/',
      '.verify/',
      '.worktrees/',
      'reports/',
      'coverage/',
      'playwright-report/',
      'test-results/',
      'supabase/.temp/',
      'supabase/.branches/',
      'hardware/live-shelf/mutants/',
      'packages/db-types/src/',
      '**/.testmondata',
      '**/.pytest_cache/',
      // Phase 2 territory — tests/e2e is owned by the e2e harness agent.
      // Skip during Phase 5; the e2e agent will land its own lint config.
      'tests/e2e/',
      // Python virtualenvs (vendored JS inside coverage/werkzeug/etc.)
      '**/.venv/',
      // Generated playwright traces / reports.
      'playwright-report-e2e/',
      // pgTAP fixtures sometimes ship .js helpers; they're hand-rolled.
      'supabase/tests/**/*.js',
      // Mutation-testing artifacts.
      'mutants/',
      'hardware/live-shelf/mutants/',
      'hardware/live-shelf/.mutmut-cache/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.worker,
      },
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  prettier,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
);
