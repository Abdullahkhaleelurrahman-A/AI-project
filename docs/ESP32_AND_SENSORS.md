# ESP32 and Sensors Documentation

## 1. Hardware Overview
The field data collection node is powered by an ESP32 microcontroller, interfacing with multiple analog and digital sensors to gather environmental conditions.

## 2. Sensor Mapping

| Sensor | Purpose | Interface | Pins / Address |
| :--- | :--- | :--- | :--- |
| **DHT22** | Air Temperature & Humidity | Digital | GPIO 4 |
| **DS18B20** | Soil Temperature | One-Wire | GPIO 18 (with 4.7kΩ pull-up) |
| **BH1750** | Light Intensity (Lux) | I2C | Address `0x23` (SDA: 21, SCL: 22) |
| **ADS1115** | ADC for Analog Sensors | I2C | Address `0x48` (SDA: 21, SCL: 22) |
| **Capacitive Moisture (v1.2)** | Soil Moisture | Analog (via ADS1115) | Channel A0 on ADS1115 |

## 3. Sensor Details & Calculations

### DHT22 (Air Temp & Humidity)
- **Library:** `DHT.h`
- **Output:** Temperature (°C), Humidity (%)
- **Error Handling:** Returns `NaN` if read fails. The firmware captures this and outputs `null` in the JSON payload for that specific metric.

### DS18B20 (Soil Temperature)
- **Library:** `DallasTemperature.h`, `OneWire.h`
- **Output:** Temperature (°C)
- **Pull-up Resistor:** Requires a 4.7kΩ pull-up resistor on the data line.
- **Error Handling:** If reading is `DEVICE_DISCONNECTED_C` (-127.0), the payload outputs `null`.

### BH1750 (Light Lux)
- **Library:** `BH1750.h`
- **Initialization:** `lightMeter.begin(BH1750::CONTINUOUS_HIGH_RES_MODE)`
- **Output:** Lux (float)
- **Error Handling:** If read fails (returns < 0), outputs `null`.

### ADS1115 + Capacitive Soil Moisture Sensor v1.2
- **Library:** `Adafruit_ADS1X15.h`
- **Purpose:** The ESP32's internal ADC is non-linear and noisy. The ADS1115 provides a highly accurate 16-bit analog conversion.
- **Gain:** `GAIN_ONE` (Voltage range: +/- 4.096V)
- **Raw Reading:** `int16_t adc0 = ads.readADC_SingleEnded(0);`
- **Voltage Calculation:** `float volts0 = ads.computeVolts(adc0);`
- **Percentage Calculation:** (Note: this varies based on calibration values set in `config.h`)
  ```cpp
  // INFERRED FROM TYPICAL IMPLEMENTATION
  float moisture = map(volts0, AIR_VOLTAGE, WATER_VOLTAGE, 0, 100);
  moisture = constrain(moisture, 0, 100);
  ```

### pH and EC (Dataset Reference Values)
**CRITICAL CLARIFICATION:** The ESP32 does **NOT** measure pH or EC physically. There are no pH or EC sensors attached to the microcontroller.
- **Implementation:** These values are injected by the backend Python server (`sensor_service.py`) via the `soil_dataset_service.py` based on the configured crop (`farm.crop_id`). 

## 4. Communication Protocol

### Serial Settings
- **Baud Rate:** `115200`
- **Format:** The production sketch outputs exactly one JSON object per line, followed by `\n`.

### JSON Payload Example (Production Sketch)
```json
{
  "device_id": "MARUDAM-01",
  "soil_moisture": 45.2,
  "soil_temperature": 24.5,
  "air_temperature": 31.0,
  "humidity": 65.0,
  "light_lux": 15000.0,
  "sensor_status": {
    "soil_moisture": "ok",
    "soil_temperature": "ok",
    "air_temperature": "ok",
    "humidity": "ok",
    "light_lux": "ok"
  }
}
```

### Deviations (Test Sketch Fallback)
Currently, a test sketch is running on the hardware which outputs:
```text
Air Temperature: 31.40 °C
Humidity: 65.80 %
...
```
The backend `serial_manager.py` implements a fallback parser (`parse_serial_line`) to reconstruct the JSON object from these text lines to prevent the need for immediate reflashing.
