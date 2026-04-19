-- Live Shelf LAN IP (device-local URL for "Review (N)" deep-link)
--
-- The Raspberry Pi running the live-shelf stack serves its review UI at
-- http://<lan_ip>:8000/inventory#review. The cloud ChefByte inventory
-- page uses this column to deep-link into that review queue.
--
-- Kept separate from the initial live_shelf migration so that the device
-- provisioning flow (Pi side) stays backward-compatible: existing rows
-- simply have NULL lan_ip until the user fills it in via Settings → Scales.

ALTER TABLE chefbyte.live_shelf_devices
  ADD COLUMN IF NOT EXISTS lan_ip TEXT;
