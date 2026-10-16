#include <Arduino.h>
#include <ArduinoJson.h>
#include "config.h"
#include "sensors.h"

// =============================================================================
// MARUDAM ESP32 Sensor Node — Two-Field Architecture
// =============================================================================
// PRIMARY COMMUNICATION: USB Serial (115200 baud)
//
// ESP32 -> USB -> FastAPI Backend -> Supabase
//
// SERIAL OUTPUT RULES:
//   - Exactly ONE valid JSON object per line.
//   - Line ends with standard \n.
//   - Absolutely NO human-readable debug text or banners on Serial.
//   - NaN / Infinite sensor values are serialized strictly as JSON `null`.
// =============================================================================

SensorManager sensors(DEVICE_ID);
unsigned long lastSampleTime = 0;

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
// SETUP
// ===========================================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  // Initialize all hardware drivers.
  // Note: Diagnostic text is deliberately suppressed from Serial output.
  sensors.begin();
}

// ===========================================================================
// LOOP
// ===========================================================================
void loop() {
  if (millis() - lastSampleTime >= SAMPLE_INTERVAL_MS) {
    lastSampleTime = millis();

    TwoFieldReadings readings = sensors.readAll();

    if (!readings.is_valid) {
      // Do not transmit completely invalid packets
      return;
    }

    String jsonPayload = generateJsonPayload(readings);

    // ONLY pure JSON goes through USB Serial, exactly one line per reading
    Serial.println(jsonPayload);
  }
}