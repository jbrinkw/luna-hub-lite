'use strict';

const { RuleTester } = require('eslint');
const rule = require('../../lib/rules/no-numeric-coalesce-default');

// ESLint 9 flat config: parserOptions must be nested inside languageOptions
const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: {
      ecmaFeatures: { jsx: true },
    },
  },
});

tester.run('no-numeric-coalesce-default', rule, {
  valid: [
    // Not a JSX context — plain assignment is fine
    { code: 'const x = value ?? 0;' },
    // Math context — acceptable arithmetic default
    { code: 'const y = Math.max(value ?? 0, 1);' },
    // Math.min
    { code: 'const z = Math.min(a ?? 0, b ?? 0);' },
    // Non-zero fallback — not flagged (only flags ?? 0)
    { code: '<span>{value ?? -1}</span>' },
    // String fallback — not flagged
    { code: '<span>{label ?? ""}</span>' },
    // Wrapped in arithmetic operator (not in display context)
    { code: 'const n = (value ?? 0) + 5;' },
    // toFixed on non-coalesce — fine
    { code: 'value.toFixed(2);' },
    // Ternary fallback — different pattern, not flagged
    { code: '<span>{value != null ? value : 0}</span>' },
  ],
  invalid: [
    // JSX text expression
    {
      code: '<span>{calories ?? 0}</span>',
      errors: [{ messageId: 'coalesceDefault' }],
    },
    // JSX nested element expression
    {
      code: '<div>{total ?? 0}</div>',
      errors: [{ messageId: 'coalesceDefault' }],
    },
    // toFixed callee
    {
      code: 'const s = (value ?? 0).toFixed(2);',
      errors: [{ messageId: 'coalesceDefault' }],
    },
    // toLocaleString callee
    {
      code: 'const s = (amount ?? 0).toLocaleString();',
      errors: [{ messageId: 'coalesceDefault' }],
    },
    // format callee
    {
      code: 'const s = (price ?? 0).format("0.00");',
      errors: [{ messageId: 'coalesceDefault' }],
    },
    // JSX attribute expression container
    {
      code: '<Progress value={count ?? 0} />',
      errors: [{ messageId: 'coalesceDefault' }],
    },
  ],
});

console.log('no-numeric-coalesce-default: all tests passed');
