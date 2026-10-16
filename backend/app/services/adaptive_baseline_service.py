# =============================================================================
# MARUDAM Backend — Context-Aware Adaptive Baseline Service
# =============================================================================
#
# Architecture: TWO PATHS
#
#   FAST PATH  (every ESP32 packet, called from detect()):
#     → Read pre-computed baseline ranges from _device_states (O(1), no DB)
#     → Compare reading to range
#     → Increment anomaly evidence counters
#     → Return result
#
#   ADAPTIVE PATH (periodic background task, every T_update hours):
#     → fetch bounded history (max HISTORY_LIMIT rows, never full-table scan)
#     → calculate Median + MAD robust baseline
#     → calculate normalised CV + rate-of-change variability
#     → calculate sensor data quality (S) — NO dependency on T_create
#     → calculate time-of-day weighted coverage
#     → calculate context change (C)
#     → calculate weather variability (W) if observations available
#     → re-weight available factors (missing weather → renormalise, NOT W=0)
#     → calculate T_create and T_update with renormalised weights
#     → calculate confidence with early-learning ceiling
#     → calculate dynamic alpha_t (two modes: normal / confirmed regime)
#     → upsert Supabase
#     → refresh in-memory cache
#
# Mathematical model (MARUDAM prototype — coefficients are not universal):
#
#   B_s       = Median(X_s)
#   MAD_eff_s = max(Median(|X_s − B_s|), MAD_MIN_s)       ← zero-MAD fix
#   Range_s   = [B_s − K_s*MAD_eff_s, B_s + K_s*MAD_eff_s]  ∩  physical_limits
#
#   CV_s      = StdDev(X_s) / max(|Mean(X_s)|, ε)
#   Rate_s    = Mean(|X_t − X_{t-1}|)
#   N_CV_s    = clip(CV_s / CV_REF_s,   0, 1)
#   N_Rate_s  = clip(Rate_s / Rate_REF_s, 0, 1)
#   V_s       = w_cv * N_CV_s + w_rate * N_Rate_s
#   V         = weighted_avg(V_s) over AVAILABLE sensors only
#
#   S         = weighted(missing_rate, invalid_rate, jump_rate, sample_ratio)
#               — does NOT depend on T_create (no circular dependency)
#
#   TOD_cov   = mean over 24 h of clip(samples_in_h / TOD_REF_SAMPLES, 0, 1)
#
#   Confidence = weighted(sample_cov, time_cov, tod_cov, S, anomaly_clean,
#                         context_complete) with early-learning ceilings
#               — weather unavailability REDUCES context_complete
#
#   T_create  = clip(T0*(1 + Σ_i w_i*f_i / Σ_i w_i), Tmin, Tmax)
#               where the sum is over AVAILABLE factors only (weather excluded
#               when unavailable, weights renormalised)
#
#   T_update  = clip(K_u / (ε + Σ_i w_i*f_i / Σ_i w_i), Tmin, Tmax)
#               with hysteresis (0.8 * prev + 0.2 * new)
#               and max-change-per-step cap (25%)
#
#   alpha_normal = clip(ALPHA_BASE * conf * stability * ctx, MIN, MAX)
#   alpha_regime = clip(ALPHA_BASE_REGIME * conf, MIN, ALPHA_REGIME_MAX)
#               — alpha_regime used ONLY after confirmed regime change
#
#   Regime change confirmed only when:
#     persistence ≥ ANOMALY_PERSIST_MIN samples
#     AND duration  ≥ REGIME_MIN_PERSISTENCE_HOURS
#     AND magnitude ≥ REGIME_MAGNITUDE_MIN_MAD × MAD_eff
#     AND quality   ≥ SENSOR_QUALITY_THRESHOLD
#     AND (multi-sensor support OR independently-reliable sensor)
#
# All coefficients labelled MARUDAM PROTOTYPE DEFAULT.
# pH/EC are NOT required. Weather is NOT required.
# =============================================================================
from __future__ import annotations

import asyncio
import statistics
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from typing import Any, Optional

from app.utils.logger import get_logger
import app.services.supabase_service as supa

logger = get_logger("adaptive_baseline")


# =============================================================================
# CONSTANTS — MARUDAM PROTOTYPE DEFAULTS — ALL CONFIGURABLE HERE
# =============================================================================

# ─── Sensors tracked ─────────────────────────────────────────────────────────
MONITORED_SENSORS = [
    "soil_moisture",
    "soil_temperature",
    "air_temperature",
    "humidity",
    "light_lux",
]

# ─── Sensor-specific K multipliers for MAD expected-range ────────────────────
# FinalRange_s = [center − K_s * MAD_eff_s, center + K_s * MAD_eff_s]
SENSOR_K: dict[str, float] = {
    "soil_moisture":    3.0,
    "soil_temperature": 3.0,
    "air_temperature":  3.0,
    "humidity":         3.0,
    "light_lux":        3.5,
}

# ─── Minimum effective MAD (prevents zero-width range on stable sensors) ─────
# MAD_eff_s = max(MAD_s, MAD_MIN_s)
MAD_MIN: dict[str, float] = {
    "soil_moisture":    0.5,
    "soil_temperature": 0.2,
    "air_temperature":  0.2,
    "humidity":         0.5,
    "light_lux":        200.0,
}

# ─── Physical safety limits (crop-neutral hard floor/ceiling) ────────────────
# Final range is INTERSECTED with these — they are never violated.
PHYSICAL_LIMITS: dict[str, dict] = {
    "soil_moisture":    {"min": 0.0,   "max": 100.0},
    "soil_temperature": {"min": -10.0, "max": 60.0},
    "air_temperature":  {"min": -20.0, "max": 65.0},
    "humidity":         {"min": 0.0,   "max": 100.0},
    "light_lux":        {"min": 0.0,   "max": 200000.0},
}

# ─── Crop/growth-stage soft priors ───────────────────────────────────────────
# Applied AFTER statistical calculation as a tighter constraint.
# Key format: "crop_id:growth_stage"
# These are PRIORS/CONSTRAINTS, not baselines.
CROP_PRIORS: dict[str, dict[str, tuple]] = {
    "tomato:seedling":   {"soil_moisture": (55, 70), "air_temperature": (22, 30)},
    "tomato:vegetative": {"soil_moisture": (50, 70), "air_temperature": (24, 32)},
    "tomato:flowering":  {"soil_moisture": (60, 80), "air_temperature": (20, 28)},
    "tomato:fruiting":   {"soil_moisture": (55, 75), "air_temperature": (22, 30)},
    "rice:tillering":    {"soil_moisture": (80, 100)},
    "wheat:vegetative":  {"soil_moisture": (40, 65), "air_temperature": (15, 25)},
}

SENSITIVE_STAGES = frozenset(
    ["flowering", "fruiting", "panicle", "pod_dev", "boll_dev"]
)

# ─── Impossible-jump thresholds (per reading pair) ───────────────────────────
MAX_JUMP: dict[str, float] = {
    "soil_moisture":    30.0,
    "soil_temperature": 15.0,
    "air_temperature":  15.0,
    "humidity":         40.0,
    "light_lux":        80000.0,
}

# ─── Variability: within-sensor weights (w_cv + w_rate = 1) ──────────────────
W_CV   = 0.60
W_RATE = 0.40

# ─── Variability: CV reference normalisation values ───────────────────────────
# N_CV_s = clip(CV_s / CV_REFERENCE_s, 0, 1)
CV_REFERENCE: dict[str, float] = {
    "soil_moisture":    0.20,
    "soil_temperature": 0.15,
    "air_temperature":  0.15,
    "humidity":         0.20,
    "light_lux":        0.50,
}

# ─── Variability: rate-of-change reference normalisation values ───────────────
# N_Rate_s = clip(Rate_s / RATE_REFERENCE_s, 0, 1)
RATE_REFERENCE: dict[str, float] = {
    "soil_moisture":    5.0,
    "soil_temperature": 2.0,
    "air_temperature":  3.0,
    "humidity":         5.0,
    "light_lux":        10000.0,
}

# ─── Variability: cross-sensor weights (available sensors only) ───────────────
VARIABILITY_WEIGHTS: dict[str, float] = {
    "soil_moisture":    0.30,
    "soil_temperature": 0.25,
    "air_temperature":  0.20,
    "humidity":         0.15,
    "light_lux":        0.10,
}

# ─── Data quality (S) component weights ──────────────────────────────────────
# S does NOT depend on T_create — no circular dependency.
S_W_MISSING  = 0.30
S_W_INVALID  = 0.25
S_W_JUMP     = 0.25
S_W_SAMPLE   = 0.20   # sample count relative to MIN_SAMPLES_ACTIVE

# ─── Time-of-day coverage ────────────────────────────────────────────────────
# TOD_cov = mean_over_24h of clip(samples_in_hour / TOD_REF_SAMPLES, 0, 1)
TOD_REF_SAMPLES = 20   # reference: 20 samples per hour-bucket = full coverage
TOD_MIN_SAMPLES = 10   # below → lambda_tod = 0 (fall back to overall baseline)
TOD_MAX_SAMPLES = 50   # at or above → lambda_tod = 1 (use segment baseline)
# Sensors with strong diurnal cycles
DIURNAL_SENSORS = frozenset(["air_temperature", "humidity", "light_lux"])

# ─── Confidence weights ───────────────────────────────────────────────────────
CONF_W_SAMPLE   = 0.25   # sample count coverage
CONF_W_TIME     = 0.25   # elapsed time / T_create
CONF_W_TOD      = 0.15   # time-of-day spread
CONF_W_QUALITY  = 0.20   # sensor data quality (S)
CONF_W_ANOMALY  = 0.10   # anomaly cleanliness
CONF_W_CONTEXT  = 0.05   # context completeness (weather unavailability penalised here)

# ─── Confidence early-learning ceilings ──────────────────────────────────────
# (time_coverage_fraction, max_confidence_score)
CONF_CEIL: list[tuple[float, int]] = [
    (0.10, 25),
    (0.25, 50),
    (0.50, 75),
]

# ─── T_create formula factor weights (BEFORE renormalisation) ────────────────
# When a factor is unavailable (e.g. weather), it is excluded and the
# remaining weights are renormalised — weather_unavailable ≠ W=0.
T0_DAYS = 7.0
T_CREATE_FACTORS: dict[str, float] = {
    "variability":   1.00,   # alpha in the spec
    "weather":       0.75,   # beta
    "anomaly_rate":  0.50,   # gamma
    "context_change":0.50,   # delta
    "quality_lack":  0.50,   # eta (applied as 1 - S)
}
T_CREATE_MIN_H = 3.0  * 24.0
T_CREATE_MAX_H = 45.0 * 24.0

# ─── T_update formula factor weights (BEFORE renormalisation) ────────────────
K_UPDATE   = 12.0
U_EPSILON  = 0.01
T_UPDATE_FACTORS: dict[str, float] = {
    "variability":    1.00,
    "weather":        0.75,
    "anomaly_rate":   0.50,
    "context_change": 0.50,
}
T_UPDATE_MIN_H        = 3.0
T_UPDATE_MAX_H        = 48.0
UPDATE_HYSTERESIS     = 0.80   # weight of previous interval
UPDATE_MAX_CHANGE_PCT = 0.25   # max fractional change per recalculation

# ─── Dynamic alpha — normal in-range adaptation ───────────────────────────────
ALPHA_BASE = 0.05
ALPHA_MIN  = 0.005
ALPHA_MAX  = 0.15
ALPHA_SENSITIVE_STAGE_FACTOR = 0.50

# ─── Dynamic alpha — confirmed regime-change adaptation ───────────────────────
# Only used after regime_change_confirmed() returns True.
ALPHA_BASE_REGIME  = 0.10
ALPHA_REGIME_MAX   = 0.25

# ─── Anomaly/regime-change protection thresholds ─────────────────────────────
ANOMALY_PERSIST_MIN            = 5      # consecutive anomalous readings minimum
REGIME_MIN_PERSISTENCE_HOURS  = 1.0    # minimum real-time duration of anomaly window
REGIME_CHANGE_THRESH           = 10     # total samples in window to confirm
REGIME_MAGNITUDE_MIN_MAD       = 1.5   # must be ≥ this many MADs from center
MULTISENSOR_SUPPORT_MIN        = 1      # other sensors also anomalous
SENSOR_QUALITY_THRESHOLD       = 0.50  # minimum S for single-sensor regime claim
INDEPENDENTLY_RELIABLE_S       = 0.85  # S threshold to skip multi-sensor requirement

# ─── Context change rebuild threshold ────────────────────────────────────────
CONTEXT_CHANGE_REBUILD_THRESHOLD = 0.60

# ─── Status thresholds ───────────────────────────────────────────────────────
MIN_SAMPLES_ACTIVE    = 100
MIN_TIME_FRAC_ACTIVE  = 0.50
MIN_CONFIDENCE_ACTIVE = 50

# ─── Bounded history window ───────────────────────────────────────────────────
HISTORY_LIMIT = 2016   # ~7 days at 5-min intervals; hard cap, never full table


# =============================================================================
# DATA STRUCTURES
# =============================================================================

@dataclass
class SensorBaselineState:
    """Per-sensor baseline state — held in memory and persisted to Supabase."""
    sensor:                   str
    center:                   float
    mad:                      float          # raw MAD (may be 0)
    mad_eff:                  float          # max(mad, MAD_MIN_s)
    k_multiplier:             float
    min_expected:             float
    max_expected:             float
    confidence:               float          = 0.0   # 0–100
    observations:             int            = 0
    variability_score:        float          = 0.0
    anomaly_rate:             float          = 0.0
    sensor_quality:           float          = 1.0
    creation_period_hours:    float          = T0_DAYS * 24.0
    update_interval_hours:    float          = K_UPDATE
    learning_started_at:      Optional[datetime] = None
    learning_completed_at:    Optional[datetime] = None
    next_update_at:           Optional[datetime] = None
    baseline_status:          str            = "LEARNING"
    context_snapshot:         dict           = field(default_factory=dict)
    anomaly_evidence_count:   int            = 0
    tod_coverage_json:        dict           = field(default_factory=dict)
    explanation_json:         dict           = field(default_factory=dict)
    # In-memory only (not persisted — reset on restart, safe to do so)
    _alpha_t:                 float          = ALPHA_BASE
    _prev_update_interval:    float          = T_UPDATE_MAX_H
    _consecutive_anomalies:   int            = 0
    _last_anomaly_magnitude:  float          = 0.0
    _anomaly_first_seen_at:   Optional[datetime] = None


@dataclass
class DeviceBaselineState:
    """All-sensor state for one device."""
    device_id:             str
    sensors:               dict[str, SensorBaselineState] = field(default_factory=dict)
    learning_started_at:   Optional[datetime] = None
    overall_status:        str            = "LEARNING"
    confidence:            float          = 0.0
    overall_variability:   float          = 0.0
    weather_variability:   Optional[float] = None
    weather_status:        str            = "weather_data_unavailable"
    anomaly_rate:          float          = 0.0
    sensor_quality:        float          = 1.0
    creation_period_hours: float          = T0_DAYS * 24.0
    update_interval_hours: float          = K_UPDATE
    next_update_at:        Optional[datetime] = None
    explanation:           dict           = field(default_factory=dict)
    context_snapshot:      dict           = field(default_factory=dict)


# =============================================================================
# IN-MEMORY STORE
# =============================================================================

_device_states: dict[str, DeviceBaselineState] = {}


def _state_key(device_id: str, field_id: str = "field_1") -> str:
    """Helper to form composite key per device and field for complete data isolation."""
    return f"{device_id}:{field_id}" if field_id else device_id


def _get_or_create_state(device_id: str, field_id: str = "field_1") -> DeviceBaselineState:
    key = _state_key(device_id, field_id)
    if key not in _device_states:
        _device_states[key] = DeviceBaselineState(
            device_id=device_id,
            learning_started_at=datetime.now(tz=timezone.utc),
        )
    # Maintain legacy alias for field_1 so single-arg lookups succeed
    if field_id == "field_1" and device_id not in _device_states:
        _device_states[device_id] = _device_states[key]
    return _device_states[key]


# =============================================================================
# MATH UTILITIES
# =============================================================================

def _median(values: list[float]) -> float:
    if not values:
        raise ValueError("Cannot compute median of empty list")
    return statistics.median(values)


def _mad(values: list[float]) -> float:
    """Median Absolute Deviation."""
    if len(values) < 2:
        return 0.0
    med = _median(values)
    return statistics.median([abs(v - med) for v in values])


def _clip(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _normalize(value: float, reference: float) -> float:
    """Normalize value against reference, clamped to [0, 1]."""
    if reference <= 0:
        return 0.0
    return _clip(value / reference, 0.0, 1.0)


def _weighted_avg_available(
    values: dict[str, float],
    weights: dict[str, float],
) -> float:
    """
    Weighted average over keys present in `values`.
    Keys in `weights` but absent from `values` are excluded from BOTH
    numerator and denominator — missing sensors do NOT contribute zero.
    """
    total_w = sum(weights[k] for k in values if k in weights)
    if total_w <= 0:
        return 0.0
    return sum(weights[k] * v for k, v in values.items() if k in weights) / total_w


def _renormalised_formula(
    factor_values: dict[str, float],   # factor_name → value (only AVAILABLE)
    factor_weights: dict[str, float],  # factor_name → base weight
    base: float,
    mode: str,                         # "additive" | "divisive"
    epsilon: float = 0.0,
    clip_lo: float = 0.0,
    clip_hi: float = float("inf"),
) -> tuple[float, dict[str, float]]:
    """
    Apply renormalised formula using only AVAILABLE factors.

    Additive (T_create):
        result = base * (1 + Σ w_i_norm * f_i)
        where w_i_norm = w_i / Σ_available w_j

    Divisive (T_update):
        result = base / (epsilon + Σ w_i_norm * f_i)

    Returns (clipped_result, effective_weights_used).
    """
    avail_w_sum = sum(factor_weights[k] for k in factor_values if k in factor_weights)
    if avail_w_sum <= 0:
        # No available factors — use base directly
        return _clip(base, clip_lo, clip_hi), {}

    eff_weights: dict[str, float] = {}
    weighted_sum = 0.0
    for k, fv in factor_values.items():
        if k not in factor_weights:
            continue
        w_norm = factor_weights[k] / avail_w_sum
        eff_weights[k] = round(w_norm, 4)
        weighted_sum += w_norm * fv

    if mode == "additive":
        raw = base * (1.0 + weighted_sum)
    else:  # divisive
        raw = base / (epsilon + weighted_sum)

    return _clip(raw, clip_lo, clip_hi), eff_weights


# =============================================================================
# FAST PATH — called from anomaly_service.detect() on every packet
# =============================================================================

def get_sensor_range(device_id: str, sensor: str, field_id: str = "field_1") -> tuple[float, float]:
    """
    FAST PATH: Return the pre-computed (min_expected, max_expected) for a sensor in a field.
    O(1) — no database access. Falls back to physical limits if no baseline yet.
    """
    key = _state_key(device_id, field_id)
    state = _device_states.get(key) or _device_states.get(device_id)
    if state and sensor in state.sensors:
        s = state.sensors[sensor]
        return s.min_expected, s.max_expected
    lim = PHYSICAL_LIMITS.get(sensor, {"min": 0.0, "max": 100.0})
    return lim["min"], lim["max"]


def get_sensor_mad_eff(device_id: str, sensor: str, field_id: str = "field_1") -> float:
    """FAST PATH: Return effective MAD for a sensor (for deviation calculation)."""
    key = _state_key(device_id, field_id)
    state = _device_states.get(key) or _device_states.get(device_id)
    if state and sensor in state.sensors:
        return max(state.sensors[sensor].mad_eff, 1e-6)
    return 1.0


def record_anomaly_evidence(
    device_id: str,
    sensor: str,
    is_anomalous: bool,
    deviation_mads: float = 0.0,
    field_id: str = "field_1",
) -> None:
    """
    FAST PATH: Update in-memory anomaly evidence counters for a specific field.
    Called by anomaly_service.detect() for every packet.
    Also tracks first-seen timestamp for time-persistence regime check.
    """
    key = _state_key(device_id, field_id)
    state = _device_states.get(key) or _device_states.get(device_id)
    if not state or sensor not in state.sensors:
        return
    s = state.sensors[sensor]
    now = datetime.now(tz=timezone.utc)
    if is_anomalous:
        s._consecutive_anomalies += 1
        s._last_anomaly_magnitude = max(s._last_anomaly_magnitude, deviation_mads)
        if s._anomaly_first_seen_at is None:
            s._anomaly_first_seen_at = now
    else:
        s._consecutive_anomalies = 0
        s._last_anomaly_magnitude = 0.0
        s._anomaly_first_seen_at = None


def update_anomaly_rate(device_id: str, rate: float, field_id: str = "field_1") -> None:
    """Called by anomaly_service to push the rolling anomaly rate for a specific field."""
    key = _state_key(device_id, field_id)
    state = _device_states.get(key) or _device_states.get(device_id)
    if state:
        state.anomaly_rate = _clip(rate, 0.0, 1.0)


# =============================================================================
# ADAPTIVE PATH HELPERS
# =============================================================================

def _extract_clean_values(history: list[dict], sensor: str) -> list[float]:
    """
    Extract non-null, physically-valid, non-jump-jump values.
    Values are returned in chronological order (history sorted oldest-first).
    """
    values: list[float] = []
    prev: Optional[float] = None
    jump_limit = MAX_JUMP.get(sensor, float("inf"))
    phys = PHYSICAL_LIMITS.get(sensor, {"min": -1e9, "max": 1e9})

    for row in history:
        v = row.get(sensor)
        if v is None:
            continue
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if not (phys["min"] <= v <= phys["max"]):
            continue
        if prev is not None and abs(v - prev) > jump_limit:
            prev = v
            continue
        values.append(v)
        prev = v
    return values


def _calculate_robust_baseline(
    values: list[float],
    sensor: str,
    crop_key: str,
) -> dict:
    """
    Median + MAD baseline with MAD_eff floor and physical/crop prior clamping.

    B_s         = Median(X_s)
    MAD_s       = Median(|X_s − B_s|)
    MAD_eff_s   = max(MAD_s, MAD_MIN_s)          ← prevents zero-width range
    stat_range  = [B_s − K_s*MAD_eff_s, B_s + K_s*MAD_eff_s]
    final_range = stat_range ∩ physical_limits ∩ crop_prior
    """
    phys = PHYSICAL_LIMITS.get(sensor, {"min": -1e9, "max": 1e9})
    k    = SENSOR_K.get(sensor, 3.0)

    if len(values) < 2:
        mid = (phys["min"] + phys["max"]) / 2.0
        mad_min = MAD_MIN.get(sensor, 0.5)
        return {
            "center": mid, "mad": 0.0, "mad_eff": mad_min, "k": k,
            "stat_lower": mid - k * mad_min, "stat_upper": mid + k * mad_min,
            "final_lower": phys["min"], "final_upper": phys["max"],
            "insufficient_data": True,
        }

    center  = _median(values)
    mad_raw = _mad(values)
    mad_eff = max(mad_raw, MAD_MIN.get(sensor, 0.5))

    stat_lower = center - k * mad_eff
    stat_upper = center + k * mad_eff

    final_lower = max(stat_lower, phys["min"])
    final_upper = min(stat_upper, phys["max"])

    # Crop/stage soft prior
    prior = CROP_PRIORS.get(crop_key, {}).get(sensor)
    if prior:
        p_lo, p_hi = prior
        final_lower = max(final_lower, p_lo)
        final_upper = min(final_upper, p_hi)

    # Safety: if intersection is empty, revert to statistical range
    if final_lower >= final_upper:
        logger.warning(
            f"Baseline/physical conflict for {sensor}: "
            f"stat=[{stat_lower:.2f},{stat_upper:.2f}] → reverting."
        )
        final_lower, final_upper = stat_lower, stat_upper

    logger.info(
        f"Robust baseline {sensor}: center={center:.2f} MAD={mad_raw:.3f} "
        f"MAD_eff={mad_eff:.3f} K={k} "
        f"stat=[{stat_lower:.2f},{stat_upper:.2f}] "
        f"final=[{final_lower:.2f},{final_upper:.2f}]"
    )
    return {
        "center": center, "mad": mad_raw, "mad_eff": mad_eff, "k": k,
        "stat_lower": stat_lower, "stat_upper": stat_upper,
        "final_lower": final_lower, "final_upper": final_upper,
        "insufficient_data": False,
    }


def _calculate_variability(
    sensor_values: dict[str, list[float]],
) -> tuple[float, dict[str, float]]:
    """
    V_s = W_CV * N_CV_s + W_RATE * N_Rate_s   per sensor
    V   = weighted_avg(V_s) over AVAILABLE sensors only.
    Missing sensors do NOT contribute zero.
    """
    per_sensor: dict[str, float] = {}
    for sensor, values in sensor_values.items():
        if len(values) < 2:
            continue
        mean_v = statistics.mean(values)
        std_v  = statistics.pstdev(values)
        cv     = std_v / max(abs(mean_v), 1e-6)
        diffs  = [abs(values[i] - values[i - 1]) for i in range(1, len(values))]
        rate   = statistics.mean(diffs) if diffs else 0.0
        n_cv   = _normalize(cv,   CV_REFERENCE.get(sensor,   0.20))
        n_rate = _normalize(rate, RATE_REFERENCE.get(sensor, 5.0))
        v_s    = W_CV * n_cv + W_RATE * n_rate
        per_sensor[sensor] = _clip(v_s, 0.0, 1.0)

    if not per_sensor:
        return 0.0, {}
    overall = _weighted_avg_available(per_sensor, VARIABILITY_WEIGHTS)
    return _clip(overall, 0.0, 1.0), per_sensor


def _calculate_data_quality(
    history: list[dict],
    sensor: str,
    clean_values: list[float],
) -> float:
    """
    Sensor data quality score S ∈ [0,1].

    IMPORTANT: S does NOT depend on T_create. There is NO circular dependency.

    Components:
        missing_rate  = 1 - (null_count / total_rows)
        invalid_rate  = 1 - (physical_range_failures / non_null)
        jump_rate     = 1 - (impossible_jumps / consecutive_pairs)
        sample_ratio  = clip(clean_count / MIN_SAMPLES_ACTIVE, 0, 1)
    """
    if not history:
        return 0.0

    total = len(history)
    null_count = sum(1 for r in history if r.get(sensor) is None)
    missing_score = 1.0 - (null_count / total)

    phys = PHYSICAL_LIMITS.get(sensor, {"min": -1e9, "max": 1e9})
    raw_vals = []
    invalid_count = 0
    for r in history:
        v = r.get(sensor)
        if v is None:
            continue
        try:
            fv = float(v)
        except (TypeError, ValueError):
            invalid_count += 1
            continue
        raw_vals.append(fv)
        if not (phys["min"] <= fv <= phys["max"]):
            invalid_count += 1
    invalid_score = 1.0 - (invalid_count / max(len(raw_vals), 1))

    jump_limit = MAX_JUMP.get(sensor, float("inf"))
    jumps = sum(
        1 for i in range(1, len(raw_vals))
        if abs(raw_vals[i] - raw_vals[i - 1]) > jump_limit
    )
    jump_score = 1.0 - (jumps / max(len(raw_vals) - 1, 1))

    sample_score = _clip(len(clean_values) / max(MIN_SAMPLES_ACTIVE, 1), 0.0, 1.0)

    s = (
        S_W_MISSING * missing_score +
        S_W_INVALID * invalid_score +
        S_W_JUMP    * jump_score +
        S_W_SAMPLE  * sample_score
    )
    return _clip(s, 0.0, 1.0)


def _calculate_tod_coverage(history: list[dict]) -> tuple[float, dict[int, int]]:
    """
    Time-of-day coverage based on sample counts per hour-bucket.

    TOD_cov = mean over 24 h of clip(samples_in_h / TOD_REF_SAMPLES, 0, 1)

    Returns (tod_coverage_frac, hour_counts dict).
    """
    hour_counts: dict[int, int] = {h: 0 for h in range(24)}
    for row in history:
        ts_str = row.get("timestamp", "")
        try:
            ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
            hour_counts[ts.hour] = hour_counts.get(ts.hour, 0) + 1
        except (ValueError, AttributeError):
            pass
    cov = sum(
        _clip(count / max(TOD_REF_SAMPLES, 1), 0.0, 1.0)
        for count in hour_counts.values()
    ) / 24.0
    return _clip(cov, 0.0, 1.0), hour_counts


def _calculate_confidence(
    n: int,
    elapsed_hours: float,
    creation_hours: float,
    tod_coverage: float,
    sensor_quality: float,
    anomaly_rate: float,
    context_completeness: float,   # already penalised for missing weather
) -> int:
    """
    Weighted confidence score (0–100) with early-learning ceilings.

    Weather unavailability is already penalised through context_completeness.
    (Weather counted as one context field → missing weather reduces context_complete.)

    No dependency on T_create in S (sensor_quality) — circular dependency removed.
    """
    sample_cov   = _clip(n / max(MIN_SAMPLES_ACTIVE, 1), 0.0, 1.0)
    time_cov     = _clip(elapsed_hours / max(creation_hours, 1.0), 0.0, 1.0)
    anomaly_cln  = _clip(1.0 - anomaly_rate, 0.0, 1.0)

    raw = 100.0 * (
        CONF_W_SAMPLE  * sample_cov +
        CONF_W_TIME    * time_cov +
        CONF_W_TOD     * tod_coverage +
        CONF_W_QUALITY * sensor_quality +
        CONF_W_ANOMALY * anomaly_cln +
        CONF_W_CONTEXT * context_completeness
    )

    # Early-learning ceilings (checked in ascending order)
    for time_frac_threshold, max_conf in CONF_CEIL:
        if time_cov < time_frac_threshold:
            raw = min(raw, float(max_conf))
            break

    return int(round(_clip(raw, 0.0, 100.0)))


def _calculate_context_change(prev: dict, cur: dict) -> float:
    """C ∈ [0,1] — how much the agronomic context has shifted."""
    if not prev:
        return 0.0  # startup — not a change event

    scores: list[float] = []
    if prev.get("crop") != cur.get("crop") and prev.get("crop_id") != cur.get("crop_id"):
        scores.append(1.0)
    prev_stage, new_stage = prev.get("growth_stage"), cur.get("growth_stage")
    if prev_stage != new_stage:
        scores.append(0.8 if new_stage in SENSITIVE_STAGES else 0.4)
    if prev.get("soil_type") != cur.get("soil_type"):
        scores.append(0.5)
    if prev.get("season_id") != cur.get("season_id"):
        scores.append(0.3)
    if prev.get("climate_zone") != cur.get("climate_zone"):
        scores.append(0.4)
    if prev.get("irrigation_method") != cur.get("irrigation_method"):
        scores.append(0.4)
    if prev.get("irrigation_source") != cur.get("irrigation_source"):
        scores.append(0.3)
    if prev.get("water_availability_class") != cur.get("water_availability_class"):
        scores.append(0.4)

    return _clip(max(scores, default=0.0), 0.0, 1.0)


def _regime_change_confirmed(
    sensor_state: SensorBaselineState,
    supporting_sensor_count: int,
    now: datetime,
) -> bool:
    """
    Multi-evidence regime change detection.

    Requires ALL of:
      1. persistence ≥ ANOMALY_PERSIST_MIN consecutive anomalous readings
      2. real-time duration ≥ REGIME_MIN_PERSISTENCE_HOURS
      3. deviation magnitude ≥ REGIME_MAGNITUDE_MIN_MAD × MAD_eff
      4. sensor quality ≥ SENSOR_QUALITY_THRESHOLD
      5. multi-sensor support OR independently-reliable sensor quality

    One broken sensor with normal companions does NOT trigger regime change.
    """
    if sensor_state._anomaly_first_seen_at is None:
        return False
    duration_h = (now - sensor_state._anomaly_first_seen_at).total_seconds() / 3600.0

    return (
        sensor_state._consecutive_anomalies >= ANOMALY_PERSIST_MIN
        and duration_h >= REGIME_MIN_PERSISTENCE_HOURS
        and sensor_state._last_anomaly_magnitude >= REGIME_MAGNITUDE_MIN_MAD
        and sensor_state.observations >= REGIME_CHANGE_THRESH
        and sensor_state.sensor_quality >= SENSOR_QUALITY_THRESHOLD
        and (
            supporting_sensor_count >= MULTISENSOR_SUPPORT_MIN
            or sensor_state.sensor_quality >= INDEPENDENTLY_RELIABLE_S
        )
    )


def _calculate_dynamic_alpha(
    confidence_score: int,
    variability: float,
    context_change: float,
    consecutive_anomalies: int,
    in_sensitive_stage: bool,
    regime_confirmed: bool,
) -> float:
    """
    Two-mode adaptive alpha:

    Normal mode (in-range, or anomaly not yet confirmed as regime):
        alpha_normal = clip(
            ALPHA_BASE * conf_factor * stability_factor * ctx_factor,
            ALPHA_MIN, ALPHA_MAX
        )
        — during active anomaly: strongly reduced via stability_factor

    Confirmed regime mode:
        alpha_regime = clip(ALPHA_BASE_REGIME * conf_factor, ALPHA_MIN, ALPHA_REGIME_MAX)
        — controlled larger adaptation toward the new regime

    Sensitive stage: alpha scaled down by ALPHA_SENSITIVE_STAGE_FACTOR.
    """
    conf_factor      = _clip(confidence_score / 100.0, 0.1, 1.0)
    stability_factor = _clip(1.0 - variability, 0.1, 1.0)
    ctx_factor       = _clip(1.0 - context_change, 0.1, 1.0)

    if consecutive_anomalies >= ANOMALY_PERSIST_MIN:
        stability_factor = min(stability_factor, 0.1)
    elif consecutive_anomalies > 0:
        penalty = 0.15 * consecutive_anomalies
        stability_factor = max(0.3, stability_factor - penalty)

    if regime_confirmed:
        alpha = _clip(ALPHA_BASE_REGIME * conf_factor, ALPHA_MIN, ALPHA_REGIME_MAX)
    else:
        alpha = _clip(
            ALPHA_BASE * conf_factor * stability_factor * ctx_factor,
            ALPHA_MIN, ALPHA_MAX,
        )

    if in_sensitive_stage:
        alpha = _clip(alpha * ALPHA_SENSITIVE_STAGE_FACTOR, ALPHA_MIN, alpha)

    return alpha


def _calculate_update_interval(
    factor_values: dict[str, float],
    prev_interval: float,
) -> float:
    """
    T_update = clip(K_UPDATE / (U_EPSILON + Σ renorm_w_i * f_i), Tmin, Tmax)
    + hysteresis: 0.8 * prev + 0.2 * new
    + rate cap:   max change = UPDATE_MAX_CHANGE_PCT * prev
    """
    raw, _ = _renormalised_formula(
        factor_values=factor_values,
        factor_weights=T_UPDATE_FACTORS,
        base=K_UPDATE,
        mode="divisive",
        epsilon=U_EPSILON,
        clip_lo=T_UPDATE_MIN_H,
        clip_hi=T_UPDATE_MAX_H,
    )
    smoothed  = UPDATE_HYSTERESIS * prev_interval + (1.0 - UPDATE_HYSTERESIS) * raw
    max_delta = UPDATE_MAX_CHANGE_PCT * prev_interval
    capped    = _clip(smoothed, prev_interval - max_delta, prev_interval + max_delta)
    return _clip(capped, T_UPDATE_MIN_H, T_UPDATE_MAX_H)


def _blend_tod_baseline(
    tod_values: list[float],
    overall_center: float,
    overall_mad_eff: float,
    k: float,
    hour_count_in_bucket: int,
) -> tuple[float, float, float]:
    """
    Hierarchical TOD blend:
      B_final   = λ * B_tod + (1-λ) * B_overall
      MAD_final = λ * MAD_tod + (1-λ) * MAD_overall
      λ = clip((n_tod - TOD_MIN) / (TOD_MAX - TOD_MIN), 0, 1)
    """
    lam = _clip(
        (hour_count_in_bucket - TOD_MIN_SAMPLES) /
        max(TOD_MAX_SAMPLES - TOD_MIN_SAMPLES, 1),
        0.0, 1.0,
    )
    if lam > 0 and len(tod_values) >= 2:
        tod_center = _median(tod_values)
        tod_mad    = max(_mad(tod_values), MAD_MIN.get("_generic", 0.2))
    else:
        tod_center = overall_center
        tod_mad    = overall_mad_eff

    final_center = lam * tod_center + (1.0 - lam) * overall_center
    final_mad    = lam * tod_mad    + (1.0 - lam) * overall_mad_eff
    return final_center, final_mad, lam


def _determine_status(
    n: int,
    time_coverage: float,
    confidence: int,
    context_change: float,
    regime_change: bool,
) -> str:
    """
    Four-state FSM — status driven by data quality, NOT only elapsed time.

    LEARNING      → creation requirements not satisfied
    ACTIVE        → sufficient samples + time + confidence
    LOW_CONFIDENCE → baseline exists but confidence below threshold
    REBUILDING    → context change or confirmed persistent regime change
    """
    if context_change >= CONTEXT_CHANGE_REBUILD_THRESHOLD or regime_change:
        return "REBUILDING"
    if (n >= MIN_SAMPLES_ACTIVE
            and time_coverage >= MIN_TIME_FRAC_ACTIVE
            and confidence >= MIN_CONFIDENCE_ACTIVE):
        return "ACTIVE"
    if n >= MIN_SAMPLES_ACTIVE // 2 and confidence < MIN_CONFIDENCE_ACTIVE:
        return "LOW_CONFIDENCE"
    return "LEARNING"


# =============================================================================
# MAIN ADAPTIVE CALCULATION
# =============================================================================

async def run_adaptive_calculation(
    device_id: str,
    context: dict,
    field_id: str = "field_1",
) -> DeviceBaselineState:
    """
    ADAPTIVE PATH — runs periodically (every T_update hours) for a specific field.
    Never called per-packet.

    context dict expected keys:
        crop_id, growth_stage, soil_type, climate_zone, season_id,
        weather_observations (list[dict] | None)
    """
    now   = datetime.now(tz=timezone.utc)
    state = _get_or_create_state(device_id, field_id)

    # ── Fetch bounded history for this field ──────────────────────────────────
    history: list[dict] = await asyncio.get_event_loop().run_in_executor(
        None, supa.get_bounded_reading_history, device_id, field_id, HISTORY_LIMIT
    )
    if not history:
        logger.info(f"Adaptive baseline [{device_id}/{field_id}]: no history yet, skipping.")
        return state

    # Sort chronologically (oldest first for consecutive-diff calculations)
    history.sort(key=lambda r: r.get("timestamp", ""))

    # ── Clean values per sensor ───────────────────────────────────────────────
    sensor_values: dict[str, list[float]] = {}
    for s in MONITORED_SENSORS:
        vals = _extract_clean_values(history, s)
        if vals:
            sensor_values[s] = vals

    if not sensor_values:
        logger.warning(f"Adaptive baseline [{device_id}]: no valid readings.")
        return state

    # ── Learning start time ───────────────────────────────────────────────────
    try:
        first_ts = datetime.fromisoformat(
            history[0]["timestamp"].replace("Z", "+00:00")
        )
    except (KeyError, ValueError, AttributeError):
        first_ts = now
    if state.learning_started_at is None:
        state.learning_started_at = first_ts
    elapsed_h = max((now - state.learning_started_at).total_seconds() / 3600.0, 0.01)
    total_n = max((len(v) for v in sensor_values.values()), default=0)

    # ── Context ───────────────────────────────────────────────────────────────
    new_ctx = {
        "crop_id":      context.get("crop_id", "unknown"),
        "growth_stage": context.get("growth_stage", "unknown"),
        "soil_type":    context.get("soil_type", "unknown"),
        "season_id":    context.get("season_id", "unknown"),
        "climate_zone": context.get("climate_zone", "unknown"),
    }
    context_change = _calculate_context_change(state.context_snapshot, new_ctx)
    state.context_snapshot = new_ctx
    crop_key       = f"{new_ctx['crop_id']}:{new_ctx['growth_stage']}"
    in_sensitive   = new_ctx["growth_stage"] in SENSITIVE_STAGES

    # ── Variability ───────────────────────────────────────────────────────────
    v_overall, v_per_sensor = _calculate_variability(sensor_values)

    # ── Weather variability ───────────────────────────────────────────────────
    # Missing weather → null, NOT zero. Factors are renormalised below.
    weather_obs = context.get("weather_observations")
    weather_variability: Optional[float] = None
    weather_status = "weather_data_unavailable"
    if weather_obs and len(weather_obs) >= 2:
        w_scores: list[float] = []
        weather_keys = {
            "temperature": 5.0, "humidity": 10.0,
            "rain_probability": 20.0, "wind": 3.0, "solar": 200.0,
        }
        for wk, ref in weather_keys.items():
            vals_w = [float(o[wk]) for o in weather_obs if wk in o and o[wk] is not None]
            if len(vals_w) >= 2:
                avg_diff = statistics.mean([abs(vals_w[i] - vals_w[i - 1]) for i in range(1, len(vals_w))])
                w_scores.append(_normalize(avg_diff, ref))
        if w_scores:
            weather_variability = _clip(statistics.mean(w_scores), 0.0, 1.0)
            weather_status = "available"

    # ── Sensor data quality (S) — no T_create dependency ────────────────────
    quality_per_sensor: dict[str, float] = {
        s: _calculate_data_quality(history, s, sensor_values.get(s, []))
        for s in MONITORED_SENSORS
    }
    overall_quality = (
        statistics.mean(quality_per_sensor.values())
        if quality_per_sensor else 0.5
    )

    # ── TOD coverage ─────────────────────────────────────────────────────────
    tod_coverage, hour_counts = _calculate_tod_coverage(history)

    # ── Anomaly rate ──────────────────────────────────────────────────────────
    anomaly_rate = state.anomaly_rate  # maintained by fast path

    # ── Context completeness — includes weather availability ─────────────────
    ctx_fields_checked = ["crop_id", "growth_stage", "soil_type", "climate_zone",
                          "season_id", "weather"]
    ctx_present = sum(
        1 for f in ["crop_id", "growth_stage", "soil_type", "climate_zone", "season_id"]
        if new_ctx.get(f) not in (None, "unknown", "")
    )
    if weather_variability is not None:
        ctx_present += 1  # weather available
    context_completeness = ctx_present / len(ctx_fields_checked)

    # ── Build factor dicts for formula (available only) ───────────────────────
    create_factors: dict[str, float] = {
        "variability":    v_overall,
        "anomaly_rate":   anomaly_rate,
        "context_change": context_change,
        "quality_lack":   1.0 - overall_quality,
    }
    update_factors: dict[str, float] = {
        "variability":    v_overall,
        "anomaly_rate":   anomaly_rate,
        "context_change": context_change,
    }
    if weather_variability is not None:
        create_factors["weather"] = weather_variability
        update_factors["weather"] = weather_variability
    # When weather is unavailable: "weather" key absent → renormalised formula
    # excludes it from both numerator and denominator automatically.

    # ── T_create (renormalised over available factors) ─────────────────────
    creation_h, create_eff_w = _renormalised_formula(
        factor_values=create_factors,
        factor_weights=T_CREATE_FACTORS,
        base=T0_DAYS * 24.0,
        mode="additive",
        clip_lo=T_CREATE_MIN_H,
        clip_hi=T_CREATE_MAX_H,
    )

    # ── Confidence ────────────────────────────────────────────────────────────
    confidence = _calculate_confidence(
        n=total_n,
        elapsed_hours=elapsed_h,
        creation_hours=creation_h,
        tod_coverage=tod_coverage,
        sensor_quality=overall_quality,
        anomaly_rate=anomaly_rate,
        context_completeness=context_completeness,
    )
    time_coverage = _clip(elapsed_h / max(creation_h, 1.0), 0.0, 1.0)

    # ── Per-sensor regime-change tally ────────────────────────────────────────
    n_regime_sensors = sum(
        1 for s in MONITORED_SENSORS
        if (ss := state.sensors.get(s)) and ss._consecutive_anomalies >= ANOMALY_PERSIST_MIN
    )

    overall_regime_change = False
    updated_sensors: dict[str, SensorBaselineState] = {}

    for sensor in MONITORED_SENSORS:
        vals = sensor_values.get(sensor)
        if not vals:
            continue

        s_quality = quality_per_sensor.get(sensor, 0.5)
        prev_s    = state.sensors.get(sensor)

        # TOD blend for diurnal sensors
        rb = _calculate_robust_baseline(vals, sensor, crop_key)
        if sensor in DIURNAL_SENSORS:
            bucket_count = hour_counts.get(now.hour, 0)
            tod_vals = _extract_clean_values(
                [r for r in history
                 if _row_hour(r) == now.hour],
                sensor,
            )
            blended_c, blended_m, lam_tod = _blend_tod_baseline(
                tod_vals, rb["center"], rb["mad_eff"], rb["k"], bucket_count
            )
            rb = {**rb, "center": blended_c, "mad_eff": max(blended_m, MAD_MIN.get(sensor, 0.5))}

        # Regime check — supporting = other sensors also anomalous (excluding this one)
        this_in_regime = (prev_s and prev_s._consecutive_anomalies >= ANOMALY_PERSIST_MIN)
        supporting = n_regime_sensors - (1 if this_in_regime else 0)
        regime_ok = False
        if prev_s:
            regime_ok = _regime_change_confirmed(prev_s, supporting, now)
            if regime_ok:
                overall_regime_change = True
                logger.info(
                    f"Regime change CONFIRMED: {device_id}/{sensor} "
                    f"(persistence={prev_s._consecutive_anomalies}, "
                    f"magnitude={prev_s._last_anomaly_magnitude:.2f} MADs)"
                )

        # Dynamic alpha
        alpha_t = _calculate_dynamic_alpha(
            confidence_score=confidence,
            variability=v_per_sensor.get(sensor, v_overall),
            context_change=context_change,
            consecutive_anomalies=prev_s._consecutive_anomalies if prev_s else 0,
            in_sensitive_stage=in_sensitive,
            regime_confirmed=regime_ok,
        )

        # Adaptive center update
        if prev_s and not (prev_s._consecutive_anomalies >= ANOMALY_PERSIST_MIN and not regime_ok):
            new_center = (1.0 - alpha_t) * prev_s.center + alpha_t * rb["center"]
        else:
            new_center = rb["center"]

        mad_eff  = rb["mad_eff"]
        new_lo   = max(new_center - rb["k"] * mad_eff, rb["final_lower"])
        new_hi   = min(new_center + rb["k"] * mad_eff, rb["final_upper"])

        sensor_conf = _calculate_confidence(
            n=len(vals),
            elapsed_hours=elapsed_h,
            creation_hours=creation_h,
            tod_coverage=tod_coverage,
            sensor_quality=s_quality,
            anomaly_rate=anomaly_rate,
            context_completeness=context_completeness,
        )

        # Build or inherit sensor state
        ns = SensorBaselineState(
            sensor=sensor,
            center=new_center,
            mad=rb["mad"],
            mad_eff=mad_eff,
            k_multiplier=rb["k"],
            min_expected=new_lo,
            max_expected=new_hi,
            confidence=float(sensor_conf),
            observations=len(vals),
            variability_score=v_per_sensor.get(sensor, 0.0),
            anomaly_rate=anomaly_rate,
            sensor_quality=s_quality,
            creation_period_hours=creation_h,
            update_interval_hours=state.update_interval_hours,
            learning_started_at=state.learning_started_at,
            baseline_status="LEARNING",
            context_snapshot=new_ctx,
            anomaly_evidence_count=prev_s.anomaly_evidence_count if prev_s else 0,
            tod_coverage_json={"hour_counts": hour_counts, "coverage_frac": tod_coverage},
        )
        if prev_s:
            ns._consecutive_anomalies  = prev_s._consecutive_anomalies
            ns._last_anomaly_magnitude = prev_s._last_anomaly_magnitude
            ns._anomaly_first_seen_at  = prev_s._anomaly_first_seen_at
            ns._prev_update_interval   = prev_s._prev_update_interval
        ns._alpha_t = alpha_t

        updated_sensors[sensor] = ns

        logger.info(
            f"Adaptive baseline: device={device_id} sensor={sensor} "
            f"center={new_center:.2f} MAD={rb['mad']:.3f} MAD_eff={mad_eff:.3f} "
            f"range=[{new_lo:.2f},{new_hi:.2f}] "
            f"confidence={sensor_conf} alpha_t={alpha_t:.4f} "
            f"quality={s_quality:.2f}"
        )

    # ── T_update with hysteresis + rate cap ───────────────────────────────────
    new_interval = _calculate_update_interval(update_factors, state.update_interval_hours)

    # ── Overall status ────────────────────────────────────────────────────────
    overall_status = _determine_status(
        n=total_n,
        time_coverage=time_coverage,
        confidence=confidence,
        context_change=context_change,
        regime_change=overall_regime_change,
    )
    for ns in updated_sensors.values():
        ns.baseline_status = overall_status

    # ── Explainability ────────────────────────────────────────────────────────
    active_factors:   list[str] = []
    inactive_factors: list[str] = ["weather_history"] if weather_variability is None else []

    factor_display = {
        "variability":    f"Reading variation (V={v_overall:.3f})",
        "weather":        f"Weather variation (W={weather_variability:.3f})" if weather_variability else None,
        "anomaly_rate":   f"Anomaly rate (A={anomaly_rate:.3f})",
        "context_change": f"Context change (C={context_change:.3f})",
        "quality_lack":   f"Sensor quality (S={overall_quality:.3f})",
    }
    for k in create_factors:
        if k in factor_display and factor_display[k]:
            active_factors.append(factor_display[k])
    for k in ["crop_id", "growth_stage", "soil_type", "climate_zone"]:
        val = new_ctx.get(k, "unknown")
        if val not in (None, "unknown", ""):
            active_factors.append(k)
        else:
            inactive_factors.append(k)

    explanation = {
        "variability":         round(v_overall, 4),
        "weather_variability": round(weather_variability, 4) if weather_variability is not None else None,
        "weather_status":      weather_status,
        "anomaly_rate":        round(anomaly_rate, 4),
        "sensor_quality":      round(overall_quality, 4),
        "context_change":      round(context_change, 4),
        "active_factors":      list(dict.fromkeys(active_factors)),
        "inactive_factors":    list(dict.fromkeys(inactive_factors)),
        "active_factor_weights": create_eff_w,
        "creation_period_h":   round(creation_h, 2),
        "update_interval_h":   round(new_interval, 2),
    }

    # ── Update device state ───────────────────────────────────────────────────
    state.sensors               = updated_sensors
    state.overall_status        = overall_status
    state.confidence            = float(confidence)
    state.overall_variability   = v_overall
    state.weather_variability   = weather_variability
    state.weather_status        = weather_status
    state.anomaly_rate          = anomaly_rate
    state.sensor_quality        = overall_quality
    state.creation_period_hours = creation_h
    state.update_interval_hours = new_interval
    state.next_update_at        = now + timedelta(hours=new_interval)
    state.explanation           = explanation

    logger.info(
        f"Baseline recommendation: device={device_id} "
        f"T_create={creation_h/24:.2f}d T_update={new_interval:.1f}h "
        f"confidence={confidence} status={overall_status} "
        f"V={v_overall:.3f} W={weather_variability} "
        f"A={anomaly_rate:.3f} C={context_change:.3f} S={overall_quality:.3f}"
    )

    # ── Persist to Supabase ───────────────────────────────────────────────────
    for sensor, ns in updated_sensors.items():
        await asyncio.get_event_loop().run_in_executor(
            None, supa.upsert_adaptive_baseline, device_id, sensor, _to_dict(ns), field_id
        )

    return state


# ─── Private helpers ──────────────────────────────────────────────────────────

def _row_hour(row: dict) -> int:
    ts_str = row.get("timestamp", "")
    try:
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00")).hour
    except (ValueError, AttributeError):
        return -1


def _to_dict(s: SensorBaselineState) -> dict:
    """Serialise a SensorBaselineState for Supabase upsert."""
    return {
        "baseline_center":        s.center,
        "mad":                    s.mad,
        "k_multiplier":           s.k_multiplier,
        "min_expected":           s.min_expected,
        "max_expected":           s.max_expected,
        "confidence":             s.confidence,
        "observations":           s.observations,
        "variability_score":      s.variability_score,
        "anomaly_rate":           s.anomaly_rate,
        "sensor_quality":         s.sensor_quality,
        "creation_period_hours":  s.creation_period_hours,
        "update_interval_hours":  s.update_interval_hours,
        "learning_started_at":    s.learning_started_at.isoformat() if s.learning_started_at else None,
        "learning_completed_at":  s.learning_completed_at.isoformat() if s.learning_completed_at else None,
        "next_update_at":         s.next_update_at.isoformat() if s.next_update_at else None,
        "baseline_status":        s.baseline_status,
        "context_snapshot":       s.context_snapshot,
        "anomaly_evidence_count": s.anomaly_evidence_count,
        "tod_coverage_json":      s.tod_coverage_json,
        "explanation_json":       s.explanation_json,
    }


# =============================================================================
# STARTUP — RESTORE FROM SUPABASE
# =============================================================================

def restore_from_supabase(device_id: str) -> None:
    """
    Load previously persisted baseline states from Supabase on FastAPI startup.
    Enables baseline survival across restarts for all fields.
    """
    rows = supa.load_adaptive_baselines(device_id)
    if not rows:
        logger.info(f"No persisted baselines for {device_id} — starting fresh.")
        return

    loaded = 0
    for row in rows:
        sensor = row.get("sensor")
        field_id = row.get("field_id") or "field_1"
        if not sensor:
            continue
        try:
            state = _get_or_create_state(device_id, field_id)
            mad_raw = float(row.get("mad", 0.0))
            mad_eff = max(mad_raw, MAD_MIN.get(sensor, 0.5))
            ns = SensorBaselineState(
                sensor=sensor,
                center=float(row["baseline_center"]),
                mad=mad_raw,
                mad_eff=mad_eff,
                k_multiplier=float(row.get("k_multiplier", SENSOR_K.get(sensor, 3.0))),
                min_expected=float(row["min_expected"]),
                max_expected=float(row["max_expected"]),
                confidence=float(row.get("confidence", 0.0)),
                observations=int(row.get("observations", 0)),
                variability_score=float(row.get("variability_score", 0.0)),
                anomaly_rate=float(row.get("anomaly_rate", 0.0)),
                sensor_quality=float(row.get("sensor_quality", 1.0)),
                creation_period_hours=float(row.get("creation_period_hours", T0_DAYS * 24.0)),
                update_interval_hours=float(row.get("update_interval_hours", K_UPDATE)),
                baseline_status=row.get("baseline_status", "LEARNING"),
                context_snapshot=row.get("context_snapshot") or {},
                anomaly_evidence_count=int(row.get("anomaly_evidence_count", 0)),
                tod_coverage_json=row.get("tod_coverage_json") or {},
                explanation_json=row.get("explanation_json") or {},
            )
            for ts_field, attr in [
                ("learning_started_at", "learning_started_at"),
                ("next_update_at", "next_update_at"),
            ]:
                raw = row.get(ts_field)
                if raw:
                    try:
                        setattr(ns, attr, datetime.fromisoformat(raw.replace("Z", "+00:00")))
                    except ValueError:
                        pass
            state.sensors[sensor] = ns
            loaded += 1
        except (KeyError, TypeError, ValueError) as e:
            logger.warning(f"Could not restore baseline for {sensor}: {e}")

    if loaded:
        for k, s in _device_states.items():
            confs = [item.confidence for item in s.sensors.values()]
            s.confidence = statistics.mean(confs) if confs else 0.0
        logger.info(f"Restored {loaded} sensor baselines for {device_id} across fields from Supabase.")


# =============================================================================
# PUBLIC API — get_full_baseline_state
# =============================================================================

def get_full_baseline_state(device_id: str, field_id: str = "field_1") -> dict:
    """
    Full structured baseline response for the API endpoint for a specific field.
    Backward compatible: sensors.* always has center, min_expected,
    max_expected, confidence, observations (existing dashboard uses these).
    """
    now   = datetime.now(tz=timezone.utc)
    key   = _state_key(device_id, field_id)
    state = _device_states.get(key) or _device_states.get(device_id)

    if not state or not state.sensors:
        return {
            "device_id":          device_id,
            "field_id":           field_id,
            "status":             "LEARNING",
            "creation": {
                "recommended_hours":       round(T0_DAYS * 24.0, 2),
                "recommended_days":        T0_DAYS,
                "elapsed_hours":           0.0,
                "progress_percent":        0,
                "estimated_completion_at": None,
                "sample_count":            0,
            },
            "update": {
                "recommended_interval_hours": round(K_UPDATE, 2),
                "next_update_at":             None,
            },
            "confidence":          0,
            "overall_variability": 0.0,
            "weather_variability": None,
            "weather_status":      "weather_data_unavailable",
            "anomaly_rate":        0.0,
            "sensor_quality":      1.0,
            "explanation": {
                "variability": 0.0, "weather_variability": None,
                "weather_status": "weather_data_unavailable",
                "anomaly_rate": 0.0, "sensor_quality": 1.0, "context_change": 0.0,
                "active_factors": [], "inactive_factors": ["weather_history"],
                "active_factor_weights": {},
            },
            "sensors": {},
        }

    elapsed_h   = max((now - state.learning_started_at).total_seconds() / 3600.0, 0.0) \
                  if state.learning_started_at else 0.0
    creation_h  = state.creation_period_hours
    progress    = min(100, int(100 * elapsed_h / max(creation_h, 1.0)))
    est_done: Optional[str] = None
    if state.learning_started_at and elapsed_h < creation_h:
        est_done = (now + timedelta(hours=creation_h - elapsed_h)).isoformat()

    total_n = max((s.observations for s in state.sensors.values()), default=0)

    sensors_out: dict[str, Any] = {}
    for sensor, s in state.sensors.items():
        sensors_out[sensor] = {
            # Backward-compatible (existing dashboard reads these)
            "center":            round(s.center, 4),
            "min_expected":      round(s.min_expected, 4),
            "max_expected":      round(s.max_expected, 4),
            "confidence":        int(round(s.confidence)),
            "observations":      s.observations,
            # Extended
            "mad":               round(s.mad, 4),
            "mad_eff":           round(s.mad_eff, 4),
            "k_multiplier":      s.k_multiplier,
            "variability_score": round(s.variability_score, 4),
            "sensor_quality":    round(s.sensor_quality, 4),
        }

    return {
        "device_id": device_id,
        "status":    state.overall_status,
        "creation": {
            "recommended_hours":       round(creation_h, 2),
            "recommended_days":        round(creation_h / 24.0, 2),
            "elapsed_hours":           round(elapsed_h, 2),
            "progress_percent":        progress,
            "estimated_completion_at": est_done,
            "sample_count":            total_n,
        },
        "update": {
            "recommended_interval_hours": round(state.update_interval_hours, 2),
            "next_update_at": state.next_update_at.isoformat() if state.next_update_at else None,
        },
        "confidence":          int(round(state.confidence)),
        "overall_variability": round(state.overall_variability, 4),
        "weather_variability": round(state.weather_variability, 4) if state.weather_variability is not None else None,
        "weather_status":      state.weather_status,
        "anomaly_rate":        round(state.anomaly_rate, 4),
        "sensor_quality":      round(state.sensor_quality, 4),
        "explanation":         state.explanation,
        "sensors":             sensors_out,
    }
