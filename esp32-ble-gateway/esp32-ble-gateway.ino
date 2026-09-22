// ECCD SmartTrack — ESP32 BLE gateway
//
// Listens for the BLE tags registered to students and reports which tags it
// hears, and how strongly, to the backend. It does NOT decide who is present:
// the backend combines these sightings with the camera's face matches and
// applies the thresholds (BLE_MIN_RSSI, ...). This device only reports.
//
// Flow:
//   1. Joins Wi-Fi and syncs the clock (needed to verify the server's TLS cert).
//   2. Downloads the list of tag addresses to listen for (addresses only; no
//      student names or ids ever reach this device).
//   3. While a session is running, scans for 2 s, then posts what it heard.
//      When no session is running it just checks in every few seconds.
//
// Libraries (Arduino Library Manager): "ArduinoJson" by Benoit Blanchon, v7.x.
// Board: an ESP32 with the arduino-esp32 core. Written against the 2.x BLE API,
// the same one the original CAPSTONE.ino used; on core 3.x, re-check the build.
//
// Security: HTTPS only, server certificate verified against ROOT_CA_PEM (never
// setInsecure), device key sent in a header and never printed.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <strings.h>
#include <BLEDevice.h>
#include <BLEUtils.h>
#include <BLEScan.h>
#include <BLEAdvertisedDevice.h>

// SCAN_ONLY = 1: no Wi-Fi, no server. Prints every BLE device heard with its
// signal strength. Use it to (a) find a tag's address to register in the app and
// (b) measure RSSI at 0.5 m / 1 m / 2 m / the doorway to choose BLE_MIN_RSSI.
#define SCAN_ONLY 0

#if !SCAN_ONLY
#include "secrets.h"
#endif

// ---- Tunables -------------------------------------------------------------
const int SCAN_SECONDS = 2;
// Coarse floor only, to skip noise. The backend applies the real threshold.
const int MIN_REPORT_RSSI = -90;
const int MAX_TAGS = 50;                            // matches the server's per-request limit
const unsigned long REGISTRY_REFRESH_MS = 5UL * 60UL * 1000UL;
const unsigned long REGISTRY_RETRY_MS = 30UL * 1000UL;
const unsigned long HEARTBEAT_MS = 10UL * 1000UL;   // check in this often while active but quiet
const unsigned long IDLE_CHECKIN_MS = 5UL * 1000UL; // check in this often while no session runs
const unsigned long HTTP_TIMEOUT_MS = 8000UL;
const unsigned long WIFI_TIMEOUT_MS = 20000UL;
const unsigned long BACKOFF_UNAUTHORIZED_MS = 60UL * 1000UL;
const unsigned long BACKOFF_RATE_LIMITED_MS = 15UL * 1000UL;

// ---- State ----------------------------------------------------------------
struct Tag {
  char mac[18];   // "AA:BB:CC:DD:EE:FF"
  int bestRssi;   // strongest reading heard this scan
  bool seen;
};

Tag tags[MAX_TAGS];
int tagCount = 0;
BLEScan* pBLEScan = nullptr;

#if SCAN_ONLY
struct Heard {
  char mac[18];
  int rssi;
  char name[24];
};
const int MAX_HEARD = 40;
Heard heard[MAX_HEARD];
int heardCount = 0;
#else
WiFiClientSecure secureClient;
bool sessionActive = false;
unsigned long lastPostMs = 0;
unsigned long lastRegistryMs = 0;
unsigned long registryRetryAtMs = 0;
bool registryLoaded = false;
unsigned long backoffUntilMs = 0;
#endif

// The callback runs on the BLE task while a scan is in progress. loop() only
// touches tags[]/heard[] before a scan starts or after it has returned, so the
// two never overlap.
class SightingCallbacks : public BLEAdvertisedDeviceCallbacks {
  void onResult(BLEAdvertisedDevice advertisedDevice) {
    int rssi = advertisedDevice.getRSSI();
    String address = advertisedDevice.getAddress().toString().c_str();
#if SCAN_ONLY
    for (int i = 0; i < heardCount; i++) {
      if (address.equalsIgnoreCase(heard[i].mac)) {
        if (rssi > heard[i].rssi) heard[i].rssi = rssi;
        return;
      }
    }
    if (heardCount < MAX_HEARD) {
      Heard& h = heard[heardCount++];
      strncpy(h.mac, address.c_str(), sizeof(h.mac) - 1);
      h.mac[sizeof(h.mac) - 1] = '\0';
      h.rssi = rssi;
      String name = advertisedDevice.haveName() ? String(advertisedDevice.getName().c_str()) : String("");
      strncpy(h.name, name.c_str(), sizeof(h.name) - 1);
      h.name[sizeof(h.name) - 1] = '\0';
    }
#else
    if (rssi < MIN_REPORT_RSSI) return;
    for (int i = 0; i < tagCount; i++) {
      if (address.equalsIgnoreCase(tags[i].mac)) {
        if (!tags[i].seen || rssi > tags[i].bestRssi) tags[i].bestRssi = rssi;
        tags[i].seen = true;
        return;
      }
    }
#endif
  }
};

// ---- Helpers --------------------------------------------------------------
bool isMacAddress(const char* s) {
  if (strlen(s) != 17) return false;
  for (int i = 0; i < 17; i++) {
    if (i % 3 == 2) {
      if (s[i] != ':') return false;
    } else if (!isxdigit((unsigned char)s[i])) {
      return false;
    }
  }
  return true;
}

void startScanner() {
  BLEDevice::init("");
  pBLEScan = BLEDevice::getScan();
  pBLEScan->setAdvertisedDeviceCallbacks(new SightingCallbacks());
  pBLEScan->setActiveScan(true);
  pBLEScan->setInterval(100);
  pBLEScan->setWindow(99);
}

#if SCAN_ONLY
// ==========================================================================
// Scan-only mode: print everything heard, strongest first.
// ==========================================================================
void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("--- SCAN_ONLY: printing every BLE device heard ---");
  startScanner();
}

void loop() {
  heardCount = 0;
  pBLEScan->start(SCAN_SECONDS, false);
  pBLEScan->clearResults();

  // Selection sort by RSSI, strongest first (the list is tiny).
  for (int i = 0; i < heardCount; i++) {
    for (int j = i + 1; j < heardCount; j++) {
      if (heard[j].rssi > heard[i].rssi) {
        Heard t = heard[i];
        heard[i] = heard[j];
        heard[j] = t;
      }
    }
  }
  Serial.printf("--- %d device(s) ---\n", heardCount);
  for (int i = 0; i < heardCount; i++) {
    Serial.printf("%s  %4d dBm  %s\n", heard[i].mac, heard[i].rssi, heard[i].name);
  }
}

#else
// ==========================================================================
// Gateway mode
// ==========================================================================

// Certificate checking needs the real date. Returns true once the clock is set.
bool syncClock() {
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  unsigned long start = millis();
  while (time(nullptr) < 1700000000L) {  // any date after Nov 2023 means NTP worked
    if (millis() - start > 15000UL) return false;
    delay(250);
  }
  return true;
}

bool connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return true;
  Serial.println("Connecting to Wi-Fi...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - start > WIFI_TIMEOUT_MS) {
      Serial.println("Wi-Fi not available; will retry.");
      return false;
    }
    delay(250);
  }
  Serial.print("Wi-Fi connected, IP ");
  Serial.println(WiFi.localIP());
  if (!syncClock()) {
    Serial.println("Clock not synced yet; HTTPS will fail until it is. Retrying.");
    return false;
  }
  return true;
}

// Sends one HTTPS request with the device key. Returns the HTTP status, or a
// negative HTTPClient error. `body` is null for GET. The response goes into `out`.
int callBackend(const char* method, const char* path, const String* body, String& out) {
  HTTPClient http;
  http.setReuse(true);  // keep the TLS connection open between posts (handshakes are slow)
  http.setTimeout(HTTP_TIMEOUT_MS);
  String url = String(API_BASE_URL) + path;
  if (!http.begin(secureClient, url)) return -1;
  http.addHeader("X-Device-Key", DEVICE_KEY);
  int status;
  if (body != nullptr) {
    http.addHeader("Content-Type", "application/json");
    status = http.POST(*body);
  } else {
    status = http.GET();
  }
  if (status > 0) out = http.getString();
  http.end();
  return status;
}

// Common reaction to a non-success status, so every call site backs off the same way.
void noteFailure(int status) {
  if (status == 401) {
    Serial.println("Backend rejected the device key (401). Check DEVICE_KEY; retrying in 60 s.");
    backoffUntilMs = millis() + BACKOFF_UNAUTHORIZED_MS;
  } else if (status == 429) {
    Serial.println("Rate limited (429); slowing down.");
    backoffUntilMs = millis() + BACKOFF_RATE_LIMITED_MS;
  } else {
    Serial.printf("Request failed (%d).\n", status);
  }
}

// Downloads the addresses to listen for. Only called between scans.
bool refreshRegistry() {
  String response;
  int status = callBackend("GET", "/api/attendance/gateway/devices", nullptr, response);
  if (status != 200) {
    noteFailure(status);
    return false;
  }
  JsonDocument doc;
  if (deserializeJson(doc, response)) {
    Serial.println("Registry response was not valid JSON.");
    return false;
  }
  JsonArray devices = doc["devices"].as<JsonArray>();
  if (devices.isNull()) return false;

  int count = 0;
  for (JsonVariant v : devices) {
    const char* mac = v.as<const char*>();
    if (mac == nullptr || !isMacAddress(mac) || count >= MAX_TAGS) continue;
    strncpy(tags[count].mac, mac, sizeof(tags[count].mac) - 1);
    tags[count].mac[sizeof(tags[count].mac) - 1] = '\0';
    tags[count].seen = false;
    tags[count].bestRssi = -127;
    count++;
  }
  tagCount = count;
  Serial.printf("Listening for %d tag(s).\n", tagCount);
  return true;
}

// Posts what the last scan heard (or an empty batch as a heartbeat) and learns
// whether a session is running from the reply.
bool postSightings() {
  JsonDocument doc;
  JsonArray events = doc["events"].to<JsonArray>();
  for (int i = 0; i < tagCount; i++) {
    if (!tags[i].seen) continue;
    JsonObject event = events.add<JsonObject>();
    event["deviceIdentifier"] = tags[i].mac;
    event["rssi"] = tags[i].bestRssi;
  }
  String body;
  serializeJson(doc, body);

  String response;
  int status = callBackend("POST", "/api/attendance/gateway/events", &body, response);
  lastPostMs = millis();
  if (status != 200) {
    noteFailure(status);
    return false;
  }
  JsonDocument reply;
  if (!deserializeJson(reply, response)) {
    bool active = reply["sessionActive"] | false;
    if (active != sessionActive) {
      Serial.println(active ? "Attendance started: scanning." : "Attendance stopped: idle.");
    }
    sessionActive = active;
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("--- ECCD BLE gateway starting ---");

  // Never send the device key over plain HTTP.
  if (strncmp(API_BASE_URL, "https://", 8) != 0) {
    Serial.println("API_BASE_URL must start with https://. Halting.");
    while (true) delay(1000);
  }

  secureClient.setCACert(ROOT_CA_PEM);  // verify the server; never setInsecure()
  startScanner();
  Serial.println("--- BLE scanner ready ---");
}

void loop() {
  unsigned long now = millis();

  if (now < backoffUntilMs) {  // told to slow down or key rejected
    delay(500);
    return;
  }
  if (!connectWifi()) {
    delay(3000);
    return;
  }

  // Refresh the tag list at boot and every few minutes, only between scans.
  if (!registryLoaded || now - lastRegistryMs > REGISTRY_REFRESH_MS) {
    if (now >= registryRetryAtMs) {
      if (refreshRegistry()) {
        registryLoaded = true;
        lastRegistryMs = now;
      } else {
        registryRetryAtMs = now + REGISTRY_RETRY_MS;
      }
    }
    if (!registryLoaded) {
      delay(1000);
      return;
    }
  }

  // No session running (or nothing to listen for): just check in.
  if (!sessionActive || tagCount == 0) {
    if (lastPostMs == 0 || now - lastPostMs >= IDLE_CHECKIN_MS) {
      for (int i = 0; i < tagCount; i++) tags[i].seen = false;
      postSightings();
    }
    delay(500);
    return;
  }

  // Session running: scan, then report.
  for (int i = 0; i < tagCount; i++) {
    tags[i].seen = false;
    tags[i].bestRssi = -127;
  }
  pBLEScan->start(SCAN_SECONDS, false);
  pBLEScan->clearResults();

  int heardCount = 0;
  for (int i = 0; i < tagCount; i++) {
    if (tags[i].seen) heardCount++;
  }
  if (heardCount > 0 || millis() - lastPostMs >= HEARTBEAT_MS) {
    postSightings();
  }
}
#endif
