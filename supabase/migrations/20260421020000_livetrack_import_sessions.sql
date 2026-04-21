-- LiveTrack Import Sessions — cloud-driven barcode-scan → scale-reading wizard.
--
-- One row per active "import in progress" for a Pi device. The row IS the
-- protocol: browser writes UI-initiated state changes (state flips, barcode
-- chosen, close/re-arm); Pi POSTs via the livetrack-session edge function
-- (x-api-key auth) to write scale readings + AI-tare results. Both sides
-- see each other's updates via Supabase Realtime on the session_id.
--
-- See docs/superpowers/plans/2026-04-21-livetrack-import-wizard.md §6.

------------------------------------------------------------
-- 1. Table
------------------------------------------------------------

CREATE TABLE IF NOT EXISTS chefbyte.livetrack_import_sessions (
  session_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id              UUID NOT NULL REFERENCES chefbyte.live_shelf_devices(device_id) ON DELETE CASCADE,
  state                  TEXT NOT NULL CHECK (state IN (
                           'waiting_barcode','waiting_scale','scale_reading_received',
                           'awaiting_ai_tare','ai_tare_ready','closed','expired')),
  current_barcode        TEXT,
  current_product_id     UUID REFERENCES chefbyte.products(product_id) ON DELETE SET NULL,
  scale_reading_g        NUMERIC(10,3),
  scale_reading_ts       TIMESTAMPTZ,
  ai_tare_product_form   JSONB,
  ai_tare_g              NUMERIC(10,3),
  ai_tare_confidence     TEXT CHECK (ai_tare_confidence IN ('low','medium','high') OR ai_tare_confidence IS NULL),
  ai_tare_reasoning      TEXT,
  last_error             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '10 minutes')
);

------------------------------------------------------------
-- 2. Indexes
------------------------------------------------------------

-- Partial index scoped to live sessions — Pi's "active session for my device"
-- lookup becomes an index-only scan on hot rows, and the index stays tiny as
-- closed/expired rows pile up.
CREATE INDEX IF NOT EXISTS lti_active_idx
  ON chefbyte.livetrack_import_sessions (device_id, state)
  WHERE state NOT IN ('closed','expired');

CREATE INDEX IF NOT EXISTS lti_user_idx
  ON chefbyte.livetrack_import_sessions (user_id);

------------------------------------------------------------
-- 3. RLS — user reads/writes their own rows via JWT; service_role bypasses.
------------------------------------------------------------

ALTER TABLE chefbyte.livetrack_import_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lti_user_rls ON chefbyte.livetrack_import_sessions;
CREATE POLICY lti_user_rls ON chefbyte.livetrack_import_sessions
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON chefbyte.livetrack_import_sessions TO service_role;

------------------------------------------------------------
-- 4. Realtime publication
------------------------------------------------------------
-- Browser subscribes postgres_changes filtered by session_id. Without this
-- the subscription returns `status: error` from Supabase Realtime.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'livetrack_import_sessions'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE chefbyte.livetrack_import_sessions';
  END IF;
END $$;
