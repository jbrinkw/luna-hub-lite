'use strict';

const { RuleTester } = require('eslint');
const rule = require('../../lib/rules/spec-as-fixture');

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
});

// RuleTester filename is set per-test via options object
// For file-scoped rules we pass filename via the test object
tester.run('spec-as-fixture', rule, {
  valid: [
    // Non-test file — rule is silent
    {
      code: `import { StatusType } from './types'; const cases = ['ACTIVE', 'INACTIVE', 'PENDING', 'ARCHIVED'];`,
      filename: '/src/utils.ts',
    },
    // Test file but fewer than 4 elements
    {
      code: `import { StatusType } from './types'; const cases = ['ACTIVE', 'INACTIVE', 'PENDING'];`,
      filename: '/src/utils.test.ts',
    },
    // Test file with 4+ elements but no matching import with enum suffix
    {
      code: `import { helper } from './helper'; const cases = ['ACTIVE', 'INACTIVE', 'PENDING', 'ARCHIVED'];`,
      filename: '/src/utils.test.ts',
    },
    // Test file with mixed types (not all strings) — not flagged
    {
      code: `import { StatusType } from './types'; const cases = ['ACTIVE', 1, 'PENDING', 'ARCHIVED'];`,
      filename: '/src/utils.test.ts',
    },
    // Test file with strings that don't share prefix or upper case pattern
    {
      code: `import { StatusType } from './types'; const cases = ['apple', 'banana', 'cherry', 'date'];`,
      filename: '/src/utils.test.ts',
    },
    // Non-const array (function arg) — not a VariableDeclarator, not flagged
    {
      code: `import { StatusType } from './types'; test('x', () => runWith(['ACTIVE', 'INACTIVE', 'PENDING', 'ARCHIVED']));`,
      filename: '/src/utils.test.ts',
    },
  ],
  invalid: [
    // Classic enum copy in test file — all-caps + imported Type
    {
      code: `import { OrderStatus } from './types'; const cases = ['PENDING', 'ACTIVE', 'CANCELLED', 'COMPLETED'];`,
      filename: '/src/orders.test.ts',
      errors: [
        {
          messageId: 'specAsFixture',
          suggestions: [
            {
              desc: 'Replace with Object.values(OrderStatus)',
              output: `import { OrderStatus } from './types'; const cases = Object.values(OrderStatus);`,
            },
          ],
        },
      ],
    },
    // Status suffix import + all-caps array
    {
      code: `import { JobStatus } from './jobs'; const statuses = ['RUNNING', 'FAILED', 'STOPPED', 'QUEUED'];`,
      filename: '/src/jobs.test.ts',
      errors: [
        {
          messageId: 'specAsFixture',
          suggestions: [
            {
              desc: 'Replace with Object.values(JobStatus)',
              output: `import { JobStatus } from './jobs'; const statuses = Object.values(JobStatus);`,
            },
          ],
        },
      ],
    },
    // Mode suffix import + all-caps array
    {
      code: `import { DisplayMode } from './display'; const modes = ['DARK', 'LIGHT', 'SYSTEM', 'AUTO'];`,
      filename: '/src/display.spec.ts',
      errors: [
        {
          messageId: 'specAsFixture',
          suggestions: [
            {
              desc: 'Replace with Object.values(DisplayMode)',
              output: `import { DisplayMode } from './display'; const modes = Object.values(DisplayMode);`,
            },
          ],
        },
      ],
    },
    // Kind suffix import + 5 elements
    {
      code: `import { EventKind } from './events'; const kinds = ['CLICK', 'HOVER', 'FOCUS', 'BLUR', 'SUBMIT'];`,
      filename: '/src/events.test.ts',
      errors: [
        {
          messageId: 'specAsFixture',
          suggestions: [
            {
              desc: 'Replace with Object.values(EventKind)',
              output: `import { EventKind } from './events'; const kinds = Object.values(EventKind);`,
            },
          ],
        },
      ],
    },
    // Category suffix
    {
      code: `import { FoodCategory } from './food'; const cats = ['DAIRY', 'MEAT', 'GRAIN', 'VEGGIE'];`,
      filename: '/src/food.test.ts',
      errors: [
        {
          messageId: 'specAsFixture',
          suggestions: [
            {
              desc: 'Replace with Object.values(FoodCategory)',
              output: `import { FoodCategory } from './food'; const cats = Object.values(FoodCategory);`,
            },
          ],
        },
      ],
    },
  ],
});

console.log('spec-as-fixture: all tests passed');
