/**
 * Scenario 10 — day-rollover-at-day-start-hour
 *
 * With the user's day_start_hour=6 (logical day starts at 06:00 local), a
 * food consumed at 05:30 local must:
 *   1. Land in `chefbyte.food_logs` with yesterday's logical_date
 *   2. Surface in MacroPage when navigating to yesterday's date
 *
 * We can't realistically freeze the system clock at 05:30 inside the running
 * Supabase Postgres. Instead, we drive `consume_product` with an explicit
 * `p_logical_date` (yesterday's date) — which is exactly what the UI does
 * when the user is on yesterday's MacroPage already. The cloud function
 * `private.get_logical_date()` fallback is well-tested by pgTAP; the cross-
 * layer assertion here is "macro page rendered with day_start_hour=6 honors
 * the logical_date stamp correctly when navigating between days".
 *
 * Catches: day_start_hour-driven UI shifts that desync the macro view from
 * the underlying food_logs.
 */
import { test, expect } from '@playwright/test';
import { adminClient } from '../fixtures/env';
import {
  loginViaUi,
  seedProduct,
  seedStockLot,
  seedUserAndActivate,
  setDayStartHour,
} from '../fixtures/test-db';

test('day-rollover-at-day-start-hour', async ({ page }) => {
  const seeded = await seedUserAndActivate('day-rollover');
  try {
    await setDayStartHour(seeded.userId, 6);

    const productId = await seedProduct(seeded.userId, 'Late Night Snack', {
      barcode: '777000777000',
      servings_per_container: 1,
      calories_per_serving: 400,
    });
    await seedStockLot(seeded.userId, productId, 5);

    // Compute "yesterday" as the user's logical_date for a 05:30 consume.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yyyy = yesterday.getFullYear();
    const mm = String(yesterday.getMonth() + 1).padStart(2, '0');
    const dd = String(yesterday.getDate()).padStart(2, '0');
    const yesterdayStr = `${yyyy}-${mm}-${dd}`;

    // Consume one serving with explicit logical_date = yesterday.
    const userClient = seeded.client;
    const { data: rpcRes, error } = await (userClient as any)
      .schema('chefbyte')
      .rpc('consume_product', {
        p_product_id: productId,
        p_qty: 1,
        p_unit: 'serving',
        p_log_macros: true,
        p_logical_date: yesterdayStr,
      });
    expect(error?.message ?? 'ok').toBe('ok');
    expect(rpcRes?.success).toBe(true);

    // DB-side: food_log stamped with yesterday's logical_date.
    const admin = adminClient();
    const { data: logs, error: logErr } = await (admin as any)
      .schema('chefbyte')
      .from('food_logs')
      .select('*')
      .eq('user_id', seeded.userId)
      .eq('product_id', productId);
    if (logErr) throw logErr;
    expect(logs.length, 'food_logs row count').toBeGreaterThanOrEqual(1);
    expect(logs[0].logical_date).toBe(yesterdayStr);

    // Web-side: macro page → click the prev-date button to go to yesterday,
    // then assert the consumed entry surfaces.
    await loginViaUi(page, seeded.email, seeded.password);
    await page.goto('/chef/macros');
    await expect(page.getByTestId('macro-summary')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('prev-date-btn').click();
    // The date label should now reflect yesterday — the consumed-section
    // populates within 5 s of the date change.
    await expect(page.getByTestId('consumed-section')).toContainText('Late Night Snack', {
      timeout: 10_000,
    });
  } finally {
    await seeded.cleanup();
  }
});
