// ============================================================================
// scale-single-item.ino — Single-item tracker scale firmware
//
// A generic one-HX711 scale dedicated to tracking ONE paired product over
// time (LiquidTrack-style: milk carton, protein tub, etc.). The Pi pairs a
// device_id to a product at runtime via the /inventory UI. NO camera is
// associated with these scales — the server skips the classifier entirely
// and applies weight deltas directly against the paired lot.
//
// Firmware-side behavior is identical to scale-catch-all.ino: stability
// state machine → POST delta events to the Pi. All lot math, refill
// detection, and consumption logging live on the server. The ESP just
// reports "weight settled at W grams".
//
// Differences from scale-catch-all.ino:
//   - DEFAULT_DEVICE_ID: "scale-02" → "scale-03"    (starting point; each
//       flashed board should be renamed via the onboard web UI so the Pi
//       can pair it to a distinct product)
//   - EEPROM_MAGIC:     0xBEEF0006UL → 0xBEEF0007UL (keeps a cross-flashed
//       catch-all RuntimeCfg from bleeding in; forces clean re-init)
//
// If the scale has no WS2812B wired, D4 writes are harmless (floating
// data pin). Keep the LED code so adding one later is a drop-in.
//
// Wemos D1 Mini + 1x HX711 (shared SCK on D7, DOUT on D6)
// + optional WS2812B RGB LED on D4 (GPIO2)
//
// Extends scale-test.ino with:
//  - WS2812B LED state machine (off/red/yellow/green/blue-flash/magenta)
//  - Stability state machine (SETTLING / STABLE) with EEPROM-persisted params
//  - Event emission to Pi (POST /api/scale-event)
//  - Heartbeat every 5s (POST /api/scale-heartbeat)
//  - NTP sync (resync every 6h)
//  - Bounded FIFO retry queue (50 events) with magenta LED when non-empty
//  - Existing calibration web UI retained + new config fields
//
// Weight definition: only one cell, so `sumOfAllCells()` returns that
// cell's reading directly. Calibration prompts for a known weight and
// maps raw → grams for the single HX711.
//
// Libraries required (Arduino Library Manager names):
//   - Adafruit NeoPixel
//   - ArduinoJson
//   - NTPClient
//   - ESP8266 core (WiFi, HTTPClient, EEPROM, WebServer — built in)
// ============================================================================

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiUdp.h>
#include <ESP8266mDNS.h>
#include <ArduinoOTA.h>
#include <EEPROM.h>
#include <Adafruit_NeoPixel.h>
#include <ArduinoJson.h>
#include <NTPClient.h>
#include <time.h>

// ---------- Wi-Fi ----------
const char* ssid = "EmeraldDolphin";
const char* password = "lil-flop";

// ---------- Pins ----------
#define NUM_CELLS 1
const int SCK_PIN = D7;
const int DOUT_PINS[NUM_CELLS] = { D6 };
const int LED_PIN = D4;          // WS2812B data
const int LED_COUNT = 1;

// ---------- EEPROM layout ----------
// Bumped version because we append a RuntimeCfg block at offset after calibration.
//
// IMPORTANT — MAGIC differs from BOTH scale-live.ino (0xBEEF0005UL,
// NUM_CELLS=4) and scale-catch-all.ino (0xBEEF0006UL, same struct shape
// but different role). Even though this firmware's CalStorage byte
// layout is identical to scale-catch-all's, keeping a distinct magic
// means a Wemos cross-flashed between the two roles will fail the
// magic check and re-initialize with the new DEFAULT_DEVICE_ID rather
// than silently keeping the previous role's device_id. EEPROM_VERSION
// stays at 3 — layout semantics within this firmware are unchanged.
#define EEPROM_SIZE 512
#define EEPROM_MAGIC 0xBEEF0007UL
#define EEPROM_VERSION 3

struct CellCal {
  long offset;
  float scale_factor;
};

struct RuntimeCfg {
  // Pi URL (base, no trailing slash), e.g. "http://192.168.0.181:8000"
  char pi_url[64];
  // Device id sent in payloads (default "scale-03" on single-item scales;
  // each flashed board is expected to be renamed per-unit via the web UI
  // so the Pi can pair it to a distinct product).
  char device_id[24];
  float stability_window_g;
  uint16_t stable_samples_required;
  float near_stable_window_g;
  float delta_threshold_g;
  uint32_t reserved;
};

struct CalStorage {
  uint32_t magic;
  uint32_t version;
  CellCal cells[NUM_CELLS];
  RuntimeCfg cfg;
};

const float DEFAULT_SCALE_FACTOR = 415.0;
const char*   DEFAULT_PI_URL     = "http://192.168.0.181:8000";
const char*   DEFAULT_DEVICE_ID  = "scale-03";
const float   DEFAULT_STAB_WIN   = 2.0f;
const uint16_t DEFAULT_STAB_N    = 8;
const float   DEFAULT_NEAR_WIN   = 4.0f;
const float   DEFAULT_DELTA_THR  = 5.0f;

// ---------- Globals ----------
CellCal cells[NUM_CELLS];
RuntimeCfg cfg;

ESP8266WebServer server(80);
Adafruit_NeoPixel pixel(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

WiFiUDP ntpUDP;
// offset=0 (UTC), update interval handled manually; pass 60s to keep lib happy.
NTPClient timeClient(ntpUDP, "pool.ntp.org", 0, 60 * 1000UL);

const int statusLedPin = LED_BUILTIN;

// ---------- LED state ----------
enum LedState {
  LED_OFF,
  LED_RED,
  LED_YELLOW,
  LED_GREEN,
  LED_BLUE_FLASH,
  LED_MAGENTA
};

LedState currentLed = LED_OFF;
unsigned long blueFlashStart = 0;
const unsigned long BLUE_FLASH_MS = 200;
unsigned long lastMovementMs = 0;
const unsigned long IDLE_TIMEOUT_MS = 15000;  // §2: >15s idle → off

// ---------- Stability state machine ----------
enum StabState { SETTLING, STABLE };
StabState stabState = SETTLING;

// Rolling window of recent readings (averaged across 4 cells).
// Sized to the max possible stable_samples_required we'll accept.
#define MAX_WIN 64
float windowBuf[MAX_WIN];
int   windowLen = 0;
int   windowHead = 0;

float lastStableWeight = 0.0f;
bool  hasLastStable = false;
uint16_t currentStableSamples = 0;

// Moment (millis()) when the scale most recently transitioned from STABLE
// to SETTLING — i.e., when motion first started. Reported in the event
// payload so the Pi can anchor its "before" frame half a second before
// this moment instead of 3 s before the stability declaration (which may
// be AFTER the user already closed the fridge door).
unsigned long motionStartedMs = 0;
bool hasMotionStart = false;

// Sample cadence for the scale-reading loop. Must be declared at file scope
// BEFORE emitEvent() / scaleLoop() use it (~10 Hz / HX711 default rate).
unsigned long lastSampleMs = 0;
const unsigned long SAMPLE_INTERVAL_MS = 100;   // ~10 Hz

// ---------- Event emission ----------
uint32_t eventSeq = 0;
unsigned long lastHeartbeatMs = 0;
// Normal heartbeat cadence. When the Pi is unreachable we back off to
// HEARTBEAT_BACKOFF_MS after HEARTBEAT_FAIL_THRESHOLD consecutive failures,
// then reset on the first success. See periodicTasks().
const unsigned long HEARTBEAT_INTERVAL_MS = 500;
const unsigned long HEARTBEAT_BACKOFF_MS  = 5000;
const uint8_t       HEARTBEAT_FAIL_THRESHOLD = 3;
unsigned long currentHeartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
uint8_t heartbeatFailStreak = 0;
unsigned long lastNtpResyncMs = 0;
const unsigned long NTP_RESYNC_INTERVAL_MS = 6UL * 60UL * 60UL * 1000UL;  // 6h
unsigned long ntpLastSuccessMs = 0;
bool ntpEverSynced = false;

// ---------- WiFi reconnect tracking ----------
// Periodic health check runs every WIFI_CHECK_INTERVAL_MS; when disconnected,
// we call WiFi.reconnect() at most once per WIFI_RECONNECT_DEBOUNCE_MS so we
// don't hammer the ESP8266 stack during a long outage.
const unsigned long WIFI_CHECK_INTERVAL_MS      = 10000;
const unsigned long WIFI_RECONNECT_DEBOUNCE_MS  = 15000;
unsigned long lastWifiCheckMs = 0;
unsigned long lastWifiReconnectMs = 0;

// Bounded FIFO for failed posts.
#define QUEUE_CAPACITY 50
struct PendingEvent {
  char   ts[32];
  float  delta_g;
  float  before_weight_g;
  float  after_weight_g;
  uint16_t stable_samples;
  uint32_t event_seq;
  // Ms between when the scale first broke stability (motion started) and
  // this event POST being fired. The Pi uses it to compute the pre-motion
  // anchor for ring-buffer lookups: motion_start_ts = pi_received_ts -
  // motion_start_ms_before. Fallback to 0 if we never saw a STABLE state.
  uint32_t motion_start_ms_before;
  // Ms covered by the stability window (stable_samples_required *
  // sample_interval). Pi uses this to anchor the "after" frame right as
  // motion ended, before the stability delay elapsed.
  uint32_t stability_window_ms;
};
PendingEvent queueBuf[QUEUE_CAPACITY];
int queueHead = 0;
int queueTail = 0;
int queueSize = 0;

// ---------- Low-level parallel HX711 read ----------

bool allReady() {
  for (int i = 0; i < NUM_CELLS; i++) {
    if (digitalRead(DOUT_PINS[i]) == HIGH) return false;
  }
  return true;
}

bool waitAllReady(unsigned long timeout_ms) {
  unsigned long start = millis();
  while (!allReady()) {
    if (millis() - start > timeout_ms) return false;
    yield();
  }
  return true;
}

bool readRaw(long out[NUM_CELLS]) {
  if (!waitAllReady(200)) {
    for (int i = 0; i < NUM_CELLS; i++) out[i] = 0;
    return false;
  }

  long raw[NUM_CELLS] = { 0 };

  // Timing budget is ~100µs for 4 cells (25 clock pulses * ~2µs + loop
  // overhead, with NUM_CELLS digitalReads per bit). Adding more cells or
  // slower scale factors may push this over the ESP8266 WiFi stack's
  // tolerance for interrupts-off windows — reevaluate if cell count changes.
  // Keep this region free of Serial writes, yield(), or any library calls.
  noInterrupts();
  for (int b = 0; b < 24; b++) {
    digitalWrite(SCK_PIN, HIGH);
    delayMicroseconds(1);
    for (int i = 0; i < NUM_CELLS; i++) {
      raw[i] = (raw[i] << 1) | (digitalRead(DOUT_PINS[i]) & 1);
    }
    digitalWrite(SCK_PIN, LOW);
    delayMicroseconds(1);
  }
  // 25th pulse: channel A, gain 128
  digitalWrite(SCK_PIN, HIGH);
  delayMicroseconds(1);
  digitalWrite(SCK_PIN, LOW);
  delayMicroseconds(1);
  interrupts();

  for (int i = 0; i < NUM_CELLS; i++) {
    if (raw[i] & 0x800000UL) raw[i] |= 0xFF000000UL;
    out[i] = raw[i];
  }
  return true;
}

bool readAverage(long out[NUM_CELLS], int samples) {
  long acc[NUM_CELLS] = { 0 };
  int got = 0;
  for (int s = 0; s < samples; s++) {
    long r[NUM_CELLS];
    if (!readRaw(r)) continue;
    for (int i = 0; i < NUM_CELLS; i++) acc[i] += r[i];
    got++;
    yield();
  }
  if (got == 0) {
    for (int i = 0; i < NUM_CELLS; i++) out[i] = 0;
    return false;
  }
  for (int i = 0; i < NUM_CELLS; i++) out[i] = acc[i] / got;
  return true;
}

float rawToGrams(int i, long raw) {
  if (cells[i].scale_factor == 0) return 0;
  return (float)(raw - cells[i].offset) / cells[i].scale_factor;
}

// Returns the total shelf weight used for event detection.
// Uses SUM of cells (not average): the legacy per-cell calibration UI
// prompts the user to place the known weight on ONE cell at a time,
// which sets each cell's scale_factor to translate its own raw reading
// into its own share of force in grams. Distributed load → each cell
// reports its share → sum = true total. See README.md §"Weight definition".
bool readShelfWeight(float* out_weight) {
  long raw[NUM_CELLS];
  if (!readRaw(raw)) return false;
  float sum = 0;
  for (int i = 0; i < NUM_CELLS; i++) sum += rawToGrams(i, raw[i]);
  *out_weight = sum;
  return true;
}

// ---------- EEPROM persistence ----------

void setDefaultRuntimeCfg(RuntimeCfg& c) {
  strncpy(c.pi_url,    DEFAULT_PI_URL,    sizeof(c.pi_url) - 1);
  c.pi_url[sizeof(c.pi_url) - 1] = 0;
  strncpy(c.device_id, DEFAULT_DEVICE_ID, sizeof(c.device_id) - 1);
  c.device_id[sizeof(c.device_id) - 1] = 0;
  c.stability_window_g      = DEFAULT_STAB_WIN;
  c.stable_samples_required = DEFAULT_STAB_N;
  c.near_stable_window_g    = DEFAULT_NEAR_WIN;
  c.delta_threshold_g       = DEFAULT_DELTA_THR;
  c.reserved                = 0;
}

void saveAll() {
  CalStorage data;
  data.magic   = EEPROM_MAGIC;
  data.version = EEPROM_VERSION;
  for (int i = 0; i < NUM_CELLS; i++) data.cells[i] = cells[i];
  data.cfg = cfg;
  EEPROM.put(0, data);
  EEPROM.commit();
  Serial.println("EEPROM saved");
}

bool loadAll() {
  CalStorage data;
  EEPROM.get(0, data);
  if (data.magic != EEPROM_MAGIC || data.version != EEPROM_VERSION) return false;
  for (int i = 0; i < NUM_CELLS; i++) {
    if (isnan(data.cells[i].scale_factor)) return false;
    cells[i] = data.cells[i];
  }
  cfg = data.cfg;
  // Sanity on config fields
  if (cfg.pi_url[0] == 0) strncpy(cfg.pi_url, DEFAULT_PI_URL, sizeof(cfg.pi_url) - 1);
  if (cfg.device_id[0] == 0) strncpy(cfg.device_id, DEFAULT_DEVICE_ID, sizeof(cfg.device_id) - 1);
  if (!(cfg.stability_window_g > 0))      cfg.stability_window_g = DEFAULT_STAB_WIN;
  if (cfg.stable_samples_required == 0 || cfg.stable_samples_required > MAX_WIN)
    cfg.stable_samples_required = DEFAULT_STAB_N;
  if (!(cfg.near_stable_window_g > 0))    cfg.near_stable_window_g = DEFAULT_NEAR_WIN;
  if (!(cfg.delta_threshold_g > 0))       cfg.delta_threshold_g = DEFAULT_DELTA_THR;
  return true;
}

void setDefaultCalibration() {
  long raw[NUM_CELLS];
  readAverage(raw, 10);
  for (int i = 0; i < NUM_CELLS; i++) {
    cells[i].offset = raw[i];
    cells[i].scale_factor = DEFAULT_SCALE_FACTOR;
  }
}

// ---------- LED control ----------

void ledApply(LedState s) {
  switch (s) {
    case LED_OFF:         pixel.setPixelColor(0, pixel.Color(0, 0, 0));       break;
    case LED_RED:         pixel.setPixelColor(0, pixel.Color(64, 0, 0));      break;
    case LED_YELLOW:      pixel.setPixelColor(0, pixel.Color(48, 40, 0));     break;
    case LED_GREEN:       pixel.setPixelColor(0, pixel.Color(0, 64, 0));      break;
    case LED_BLUE_FLASH:  pixel.setPixelColor(0, pixel.Color(0, 0, 96));      break;
    case LED_MAGENTA:     pixel.setPixelColor(0, pixel.Color(64, 0, 48));     break;
  }
  pixel.show();
  currentLed = s;
}

void triggerBlueFlash() {
  blueFlashStart = millis();
  ledApply(LED_BLUE_FLASH);
}

// Resolve desired steady-state LED based on stability + queue + idle.
// Blue flash and magenta override the steady state inside ledTick().
//
// `windowFull` means the rolling window has >= stable_samples_required
// samples. Until then we hold RED ("warming up") so the operator isn't
// misled into thinking the shelf is stable after a handful of samples.
// If WiFi is down we show MAGENTA (same color as queue-non-empty, since
// both mean "the Pi isn't getting events right now").
LedState desiredSteadyLed(float winMax, float winMin, bool windowFull) {
  unsigned long now = millis();
  if (WiFi.status() != WL_CONNECTED)            return LED_MAGENTA;
  if (queueSize > 0)                            return LED_MAGENTA;
  if (windowLen == 0)                           return LED_OFF;
  if (!windowFull)                              return LED_RED;   // warming up
  if (now - lastMovementMs > IDLE_TIMEOUT_MS)   return LED_OFF;
  float spread = winMax - winMin;
  if (spread < cfg.stability_window_g)          return LED_GREEN;
  if (spread < cfg.near_stable_window_g)        return LED_YELLOW;
  return LED_RED;
}

// ---------- Timestamps ----------

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

// ---------- Retry queue ----------

bool queuePush(const PendingEvent& e) {
  if (queueSize >= QUEUE_CAPACITY) return false;
  queueBuf[queueTail] = e;
  queueTail = (queueTail + 1) % QUEUE_CAPACITY;
  queueSize++;
  return true;
}

bool queuePeek(PendingEvent& out) {
  if (queueSize == 0) return false;
  out = queueBuf[queueHead];
  return true;
}

void queuePop() {
  if (queueSize == 0) return;
  queueHead = (queueHead + 1) % QUEUE_CAPACITY;
  queueSize--;
}

// ---------- HTTP POST helpers ----------

// Returns true on 2xx. `body` must be fully formed JSON.
// Used for event POSTs which can tolerate longer timeouts.
bool httpPost(const String& path, const String& body, int timeoutMs) {
  if (cfg.pi_url[0] == 0) return false;
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClient client;
  HTTPClient http;
  String url = String(cfg.pi_url) + path;
  http.setTimeout(timeoutMs);
  http.setReuse(false);
  if (!http.begin(client, url)) return false;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  http.end();
  return (code >= 200 && code < 300);
}

// Fast-fail variant for heartbeats. Uses a 400ms timeout so a failed POST
// cannot starve the cooperative loop past the 500ms heartbeat interval.
// Events still use the longer-timeout httpPost() because they are rare and
// must be delivered when possible.
bool httpPostFastFail(const String& path, const String& body) {
  if (cfg.pi_url[0] == 0) return false;
  if (WiFi.status() != WL_CONNECTED) return false;
  WiFiClient client;
  HTTPClient http;
  String url = String(cfg.pi_url) + path;
  http.setTimeout(400);
  http.setReuse(false);
  if (!http.begin(client, url)) return false;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  http.end();
  return (code >= 200 && code < 300);
}

String buildEventJson(const PendingEvent& e) {
  StaticJsonDocument<512> doc;
  doc["ts"]                      = e.ts;
  doc["device_id"]               = cfg.device_id;
  doc["delta_g"]                 = e.delta_g;
  doc["before_weight_g"]         = e.before_weight_g;
  doc["after_weight_g"]          = e.after_weight_g;
  doc["stable_samples"]          = e.stable_samples;
  doc["event_seq"]               = e.event_seq;
  doc["motion_start_ms_before"]  = e.motion_start_ms_before;
  doc["stability_window_ms"]     = e.stability_window_ms;
  String out;
  serializeJson(doc, out);
  return out;
}

// Attempt to post one queued event. Returns true if queue drained one.
bool drainOne() {
  PendingEvent e;
  if (!queuePeek(e)) return false;
  String body = buildEventJson(e);
  if (httpPost("/api/scale-event", body, 2000)) {
    queuePop();
    return true;
  }
  return false;
}

// Post a fresh event. Falls back to queue on failure.
void emitEvent(float before, float after, float delta, uint16_t samples) {
  eventSeq++;
  PendingEvent e;
  isoTimestampMs(e.ts, sizeof(e.ts));
  e.delta_g         = delta;
  e.before_weight_g = before;
  e.after_weight_g  = after;
  e.stable_samples  = samples;
  e.event_seq       = eventSeq;
  // Motion timing metadata for Pi frame-extraction anchors.
  // Unsigned modular arithmetic handles the ~49.7-day millis() rollover
  // correctly on its own — (now - motionStartedMs) gives the right delta
  // even when now has wrapped past motionStartedMs. We intentionally do
  // NOT compare now >= motionStartedMs; that check would fail across
  // a rollover boundary and emit 0 instead of the true elapsed ms.
  unsigned long now = millis();
  e.motion_start_ms_before =
      hasMotionStart ? (uint32_t)(now - motionStartedMs) : 0;
  e.stability_window_ms =
      (uint32_t)cfg.stable_samples_required * (uint32_t)SAMPLE_INTERVAL_MS;

  String body = buildEventJson(e);
  bool ok = httpPost("/api/scale-event", body, 2000);
  if (ok) {
    triggerBlueFlash();
    // Opportunistically drain one queued event per successful post
    drainOne();
  } else {
    if (!queuePush(e)) {
      // Drop-oldest fallback. Safe only because the ESP8266 Arduino runtime
      // is cooperatively scheduled: nothing else can touch queueHead/queueTail
      // between these two calls. Do NOT insert yield() or delay() between
      // queuePop() and the subsequent queuePush(e) — they must remain atomic
      // under the cooperative scheduler (no ISR writes to the queue either).
      Serial.println("Event queue full — dropping oldest");
      queuePop();
      queuePush(e);
    }
    Serial.printf("Event POST failed, queued (queueSize=%d)\n", queueSize);
  }
}

bool sendHeartbeat(float weight, bool stable) {
  StaticJsonDocument<256> doc;
  char ts[32];
  isoTimestampMs(ts, sizeof(ts));
  doc["device_id"] = cfg.device_id;
  doc["ts"]        = ts;
  doc["weight_g"]  = weight;
  doc["stable"]    = stable;
  doc["uptime_s"]  = (uint32_t)(millis() / 1000UL);
  String body;
  serializeJson(doc, body);
  return httpPostFastFail("/api/scale-heartbeat", body);
}

// ---------- HTTP handlers (existing UI retained) ----------

void handleData() {
  long raw[NUM_CELLS];
  readRaw(raw);

  float sum = 0;
  String json = "{\"cells\":[";
  for (int i = 0; i < NUM_CELLS; i++) {
    float g = rawToGrams(i, raw[i]);
    sum += g;
    if (i > 0) json += ",";
    json += String(g, 2);
  }
  // total == sum of cells: each cell reports its own share of force,
  // summing gives the true load on the platform.
  json += "],\"total\":" + String(sum, 2);
  json += ",\"sum\":" + String(sum, 2);
  json += ",\"state\":\"" + String(stabState == STABLE ? "stable" : "settling") + "\"";
  json += ",\"queue\":" + String(queueSize);
  json += ",\"event_seq\":" + String(eventSeq);
  json += "}";
  server.send(200, "application/json", json);
}

void handleConfig() {
  StaticJsonDocument<512> doc;
  JsonArray cArr = doc.createNestedArray("cells");
  for (int i = 0; i < NUM_CELLS; i++) {
    JsonObject o = cArr.createNestedObject();
    o["scale_factor"] = cells[i].scale_factor;
    o["offset"]       = cells[i].offset;
  }
  JsonObject rc = doc.createNestedObject("runtime");
  rc["pi_url"]                   = cfg.pi_url;
  rc["device_id"]                = cfg.device_id;
  rc["stability_window_g"]       = cfg.stability_window_g;
  rc["stable_samples_required"]  = cfg.stable_samples_required;
  rc["near_stable_window_g"]     = cfg.near_stable_window_g;
  rc["delta_threshold_g"]        = cfg.delta_threshold_g;
  rc["ntp_synced"]               = ntpEverSynced;
  rc["queue_size"]               = queueSize;
  String out;
  serializeJson(doc, out);
  server.send(200, "application/json", out);
}

int parseCellArg(bool &all) {
  all = false;
  if (server.hasArg("all") && server.arg("all") == "1") { all = true; return -1; }
  if (!server.hasArg("cell")) return -1;
  int c = server.arg("cell").toInt();
  if (c < 0 || c >= NUM_CELLS) return -2;
  return c;
}

void handleTare() {
  bool all;
  int cell = parseCellArg(all);
  if (!all && cell < 0) {
    server.send(400, "application/json", "{\"ok\":false,\"err\":\"missing or invalid cell param (or use all=1)\"}");
    return;
  }
  long raw[NUM_CELLS];
  if (!readAverage(raw, 10)) {
    server.send(503, "application/json", "{\"ok\":false,\"err\":\"scale not ready\"}");
    return;
  }
  if (all) {
    for (int i = 0; i < NUM_CELLS; i++) cells[i].offset = raw[i];
  } else {
    cells[cell].offset = raw[cell];
  }
  saveAll();
  String json = "{\"ok\":true,\"scope\":\"" + String(all ? "all" : String(cell)) + "\"}";
  server.send(200, "application/json", json);
}

void handleCalibrate() {
  if (!server.hasArg("cell") || !server.hasArg("grams")) {
    server.send(400, "application/json", "{\"ok\":false,\"err\":\"need cell=N and grams=X\"}");
    return;
  }
  int cell = server.arg("cell").toInt();
  float known_grams = server.arg("grams").toFloat();
  if (cell < 0 || cell >= NUM_CELLS) {
    server.send(400, "application/json", "{\"ok\":false,\"err\":\"invalid cell index\"}");
    return;
  }
  if (!(known_grams > 0) || known_grams > 100000) {
    server.send(400, "application/json", "{\"ok\":false,\"err\":\"grams out of range\"}");
    return;
  }
  long raw[NUM_CELLS];
  if (!readAverage(raw, 10)) {
    server.send(503, "application/json", "{\"ok\":false,\"err\":\"scale not ready\"}");
    return;
  }
  long signal = raw[cell] - cells[cell].offset;
  if (signal == 0) {
    server.send(400, "application/json", "{\"ok\":false,\"err\":\"no signal on that cell — tare empty + load the weight?\"}");
    return;
  }
  float new_factor = (float)signal / known_grams;
  cells[cell].scale_factor = new_factor;
  saveAll();

  String json = "{\"ok\":true,\"cell\":" + String(cell);
  json += ",\"scale_factor\":" + String(new_factor, 4);
  json += ",\"signal\":" + String(signal);
  json += ",\"grams\":" + String(known_grams, 2) + "}";
  server.send(200, "application/json", json);
}

// POST /settings  (form-encoded or query params)
// Fields: pi_url, device_id, stability_window_g, stable_samples_required,
//         near_stable_window_g, delta_threshold_g
void handleSettings() {
  bool changed = false;
  if (server.hasArg("pi_url")) {
    String v = server.arg("pi_url"); v.trim();
    if (v.length() < sizeof(cfg.pi_url)) {
      v.toCharArray(cfg.pi_url, sizeof(cfg.pi_url)); changed = true;
    }
  }
  if (server.hasArg("device_id")) {
    String v = server.arg("device_id"); v.trim();
    if (v.length() > 0 && v.length() < sizeof(cfg.device_id)) {
      v.toCharArray(cfg.device_id, sizeof(cfg.device_id)); changed = true;
    }
  }
  if (server.hasArg("stability_window_g")) {
    float v = server.arg("stability_window_g").toFloat();
    if (v > 0 && v < 1000) { cfg.stability_window_g = v; changed = true; }
  }
  if (server.hasArg("stable_samples_required")) {
    int v = server.arg("stable_samples_required").toInt();
    if (v > 0 && v <= MAX_WIN) { cfg.stable_samples_required = (uint16_t)v; changed = true; }
  }
  if (server.hasArg("near_stable_window_g")) {
    float v = server.arg("near_stable_window_g").toFloat();
    if (v > 0 && v < 1000) { cfg.near_stable_window_g = v; changed = true; }
  }
  if (server.hasArg("delta_threshold_g")) {
    float v = server.arg("delta_threshold_g").toFloat();
    if (v > 0 && v < 100000) { cfg.delta_threshold_g = v; changed = true; }
  }
  if (changed) {
    // Reset stability window since params changed
    windowLen = 0;
    windowHead = 0;
    currentStableSamples = 0;
    saveAll();
  }
  String json = "{\"ok\":true,\"changed\":" + String(changed ? "true" : "false") + "}";
  server.send(200, "application/json", json);
}

// Optional Pi → ESP LED override per §4.3. Accepts JSON or query args:
//   color=off|red|yellow|green|blue|magenta
//   duration_ms=<int>  (only used for blue flash)
void handleLed() {
  String color;
  if (server.hasArg("color")) color = server.arg("color");
  else if (server.hasArg("plain")) {
    StaticJsonDocument<128> doc;
    if (deserializeJson(doc, server.arg("plain")) == DeserializationError::Ok) {
      color = String((const char*)(doc["color"] | ""));
    }
  }
  color.toLowerCase();
  if (color == "off")           ledApply(LED_OFF);
  else if (color == "red")      ledApply(LED_RED);
  else if (color == "yellow")   ledApply(LED_YELLOW);
  else if (color == "green")    ledApply(LED_GREEN);
  else if (color == "blue")     triggerBlueFlash();
  else if (color == "magenta")  ledApply(LED_MAGENTA);
  else {
    server.send(400, "application/json", "{\"ok\":false,\"err\":\"unknown color\"}");
    return;
  }
  server.send(200, "application/json", "{\"ok\":true}");
}

// ---------- Root UI ----------

void handleRoot() {
  String html;
  html.reserve(6500);
  html += "<!DOCTYPE html><html><head>";
  html += "<meta charset='UTF-8'><title>Live Shelf Scale</title>";
  html += "<meta name='viewport' content='width=device-width, initial-scale=1'>";
  html += "<style>";
  html += "*{box-sizing:border-box}";
  html += "body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0f1115;color:#e8e8e8;margin:0;min-height:100vh;padding:32px}";
  html += ".wrap{max-width:760px;margin:0 auto}";
  html += ".label{font-size:0.8em;color:#888;letter-spacing:3px;text-transform:uppercase;text-align:center}";
  html += ".total{font-size:6em;font-weight:700;color:#00e676;font-variant-numeric:tabular-nums;text-align:center;line-height:1;margin:16px 0;text-shadow:0 0 24px rgba(0,230,118,0.15)}";
  html += ".unit{font-size:0.3em;color:#666;margin-left:14px;font-weight:400}";
  html += ".grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:32px 0}";
  html += ".cell{background:#161922;border:1px solid #252a35;border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:6px}";
  html += ".cell .cname{color:#888;font-size:0.75em;letter-spacing:2px;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}";
  html += ".cell .cval{font-size:2.2em;font-weight:600;color:#e8e8e8;font-variant-numeric:tabular-nums}";
  html += ".cell .cmeta{font-size:0.7em;color:#555;margin-top:4px}";
  html += ".cell .actions{display:flex;gap:6px;margin-top:8px}";
  html += ".cell .actions button{flex:1;padding:8px 10px;font-size:0.7em}";
  html += ".stats{text-align:center;font-size:0.85em;color:#555;display:flex;gap:16px;justify-content:center;flex-wrap:wrap}";
  html += ".stats b{color:#999;font-weight:600}";
  html += ".controls{margin-top:24px;display:flex;gap:12px;flex-wrap:wrap;justify-content:center}";
  html += "button{padding:10px 18px;font-size:0.8em;background:#1a1d24;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:8px;cursor:pointer;font-family:inherit;letter-spacing:2px;text-transform:uppercase;transition:all 0.15s}";
  html += "button:hover{background:#242832;border-color:#3a4150}";
  html += "button.primary{background:#0a3d1f;border-color:#0f5c2e;color:#00e676}";
  html += "button.primary:hover{background:#0f5c2e;border-color:#15874a}";
  html += ".cfg{background:#161922;border:1px solid #252a35;border-radius:10px;padding:18px;margin-top:24px}";
  html += ".cfg h3{margin:0 0 12px 0;font-size:0.9em;letter-spacing:3px;text-transform:uppercase;color:#888}";
  html += ".cfg .row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}";
  html += ".cfg label{font-size:0.75em;color:#888;display:block;margin-bottom:4px;letter-spacing:1px;text-transform:uppercase}";
  html += ".cfg input{width:100%;padding:8px 10px;background:#0f1115;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:6px;font-family:inherit;font-size:0.9em}";
  html += ".err{color:#ff5252;font-size:0.85em;text-align:center;margin-top:16px;min-height:1.4em}";
  html += ".pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:0.7em;letter-spacing:1px;text-transform:uppercase}";
  html += ".pill.stable{background:#0a3d1f;color:#00e676}";
  html += ".pill.settling{background:#3d2a0a;color:#ffb74d}";
  html += "@media (max-width:500px){.total{font-size:4.2em}.grid{grid-template-columns:1fr}.cfg .row{grid-template-columns:1fr}}";
  html += "</style></head><body><div class='wrap'>";
  html += "<div class='label'>Shelf Weight (1-cell)</div>";
  html += "<div class='total'><span id='total'>--</span><span class='unit'>g</span></div>";
  html += "<div class='stats'>";
  html += "<div>state <span id='state' class='pill settling'>--</span></div>";
  html += "<div><b id='rate'>--</b> ms/poll</div>";
  html += "<div><b id='count'>0</b> samples</div>";
  html += "<div>queue <b id='queue'>0</b></div>";
  html += "<div>seq <b id='seq'>0</b></div>";
  html += "</div>";
  html += "<div class='grid' id='cells'></div>";
  html += "<div class='controls'>";
  html += "<button onclick='tareAll()'>Tare All (Zero)</button>";
  html += "</div>";
  html += "<div class='cfg'><h3>Runtime Config</h3>";
  html += "<div class='row'>";
  html += "<div><label>Pi URL</label><input id='cf_pi_url'></div>";
  html += "<div><label>Device ID</label><input id='cf_device_id'></div>";
  html += "</div><div class='row'>";
  html += "<div><label>Delta Threshold (g)</label><input id='cf_delta' type='number' step='0.1'></div>";
  html += "<div><label>Stability Window (g)</label><input id='cf_stab' type='number' step='0.1'></div>";
  html += "</div><div class='row'>";
  html += "<div><label>Stable Samples Required</label><input id='cf_samples' type='number' step='1'></div>";
  html += "<div><label>Near-Stable Window (g)</label><input id='cf_near' type='number' step='0.1'></div>";
  html += "</div>";
  html += "<div class='controls' style='margin-top:12px'><button class='primary' onclick='saveCfg()'>Save Config</button></div>";
  html += "</div>";
  html += "<div class='err' id='err'>&nbsp;</div>";
  html += "</div><script>";
  html += "const N=" + String(NUM_CELLS) + ";";
  html += "let count=0,cfg=null;";
  html += "function renderCells(){";
  html += " const el=document.getElementById('cells');el.innerHTML='';";
  html += " for(let i=0;i<N;i++){";
  html += "  const d=document.createElement('div');d.className='cell';";
  html += "  d.innerHTML=`<div class='cname'><span>Cell ${i}</span><span style='color:#555;font-size:0.85em'>D${['6','1','2','5'][i]}</span></div>`";
  html += "   +`<div class='cval' id='cv${i}'>--</div>`";
  html += "   +`<div class='cmeta'>factor: <span id='cf${i}'>--</span> &middot; offset: <span id='co${i}'>--</span></div>`";
  html += "   +`<div class='actions'><button onclick='tareCell(${i})'>Tare</button><button onclick='calCell(${i})'>Cal</button></div>`;";
  html += "  el.appendChild(d);";
  html += " }";
  html += "}";
  html += "async function loadConfig(){";
  html += " try{const r=await fetch('/config');cfg=await r.json();";
  html += "  for(let i=0;i<N;i++){";
  html += "   document.getElementById('cf'+i).textContent=cfg.cells[i].scale_factor.toFixed(4);";
  html += "   document.getElementById('co'+i).textContent=cfg.cells[i].offset;";
  html += "  }";
  html += "  const rc=cfg.runtime;";
  html += "  document.getElementById('cf_pi_url').value=rc.pi_url;";
  html += "  document.getElementById('cf_device_id').value=rc.device_id;";
  html += "  document.getElementById('cf_delta').value=rc.delta_threshold_g;";
  html += "  document.getElementById('cf_stab').value=rc.stability_window_g;";
  html += "  document.getElementById('cf_samples').value=rc.stable_samples_required;";
  html += "  document.getElementById('cf_near').value=rc.near_stable_window_g;";
  html += " }catch(e){}";
  html += "}";
  html += "async function tick(){";
  html += " try{const t0=performance.now();";
  html += "  const r=await fetch('/data',{cache:'no-store'});";
  html += "  const d=await r.json();";
  html += "  const rt=Math.round(performance.now()-t0);";
  html += "  document.getElementById('total').textContent=d.total.toFixed(1);";
  html += "  for(let i=0;i<N;i++)document.getElementById('cv'+i).textContent=d.cells[i].toFixed(1)+' g';";
  html += "  count++;";
  html += "  const st=document.getElementById('state');st.textContent=d.state;st.className='pill '+d.state;";
  html += "  document.getElementById('rate').textContent=rt;";
  html += "  document.getElementById('count').textContent=count;";
  html += "  document.getElementById('queue').textContent=d.queue;";
  html += "  document.getElementById('seq').textContent=d.event_seq;";
  html += "  document.getElementById('err').innerHTML='&nbsp;';";
  html += " }catch(e){document.getElementById('err').textContent='Lost connection — retrying';}";
  html += " setTimeout(tick,250);";
  html += "}";
  html += "async function tareAll(){";
  html += " if(!confirm('Platform EMPTY? OK to zero all.'))return;";
  html += " try{const r=await fetch('/tare?all=1');const d=await r.json();";
  html += "  if(!d.ok)alert('Tare failed: '+d.err);else loadConfig();";
  html += " }catch(e){alert('Network error');}";
  html += "}";
  html += "async function tareCell(i){";
  html += " if(!confirm('Cell '+i+' EMPTY? OK to zero.'))return;";
  html += " try{const r=await fetch('/tare?cell='+i);const d=await r.json();";
  html += "  if(!d.ok)alert('Tare failed: '+d.err);else loadConfig();";
  html += " }catch(e){alert('Network error');}";
  html += "}";
  html += "async function calCell(i){";
  html += " const g=prompt('Place KNOWN weight ON CELL '+i+' ONLY. Enter grams:');";
  html += " if(g===null||g==='')return;";
  html += " const grams=parseFloat(g);if(!(grams>0)){alert('Invalid');return;}";
  html += " try{const r=await fetch('/calibrate?cell='+i+'&grams='+encodeURIComponent(grams));const d=await r.json();";
  html += "  if(d.ok){alert('Cell '+i+' factor='+d.scale_factor.toFixed(4));loadConfig();}";
  html += "  else alert('Cal failed: '+d.err);";
  html += " }catch(e){alert('Network error');}";
  html += "}";
  html += "async function saveCfg(){";
  html += " const p=new URLSearchParams();";
  html += " p.set('pi_url',document.getElementById('cf_pi_url').value);";
  html += " p.set('device_id',document.getElementById('cf_device_id').value);";
  html += " p.set('delta_threshold_g',document.getElementById('cf_delta').value);";
  html += " p.set('stability_window_g',document.getElementById('cf_stab').value);";
  html += " p.set('stable_samples_required',document.getElementById('cf_samples').value);";
  html += " p.set('near_stable_window_g',document.getElementById('cf_near').value);";
  html += " try{const r=await fetch('/settings?'+p.toString(),{method:'POST'});const d=await r.json();";
  html += "  if(d.ok)alert('Saved (changed='+d.changed+')');else alert('Save failed');";
  html += "  loadConfig();";
  html += " }catch(e){alert('Network error');}";
  html += "}";
  html += "renderCells();loadConfig();tick();";
  html += "</script></body></html>";
  server.send(200, "text/html", html);
}

// ---------- Stability + event loop ----------

void pushWindow(float w) {
  if (windowLen < cfg.stable_samples_required) {
    windowBuf[(windowHead + windowLen) % MAX_WIN] = w;
    windowLen++;
  } else {
    windowBuf[windowHead] = w;
    windowHead = (windowHead + 1) % MAX_WIN;
  }
}

// Computes min/max/mean over whatever samples are currently in the window.
// Returns true ONLY when the window has >= stable_samples_required samples
// (i.e. "full"). Callers that need a meaningful stability judgement (event
// gate, LED steady state) must treat a false return as "warming up" and
// must NOT conclude stability from a partial window.
bool windowStats(float* outMin, float* outMax, float* outMean) {
  if (windowLen == 0) return false;
  float mn = windowBuf[windowHead];
  float mx = mn;
  float sum = 0;
  for (int i = 0; i < windowLen; i++) {
    int idx = (windowHead + i) % MAX_WIN;
    float v = windowBuf[idx];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
    sum += v;
  }
  *outMin = mn;
  *outMax = mx;
  *outMean = sum / (float)windowLen;
  return (windowLen >= (int)cfg.stable_samples_required);
}

void scaleLoop() {
  unsigned long now = millis();
  if (now - lastSampleMs < SAMPLE_INTERVAL_MS) return;
  lastSampleMs = now;

  float w;
  if (!readShelfWeight(&w)) return;

  // Track movement (for idle-off LED logic): if the newest sample is more than
  // stability_window_g from the previous sample, count as movement.
  static float prevSample = 0.0f;
  static bool hasPrev = false;
  if (hasPrev && fabsf(w - prevSample) > cfg.stability_window_g) {
    lastMovementMs = now;
  }
  prevSample = w;
  hasPrev = true;

  pushWindow(w);

  float mn, mx, mean;
  // windowStats() now returns true only when the window is full; treat
  // its return value as the "windowFull" gate for both event emission
  // and LED steady-state. Partial windows leave windowFull == false.
  bool windowFull = windowStats(&mn, &mx, &mean);

  if (windowFull && (mx - mn) < cfg.stability_window_g) {
    // Stable window observed
    if (stabState == SETTLING) {
      stabState = STABLE;
      currentStableSamples = cfg.stable_samples_required;
      // Transition: emit if |mean - last_stable| > delta_threshold
      if (hasLastStable) {
        float delta = mean - lastStableWeight;
        if (fabsf(delta) >= cfg.delta_threshold_g) {
          emitEvent(lastStableWeight, mean, delta, currentStableSamples);
        }
      }
      lastStableWeight = mean;
      hasLastStable = true;
    } else {
      // Still stable; no event
      if (currentStableSamples < 0xFFFF) currentStableSamples++;
    }
  } else {
    // Not stable
    if (stabState == STABLE) {
      // Edge transition: STABLE → SETTLING. This is when motion started.
      motionStartedMs = now;
      hasMotionStart = true;
    }
    stabState = SETTLING;
    currentStableSamples = 0;
  }

  // LED: steady state per spec, but blue-flash wins while active.
  if (currentLed == LED_BLUE_FLASH) {
    if (now - blueFlashStart > BLUE_FLASH_MS) {
      ledApply(desiredSteadyLed(mx, mn, windowFull));
    }
  } else {
    LedState d = desiredSteadyLed(mx, mn, windowFull);
    if (d != currentLed) ledApply(d);
  }
}

// ---------- Heartbeat + NTP + queue-drain ----------

void periodicTasks() {
  unsigned long now = millis();

  // WiFi health check — every ~10s, if disconnected, nudge the stack. The
  // ESP8266 core will also auto-reconnect on its own (setAutoReconnect), so
  // this is a belt-and-suspenders trigger, debounced so we don't thrash.
  if (now - lastWifiCheckMs > WIFI_CHECK_INTERVAL_MS) {
    lastWifiCheckMs = now;
    if (WiFi.status() != WL_CONNECTED) {
      if (now - lastWifiReconnectMs > WIFI_RECONNECT_DEBOUNCE_MS) {
        lastWifiReconnectMs = now;
        Serial.println("WiFi disconnected — calling WiFi.reconnect()");
        WiFi.reconnect();
      }
    }
  }

  // NTP resync
  if (!ntpEverSynced || now - lastNtpResyncMs > NTP_RESYNC_INTERVAL_MS) {
    if (WiFi.status() == WL_CONNECTED) {
      if (timeClient.update()) {
        ntpEverSynced = true;
        ntpLastSuccessMs = now;
      }
      lastNtpResyncMs = now;
    }
  }

  // Heartbeat with adaptive backoff. At the normal 500ms cadence a failed
  // POST can still cost up to ~400ms (see httpPostFastFail timeout), which
  // is acceptable — but after HEARTBEAT_FAIL_THRESHOLD consecutive failures
  // we assume the Pi is unreachable and back off to HEARTBEAT_BACKOFF_MS
  // to avoid steady loop-starvation. First success resets the cadence.
  if (now - lastHeartbeatMs > currentHeartbeatIntervalMs) {
    lastHeartbeatMs = now;
    float w = hasLastStable ? lastStableWeight : 0.0f;
    bool ok = sendHeartbeat(w, stabState == STABLE);
    if (ok) {
      if (currentHeartbeatIntervalMs != HEARTBEAT_INTERVAL_MS) {
        Serial.println("Heartbeat recovered — resuming 500ms cadence");
      }
      heartbeatFailStreak = 0;
      currentHeartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
    } else {
      if (heartbeatFailStreak < 0xFF) heartbeatFailStreak++;
      if (heartbeatFailStreak >= HEARTBEAT_FAIL_THRESHOLD &&
          currentHeartbeatIntervalMs != HEARTBEAT_BACKOFF_MS) {
        Serial.printf("Heartbeat failed %u times — backing off to %lums\n",
                      (unsigned)heartbeatFailStreak,
                      (unsigned long)HEARTBEAT_BACKOFF_MS);
        currentHeartbeatIntervalMs = HEARTBEAT_BACKOFF_MS;
      }
    }
  }

  // Drain queued events (one per pass when connected)
  static unsigned long lastDrainMs = 0;
  if (queueSize > 0 && (now - lastDrainMs) > 1000) {
    lastDrainMs = now;
    drainOne();
  }
}

// ---------- Setup ----------

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n=== Catch-all Scale (1-cell HX711 + WS2812B) ===");

  pinMode(statusLedPin, OUTPUT);
  digitalWrite(statusLedPin, HIGH);

  pinMode(SCK_PIN, OUTPUT);
  digitalWrite(SCK_PIN, LOW);
  for (int i = 0; i < NUM_CELLS; i++) pinMode(DOUT_PINS[i], INPUT);

  pixel.begin();
  pixel.setBrightness(128);
  ledApply(LED_RED);  // boot indicator

  Serial.print("Waiting for all HX711s to become ready");
  unsigned long start = millis();
  while (!allReady() && millis() - start < 2000) {
    Serial.print(".");
    delay(100);
  }
  Serial.println();
  if (!allReady()) {
    Serial.println("WARNING: not all DOUTs went low — check wiring / power");
  }

  EEPROM.begin(EEPROM_SIZE);

  if (loadAll()) {
    Serial.println("EEPROM loaded (calibration + runtime cfg)");
  } else {
    Serial.println("No valid EEPROM — initializing defaults");
    setDefaultRuntimeCfg(cfg);
    setDefaultCalibration();
    saveAll();
  }

  for (int i = 0; i < NUM_CELLS; i++) {
    Serial.printf("  cell %d: scale=%.4f  offset=%ld\n", i,
                  cells[i].scale_factor, cells[i].offset);
  }
  Serial.printf("  pi_url=%s  device_id=%s\n", cfg.pi_url, cfg.device_id);
  Serial.printf("  stability_window_g=%.2f  stable_samples=%u  near_window=%.2f  delta_thr=%.2f\n",
                cfg.stability_window_g, (unsigned)cfg.stable_samples_required,
                cfg.near_stable_window_g, cfg.delta_threshold_g);

  WiFi.mode(WIFI_STA);
  // Ask the ESP8266 stack to auto-reconnect on its own when the link drops.
  // periodicTasks() adds a belt-and-suspenders WiFi.reconnect() call every
  // ~10s if we're still disconnected (see WIFI_CHECK_INTERVAL_MS).
  WiFi.setAutoReconnect(true);
  WiFi.persistent(true);
  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  int timeout = 0;
  while (WiFi.status() != WL_CONNECTED && timeout < 30) {
    delay(500);
    Serial.print(".");
    digitalWrite(statusLedPin, !digitalRead(statusLedPin));
    timeout++;
  }

  // Register web routes + start the server regardless of current WiFi state.
  // If WiFi comes up later (via setAutoReconnect or periodic reconnect), the
  // server is already listening and will accept clients immediately. The
  // server.handleClient() call in loop() is a no-op when there is no link.
  server.on("/",           handleRoot);
  server.on("/data",       handleData);
  server.on("/config",     handleConfig);
  server.on("/tare",       handleTare);
  server.on("/calibrate",  handleCalibrate);
  server.on("/settings",   HTTP_POST, handleSettings);
  server.on("/settings",   HTTP_GET,  handleSettings);
  server.on("/led",        handleLed);
  server.begin();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
    digitalWrite(statusLedPin, LOW);

    timeClient.begin();
    // Blocking initial NTP attempt (best-effort)
    if (timeClient.forceUpdate()) {
      ntpEverSynced = true;
      ntpLastSuccessMs = millis();
      Serial.printf("NTP synced: epoch=%lu\n", (unsigned long)timeClient.getEpochTime());
    } else {
      Serial.println("NTP: initial sync failed, will retry in loop");
    }
    lastNtpResyncMs = millis();
    Serial.println("Web server listening on :80");

    // OTA: enable Arduino IDE wireless flashing. After one USB flash to
    // include this code, future uploads find the device as a "Network Port"
    // in the IDE and flash over WiFi. Hostname advertised via mDNS.
    ArduinoOTA.setHostname("live-shelf-scale");
    ArduinoOTA.setPassword("shelf-ota");  // prompted for in the IDE
    ArduinoOTA.onStart([]() {
      ledApply(LED_MAGENTA);
      Serial.println("OTA: update starting");
    });
    ArduinoOTA.onEnd([]() {
      Serial.println("\nOTA: update complete");
    });
    ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
      Serial.printf("OTA: %u%%\r", (progress * 100) / total);
    });
    ArduinoOTA.onError([](ota_error_t error) {
      Serial.printf("OTA error %u: ", error);
      if (error == OTA_AUTH_ERROR)        Serial.println("auth failed");
      else if (error == OTA_BEGIN_ERROR)  Serial.println("begin failed");
      else if (error == OTA_CONNECT_ERROR)Serial.println("connect failed");
      else if (error == OTA_RECEIVE_ERROR)Serial.println("receive failed");
      else if (error == OTA_END_ERROR)    Serial.println("end failed");
      ledApply(LED_MAGENTA);
    });
    ArduinoOTA.begin();
    Serial.println("OTA: ready as 'live-shelf-scale' on port 8266");

    ledApply(LED_OFF);
  } else {
    // WiFi didn't come up within 15s (30 * 500ms). Do NOT hard-lock the
    // device — the main loop will keep reading the scale, driving the LED,
    // and periodically attempting reconnection via setAutoReconnect +
    // periodicTasks(). The web UI will be reachable as soon as the AP
    // becomes available. NTP will be attempted on the next periodicTasks
    // pass once WiFi is up.
    Serial.println("\nWiFi failed at boot — continuing in offline mode (will retry)");
    // Still call timeClient.begin() so later timeClient.update() calls work.
    timeClient.begin();
    // Seed reconnect timers so the first health check still tries quickly.
    lastWifiCheckMs = millis() - WIFI_CHECK_INTERVAL_MS;
    lastWifiReconnectMs = 0;
    // LED: magenta indicates "network unreachable". desiredSteadyLed() will
    // also show magenta whenever WiFi.status() != WL_CONNECTED, so this is
    // consistent with the runtime behavior documented in the README.
    ledApply(LED_MAGENTA);
  }
}

void loop() {
  server.handleClient();
  // Handle OTA first so in-flight uploads finish quickly even when the
  // scale loop is busy. Safe to call unconditionally; it's a no-op until
  // an upload arrives.
  ArduinoOTA.handle();
  scaleLoop();
  periodicTasks();
  yield();
}
