#include <Arduino.h>
#include <ArduinoJson.h>
#include "config.h"
#include "sensors.h"

// =============================================================================
// MARUDAM ESP32 Sensor Node — Two-Field Architecture
// =============================================================================
// COMMUNICATION MODES:
//   "SERIAL" -> Pure JSON Lines over USB Serial (115200 baud)
//               ESP32 -> USB -> FastAPI Backend -> Supabase
//   "WIFI"   -> HTTP POST over Wi-Fi to FastAPI Backend
//               ESP32 -> Wi-Fi -> FastAPI /api/sensors/esp32 -> Pipeline
//
// SERIAL OUTPUT RULES:
//   - Exactly ONE valid JSON object per line.
//   - Line ends with standard \n.
//   - Absolutely NO human-readable debug text on Serial in SERIAL mode.
//   - NaN / Infinite sensor values are serialized strictly as JSON `null`.
//
// Wi-Fi Mode:
//   - Connects to configured WIFI_SSID / WIFI_PASSWORD.
//   - POSTs JSON to BACKEND_URL every SAMPLE_INTERVAL_MS.
//   - Falls back to Serial output on POST failure.
//   - Debug messages go to Serial (since Serial is not used for data in Wi-Fi mode).
// =============================================================================

// Conditionally include Wi-Fi libraries
#if defined(COMMUNICATION_MODE) && (strcmp(COMMUNICATION_MODE, "WIFI") == 0 || strcmp(COMMUNICATION_MODE, "BOTH") == 0)
  #define USE_WIFI 1
#else
  #define USE_WIFI 0
#endif

#if USE_WIFI
  #include <WiFi.h>
  #include <HTTPClient.h>
#endif

SensorManager sensors(DEVICE_ID);
unsigned long lastSampleTime = 0;

#if USE_WIFI
  bool wifiConnected = false;
  unsigned long lastWifiCheck = 0;
  const unsigned long WIFI_CHECK_INTERVAL_MS = 30000; // Check Wi-Fi every 30s
#endif

// ---------------------------------------------------------------------------
// generateJsonPayload()
// Constructs a validated JSON payload supporting both Field 1 & Field 2,
// shared atmospheric readings, component status, and backward compatibility.
// ---------------------------------------------------------------------------
String generateJsonPayload(const TwoFieldReadings& r) {
  DynamicJsonDocument doc(1536);

  // --- Identity & Metadata ---
  doc["device_id"]        = r.device_id;
  doc["firmware_version"] = r.firmware_version;
  doc["schema_version"]   = r.schema_version;
  doc["uptime_ms"]        = r.uptime_ms;
  doc["timestamp"]        = nullptr; // Synchronized server-side UTC

  // --- Shared Environmental Measurements ---
  JsonObject shared = doc.createNestedObject("shared");
  if (!isnan(r.shared.air_temperature)) doc["air_temperature"] = shared["air_temperature"] = r.shared.air_temperature;
  else { doc["air_temperature"] = nullptr; shared["air_temperature"] = nullptr; }

  if (!isnan(r.shared.humidity)) doc["humidity"] = shared["humidity"] = r.shared.humidity;
  else { doc["humidity"] = nullptr; shared["humidity"] = nullptr; }

  if (!isnan(r.shared.light_lux)) doc["light_lux"] = shared["light_lux"] = r.shared.light_lux;
  else { doc["light_lux"] = nullptr; shared["light_lux"] = nullptr; }

  // --- Field-Specific Measurements ---
  JsonObject fields = doc.createNestedObject("fields");

  // Field 1
  JsonObject f1 = fields.createNestedObject("field_1");
  f1["field_id"] = r.field_1.field_id;
  if (r.field_1.soil_moisture_raw >= 0) f1["soil_moisture_raw"] = r.field_1.soil_moisture_raw;
  else f1["soil_moisture_raw"] = nullptr;

  if (!isnan(r.field_1.soil_moisture_voltage)) f1["soil_moisture_voltage"] = r.field_1.soil_moisture_voltage;
  else f1["soil_moisture_voltage"] = nullptr;

  if (!isnan(r.field_1.soil_moisture)) f1["soil_moisture"] = r.field_1.soil_moisture;
  else f1["soil_moisture"] = nullptr;

  if (!isnan(r.field_1.soil_temperature)) f1["soil_temperature"] = r.field_1.soil_temperature;
  else f1["soil_temperature"] = nullptr;

  if (r.field_1.ds18b20_address.length() > 0) f1["ds18b20_address"] = r.field_1.ds18b20_address;
  else f1["ds18b20_address"] = nullptr;

  // Field 2
  JsonObject f2 = fields.createNestedObject("field_2");
  f2["field_id"] = r.field_2.field_id;
  if (r.field_2.soil_moisture_raw >= 0) f2["soil_moisture_raw"] = r.field_2.soil_moisture_raw;
  else f2["soil_moisture_raw"] = nullptr;

  if (!isnan(r.field_2.soil_moisture_voltage)) f2["soil_moisture_voltage"] = r.field_2.soil_moisture_voltage;
  else f2["soil_moisture_voltage"] = nullptr;

  if (!isnan(r.field_2.soil_moisture)) f2["soil_moisture"] = r.field_2.soil_moisture;
  else f2["soil_moisture"] = nullptr;

  if (!isnan(r.field_2.soil_temperature)) f2["soil_temperature"] = r.field_2.soil_temperature;
  else f2["soil_temperature"] = nullptr;

  if (r.field_2.ds18b20_address.length() > 0) f2["ds18b20_address"] = r.field_2.ds18b20_address;
  else f2["ds18b20_address"] = nullptr;

  // Backward compatibility root aliases (default to Field 1 primary)
  doc["soil_moisture"]    = f1["soil_moisture"];
  doc["soil_temperature"] = f1["soil_temperature"];
  doc["soil_ph"]          = nullptr; // Not physically attached
  doc["soil_ec"]          = nullptr; // Not physically attached

  // --- Sensor Statuses ---
  JsonObject status = doc.createNestedObject("sensor_status");
  status["dht22"]               = r.status_dht22;
  status["bh1750"]              = r.status_bh1750;
  status["ads1115"]             = r.status_ads1115;
  status["field_1_moisture"]    = r.field_1.status_moisture;
  status["field_1_temperature"] = r.field_1.status_temperature;
  status["field_2_moisture"]    = r.field_2.status_moisture;
  status["field_2_temperature"] = r.field_2.status_temperature;
  status["air_temperature"]     = r.shared.status_air_temperature;
  status["humidity"]            = r.shared.status_humidity;
  status["light_lux"]           = r.shared.status_light_lux;

  String output;
  serializeJson(doc, output);
  return output;
}

// ===========================================================================
// Wi-Fi FUNCTIONS
// ===========================================================================
#if USE_WIFI

void connectWiFi() {
  Serial.print("[WIFI] Connecting to ");
  Serial.print(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long startMs = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - startMs > WIFI_TIMEOUT_MS) {
      Serial.println("\n[WIFI] Connection FAILED — timeout");
      wifiConnected = false;
      return;
    }
    delay(500);
    Serial.print(".");
  }

  wifiConnected = true;
  Serial.println();
  Serial.print("[WIFI] Connected! IP: ");
  Serial.println(WiFi.localIP());
}

bool sendHttpPost(const String& jsonPayload) {
  if (WiFi.status() != WL_CONNECTED) {
    wifiConnected = false;
    return false;
  }

  HTTPClient http;
  http.begin(BACKEND_URL);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000); // 5 second timeout

  int httpCode = http.POST(jsonPayload);

  if (httpCode > 0) {
    String response = http.getString();
    Serial.printf("[WIFI] POST %d -> %s\n", httpCode, response.c_str());
    http.end();
    return (httpCode >= 200 && httpCode < 300);
  } else {
    Serial.printf("[WIFI] POST failed: %s\n", http.errorToString(httpCode).c_str());
    http.end();
    return false;
  }
}

void maintainWiFi() {
  if (millis() - lastWifiCheck > WIFI_CHECK_INTERVAL_MS) {
    lastWifiCheck = millis();
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[WIFI] Connection lost, reconnecting...");
      wifiConnected = false;
      connectWiFi();
    }
  }
}

#endif // USE_WIFI

// ===========================================================================
// SETUP
// ===========================================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  // Initialize all hardware drivers.
  // Note: Diagnostic text is deliberately suppressed from Serial output
  // in SERIAL communication mode.
  sensors.begin();

  #if USE_WIFI
    Serial.println("[MARUDAM] Wi-Fi mode enabled");
    Serial.print("[MARUDAM] Backend URL: ");
    Serial.println(BACKEND_URL);
    connectWiFi();
  #endif
}

// ===========================================================================
// LOOP
// ===========================================================================
void loop() {
  #if USE_WIFI
    maintainWiFi();
  #endif

  if (millis() - lastSampleTime >= SAMPLE_INTERVAL_MS) {
    lastSampleTime = millis();

    TwoFieldReadings readings = sensors.readAll();

    if (!readings.is_valid) {
      // Do not transmit completely invalid packets
      return;
    }

    String jsonPayload = generateJsonPayload(readings);

    // Always output pure JSON Line to USB Serial (115200 baud)
    Serial.println(jsonPayload);

    #if USE_WIFI
      // In Wi-Fi mode or BOTH mode, also POST to backend over Wi-Fi
      if (wifiConnected) {
        sendHttpPost(jsonPayload);
      }
    #endif
  }
}