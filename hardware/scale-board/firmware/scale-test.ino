#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <EEPROM.h>

const char* ssid = "EmeraldDolphin";
const char* password = "lil-flop";

#define NUM_CELLS 4
const int SCK_PIN = D7;
const int DOUT_PINS[NUM_CELLS] = { D6, D1, D2, D5 };

#define EEPROM_SIZE 128
#define EEPROM_MAGIC 0xBEEF0004UL
#define EEPROM_VERSION 2

struct CellCal {
  long offset;
  float scale_factor;
};

struct CalStorage {
  uint32_t magic;
  uint32_t version;
  CellCal cells[NUM_CELLS];
};

const float DEFAULT_SCALE_FACTOR = 141.6;

CellCal cells[NUM_CELLS];
ESP8266WebServer server(80);
const int ledPin = LED_BUILTIN;

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

// Reads all 4 HX711s simultaneously. Returns false on timeout.
bool readRaw(long out[NUM_CELLS]) {
  if (!waitAllReady(200)) {
    for (int i = 0; i < NUM_CELLS; i++) out[i] = 0;
    return false;
  }

  long raw[NUM_CELLS] = { 0, 0, 0, 0 };

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
  // 25th pulse: channel A, gain 128 for next conversion
  digitalWrite(SCK_PIN, HIGH);
  delayMicroseconds(1);
  digitalWrite(SCK_PIN, LOW);
  delayMicroseconds(1);
  interrupts();

  // Sign-extend 24-bit two's complement to 32-bit
  for (int i = 0; i < NUM_CELLS; i++) {
    if (raw[i] & 0x800000UL) raw[i] |= 0xFF000000UL;
    out[i] = raw[i];
  }
  return true;
}

// Returns averaged raw reading across `samples` conversions
bool readAverage(long out[NUM_CELLS], int samples) {
  long acc[NUM_CELLS] = { 0, 0, 0, 0 };
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

// ---------- Calibration persistence ----------

void saveCalibration() {
  CalStorage data;
  data.magic = EEPROM_MAGIC;
  data.version = EEPROM_VERSION;
  for (int i = 0; i < NUM_CELLS; i++) data.cells[i] = cells[i];
  EEPROM.put(0, data);
  EEPROM.commit();
  Serial.println("Calibration saved");
}

bool loadCalibration() {
  CalStorage data;
  EEPROM.get(0, data);
  if (data.magic != EEPROM_MAGIC || data.version != EEPROM_VERSION) return false;
  for (int i = 0; i < NUM_CELLS; i++) {
    if (isnan(data.cells[i].scale_factor)) return false;
    cells[i] = data.cells[i];
  }
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

// ---------- HTTP handlers ----------

void handleData() {
  long raw[NUM_CELLS];
  readRaw(raw);

  float total = 0;
  String json = "{\"cells\":[";
  for (int i = 0; i < NUM_CELLS; i++) {
    float g = rawToGrams(i, raw[i]);
    total += g;
    if (i > 0) json += ",";
    json += String(g, 2);
  }
  json += "],\"total\":" + String(total, 2) + "}";
  server.send(200, "application/json", json);
}

void handleConfig() {
  String json = "{\"cells\":[";
  for (int i = 0; i < NUM_CELLS; i++) {
    if (i > 0) json += ",";
    json += "{\"scale_factor\":" + String(cells[i].scale_factor, 4);
    json += ",\"offset\":" + String(cells[i].offset) + "}";
  }
  json += "]}";
  server.send(200, "application/json", json);
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
  saveCalibration();
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
    server.send(400, "application/json", "{\"ok\":false,\"err\":\"no signal on that cell — did you tare it empty and place the weight on it?\"}");
    return;
  }
  float new_factor = (float)signal / known_grams;
  cells[cell].scale_factor = new_factor;
  saveCalibration();

  String json = "{\"ok\":true,\"cell\":" + String(cell);
  json += ",\"scale_factor\":" + String(new_factor, 4);
  json += ",\"signal\":" + String(signal);
  json += ",\"grams\":" + String(known_grams, 2) + "}";
  server.send(200, "application/json", json);
}

// ---------- Web UI ----------

void handleRoot() {
  String html = "<!DOCTYPE html><html><head>";
  html += "<meta charset='UTF-8'><title>Scale Test (4-cell)</title>";
  html += "<meta name='viewport' content='width=device-width, initial-scale=1'>";
  html += "<style>";
  html += "*{box-sizing:border-box}";
  html += "body{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#0f1115;color:#e8e8e8;margin:0;min-height:100vh;padding:32px}";
  html += ".wrap{max-width:720px;margin:0 auto}";
  html += ".label{font-size:0.8em;color:#888;letter-spacing:3px;text-transform:uppercase;text-align:center}";
  html += ".total{font-size:7em;font-weight:700;color:#00e676;font-variant-numeric:tabular-nums;text-align:center;line-height:1;margin:16px 0;text-shadow:0 0 24px rgba(0,230,118,0.15)}";
  html += ".unit{font-size:0.3em;color:#666;margin-left:14px;font-weight:400}";
  html += ".grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:32px 0}";
  html += ".cell{background:#161922;border:1px solid #252a35;border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:6px}";
  html += ".cell .cname{color:#888;font-size:0.75em;letter-spacing:2px;text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}";
  html += ".cell .cval{font-size:2.2em;font-weight:600;color:#e8e8e8;font-variant-numeric:tabular-nums}";
  html += ".cell .cmeta{font-size:0.7em;color:#555;margin-top:4px}";
  html += ".cell .actions{display:flex;gap:6px;margin-top:8px}";
  html += ".cell .actions button{flex:1;padding:8px 10px;font-size:0.7em}";
  html += ".stats{text-align:center;font-size:0.85em;color:#555;display:flex;gap:24px;justify-content:center;flex-wrap:wrap}";
  html += ".stats b{color:#999;font-weight:600}";
  html += ".controls{margin-top:24px;display:flex;gap:12px;flex-wrap:wrap;justify-content:center}";
  html += "button{padding:12px 22px;font-size:0.85em;background:#1a1d24;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:8px;cursor:pointer;font-family:inherit;letter-spacing:2px;text-transform:uppercase;transition:all 0.15s}";
  html += "button:hover{background:#242832;border-color:#3a4150}";
  html += "button.primary{background:#0a3d1f;border-color:#0f5c2e;color:#00e676}";
  html += "button.primary:hover{background:#0f5c2e;border-color:#15874a}";
  html += ".err{color:#ff5252;font-size:0.85em;text-align:center;margin-top:16px;height:1.4em}";
  html += "@media (max-width:500px){.total{font-size:4.5em}.grid{grid-template-columns:1fr}}";
  html += "</style></head><body><div class='wrap'>";
  html += "<div class='label'>Total Weight</div>";
  html += "<div class='total'><span id='total'>--</span><span class='unit'>g</span></div>";
  html += "<div class='stats'><div><b id='rate'>--</b> ms / poll</div><div><b id='count'>0</b> samples</div></div>";
  html += "<div class='grid' id='cells'></div>";
  html += "<div class='controls'>";
  html += "<button onclick='tareAll()'>Tare All (Zero)</button>";
  html += "</div>";
  html += "<div class='err' id='err'>&nbsp;</div>";
  html += "</div><script>";
  html += "const N=" + String(NUM_CELLS) + ";";
  html += "let count=0,cfg=null;";
  html += "function renderCells(){";
  html += "  const el=document.getElementById('cells');el.innerHTML='';";
  html += "  for(let i=0;i<N;i++){";
  html += "    const d=document.createElement('div');d.className='cell';";
  html += "    d.innerHTML=`<div class='cname'><span>Cell ${i}</span><span style='color:#555;font-size:0.85em'>D${['6','1','2','5'][i]}</span></div>"
           "<div class='cval' id='cv${i}'>--</div>"
           "<div class='cmeta'>factor: <span id='cf${i}'>--</span> &middot; offset: <span id='co${i}'>--</span></div>"
           "<div class='actions'><button onclick='tareCell(${i})'>Tare</button><button onclick='calCell(${i})'>Calibrate</button></div>`;";
  html += "    el.appendChild(d);";
  html += "  }";
  html += "}";
  html += "async function loadConfig(){";
  html += "  try{const r=await fetch('/config');cfg=await r.json();";
  html += "    for(let i=0;i<N;i++){";
  html += "      document.getElementById('cf'+i).textContent=cfg.cells[i].scale_factor.toFixed(4);";
  html += "      document.getElementById('co'+i).textContent=cfg.cells[i].offset;";
  html += "    }}catch(e){}";
  html += "}";
  html += "async function tick(){";
  html += "  try{const t0=performance.now();";
  html += "    const r=await fetch('/data',{cache:'no-store'});";
  html += "    const d=await r.json();";
  html += "    const rt=Math.round(performance.now()-t0);";
  html += "    document.getElementById('total').textContent=d.total.toFixed(1);";
  html += "    for(let i=0;i<N;i++)document.getElementById('cv'+i).textContent=d.cells[i].toFixed(1)+' g';";
  html += "    count++;";
  html += "    document.getElementById('rate').textContent=rt;";
  html += "    document.getElementById('count').textContent=count;";
  html += "    document.getElementById('err').innerHTML='&nbsp;';";
  html += "  }catch(e){document.getElementById('err').textContent='Lost connection — retrying';}";
  html += "  setTimeout(tick,250);";
  html += "}";
  html += "async function tareAll(){";
  html += "  if(!confirm('Make sure the platform is EMPTY, then OK to zero all cells.'))return;";
  html += "  try{const r=await fetch('/tare?all=1');const d=await r.json();";
  html += "    if(!d.ok)alert('Tare failed: '+d.err);else loadConfig();";
  html += "  }catch(e){alert('Network error');}";
  html += "}";
  html += "async function tareCell(i){";
  html += "  if(!confirm('Make sure cell '+i+' has NOTHING on it, then OK to zero.'))return;";
  html += "  try{const r=await fetch('/tare?cell='+i);const d=await r.json();";
  html += "    if(!d.ok)alert('Tare failed: '+d.err);else loadConfig();";
  html += "  }catch(e){alert('Network error');}";
  html += "}";
  html += "async function calCell(i){";
  html += "  const g=prompt('Place a KNOWN weight ON CELL '+i+' ONLY, then enter its weight in grams:');";
  html += "  if(g===null||g==='')return;";
  html += "  const grams=parseFloat(g);if(!(grams>0)){alert('Invalid weight');return;}";
  html += "  try{const r=await fetch('/calibrate?cell='+i+'&grams='+encodeURIComponent(grams));const d=await r.json();";
  html += "    if(d.ok){alert('Cell '+i+' calibrated.\\nScale factor: '+d.scale_factor.toFixed(4));loadConfig();}";
  html += "    else alert('Calibration failed: '+d.err);";
  html += "  }catch(e){alert('Network error');}";
  html += "}";
  html += "renderCells();loadConfig();tick();";
  html += "</script></body></html>";
  server.send(200, "text/html", html);
}

// ---------- Setup ----------

void setup() {
  Serial.begin(115200);
  delay(100);
  Serial.println("\n=== Scale Test (4-cell parallel HX711) ===");

  pinMode(ledPin, OUTPUT);
  digitalWrite(ledPin, HIGH);

  pinMode(SCK_PIN, OUTPUT);
  digitalWrite(SCK_PIN, LOW);  // keep chips awake
  for (int i = 0; i < NUM_CELLS; i++) pinMode(DOUT_PINS[i], INPUT);

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

  if (loadCalibration()) {
    Serial.println("Calibration loaded from EEPROM");
  } else {
    Serial.println("No valid EEPROM — initializing defaults (empty platform assumed)");
    setDefaultCalibration();
    saveCalibration();
  }

  for (int i = 0; i < NUM_CELLS; i++) {
    Serial.printf("  cell %d: pin D%d  scale=%.4f  offset=%ld\n", i,
                  (i == 0 ? 6 : (i == 1 ? 1 : (i == 2 ? 2 : 5))),
                  cells[i].scale_factor, cells[i].offset);
  }

  WiFi.begin(ssid, password);
  Serial.print("Connecting to WiFi");
  int timeout = 0;
  while (WiFi.status() != WL_CONNECTED && timeout < 30) {
    delay(500);
    Serial.print(".");
    digitalWrite(ledPin, !digitalRead(ledPin));
    timeout++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println();
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
    digitalWrite(ledPin, LOW);

    server.on("/", handleRoot);
    server.on("/data", handleData);
    server.on("/config", handleConfig);
    server.on("/tare", handleTare);
    server.on("/calibrate", handleCalibrate);
    server.begin();
    Serial.println("Server listening on port 80");
  } else {
    Serial.println("\nWiFi failed");
    while (1) {
      digitalWrite(ledPin, !digitalRead(ledPin));
      delay(200);
    }
  }
}

void loop() {
  server.handleClient();
}
