// =============================================================================
// MARUDAM — ESP32 Dual Soil Moisture Diagnostic Sketch (ADS1115 A0 / A1)
// =============================================================================
// PURPOSE:
//   Reads raw 16-bit ADC values and computed voltages for both soil moisture
//   sensors directly from ADS1115 without applying ANY percentage conversion.
//
// HARDWARE CONNECTIONS:
//   - ESP32 SDA -> GPIO 21
//   - ESP32 SCL -> GPIO 22
//   - ADS1115 VDD -> 3.3V
//   - ADS1115 GND -> GND
//   - ADS1115 A0  -> Soil Moisture Sensor 1 Analog Signal
//   - ADS1115 A1  -> Soil Moisture Sensor 2 Analog Signal
//
// CALIBRATION PROCEDURE (SAFE - NEVER SUBMERGE ELECTRONICS):
//   1. AIR READING (Bone Dry):
//      - Wipe the probe blade completely dry with a tissue.
//      - Hold probe suspended in air (away from hands/metal).
//      - Record the stable MOISTURE_1_RAW and MOISTURE_2_RAW values.
//
//   2. DRY SOIL READING:
//      - Insert probe up to the white guideline into completely dry soil.
//      - Record the values.
//
//   3. MOIST SOIL READING (Target Wet):
//      - Add water to soil sample until evenly moist (not standing puddle).
//      - Insert probe up to the white guideline. Keep top circuitry and ADS1115 dry!
//      - Record the values.
// =============================================================================

#include <Wire.h>
#include <Adafruit_ADS1X15.h>

#define PIN_I2C_SDA      21
#define PIN_I2C_SCL      22
#define ADS1115_I2C_ADDR 0x48

Adafruit_ADS1115 ads;
bool adsConnected = false;

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n==================================================");
  Serial.println("  MARUDAM Soil Moisture Diagnostic Tool");
  Serial.println("==================================================");

  // Initialize I2C on GPIO 21 (SDA) and GPIO 22 (SCL)
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);

  // Initialize ADS1115 at address 0x48
  if (ads.begin(ADS1115_I2C_ADDR)) {
    // GAIN_ONE: +/- 4.096V range, 1 LSB = 0.125mV
    // Safely measures 0 to 3.3V signals without clipping
    ads.setGain(GAIN_ONE);
    adsConnected = true;
    Serial.println("[ADS1115] Connected successfully at 0x48.");
    Serial.println("[ADS1115] Gain set to GAIN_ONE (+/- 4.096V, 0.125mV/bit)");
  } else {
    adsConnected = false;
    Serial.println("[ADS1115] ERROR: ADS1115 not found! Check SDA/SCL wiring and pull-ups.");
  }

  Serial.println("--------------------------------------------------");
  Serial.println("Beginning independent raw channel acquisition...");
  Serial.println("--------------------------------------------------\n");
}

void loop() {
  if (!adsConnected) {
    Serial.println("[ERROR] ADS1115 unavailable. Retrying connection...");
    if (ads.begin(ADS1115_I2C_ADDR)) {
      ads.setGain(GAIN_ONE);
      adsConnected = true;
      Serial.println("[ADS1115] Reconnected successfully!");
    }
    delay(2000);
    return;
  }

  // 1. Read Channel A0 (Sensor 1) independently
  int16_t raw_a0 = ads.readADC_SingleEnded(0);
  float volts_a0 = ads.computeVolts(raw_a0);

  // Small delay between channel muxing for ADC sample-and-hold capacitor settling
  delay(20);

  // 2. Read Channel A1 (Sensor 2) independently
  int16_t raw_a1 = ads.readADC_SingleEnded(1);
  float volts_a1 = ads.computeVolts(raw_a1);

  // 3. Output standard diagnostic format (parsed by FastAPI serial reader and humans)
  Serial.println("------ SENSOR READINGS ------");
  Serial.print("MOISTURE_1_RAW: ");
  Serial.println(raw_a0);
  Serial.printf("Moisture Sensor 1 - A0 raw: %d, voltage: %.3f V\n", raw_a0, volts_a0);

  Serial.print("MOISTURE_2_RAW: ");
  Serial.println(raw_a1);
  Serial.printf("Moisture Sensor 2 - A1 raw: %d, voltage: %.3f V\n", raw_a1, volts_a1);
  Serial.println("-----------------------------");

  // Status checks
  if (raw_a0 <= 100 || volts_a0 < 0.05f) {
    Serial.println("  [NOTICE] Sensor 1 (A0) reading near 0! Check if probe wire is disconnected or shorted to GND.");
  }
  if (raw_a1 <= 100 || volts_a1 < 0.05f) {
    Serial.println("  [NOTICE] Sensor 2 (A1) reading near 0! Check if probe wire is disconnected or shorted to GND.");
  }

  delay(1500); // Sample every 1.5 seconds
}
