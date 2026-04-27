# Live Shelf server

Python 3.13 + Flask + SQLite application that owns the Pi-side of the
Live Shelf demo: camera capture, scale event ingestion, classifier, session
reconciler, and the web UI. ESP8266 firmware lives in `../firmware/`.

## Install

```bash
cd hardware/live-shelf/server
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install -r requirements.txt
cp .env.example .env
# Fill in ANTHROPIC_API_KEY in .env
```

The `.venv` at `hardware/live-shelf/.venv` (one level up) is also valid —
use whichever matches the user's existing setup.

## Run

From the `hardware/live-shelf/` directory (so relative imports resolve):

```bash
python3 -m server.app
```

Options:

- `--host`, `--port` — override WEB_HOST / WEB_PORT from `.env`.
- `--no-v4l2` — skip applying the locked camera settings (useful off-Pi).
- `--no-camera` — don't start the capture thread (debug only).
- `--data-dir PATH` — override the DATA_DIR root.

The web UI is then at `http://<host>:8000/`.

## Smoke test (no Anthropic key required)

```bash
cd hardware/live-shelf
python3 -m pytest server/tests/test_integration.py -v
```

This runs the full orchestrator flow against an in-process Flask client
with a synthetic camera and a stubbed Anthropic client. If all tests pass
the pipeline is wired correctly end-to-end.

## Reset demo data

```bash
python3 -m server.scripts.demo_reset        # prompts before deleting
python3 -m server.scripts.demo_reset -y     # skip prompt
```

Removes the DB + events/refs folders but keeps `camera_locked.json`.

## Deploy to the Pi

From a dev machine with SSH access to the Pi:

```bash
python3 hardware/live-shelf/scripts/deploy.py
```

This uses paramiko with the credentials the repo already has (see the
legacy `fridge-cam` deploy for the pattern). After the push:

```bash
ssh jeremy@192.168.0.181 "cd /home/jeremy/live-shelf && python3 -m pip install --break-system-packages -r server/requirements.txt"
ssh jeremy@192.168.0.181 "cd /home/jeremy/live-shelf && python3 -m server.app"
```

To run it as a systemd service on boot, create a unit that runs the same
command with `WorkingDirectory=/home/jeremy/live-shelf` and
`Environment=PYTHONPATH=/home/jeremy/live-shelf`.

## Cloud mode

The Pi can push scale events to the Luna Hub Lite cloud (Supabase) and read
its product catalog + stock from there instead of local SQLite. When enabled,
users see their physical-shelf state — device online, per-scale pairings,
lot-level updates tagged `live_shelf` / `live_scale` / `catch_all` — inside
the regular ChefByte UI. The full contract lives in
`hardware/live-shelf/docs/PROD_MIGRATION_PLAN.md`.

**What it enables:**

- Pi posts every reconciler-committed mutation to
  `<CLOUD_URL>/event` so cloud stock and macros stay in sync.
- Local inventory syncs from the cloud catalog per-event (pull, not push) —
  no background sync loop, no cache staleness.
- ChefByte Settings → Scales tab shows the device heartbeat and per-scale
  pairings; Inventory pages render lot rows with a source tag (manual /
  live_shelf / live_scale / catch_all) and a "Review (N)" deep-link to the
  Pi's local review queue.

**Required env vars** (in `hardware/live-shelf/server/.env`):

```
CLOUD_ENABLED=1
CLOUD_URL=https://<project>.supabase.co/functions/v1/shelf-ingest
CLOUD_IMPORT_KEY=<64-char hex>
CLOUD_HEARTBEAT_INTERVAL_S=30        # optional, default 30
```

**How to get a key:** log into ChefByte → Settings → Scales tab → "Add
Device" → copy the key once (it is only shown at creation — the cloud
stores its SHA-256 hash). Paste it into the Pi's `.env` as
`CLOUD_IMPORT_KEY` and restart the Flask app.

**How to verify:**

```bash
curl http://192.168.0.181:8000/healthz
```

`cloud_worker_alive=true` and `cloud_outbox_pending=0` means the Pi is
successfully talking to the cloud. Any non-zero pending count that is
_draining_ is normal; a count that stays flat under load points to an
auth or network issue.

**Offline behavior:** when the cloud is unreachable, events queue in the
local SQLite outbox and drain automatically once the worker sees a
successful heartbeat. Reconciliation still completes locally regardless of
cloud state — the cloud is a mirror, not a gate.

**Troubleshooting:**

- `401` in `server.log` → wrong `CLOUD_IMPORT_KEY` (regenerate from
  ChefByte → Settings → Scales).
- `cloud_outbox_permanent_failures > 0` → rows the cloud rejected with a
  4xx that isn't retryable (invalid payload, deleted device, etc.).
  Operator intervention: inspect the rows in the outbox table, fix the
  root cause, then clear them manually.
- `cloud_outbox_pending` climbs but never drops → network or auth
  problem; check the worker thread's log lines for the last error.

## Architecture

```
Flask app (app.py)
├── CameraDaemon           captures frames + detects door open/close
│     └── BrightnessHandler  → opens/closes sessions, runs reconciler
├── /api/scale-event       ScaleHandler — classify + update lot state
├── /api/intake/*          Bundle F blueprint (one-time product onboarding)
├── /*   (web HTML)        Bundle G HTML blueprint (dashboard / registry / etc)
├── /api/*   (web JSON)    Bundle G API blueprint (/api/state, /api/config)
└── /live.mjpg             Bundle C's MJPEG generator
```

Adapters under `server/adapters/` bridge the narrow protocols defined in
Bundles D/E/F/G to the concrete `storage.repo` CRUD.

## Troubleshooting

- **Camera fails to open** — check the device path in `.env`
  (`CAMERA_DEVICE=/dev/video0`) and that the process has permission.
  `--no-v4l2` skips the exposure/WB locks if `v4l2-ctl` isn't installed.
- **Frames missing during an event** — the ring buffer holds ~30s @ 10fps
  by default; if the scale event references a `ts` older than that window
  we log `FrameNotAvailableError` and enqueue a `sensor_anomaly` review
  row. Shorten `FRAME_LOOKBACK_SECONDS` or increase the ring size in
  `DaemonConfig` to recover.
- **Classifier keeps returning unknown** — ensure `ANTHROPIC_API_KEY` is
  set and your product actually has `certified=1` + reference images.
  Without references the model sees metadata only.
- **Session never closes** — the brightness watcher uses hysteresis +
  a 2s debounce. Tune `BRIGHTNESS_THRESHOLD` / `BRIGHTNESS_HYSTERESIS`
  in `.env` or via `POST /api/config`.
- **SQLite locked** — the orchestrator funnels DB writes through a single
  mutex; if you attach another writer (e.g. the `sqlite3` CLI) during a
  live session, sessions may stall. Stop the app first.
