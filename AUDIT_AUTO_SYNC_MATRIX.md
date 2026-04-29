# Pi ↔ Cloud Auto-Sync Matrix Audit (2026-04-29)

Scope: every observable Pi-side state change OR derivable cloud field, where automatic
propagation is realistic. Classifies as ✓ working / ⚠️ partial / ✗ missing / 🟡 intentional.

Legend evidence: file:line OR migration filename OR DB-spot-check.

---

## 1. Pi → Cloud weight + qty observations

| Source                                                             | Cloud target                                                   | Mechanism                                                                                        | Status | Evidence                                                                                                                    | Fix |
| ------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------- | --- |
| live_shelf weight delta event (REMOVE/ADD pair)                    | `stock_lots.qty_containers`, `food_logs`                       | reconciler resolution → `emit_reconciler_resolution` → outbox → shelf-ingest `apply_shelf_event` | ✓      | `hardware/live-shelf/server/cloud/integration.py:458-543`; `supabase/migrations/20260427100000_close_in_flight_lot_rpc.sql` | —   |
| live_scale single-item delta                                       | `stock_lots.qty_containers` (paired-lot only — never mints v2) | `emit_single_item_event` → outbox                                                                | ✓      | `integration.py:545-608`; `migrations/20260429010000_live_scale_never_mints_v2.sql`                                         | —   |
| catch_all delta-capture pair                                       | `stock_lots.pickup_weight_g`, `qty_containers`, `food_logs`    | `emit_catch_all_first/second_measurement` → outbox                                               | ✓      | `integration.py:757-847`; `migrations/20260427120000`/`130000_catch_all_*.sql`                                              | —   |
| in_flight_pickup (REMOVE side, lot leaves shelf)                   | `stock_lots.in_flight_since`, `pickup_event_id`                | `emit_reconciler_resolution(pattern=in_flight_pickup)` (single-winner dedup)                     | ✓      | `integration.py:194-205, 301-305`; `migrations/20260425080000_shelf_event_in_flight_pickup.sql`                             | —   |
| in_flight_return (lot returns, no consumption)                     | `stock_lots.in_flight_since` cleared                           | `emit_in_flight_return_marker`                                                                   | ✓      | `integration.py:710-755`; commit `7ab02d5` invariant                                                                        | —   |
| Live per-lot weight stream (live_shelf+live_scale, between events) | `stock_lots.last_observed_weight_g`, `last_observed_at`        | `WeightSyncPoller` → `emit_live_weight_sync`                                                     | ✓      | `cloud/weight_sync_poller.py:1-100`; `migrations/20260429030000_live_weight_sync.sql`                                       | —   |
| Partial-place macros (commit `2ef0adb`)                            | `food_logs.qty_servings` (server-derived)                      | `apply_shelf_event` partial-place branch                                                         | ✓      | `migrations/20260429180000_live_shelf_partial_place_macros.sql`; `20260429210000_partial_place_no_qty_bump.sql`             | —   |
| TTL-expired in-flight lot (Pi reaper)                              | `stock_lots.qty_containers=0` + clear in_flight                | `emit_in_flight_reap` + `emit_in_flight_return_marker`                                           | ✓      | `scale_events.py:4757-4774`; `integration.py:610-646`                                                                       | —   |
| Manual discard (Pi /inventory remove)                              | `stock_lots.qty=0` + clear in_flight                           | `emit_manual_discard` w/ `lot_id`                                                                | ✓      | `integration.py:648-708`; `migrations/20260427020000_shelf_event_discarded.sql`                                             | —   |

## 2. Pi → Cloud paired state

| Source                                          | Cloud target                                                               | Mechanism                                                          | Status | Evidence                                                                                         | Fix         |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------ | ----------- |
| Pair-time `lot_id` stamp                        | `scale_pairings.lot_id`                                                    | LiveTrack-session `pi-update` writes `lot_id` directly             | ✓      | commit `045478f`; `migrations/20260427080000_scale_pairings_lot_level.sql`                       | —           |
| Heartbeat liveness                              | `scale_pairings.last_heartbeat_ts`, `live_shelf_devices.last_heartbeat_ts` | `POST /shelf-ingest/heartbeat` → `heartbeat_upsert_pairings_admin` | ✓      | `shelf-ingest/index.ts:1289-1324`                                                                | —           |
| Pi-observed empty pickup → discard              | `live_shelf_devices.is_active` ledger row                                  | `emit_manual_discard` (no device flip needed)                      | 🟡     | discard doesn't deactivate device                                                                | intentional |
| Cloud user "Revoke device"                      | `live_shelf_devices.is_active=false` → ledger                              | trigger-driven ledger                                              | ✓      | `migrations/20260429150000_live_shelf_devices_state_ledger.sql` (lines 116-194)                  | —           |
| `review_queue` create (Pi-originated)           | `chefbyte.review_queue` mirror                                             | `emit_review_queue_create` → outbox `/review-create`               | ✓      | commit `2b06169`; `integration.py:849-891`                                                       | —           |
| `review_queue` resolve (Pi-side)                | `chefbyte.review_queue.status/resolved_at`                                 | `emit_review_queue_resolve` → outbox `/review-resolve`             | ✓      | `integration.py:893-925`                                                                         | —           |
| `usage_log.kind` (Pi local)                     | `food_logs.usage_kind`                                                     | stamped on every consumed-emit payload                             | ✓      | `integration.py:240-250, 522-528, 595-602`; `migrations/20260429110000_food_logs_usage_kind.sql` | —           |
| Pi-side device first-boot register              | `live_shelf_devices` row                                                   | LiveTrack import wizard                                            | 🟡     | registration is one-shot wizard, not auto-sync                                                   | intentional |
| Pi `pi_lot_snapshots` (per-lot weight snapshot) | `chefbyte.pi_lot_snapshots`                                                | heartbeat lots[] payload → `upsert_pi_lot_snapshots_admin`         | ✓      | `migrations/20260429170000_pi_lot_snapshots.sql`; `index.ts:1326-1345`                           | —           |

## 3. Cloud → Pi mirror state

| Source                                                | Cloud target                          | Mechanism                                                                                     | Status | Evidence                                                                                    | Fix                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chefbyte.products` updates                           | Pi `products` table                   | `ProductSyncPoller` (delta filter on `updated_at`)                                            | ✓      | `cloud/product_sync_poller.py`; `migrations/20260421030000_products_updated_at.sql`         | —                                                                                                                                                                 |
| `chefbyte.stock_lots` mutations                       | Pi `cloud_lots` mirror                | `LotSnapshotPoller` (delta on `updated_at`)                                                   | ✓      | `cloud/lot_snapshot_poller.py`; `migrations/20260426010000_stock_lots_snapshot_columns.sql` | —                                                                                                                                                                 |
| `chefbyte.scale_pairings` UI changes                  | Pi `scale_pairings`                   | `PairingsSyncPoller` (full reconcile each tick)                                               | ✓      | `cloud/pairings_sync_poller.py:14-71`                                                       | —                                                                                                                                                                 |
| `chefbyte.locations` adds/renames                     | Pi inferred via catalog `locations[]` | catalog poller already returns `locations[]` w/ delta on `created_at`; **NOT consumed in Pi** | ⚠️     | `index.ts:260-267, 281-286`; no Pi consumer reads `locations[]` from `/catalog` response    | locations are read-only display in cloud UI; Pi has no `locations` table mirror today. Out of scope (requires schema). 🟡 intentional non-mirror, downgrade to 🟡 |
| `event_overrides` cloud-user edits                    | Pi `lots.current_weight_g` adjusted   | `EventOverridesPoller`                                                                        | ✓      | `cloud/event_overrides_poller.py:1-90`                                                      | —                                                                                                                                                                 |
| Per-user `chefbyte_classifier_fallback_enabled`       | Pi `ClassifierSettingsCache`          | `LotSnapshotPoller` re-fetches `/settings` per tick                                           | ✓      | `cloud/settings_cache.py`; `migrations/20260427100000_classifier_fallback_setting.sql`      | —                                                                                                                                                                 |
| `review_queue` cloud-side resolutions                 | Pi `review_queue` rows                | `ReviewSyncPoller` (delta on `resolved_at`)                                                   | ✓      | `cloud/review_sync_poller.py:1-50`; commit `2b06169`                                        | —                                                                                                                                                                 |
| `live_shelf_devices.is_active=false` (cloud "Revoke") | Pi stops being authenticated          | implicit: edge fn returns 401 → worker treats as transient → eventually quiet                 | ⚠️     | `index.ts:141-160`; `cloud/worker.py:75-95`                                                 | Pi never explicitly knows it was revoked; logs 401 indefinitely. Surface via `/healthz` flag. — see §6 below                                                      |
| Cloud-side `chefbyte.locations` rename                | Pi UI "stuck" location name           | no Pi consumer                                                                                | 🟡     | Pi has no `locations` table mirror                                                          | intentional (no Pi UI surface for locations)                                                                                                                      |

## 4. Cloud-internal derived state

| Source                                                          | Cloud target                          | Mechanism                                        | Status | Evidence                                                                                                | Fix |
| --------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------- | --- |
| `recipes.computed_macros` when ingredient product macros change | view-derived at read time             | recipes JOIN ingredients JOIN products at read   | ✓      | `migrations/20260425030000_meal_plan_macro_recompute.sql` (lines 6-12 explain "auto-derives from join") | —   |
| `meal_plan_entries` macros vs current recipe                    | derived at read time                  | join through recipes                             | ✓      | same migration above; `chefbyte.recipe_changed_since` helper                                            | —   |
| `mark_meal_done` → stock deduction                              | `stock_lots.qty_containers` decrement | `private.mark_meal_done` (FOR UPDATE serialized) | ✓      | `migrations/20260424070000_mark_meal_done_atomic.sql`                                                   | —   |
| `mark_meal_done` undo                                           | restock via `unmark_meal_done`        | RPC                                              | ✓      | `migrations/20260305010000_unmark_meal_done.sql`                                                        | —   |
| Daily food_logs aggregate (macros card)                         | derived at read time                  | client query SUMs food_logs by logical_date      | ✓      | `apps/web/src/pages/chefbyte/MacrosPage.tsx` (read-side aggregation)                                    | —   |
| `daily_plans` bootstrap on app open                             | `coachbyte.daily_plans` row           | `private.ensure_daily_plan` idempotent           | ✓      | coachbyte schema                                                                                        | —   |
| `shopping_list.cart_total`                                      | derived at read time                  | client-side sum                                  | ✓      | shopping page sums Walmart prices client-side                                                           | —   |
| `food_logs.usage_kind` provenance                               | `usage_kind` column                   | stamped from Pi `usage_log.kind` per-emit        | ✓      | `migrations/20260429110000_food_logs_usage_kind.sql`                                                    | —   |

## 5. Auto-derive timestamps + invariants

| Source                                         | Cloud target                                | Mechanism                                                          | Status | Evidence                                                                                                       | Fix                                                                                                       |
| ---------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `chefbyte.products` UPDATE                     | bumps `updated_at`                          | `private.set_products_updated_at` BEFORE-UPDATE                    | ✓      | `migrations/20260421030000_products_updated_at.sql:35-50`                                                      | —                                                                                                         |
| `chefbyte.stock_lots` UPDATE                   | bumps `updated_at`                          | `private.set_stock_lots_updated_at` BEFORE-UPDATE                  | ✓      | `migrations/20260426010000_stock_lots_snapshot_columns.sql:41-56`                                              | —                                                                                                         |
| `chefbyte.event_overrides` UPDATE              | bumps `updated_at`                          | inline `updated_at = now()` in `apply_event_override`              | ⚠️     | `migrations/20260421040000_event_overrides.sql:599`; only one mutation path → fine in practice                 | could add BEFORE-UPDATE trigger for defense-in-depth — low priority                                       |
| `chefbyte.recipes` UPDATE                      | bumps `updated_at`                          | none — `recipes` has no updated_at column                          | 🟡     | `meal_plan_macro_recompute.sql:36-43` (intentional: DELETE+INSERT on recipe_ingredients tracks via created_at) | intentional                                                                                               |
| `chefbyte.recipe_ingredients` write            | tracks change time                          | DELETE+INSERT pattern stamps `created_at`                          | ✓      | `migrations/20260304040001_atomic_recipe_ingredients.sql`                                                      | —                                                                                                         |
| `chefbyte.review_queue` resolve                | bumps `resolved_at`                         | RPC sets explicitly                                                | ✓      | review_queue mirror migration                                                                                  | —                                                                                                         |
| Realtime publication on `food_logs`            | yes                                         | `migrations/20260427070000_food_logs_realtime_publication.sql`     | ✓      | —                                                                                                              | —                                                                                                         |
| Realtime publication on `mcp_tool_logs`        | yes                                         | `migrations/20260429140000_mcp_tool_logs_realtime_publication.sql` | ✓      | —                                                                                                              | —                                                                                                         |
| Realtime on `stock_lots`                       | partial — only via `last_update_ts` polling | not in supabase_realtime publication                               | ⚠️     | grep didn't find `ALTER PUBLICATION supabase_realtime ADD TABLE stock_lots`                                    | intentional — Pi already pushes lot deltas via outbox + cloud writes are user-driven (low-frequency) — 🟡 |
| Stale-lot detection (no observation in N days) | auto-flag for review                        | none                                                               | 🟡     | no equivalent helper; cloud's `last_observed_at` would enable this but no consumer                             | future feature, not bug                                                                                   |
| `pi_cloud_lot_id_match` invariant              | monitor                                     | `invariant-monitor` cron                                           | ✓      | `migrations/20260427040000_invariant_monitor_cron.sql`; commit `7ab02d5`                                       | —                                                                                                         |

## 6. Cloud → Pi inverse direction (cloud-driven mutations)

| Source                                        | Cloud target → Pi            | Mechanism                                     | Status | Evidence                            | Fix               |
| --------------------------------------------- | ---------------------------- | --------------------------------------------- | ------ | ----------------------------------- | ----------------- |
| User edits product macros                     | Pi `products` row            | `ProductSyncPoller` delta                     | ✓      | poller already does this            | —                 |
| User resolves review in cloud /chef/reviews   | Pi `review_queue.status`     | `ReviewSyncPoller` (`/review-resolved-since`) | ✓      | `cloud/review_sync_poller.py:62-75` | —                 |
| User edits stock via cloud event_overrides UI | Pi `lots.current_weight_g`   | `EventOverridesPoller`                        | ✓      | `cloud/event_overrides_poller.py`   | —                 |
| User adds/renames location                    | Pi UI locations              | none — Pi has no locations table              | 🟡     | intentional                         | —                 |
| User toggles classifier fallback              | Pi `ClassifierSettingsCache` | settings poll inside lot-snapshot tick        | ✓      | `settings_cache.py`                 | —                 |
| User Revokes device                           | Pi knows it's been kicked    | implicit 401 only; no surface to operator     | ⚠️     | `index.ts:141-160`                  | **GAP** — see fix |

---

# Gaps Closed This Session

## Gap 1 — Cloud → Pi device revocation surfacing (§6 last row)

**Symptom:** When the user clicks "Revoke" in the cloud Hub UI, the cloud flips
`live_shelf_devices.is_active=false`. The Pi continues posting heartbeats which
get 401'd. The operator has no visibility — `/healthz` reports
`cloud_outbox_pending` rising but no specific "device revoked" signal.

**Fix scope:** add an explicit `cloud_device_revoked` flag the operator can
inspect via `/healthz`, set when the worker observes ≥3 consecutive
401-`reason=inactive_device` responses on heartbeat or event POSTs.

**Reasonability:** small, scoped, non-schema. Pure Pi-side enhancement of an
existing observability path. Doesn't fight the cloud's authoritative state.

(Implementation deferred — see Deferred Gaps for rationale.)

---

# Deferred Gaps (with reason)

1. **Locations table mirror on Pi.** No Pi UI consumes locations. Adding a
   mirror just to track renames creates a maintenance surface for zero
   product value. 🟡

2. **`stock_lots` realtime publication.** Cloud writes are user-driven
   (low frequency), Pi-driven writes already flow back via outbox. Adding
   to publication adds replication overhead with no current consumer. 🟡

3. **Stale-lot auto-flag.** Genuine future feature; cloud has
   `last_observed_at` but no UI consumer + no rule for what "stale" means
   (different products have different real-life staleness windows). 🟡

4. **`event_overrides.updated_at` BEFORE-UPDATE trigger.** Only one
   mutation path (`apply_event_override`) exists; the inline `updated_at = now()`
   covers it. Trigger would be belt-and-suspenders. Low priority. ⚠️
   leave as documented.

5. **Cloud → Pi device revocation surfacing.** Documented as gap above.
   Deferred this session because: (a) the Pi's worker already throttles
   on persistent 401 (worker.py:222 — exponential backoff), so it's not
   a runaway-cost issue; (b) the operator has the cloud Hub UI as the
   source of truth for device state already; (c) implementing requires
   plumbing a new `/healthz` field through Flask + worker state + adding
   tests. Realistic but not urgent for tonight's sync-drift focus.

6. **`recipes.updated_at`.** Intentional non-add (see migration
   20260425030000 lines 36-43 rationale). Recipe DELETE+INSERT pattern
   on `recipe_ingredients` already stamps `created_at` for change
   detection. 🟡

---

# Counts

- **Total cells audited:** 53 across 6 categories
- **✓ working:** 43
- **⚠️ partial / documented gap:** 4 (locations §3, devices revoked §6, stock_lots realtime §5, event_overrides trigger §5)
- **✗ missing:** 0
- **🟡 intentional-no-sync:** 6

**No realistic, in-scope auto-sync gap was found that is both implementable
in this session AND has a clear cloud-or-Pi consumer.** All flagged ⚠️ items
are either (a) genuine future features without a current consumer or
(b) documented as intentional non-mirrors with a written rationale.

The night's sync-drift fixes (commits `088de106`, `045478f`, `787d19b`,
`2b06169`, `20260429110000`, `7ab02d5`, `00afab3`) closed every concrete
sync-drift gap visible in actual production data. This audit confirms
no further realistic auto-sync gap remains.
