# fridge-cam

Local camera daemon that records door-open sessions on a fridge. Part of the
larger fridge inventory tracker (camera + scale + VLM), but this demo stands
alone: it has no Supabase upload, no scale correlation, and no VLM. It captures
video, detects open/close via frame brightness, saves a clip + before/after
stills per session, and serves a local dark-mode web UI for live preview and
event review.

Target deployment is a Raspberry Pi Zero 2W with a USB camera, but the same
code runs unmodified on any Linux or macOS dev machine with a USB webcam.

## Install

```bash
cd hardware/fridge-cam
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

On 32-bit Raspberry Pi OS there are no prebuilt `opencv-python` wheels.
Either use 64-bit Raspberry Pi OS (recommended for the Zero 2W) or install
the system package: `sudo apt install python3-opencv` and skip opencv in
the requirements file.

## Run

```bash
python app.py
# overrides:
python app.py --port 9000 --camera 1
```

Open the web UI at `http://<host>:8000/` (default port). From the Pi that's
usually `http://raspberrypi.local:8000/` or the LAN IP.

## What you get

- `GET /` - dashboard with live MJPEG preview, brightness/door readout,
  config form, manual trigger buttons, and the 10 most recent events.
- `GET /events` - all events with before/after thumbnail pairs.
- `GET /event/<id>` - per-event detail page: video player, before/after
  side-by-side, metadata table.
- `GET /live.mjpg` - raw MJPEG stream (embed in an `<img>` tag).
- `GET /api/state` - JSON: door state, current brightness, total events.
- `GET /api/events` - JSON list of events (optional `?limit=N`).
- `GET|POST /api/config` - read or update tunable config (threshold,
  hysteresis, fps, debounce, before-offset, detection on/off).
- `POST /api/trigger/start` and `POST /api/trigger/end` - force a session
  start or end without needing a brightness change.

## How sessions are recorded

1. Every captured frame is downsampled to 160x120 grayscale to compute its
   mean brightness.
2. A hysteresis state machine with a 2 s debounce watches for:
   - door OPEN: `brightness > threshold + hysteresis/2`
   - door CLOSE: `brightness < threshold - hysteresis/2`
3. On OPEN, a new directory `events/<event_id>/` is created and a
   `VideoWriter` at `events/<event_id>/session.mp4` starts recording at the
   camera's capture fps (mp4v codec).
4. On CLOSE, the writer is released, then the MP4 is re-read to pull:
   - `before.jpg` - frame at roughly `fps * before_offset_seconds`
     (default 1.5 s, after auto-exposure settles)
   - `after.jpg` - the last written frame
5. `meta.json` is written with event id, timestamps, duration, avg brightness
   during the session, fps, resolution, frame count, and cause
   (`brightness` or `manual`).

## Testing without a fridge

Three options:

1. **Lens-cover test.** Point the camera at a lit area. Cover the lens with
   your hand: brightness drops below `threshold - hysteresis/2`, so the
   daemon treats it as "door closed." Uncover: brightness rises,
   door "opens" and a session starts. Cover again to close the session.
   Repeat. Each cycle produces one event in `events/`.
2. **Manual triggers.** Disable brightness detection via the dashboard's
   config form (uncheck "detection on") and click **force open** /
   **force close**. Ideal for desk demos where you don't want to fiddle
   with lighting.
3. **API triggers.**
   ```bash
   curl -X POST http://localhost:8000/api/trigger/start
   curl -X POST http://localhost:8000/api/trigger/end
   ```

Events accumulate in `events/` as you test and appear on the dashboard
immediately (list is read from disk each request).

## Config reference

`config.json` is loaded on startup and merged with defaults. `POST /api/config`
updates tunable keys at runtime (written back to `config.json`).

| key                              | default | mutable at runtime | notes                                                |
|----------------------------------|---------|--------------------|------------------------------------------------------|
| `camera_index`                   | 0       | no (restart)       | USB camera index (`/dev/video0` on Linux)            |
| `resolution_width`               | 1280    | no (restart)       |                                                      |
| `resolution_height`              | 720     | no (restart)       |                                                      |
| `capture_fps`                    | 5       | yes                | Low fps keeps Pi CPU load low                        |
| `brightness_threshold`           | 60      | yes                | 0-255, higher = harder to trigger open               |
| `brightness_hysteresis`          | 20      | yes                | Gap between open/close points; raise if chatter      |
| `debounce_seconds`               | 2       | yes                | Minimum time between transitions                     |
| `brightness_detection_enabled`   | true    | yes                | When false, only manual triggers fire events         |
| `before_frame_offset_seconds`    | 1.5     | yes                | Where to grab the "before" frame                     |
| `web_port`                       | 8000    | no (restart)       | CLI `--port` overrides this                          |

## Running on the Raspberry Pi Zero 2W

```bash
# one-time setup
sudo apt update
sudo apt install -y python3-venv python3-pip  # 64-bit Pi OS
cd ~/luna-hub-lite/hardware/fridge-cam
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# run it
python app.py
```

For a production install, run under systemd so it auto-starts on boot.
A minimal unit file (save as `/etc/systemd/system/fridge-cam.service`):

```ini
[Unit]
Description=fridge-cam daemon
After=network.target

[Service]
Type=simple
User=pi
WorkingDirectory=/home/pi/luna-hub-lite/hardware/fridge-cam
ExecStart=/home/pi/luna-hub-lite/hardware/fridge-cam/.venv/bin/python app.py
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl enable --now fridge-cam`.

### Pi-specific tips

- Keep `capture_fps` at 5 or lower. The Zero 2W has four cores but only
  512 MB RAM; 1280x720 @ 5 fps plus the MJPEG stream is comfortable.
- Use a USB 2.0 camera - the Zero 2W only has USB 2.0.
- If startup is slow, set `resolution_width=640, resolution_height=480`.
- Keep `events/` on the SD card for demo; move it to a USB SSD if you let
  sessions accumulate for days.

## Known limitations / out of scope

- **No Supabase upload.** Events stay on local disk. Integrating with
  ChefByte stock updates comes later.
- **No scale correlation.** The daemon is camera-only; the scale side
  lives in `hardware/scale-board/`.
- **No VLM.** Before/after stills are extracted, but nothing analyzes
  them. That's the next layer on top.
- **No auth.** The web UI is bare HTTP on the LAN; do not expose it to
  the internet. Put it behind a reverse proxy + basic auth if you need
  remote access.
- **mp4v codec is good enough for demo.** For long-term archive,
  re-encode with ffmpeg to H.264 after the fact.
- **Re-reading the MP4 to extract before/after stills** uses a
  second pass; for long sessions (minutes) this adds latency to the
  close event. In practice fridge openings are seconds.
- **Brightness detection is crude** - a fixed threshold with hysteresis.
  On a real fridge the interior light makes this work well; in ambient
  lighting you may need to tune via the dashboard or disable detection
  and use manual triggers.
- **No automatic event pruning.** `events/` will grow forever. Add a
  cron that deletes events older than N days if that matters.
- **Deleting an event** must be done from the shell (`rm -rf events/<id>`).
  A UI delete button is not implemented.

## File layout

```
hardware/fridge-cam/
├── app.py              # daemon: capture thread + Flask app
├── config.json         # default + runtime config
├── requirements.txt
├── templates/
│   ├── _base.html
│   ├── dashboard.html
│   ├── events.html
│   └── event_detail.html
├── static/             # (empty; styles are inline in _base.html)
├── events/             # per-event subdirs (session.mp4, before.jpg,
│                       #   after.jpg, meta.json) - gitignored
├── .gitignore
└── README.md
```
