# Event Lifecycle

Located in: `backend/app/services/anomaly_service.py` and Database table `anomalies`.

## 1. Event Definition
An event is the stateful aggregation of an anomaly over time. Instead of triggering thousands of alerts for a fluctuating temperature sensor, the system groups them into a single "Event" that opens when the anomaly begins and closes when conditions normalize.

## 2. Event Model Structure
- **id:** UUID.
- **device_id:** The origin ESP32 (e.g., `MARUDAM-01`).
- **sensor:** The specific metric (e.g., `soil_moisture`).
- **anomaly_type:** Directional constraint breach (`HIGH` or `LOW`).
- **severity:** (0.0 to 1.0) Float determining criticalness.
- **status:** `ACTIVE` (ongoing) or `RESOLVED` (normalized).

## 3. The Lifecycle
1. **Creation:** Triggered when Z-score > 3.0. Row inserted with status `ACTIVE`.
2. **Update / Escalation:** As subsequent readings arrive, if Z-score remains > 3.0, the backend performs an `UPSERT`, updating the `severity` to the maximum observed and pushing the `last_seen` timestamp.
3. **Resolution:** When a reading arrives with Z-score < 3.0, the backend queries for `ACTIVE` events for that sensor. It issues an `UPDATE`, changing the status to `RESOLVED` and freezing the timestamp.

## 4. Frontend Integration
The Next.js dashboard uses a dual approach to display events:
1. On initial load, it fetches all recent events via `fetchRecentAnomalies`.
2. It subscribes to Supabase Realtime `INSERT` and `UPDATE` on the `anomalies` table to dynamically push new event cards into the UI without page refreshes.
