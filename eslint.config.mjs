import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import noUncheckedSupabaseMutation from './eslint-rules/no-unchecked-supabase-mutation.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const antiLazyPlugin = require('@luna/eslint-plugin-anti-lazy');

const localRulesPlugin = {
  rules: {
    'no-unchecked-supabase-mutation': noUncheckedSupabaseMutation,
  },
};

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
      // Local ESLint plugins are intentionally CommonJS .js; the ESLint
      // CLI loads them directly and tseslint's no-require-imports does
      // not apply to plugin source.
      'tools/eslint-plugin-anti-lazy/',
      'eslint-rules/',
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
  // Custom: surface silent supabase mutation errors. Scoped to production
  // code paths that talk to Supabase. Tests legitimately fire-and-forget
  // mocked builders, so they're excluded.
  {
    files: ['apps/web/src/**/*.{ts,tsx}', 'supabase/functions/**/*.ts'],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', 'tests/**', 'apps/web/e2e/**'],
    plugins: {
      'local-rules': localRulesPlugin,
    },
    rules: {
      'local-rules/no-unchecked-supabase-mutation': 'error',
    },
  },
  // Anti-laziness rules — apply to PRODUCTION + TEST code (the lazy patterns
  // they catch are exactly the ones audits keep finding in test files).
  // Scoped to first-party source paths. Excludes node_modules / dist via the
  // global ignores at the top of this config.
  {
    files: [
      'apps/web/src/**/*.{ts,tsx}',
      'apps/mcp-worker/src/**/*.ts',
      'packages/*/src/**/*.{ts,tsx}',
      'extensions/**/*.{ts,tsx}',
      'supabase/functions/**/*.ts',
      'tests/e2e/**/*.ts',
    ],
    plugins: {
      '@luna/anti-lazy': antiLazyPlugin,
    },
    rules: {
      // INITIAL ROLLOUT: set to 'warn' so the plugin ships without breaking
      // verify:full on existing violations. Sweep agents will fix violations
      // in batches; after the sweep, ratchet to 'error' in a follow-up commit.
      // Current backlog (counted via `npx eslint ...` on 2026-04-29):
      //   no-empty-catch-no-comment: 31
      //   no-bare-tohavebeencalled:  24
      //   no-bare-number-coerce:    303 (mostly legitimate Number(numericDb)
      //                                  — needs rule refinement before ratchet)
      '@luna/anti-lazy/no-empty-catch-no-comment': 'warn',
      '@luna/anti-lazy/no-bare-tohavebeencalled': 'warn',
      '@luna/anti-lazy/no-bare-number-coerce': 'warn',
    },
  },
);
