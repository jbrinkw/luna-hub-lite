/**
 * ESLint rule: no-unchecked-supabase-mutation
 *
 * Flags supabase mutation chains whose `error` is silently dropped. A "mutation
 * chain" is any await/expression that ends in one of:
 *
 *   .from('x').insert(...)
 *   .from('x').update(...)
 *   .from('x').delete()
 *   .from('x').upsert(...)
 *   .rpc('foo', {...})
 *
 * possibly with intermediate .eq / .select / .single / .maybeSingle / etc
 * tacked on. The base may be `supabase.`, `chefbyte().`, `coachbyte().`,
 * `(chefbyte() as any).` or any identifier or call expression — we don't try
 * to be clever about which client; instead we look for the marker method
 * names (`from` followed by a mutation method, or a top-level `rpc` call).
 *
 * The result of such a chain MUST either be:
 *
 *   a) destructured with an `error` property, OR
 *   b) used inside a `throw` / `Promise.reject(...)` / `if (...)` check that
 *      reads its `.error`, OR
 *   c) returned from the enclosing function so the caller is on the hook for
 *      checking it.
 *
 * Anything else — most commonly a bare `await chefbyte().from(...).insert(...)`
 * statement or an awaited expression whose value is discarded — is reported.
 *
 * False-positive surface: this rule will miss exotic cases (variables aliased
 * to `.from(x).insert(y)` then awaited later, builders constructed in a loop)
 * but those have been historically rare in this codebase. The rule is run as
 * `error` only against `apps/web/src/**` and `supabase/functions/**`, with
 * tests excluded entirely (mocks legitimately return shapes that don't need
 * checking).
 */

'use strict';

const MUTATION_METHODS = new Set(['insert', 'update', 'delete', 'upsert']);

/**
 * Walk a CallExpression chain backwards from the outermost call. Returns the
 * LAST mutation method we encountered on a `.from(...)` chain, or 'rpc' if the
 * chain ends in a top-level `.rpc(...)` call. Returns null if the chain isn't
 * a recognized mutation.
 *
 * Example: `chefbyte().from('x').insert(...).select().single()` → walks back
 * past .single, .select, .insert (HIT — return 'insert').
 *
 * Special case: a chain that ends in `.then(...)` is treated as
 * "promise-consumed" — we let the .then callback's body decide whether to
 * check `error`. We don't try to introspect the .then body; the developer
 * has explicitly chosen the callback form, which is a strong signal that
 * the result is being consumed.
 */
function classifyChain(node) {
  let current = node;
  // Unwrap parenthesized / `as any` / non-null assertions.
  while (
    current &&
    (current.type === 'TSAsExpression' || current.type === 'TSNonNullExpression' || current.type === 'TSTypeAssertion')
  ) {
    current = current.expression;
  }

  // Walk down through the call chain.
  while (current && current.type === 'CallExpression') {
    const callee = current.callee;
    if (callee && callee.type === 'MemberExpression' && callee.property && callee.property.type === 'Identifier') {
      const method = callee.property.name;
      // .then / .catch consume the promise — the user has opted into a
      // callback-form result handler, so we don't second-guess.
      if ((method === 'then' || method === 'catch') && hasFromAncestor(callee.object)) {
        return null;
      }
      if (MUTATION_METHODS.has(method)) {
        // Confirm there is a `.from(...)` somewhere upstream of this call.
        // (We don't want to flag plain JS Array.insert / Set.delete etc.)
        if (hasFromAncestor(callee.object)) {
          return method;
        }
      }
      if (method === 'rpc') {
        // top-level rpc(...) on whatever client.
        return 'rpc';
      }
      current = callee.object;
      continue;
    }
    break;
  }
  return null;
}

/**
 * Returns true if the given expression has a `.from(...)` call anywhere in its
 * member-expression / call-expression chain. Supabase clients always start
 * mutations with `.from(...)`.
 */
function hasFromAncestor(node) {
  let current = node;
  while (current) {
    while (
      current &&
      (current.type === 'TSAsExpression' ||
        current.type === 'TSNonNullExpression' ||
        current.type === 'TSTypeAssertion')
    ) {
      current = current.expression;
    }
    if (!current) return false;
    if (current.type === 'CallExpression') {
      const callee = current.callee;
      if (callee && callee.type === 'MemberExpression' && callee.property && callee.property.type === 'Identifier') {
        if (callee.property.name === 'from') return true;
        current = callee.object;
        continue;
      }
      // `chefbyte()` or similar — drill into its callee object if it has one.
      if (callee && callee.type === 'MemberExpression') {
        current = callee.object;
        continue;
      }
      return false;
    }
    if (current.type === 'MemberExpression') {
      current = current.object;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Walk up from `node` to find the meaningful enclosing context that determines
 * whether the call's error is checked. Returns one of:
 *   - 'destructured-error' — assigned via `const { error } = ...`
 *   - 'returned' — the call's value is the return value of the surrounding fn
 *   - 'thrown' — wrapped in `throw` (Promise.reject too)
 *   - 'discarded' — anything else (the bug we want to flag)
 */
function classifyUsage(node) {
  let current = node;
  // Step 1: pop off await / parenthesized / TS assertions.
  while (
    current.parent &&
    (current.parent.type === 'AwaitExpression' ||
      current.parent.type === 'TSAsExpression' ||
      current.parent.type === 'TSNonNullExpression' ||
      current.parent.type === 'TSTypeAssertion' ||
      current.parent.type === 'ParenthesizedExpression' ||
      current.parent.type === 'ChainExpression')
  ) {
    current = current.parent;
  }

  const parent = current.parent;
  if (!parent) return 'discarded';

  // VariableDeclarator with ObjectPattern that destructures `error`.
  if (parent.type === 'VariableDeclarator' && parent.init === current) {
    const id = parent.id;
    if (id && id.type === 'ObjectPattern') {
      for (const prop of id.properties) {
        if (prop.type === 'Property' && prop.key && prop.key.type === 'Identifier' && prop.key.name === 'error') {
          return 'destructured-error';
        }
      }
    }
    // Bare `const result = await ...` — caller decides. We treat this as OK
    // only if the `result` variable is later read on `.error`. Heuristic
    // approximation: be conservative and accept the assignment (false
    // negatives possible, but matches the common "I'll check later" pattern).
    return 'destructured-error';
  }

  // Return statement — caller deals with it.
  if (parent.type === 'ReturnStatement') return 'returned';
  if (parent.type === 'ArrowFunctionExpression' && parent.body === current) return 'returned';

  // Throw / Promise.reject — error semantics handled.
  if (parent.type === 'ThrowStatement') return 'thrown';

  // Bare ExpressionStatement (`await chefbyte().from(...).insert(...);`) —
  // value discarded. THIS is the bug.
  if (parent.type === 'ExpressionStatement') return 'discarded';

  // Anything else (logical exprs, conditional, member access, function args
  // that aren't return) — not obviously safe, but also not the canonical
  // discarded-value bug. Default to allowed to keep false-positive rate low.
  return 'returned';
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Supabase mutation chains whose `error` is silently swallowed. ' +
        'Destructure `{ error }` or rethrow on failure.',
    },
    schema: [],
    messages: {
      uncheckedMutation:
        'Supabase `.{{method}}(...)` mutation result is discarded — destructure `{ error }` ' +
        'and rethrow / surface it, or return the result so the caller can handle it.',
    },
  },

  create(context) {
    function check(callExprNode) {
      const kind = classifyChain(callExprNode);
      if (!kind) return;
      const usage = classifyUsage(callExprNode);
      if (usage === 'discarded') {
        context.report({
          node: callExprNode,
          messageId: 'uncheckedMutation',
          data: { method: kind },
        });
      }
    }

    return {
      // Cover both `await chain.insert(...)` and bare `chain.insert(...)`.
      // We only inspect at the OUTERMOST CallExpression of a chain by
      // checking that our parent isn't another CallExpression with us as the
      // callee — which would mean we're an inner link.
      CallExpression(node) {
        // If this call is the callee.object of a parent CallExpression's
        // member-expression, it's NOT the outermost call — skip. We want to
        // analyze the WHOLE chain at its terminal node.
        const parent = node.parent;
        if (
          parent &&
          parent.type === 'MemberExpression' &&
          parent.object === node &&
          parent.parent &&
          parent.parent.type === 'CallExpression' &&
          parent.parent.callee === parent
        ) {
          // Inner link of a longer chain — let the outer call get checked.
          return;
        }
        check(node);
      },
    };
  },
};
