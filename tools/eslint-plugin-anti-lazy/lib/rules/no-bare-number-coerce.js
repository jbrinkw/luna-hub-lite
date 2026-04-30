/**
 * Rule: no-bare-number-coerce
 *
 * Flag `Number(x)` calls in production code where the result isn't checked
 * for finiteness. `Number(undefined)` → NaN, `Number("")` → 0,
 * `Number("abc")` → NaN, `Number(null)` → 0. NaN propagates silently
 * through arithmetic and renders as "NaN" in the UI.
 *
 * Acceptable patterns:
 *   - `Number.isFinite(Number(x))` guard
 *   - `parseInt(x, 10)` / `parseFloat(x)` (different semantics, more explicit failure)
 *   - `Number(x)` immediately followed by `.toFixed(N)` or `Math.X(...)` IS still flagged
 *     (NaN.toFixed = "NaN") UNLESS preceded by a finite check.
 *   - inside test files (test fixtures use Number literals freely)
 *
 * The rule is INTENTIONALLY conservative: it only flags `Number(x)` where x is a
 * non-literal (an Identifier, MemberExpression, or CallExpression). `Number(0)` is fine.
 *
 * To intentionally allow:
 *   // eslint-disable-next-line @luna/anti-lazy/no-bare-number-coerce
 *   // reason: <input is guaranteed finite by callsite>
 */
'use strict';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'forbid bare Number(x) on non-literal expressions without finite check',
    },
    schema: [],
    messages: {
      bareNumberCoerce:
        'Number({{ argType }}) without isFinite check can produce NaN silently (Number(undefined), Number("abc")). Wrap with Number.isFinite or use parseInt/parseFloat with explicit fallback.',
    },
  },
  create(context) {
    const filename = context.getFilename();
    // Skip test files — fixture code uses Number() freely on known-good values.
    if (
      /__tests__\//.test(filename) ||
      /\.test\.(ts|tsx|js|jsx)$/.test(filename) ||
      /\.spec\.(ts|tsx|js|jsx)$/.test(filename) ||
      /\/tests?\//.test(filename) ||
      /\/e2e\//.test(filename)
    ) {
      return {};
    }

    function isNonLiteralArg(arg) {
      if (!arg) return false;
      // Literal numbers / strings / template literals are fine.
      if (arg.type === 'Literal') return false;
      if (arg.type === 'TemplateLiteral' && arg.expressions.length === 0) return false;
      // UnaryExpression like -1 is fine.
      if (arg.type === 'UnaryExpression' && arg.argument.type === 'Literal') return false;
      return true;
    }

    function isWrappedInFiniteCheck(node) {
      // Walk up: is the Number(...) the argument of Number.isFinite() or
      // wrapped in a ternary checking isFinite/isNaN?
      let cursor = node.parent;
      while (cursor) {
        if (cursor.type === 'CallExpression' && cursor.callee && cursor.callee.type === 'MemberExpression') {
          const obj = cursor.callee.object;
          const prop = cursor.callee.property;
          if (
            obj &&
            obj.name === 'Number' &&
            prop &&
            (prop.name === 'isFinite' || prop.name === 'isNaN' || prop.name === 'isInteger')
          ) {
            return true;
          }
        }
        if (cursor.type === 'CallExpression' && cursor.callee && cursor.callee.name === 'isFinite') return true;
        if (cursor.type === 'CallExpression' && cursor.callee && cursor.callee.name === 'isNaN') return true;
        // Stop walking once we leave the immediate expression context.
        if (cursor.type === 'BlockStatement' || cursor.type === 'Program') return false;
        cursor = cursor.parent;
      }
      return false;
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== 'Identifier' || callee.name !== 'Number') return;
        if (node.arguments.length !== 1) return;
        const arg = node.arguments[0];
        if (!isNonLiteralArg(arg)) return;
        if (isWrappedInFiniteCheck(node)) return;
        context.report({
          node,
          messageId: 'bareNumberCoerce',
          data: { argType: arg.type },
        });
      },
    };
  },
};
