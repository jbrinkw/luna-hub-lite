/**
 * @luna/eslint-plugin-anti-lazy
 *
 * Rules that flag patterns Codex audits keep finding:
 *   - empty catch blocks with no comment or re-throw
 *   - bare `expect(fn).toHaveBeenCalled()` without args / count
 *   - bare `Number(x)` without isFinite check
 *   - `?? 0` numeric default in display contexts
 *   - tests importing from a page module instead of a shared helper
 *
 * Each rule is intentionally narrow. The combined effect is to deny the
 * laziness escape hatches that mask real bugs. False positives are
 * acceptable when the disable-with-reason comment is required.
 */
'use strict';

const noEmptyCatchNoComment = require('./rules/no-empty-catch-no-comment');
const noBareToHaveBeenCalled = require('./rules/no-bare-tohavebeencalled');
const noBareNumberCoerce = require('./rules/no-bare-number-coerce');

module.exports = {
  rules: {
    'no-empty-catch-no-comment': noEmptyCatchNoComment,
    'no-bare-tohavebeencalled': noBareToHaveBeenCalled,
    'no-bare-number-coerce': noBareNumberCoerce,
  },
};
