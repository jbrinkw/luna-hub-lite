-- ChefByte classifier fallback setting (per-user opt-in)
--
-- Adds `chefbyte_classifier_fallback_enabled BOOLEAN` to `hub.profiles`.
-- When TRUE, the live-shelf Pi classifier runs a SECOND pass against
-- ALL certified LiveTrack-tracked products if the FIRST pass (against
-- the inventory-only candidate pool) returns UNKNOWN or low confidence.
--
-- Default FALSE — explicit opt-in. Adds latency + AI cost when the
-- fallback fires, so users opt in only when they hit cases where
-- inventory-only matching fails (e.g. an item that's certified +
-- LiveTrack-tracked but isn't currently in the cloud_lots inventory
-- mirror because it was depleted earlier and they're putting a fresh
-- container on the shelf).
--
-- Pi sync: the Pi's lot-snapshot poller is extended to fetch this
-- field from a /shelf-ingest/settings endpoint (added in the same
-- bundle of changes) on the same 60s cadence and cache the value
-- in-memory for use by the classifier.
--
-- RLS: hub.profiles already has user-scoped policies (each user only
-- reads + updates their own row). This column inherits those policies
-- with no separate grant changes required.

BEGIN;

ALTER TABLE hub.profiles
  ADD COLUMN IF NOT EXISTS chefbyte_classifier_fallback_enabled
    BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
