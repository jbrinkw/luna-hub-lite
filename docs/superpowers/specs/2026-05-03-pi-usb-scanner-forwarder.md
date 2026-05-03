# Pi USB Scanner Forwarder + Persistent Scanner Transactions — Design

**Date:** 2026-05-03
**Status:** Draft (autonomous-build mode — user pre-authorized)

## Goal

Plug a USB barcode scanner into the live-shelf Pi. Each scan forwards the barcode to a cloud edge function, which processes it under the user's currently-active scanner mode (purchase / consume_macros / consume_no_macros / shopping). Two new UX affordances accompany this:

1. **"Lock scanner mode" setting** — when toggled, scanner stays in one mode permanently regardless of what the web Scanner page currently shows.
2. **"Scanner transactions" Settings tab** — view/edit/delete past scans (web + Pi-USB) from a persistent log, mirroring the in-page queue UX.

## Architecture

The pipeline:

```
USB HID scanner (Pi) ──► barcode_listener.py ──► CloudClient.post_barcode_scan()
                                                       │
                                                       ▼
                            POST /shelf-ingest/barcode-scan (x-api-key, body={barcode})
                                                       │
                                                       ▼
                            Resolve user → resolve mode → lookup product → execute action → log transaction
                                                       │
                                                       ▼
                            INSERT chefbyte.scan_transactions (status, applied_lot_id|food_log_id|cart_item_id)
```

Web Scanner page continues its existing client-side fast-path for instant feedback, but ALSO:

- Writes its current mode to `chefbyte.scanner_state.last_active_mode` whenever the user switches mode.
- Logs each completed scan to `chefbyte.scan_transactions` (mirrors what Pi writes).

Settings Scanner Transactions tab queries `scan_transactions` (filterable by date, status, source). Edit/delete actions mutate via mutations that ALSO reverse stock_lot/food_log/cart_item side-effects (same logic the current in-page queue's "undo" button uses).

## Components

### 1. New DB tables

**`chefbyte.scanner_state`** — one row per user, tracks active and locked mode:

```sql
CREATE TABLE chefbyte.scanner_state (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  last_active_mode TEXT NOT NULL DEFAULT 'purchase'
    CHECK (last_active_mode IN ('purchase', 'consume_macros', 'consume_no_macros', 'shopping')),
  locked_mode TEXT NULL
    CHECK (locked_mode IN ('purchase', 'consume_macros', 'consume_no_macros', 'shopping')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE chefbyte.scanner_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY scanner_state_self ON chefbyte.scanner_state
  FOR ALL TO authenticated USING ((select auth.uid()) = user_id);
```

`locked_mode` precedes `last_active_mode` when both are set. `last_active_mode` is a hint for the Pi when not locked.

**`chefbyte.scan_transactions`** — persistent log of every scan (web + Pi):

```sql
CREATE TABLE chefbyte.scan_transactions (
  transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  barcode TEXT NOT NULL,
  product_id UUID NULL REFERENCES chefbyte.products(product_id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (mode IN ('purchase', 'consume_macros', 'consume_no_macros', 'shopping')),
  qty NUMERIC(10,3) NULL,
  unit TEXT NULL CHECK (unit IS NULL OR unit IN ('container', 'serving')),
  nutrition_snapshot JSONB NULL, -- {servings_per_container, calories_per_serving, ...}
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'voided', 'errored')),
  error_msg TEXT NULL,
  logical_date DATE NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('web', 'pi_usb')),
  pi_event_id TEXT NULL, -- idempotency key for Pi scans
  applied_lot_id UUID NULL REFERENCES chefbyte.stock_lots(lot_id) ON DELETE SET NULL,
  applied_food_log_id UUID NULL REFERENCES chefbyte.food_logs(food_log_id) ON DELETE SET NULL,
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
  FOR ALL TO authenticated USING ((select auth.uid()) = user_id);
```

The `applied_*` FKs let the void-transaction mutation reverse the side-effect deterministically. The unique index on `pi_event_id` makes Pi retries idempotent.

### 2. New cloud edge function route

**`POST /shelf-ingest/barcode-scan`** in `supabase/functions/shelf-ingest/index.ts`:

- **Auth:** `x-api-key` (Pi) — same SHA-256 lookup as the existing scale-event routes via `chefbyte.live_shelf_devices`. Reuse the existing device table; the same Pi serves both scales and the USB scanner.
- **Body:** `{ barcode: string, pi_event_id: string, mode?: string, qty?: number, unit?: 'container'|'serving' }`. Pi only sends `barcode + pi_event_id`. Web sends all fields.
- **Resolution:**
  1. Resolve `user_id` from `x-api-key` SHA-256 → `live_shelf_devices`.
  2. Resolve mode: `body.mode` if present, else `scanner_state.locked_mode` if set, else `scanner_state.last_active_mode`.
  3. Lookup product by barcode (RLS-scoped to user).
  4. If product unknown: call `analyze-product` edge function internally (existing logic).
  5. Execute mode action via a new SECURITY DEFINER function `private.execute_scan_action` that wraps the existing add_stock / consume / etc. logic.
  6. INSERT row into `scan_transactions` with status, applied\_\*, etc.
  7. Return `{ transaction_id, product_id, status, applied_*, error_msg? }`.

Failure modes log status='errored' with error_msg and return 200 (Pi treats fire-and-forget; web surfaces the error_msg on the queue row).

**`POST /shelf-ingest/scanner-state`** — web pushes mode changes:

- **Auth:** JWT (browser).
- **Body:** `{ last_active_mode?: string, locked_mode?: string | null }`.
- **Effect:** UPSERT into `scanner_state`. Sets only the fields provided (PATCH semantics).
- Used both for "user switched mode" (last_active_mode) and "user toggled lock" (locked_mode).

**`POST /shelf-ingest/scan-transaction/{id}/void`** — manual void from the Settings tab:

- **Auth:** JWT.
- **Effect:** call `private.void_scan_transaction(transaction_id)` which:
  - Reads applied_lot_id / applied_food_log_id / applied_cart_item_id.
  - Reverses each effect (DELETE the lot, DELETE the food_log, etc.).
  - Sets transaction status='voided', applied*at=null (preserves applied*\* for audit).

### 3. Pi-side USB scanner module

New module: `hardware/live-shelf/server/barcode/`

**Files:**

- `__init__.py`
- `hid_listener.py` — opens the USB scanner via `evdev`, accumulates keystrokes until ENTER, emits a barcode string.
- `scanner_loop.py` — main loop: receives barcodes from `hid_listener`, calls `cloud_client.post_barcode_scan(barcode, pi_event_id)`, logs result.
- `tests/` — unit tests with a fake evdev source.

**Integration with existing Pi:**

- `app.py` (or equivalent entrypoint) starts the scanner loop as a background thread alongside the existing scale event handler.
- Reuses `cloud/client.py` for HTTP. Add a new method `CloudClient.post_barcode_scan(barcode, pi_event_id)` that POSTs `/shelf-ingest/barcode-scan`.
- `pi_event_id` is generated as `f"barcode-{uuid4()}"` per scan for idempotency.

**Configuration:**

- Env var `BARCODE_SCANNER_DEVICE` — path to the evdev device (e.g. `/dev/input/event2`). Optional; if unset, the listener auto-detects the first input device with `BARCODE_SCANNER_VENDOR_ID` matching.
- Env var `BARCODE_SCANNER_ENABLED=true` — gate the loop. Default off so existing Pi setups are unaffected.

### 4. Web Scanner page changes

**File:** `apps/web/src/pages/chefbyte/ScannerPage.tsx`

Changes:

1. **Mode broadcast on change:** every `setMode(...)` call ALSO calls a debounced (500ms) `pushScannerMode(mode)` mutation that POSTs `/shelf-ingest/scanner-state`.
2. **Mode hydration on mount:** read `scanner_state.locked_mode` first (if set, lock the mode dropdown). Otherwise read `scanner_state.last_active_mode` for the initial mode.
3. **Transaction logging on each scan:** every successful or failed scan ALSO writes a row to `scan_transactions` (source='web') with the same shape the Pi writes. The in-component queue stays — the transaction is a parallel audit log.

### 5. Settings page changes

**File:** `apps/web/src/pages/chefbyte/SettingsPage.tsx`

(a) **New "Scanner" tab** (or extend an existing tab) with:

- Toggle: "Lock scanner to single mode"
- Mode dropdown (only visible when toggle is on)
- Save action UPSERTs into `scanner_state.locked_mode`.

(b) **New "Scanner transactions" tab** rendering a `ScannerTransactionsTab` component:

- Lists scan_transactions for the current user, filterable by date range + status + source.
- Each row shows: timestamp, source (web/pi_usb), barcode, product name, mode, qty, status, error_msg.
- Row actions: edit (qty/mode/notes), delete (calls void endpoint).
- Mirrors the in-page Scanner queue UX so muscle memory transfers.

### 6. Settings tab placement

New `Tab` type values: `'scanner'` and `'scanner-transactions'`. Inserted after `'scales'` in the tabs array.

## Data Flow

### Pi USB scan → cloud

```
1. User scans barcode on USB scanner connected to Pi.
2. evdev keystrokes accumulate; ENTER triggers emit.
3. scanner_loop.py: cloud_client.post_barcode_scan(barcode, pi_event_id=uuid4())
4. Pi → POST /shelf-ingest/barcode-scan with {barcode, pi_event_id}
5. Edge function:
   - SHA-256(api_key) → user_id via live_shelf_devices
   - mode = scanner_state.locked_mode ?? scanner_state.last_active_mode
   - product = SELECT FROM products WHERE barcode = ... AND user_id = ...
   - If unknown → analyze-product internally (3-5s; fine for fire-and-forget)
   - private.execute_scan_action(user_id, product_id, mode, ...)
   - INSERT scan_transactions
   - Return { transaction_id, applied_* }
6. Pi logs result. Failures retried with same pi_event_id (idempotent).
```

### Web mode change → Pi pickup

```
1. User toggles ScannerPage mode dropdown.
2. setMode(newMode); debounced fire-and-forget POST /shelf-ingest/scanner-state {last_active_mode: newMode}.
3. Cloud UPDATE scanner_state.last_active_mode.
4. Next Pi scan reads the updated mode (no polling — read on demand at scan time).
```

### Lock toggle → behavior change

```
1. User toggles "Lock to mode" in Settings. Selects 'consume_macros'.
2. POST /shelf-ingest/scanner-state {locked_mode: 'consume_macros'}.
3. Cloud UPDATE scanner_state.locked_mode = 'consume_macros'.
4. Pi scans always use 'consume_macros' until lock cleared.
5. Web Scanner page reads scanner_state.locked_mode on mount; disables the mode dropdown when locked.
```

### Void transaction

```
1. User clicks delete on a row in Settings → Scanner transactions.
2. Confirm dialog.
3. POST /shelf-ingest/scan-transaction/{id}/void.
4. private.void_scan_transaction reverses applied_* effect (DELETE lot / DELETE food_log / DELETE cart_item).
5. UPDATE scan_transactions SET status='voided'.
6. UI invalidates the query, row disappears.
```

## Error Handling

- **Pi can't reach cloud:** scanner_loop.py retries with same `pi_event_id` and exponential backoff. Cloud deduplicates via the unique index.
- **Cloud can't determine mode:** scanner_state row missing → use server-side default 'purchase' and log a warning.
- **Product lookup fails for Pi scan when analyze-product fails:** INSERT scan_transaction with status='errored' + error_msg='AI analysis failed'. User can retry from Settings tab (re-trigger by manually correcting the row).
- **execute_scan_action throws:** transaction rolled back; status='errored' logged separately for audit.
- **RLS / cross-user collision:** RLS prevents wrong-user writes; edge function returns 401 if api-key doesn't match a device.

## Testing Strategy

Per user's mandate ("E2E tests must hit real Pi → cloud → DB; no mocks"):

1. **Unit tests (Pi side):**
   - `hid_listener_test.py` — fake evdev source with keystroke sequences; verify barcode emission.
   - `scanner_loop_test.py` — mock CloudClient; verify retry semantics.
2. **Integration tests (cloud side):**
   - pgTAP for the new tables (existence, constraints, RLS).
   - `shelf-ingest.test.ts` Deno tests for the new routes (real DB, real api-key auth).
3. **Web tests:**
   - Vitest for the new mutations + Settings tabs.
4. **E2E:**
   - A new test in `apps/web/src/__tests__/integration/edge-functions/scanner-pipeline.test.ts` that exercises the full scan path end-to-end:
     - POST scanner-state → cloud row created.
     - POST barcode-scan with x-api-key → product looked up, action executed, transaction logged.
     - POST void → side-effect reversed, transaction marked voided.
   - This is a real cloud-call test, not a mock. Requires Supabase local dev running (matches the existing shelf-ingest.test.ts pattern).

## Migration Order

1. New `chefbyte.scanner_state` + `chefbyte.scan_transactions` tables (one migration).
2. New `private.execute_scan_action` and `private.void_scan_transaction` SECURITY DEFINER functions.
3. Extend `shelf-ingest/index.ts` with the three new routes.
4. Pi-side `barcode/` module + integration into app.py.
5. Web Scanner mode broadcast + transaction logging.
6. Settings tab + scanner-state UI.
7. Docs.

## YAGNI Excluded

- **Multiple scanners per user** — the user has one Pi; one device row is enough. The schema supports more naturally; UI doesn't.
- **Mode-aware barcode shortcuts** — e.g., scan a special "switch to consume mode" barcode. Out of scope.
- **Scheduled mode locking** — e.g., auto-lock to consume_macros at meal times. Out of scope.
- **Edit-transaction (vs delete)** — the user asked for view/edit/delete. Delete (void) reverses effects deterministically. Editing is more error-prone (e.g., changing mode would require reversing the old effect AND applying the new one). Implement view + delete first; defer edit unless explicitly requested.

## Open Decisions Captured

- **Edge function performs analyze-product internally for unknown Pi scans** rather than leaving them as 'pending' for async processing. Trade-off: scan response is slow (3-5s) but the Pi is fire-and-forget anyway and the simplification is large.
- **Web continues its client-side fast path** rather than routing through the edge function. Trade-off: web has lower latency (~50ms), but two code paths exist (web + Pi). Mitigated by both writing identical scan_transactions rows.
- **`locked_mode` is per-user, not per-device** — the user has one Pi, one web tab open most of the time; per-user is the right scope.
- **`scanner_state.last_active_mode` writes are debounced 500ms on web** — avoids hammering the cloud during keypad mashing.
