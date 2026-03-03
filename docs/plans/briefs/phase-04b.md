# Phase 04b: CoachByte DB — Functions + Flow Tests
> Previous: phase-04a.md | Next: phase-05a.md

## Skills
test-driven-development, test-quality-review, context7 (Supabase)

## Build

**Private functions (SECURITY DEFINER, SET search_path = ''):**
- `private.ensure_daily_plan(p_user_id UUID, p_day DATE)` — idempotent bootstrap: create daily_plan (ON CONFLICT DO NOTHING), copy weekday split into planned_sets, resolve relative loads from derived PRs (query MAX Epley from completed_sets: `load * (1 + reps/30)`, 1-rep uses actual weight, 0-rep excluded, no rep cap), round to nearest 5, delete previous day if 0 completed sets. Returns plan JSONB.
- `private.complete_next_set(p_user_id UUID, p_plan_id UUID, p_actual_reps INTEGER, p_actual_load NUMERIC)` RETURNS TABLE(rest_seconds INTEGER) — find lowest-order incomplete planned_set, insert completed_set, return next set's rest_seconds. **No PR upsert** — PRs derived at query time (decision #6).

**Thin RPC wrappers (SECURITY DEFINER, delegates to private):**
- `coachbyte.ensure_daily_plan(p_day DATE)` — calls `private.ensure_daily_plan((select auth.uid()), p_day)`
- `coachbyte.complete_next_set(p_plan_id UUID, p_reps INTEGER, p_load NUMERIC)` — calls `private.complete_next_set((select auth.uid()), ...)`
- GRANT EXECUTE on both wrappers TO authenticated

**Extend activation/deactivation:**
- `private.activate_app()` CoachByte branch — seed user_settings row with defaults
- `private.deactivate_app()` CoachByte branch — CASCADE delete all CoachByte user data (plans, sets, splits, timer, user_settings)

## Test (TDD)

### pgTAP: `supabase/tests/coachbyte/ensure_daily_plan.test.sql`
- Create split for Monday (Squat 3x5 @ 80%, Bench 3x5 @ 185lb)
- Seed completed_set for Squat to establish derived e1rm = 300lb (via Epley: e.g. 255lb x 5 reps = 255*(1+5/30) = 297.5, or direct seeding)
- Call ensure_daily_plan for Monday → plan created
- Verify Squat loads resolved to 240lb (80% of 300, rounded to nearest 5)
- Verify Bench at 185lb (absolute, not percentage)
- Call ensure_daily_plan again for same day → same plan returned (idempotent, no duplicate)
- Call for Tuesday with no split defined → empty plan (zero planned sets)
- Create plan for Day X with 0 completed sets → call ensure for Day X+1 → Day X deleted
- Create plan for Day X with 1+ completed sets → call ensure for Day X+1 → Day X preserved
- Exercise with no completed_sets and percentage-based load → resolved weight is NULL
- Verify logical_date computed via get_logical_date with user's day_start_hour

### pgTAP: `supabase/tests/coachbyte/complete_next_set.test.sql`
- Create plan with 3 planned sets (order 1, 2, 3)
- Complete first → completed_set created for order 1
- Complete again → completed_set created for order 2 (sequential)
- Attempt to skip order → rejected (function finds lowest-order incomplete)
- Override reps/load → stored in completed_set correctly
- Failed set (0 reps) → completed_set created but excluded from derived PR
- 1-rep set → derived PR uses actual weight, not Epley formula
- Complete all sets → next call returns null (no more sets)
- Returns rest_seconds from the next planned set after completion

### pgTAP: `supabase/tests/coachbyte/timer_states.test.sql`
- Insert timer with state=running → valid, end_time set
- running → paused → succeeds, paused_at set, elapsed_before_pause calculated
- paused → running → succeeds, new end_time = now + remaining time
- running → expired (WHERE end_time <= NOW()) → succeeds
- paused → paused → no-op (0 rows updated, WHERE guard)
- expired → running → rejected (0 rows updated)
- expired → paused → rejected (0 rows updated)
- paused → expired → rejected (0 rows updated)
- Only one timer per user (UNIQUE constraint on user_id)
- Starting new timer replaces existing (INSERT ON CONFLICT replaces)
- elapsed_before_pause calculated correctly after multiple pause/resume cycles

### Integration: `apps/web/src/__tests__/integration/coachbyte/app-activation-coachbyte.test.ts`
- Activate CoachByte → global exercises accessible + user_settings created with defaults
- Insert CoachByte data (split, plan, completed sets)
- Deactivate CoachByte → ALL user's CoachByte data deleted
- Reactivate CoachByte → clean slate (no old data), global exercises still accessible

### Flow: `apps/web/src/__tests__/flows/coachbyte-workout.flow.test.ts`
1. Sign up user → profile created with day_start_hour=6
2. Create weekly split: Monday = Squat 3x5 @ 80%, Bench 3x5 @ 185lb
3. Seed completed_set for Squat to establish derived e1rm = 300lb (via Epley on completed_sets)
4. Bootstrap today's plan (Monday) → verify Squat loads resolved to 240lb (80% of 300, rounded to nearest 5), Bench at 185lb (absolute)
5. Complete set 1 (Squat, 5 reps, 240lb) → verify completed_set created, derived PR unchanged (Epley 240*(1+5/30) = 280 < 300)
6. Verify completion returns next set's rest_seconds
7. Start timer with that rest_seconds → verify timer row created with correct end_time
8. Complete remaining sets with various overrides
9. Complete Bench set with heavy override → verify derived PR computed for Bench (new exercise, no prior history)
10. Query history for today → all sets appear with correct data
11. Create empty plan for another day (0 completions), then bootstrap next day → empty day deleted

### Flow: `apps/web/src/__tests__/flows/coachbyte-timer.flow.test.ts`
1. Start timer (90s) → verify state=running, end_time = now + 90s
2. Advance 30s → pause → verify state=paused, elapsed_before_pause=30
3. Resume → verify state=running, new end_time = now + 60s (remaining)
4. Advance 60s → expire (via atomic WHERE guard) → verify state=expired
5. Start new timer (60s) → verify replaces expired timer (one timer per user)

### Quality gate
After all tests in each layer pass, dispatch `test-quality-review` per-batch before marking done.

## Legacy Reference
- `legacy/luna_ext_coachbyte/tools/coachbyte_tools.py` — tool handlers with plan bootstrap + set completion logic
- `legacy/luna_ext_coachbyte/services/api/server.py` — REST routes for plans, sets, timer, splits; DB schema definitions

## Commit
`feat: coachbyte DB functions + flow tests`

## Acceptance
- [ ] ensure_daily_plan is idempotent (call twice, one plan)
- [ ] Relative loads derived from completed_sets via Epley (no PR table), rounded to nearest 5
- [ ] complete_next_set enforces sequential order and returns rest_seconds
- [ ] Timer state machine enforces valid transitions via WHERE guards
- [ ] Activation seeds user_settings; deactivation cascades all CoachByte data
- [ ] No exercise_prs table — all PR derivation uses completed_sets + Epley formula
- [ ] Targeted tests pass: `supabase test db supabase/tests/coachbyte/`
- [ ] Integration tests pass: `pnpm --filter web exec vitest -c vitest.integration.config.ts run src/__tests__/integration/coachbyte/app-activation-coachbyte.test.ts`
- [ ] Flow tests pass: `pnpm --filter web exec vitest -c vitest.integration.config.ts run src/__tests__/flows/coachbyte-workout.flow.test.ts src/__tests__/flows/coachbyte-timer.flow.test.ts`
- [ ] Full DB tests pass: `supabase test db`
