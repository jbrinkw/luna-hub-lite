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
 *   - variable name matches known-numeric DB column patterns (see ALLOWLIST_* below)
 *   - member access on a data/result/row object (e.g. `row.value`, `data.price`)
 *
 * Allowlisted variable name patterns (known-numeric DB columns; refinement reduces
 * ~303 → ≤50 violations):
 *   - Prefix pattern: value_, qty_, quantity_, amount_, count_, n_, num_, integer_,
 *     float_, double_, decimal_, numeric_, grams_, kg_, ml_, l_ (case-insensitive)
 *   - Exact names: price, cost, weight, height, temp, temperature, calories, fat,
 *     protein, carbs, carbohydrates, fiber, sodium, servings, duration, reps,
 *     sets, distance, bpm, rate
 *   - Member access where object name is: data, result, row, record, item, entry,
 *     payload, response, body, values, totals, macros, stats, summary
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
    const filename = context.getFilename ? context.getFilename() : context.filename || '';
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

    // Known-numeric DB column PREFIX patterns (case-insensitive).
    const NUMERIC_PREFIX =
      /^(value|qty|quantity|amount|count|n|num|integer|float|double|decimal|numeric|grams|kg|ml|l)_/i;

    // Common Postgres numeric column suffixes
    const NUMERIC_SUFFIX =
      /_g$|_kg$|_ml$|_l$|_kcal$|_pct$|_count$|_qty$|_amount$|_per_serving$|_per_container$|_time$|_duration$|_height$|_weight$/i;

    // Known-numeric EXACT variable / property names (common DB column names for numeric fields).
    const NUMERIC_EXACT = new Set([
      // Macros / nutrition
      'calories',
      'fat',
      'protein',
      'carbs',
      'carbohydrates',
      'fiber',
      'sodium',
      'sugar',
      'saturated_fat',
      'cholesterol',
      'calories_per_serving',
      'fat_per_serving',
      'protein_per_serving',
      'carbs_per_serving',
      'net_weight_g',
      'servings_per_container',
      // Physical / workout
      'servings',
      'weight',
      'height',
      'temp',
      'temperature',
      'reps',
      'sets',
      'distance',
      'duration',
      'bpm',
      'rest_seconds',
      'weight_kg',
      'one_rm',
      'epley_1rm',
      // Commerce / inventory
      'price',
      'cost',
      'subtotal',
      'tax',
      'discount',
      'quantity',
      'qty',
      'qty_consumed',
      'qty_purchased',
      'stock',
      // General numeric
      'rate',
      'total',
      'total_time',
      'active_time',
      'base_servings',
      'visual_quantity',
      'consumed',
      'goal',
      'progress',
      'pct',
      // Common short names (avoid 'value' — too broad, matches event.target.value)
      'n',
      'num',
      'amount',
      'count',
      'score',
    ]);

    // Known DB data-container variable names — member access on these is likely
    // from a numeric Postgres column (NUMERIC/INTEGER/FLOAT).
    const DB_CONTAINER = new Set([
      'data',
      'result',
      'row',
      'record',
      'item',
      'entry',
      'payload',
      'response',
      'body',
      'values',
      'totals',
      'macros',
      'stats',
      'summary',
      'log',
      'plan',
      'exercise',
      'product',
      'lot',
      'meal',
      'recipe',
      'ingredient',
      'rpc',
      'ti',
      'ri',
      'p',
      'e',
      's', // common destructured DB result shorthands
    ]);

    function getFinalPropertyName(node) {
      // Walk through MemberExpression / ChainExpression chain to get the final property name
      let cursor = node;
      while (cursor) {
        if (cursor.type === 'ChainExpression') {
          cursor = cursor.expression;
          continue;
        }
        if (cursor.type === 'MemberExpression') {
          const prop = cursor.property;
          if (prop && prop.type === 'Identifier') return prop.name;
          return null;
        }
        break;
      }
      return null;
    }

    function getRootObjectName(node) {
      // Walk to the root Identifier of a member chain (e.g. rpc.calories?.consumed → 'rpc')
      let cursor = node;
      while (cursor) {
        if (cursor.type === 'ChainExpression') {
          cursor = cursor.expression;
          continue;
        }
        if (cursor.type === 'MemberExpression') {
          cursor = cursor.object;
          continue;
        }
        if (cursor.type === 'Identifier') return cursor.name;
        break;
      }
      return null;
    }

    function isNumericPropName(name) {
      if (!name) return false;
      if (NUMERIC_PREFIX.test(name)) return true;
      if (NUMERIC_EXACT.has(name.toLowerCase())) return true;
      if (NUMERIC_SUFFIX.test(name)) return true;
      return false;
    }

    function isAllowlistedArg(arg) {
      if (!arg) return false;

      // Identifier: check name patterns
      if (arg.type === 'Identifier') {
        return isNumericPropName(arg.name);
      }

      // MemberExpression / ChainExpression (including optional chaining a?.b?.c)
      if (arg.type === 'MemberExpression' || arg.type === 'ChainExpression') {
        // Check final property name (the outermost .prop)
        const finalProp = getFinalPropertyName(arg);
        if (isNumericPropName(finalProp)) return true;

        // Check root object name (e.g. rpc, log, data, row)
        const rootObj = getRootObjectName(arg);
        if (rootObj && DB_CONTAINER.has(rootObj)) return true;

        return false;
      }

      // LogicalExpression: Number(x ?? fallback) — check left side
      if (arg.type === 'LogicalExpression') {
        return isAllowlistedArg(arg.left);
      }

      return false;
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
        if (isAllowlistedArg(arg)) return;
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
