// =============================================================================
// MARUDAM — Full Multi-Sensor Production Firmware (Arduino IDE Compatible)
// =============================================================================
// HARDWARE SETUP:
//   - ESP32 Microcontroller
//   - ADS1115 ADC: SDA GPIO 21, SCL GPIO 22, Address 0x48 (Gain GAIN_ONE: +/- 4.096V)
//       * ADS1115 A0: Field 1 Capacitive Soil Moisture Sensor
//       * ADS1115 A1: Field 2 Capacitive Soil Moisture Sensor
//   - DS18B20 Temperature Probes: GPIO 4 (OneWire with 4.7k pull-up to 3.3V)
//       * Probe 1: Field 1 Soil Temperature
//       * Probe 2: Field 2 Soil Temperature
//   - DHT22 Sensor: GPIO 27 (Air Temperature and Relative Humidity)
//   - BH1750 Ambient Light Sensor: I2C (0x23)
//
// CALIBRATION INSTRUCTIONS:
//   1. Run marudam_diagnostic.ino to observe stable raw counts for A0 and A1 in air and moist soil.
//   2. Set CALIBRATE_MOISTURE to true once real physical values are entered below.
//   3. Flash this firmware to ESP32.
// =============================================================================

#include <Wire.h>
#include <Adafruit_ADS1X15.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <DHT.h>
#include <BH1750.h>

// ── Pin Configuration ──
#define PIN_I2C_SDA         21
#define PIN_I2C_SCL         22
#define PIN_ONE_WIRE        4
#define PIN_DHT             27
#define DHT_TYPE            DHT22
#define ADS1115_I2C_ADDR    0x48

// ── Moisture Calibration Settings ──
// CALIBRATE_MOISTURE is true so relative moisture percentages are calculated and streamed.
const bool CALIBRATE_MOISTURE = true;

// Field 1 (A0) Calibration Constants (Independent from Field 2):
// Air/Dry ref: 14750 counts (~1.844V), Saturated/Wet ref: 8230 counts (~1.029V)
const int DRY_1 = 14750;
const int WET_1 = 8230;

// Field 2 (A1) Calibration Constants (Independent from Field 1):
// Air/Dry ref: 14650 counts (~1.831V), Saturated/Wet ref: 7936 counts (~0.992V)
const int DRY_2 = 14650;
const int WET_2 = 7936;

// ── Sensor Drivers ──
Adafruit_ADS1115 ads;
OneWire oneWire(PIN_ONE_WIRE);
DallasTemperature dallasSensors(&oneWire);
DHT dht(PIN_DHT, DHT_TYPE);
BH1750 lightMeter;

bool hasADS = false;
bool hasBH1750 = false;
int  ds18b20Count = 0;
DeviceAddress probe1Addr, probe2Addr;

// Helper function to format 64-bit DS18B20 ROM address
String formatRomAddress(DeviceAddress addr) {
  char buf[17];
  snprintf(buf, sizeof(buf), "%02X%02X%02X%02X%02X%02X%02X%02X",
           addr[0], addr[1], addr[2], addr[3],
           addr[4], addr[5], addr[6], addr[7]);
  return String(buf);
}

// ── Safe Moisture Calculation Function ──
// Prevents division by zero, detects disconnected sensors, and respects calibration flag
float calculateMoisturePercent(int16_t raw, float volts, int dryRef, int wetRef, bool isCalibrated) {
  // Disconnected or grounding fault check
  if (raw <= 100 || volts < 0.05f) {
    return NAN; // Missing or disconnected sensor
  }

  // If calibration has not been performed yet, return NAN to show raw voltage/counts on dashboard
  if (!isCalibrated) {
    return NAN;
  }

  // Safety check: Dry must be significantly higher than Wet for capacitive sensors
  int span = dryRef - wetRef;
  if (span <= 200) {
    return NAN; // Invalid calibration configuration (equal or inverted)
  }

  // Calculate percentage: Capacitive sensor voltage decreases as moisture increases
  float pct = 100.0f * (float)(dryRef - raw) / (float)span;

  // Safe clamping strictly after calculation
  return constrain(pct, 0.0f, 100.0f);
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  // 1. Initialize ADS1115
  if (ads.begin(ADS1115_I2C_ADDR)) {
    ads.setGain(GAIN_ONE); // +/- 4.096V range, 0.125mV / LSB
    hasADS = true;
  }

  // 2. Initialize BH1750
  if (lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)) {
    hasBH1750 = true;
  }

  // 3. Initialize DHT22
  dht.begin();

  // 4. Initialize DS18B20
  dallasSensors.begin();
  ds18b20Count = dallasSensors.getDeviceCount();
  if (ds18b20Count >= 1) {
    dallasSensors.getAddress(probe1Addr, 0);
    Serial.print("Probe 1 address: ");
    Serial.println(formatRomAddress(probe1Addr));
  }
  if (ds18b20Count >= 2) {
    dallasSensors.getAddress(probe2Addr, 1);
    Serial.print("Probe 2 address: ");
    Serial.println(formatRomAddress(probe2Addr));
  }
}

void loop() {
  // ── Read Atmospheric Sensors ──
  float airTemp = dht.readTemperature();
  float humidity = dht.readHumidity();
  float lightLux = hasBH1750 ? lightMeter.readLightLevel() : NAN;

  // ── Read ADS1115 Soil Moisture Sensors ──
  int16_t m1_raw = -1;
  float   m1_volts = NAN;
  float   m1_pct   = NAN;

  int16_t m2_raw = -1;
  float   m2_volts = NAN;
  float   m2_pct   = NAN;

  if (hasADS) {
    m1_raw   = ads.readADC_SingleEnded(0);
    m1_volts = ads.computeVolts(m1_raw);
    m1_pct   = calculateMoisturePercent(m1_raw, m1_volts, DRY_1, WET_1, CALIBRATE_MOISTURE);

    delay(20); // Settling delay

    m2_raw   = ads.readADC_SingleEnded(1);
    m2_volts = ads.computeVolts(m2_raw);
    m2_pct   = calculateMoisturePercent(m2_raw, m2_volts, DRY_2, WET_2, CALIBRATE_MOISTURE);
  }

  // ── Read Soil Temperature Probes ──
  float soilTemp1 = NAN;
  float soilTemp2 = NAN;
  if (ds18b20Count > 0) {
    dallasSensors.requestTemperatures();
    if (ds18b20Count >= 1) {
      float t1 = dallasSensors.getTempC(probe1Addr);
      if (t1 != DEVICE_DISCONNECTED_C && !isnan(t1) && t1 > -50.0f) soilTemp1 = t1;
    }
    if (ds18b20Count >= 2) {
      float t2 = dallasSensors.getTempC(probe2Addr);
      if (t2 != DEVICE_DISCONNECTED_C && !isnan(t2) && t2 > -50.0f) soilTemp2 = t2;
    }
  }

  // ── Transmit Streaming Block (Compatible with FastAPI Serial Parser) ──
  Serial.println("------ SENSOR READINGS ------");

  // Moisture Sensor 1
  if (m1_raw > 0) {
    Serial.print("MOISTURE_1_RAW: ");
    Serial.println(m1_raw);
    Serial.printf("Moisture sensor 1 raw value: %d\n", m1_raw);
    Serial.printf("Moisture sensor 1 voltage: %.3f V\n", m1_volts);
    if (!isnan(m1_pct)) {
      Serial.printf("MOISTURE_1_PERCENT: %.1f %%\n", m1_pct);
      Serial.printf("Moisture sensor 1 relative moisture: %.1f%%\n", m1_pct);
    }
  }

  // Moisture Sensor 2
  if (m2_raw > 0) {
    Serial.print("MOISTURE_2_RAW: ");
    Serial.println(m2_raw);
    Serial.printf("Moisture sensor 2 raw value: %d\n", m2_raw);
    Serial.printf("Moisture sensor 2 voltage: %.3f V\n", m2_volts);
    if (!isnan(m2_pct)) {
      Serial.printf("MOISTURE_2_PERCENT: %.1f %%\n", m2_pct);
      Serial.printf("Moisture sensor 2 relative moisture: %.1f%%\n", m2_pct);
    }
  }

  // DS18B20 Probes
  if (!isnan(soilTemp1)) {
    Serial.printf("Soil temperature probe 1: %.2f°C\n", soilTemp1);
    Serial.printf("DS18B20 Probe 1: %.2f C\n", soilTemp1);
  }
  if (!isnan(soilTemp2)) {
    Serial.printf("Soil temperature probe 2: %.2f°C\n", soilTemp2);
    Serial.printf("DS18B20 Probe 2: %.2f C\n", soilTemp2);
  }

  // Atmospheric Environment
  if (!isnan(airTemp))   Serial.printf("Air temperature: %.2f°C\n", airTemp);
  if (!isnan(humidity))  Serial.printf("Air humidity: %.2f %%\n", humidity);
  if (!isnan(lightLux) && lightLux >= 0) Serial.printf("Light intensity: %.2f lux\n", lightLux);

  Serial.println("-----------------------------");

  delay(3000); // Sample interval 3s
}
