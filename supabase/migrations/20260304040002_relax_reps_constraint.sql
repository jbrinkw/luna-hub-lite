-- Allow 0 reps for failed/skipped sets
ALTER TABLE coachbyte.completed_sets
  DROP CONSTRAINT IF EXISTS completed_sets_reps_positive;

ALTER TABLE coachbyte.completed_sets
  ADD CONSTRAINT completed_sets_reps_nonnegative CHECK (actual_reps >= 0);
