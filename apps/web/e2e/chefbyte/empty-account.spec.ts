/**
 * Empty-account coverage for ChefByte pages.
 *
 * A common class of bug: components assume some data exists and either crash
 * (TypeError / `Cannot read properties of undefined`) or render a blank
 * loading state forever when the user has NO products / lots / recipes /
 * meals / shopping items. This spec walks through every ChefByte page with a
 * freshly-activated empty account and asserts:
 *   - no console errors were logged
 *   - no unhandled promise rejections fired
 *   - the page finishes loading (renders a known empty-state testId or
 *     a known non-empty-state landmark) within 10 seconds
 */
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { seedFullAndLogin } from '../helpers/seed';

type Listener = {
  consoleErrors: string[];
  pageErrors: Error[];
};

function attachErrorListeners(page: Page): Listener {
  const listener: Listener = { consoleErrors: [], pageErrors: [] };
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter out known benign noise from third parties. If this list
      // grows past a handful, the underlying components need fixing.
      if (/Download the React DevTools/i.test(text)) return;
      if (/Failed to load resource.*favicon/i.test(text)) return;
      listener.consoleErrors.push(text);
    }
  });
  page.on('pageerror', (err: Error) => {
    listener.pageErrors.push(err);
  });
  return listener;
}

function assertClean(listener: Listener, route: string) {
  if (listener.pageErrors.length > 0) {
    throw new Error(
      `[${route}] uncaught JS errors on empty account:\n` +
        listener.pageErrors.map((e) => `  - ${e.message}`).join('\n'),
    );
  }
  if (listener.consoleErrors.length > 0) {
    throw new Error(
      `[${route}] console errors on empty account:\n` + listener.consoleErrors.map((e) => `  - ${e}`).join('\n'),
    );
  }
}

// Each route has a known testId that signals the page has actually rendered
// its empty state (or primary landmark) — not a permanent spinner. If the
// route doesn't have a dedicated empty-state testId we use a stable landmark
// that only renders after the data query resolves.
const ROUTES: Array<{ path: string; landmark: string; label: string }> = [
  // Home shows status cards once macros/meals queries resolve.
  { path: '/chef', landmark: 'status-cards', label: 'home' },
  // Meal-plan renders the "no-meals" empty state for every day when plan is empty.
  { path: '/chef/meal-plan', landmark: 'no-meals', label: 'meal-plan' },
  // Recipes has a dedicated `no-recipes` empty state.
  { path: '/chef/recipes', landmark: 'no-recipes', label: 'recipes' },
  // Shopping renders `no-to-buy` when the "To Buy" list is empty.
  { path: '/chef/shopping', landmark: 'no-to-buy', label: 'shopping' },
  // Inventory shows `no-products` when no products exist at all.
  { path: '/chef/inventory', landmark: 'no-products', label: 'inventory' },
  // Settings: Products tab is the default active tab content. It has a
  // unique testId (unlike settings-tabs which exists twice — mobile +
  // desktop variants).
  { path: '/chef/settings', landmark: 'products-tab', label: 'settings' },
  // Macros renders the "no-consumed" and "no-planned" empty states.
  { path: '/chef/macros', landmark: 'no-consumed', label: 'macros' },
];

test.describe('ChefByte — empty-account rendering', () => {
  for (const route of ROUTES) {
    test(`${route.label} page renders cleanly with no seeded data`, async ({ page }) => {
      test.setTimeout(60_000);
      const listener = attachErrorListeners(page);
      const { cleanup } = await seedFullAndLogin(page, `empty-${route.label}`);
      try {
        await page.goto(route.path);

        // The landmark must appear within 10s — that proves the page
        // didn't get stuck loading. For macros, 'no-consumed' is inside
        // a collapsible section that is open by default.
        await expect(page.getByTestId(route.landmark)).toBeVisible({ timeout: 10_000 });

        // Title must not reveal a rendering error.
        await expect(page).not.toHaveTitle(/error/i);

        // Hold for a short tick so any late-firing promise rejections
        // have a chance to surface.
        await page.waitForTimeout(500);

        assertClean(listener, route.label);
      } finally {
        await cleanup();
      }
    });
  }
});
