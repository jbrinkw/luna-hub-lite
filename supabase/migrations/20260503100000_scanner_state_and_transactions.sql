-- Pi USB scanner forwarder (2026-05-03):
-- scanner_state holds per-user active + locked mode so the Pi can
-- resolve which mode to apply on each USB scan even when the web
-- Scanner page is closed.
-- scan_transactions is the persistent audit log of every scan
-- (web + Pi). The Settings -> Scanner Transactions tab queries this.

CREATE TABLE chefbyte.scanner_state (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_active_mode TEXT NOT NULL DEFAULT 'purchase'
    CHECK (last_active_mode IN (
      'purchase', 'consume_macros', 'consume_no_macros', 'shopping'
    )),
  locked_mode TEXT NULL
    CHECK (locked_mode IN (
      'purchase', 'consume_macros', 'consume_no_macros', 'shopping'
    )),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE chefbyte.scanner_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY scanner_state_self ON chefbyte.scanner_state
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON chefbyte.scanner_state TO authenticated;

CREATE TABLE chefbyte.scan_transactions (
  transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL,
  product_id UUID NULL REFERENCES chefbyte.products(product_id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN (
    'purchase', 'consume_macros', 'consume_no_macros', 'shopping'
  )),
  qty NUMERIC(10,3) NULL,
  unit TEXT NULL CHECK (unit IS NULL OR unit IN ('container', 'serving')),
  nutrition_snapshot JSONB NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'applied', 'voided', 'errored'
  )),
  error_msg TEXT NULL,
  logical_date DATE NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'pi_usb')),
  pi_event_id TEXT NULL,
  applied_lot_id UUID NULL REFERENCES chefbyte.stock_lots(lot_id) ON DELETE SET NULL,
  applied_food_log_id UUID NULL REFERENCES chefbyte.food_logs(log_id) ON DELETE SET NULL,
  applied_cart_item_id UUID NULL REFERENCES chefbyte.shopping_list(cart_item_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ NULL
);

CREATE INDEX scan_transactions_by_logical_date
  ON chefbyte.scan_transactions (user_id, logical_date DESC);
CREATE INDEX scan_transactions_by_status
  ON chefbyte.scan_transactions (user_id, status, created_at DESC);
CREATE UNIQUE INDEX scan_transactions_pi_event_id_unique
  ON chefbyte.scan_transactions (user_id, pi_event_id)
  WHERE pi_event_id IS NOT NULL;

ALTER TABLE chefbyte.scan_transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY scan_transactions_self ON chefbyte.scan_transactions
  FOR ALL TO authenticated
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON chefbyte.scan_transactions TO authenticated;

COMMENT ON TABLE chefbyte.scanner_state IS
  'Per-user active scanner mode. Pi resolves locked_mode || last_active_mode on each USB scan.';
COMMENT ON TABLE chefbyte.scan_transactions IS
  'Persistent audit log of every scan (web + Pi USB). Settings tab surfaces this; void mutation reverses applied_* side-effects.';

-- Realtime publication membership.
-- scanner_state: ScannerPage and Pi USB forwarder need cross-tab/device
--   visibility into mode changes (locked_mode toggles + last_active_mode
--   broadcast). The Settings → Scanner tab live-syncs the lock state.
-- scan_transactions: Settings → Scanner Transactions tab subscribes to
--   INSERT events so newly-applied Pi USB scans appear without a manual
--   refresh (mirrors the food_logs realtime pattern from 2026-04-27).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'scanner_state'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE chefbyte.scanner_state';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'chefbyte'
       AND tablename = 'scan_transactions'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE chefbyte.scan_transactions';
  END IF;
END $$;
