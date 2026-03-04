-- Add pr_tracked_exercise_ids column to coachbyte.user_settings
-- Stores the list of exercise UUIDs the user wants to track on the PRs page.
-- NULL means "track all exercises" (default behavior).
ALTER TABLE coachbyte.user_settings
  ADD COLUMN pr_tracked_exercise_ids JSONB DEFAULT NULL;

COMMENT ON COLUMN coachbyte.user_settings.pr_tracked_exercise_ids IS
  'Array of exercise_id UUIDs to show on PRs page. NULL = show all.';
