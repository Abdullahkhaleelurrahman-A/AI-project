# Sensor Data Pipeline

This document traces the exact path of a sensor reading from physical measurement to the user's dashboard.

## 1. End-to-End Trace Example (Air Temperature)

1. **Hardware Measurement:** The DHT22 sensor takes a physical measurement.
2. **ESP32 Firmware:** `main.cpp` reads the value via `dht.readTemperature()`.
3. **JSON Construction:** The ESP32 formats the reading into a string, e.g., `"air_temperature": 31.4`.
4. **Serial Transmission:** The ESP32 sends the string over USB Serial (COM6) at 115200 baud.
5. **Backend Ingestion (`serial_manager.py`):** 
   - A background task reads the serial line.
   - It parses the JSON (or human-readable fallback) into an internal dictionary.
   - It instantiates an `ESP32Packet` Pydantic model.
6. **Backend Processing (`sensor_service.py` & `main.py`):**
   - The packet triggers `on_packet_received()`.
   - `device_service.record_reading_received()` updates the device's `last_seen` timestamp.
   - `sensor_service.normalise_packet()` receives the packet.
   - **Dataset Injection:** `soil_dataset_service.py` is queried. Since air temp is a physical sensor, it is kept as-is, but `pH` and `EC` are injected here if missing.
   - It converts `ESP32Packet` to a `SensorReading` object.
7. **Database Persistence (`supabase_service.py`):**
   - The `SensorReading` is inserted into the Supabase `sensor_readings` table via the `SUPABASE_SERVICE_ROLE_KEY`.
8. **Adaptive Baseline (`adaptive_baseline_service.py`):**
   - The reading is compared against the historical `baseline_center` and `max_expected`/`min_expected` for `air_temperature` in `adaptive_baselines`.
   - The baseline distribution is updated incrementally using exponential moving averages.
9. **Anomaly Detection (`anomaly_service.py`):**
   - The reading is compared against the adaptive thresholds.
   - If `31.4` exceeds `max_expected`, an anomaly score is calculated.
   - If severe enough, an event is created/upserted in the `anomalies` table.
10. **Cloud Real-time (Supabase):**
    - Supabase Realtime detects the `INSERT` on `sensor_readings`.
11. **Frontend Receipt (`src/app/dashboard/page.tsx`):**
    - The active Next.js client receives the WebSocket event.
    - `mapSupabaseReading` transforms the database row into the UI state.
    - React triggers a re-render, displaying `31.4 °C` in the Air Temperature card.

## 2. Pipeline Variations by Sensor Type

### Physical Sensors (Temp, Humidity, Lux, Moisture)
Follow the exact flow described above. Values are fully dynamic and dictate adaptive baselines and anomalies.

### Static Reference Sensors (pH, EC)
1. **ESP32:** Does NOT send `soil_ph` or `soil_ec`.
2. **Backend:** `sensor_service.py` queries `soil_dataset_service.get_crop_soil_reference(crop_id)`.
3. **Dataset (CSV):** Calculates the median pH/EC for the specific crop from `backend/data/soil_dataset.csv`.
4. **Injection:** The median values are hardcoded into the `SensorReading` packet before database insertion.
5. **Dashboard:** Displayed exactly like physical sensors, but the value will only change if the underlying crop changes.

## 3. Fallback Data Paths

- **If Supabase Realtime fails:** The frontend `fetchBackend()` loop explicitly polls `http://localhost:8000/api/sensors/latest/{deviceId}` every few seconds (only works if running locally on the same network).
- **If Supabase database is offline:** The backend `supabase_service.py` logs an error, but the pipeline continues. Adaptive baselines fall back to an in-memory dictionary.
- **If a sensor physically disconnects:** The ESP32 sends `null`. The backend Pydantic model parses it as `None`. The Supabase insert receives `NULL`. The frontend displays `--`.
