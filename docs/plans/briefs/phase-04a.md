# Phase 04a: CoachByte DB — Tables + RLS
> Previous: phase-03e.md | Next: phase-04b.md

## Skills
test-driven-development, test-quality-review, context7 (Supabase, pgTAP)

## Build

Single migration file — order: tables, indexes, RLS, seeds.

**Tables:**
- `coachbyte.exercises` (exercise_id UUID PK DEFAULT gen_random_uuid(), user_id UUID REFERENCES auth.users ON DELETE CASCADE — nullable for globals, name TEXT, UNIQUE(user_id, LOWER(name)), created_at TIMESTAMPTZ DEFAULT now())
- `coachbyte.user_settings` (user_id UUID PK REFERENCES auth.users ON DELETE CASCADE, default_rest_seconds INTEGER DEFAULT 90, bar_weight_lbs NUMERIC(10,3) DEFAULT 45, available_plates JSONB DEFAULT '[45,35,25,10,5,2.5]')
- `coachbyte.daily_plans` (plan_id UUID PK DEFAULT gen_random_uuid(), user_id UUID REFERENCES auth.users ON DELETE CASCADE, plan_date DATE, logical_date DATE, summary TEXT, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(user_id, plan_date))
- `coachbyte.planned_sets` (planned_set_id UUID PK DEFAULT gen_random_uuid(), plan_id UUID FK REFERENCES daily_plans ON DELETE CASCADE, exercise_id UUID FK REFERENCES exercises, target_reps INTEGER, target_load NUMERIC(10,3), target_load_percentage NUMERIC(5,2) — nullable, rest_seconds INTEGER, "order" INTEGER)
- `coachbyte.completed_sets` (completed_set_id UUID PK DEFAULT gen_random_uuid(), plan_id UUID FK REFERENCES daily_plans ON DELETE CASCADE, planned_set_id UUID FK REFERENCES planned_sets ON DELETE SET NULL — nullable for ad-hoc, exercise_id UUID FK REFERENCES exercises, actual_reps INTEGER, actual_load NUMERIC(10,3), logical_date DATE, completed_at TIMESTAMPTZ DEFAULT now())
- `coachbyte.splits` (split_id UUID PK DEFAULT gen_random_uuid(), user_id UUID REFERENCES auth.users ON DELETE CASCADE, weekday INTEGER CHECK (weekday BETWEEN 0 AND 6), template_sets JSONB, split_notes TEXT)
- `coachbyte.timers` (timer_id UUID PK DEFAULT gen_random_uuid(), user_id UUID UNIQUE REFERENCES auth.users ON DELETE CASCADE, state TEXT CHECK (state IN ('running','paused','expired')), end_time TIMESTAMPTZ, paused_at TIMESTAMPTZ, duration_seconds INTEGER, elapsed_before_pause INTEGER DEFAULT 0)
- **No exercise_prs table** — PRs derived from completed_sets via Epley formula (decision #6)

**Indexes:**
- `(user_id, logical_date)` on completed_sets
- `(exercise_id)` on completed_sets (for PR derivation queries)
- Partial index on exercises: `WHERE user_id IS NULL` (global exercises)
- UNIQUE `(user_id, weekday)` on splits

**RLS policies (all tables):**
- Standard: `(select auth.uid()) = user_id TO authenticated` for SELECT, INSERT, UPDATE, DELETE
- exercises exception: SELECT also allows `user_id IS NULL` (global). INSERT/UPDATE/DELETE restricted to `(select auth.uid()) = user_id` only (no writes to globals).

**Seeds:**
- Global exercise library (user_id = NULL): Squat, Bench Press, Deadlift, Overhead Press, Barbell Row, Pull-Up, Dip, Lat Pulldown, Cable Row, Leg Press, Romanian Deadlift, Front Squat, Incline Bench Press, Barbell Curl, Tricep Extension, Lateral Raise, Face Pull, Leg Curl, Leg Extension, Calf Raise

## Test (TDD)

### pgTAP: `supabase/tests/coachbyte/exercise_rls.test.sql`
- User A can SELECT global exercises (user_id IS NULL)
- User A can SELECT their own custom exercises
- User A cannot SELECT User B's custom exercises
- User A can INSERT exercises with their own user_id
- User A cannot INSERT exercises with user_id = NULL (only service role can seed globals)
- User A cannot UPDATE global exercises
- User A cannot DELETE global exercises
- User A can UPDATE their own custom exercises
- User A can DELETE their own custom exercises
- Uniqueness: User A inserting duplicate name (case-insensitive) rejected

### pgTAP: `supabase/tests/hub/activation_coachbyte.test.sql`
- Activate CoachByte → global exercises accessible, user_settings row created with defaults (rest=90, bar=45, plates=[45,35,25,10,5,2.5])
- Deactivate CoachByte → all user's CoachByte data deleted (plans, sets, splits, timer, user_settings)
- Reactivate → clean slate, fresh seeds, no leftover data

### Quality gate
After all tests in each layer pass, dispatch `test-quality-review` per-batch before marking done.

## Legacy Reference
- `legacy/luna_ext_coachbyte/services/api/server.py` — DB schema definitions (embedded SQL)
- `legacy/luna_ext_coachbyte/tools/populate_coachbyte_demo.py` — exercise seed data reference
- `legacy/luna_ext_coachbyte/tools/coachbyte_tools.py` — tool definitions showing table structure

## Commit
`feat: coachbyte DB tables + RLS + exercise seeds`

## Acceptance
- [ ] All CoachByte tables created in coachbyte schema with correct columns and constraints
- [ ] Global exercises seeded (20 common exercises with user_id = NULL)
- [ ] RLS enforced: user isolation + global exercise read access
- [ ] No exercise_prs table exists anywhere
- [ ] UNIQUE(user_id, LOWER(name)) rejects case-insensitive duplicates
- [ ] UNIQUE(user_id, weekday) on splits prevents duplicate weekday entries
- [ ] Timer UNIQUE on user_id enforces one timer per user
- [ ] Targeted tests pass: `supabase test db supabase/tests/coachbyte/exercise_rls.test.sql`
- [ ] Targeted tests pass: `supabase test db supabase/tests/hub/activation_coachbyte.test.sql`
- [ ] Full DB tests pass: `supabase test db`
