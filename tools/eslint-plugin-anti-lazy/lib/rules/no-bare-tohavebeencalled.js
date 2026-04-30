/**
 * Rule: no-bare-tohavebeencalled
 *
 * Flag `expect(x).toHaveBeenCalled()` and `expect(x).toHaveBeenCalled` (without parens)
 * — these don't verify WHAT was called or HOW MANY times, only that SOMETHING happened.
 * Codex audits flagged this in HA SSRF, GitHub token-revoke, ApiKeyGenerator labels,
 * coachbyte timer handlers — bugs hid behind "test asserts the call happened."
 *
 * Acceptable replacements:
 *   - `expect(x).toHaveBeenCalledWith(specificArgs)`
 *   - `expect(x).toHaveBeenCalledTimes(N)`
 *   - `expect(x).toHaveBeenLastCalledWith(...)`
 *   - `expect(x).toHaveBeenNthCalledWith(...)`
 *
 * The `not.toHaveBeenCalled()` form IS allowed (asserting NO call is meaningful
 * without args).
 *
 * To intentionally allow (e.g., when args are non-deterministic and untestable):
 *   // eslint-disable-next-line @luna/anti-lazy/no-bare-tohavebeencalled
 *   // reason: <why bare-call assertion is correct here>
 */
'use strict';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'forbid bare expect(x).toHaveBeenCalled() — require args or call-count assertion',
    },
    schema: [],
    messages: {
      bareToHaveBeenCalled:
        'bare toHaveBeenCalled() does not verify WHAT was called or HOW MANY times. Use toHaveBeenCalledWith(...) or toHaveBeenCalledTimes(N) instead.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        // Only inspect zero-argument calls to a method named toHaveBeenCalled.
        if (node.arguments.length !== 0) return;
        const callee = node.callee;
        if (!callee || callee.type !== 'MemberExpression') return;
        const prop = callee.property;
        if (!prop || prop.name !== 'toHaveBeenCalled') return;

        // Walk up the MemberExpression chain to see if `not.` is between
        // expect(...) and toHaveBeenCalled. Allow `expect(x).not.toHaveBeenCalled()`.
        let cursor = callee.object;
        while (cursor && cursor.type === 'MemberExpression') {
          if (cursor.property && cursor.property.name === 'not') return;
          cursor = cursor.object;
        }

        context.report({ node, messageId: 'bareToHaveBeenCalled' });
      },
    };
  },
};
