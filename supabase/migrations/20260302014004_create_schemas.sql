-- Create application schemas
CREATE SCHEMA IF NOT EXISTS hub;
CREATE SCHEMA IF NOT EXISTS coachbyte;
CREATE SCHEMA IF NOT EXISTS chefbyte;
CREATE SCHEMA IF NOT EXISTS private;

-- Expose schemas to PostgREST (except private)
GRANT USAGE ON SCHEMA hub TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA coachbyte TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA chefbyte TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO service_role;

-- Hub profiles table
CREATE TABLE hub.profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  day_start_hour INTEGER NOT NULL DEFAULT 6 CHECK (day_start_hour BETWEEN 0 AND 23),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE hub.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
  ON hub.profiles FOR SELECT TO authenticated
  USING ((select auth.uid()) = user_id);

CREATE POLICY "Users can update own profile"
  ON hub.profiles FOR UPDATE TO authenticated
  USING ((select auth.uid()) = user_id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION private.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO hub.profiles (user_id, timezone)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'timezone', 'America/New_York')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION private.handle_new_user();

-- Logical date function
CREATE OR REPLACE FUNCTION private.get_logical_date(
  ts TIMESTAMPTZ,
  tz TEXT,
  day_start_hour INTEGER
) RETURNS DATE
LANGUAGE sql IMMUTABLE
AS $$
  SELECT (ts AT TIME ZONE tz - (day_start_hour || ' hours')::INTERVAL)::DATE;
$$;

-- Grant table permissions
GRANT ALL ON ALL TABLES IN SCHEMA hub TO authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA coachbyte TO authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA chefbyte TO authenticated, service_role;

-- Default grants for future tables in these schemas
ALTER DEFAULT PRIVILEGES IN SCHEMA hub GRANT ALL ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA coachbyte GRANT ALL ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA chefbyte GRANT ALL ON TABLES TO authenticated, service_role;
