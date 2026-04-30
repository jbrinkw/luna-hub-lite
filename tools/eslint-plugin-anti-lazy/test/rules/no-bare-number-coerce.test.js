'use strict';

const { RuleTester } = require('eslint');
const rule = require('../../lib/rules/no-bare-number-coerce');

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

tester.run('no-bare-number-coerce', rule, {
  valid: [
    // Literal argument — always fine
    { code: 'Number(0);', filename: '/src/app.ts' },
    { code: 'Number("123");', filename: '/src/app.ts' },
    // Wrapped in isFinite check
    { code: 'Number.isFinite(Number(x));', filename: '/src/app.ts' },
    { code: 'isFinite(Number(x));', filename: '/src/app.ts' },
    // Allowlisted prefix patterns
    { code: 'Number(value_in_g);', filename: '/src/app.ts' },
    { code: 'Number(qty_servings);', filename: '/src/app.ts' },
    { code: 'Number(amount_total);', filename: '/src/app.ts' },
    // Allowlisted exact names
    { code: 'Number(price);', filename: '/src/app.ts' },
    { code: 'Number(weight);', filename: '/src/app.ts' },
    { code: 'Number(calories);', filename: '/src/app.ts' },
    { code: 'Number(protein);', filename: '/src/app.ts' },
    // Member access on DB container objects
    { code: 'Number(data.value);', filename: '/src/app.ts' },
    { code: 'Number(row.amount);', filename: '/src/app.ts' },
    { code: 'Number(result.count);', filename: '/src/app.ts' },
    // Test files — always skipped
    { code: 'Number(x);', filename: '/src/app.test.ts' },
    { code: 'Number(y);', filename: '/src/__tests__/util.ts' },
    { code: 'Number(z);', filename: '/src/app.spec.ts' },
    // Property with numeric suffix
    { code: 'Number(item.value_in_g);', filename: '/src/app.ts' },
    { code: 'Number(item.weight_kg);', filename: '/src/app.ts' },
  ],
  invalid: [
    // Plain identifier — not in allowlist
    {
      code: 'Number(userInput);',
      filename: '/src/app.ts',
      errors: [{ messageId: 'bareNumberCoerce' }],
    },
    // Member expression on unknown object
    {
      code: 'Number(form.rawValue);',
      filename: '/src/app.ts',
      errors: [{ messageId: 'bareNumberCoerce' }],
    },
    // CallExpression argument
    {
      code: 'Number(getValue());',
      filename: '/src/app.ts',
      errors: [{ messageId: 'bareNumberCoerce' }],
    },
    // Unknown identifier
    {
      code: 'Number(searchParam);',
      filename: '/src/app.ts',
      errors: [{ messageId: 'bareNumberCoerce' }],
    },
    // Unknown member access on non-DB-container
    {
      code: 'Number(event.target.value);',
      filename: '/src/app.ts',
      errors: [{ messageId: 'bareNumberCoerce' }],
    },
    // Chained call — not inside isFinite
    {
      code: 'const n = Number(str).toFixed(2);',
      filename: '/src/app.ts',
      errors: [{ messageId: 'bareNumberCoerce' }],
    },
  ],
});

console.log('no-bare-number-coerce: all tests passed');
