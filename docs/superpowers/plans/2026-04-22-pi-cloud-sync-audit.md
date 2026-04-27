# Pi ↔ Cloud Sync Audit — 2026-04-22

Triggered by: chocolate-milk lot stuck `in_flight` on Pi since
2026-04-22 14:10:31Z, invisible on cloud `/chef/inventory`. Full
enumeration of every Pi↔Cloud boundary with LIVE / PARTIAL / BROKEN
status and repro evidence.

## Evidence from the Pi (192.168.0.181)

```
lots:                 7c78ac21, product=f24aaedc (chocolate milk),
                      status=in_flight, current_weight_g=472.1,
                      in_flight_since=2026-04-22T14:10:31.237Z,
                      pickup_event_id=228d42f5
scale_events:         228d42f5 direction=remove, delta=-470.2g
session_resolutions:  e224e861 pattern=in_flight_pickup
                      d32e2299 pattern=consumed_or_removed (!)
cloud_outbox:         row 7 shows consumed event (-470g) for pid=f24aaedc,
                      sent_at=2026-04-22 14:11:10 — this came from the
                      consumed_or_removed row, NOT the in_flight_pickup
```

## Boundary-by-boundary status

### Pi → Cloud

| #   | Path                                                                             | Status         | Notes                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Reconciler resolution → `emit_reconciler_resolution` → `cloud_outbox` → `/event` | LIVE (partial) | Mapping `PATTERN_TO_EVENT_KIND` explicitly drops `in_flight_pickup` (mapped to `None`). Terminal in_flight_return / in_flight_replaced_new_item / in_flight_ttl_expired patterns DO emit as `consumed`. Fine in isolation.                                                                                                      |
| 2   | In-flight pickup marker → cloud `stock_lots.in_flight_since`                     | **BROKEN**     | The Pi transition `on_shelf → in_flight` has NO cloud emit. The cloud's `stock_lots.in_flight_since` column exists (migration 20260422020000) but is only CLEARED by `added`/`refilled` events — it's never SET.                                                                                                                |
| 3   | Double bookkeeping — `in_flight_pickup` + `consumed_or_removed` for same REMOVE  | **BROKEN**     | Observed on Pi: REMOVE event 228d42f5 produced BOTH an `in_flight_pickup` resolution (row e224e861) AND a later `consumed_or_removed` resolution (row d32e2299) with the same `remove_event_id`. The `consumed_or_removed` row leaked to cloud as `consumed`, zeroing out cloud stock. The in-flight state never reached cloud. |
| 4   | Single-item scale delta → `emit_single_item_event` → `/event`                    | LIVE           | Works per prior audit (scale-03 short-circuit).                                                                                                                                                                                                                                                                                 |
| 5   | TTL-reaped in-flight → `emit_in_flight_reap` → `/event` (consumed)               | LIVE           | Reaper writes `consumed` event with `-pickup_g` delta.                                                                                                                                                                                                                                                                          |
| 6   | Heartbeat → `/heartbeat` → `live_shelf_devices.last_heartbeat_ts`                | LIVE           | Working; now also triggers the self-heal for accidentally-deactivated devices (2026-04-25).                                                                                                                                                                                                                                     |
| 7   | Livetrack session state → `/pi-update`                                           | LIVE           | Not affected by this audit.                                                                                                                                                                                                                                                                                                     |
| 8   | Backfill sweeper (`backfill_missing_outbox_events`)                              | PARTIAL        | Only re-emits pattern→event_kind mappings that PATTERN_TO_EVENT_KIND considers valid. `in_flight_pickup` rows are silently skipped because mapping returns None.                                                                                                                                                                |

### Cloud → Pi

| #   | Path                                                                        | Status | Notes                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | ProductSyncPoller → `/catalog?updated_since=` → `upsert_product_from_cloud` | LIVE   | Column list verified against cloud schema in `intake/cloud_sync.py::_PRODUCT_COLUMNS`. All 20 fields including macros + certified + deleted_at. Pass-2 audit finding #2 already fixed the earlier drift. |
| 10  | EventOverridesPoller → `/overrides?updated_since=`                          | LIVE   | Not affected.                                                                                                                                                                                            |
| 11  | LivetrackPoller → `/active`                                                 | LIVE   | Not affected.                                                                                                                                                                                            |

## Root cause for Bug B (chocolate-milk invisible)

The Pi's in-flight tracker is a Pi-local state: `lots.status='in_flight'`
with `in_flight_since` + `pickup_event_id` + `pickup_weight_g`. The
cloud's stock_lots has matching columns (since 20260422020000) but
no write path — the cloud was designed to be "eventually consistent"
via the terminal in_flight_return / reap paths.

Observed reality: the Pi's handler writes BOTH an `in_flight_pickup`
resolution AND a `consumed_or_removed` resolution for the same REMOVE
event (see `reconciler/reconcile.py` Pass 2 — C3 logic only claims the
REMOVE when a terminal in_flight resolution exists; for a still-pending
in-flight pickup, the REMOVE falls through and gets resolved as
`consumed_or_removed`). This dual-write is the "safety net" for
unpaired pickups — but it means cloud receives `consumed` with the
full pickup mass, zeroing the lot's qty before the Pi has even
attempted to reconcile the return.

Consequence: `/chef/inventory` hides the lot because `qty_containers=0`.
The Pi still shows the bottle as in_flight. Two truths diverge until
the user brings the bottle back and the Pi emits a terminal
in_flight_return (which is fine — cloud gets a negative delta — but
by then `/chef/inventory` may be missing the intermediate state for
hours).

## Fix strategy (applied this commit)

1. **Add cloud-side `event_kind='in_flight_pickup'` path**: extend the
   `shelf-ingest` edge function + `private.apply_shelf_event` RPC to
   accept `in_flight_pickup` as a non-stock-mutating event that merely
   stamps `stock_lots.in_flight_since` and `stock_lots.pickup_event_id`
   on the matched lot. No qty decrement.

2. **Pi emits `in_flight_pickup`**: flip
   `PATTERN_TO_EVENT_KIND['in_flight_pickup']` from `None` to
   `'in_flight_pickup'` so the resolution DOES reach cloud. Add a new
   `CloudEventEmitter.emit_in_flight_pickup` helper.

3. **Suppress `consumed_or_removed` → cloud when there's a matching
   `in_flight_pickup` in the same session**: add a check in the
   `_derive_backfill_delta` + reconciler adapter paths so the Pi does
   not emit a zeroing-consumed event for a REMOVE that already has an
   in_flight_pickup row waiting for its return. This is defence in
   depth on top of #1 — if cloud sees both, the in_flight marker is
   effectively overridden by the later `consumed`, but the UI can
   special-case `in_flight_since IS NOT NULL` to keep showing it.

4. **Inventory UI**: the inventory-by-product view already uses the
   `stock_lots.in_flight_since IS NOT NULL` column to render an
   "In-flight" badge. A separate follow-up will change the qty filter
   from `> 0` to `> 0 OR in_flight_since IS NOT NULL` so in-flight
   empty lots stay visible.

## Deferred / follow-up (flagged)

- **Reconciliation snapshot endpoint** (Pi → Cloud state sweep):
  deferred. Would expose `POST /shelf-ingest/lot-snapshot` with
  full `(product_id, qty_containers, in_flight_since,
pickup_event_id)` tuples for every open Pi lot; cloud would
  upsert into `stock_lots` by `(user_id, product_id)` matching.
  Scope creep for this hotfix. Add a runbook instead: "operator can
  manually set `in_flight_since` in SQL if they need to override
  divergent state".

- **De-duplicate Pi dual-resolution bug** (`in_flight_pickup` +
  `consumed_or_removed` for same REMOVE): requires surgery in
  `reconciler/reconcile.py` Pass 2 to NOT emit `consumed_or_removed`
  for REMOVEs that already have a matching `in_flight_pickup` row,
  even without a terminal in-flight resolution. Current C3 guard
  only skips when terminal exists. Deferred — the cloud-side fix
  above makes the symptom invisible, but the root-cause dedup should
  be cleaned up in a later commit with proper tests.

- **`certified` column drift** (called out in the task): verified
  present in `_PRODUCT_COLUMNS` + upsert SET clause. No drift. The
  earlier drift was fixed in pass-2 audit finding #2.

## Commit plan

- Bug A fix → commit 1 (already shipped — `e7800e5`).
- Bug B cloud-side migration + edge fn → commit 2.
- Bug B Pi-side emit + helper → commit 3.
- Inventory UI qty-filter tweak → commit 4.
