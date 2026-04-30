/**
 * Rule: no-empty-catch-no-comment
 *
 * Flag `catch` blocks that:
 *   - have an empty body, OR
 *   - contain ONLY a comment that doesn't justify swallowing
 *
 * The Obsidian `getMultipleBlobs` bug (commit 180fcc9) was a `catch { /* skip * /  }`
 * that silently dropped per-file fetch failures. The audit finding said
 * "empty + comment" is the same anti-pattern as bare `catch {}` — the
 * comment is performative.
 *
 * Acceptable patterns inside catch:
 *   - re-throw: `throw e;` / `throw new ...`
 *   - log/telemetry call AND a re-throw OR explicit fallback assignment
 *   - structured fallback that mutates outer state visibly
 *
 * Unacceptable:
 *   - `catch {}`
 *   - `catch (e) {}`
 *   - `catch { /* anything * /  }` with no statements
 *
 * To intentionally allow (rare): use the standard ESLint disable comment
 * with a reason:
 *   // eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment
 *   // reason: <why this swallow is correct>
 */
'use strict';

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'forbid catch blocks with empty body or comment-only body',
    },
    schema: [],
    messages: {
      emptyCatch:
        'catch block has no statements. Either re-throw, log+fallback, or add `// eslint-disable-next-line @luna/anti-lazy/no-empty-catch-no-comment` with a reason.',
      commentOnlyCatch:
        'catch block has only a comment, no statements. Comments do not handle errors. Either re-throw, log+fallback, or eslint-disable with a reason.',
    },
  },
  create(context) {
    return {
      CatchClause(node) {
        const body = node.body && node.body.body;
        if (!body || body.length > 0) return;

        // Check if there are any comments inside the block. If yes, this is
        // a "comment-only catch" — performative.
        const sourceCode = context.getSourceCode();
        const blockComments = sourceCode.getCommentsInside(node.body) || [];
        const messageId = blockComments.length > 0 ? 'commentOnlyCatch' : 'emptyCatch';

        context.report({ node: node.body, messageId });
      },
    };
  },
};
