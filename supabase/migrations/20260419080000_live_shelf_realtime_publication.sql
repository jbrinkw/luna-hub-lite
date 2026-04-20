-- Add chefbyte.live_shelf_devices to the supabase_realtime publication so
-- browser postgres_changes subscriptions deliver heartbeat updates to the
-- Scales tab in real time.
--
-- Without this, subscribing to `chefbyte.live_shelf_devices` returns
-- `status: error` from Supabase Realtime. Before the channel-per-table
-- fix in useRealtimeInvalidation (commit b9a1712) this failure was
-- silently poisoning the inventory channel's stock_lots and products
-- subscriptions as well. Agent 2 scoped this follow-up to a migration;
-- this is that migration.
--
-- Idempotent: only adds the table if it's not already in the publication.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'live_shelf_devices'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE chefbyte.live_shelf_devices';
  END IF;
END $$;

-- Also add scale_pairings while we're here — the Scales tab expands device
-- cards to show live scale status, and the product-pairing dropdown writes
-- to this table. Any cross-tab/cross-session update should reflect live.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'scale_pairings'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE chefbyte.scale_pairings';
  END IF;
END $$;
