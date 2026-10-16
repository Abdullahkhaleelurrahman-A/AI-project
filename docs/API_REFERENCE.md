# API Reference

The MARUDAM backend (`main.py`) exposes several REST endpoints built with FastAPI.

## 1. Sensor Endpoints

### `GET /api/sensors/latest/{device_id}`
- **Purpose:** Fetches the single most recent `SensorReading`.
- **Flow:** Queries Supabase `sensor_readings` table. If successful, returns the enriched row (including pH/EC). If missing, falls back to the local `serial_manager.get_last_packet()` in memory.
- **Used By:** Frontend Dashboard fallback polling.

### `GET /api/sensors/history/{device_id}`
- **Purpose:** Fetches the last N readings for a device.
- **Parameters:** `limit` (default 100).
- **Used By:** History and Charts UI.

## 2. Event & Anomaly Endpoints

### `GET /api/events/{device_id}`
- **Purpose:** Returns the active and recently resolved anomalies for the device.
- **Flow:** Queries Supabase `anomalies` table where `device_id` matches, ordered by `created_at` DESC.

### `GET /api/baseline/{device_id}`
- **Purpose:** Exposes the current internal state of the adaptive baselines.
- **Returns:** JSON object containing `center`, `min_expected`, `max_expected`, and `confidence` for every sensor type.
- **Fallback:** If the `adaptive_baselines` table is offline, returns the transient in-memory state.

## 3. Decision & AI Endpoints

### `GET /api/decision/{device_id}`
- **Purpose:** Returns the holistic risk score and static recommendations based purely on rule-based anomalies.
- **Returns:** `{ "risk_level": "HIGH", "recommendation": "Irrigate immediately." }`

### `POST /api/chat`
- **Purpose:** Invokes Google Gemini for contextual agronomic advice.
- **Payload:** `{ "message": "Why is my soil moisture low?", "device_id": "FIELD_001" }`
- **Flow:** The backend intercepts the prompt, silently appends the `india_context`, active `anomalies`, and latest `sensor_readings`, then forwards it to the Gemini API.

## 4. Status Endpoints

### `GET /api/status/{device_id}`
- **Purpose:** Returns device connectivity status.
- **Returns:** `{ "status": "CONNECTED", "last_seen": "...", "age_seconds": 12 }`
- **Logic:** `ONLINE` (< 60s), `STALE` (< 600s), `OFFLINE` (> 600s).
