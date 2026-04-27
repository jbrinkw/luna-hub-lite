# Pi ↔ Cloud Integration Audit — 2026-04-21

Scope: `hardware/live-shelf/server/**` ↔ `supabase/functions/shelf-ingest` + `supabase/functions/livetrack-session`, plus the `apps/web` surfaces that render cloud state. Read-only. Live state confirmed via Supabase REST at `btlfsxammjzkyluophgr` and SSH to the Pi at `192.168.0.181`.

## 1. Summary

Pi → cloud is LIVE and healthy for `live_shelf` + `catch_all` scales: outbox, heartbeat, intake write-through, and LiveTrack-session fan-in all run on the real Pi (`healthz: cloud_worker_alive=true, outbox_pending=0, permanent_failures=0`). Cloud → Pi is asymmetric: `GET /catalog` is callable, but the **only** consumer on the Pi is startup-time `sync_products_from_cloud` (`hardware/live-shelf/server/app.py:683`) plus a classifier cache that nobody uses in the running config — there is **no periodic catalog poll**. The live_scale / single-item rig is **BROKEN end-to-end on the Pi** (shelf-registry literal mismatch vs. storage CHECK + handler has no single-item dispatch), even though the cloud pairing UX + `scale_pairings` rows are already in production. LiquidTrack is functionally greenfield to retire (0 device rows) but still has live UI in `SettingsPage` + `MacroPage` reading `liquidtrack_events`. For the cloud event viewer, the backing data already exists (`chefbyte.scale_events` via `shelf_event_log` + `food_logs`) but will need a new `event_overrides` table and an RPC to retroactively apply edits while preserving `logical_date`.

## 2. A. Pi → cloud code paths

File:line citations anchor to the live code. All below are wired into the live daemon (`hardware/live-shelf/server/app.py`) unless noted.

| Path                                                  | Status  | Wired?                                                                                                                                                                                    | Trigger / cadence                                                                                                                            | Failure mode                                                                                                                            |
| ----------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud/client.py CloudClient.post("/event")`          | LIVE    | `app.py:1532` → `CloudWorker`                                                                                                                                                             | Once per outbox drain tick (5s base, exp backoff on failure to 5m cap)                                                                       | `CloudError` → worker bumps `attempts`, keeps row `pending`. 400/404/409 → `mark_permanent_failure`; 401/403/422 retryable              |
| `client.post("/heartbeat")`                           | LIVE    | `app.py:1532` → `CloudWorker.tick()`                                                                                                                                                      | Same 5s base cadence                                                                                                                         | 401/403 logged ERROR ("check CLOUD_IMPORT_KEY"), otherwise WARNING. Heartbeat fail short-circuits drain for that tick (`worker.py:241`) |
| `client.post("/intake")`                              | LIVE    | `intake/routes.py:429` (`_post_intake_to_cloud`)                                                                                                                                          | On `POST /api/intake/save` from Pi wizard                                                                                                    | Log + swallow; Pi local row is authoritative                                                                                            |
| `client.post("/product-tare")`                        | LIVE    | `handlers/scale_events.py:412` (`_push_tare_to_cloud`)                                                                                                                                    | Catch-all tare capture fires                                                                                                                 | Fire-and-forget; WARN on failure                                                                                                        |
| `client.get("/catalog")`                              | PARTIAL | `intake/cloud_sync.py:330` (startup only) + `classifier/cloud_candidate_source.py:140` (unused)                                                                                           | **Startup once** from `app.py:683`. Classifier path uses `RepoCandidateSource` (app.py:699), not cloud, so catalog never refreshes post-boot | CloudError swallowed at startup; classifier-path fallback has 5 min TTL but isn't live                                                  |
| `client.get_active_livetrack_session()`               | LIVE    | `cloud/livetrack_poller.py` thread                                                                                                                                                        | 500 ms active / 2 s idle / exp backoff to 30 s                                                                                               | CloudError → log WARN + backoff, keep trying                                                                                            |
| `client.post_livetrack_session_update()`              | LIVE    | `handlers/scale_events.py:1645` (scale-event intercept) + `cloud/livetrack_poller.py:_post_update_safely` (AI-tare result)                                                                | Per scale reading while `state=waiting_scale`; per AI-tare completion                                                                        | Swallow + log; no retry                                                                                                                 |
| `cloud/outbox.py enqueue_event`                       | LIVE    | Callers: `adapters/reconciler_repo.py:351`, `handlers/scale_events.py:963/1066/1077/2639`                                                                                                 | On reconciler/in-flight/TTL-reap commit while holding `db_lock`                                                                              | Best-effort; `emitter._enqueue` swallows all exceptions                                                                                 |
| `cloud/integration.py emit_reconciler_resolution`     | LIVE    | `reconciler_repo.py:351`                                                                                                                                                                  | Every reconciler resolution with an applicable pattern                                                                                       | Pre-NTP (`year<2024`) `occurred_at` dropped with WARN                                                                                   |
| `cloud/integration.py emit_in_flight_reap`            | LIVE    | `scale_events.py:963/2639` (TTL reaper)                                                                                                                                                   | In-flight lot TTL-expires                                                                                                                    | Same                                                                                                                                    |
| `cloud/integration.py emit_single_item_event`         | DEAD    | Never called from handler. `scale_events.py:459` wraps it but `handle_scale_event` (1566) never dispatches; docstring at :452 says "single-item hardware isn't implemented on the Pi yet" | Never                                                                                                                                        | n/a                                                                                                                                     |
| `cloud/integration.py backfill_missing_outbox_events` | LIVE    | `app.py:1516` at startup                                                                                                                                                                  | Once at boot when `cloud_enabled`                                                                                                            | Window = `CLOUD_BACKFILL_WINDOW_HOURS` (default 168h)                                                                                   |
| `intake/cloud_sync.py upsert_product_from_cloud`      | LIVE    | `intake/routes.py:137` (single-product, after `POST /intake`) and inside `sync_products_from_cloud`                                                                                       | Per intake save + once at startup                                                                                                            | Bad payload skipped with WARN                                                                                                           |
| `intake/cloud_sync.py sync_products_from_cloud`       | PARTIAL | `app.py:683` — startup-only pull                                                                                                                                                          | Once at boot                                                                                                                                 | Raises → logged + continue; **no periodic poll → stale catalog**                                                                        |

## 3. B. Cloud → Pi code paths

| Route                                | Who calls it                                                                | Does what                                                                                                                                                                                                             | Status                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /shelf-ingest/catalog`          | Pi `cloud/catalog.py:fetch_catalog` (startup sync + unused classifier path) | Returns products + stock_lots(qty>0) + scale_pairings + locations for the authed user (`functions/shelf-ingest/index.ts:93-130`)                                                                                      | LIVE but under-used — Pi polls only at boot                               |
| `POST /shelf-ingest/event`           | `CloudWorker` drainer                                                       | `private.apply_shelf_event` replays idempotently: writes `shelf_event_log`, updates `stock_lots.qty_containers`, and inserts `food_logs` on `consumed` (migration `20260419060000_shelf_ingest_hardening_v2.sql:200`) | LIVE                                                                      |
| `POST /shelf-ingest/intake`          | Pi `intake/routes.py:429`                                                   | Upsert product on `(user_id, barcode)`; update existing or insert new (`index.ts:282-353`)                                                                                                                            | LIVE                                                                      |
| `POST /shelf-ingest/heartbeat`       | `CloudWorker`                                                               | Updates `live_shelf_devices.{last_heartbeat_ts,pending_review_count,outbox_pending_count,outbox_permanent_failures}` and bulk-UPSERTs `scale_pairings` via `heartbeat_upsert_pairings_admin` RPC (`index.ts:399-479`) | LIVE                                                                      |
| `POST /shelf-ingest/product-tare`    | Pi tare-capture fire-and-forget                                             | Narrow `UPDATE products.tare_weight_g` for authed user (`index.ts:365-397`)                                                                                                                                           | LIVE                                                                      |
| `POST /livetrack-session/create`     | Browser SPA (`/chef/livetrack-import`) — user JWT                           | Picks most-recent-heartbeated device (60s freshness), expires prior live rows, inserts fresh `waiting_barcode` row (`functions/livetrack-session/index.ts:91-174`)                                                    | LIVE                                                                      |
| `POST /livetrack-session/pi-update`  | Pi poller + scale-event intercept                                           | Narrow allow-list UPDATE: `scale_reading_g`, `ai_tare_g`, `state`, `last_error`, etc. Enforces `device_id` match + state lifecycle (`index.ts:194-267`)                                                               | LIVE                                                                      |
| `GET /livetrack-session/active`      | Pi `livetrack_poller._run`                                                  | Returns newest non-terminal session for the authed device or `{session: null}` (`index.ts:276-295`)                                                                                                                   | LIVE                                                                      |
| `POST /functions/v1/analyze-product` | Browser only (SettingsPage barcode flow)                                    | OFF + Claude Haiku 4.5                                                                                                                                                                                                | LIVE — Pi does NOT call this (Pi runs its own AI via `intake/ai_tare.py`) |
| `POST /functions/v1/liquidtrack`     | Dead — no device rows in prod (0/0 `liquidtrack_devices`)                   | Legacy IoT ingest                                                                                                                                                                                                     | DEAD                                                                      |

## 4. C. Event emission map

| Pi trigger                                       | Cloud sink                                                                                                                                                           | Current status                                                      | User-visible where                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `scale_events` INSERT (live_shelf, catch_all)    | Never emitted directly. Classifier → reconciler runs → `session_resolutions` row → `emit_reconciler_resolution`                                                      | LIVE for consumed/refilled/added/depleted; other patterns are no-op | Cloud inventory (`chefbyte.stock_lots`) + macro totals (`food_logs`) |
| `scale_events` INSERT (live_scale / single-item) | Never (see §G) — handler never runs `emit_single_item_event`                                                                                                         | BROKEN                                                              | —                                                                    |
| Session close                                    | Drives reconciler, which emits 0..N resolution events. No "session closed" event itself.                                                                             | LIVE via reconciler path                                            | —                                                                    |
| Classifier completion                            | No direct cloud emit; reconciler consumes the classifier result and emits the resolution                                                                             | LIVE                                                                | —                                                                    |
| Intake commit (`POST /api/intake/save`)          | `cloud.post("/intake")` + local write-through (`intake/routes.py:429`)                                                                                               | LIVE                                                                | ChefByte products list + cloud catalog                               |
| Heartbeat (every 5s)                             | `POST /heartbeat` → `live_shelf_devices` + bulk UPSERT `scale_pairings`                                                                                              | LIVE                                                                | Hub Scales tab + LiveTrack-Import device freshness gate              |
| Catch-all tare capture                           | `emit_reconciler_resolution` path does NOT fire (tare short-circuits). `POST /product-tare` is the separate channel                                                  | LIVE                                                                | Products row tare update                                             |
| Single-item scale consumption                    | **`emit_single_item_event` is defined but not wired**; also `shelf_id="live_scale"` would fail storage schema CHECK (`storage/schema.sql:111`) before emit even runs | BROKEN (see §G)                                                     | —                                                                    |
| TTL in-flight reap                               | `emit_in_flight_reap` (`scale_events.py:963/2639`)                                                                                                                   | LIVE                                                                | Cloud stock + macros                                                 |

## 5. D. Bidirectional sync state

| Entity                                                                          | Pi → cloud                                                                                                          | Cloud → Pi                                                                        | Latency / trigger                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------- |
| `products` (incl. macros, tare, net)                                            | On intake save: `POST /intake` write-through. On catch-all tare: `POST /product-tare`.                              | **Startup only** via `sync_products_from_cloud` (`app.py:683`). No periodic poll. | Cloud→Pi = boot; Pi→cloud = immediate |
| `stock_lots`                                                                    | Via reconciler resolutions → `POST /event` → `private.apply_shelf_event` updates `qty_containers`                   | None. Pi has its own `lots` table; cloud is derived, not replicated back          | Pi→cloud ~5s                          |
| `locations`                                                                     | Included in `GET /catalog` response but Pi doesn't write locations back                                             | Startup only (same catalog path)                                                  | Cloud→Pi = boot only                  |
| `food_logs` / macros                                                            | Indirect — `apply_shelf_event` inserts a `food_logs` row on every `consumed` event (migration `20260419060000:200`) | None                                                                              | ~5s                                   |
| `live_shelf_devices` (heartbeat, pending_review_count, outbox counters, lan_ip) | `POST /heartbeat` every 5s + `last_heartbeat_ts`, all 4 outbox counters                                             | None                                                                              | 5s                                    |
| `scale_pairings`                                                                | Heartbeat UPSERT (device_id + scale_id + kind; product_id preserved)                                                | `GET /catalog` pulls pairings but Pi doesn't act on them (no dispatch)            | Pi→cloud 5s; Cloud→Pi = boot          |
| `livetrack_import_sessions`                                                     | Pi writes `scale_reading_g`, `ai_tare_*`, `state`, `last_error` via `/pi-update`                                    | Pi polls `/active` at 500ms/2s                                                    | Sub-second                            |
| `review_queue` (Pi-local)                                                       | Counted in heartbeat only; rows stay local                                                                          | None                                                                              | —                                     |

**Gap confirmed**: a product created via cloud wizard (`/chef/livetrack-import` or direct edits) does **not** propagate to the Pi until the next restart. Root cause: `app.py:683` is the only call site for `sync_products_from_cloud`, and `RepoCandidateSource` (the production classifier candidate source at `app.py:699`) reads only from local `products`. `CloudCandidateSource` with its 5-minute TTL-refresh exists but is not instantiated in the live daemon.

Live prod state (Supabase REST, 2026-04-21):

- `live_shelf_devices`: 3 rows; only `a6def4d3-...` has a fresh heartbeat (`2026-04-21T19:23Z`), `lan_ip=192.168.0.181`, `pending_review_count=3`. Others are stale (2026-04-20).
- `scale_pairings`: 6 rows. 3 `live_scale` (including `scale-ls-A` → product `b6cdc006-...` and `scale-03` → product `063ea35d-...`). 2 `catch_all`. 1 `live_shelf`.
- `livetrack_import_sessions`: 8 rows total. Last 10 either `closed` or `expired` — wizard works end-to-end.
- `liquidtrack_devices`: **0 rows**. `liquidtrack_readings`: 404 (table dropped at some point; the one remaining is `liquidtrack_events` which `MacroPage.tsx:116` still queries).

## 6. E. Pi web UI replacement map

All routes live under `http://192.168.0.181:8000/` (Flask dev server on the Pi). Templates: `hardware/live-shelf/server/web/templates/`.

| Pi route                                        | Template                                  | Disposition                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`                                         | `dashboard.html`                          | Operator-only (live camera + recent events + in-flight lots). Keep as fallback forever — useful during hardware troubleshooting |
| `GET /inventory`                                | `inventory.html`                          | Replaced by cloud Inventory + Settings→Scales. Retire after event viewer.                                                       |
| `GET /registry`                                 | redirect                                  | Retire with `/inventory`                                                                                                        |
| `GET /events`                                   | `events.html`                             | **To be replaced by the cloud event viewer (target of this next build)**                                                        |
| `GET /event/<id>`                               | `event_detail.html`                       | Same — needs cloud replacement                                                                                                  |
| `GET /event/<id>/<file>`                        | (image serve)                             | **Keep** — browser hits Pi directly for images per decision #6                                                                  |
| `GET /refs/<product_id>/<file>`                 | (image serve)                             | Keep for operator debug; cloud can copy-on-demand later                                                                         |
| `GET /sessions` / `/session/<id>`               | `sessions.html` / `session_detail.html`   | Operator-only — not surfacing sessions in cloud (classifier events only)                                                        |
| `GET /review` / `/review/<id>`                  | `review_list.html` / `review_detail.html` | Folded into cloud event viewer (low-confidence events are editable events with candidates)                                      |
| `GET /intake`                                   | `intake.html`                             | **Already replaced** by `/chef/livetrack-import`. Operator fallback only (no wifi / no cloud).                                  |
| `POST /api/intake/*`                            | api_routes.py                             | Same                                                                                                                            |
| `GET /api/state` / `/api/events` / `/api/usage` | api_routes.py                             | Internal — keep for diagnostic/debug UI only                                                                                    |
| `POST /api/admin/wipe`                          | api_routes.py                             | Operator-only                                                                                                                   |
| `POST /api/config`                              | api_routes.py                             | Operator-only                                                                                                                   |
| `GET /api/debug/*`                              | debug_routes.py                           | Operator-only                                                                                                                   |

Counts: routes.py has ~20 HTML routes + image serve; api_routes.py has ~22 JSON endpoints; debug_routes.py has 6. After cloud event viewer lands, operator-only set shrinks to dashboard + debug/admin/config.

## 7. F. LiquidTrack retirement scope

| Surface                                                                 | File / path                                                       | Row count                                               | Action                                                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `chefbyte.liquidtrack_devices`                                          | migration `20260303040000_chefbyte_tables.sql`                    | 0                                                       | Drop (greenfield)                                                                                                   |
| `chefbyte.liquidtrack_events`                                           | same                                                              | Referenced by `MacroPage.tsx:116` and integration tests | Drop after UI cutover                                                                                               |
| `chefbyte.liquidtrack_readings`                                         | -                                                                 | **Table already missing** (REST 404)                    | Confirm drop migration ran, clean up references                                                                     |
| `supabase/functions/liquidtrack`                                        | full edge fn                                                      | -                                                       | Remove + `[functions.liquidtrack]` block in `config.toml:372`                                                       |
| `apps/web/src/pages/chefbyte/SettingsPage.tsx`                          | `Tab='liquidtrack'`, `LiquidTrackDevice` interface, tab rendering | -                                                       | Delete tab + state + mutations; re-tab to `scales` + `locations` only                                               |
| `apps/web/src/pages/chefbyte/MacroPage.tsx:116, 184, 278, 573`          | Reads `liquidtrack_events` + filter branches                      | -                                                       | Replace data source with `food_logs` derived from shelf-ingest apply (already written there by `apply_shelf_event`) |
| `apps/web/src/shared/queryKeys.ts:33`                                   | `liquidtrackEvents` key                                           | -                                                       | Delete                                                                                                              |
| `apps/web/src/__tests__/integration/edge-functions/liquidtrack.test.ts` | integration test                                                  | -                                                       | Delete                                                                                                              |
| `apps/web/src/__tests__/integration/pages/chef-macros.test.ts`          | mentions LiquidTrack                                              | -                                                       | Update to assert food_logs-driven source                                                                            |
| `apps/web/src/__tests__/integration/pages/chef-settings.test.ts`        | asserts liquidtrack tab                                           | -                                                       | Update (tab removed)                                                                                                |

Migration path: because both `liquidtrack_devices` and `liquidtrack_readings` are empty/missing, there is **no data to migrate** to `live_shelf_devices` / `scale_pairings(kind='live_scale')`. Retirement is pure delete.

## 8. G. Single-item rig status

| Bullet                                                                           | Status                                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Cloud pairing UX (Settings → Scales) assigns a product to `live_scale` kind   | **LIVE**                              | `apps/web/src/components/chefbyte/ScalesTab.tsx:30` types `kind: 'live_shelf' \| 'live_scale' \| 'catch_all'`; `:791-803` renders product-picker gated on `s.kind === 'live_scale'`; prod has 3 `live_scale` rows with `product_id` non-null in `scale_pairings`                                                                                                                                                                                                                                                                                                |
| 2. Pi firmware emits scale events for `scale-03`; Pi handler routes `live_scale` | **BROKEN**                            | `shelves.py:69` maps `scale-03` → `shelf_id="live_scale"`. Storage CHECK is `CHECK(shelf_id IN ('live_shelf','catch_all','single_item'))` (`storage/schema.sql:65,89,111,183`). `scale_events.py:1817` inserts via `ScaleEventIn(shelf_id=shelf_id)` → any real `scale-03` event would raise `IntegrityError` at the SQLite CHECK. Also `scale_events.py:436` maps `single_item` → `scale-single` (dead branch; registry never uses `single_item`). No live_scale events in the Pi DB (`scale_events` shelf distribution: `catch_all: 1`, `live_shelf: 3` only) |
| 3. Cloud classifier handling for single-item → `food_logs` with paired product   | **PARTIAL (cloud ready, Pi blocked)** | Cloud side fully ready: `shelf-ingest/index.ts:34` `VALID_KINDS` includes `'live_scale'`; `index.ts:207-224` resolves `product_id` via `scale_pairings` when omitted; `apply_shelf_event` inserts into `food_logs` on `consumed`. Gated only by (2) — the Pi never emits.                                                                                                                                                                                                                                                                                       |
| 4. Macro logging flow end-to-end                                                 | **BROKEN**                            | Same root cause as (2). Cloud UI reads `food_logs` but nothing is being written for `live_scale` because nothing reaches `POST /event`. Additionally `emit_single_item_event` (`scale_events.py:459`) is defined but never called from `handle_scale_event` — even if the schema CHECK were relaxed, there is no dispatch branch.                                                                                                                                                                                                                               |

Net: 1 LIVE, 2 BROKEN, 3 PARTIAL (cloud-ready but Pi-blocked), 4 BROKEN. The rig is closer to "wired on one end" than "built." Owner's assumption that it's working is refuted.

Minimum fixes to unblock single-item:

- Rename storage CHECK literal `'single_item'` → `'live_scale'` (or accept both during migration), including in `storage/schema.sql:65,89,111,183`, and fix `scale_events.py:436` `_scale_id_for_shelf`.
- Add a `live_scale` branch in `handle_scale_event` that short-circuits the classifier/session pipeline (no camera, no reconciler) and calls `emit_single_item_event` directly, resolving product_id via local `scale_pairings` cache.
- Add a migration to the Pi's sqlite schema since this is a CHECK-rewrite (SQLite: create new table + copy + drop + rename).

## 9. H. Cloud event viewer prereqs

### Required data (already populated by Pi → cloud pipeline)

- `chefbyte.shelf_event_log` — every Pi event that reached `POST /event` is here (see migration `20260419060000_shelf_ingest_hardening_v2.sql:85`). Contains `client_event_id` (Pi UUID), device/scale, kind, event_kind, product_id, delta_g, occurred_at, applied, reason, resolved_lot_id. This is the **spine of the classifier-events viewer**.
- `chefbyte.food_logs` — macro rows written when `event_kind='consumed'` (same migration, `:200`). Keyed to user + date.
- `chefbyte.stock_lots` — mutated by the same `apply_shelf_event`.

### Decision alignment

- "Classifier events" = `shelf_event_log` rows where `kind IN ('live_shelf','catch_all')` AND Pi's `classifier_status='ok'` (classifier succeeded + product_id present). Single-item events (`kind='live_scale'`) probably should also appear once §G is fixed.
- "Retroactive edit preserving `logical_date`" — `food_logs` already has `logical_date` (`chefbyte_tables.sql:195` index). Edits must NOT recompute `logical_date` from `now()` on update.
- "Soft delete" — needs a `voided_at` column on overrides OR on `shelf_event_log` + `food_logs`.

### New schema proposal

```sql
-- Applies corrections to cloud-visible state on top of immutable Pi-originated event rows.
-- One row per user edit; shelf_event_log stays the append-only audit trail.
CREATE TABLE chefbyte.event_overrides (
  override_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shelf_event_id       UUID NOT NULL REFERENCES chefbyte.shelf_event_log(event_id) ON DELETE CASCADE,

  -- Stock side (null = keep applied value).
  override_product_id  UUID REFERENCES chefbyte.products(product_id),
  override_delta_g     NUMERIC(10,3),  -- signed grams, negative = consumption
  override_servings    NUMERIC(10,3),  -- servings-primary UX; derives delta via product

  -- Macro side. Servings-primary; kcal/C/P/F start derived from product*servings
  -- but user can override any subset. Nulls mean "use derived".
  override_kcal        NUMERIC(10,3),
  override_carbs_g     NUMERIC(10,3),
  override_protein_g   NUMERIC(10,3),
  override_fat_g       NUMERIC(10,3),

  -- Soft delete. A voided override still displays in the viewer but backs
  -- out both stock + macros. Keeping the row (vs. DELETE) preserves the
  -- "event exists but was voided" trail the owner asked for.
  voided_at            TIMESTAMPTZ,
  void_reason          TEXT,

  -- Retroactive-edit preservation. If the underlying event was consumed at
  -- Tuesday 14:00 local, the macros stay anchored to Tuesday regardless of
  -- when the edit happens. Defaulted from shelf_event_log.occurred_at at
  -- insert time; NEVER recomputed.
  original_logical_date  DATE NOT NULL,

  note                 TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX event_overrides_one_per_event
  ON chefbyte.event_overrides (shelf_event_id)
  WHERE voided_at IS NULL;
ALTER TABLE chefbyte.event_overrides ENABLE ROW LEVEL SECURITY;
-- standard (select auth.uid()) = user_id policies here
```

### New RPC: `private.apply_event_override`

Input: `p_shelf_event_id UUID, p_override_product_id UUID NULL, p_override_servings NUMERIC NULL, p_override_kcal NUMERIC NULL, ... p_void BOOLEAN, p_void_reason TEXT NULL`.

Steps (transactional):

1. Load `shelf_event_log` row + its paired `food_logs` row (if `event_kind='consumed'`) + any existing `event_overrides` row.
2. Back out the previously-applied delta: reverse prior stock mutation (add magnitude back to `stock_lots.qty_containers`), delete or zero the prior `food_logs` row.
3. If `p_void=true`: set `voided_at=now()`, keep the override row, stop (stock stays reverted).
4. Else UPSERT the override. Re-apply stock against `stock_lots` using `override_product_id/delta_g/servings` (or original if null). INSERT a fresh `food_logs` row using `original_logical_date` from the override (never `now()::date`).
5. `last_update_source='user_edit'` on both tables.

### New edge function: `event-edit`

`POST /functions/v1/event-edit/apply` — browser (user JWT) → authenticate → call RPC. Narrow, JWT-auth, mirrors shape of livetrack-session/create.

### Pi-side changes required for the viewer

- `shelf_event_log` already keys on the Pi's `client_event_id` (`outbox.py:enqueue_event` injects UUID4) — no new ID needed. The event viewer URL should be keyed on the cloud event_id (UUID), and the Pi image path derives from `client_event_id` which maps to Pi's `scale_events.event_id` after a small join: the outbox payload already embeds it (see `integration.py:312`).
- Pi image endpoint is already LAN-reachable (`http://192.168.0.181:8000/event/<event_id>/before.jpg`). Cloud viewer needs `live_shelf_devices.lan_ip` (already populated: `192.168.0.181` today). No new API needed.
- **Missing**: the Pi does not send the `scale_events.event_id` (its local UUID) or `pi_received_ts` in the outbox payload, so the cloud only knows `client_event_id`. For stable image lookup the cloud viewer needs the Pi event_id that matches the on-disk `data/events/<event_id>/` path. Add a field `pi_event_id` to the event payload in `integration.py emit_reconciler_resolution` (small, backward-compatible addition).

### Cloud → Pi poll

The decided 30s product-sync poll is a new Pi-side thread (thin wrapper around `sync_products_from_cloud`) or can piggyback on the existing `LiveTrackPoller` loop's idle branch. Either way, a new `CloudCatalogPoller` component. No edge fn changes needed.

## 10. Build order recommendation

Priorities ordered from "unblock the owner's next build" → "retire old stuff" → "polish".

1. **Event viewer schema** — migration for `event_overrides` + `apply_event_override` RPC + RLS. Write pgTAP tests for the retroactive `logical_date` preservation + the back-out-and-reapply flow.
2. **Event viewer UI (read-only)** — `/chef/events` page. TanStack Query off `shelf_event_log` + join to products + food_logs. Per-row deep link to `${lan_ip}/event/<pi_event_id>/before.jpg` (requires Pi change #5 below).
3. **Pi: emit `pi_event_id` in outbox payload** — one-line change in `cloud/integration.py`. Backward compatible (cloud ignores unknown field today per `shelf-ingest/index.ts` — verify).
4. **Event viewer UI (edit + delete)** — servings-primary form, custom macros disclosure, soft-delete button.
5. **Single-item rig fix** — schema CHECK literal rename + `handle_scale_event` live_scale branch + dispatch `emit_single_item_event`. pgTAP + Pi pytest. Operator pairs scale in cloud, places item, consumption flows to food_logs.
6. **Cloud → Pi product poll** (30s) — thin `CloudCatalogPoller` reusing `sync_products_from_cloud`. Wire into `app.py` startup alongside `CloudWorker`.
7. **LiquidTrack retirement** — SettingsPage tab removal + MacroPage source swap to food_logs + delete `liquidtrack` edge fn + drop migrations.
8. **Pi web UI demotion** — add an "operator mode" banner to `dashboard.html`, redirect `/inventory`, `/intake`, `/events` to the cloud equivalents when cloud is reachable.

## 11. Retirement order

1. **After step 2 above (viewer read-only is live)**: mark `GET /events` and `GET /event/<id>` on the Pi as deprecated in logs; do not delete yet.
2. **After step 4 (edit is live)**: remove `GET /events` links from `dashboard.html`; keep endpoints behind an operator flag.
3. **After step 5 (single-item working)**: drop `chefbyte.liquidtrack_readings` confirmation migration, delete `functions/liquidtrack`, delete SettingsPage `liquidtrack` tab, delete MacroPage `liquidtrack_events` branch.
4. **After step 6 (product poll live)**: the "restart the Pi to see new products" footgun is closed. Safe to demote `/intake` on Pi to operator-only (hide when `cloud_reachable=true`).
5. **After step 7**: `DROP TABLE chefbyte.liquidtrack_devices, chefbyte.liquidtrack_events;` migration. Remove `[functions.liquidtrack]` from `config.toml`.
6. **After step 8**: Pi web UI is reduced to dashboard + debug/admin. Can live on as a local-network operator tool indefinitely.

## 12. Risks and unknowns

- **Did not verify**: the exact shape of `shelf_event_log` — assumed from migration `20260419060000_shelf_ingest_hardening_v2.sql` but did not cross-check current prod schema. If a later migration added/renamed columns, the override RPC signature will need adjustment.
- **Did not run**: `pnpm test` or the Pi pytest suite in this audit. Status claims are based on code inspection + live healthz + live DB state, not re-verified test runs.
- **Pi firmware for `scale-03`** was not read end-to-end — only confirmed device_id default is `scale-03`, shelf_id is not in the payload (server resolves), and the ESP will happily POST to `/api/scale-event` which is where the storage CHECK blows up today.
- **`food_logs` double-write risk** on retroactive edit — the override RPC backs out + re-applies. If the user edits the same event twice in quick succession, the middle-state `food_logs` row would be briefly missing. Mitigate by keeping the mutation under one transaction (already proposed).
- **Browser → Pi LAN reach**: requires the user to be on the same LAN as the Pi. Out-of-LAN (e.g., cellular) image streaming will fail silently. The event viewer should gracefully degrade (show "image unavailable, view on Pi LAN") when fetch fails, and the Pi's `lan_ip` field may be stale for the 2 devices that haven't heartbeated since 2026-04-20.
- **`cloud_outbox` payload `_pi_resolution_id`** — present today but not `pi_event_id`. Adding a new field to the payload is backward-compatible (edge fn ignores unknowns per `shelf-ingest` handler), but tests in `server/tests/test_reconciler_repo_cloud.py` may assert payload key set exactly.
- **Dead branches** on the Pi: `scale_events.py:436` `shelf_id == "single_item"` → never hit; `scale_events.py:459 emit_single_item_event` — never called. Safe to delete during the §G fix, but worth confirming via grep before touching.
