# USB Barcode Scanner Module

A USB HID barcode scanner plugged into the live-shelf Pi forwards each
scan to the cloud edge function `/shelf-ingest/barcode-scan`. The
module runs as a daemon thread alongside the existing scale event
handlers, gated by env var `BARCODE_SCANNER_ENABLED=true`.

## Components

- `server/barcode/hid_listener.py` — opens an evdev device, accumulates
  keystrokes until ENTER, yields barcode strings. Pure
  `accumulate_keys_to_barcode` function for testability.
- `server/barcode/scanner_loop.py` — orchestrates: pulls barcodes from
  the listener, generates a unique `pi_event_id` per scan, forwards via
  `CloudClient.post_barcode_scan`. Cloud errors are logged + swallowed
  (loop never crashes).
- `server/cloud/client.py::post_barcode_scan` — POST to `/shelf-ingest/barcode-scan`.
- `server/app.py::_start_barcode_scanner_thread` — wires the loop as a
  daemon thread alongside other Pi background threads.

## Auth

Reuses `chefbyte.live_shelf_devices` table (x-api-key SHA-256). The
same Pi serves both the load-cell scales and the USB scanner; one
device row is sufficient.

## Idempotency

Each scan generates `pi_event_id = 'barcode-<uuid4>'`. The cloud edge
function's unique partial index on
`(user_id, pi_event_id) WHERE pi_event_id IS NOT NULL` deduplicates
retries triggered by HTTP failures. A second POST with the same
`pi_event_id` returns the original transaction_id unchanged.

## Mode resolution

The cloud — not the Pi — resolves the mode for each scan from
`chefbyte.scanner_state.locked_mode || last_active_mode`. The Pi sends
only the barcode + `pi_event_id`. Web Scanner page broadcasts mode
changes via `POST /shelf-ingest/scanner-state` with 500ms debounce.

## Configuration

Env vars (set in `/etc/luna-live-shelf.env` or the systemd unit):

- `BARCODE_SCANNER_ENABLED=true` — gate the scanner thread.
- `BARCODE_SCANNER_DEVICE=/dev/input/event2` — evdev device path.
  Default: `/dev/input/event0`. Find yours with `cat /proc/bus/input/devices`.

## E2E test

`apps/web/src/__tests__/integration/edge-functions/scanner-pipeline.test.ts`
exercises the full real-cloud path: web mode push → Pi-style scan →
transaction logged → void reverses side-effect. Three scenarios:
happy path, locked_mode trust boundary, idempotent retry.
