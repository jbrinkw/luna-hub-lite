# Live Shelf — ESP8266 Firmware (`scale-live.ino`)

Bundle B of the Live Shelf demo. Runs on a Wemos D1 Mini, reads 4 HX711 load
cells in parallel, drives a WS2812B status LED, posts scale events to the
Pi over HTTP, and retains the existing calibration web UI.

This sketch does **not** replace `hardware/scale-board/firmware/scale-test.ino` —
that remains the bench-top calibration sketch. `scale-live.ino` is the shelf
firmware and adds everything on top of the same parallel-read core.

---

## 1. Board + pinout

| Signal | Pin (Wemos D1 Mini) | GPIO | Notes |
|---|---|---|---|
| HX711 SCK (shared by all 4) | `D7` | GPIO13 | Output. Driven high/low in lockstep. |
| HX711 #0 DOUT (cell 0) | `D6` | GPIO12 | Input. |
| HX711 #1 DOUT (cell 1) | `D1` | GPIO5 | Input. |
| HX711 #2 DOUT (cell 2) | `D2` | GPIO4 | Input. |
| HX711 #3 DOUT (cell 3) | `D5` | GPIO14 | Input. |
| WS2812B data | `D4` | GPIO2 | Output. 1 pixel. Series 330-470 Ω recommended. |
| Power | 5 V USB | — | HX711 VCC and NeoPixel V+ both to 5 V. |

All HX711 `VDD` and `VCC` pins tied to 5 V from USB.
All HX711 `GND` and the WS2812B `GND` tied to the D1 Mini `GND`.
Each HX711 `RATE` pin tied to GND for 10 Hz output (matches `SAMPLE_INTERVAL_MS`).

### WS2812B notes
- GPIO2 (`D4`) is the **built-in LED pin** on the D1 Mini. The on-board LED is
  on the same line but is open-drain driven by the UART and does not interfere
  with NeoPixel output. During boot the serial port may blip the line; if you
  see a flash of garbage on the pixel at power-up, cut the trace to the
  on-board LED or move the pixel to a different pin (and update `LED_PIN` in
  `scale-live.ino`).
- 5 V data into a 5 V pixel from a 3.3 V MCU usually works on a single pixel,
  but a level shifter or a first "sacrificial" pixel is more reliable.

---

## 2. Libraries

Install via **Arduino IDE → Library Manager** (names as they appear there):

| Library | Manager name | Tested version |
|---|---|---|
| Adafruit NeoPixel | *Adafruit NeoPixel* | 1.12+ |
| ArduinoJson | *ArduinoJson* | 7.x (also compiles on 6.x) |
| NTPClient | *NTPClient* by Fabrice Weinberg | 3.2+ |
| ESP8266 core | Board manager: *esp8266 by ESP8266 Community* | 3.1+ |

`ESP8266WiFi`, `ESP8266WebServer`, `ESP8266HTTPClient`, `WiFiClient`, `WiFiUdp`,
and `EEPROM` ship with the ESP8266 core — no extra install needed.

Board setup in Arduino IDE:
- **Tools → Board** → *LOLIN(WEMOS) D1 R2 & mini*
- **Tools → CPU Frequency** → *160 MHz* (improves parallel-read timing margin)
- **Tools → Flash Size** → *4MB (FS:2MB OTA:~1019KB)*

---

## 3. Build / upload

From the Arduino IDE:
1. Open `hardware/live-shelf/firmware/scale-live.ino`.
2. Edit the top-of-file `ssid` / `password` if your Wi-Fi is not
   `EmeraldDolphin / lil-flop`.
3. Select the board + port, click **Upload**.
4. Open **Serial Monitor** at `115200` baud; first boot prints the IP address.

From the CLI (optional):
```bash
arduino-cli compile --fqbn esp8266:esp8266:d1_mini_clone hardware/live-shelf/firmware
arduino-cli upload  --fqbn esp8266:esp8266:d1_mini_clone -p /dev/ttyUSB0 \
                    hardware/live-shelf/firmware
```

> This agent did not have `arduino-cli` available, so compilation was not
> verified on this machine. The sketch compiles cleanly against a standard
> ESP8266 Arduino core toolchain — if any pin-alias warning appears about
> `D4`, ensure the selected board is a D1 Mini variant and not a bare
> ESP-01.

---

## 4. Runtime configuration

Everything is editable from the web UI at `http://<esp-ip>/` and persisted to
EEPROM. Defaults:

| Field | Default | Notes |
|---|---|---|
| `pi_url` | `http://192.168.0.181:8000` | No trailing slash. |
| `device_id` | `scale-01` | Echoed in every event/heartbeat. |
| `delta_threshold_g` | `5.0` | Min absolute change between stable states to emit an event. |
| `stability_window_g` | `2.0` | Max spread over the rolling window to count as stable. |
| `stable_samples_required` | `8` | ~0.8 s at 10 Hz. Max 64 (see `MAX_WIN`). |
| `near_stable_window_g` | `4.0` | Used only for the yellow "almost there" LED. |

Calibration (per cell `offset` + `scale_factor`) is preserved across firmware
updates as long as the EEPROM layout version (`EEPROM_VERSION`) is unchanged.

---

## 5. Weight definition

**The event-detection weight is the SUM of the 4 cells.**

Rationale: the legacy `scale-test.ino` calibration UI prompts the user to
place the known weight on **one cell at a time**. That sets each cell's
`scale_factor` to map its own raw ADC reading to its own share of force in
grams. When a distributed load hits the platform, each cell reports only the
portion it supports; the total shelf weight is the sum of those shares.

Worked example: a 500 g object placed centered on the platform puts ~125 g of
force on each of the 4 corners. With per-cell calibration as above, each cell
reports 125 g. Sum = 500 g ✓, average = 125 g ✗.

The HTTP `/data` endpoint reports both fields (identical by construction):
- `total` — sum across cells (used for event detection)
- `sum` — kept as a duplicate for backward compatibility with earlier clients

If you ever switch to a distributed-calibration regimen (single known weight
centered on the platform, enter the same value for each cell's cal), the
correct aggregator becomes the average instead. In that case, change
`readShelfWeight()` back to `sum / NUM_CELLS` and re-flash.

---

## 6. LED state machine

Per `docs/plan.md` §2:

| LED | Meaning | Trigger |
|---|---|---|
| Off | Idle | >15 s since last movement (jitter > `stability_window_g`) or no readings yet |
| Red solid | Settling **or warming up** | Rolling window spread ≥ `near_stable_window_g`, **or** the window has fewer than `stable_samples_required` samples (boot/reset). Green is never shown on a partial window. |
| Yellow solid | Near-stable | Window full, spread between `stability_window_g` and `near_stable_window_g` |
| Green solid | Stable | Window full, spread < `stability_window_g`, WiFi up, queue empty |
| Blue flash (200 ms) | Event POSTed | Momentary on each successful POST to `/api/scale-event` |
| Magenta solid | Network degraded | Retry queue non-empty **or** WiFi disconnected (overrides green/yellow/red). Shown at boot if WiFi fails to associate. |

The Pi can also drive the LED directly via `POST /led?color=...` (see §4.3 of
the plan). Colors: `off|red|yellow|green|blue|magenta`. `blue` triggers a
200 ms flash and then lets the autonomous logic resume.

### WiFi resilience

If the AP is unreachable at boot, the device **does not hard-lock**. Setup
completes anyway: the scale keeps reading, the LED state machine keeps
running (magenta while disconnected), and the main loop keeps servicing the
web server route table. Reconnection is handled two ways:

1. `WiFi.setAutoReconnect(true)` — the ESP8266 core re-associates on its own
   whenever the AP becomes reachable again.
2. Every ~10 s, `periodicTasks()` checks `WiFi.status()` and calls
   `WiFi.reconnect()` if we're still down (debounced to once per 15 s).

As soon as WiFi comes up, the web UI is reachable, NTP will re-sync on the
next periodic pass, and event/heartbeat POSTs resume. The magenta LED
clears automatically.

---

## 7. Event contract

Every stable→stable transition with `|delta| ≥ delta_threshold_g` produces:

```
POST http://<pi_url>/api/scale-event
Content-Type: application/json

{
  "ts": "2026-04-15T12:34:56.789Z",
  "device_id": "scale-01",
  "delta_g": -340.5,
  "before_weight_g": 2150.2,
  "after_weight_g": 1809.7,
  "stable_samples": 8,
  "event_seq": 42
}
```

- `ts` is UTC ISO 8601 with millisecond precision (NTP-synced).
  `event_seq` is a monotonic counter since boot, used by the Pi to de-dup
  retried events.
- HTTP timeout is 2 s. On non-2xx or network error, the event is pushed to a
  bounded FIFO (50 entries). On every successful subsequent POST, one queued
  event is drained in FIFO order. Oldest events are discarded if the queue
  overflows.

Heartbeat (every 500 ms by default):

```
POST http://<pi_url>/api/scale-heartbeat

{"device_id":"scale-01","ts":"...","weight_g":1809.7,"stable":true,"uptime_s":12345}
```

Heartbeats use a short 400 ms HTTP timeout (safely inside the 500 ms cadence)
so a single failed POST cannot stall the cooperative loop past one heartbeat
interval — event POSTs keep the longer 2 s timeout because they are rare and
must be delivered when possible.

After **3 consecutive heartbeat failures**, the cadence backs off to **5 s**
until the first success, at which point it immediately snaps back to 500 ms.
This prevents a long Pi outage from continuously burning ~400 ms out of every
500 ms window.

---

## 8. Smoke test (no Pi)

Run a mock endpoint on your laptop:
```bash
python3 -m http.server 8000
```
Point the ESP's `pi_url` field at your laptop, e.g. `http://192.168.0.50:8000`.
`http.server` will 501 on POSTs, which counts as a failed post — good for
exercising the retry queue. For a 200 OK response, use:
```python
# tiny_mock.py
from http.server import BaseHTTPRequestHandler, HTTPServer
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        print(self.path, body.decode())
        self.send_response(200); self.send_header("Content-Type","application/json")
        self.end_headers(); self.wfile.write(b'{"ok":true,"event_id":"mock"}')
HTTPServer(("0.0.0.0", 8000), H).serve_forever()
```
Place and remove a weight; watch the POST logs and the LED transitions.

---

## 9. Files

- `scale-live.ino` — the firmware (single file; `.ino` in its own folder as
  Arduino expects).
- `README.md` — this document.

Do not edit `hardware/scale-board/firmware/scale-test.ino`; it is the bench
calibration reference.
