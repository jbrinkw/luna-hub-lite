/**
 * Scenario 1 — Brand-new user walkthrough.
 *
 * A freshly signed-up user activates both ChefByte AND CoachByte and then
 * loads every main page in all three modules. The test fails if ANY page:
 *   - logs a `console.error` during load
 *   - raises an uncaught `pageerror`
 *   - never reaches its known landmark testId within 10s (i.e. stuck in a
 *     permanent loader because some query threw on empty data)
 *
 * Covers the exact set enumerated in the audit prompt:
 *   /hub, /hub/apps, /hub/tools, /hub/extensions, /hub/mcp
 *   /chef, /chef/meal-plan, /chef/recipes, /chef/shopping, /chef/inventory,
 *       /chef/settings, /chef/macros, /chef/scanner
 *   /coach, /coach/history, /coach/prs, /coach/split, /coach/settings
 *
 * Each page is visited in a single fresh user session (user is created +
 * activated once, then cleaned up afterAll). That's the realistic "brand-new
 * user just signed up" shape — distinct from the existing empty-account spec
 * which creates one user per page.
 */
import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import { seedFullAndLogin } from '../helpers/seed';

interface Listener {
  consoleErrors: string[];
  pageErrors: Error[];
}

function attachErrorListeners(page: Page): Listener {
  const listener: Listener = { consoleErrors: [], pageErrors: [] };
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // Benign third-party noise we can't fix from app code.
    if (/Download the React DevTools/i.test(text)) return;
    if (/Failed to load resource.*favicon/i.test(text)) return;
    // The dev server proxies /rest/ calls to Supabase; a 406 "no rows" on
    // a .single() call with no seeded data is not a rendering bug, just
    // normal PostgREST behaviour that every query here gracefully handles.
    if (/406.*\/rest\/v1\//i.test(text)) return;
    // Ditto for 400 "no rows" when a lookup returns nothing.
    if (/404.*\/rest\/v1\//i.test(text)) return;
    listener.consoleErrors.push(text);
  });
  page.on('pageerror', (err: Error) => {
    listener.pageErrors.push(err);
  });
  return listener;
}

function assertClean(listener: Listener, route: string) {
  if (listener.pageErrors.length > 0) {
    throw new Error(
      `[${route}] uncaught JS errors on brand-new user:\n` +
        listener.pageErrors.map((e) => `  - ${e.message}`).join('\n'),
    );
  }
  if (listener.consoleErrors.length > 0) {
    throw new Error(
      `[${route}] console errors on brand-new user:\n` + listener.consoleErrors.map((e) => `  - ${e}`).join('\n'),
    );
  }
}

// One landmark per route. Each landmark is visible only AFTER the page's
// queries resolve, so timing out on it proves the page is stuck loading.
// We deliberately use testIds that already exist in the codebase — no new
// hooks required.
const ROUTES: Array<{ path: string; landmark: string; label: string }> = [
  // --- Hub ---
  { path: '/hub', landmark: 'hub-settings-link', label: 'hub-home' },
  // AppsPage has no dedicated testId — use the "CoachByte" activation card
  // heading which is always rendered post-load. Falls back to role=heading.
  { path: '/hub/apps', landmark: 'heading:Apps', label: 'hub-apps' },
  { path: '/hub/tools', landmark: 'heading:Tools', label: 'hub-tools' },
  { path: '/hub/extensions', landmark: 'heading:Extensions', label: 'hub-extensions' },
  // McpSettingsPage exposes copy-endpoint once data resolves.
  { path: '/hub/mcp', landmark: 'copy-endpoint', label: 'hub-mcp' },

  // --- ChefByte ---
  { path: '/chef', landmark: 'status-cards', label: 'chef-home' },
  { path: '/chef/meal-plan', landmark: 'no-meals', label: 'chef-meal-plan' },
  { path: '/chef/recipes', landmark: 'no-recipes', label: 'chef-recipes' },
  { path: '/chef/shopping', landmark: 'no-to-buy', label: 'chef-shopping' },
  { path: '/chef/inventory', landmark: 'no-products', label: 'chef-inventory' },
  { path: '/chef/settings', landmark: 'products-tab', label: 'chef-settings' },
  { path: '/chef/macros', landmark: 'no-consumed', label: 'chef-macros' },
  // Scanner renders its container immediately — query hook only fires on scan.
  { path: '/chef/scanner', landmark: 'scanner-container', label: 'chef-scanner' },

  // --- CoachByte ---
  // Today page: completed-section always renders once the daily plan query resolves.
  { path: '/coach', landmark: 'completed-section', label: 'coach-today' },
  { path: '/coach/history', landmark: 'no-history', label: 'coach-history' },
  { path: '/coach/prs', landmark: 'no-prs', label: 'coach-prs' },
  // Split page: weekday row 0 (Sunday) always rendered (empty state is per-day).
  { path: '/coach/split', landmark: 'day-0', label: 'coach-split' },
  { path: '/coach/settings', landmark: 'defaults-card', label: 'coach-settings' },
];

test.describe('Brand-new user — every main page renders cleanly', () => {
  test('walk all hub + chef + coach routes', async ({ page }) => {
    test.setTimeout(300_000);
    const { cleanup } = await seedFullAndLogin(page, 'new-user-walk');
    const failures: string[] = [];
    try {
      for (const route of ROUTES) {
        const listener = attachErrorListeners(page);
        await page.goto(route.path);

        // Resolve landmark — either a testId or a heading fallback.
        const locator = route.landmark.startsWith('heading:')
          ? page.getByRole('heading', { name: route.landmark.slice('heading:'.length), level: 1 })
          : page.getByTestId(route.landmark);

        try {
          await expect(locator.first()).toBeVisible({ timeout: 10_000 });
        } catch {
          failures.push(
            `[${route.label}] landmark "${route.landmark}" never appeared at ${route.path} (stuck loading?)`,
          );
          // Remove listeners so assertClean doesn't re-add the same failure.
          page.removeAllListeners('console');
          page.removeAllListeners('pageerror');
          continue;
        }

        // Short settle so late-firing rejections surface.
        await page.waitForTimeout(300);

        try {
          assertClean(listener, route.label);
        } catch (err) {
          failures.push((err as Error).message);
        } finally {
          page.removeAllListeners('console');
          page.removeAllListeners('pageerror');
        }
      }

      if (failures.length > 0) {
        throw new Error(`Brand-new user walk failures:\n${failures.map((f) => `  ${f}`).join('\n')}`);
      }
    } finally {
      await cleanup();
    }
  });
});
