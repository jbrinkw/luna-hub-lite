-- no-test: one-time data-bump UPDATE — no schema change, Pi-resync is one-shot and not reproducible in pgTAP
-- ════════════════════════════════════════════════════════════════════════════
-- Bump scale_pairings.last_heartbeat_ts to force a Pi-side resync
-- ════════════════════════════════════════════════════════════════════════════
-- USER BUG (2026-04-29):
--   88de106 added the live_weight_sync poller. The poller's ``live_scale``
--   branch joins ``scale_pairings`` (cloud-mirrored) with the in-memory
--   heartbeat state. The fix in commit 213f1a4 wires the runtime state
--   provider so the poller can stream gallon-of-milk weights to cloud.
--
--   But on the production Pi, ``scale_pairings.lot_id`` for scale-03 was
--   NULL: the cloud just got it backfilled by 20260429190000_backfill_live
--   _scale_lot_id.sql, but the Pi's ``pairings_sync_poller`` filters by
--   ``last_heartbeat_ts > watermark`` so a backfill that updates only
--   lot_id is silently dropped from the next delta-pull. The Pi keeps
--   serving lot_id=NULL forever.
--
-- FIX:
--   Bump last_heartbeat_ts on every live_scale pairing row so the next
--   pairings_sync_poller tick on every Pi pulls the row in fresh and
--   propagates the correct lot_id. One-time op — the cost is one
--   forced delta-sync per Pi, which lands within 60s of this migration.
--
-- IDEMPOTENCY:
--   Re-running just bumps last_heartbeat_ts again — harmless. The
--   Pi-side reconciler is a UPSERT with a no-op short-circuit when the
--   row hasn't materially changed, so a repeated bump is benign.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE chefbyte.scale_pairings
   SET last_heartbeat_ts = clock_timestamp()
 WHERE kind = 'live_scale';

COMMIT;
