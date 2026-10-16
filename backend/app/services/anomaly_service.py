# =============================================================================
# MARUDAM Backend — Anomaly Service (Two-Field Supported)
# =============================================================================
# Ported and adapted from the original SQLite-based decision engine (legacy/).
#
# Architecture: TWO PATHS
#
#   FAST PATH (this file, every packet):
#     - Read pre-computed baseline ranges from adaptive_baseline_service per field
#     - Compare reading to range
#     - Track anomaly persistence / evidence per field
#     - Multi-sensor evidence fusion
#     - Write anomaly events to Supabase with explicit field_id
#     - NEVER runs expensive historical recalculation
#
#   ADAPTIVE PATH (adaptive_baseline_service, periodic):
#     - Computes Median + MAD robust baseline per field
#     - Updates baseline ranges in memory + Supabase
#     - Called from background asyncio task in main.py
#
# Baseline calculation: B_s = Median(X_s)  [in adaptive_baseline_service]
# Adaptive update:      B_{t+1} = (1-α_t)B_t + α_t X_t  [in adaptive_baseline_service]
# =============================================================================
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from app.config import settings
from app.models.sensor import SensorReading
from app.utils.logger import get_logger
import app.services.supabase_service as supa
import app.services.adaptive_baseline_service as adaptive

logger = get_logger("anomaly_service")


# ─── Risk Levels ─────────────────────────────────────────────────────────────
RISK_LEVELS = ["NORMAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"]


# ─── Evidence ────────────────────────────────────────────────────────────────

@dataclass
class Evidence:
    code:    str
    sensor:  Optional[str] = None
    value:   Optional[float] = None
    message: str = ""


# ─── Anomaly Result ───────────────────────────────────────────────────────────

@dataclass
class AnomalyResult:
    """Result of anomaly analysis for a single sensor reading packet and field."""
    device_id:      str
    field_id:       str = "field_1"
    timestamp:      datetime = field(default_factory=lambda: datetime.now(tz=timezone.utc))
    risk_level:     str = "NORMAL"
    evidence:       list[Evidence] = field(default_factory=list)
    event_ids:      list[str] = field(default_factory=list)
    field_status:   str = "NORMAL"      # NORMAL | WATCH | ATTENTION | UNCERTAIN
    recommendation: str = "MONITOR"


SENSORS_TO_MONITOR = [
    "soil_moisture",
    "soil_temperature",
    "air_temperature",
    "humidity",
    "light_lux",
]

# ─── In-memory persistence counters (fast path only) ─────────────────────────
# Track consecutive anomalies per sensor per device:field composite key.
_persistence: dict[str, dict[str, int]] = {}

# Rolling anomaly rate tracker (last N readings per device:field)
_ANOMALY_RATE_WINDOW = 100
_anomaly_window: dict[str, list[bool]] = {}


def _get_key(device_id: str, field_id: str = "field_1") -> str:
    return f"{device_id}:{field_id}"


def _get_persistence(key: str, sensor: str) -> int:
    return _persistence.get(key, {}).get(sensor, 0)


def _set_persistence(key: str, sensor: str, count: int) -> None:
    _persistence.setdefault(key, {})[sensor] = count


def _push_anomaly_window(key: str, is_anomalous: bool) -> float:
    """Update rolling anomaly rate and return current rate [0,1]."""
    w = _anomaly_window.setdefault(key, [])
    w.append(is_anomalous)
    if len(w) > _ANOMALY_RATE_WINDOW:
        w.pop(0)
    return sum(w) / len(w) if w else 0.0


# =============================================================================
# MAIN ANOMALY DETECTION — FAST PATH
# =============================================================================

def detect(reading: SensorReading) -> AnomalyResult:
    """
    Main anomaly detection entry point.
    Analyses one SensorReading for a specific field using pre-computed baseline
    ranges from adaptive_baseline_service, updates field persistence counters,
    and returns an AnomalyResult. Also writes detected anomalies to Supabase.
    """
    device_id = reading.device_id
    field_id  = getattr(reading, "field_id", "field_1") or "field_1"
    key       = _get_key(device_id, field_id)

    result = AnomalyResult(
        device_id=device_id,
        field_id=field_id,
        timestamp=reading.timestamp,
    )

    max_risk_idx = 0
    packet_has_anomaly = False

    sensor_values: dict[str, Optional[float]] = {
        "soil_moisture":    reading.soil_moisture,
        "soil_temperature": reading.soil_temperature,
        "air_temperature":  reading.air_temperature,
        "humidity":         reading.humidity,
        "light_lux":        reading.light_lux,
    }

    # ── Per-sensor fast-path detection ────────────────────────────────────────
    for sensor, value in sensor_values.items():
        if value is None:
            continue

        # Get pre-computed baseline ranges for this field (O(1) — no DB)
        lo, hi = adaptive.get_sensor_range(device_id, sensor, field_id=field_id)
        center = (lo + hi) / 2.0

        is_out = not (lo <= value <= hi)

        # Update adaptive service's evidence counters for this field
        if lo > 0 and hi > lo:
            mad_approx = (hi - lo) / (2.0 * adaptive.SENSOR_K.get(sensor, 3.0))
            dev_mads   = abs(value - center) / max(mad_approx, 1e-6) if mad_approx > 0 else 0.0
        else:
            dev_mads = 0.0

        adaptive.record_anomaly_evidence(device_id, sensor, is_out, dev_mads, field_id=field_id)

        if is_out:
            persistence = _get_persistence(key, sensor) + 1
            _set_persistence(key, sensor, persistence)
            dev = value - center
            packet_has_anomaly = True

            # Risk escalates with persistence
            if persistence >= 5:
                risk_idx = 4   # CRITICAL
            elif persistence >= 3:
                risk_idx = 3   # HIGH
            elif persistence >= 2:
                risk_idx = 2   # MEDIUM
            else:
                risk_idx = 1   # LOW

            max_risk_idx = max(max_risk_idx, risk_idx)

            ev = Evidence(
                code    = f"{sensor.upper()}_{'ABOVE' if dev > 0 else 'BELOW'}_BASELINE",
                sensor  = sensor,
                value   = value,
                message = (
                    f"[{field_id}] {sensor} = {value:.1f} "
                    f"(expected: {lo:.1f}–{hi:.1f}, "
                    f"persistence={persistence})"
                ),
            )
            result.evidence.append(ev)

            anomaly_id = supa.upsert_anomaly(
                device_id      = device_id,
                sensor         = sensor,
                observed_value = value,
                expected_value = center,
                deviation      = dev,
                risk_level     = RISK_LEVELS[risk_idx],
                message        = ev.message,
                field_id       = field_id,
            )
            if anomaly_id:
                result.event_ids.append(anomaly_id)
                
            logger.info(
                f"Anomaly [{RISK_LEVELS[risk_idx]}] {ev.code} on {field_id}: "
                f"{value:.1f} (persistence={persistence})"
            )

        else:
            # In-range — reset persistence counter for this field & sensor
            _set_persistence(key, sensor, 0)

    # ── Rolling anomaly rate → push to adaptive service ───────────────────────
    current_rate = _push_anomaly_window(key, packet_has_anomaly)
    adaptive.update_anomaly_rate(device_id, current_rate, field_id=field_id)

    # ── Multi-sensor fusion: water stress indicator for this field ───────────
    sm  = sensor_values.get("soil_moisture")
    at  = sensor_values.get("air_temperature")
    rh  = sensor_values.get("humidity")

    sm_lo, sm_hi = adaptive.get_sensor_range(device_id, "soil_moisture", field_id=field_id)
    at_lo, at_hi = adaptive.get_sensor_range(device_id, "air_temperature", field_id=field_id)
    rh_lo, rh_hi = adaptive.get_sensor_range(device_id, "humidity", field_id=field_id)

    water_stress_signals = 0
    if sm is not None and sm < sm_lo:
        water_stress_signals += 1
    if at is not None and at > at_hi:
        water_stress_signals += 1
    if rh is not None and rh < rh_lo:
        water_stress_signals += 1

    if water_stress_signals >= 2:
        result.evidence.append(Evidence(
            code    = "WATER_STRESS_MULTI_SENSOR",
            message = f"[{field_id}] Water stress indicated by {water_stress_signals} concurrent sensors",
        ))
        max_risk_idx = max(max_risk_idx, 2)   # at least MEDIUM for fusion

    # ── Finalize result ───────────────────────────────────────────────────────
    result.risk_level = RISK_LEVELS[max_risk_idx]

    if max_risk_idx == 0:
        result.field_status   = "NORMAL"
        result.recommendation = "MONITOR"
    elif max_risk_idx <= 2:
        result.field_status   = "WATCH"
        result.recommendation = "OBSERVE"
    elif max_risk_idx == 3:
        result.field_status   = "ATTENTION"
        result.recommendation = "CONSIDER_IRRIGATION" if water_stress_signals >= 1 else "CHECK_FIELD"
    else:
        result.field_status   = "CRITICAL"
        result.recommendation = "IMMEDIATE_ACTION"

    if result.risk_level != "NORMAL":
        logger.info(
            f"Analysis complete for {field_id}: {result.field_status} / {result.risk_level} / "
            f"{result.recommendation} | {len(result.evidence)} evidence items"
        )

    return result


# =============================================================================
# PUBLIC API — kept for backward compatibility
# =============================================================================

def get_baselines(device_id: Optional[str] = None, field_id: str = "field_1") -> dict:
    """Return the full adaptive baseline state for a device and field."""
    from app.config import settings as cfg
    did = device_id or cfg.device_id
    return adaptive.get_full_baseline_state(did, field_id=field_id)
