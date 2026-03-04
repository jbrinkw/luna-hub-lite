-- Add notes column to daily_plans for workout notes
ALTER TABLE coachbyte.daily_plans ADD COLUMN IF NOT EXISTS notes TEXT;
