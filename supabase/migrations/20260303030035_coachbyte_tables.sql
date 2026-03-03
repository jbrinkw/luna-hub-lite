-- CoachByte module tables: exercises, user_settings, daily_plans, planned_sets,
-- completed_sets, splits, timers. Plus RLS, indexes, seeds, activation hooks.

------------------------------------------------------------
-- TABLES
------------------------------------------------------------

-- Exercise library (globals have user_id = NULL)
CREATE TABLE coachbyte.exercises (
  exercise_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user CoachByte settings
CREATE TABLE coachbyte.user_settings (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  default_rest_seconds INTEGER NOT NULL DEFAULT 90,
  bar_weight_lbs NUMERIC(10,3) NOT NULL DEFAULT 45,
  available_plates JSONB NOT NULL DEFAULT '[45,35,25,10,5,2.5]'
);

-- Daily workout plans
CREATE TABLE coachbyte.daily_plans (
  plan_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_date DATE NOT NULL,
  logical_date DATE,
  summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, plan_date)
);

-- Planned sets within a daily plan
CREATE TABLE coachbyte.planned_sets (
  planned_set_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES coachbyte.daily_plans(plan_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exercise_id UUID NOT NULL REFERENCES coachbyte.exercises(exercise_id),
  target_reps INTEGER,
  target_load NUMERIC(10,3),
  target_load_percentage NUMERIC(5,2),
  rest_seconds INTEGER,
  "order" INTEGER NOT NULL
);

-- Completed sets (planned or ad-hoc)
CREATE TABLE coachbyte.completed_sets (
  completed_set_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES coachbyte.daily_plans(plan_id) ON DELETE CASCADE,
  planned_set_id UUID REFERENCES coachbyte.planned_sets(planned_set_id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exercise_id UUID NOT NULL REFERENCES coachbyte.exercises(exercise_id),
  actual_reps INTEGER NOT NULL,
  actual_load NUMERIC(10,3) NOT NULL,
  logical_date DATE,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Weekly split templates
CREATE TABLE coachbyte.splits (
  split_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  template_sets JSONB,
  split_notes TEXT,
  UNIQUE (user_id, weekday)
);

-- Rest timer (one per user, state machine)
CREATE TABLE coachbyte.timers (
  timer_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('running', 'paused', 'expired')),
  end_time TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  duration_seconds INTEGER NOT NULL,
  elapsed_before_pause INTEGER NOT NULL DEFAULT 0
);

------------------------------------------------------------
-- INDEXES
------------------------------------------------------------

-- Exercise uniqueness: per-user (case-insensitive)
CREATE UNIQUE INDEX exercises_user_name_unique
  ON coachbyte.exercises (user_id, LOWER(name))
  WHERE user_id IS NOT NULL;

-- Exercise uniqueness: globals (case-insensitive)
CREATE UNIQUE INDEX exercises_global_name_unique
  ON coachbyte.exercises (LOWER(name))
  WHERE user_id IS NULL;

-- Partial index for fast global exercise lookups
CREATE INDEX exercises_global_idx
  ON coachbyte.exercises (exercise_id)
  WHERE user_id IS NULL;

-- Completed sets: history lookups by user + date
CREATE INDEX completed_sets_user_date_idx
  ON coachbyte.completed_sets (user_id, logical_date);

-- Completed sets: PR derivation by exercise
CREATE INDEX completed_sets_exercise_idx
  ON coachbyte.completed_sets (exercise_id);

------------------------------------------------------------
-- RLS
------------------------------------------------------------

-- exercises: special handling for globals
ALTER TABLE coachbyte.exercises ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own and global exercises"
  ON coachbyte.exercises FOR SELECT TO authenticated
  USING (user_id IS NULL OR (select auth.uid()) = user_id);

CREATE POLICY "Users can insert own exercises"
  ON coachbyte.exercises FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own exercises"
  ON coachbyte.exercises FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own exercises"
  ON coachbyte.exercises FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- user_settings: standard pattern
ALTER TABLE coachbyte.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own settings"
  ON coachbyte.user_settings FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own settings"
  ON coachbyte.user_settings FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own settings"
  ON coachbyte.user_settings FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own settings"
  ON coachbyte.user_settings FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- daily_plans: standard pattern
ALTER TABLE coachbyte.daily_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own plans"
  ON coachbyte.daily_plans FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own plans"
  ON coachbyte.daily_plans FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own plans"
  ON coachbyte.daily_plans FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own plans"
  ON coachbyte.daily_plans FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- planned_sets: standard pattern (user_id denormalized for RLS)
ALTER TABLE coachbyte.planned_sets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own planned sets"
  ON coachbyte.planned_sets FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own planned sets"
  ON coachbyte.planned_sets FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own planned sets"
  ON coachbyte.planned_sets FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own planned sets"
  ON coachbyte.planned_sets FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- completed_sets: standard pattern (user_id denormalized for RLS)
ALTER TABLE coachbyte.completed_sets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own completed sets"
  ON coachbyte.completed_sets FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own completed sets"
  ON coachbyte.completed_sets FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own completed sets"
  ON coachbyte.completed_sets FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own completed sets"
  ON coachbyte.completed_sets FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- splits: standard pattern
ALTER TABLE coachbyte.splits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own splits"
  ON coachbyte.splits FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own splits"
  ON coachbyte.splits FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own splits"
  ON coachbyte.splits FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own splits"
  ON coachbyte.splits FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

-- timers: standard pattern
ALTER TABLE coachbyte.timers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own timer"
  ON coachbyte.timers FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can insert own timer"
  ON coachbyte.timers FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own timer"
  ON coachbyte.timers FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can delete own timer"
  ON coachbyte.timers FOR DELETE TO authenticated
  USING ((select auth.uid()) = user_id);

------------------------------------------------------------
-- SEEDS (global exercises)
------------------------------------------------------------

INSERT INTO coachbyte.exercises (user_id, name) VALUES
  (NULL, 'Squat'),
  (NULL, 'Bench Press'),
  (NULL, 'Deadlift'),
  (NULL, 'Overhead Press'),
  (NULL, 'Barbell Row'),
  (NULL, 'Pull-Up'),
  (NULL, 'Dip'),
  (NULL, 'Lat Pulldown'),
  (NULL, 'Cable Row'),
  (NULL, 'Leg Press'),
  (NULL, 'Romanian Deadlift'),
  (NULL, 'Front Squat'),
  (NULL, 'Incline Bench Press'),
  (NULL, 'Barbell Curl'),
  (NULL, 'Tricep Extension'),
  (NULL, 'Lateral Raise'),
  (NULL, 'Face Pull'),
  (NULL, 'Leg Curl'),
  (NULL, 'Leg Extension'),
  (NULL, 'Calf Raise');

------------------------------------------------------------
-- EXTEND ACTIVATION / DEACTIVATION FOR COACHBYTE
------------------------------------------------------------

-- Replace activate_app to seed CoachByte user_settings on activation
CREATE OR REPLACE FUNCTION private.activate_app(
  p_user_id UUID,
  p_app_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO hub.app_activations (user_id, app_name)
  VALUES (p_user_id, p_app_name)
  ON CONFLICT (user_id, app_name) DO NOTHING;

  IF p_app_name = 'coachbyte' THEN
    INSERT INTO coachbyte.user_settings (user_id)
    VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
END;
$$;

-- Replace deactivate_app to cascade-delete CoachByte data on deactivation
CREATE OR REPLACE FUNCTION private.deactivate_app(
  p_user_id UUID,
  p_app_name TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM hub.app_activations
  WHERE user_id = p_user_id AND app_name = p_app_name;

  IF p_app_name = 'coachbyte' THEN
    DELETE FROM coachbyte.timers WHERE user_id = p_user_id;
    DELETE FROM coachbyte.splits WHERE user_id = p_user_id;
    -- daily_plans CASCADE deletes planned_sets and completed_sets
    DELETE FROM coachbyte.daily_plans WHERE user_id = p_user_id;
    DELETE FROM coachbyte.user_settings WHERE user_id = p_user_id;
  END IF;
END;
$$;
