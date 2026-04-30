/**
 * console-error-gate.ts — Playwright fixture
 *
 * Collects every browser `console.error` logged during a test and fails
 * the test if any are present at teardown. Catches "401 broadcast" and
 * "Live updates paused" style silent errors that existing assertions miss.
 *
 * Opt-out per-test: call `suppressConsoleErrors(page, [/pattern/])` from
 * inside the test body to register patterns that are expected and should
 * be filtered before the gate fires.
 *
 * Usage: this fixture is merged into `test-base.ts` as an auto fixture so
 * every scenario inherits it without any import change.
 */

import { type Page } from '@playwright/test';

/** Registry: page → list of patterns to suppress */
const suppressions = new WeakMap<Page, RegExp[]>();

/**
 * Call from inside a test body to whitelist expected console errors.
 *
 * Example:
 *   suppressConsoleErrors(page, [/Expected warning/, /401/]);
 */
export function suppressConsoleErrors(page: Page, patterns: RegExp[]): void {
  const existing = suppressions.get(page) ?? [];
  suppressions.set(page, [...existing, ...patterns]);
}

/**
 * Wire the console-error listener onto `page`. Returns a finalizer that
 * asserts no unfiltered errors were logged. The finalizer is called by
 * the `test-base.ts` fixture after `use()` so it runs even on failure
 * (to surface the error list alongside the scenario failure).
 *
 * Returns: [setup fn, teardown fn]. Teardown throws if errors are found.
 */
export function makeConsoleErrorGate(page: Page): {
  setup: () => void;
  teardown: () => void;
} {
  const errors: string[] = [];

  const setup = () => {
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      const patterns = suppressions.get(page) ?? [];
      if (patterns.some((re) => re.test(text))) return;
      errors.push(text);
    });
  };

  const teardown = () => {
    if (errors.length === 0) return;
    throw new Error(
      `console-error-gate: ${errors.length} unexpected browser console error(s) during test:\n` +
        errors.map((e, i) => `  [${i + 1}] ${e}`).join('\n'),
    );
  };

  return { setup, teardown };
}
