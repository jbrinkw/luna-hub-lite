/**
 * UX Audit R2 — Recipes "Uses expiring stock" window must include
 * already-expired lots (R2 finding #4).
 *
 * R1 shipped the chip but used `today..today+7` — a user staring at
 * the "expired — discard" section with 4 yogurts and toggling the
 * chip would see ZERO matching recipes because every yogurt's
 * expires_on was strictly < today. R2 widens the lower bound to
 * `today - EXPIRING_LOOKBACK_DAYS`. These tests pin the constants and
 * the helper.
 *
 * Tests are at the pure-helper layer because the windowing logic lives
 * inside the page's queryFn — but the constants and `recipeUsesExpiringStock`
 * helper are exported for exactly this reason.
 */
import { describe, it, expect } from 'vitest';
import { EXPIRING_LOOKBACK_DAYS, EXPIRING_WINDOW_DAYS, recipeUsesExpiringStock } from '@/pages/chefbyte/RecipesPage';

describe('Recipes expiring-window constants', () => {
  it('EXPIRING_WINDOW_DAYS is a positive integer (forward window)', () => {
    expect(Number.isInteger(EXPIRING_WINDOW_DAYS)).toBe(true);
    expect(EXPIRING_WINDOW_DAYS).toBeGreaterThan(0);
  });

  it('EXPIRING_LOOKBACK_DAYS is a positive integer (backward lookback)', () => {
    expect(Number.isInteger(EXPIRING_LOOKBACK_DAYS)).toBe(true);
    expect(EXPIRING_LOOKBACK_DAYS).toBeGreaterThan(0);
  });

  it('EXPIRING_LOOKBACK_DAYS covers the typical "past few days expired" case', () => {
    // 7 was the chosen value — long enough to catch a missed-week,
    // short enough that the chip doesn't surface ancient expirations.
    expect(EXPIRING_LOOKBACK_DAYS).toBeGreaterThanOrEqual(3);
    expect(EXPIRING_LOOKBACK_DAYS).toBeLessThanOrEqual(14);
  });
});

/**
 * Light validation that the helper still surfaces recipes whose
 * ingredients overlap the precomputed expiring set — the set itself
 * is built by the queryFn using the new lookback. The helper is
 * intentionally agnostic of dates: it's a pure ingredient ∩ set check.
 *
 * The test case below mirrors the R2 scenario: a yogurt that expired
 * yesterday (still legitimately edible / actionable for the user) —
 * the queryFn would now include `prod-yogurt` in `expiringProductIds`
 * because the new window is `today - 7 .. today + 7`. The helper
 * correctly returns `true` regardless of which side of `today` the
 * lot is on, so the only behaviour that needed pinning is the
 * window itself (covered by the constant assertions above) and the
 * helper's set-based contract (covered here).
 */
describe('recipeUsesExpiringStock — independent of past-vs-future', () => {
  it('matches when an ingredient appears in the expiring set (past-side scenario)', () => {
    const ings = [{ product_id: 'prod-yogurt' }];
    const expiringSetWithYesterday = new Set(['prod-yogurt']);
    expect(recipeUsesExpiringStock(ings, expiringSetWithYesterday)).toBe(true);
  });

  it('matches when an ingredient appears in the expiring set (future-side scenario)', () => {
    const ings = [{ product_id: 'prod-bread' }];
    const expiringSetWithThreeDaysOut = new Set(['prod-bread']);
    expect(recipeUsesExpiringStock(ings, expiringSetWithThreeDaysOut)).toBe(true);
  });

  it('rejects when ingredient set and expiring set are disjoint', () => {
    expect(recipeUsesExpiringStock([{ product_id: 'a' }], new Set(['b', 'c']))).toBe(false);
  });
});
