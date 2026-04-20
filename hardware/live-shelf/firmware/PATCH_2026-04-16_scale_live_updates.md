# ESP Firmware Updates — scale-live.ino

**Date:** 2026-04-16
**Target:** `firmware/scale-live.ino` on `live-shelf-scale` (192.168.0.197)
**Flash path:** Arduino IDE → Port: `live-shelf-scale at 192.168.0.197` → OTA password: `shelf-ota`

## What these fixes do

1. **EEPROM overflow guard** (`static_assert`): the current `CalStorage` is ~149 bytes in a 512-byte region. If a future field addition pushes it past 512, `EEPROM.put()` silently corrupts adjacent flash. `static_assert` catches this at compile time instead of at runtime after corruption.

2. **NTP-aligned sub-second timestamps** (`isoTimestampMs`): currently `msPart = millis() % 1000UL` uses the ESP uptime modulo, which has no phase relationship to the NTP second boundary. Means `ts.mmm` can be off by up to 999ms from true wall-clock milliseconds. Pi side uses `pi_received_ts` for session correlation so this is not currently correctness-critical — but it makes ESP `ts` unreliable for sub-second ordering. Fix: record `millis()` at NTP sync, then compute `msPart = (millis() - millisAtSync) % 1000` so the modulo is phase-locked to the NTP epoch.

3. **eventSeq persistence: NOT applied** per Jeremy's decision. The known limitation (dedup LRU can reject first post-reboot event with seq=0 if a heartbeat hasn't purged the LRU yet) is accepted as acceptable for this demo.

---

## Patch 1 — static_assert on CalStorage size

### Location
After the `struct CalStorage { ... };` block ending around **line 81**.

### Find
```cpp
struct CalStorage {
  uint32_t magic;
  uint32_t version;
  CellCal cells[NUM_CELLS];
  RuntimeCfg cfg;
};

const float DEFAULT_SCALE_FACTOR = 415.0;
```

### Replace with
```cpp
struct CalStorage {
  uint32_t magic;
  uint32_t version;
  CellCal cells[NUM_CELLS];
  RuntimeCfg cfg;
};

// Compile-time guard: EEPROM.put(0, data) writes sizeof(CalStorage)
// bytes starting at offset 0. If a future field addition makes the
// struct exceed EEPROM_SIZE we'd silently corrupt adjacent flash and
// see undetectable bad state on the next load. Catch it at compile
// time instead. Reserve a few bytes of headroom for a future footer
// / checksum without reshuffling the whole layout.
static_assert(sizeof(CalStorage) <= EEPROM_SIZE - 8,
              "CalStorage exceeds EEPROM allocation; bump EEPROM_SIZE "
              "or slim down CalStorage");

const float DEFAULT_SCALE_FACTOR = 415.0;
```

---

## Patch 2 — NTP-aligned sub-second component in `isoTimestampMs`

### Location
**Two edits**: add a new global near the other NTP state (around **line 162** where `ntpEverSynced` is declared), and rewrite `isoTimestampMs` (around **line 387**). Also update the two NTP-sync sites (**line 1017** and **line 1147**) to record the alignment epoch.

### 2a — Add alignment globals

**Find (around line 162):**
```cpp
bool ntpEverSynced = false;
```

**Replace with:**
```cpp
bool ntpEverSynced = false;

// Millisecond alignment anchor for isoTimestampMs. When NTP syncs we
// record millis() at sync time; sub-second components are then computed
// as (millis() - ntpMillisAtSync) % 1000, which is phase-locked to the
// NTP epoch boundary. Without this, `msPart = millis() % 1000` is off
// from true wall-clock ms by an arbitrary (but constant-per-boot)
// phase offset.
unsigned long ntpMillisAtSync = 0;
```

### 2b — Record millis() at NTP sync (two sites)

**Find (line ~1017, inside the resync branch):**
```cpp
      if (timeClient.update()) {
        ntpEverSynced = true;
        ntpLastSuccessMs = now;
      }
```

**Replace with:**
```cpp
      if (timeClient.update()) {
        ntpEverSynced = true;
        ntpLastSuccessMs = now;
        ntpMillisAtSync = now;  // re-anchor so msPart stays phase-locked
      }
```

**Find (line ~1147, inside the initial `forceUpdate` branch):**
```cpp
    if (timeClient.forceUpdate()) {
      ntpEverSynced = true;
      ntpLastSuccessMs = millis();
      Serial.printf("NTP synced: epoch=%lu\n", (unsigned long)timeClient.getEpochTime());
    }
```

**Replace with:**
```cpp
    if (timeClient.forceUpdate()) {
      ntpEverSynced = true;
      unsigned long _tsync = millis();
      ntpLastSuccessMs = _tsync;
      ntpMillisAtSync = _tsync;  // anchor for isoTimestampMs sub-second
      Serial.printf("NTP synced: epoch=%lu\n", (unsigned long)timeClient.getEpochTime());
    }
```

### 2c — Rewrite `isoTimestampMs` to use the anchor

**Find (line ~387):**
```cpp
void isoTimestampMs(char* out, size_t outSize) {
  // Produces "YYYY-MM-DDTHH:MM:SS.mmmZ"
  unsigned long epochSec;
  unsigned long msPart;
  if (ntpEverSynced) {
    epochSec = timeClient.getEpochTime();
    // getEpochTime() returns seconds; for ms we take millis() fractional component
    // since the lib doesn't provide sub-second resolution directly.
    msPart = millis() % 1000UL;
  } else {
    // Fallback: use 1970-based uptime
    epochSec = millis() / 1000UL;
    msPart   = millis() % 1000UL;
  }
  time_t t = (time_t)epochSec;
  struct tm* g = gmtime(&t);
  if (g == nullptr) {
    snprintf(out, outSize, "1970-01-01T00:00:00.000Z");
    return;
  }
  snprintf(out, outSize, "%04d-%02d-%02dT%02d:%02d:%02d.%03luZ",
           g->tm_year + 1900, g->tm_mon + 1, g->tm_mday,
           g->tm_hour, g->tm_min, g->tm_sec, msPart);
}
```

**Replace with:**
```cpp
void isoTimestampMs(char* out, size_t outSize) {
  // Produces "YYYY-MM-DDTHH:MM:SS.mmmZ".
  //
  // When NTP is synced, the sub-second component is anchored to the
  // NTP second boundary via ntpMillisAtSync (see NTP sync sites). This
  // means two events emitted 250ms apart actually show a ~250ms delta
  // in their ts strings, instead of the ~250ms delta +/- some arbitrary
  // phase offset that (millis() % 1000) produces.
  unsigned long epochSec;
  unsigned long msPart;
  unsigned long nowMs = millis();
  if (ntpEverSynced) {
    epochSec = timeClient.getEpochTime();
    // Phase-locked fractional second. Subtracting the sync anchor
    // handles 32-bit millis() wraparound correctly (unsigned arithmetic
    // wraps cleanly).
    msPart = (nowMs - ntpMillisAtSync) % 1000UL;
  } else {
    // Pre-NTP fallback: 1970-based uptime. Pi side rejects year<2024.
    epochSec = nowMs / 1000UL;
    msPart   = nowMs % 1000UL;
  }
  time_t t = (time_t)epochSec;
  struct tm* g = gmtime(&t);
  if (g == nullptr) {
    snprintf(out, outSize, "1970-01-01T00:00:00.000Z");
    return;
  }
  snprintf(out, outSize, "%04d-%02d-%02dT%02d:%02d:%02d.%03luZ",
           g->tm_year + 1900, g->tm_mon + 1, g->tm_mday,
           g->tm_hour, g->tm_min, g->tm_sec, msPart);
}
```

---

## Flashing instructions

1. Open Arduino IDE with `firmware/scale-live.ino` loaded.
2. Apply all three patches above.
3. Verify the sketch compiles without warnings (static_assert catches struct-size regressions at this stage).
4. Select **Tools → Port → `live-shelf-scale at 192.168.0.197`** (OTA). Password: `shelf-ota`.
5. Upload. The ESP reboots automatically after flash.
6. Verify:
   - `curl http://192.168.0.197/config` returns valid JSON (EEPROM still readable = no corruption).
   - After WiFi + NTP are up, post-NTP event timestamps should have accurate millisecond components (the Pi's `ts` column values will show proper sub-second spacing between back-to-back events).

If OTA fails (rare): fall back to USB. Connect the Wemos D1 Mini via USB-C, select the CH340 serial port, upload normally.

## Post-flash verification (Pi side)

```bash
# Confirm ESP is still talking
curl -s http://192.168.0.197/config | python3 -m json.tool

# Confirm events still flow
curl -s http://192.168.0.181:8000/api/state | python3 -m json.tool
```

No migration or Pi-side restart is required for these firmware changes.
