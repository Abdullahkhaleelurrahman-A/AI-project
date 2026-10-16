# Anomaly Detection and Event System

Located in: `backend/app/services/anomaly_service.py`

## 1. Detection Logic
The anomaly detection system sits strictly downstream of the Adaptive Baseline system.
It does NOT use static minimums or maximums (e.g. Temp > 40°C).
Instead, it compares every incoming reading against the computed `min_expected` and `max_expected` from the baseline.

### Classification Flow (Pseudocode)
```python
Reading = incoming_sensor_value
Baseline = adaptive_baseline_service.get_baseline(sensor_type)

Z_score = abs(Reading - Baseline.center) / Baseline.MAD_eff

if Z_score > 3.0:
    anomaly_detected = True
    if Reading > Baseline.center:
        direction = "HIGH"
    else:
        direction = "LOW"
    
    severity = min(1.0, (Z_score - 3.0) / 5.0)
else:
    anomaly_detected = False
```

## 2. Event Creation (Stateful)
Anomalies are not just independent blips. They are aggregated into "Events".

1. If an anomaly is detected, the system checks the `anomalies` database table for an open event on that specific sensor for that device.
2. If none exists, a new `Event` is created with status `ACTIVE`.
3. If one exists, the event's `severity` and `last_seen` timestamp are updated.
4. **Resolution:** If the sensor returns to normal range (Z_score < 3.0), the anomaly service updates the event's status to `RESOLVED` and calculates the total duration.

## 3. Database Interaction
- **Table:** `anomalies`
- **Fields:** `id`, `device_id`, `sensor`, `anomaly_type` (HIGH/LOW), `severity`, `value`, `threshold`, `status`, `created_at`, `resolved_at`.
- **Operations:** Read via `eq('status', 'ACTIVE')` to find existing events. Upsert to update or resolve.
