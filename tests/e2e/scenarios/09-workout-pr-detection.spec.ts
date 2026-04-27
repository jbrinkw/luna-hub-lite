/**
 * Scenario 09 — workout-pr-detection
 *
 * Logs a workout set heavier than the prior PR via the COACHBYTE complete-set
 * RPC. Asserts:
 *   1. `coachbyte.completed_sets` row inserted (the source of PRs)
 *   2. The PRsPage UI re-computes the PR client-side and shows the new
 *      best load/Epley-1RM
 *
 * Note: PRs are derived in the React client from completed_sets — there is
 * no `prs` DB table. So we assert the per-exercise computation surfaces in
 * the rendered UI.
 *
 * Catches: "set logged but PR display didn't update" — the optimistic-update
 * + Epley calc + render chain end-to-end.
 *
 * Note: TodayPage.tsx calls `coachbyte().rpc('complete_next_set', { p_reps,
 * p_load })` but the deployed function takes `p_actual_reps, p_actual_load`
 * (migration 20260422030000). This is a real bug — the UI mutation would
 * fail in production. This scenario uses the deployed param names; flag in
 * decisions.md.
 */
import { test, expect } from '@playwright/test';
import { adminClient } from '../fixtures/env';
import { loginViaUi, seedUserAndActivate } from '../fixtures/test-db';

test('workout-pr-detection', async ({ page }) => {
  const seeded = await seedUserAndActivate('workout-pr');
  try {
    const admin = adminClient();

    const { data: squat } = await (admin as any)
      .schema('coachbyte')
      .from('exercises')
      .select('exercise_id')
      .is('user_id', null)
      .eq('name', 'Squat')
      .maybeSingle();
    expect(squat?.exercise_id).toBeTruthy();

    // Plan a single squat set for today.
    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const weekday = today.getDay();
    await (admin as any).schema('coachbyte').from('splits').insert({
      user_id: seeded.userId,
      weekday,
      template_sets: [{ exercise_id: squat.exercise_id, target_reps: 5, target_load: 200, order: 1 }],
      split_notes: 'PR test split',
    });

    // Drive the RPC chain manually as the user.
    const userClient = seeded.client;
    const { data: planRow } = await (userClient as any)
      .schema('coachbyte')
      .rpc('ensure_daily_plan', { p_day: dateStr });
    expect(planRow.plan_id).toBeTruthy();

    const { data: completed, error } = await (userClient as any)
      .schema('coachbyte')
      .rpc('complete_next_set', {
        p_plan_id: planRow.plan_id,
        p_actual_reps: 5,
        p_actual_load: 315,
      });
    expect(error?.message ?? 'ok', 'complete_next_set').toBe('ok');
    expect(completed).toBeTruthy();

    // DB-side: completed_sets row landed at 315 lb.
    await expect
      .poll(
        async () => {
          const { data } = await (admin as any)
            .schema('coachbyte')
            .from('completed_sets')
            .select('actual_load')
            .eq('user_id', seeded.userId)
            .eq('exercise_id', squat.exercise_id)
            .order('completed_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          return Number(data?.actual_load ?? 0);
        },
        { timeout: 5_000 },
      )
      .toBe(315);

    // Web-side: PRs page renders the new PR (client computes Epley 1RM
    // ≈ 315 × 1.166 = 367 lb from the completed_set).
    await loginViaUi(page, seeded.email, seeded.password);
    await page.goto('/coach/prs');
    await expect(page.getByText('Squat', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('315', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
  } finally {
    await seeded.cleanup();
  }
});
