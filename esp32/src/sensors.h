#ifndef SENSORS_H
#define SENSORS_H

#include <Arduino.h>
#include <Wire.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <DHT.h>
#include <BH1750.h>
#include <Adafruit_ADS1X15.h>
#include "config.h"

// =============================================================================
// SENSOR STATUS VALUES
// Every sensor reports explicit state: "ok", "unavailable", or "error".
// =============================================================================
#define SENSOR_OK          "ok"
#define SENSOR_UNAVAILABLE "unavailable"
#define SENSOR_ERROR       "error"

// ─── Field-Specific Soil Measurements ─────────────────────────────────────────
struct FieldSoilReadings {
  String   field_id;
  int16_t  soil_moisture_raw;     // ADS1115 raw 16-bit count (or -1 if error)
  float    soil_moisture_voltage; // Computed voltage (V), NAN if error
  float    soil_moisture;         // Calibrated % (0-100) or NAN if uncalibrated
  float    soil_temperature;      // DS18B20 °C or NAN
  String   ds18b20_address;       // 64-bit hardware address (hex string)
  String   status_moisture;       // "ok" | "unavailable" | "error"
  String   status_temperature;    // "ok" | "unavailable" | "error"
};

// ─── Shared Atmospheric Measurements ──────────────────────────────────────────
struct SharedAtmosphericReadings {
  float  air_temperature;         // DHT22 °C or NAN
  float  humidity;                // DHT22 % RH or NAN
  float  light_lux;               // BH1750 lux or NAN
  String status_air_temperature;  // "ok" | "unavailable" | "error"
  String status_humidity;         // "ok" | "unavailable" | "error"
  String status_light_lux;        // "ok" | "unavailable" | "error"
};

// ─── Complete Sensor Packet ───────────────────────────────────────────────────
struct TwoFieldReadings {
  String                    device_id;
  String                    firmware_version;
  String                    schema_version;
  unsigned long             uptime_ms;
  SharedAtmosphericReadings shared;
  FieldSoilReadings         field_1;
  FieldSoilReadings         field_2;
  String                    status_dht22;
  String                    status_bh1750;
  String                    status_ads1115;
  bool                      is_valid;
};

// =============================================================================
// SENSOR MANAGER CLASS
// Manages sensor discovery, acquisition, and validation across both fields.
// =============================================================================
class SensorManager {
private:
  OneWire*           oneWire;
  DallasTemperature* dallasTemp;
  DHT                dht;
  BH1750             lightMeter;
  Adafruit_ADS1115   ads;

  bool has_ads1115 = false;
  bool has_bh1750  = false;
  bool has_dht     = false;
  bool has_probe_1 = false;
  bool has_probe_2 = false;

  DeviceAddress addr_field_1;
  DeviceAddress addr_field_2;

  String deviceId;

  // Helper: Format 8-byte DeviceAddress to 16-character uppercase hex string
  static String formatAddress(const DeviceAddress addr) {
    char buf[17];
    snprintf(buf, sizeof(buf), "%02X%02X%02X%02X%02X%02X%02X%02X",
             addr[0], addr[1], addr[2], addr[3],
             addr[4], addr[5], addr[6], addr[7]);
    return String(buf);
  }

  // Helper: Check if address is all zeros (unconfigured)
  static bool isZeroAddress(const uint8_t* addr) {
    for (int i = 0; i < 8; i++) {
      if (addr[i] != 0x00) return false;
    }
    return true;
  }

public:
  SensorManager(String id) : deviceId(id), dht(PIN_DHT, DHT_TYPE) {
    memset(addr_field_1, 0, sizeof(DeviceAddress));
    memset(addr_field_2, 0, sizeof(DeviceAddress));
  }

  // ---------------------------------------------------------------------------
  // begin()
  // Initializes all I2C, OneWire, and GPIO sensors.
  // Never outputs human-readable diagnostic text to Serial to maintain
  // pure JSON-Lines protocol integrity.
  // ---------------------------------------------------------------------------
  void begin() {
    // 1. Initialize I2C Bus on GPIO21 (SDA) and GPIO22 (SCL)
    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

    // 2. Initialize ADS1115 16-bit ADC (I2C address 0x48)
    if (ads.begin(ADS1115_I2C_ADDR)) {
      // Set gain to GAIN_ONE (+/- 4.096V range, 1 bit = 0.125mV).
      // With VDD at 3.3V, 0-3.3V input range is mapped safely and accurately.
      ads.setGain(GAIN_ONE);
      has_ads1115 = true;
    } else {
      has_ads1115 = false;
    }

    // 3. Initialize BH1750 Ambient Light Sensor (I2C address 0x23)
    if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) {
      has_bh1750 = true;
    } else {
      has_bh1750 = false;
    }

    // 4. Initialize DHT22 Air Temp & Humidity
    dht.begin();
    has_dht = true;

    // 5. Initialize DS18B20 OneWire Bus on GPIO4
    oneWire = new OneWire(PIN_ONE_WIRE);
    dallasTemp = new DallasTemperature(oneWire);
    dallasTemp->begin();

    // Map DS18B20 probe hardware addresses
    assignProbes();
  }

  // ---------------------------------------------------------------------------
  // assignProbes()
  // Maps 64-bit hardware ROM addresses to Field 1 and Field 2 deterministically.
  // ---------------------------------------------------------------------------
  void assignProbes() {
    int deviceCount = dallasTemp->getDeviceCount();

    // If explicit hardware ROM addresses are provided in config.h, use them
    bool configProbe1Explicit = !isZeroAddress(PROBE_ADDR_FIELD_1);
    bool configProbe2Explicit = !isZeroAddress(PROBE_ADDR_FIELD_2);

    if (configProbe1Explicit) {
      memcpy(addr_field_1, PROBE_ADDR_FIELD_1, sizeof(DeviceAddress));
      has_probe_1 = dallasTemp->isConnected(addr_field_1);
    }
    if (configProbe2Explicit) {
      memcpy(addr_field_2, PROBE_ADDR_FIELD_2, sizeof(DeviceAddress));
      has_probe_2 = dallasTemp->isConnected(addr_field_2);
    }

    // If unconfigured (all zeros), discover available probes deterministically
    if (!configProbe1Explicit && deviceCount >= 1) {
      if (dallasTemp->getAddress(addr_field_1, 0)) {
        has_probe_1 = true;
      }
    }

    if (!configProbe2Explicit && deviceCount >= 2) {
      if (dallasTemp->getAddress(addr_field_2, 1)) {
        has_probe_2 = true;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // readAll()
  // Reads all sensors non-blockingly where practical.
  // Returns structured measurements for shared atmospheric and per-field soil.
  // ---------------------------------------------------------------------------
  TwoFieldReadings readAll() {
    TwoFieldReadings r;
    r.device_id        = deviceId;
    r.firmware_version = FIRMWARE_VERSION;
    r.schema_version   = SCHEMA_VERSION;
    r.uptime_ms        = millis();

    // ── 1. Shared Atmospheric Readings (DHT22 & BH1750) ──────────────────────
    if (has_dht) {
      float t = dht.readTemperature();
      float h = dht.readHumidity();
      if (isnan(t) || isnan(h)) {
        r.shared.air_temperature        = NAN;
        r.shared.humidity               = NAN;
        r.shared.status_air_temperature = SENSOR_ERROR;
        r.shared.status_humidity        = SENSOR_ERROR;
        r.status_dht22                  = SENSOR_ERROR;
      } else {
        r.shared.air_temperature        = t;
        r.shared.humidity               = h;
        r.shared.status_air_temperature = SENSOR_OK;
        r.shared.status_humidity        = SENSOR_OK;
        r.status_dht22                  = SENSOR_OK;
      }
    } else {
      r.shared.air_temperature        = NAN;
      r.shared.humidity               = NAN;
      r.shared.status_air_temperature = SENSOR_UNAVAILABLE;
      r.shared.status_humidity        = SENSOR_UNAVAILABLE;
      r.status_dht22                  = SENSOR_UNAVAILABLE;
    }

    if (has_bh1750) {
      float lux = lightMeter.readLightLevel();
      if (lux < 0.0f) {
        r.shared.light_lux         = NAN;
        r.shared.status_light_lux  = SENSOR_ERROR;
        r.status_bh1750            = SENSOR_ERROR;
      } else {
        r.shared.light_lux         = lux;
        r.shared.status_light_lux  = SENSOR_OK;
        r.status_bh1750            = SENSOR_OK;
      }
    } else {
      r.shared.light_lux         = NAN;
      r.shared.status_light_lux  = SENSOR_UNAVAILABLE;
      r.status_bh1750            = SENSOR_UNAVAILABLE;
    }

    // ── 2. ADS1115 Soil Moisture Readings (A0 -> Field 1, A1 -> Field 2) ─────
    r.field_1.field_id = FIELD_1_ID;
    r.field_2.field_id = FIELD_2_ID;

    if (has_ads1115) {
      r.status_ads1115 = SENSOR_OK;

      // Field 1 Moisture (A0)
      int16_t raw0 = ads.readADC_SingleEnded(ADS_CH_FIELD_1);
      float v0 = ads.computeVolts(raw0);
      r.field_1.soil_moisture_raw     = raw0;
      r.field_1.soil_moisture_voltage = v0;
      r.field_1.status_moisture       = SENSOR_OK;

      #if CALIBRATE_MOISTURE
        float m1 = ((FIELD_1_VOLT_DRY - v0) / (FIELD_1_VOLT_DRY - FIELD_1_VOLT_WET)) * 100.0f;
        r.field_1.soil_moisture = constrain(m1, 0.0f, 100.0f);
      #else
        r.field_1.soil_moisture = NAN; // Leave null until calibrated
      #endif

      // Field 2 Moisture (A1)
      int16_t raw1 = ads.readADC_SingleEnded(ADS_CH_FIELD_2);
      float v1 = ads.computeVolts(raw1);
      r.field_2.soil_moisture_raw     = raw1;
      r.field_2.soil_moisture_voltage = v1;
      r.field_2.status_moisture       = SENSOR_OK;

      #if CALIBRATE_MOISTURE
        float m2 = ((FIELD_2_VOLT_DRY - v1) / (FIELD_2_VOLT_DRY - FIELD_2_VOLT_WET)) * 100.0f;
        r.field_2.soil_moisture = constrain(m2, 0.0f, 100.0f);
      #else
        r.field_2.soil_moisture = NAN; // Leave null until calibrated
      #endif
    } else {
      r.status_ads1115                = SENSOR_UNAVAILABLE;
      r.field_1.soil_moisture_raw     = -1;
      r.field_1.soil_moisture_voltage = NAN;
      r.field_1.soil_moisture         = NAN;
      r.field_1.status_moisture       = SENSOR_UNAVAILABLE;

      r.field_2.soil_moisture_raw     = -1;
      r.field_2.soil_moisture_voltage = NAN;
      r.field_2.soil_moisture         = NAN;
      r.field_2.status_moisture       = SENSOR_UNAVAILABLE;
    }

    // ── 3. DS18B20 Soil Temperature Probes ───────────────────────────────────
    dallasTemp->requestTemperatures();

    // Probe 1 -> Field 1
    if (has_probe_1) {
      r.field_1.ds18b20_address = formatAddress(addr_field_1);
      float t1 = dallasTemp->getTempC(addr_field_1);
      if (t1 == DEVICE_DISCONNECTED_C || isnan(t1) || t1 < -55.0f || t1 > 125.0f) {
        r.field_1.soil_temperature   = NAN;
        r.field_1.status_temperature = SENSOR_ERROR;
      } else {
        r.field_1.soil_temperature   = t1;
        r.field_1.status_temperature = SENSOR_OK;
      }
    } else {
      r.field_1.ds18b20_address    = "";
      r.field_1.soil_temperature   = NAN;
      r.field_1.status_temperature = SENSOR_UNAVAILABLE;
    }

    // Probe 2 -> Field 2
    if (has_probe_2) {
      r.field_2.ds18b20_address = formatAddress(addr_field_2);
      float t2 = dallasTemp->getTempC(addr_field_2);
      if (t2 == DEVICE_DISCONNECTED_C || isnan(t2) || t2 < -55.0f || t2 > 125.0f) {
        r.field_2.soil_temperature   = NAN;
        r.field_2.status_temperature = SENSOR_ERROR;
      } else {
        r.field_2.soil_temperature   = t2;
        r.field_2.status_temperature = SENSOR_OK;
      }
    } else {
      r.field_2.ds18b20_address    = "";
      r.field_2.soil_temperature   = NAN;
      r.field_2.status_temperature = SENSOR_UNAVAILABLE;
    }

    // ── 4. Packet Validity ───────────────────────────────────────────────────
    // Valid if at least one sensor returned a readable measurement
    bool soil1_ok = (r.field_1.status_moisture == SENSOR_OK) || (r.field_1.status_temperature == SENSOR_OK);
    bool soil2_ok = (r.field_2.status_moisture == SENSOR_OK) || (r.field_2.status_temperature == SENSOR_OK);
    bool env_ok   = (r.shared.status_air_temperature == SENSOR_OK) || (r.shared.status_light_lux == SENSOR_OK);

    r.is_valid = soil1_ok || soil2_ok || env_ok;
    return r;
  }
};

#endif // SENSORS_H
