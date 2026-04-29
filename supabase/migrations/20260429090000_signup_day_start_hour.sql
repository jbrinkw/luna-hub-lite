-- R2 audit F7: signup banner promised a 6 AM day-start with no path
-- to override at signup. Update private.handle_new_user() to honor
-- raw_user_meta_data.day_start_hour when supplied, falling through to
-- the column DEFAULT (6) when null/invalid. Safe migration: existing
-- users untouched; only affects new signups submitting day_start_hour
-- in metadata.

CREATE OR REPLACE FUNCTION private.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  -- Cast via TEXT first because raw_user_meta_data->>'k' yields TEXT.
  -- A non-numeric value would raise — wrap in a TRY (NULL on failure)
  -- so a malformed client doesn't break account creation.
  meta_dsh TEXT := NEW.raw_user_meta_data->>'day_start_hour';
  parsed_dsh INTEGER;
BEGIN
  BEGIN
    parsed_dsh := meta_dsh::INTEGER;
  EXCEPTION WHEN OTHERS THEN
    parsed_dsh := NULL;
  END;

  -- Range guard mirrors the CHECK constraint on hub.profiles.
  IF parsed_dsh IS NOT NULL AND (parsed_dsh < 0 OR parsed_dsh > 23) THEN
    parsed_dsh := NULL;
  END IF;

  INSERT INTO hub.profiles (user_id, display_name, timezone, day_start_hour)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data->>'display_name',
    COALESCE(NEW.raw_user_meta_data->>'timezone', 'America/New_York'),
    -- Falling back to 6 mirrors the column DEFAULT. Explicit so the
    -- caller can read this and not have to chase the schema for the
    -- default value.
    COALESCE(parsed_dsh, 6)
  );
  RETURN NEW;
END;
$$;
