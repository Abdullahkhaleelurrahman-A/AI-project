# Backend Function Inventory

## Main Application (`app/main.py`)

### `legacy_latest(device_id: str)`
- **Purpose:** API route to fetch the latest sensor reading.
- **Inputs:** `device_id`
- **Outputs:** `SensorReading` JSON.
- **Side Effects:** Falls back to `serial_manager.get_last_packet()` if the Supabase fetch fails.

### `chat(request: ChatRequest)`
- **Purpose:** API route for the Gemini integration.
- **Inputs:** `ChatRequest` (contains `message` and `device_id`).
- **Outputs:** JSON string containing the Markdown response.
- **Dependencies:** `ai_service.generate_agronomic_advice`.

## Services

### `serial_manager.py` -> `parse_serial_line(line: str)`
- **Purpose:** Workaround to parse the human-readable ESP32 test sketch output into the expected JSON structure.
- **Inputs:** Raw serial string.
- **State Modified:** Interally updates `_test_buffer`.
- **Outputs:** `ESP32Packet` or `None`.

### `sensor_service.py` -> `normalise_packet(packet: dict)`
- **Purpose:** Validates the raw JSON payload and maps it to the internal backend schema.
- **Dependencies:** Calls `soil_dataset_service` to inject missing static metrics (pH, EC) before processing.

### `adaptive_baseline_service.py` -> `process_reading(reading)`
- **Purpose:** Updates the dynamic baseline algorithms.
- **Outputs:** Updates the in-memory `_baselines` dict.
- **Side Effects:** Triggers periodic batch saves to the `adaptive_baselines` Supabase table (if configured correctly).

### `anomaly_service.py` -> `detect_anomalies(reading)`
- **Purpose:** Compares the normalized reading against the adaptive baseline bounds.
- **Outputs:** `List[AnomalyEvent]`.
- **Side Effects:** Upserts detected anomalies into the `anomalies` Supabase table.

### `ai_service.py` -> `generate_agronomic_advice(device_id, query)`
- **Purpose:** Builds a massive context prompt and invokes Google Gemini.
- **Inputs:** `device_id` (for database lookups), `query` (the user's question).
- **Dependencies:** Requires `GEMINI_API_KEY`. Calls `india_context_service`.
