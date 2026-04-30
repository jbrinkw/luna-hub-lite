'use strict';

/**
 * Rule: no-numeric-coalesce-default
 *
 * Flag `x ?? 0` in display contexts. The bug: a missing/null value gets silently
 * rendered as `0`, hiding load failures or data gaps from the user.
 *
 * Flagged contexts:
 *   - JSX expression containers: `<span>{calories ?? 0}</span>`
 *   - `.toFixed(N)` / `.toLocaleString()` / `.toFormat()` / `.format()` callees:
 *     `(value ?? 0).toFixed(2)`
 *
 * Acceptable (not flagged):
 *   - Inside `Math.X(...)` arithmetic arguments
 *   - Immediately preceded by a comment matching /reason:/i
 *   - `?? 0` with a non-zero right-hand literal (only flags the `0` case)
 *
 * To intentionally allow:
 *   // reason: price is always numeric, null means free (i.e. 0)
 *   const display = price ?? 0;
 */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'flag `x ?? 0` in display contexts (silently hides missing values)',
    },
    schema: [],
    messages: {
      coalesceDefault:
        'Using `?? 0` in a display context silently shows zero on missing data — prefer explicit empty/loading/error UI. If zero is genuinely the right default, add `// reason: ...` comment.',
    },
  },
  create(context) {
    function hasReasonComment(node) {
      const sourceCode = context.getSourceCode ? context.getSourceCode() : context.sourceCode;
      const comments = sourceCode.getCommentsBefore(node);
      return comments.some((c) => /reason:/i.test(c.value));
    }

    function isDisplayContext(node) {
      const parent = node.parent;
      if (!parent) return false;

      // JSX expression container: <span>{x ?? 0}</span>
      if (parent.type === 'JSXExpressionContainer') return true;

      // .toFixed() / .toLocaleString() / .toFormat() / .format() callee
      // Pattern: (x ?? 0).toFixed(2) — parent is MemberExpression, grandparent is CallExpression
      if (parent.type === 'MemberExpression' && parent.object === node) {
        const prop = parent.property;
        if (
          prop &&
          ['toFixed', 'toLocaleString', 'toFormat', 'format'].includes(prop.name)
        ) {
          return true;
        }
      }

      return false;
    }

    function isInsideMathCall(node) {
      let cursor = node.parent;
      while (cursor) {
        if (
          cursor.type === 'CallExpression' &&
          cursor.callee &&
          cursor.callee.type === 'MemberExpression' &&
          cursor.callee.object &&
          cursor.callee.object.name === 'Math'
        ) {
          return true;
        }
        // Stop at statement boundaries
        if (
          cursor.type === 'BlockStatement' ||
          cursor.type === 'Program' ||
          cursor.type === 'ArrowFunctionExpression' ||
          cursor.type === 'FunctionExpression' ||
          cursor.type === 'FunctionDeclaration'
        ) {
          return false;
        }
        cursor = cursor.parent;
      }
      return false;
    }

    return {
      LogicalExpression(node) {
        if (node.operator !== '??') return;
        const right = node.right;
        // Only flag `?? 0` (literal zero)
        if (!right || right.type !== 'Literal' || right.value !== 0) return;
        if (isInsideMathCall(node)) return;
        if (!isDisplayContext(node)) return;
        if (hasReasonComment(node)) return;
        context.report({ node, messageId: 'coalesceDefault' });
      },
    };
  },
};
