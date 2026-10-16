# =============================================================================
# MARUDAM Backend — Supabase Service (Two-Field Supported)
# =============================================================================
# Writes sensor readings, anomalies, device status, and events to Supabase.
# Uses the SERVICE ROLE KEY — server-side only. Never expose to the frontend.
# Supports two fields per ESP32 device node with fallback resilience.
# =============================================================================
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from supabase import create_client, Client

from app.config import settings
from app.models.sensor import SensorReading
from app.models.device import DeviceStatus, DeviceEvent
from app.utils.logger import get_logger

logger = get_logger("supabase_service")

_client: Optional[Client] = None
_raw_columns_supported = True
_field_id_supported = True


def get_client() -> Optional[Client]:
    """Lazy-initialise the Supabase client. Returns None if not configured."""
    global _client
    if _client is not None:
        return _client
    if not settings.supabase_configured:
        logger.warning(
            "Supabase is not configured (SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing). "
            "Data will not be persisted to the cloud."
        )
        return None
    try:
        _client = create_client(settings.supabase_url, settings.supabase_service_role_key)
        logger.info("Supabase client initialised.")
    except Exception as e:
        logger.error(f"Failed to initialise Supabase client: {e}")
        _client = None
    return _client


# ─── Sensor Readings ──────────────────────────────────────────────────────────

def upsert_reading(reading: SensorReading) -> bool:
    """
    Insert a sensor reading row into the sensor_readings table.
    Stores explicit field_id, raw ADC counts, voltage, and DS18B20 address.
    Resilient:
      - field_id is ALWAYS preserved to isolate Field 1 and Field 2.
      - Optional raw telemetry columns (soil_moisture_raw, voltage, DS18B20 address)
        are automatically dropped if unmigrated in Supabase without stripping field_id.
    """
    global _raw_columns_supported, _field_id_supported
    client = get_client()
    if client is None:
        return False

    row: Dict[str, Any] = {
        "device_id":        reading.device_id,
        "timestamp":        reading.timestamp.isoformat(),
        "soil_moisture":    reading.soil_moisture,
        "soil_temperature": reading.soil_temperature,
        "soil_ph":          reading.soil_ph,
        "soil_ec":          reading.soil_ec,
        "air_temperature":  reading.air_temperature,
        "humidity":         reading.humidity,
        "light_lux":        reading.light_lux,
    }

    if _field_id_supported:
        row["field_id"] = reading.field_id

    if _raw_columns_supported:
        if reading.soil_moisture_raw is not None:
            row["soil_moisture_raw"] = reading.soil_moisture_raw
        if reading.soil_moisture_voltage is not None:
            row["soil_moisture_voltage"] = reading.soil_moisture_voltage
        if reading.ds18b20_address is not None:
            row["ds18b20_address"] = reading.ds18b20_address

    try:
        client.table("sensor_readings").insert(row).execute()
        logger.info(f"Sensor reading stored for {reading.device_id} [{reading.field_id}]")
        return True
    except Exception as e:
        err_msg = str(e)
        is_schema_err = "column" in err_msg.lower() or "PGRST204" in err_msg
        raw_cols_in_err = any(col in err_msg for col in ["soil_moisture_raw", "soil_moisture_voltage", "ds18b20_address"])

        if _raw_columns_supported and (raw_cols_in_err or is_schema_err):
            logger.warning(
                "Supabase sensor_readings table lacks raw telemetry columns (soil_moisture_raw, etc.). "
                "Retrying with core metrics while preserving field_id. Run schema_v4_two_field.sql to enable raw telemetry."
            )
            _raw_columns_supported = False
            # Strip ONLY the optional raw columns — NEVER drop field_id!
            for k in ["soil_moisture_raw", "soil_moisture_voltage", "ds18b20_address"]:
                row.pop(k, None)

            try:
                client.table("sensor_readings").insert(row).execute()
                logger.info(f"Sensor reading stored (with field_id={reading.field_id}) for {reading.device_id}")
                return True
            except Exception as e2:
                err_msg2 = str(e2)
                if "field_id" in err_msg2 and _field_id_supported:
                    logger.error(
                        "Supabase sensor_readings table is missing the 'field_id' column entirely! "
                        "Please run schema_v4_two_field.sql immediately to support two fields."
                    )
                    _field_id_supported = False
                    row.pop("field_id", None)
                    try:
                        client.table("sensor_readings").insert(row).execute()
                        logger.warning(f"Sensor reading stored without field_id for {reading.device_id}")
                        return True
                    except Exception as e3:
                        logger.error(f"Failed to store sensor reading after emergency fallback: {e3}")
                        return False
                logger.error(f"Failed to store sensor reading after raw column removal: {e2}")
                return False

        logger.error(f"Failed to store sensor reading for {reading.device_id} [{reading.field_id}]: {e}")
        return False


def get_latest_reading(device_id: str, field_id: Optional[str] = None) -> Optional[dict]:
    """Fetch the most recent sensor reading from Supabase, optionally filtered by field_id."""
    client = get_client()
    if client is None:
        return None
    try:
        q = (
            client.table("sensor_readings")
            .select("*")
            .eq("device_id", device_id)
        )
        if field_id:
            q = q.eq("field_id", field_id)
        result = q.order("timestamp", desc=True).limit(1).execute()
        if result.data:
            return result.data[0]
        return None
    except Exception as e:
        logger.error(f"Failed to fetch latest reading: {e}")
        return None


def get_latest_two_field_readings(device_id: str) -> dict:
    """Fetch latest readings for both field_1 and field_2 for comparison."""
    client = get_client()
    if client is None:
        return {"field_1": None, "field_2": None}
    f1 = get_latest_reading(device_id, "field_1")
    f2 = get_latest_reading(device_id, "field_2")
    return {"field_1": f1, "field_2": f2}


def get_reading_history(device_id: str, field_id: Optional[str] = None, limit: int = 100) -> list[dict]:
    """Fetch the most recent N sensor readings from Supabase, optionally filtered by field_id."""
    client = get_client()
    if client is None:
        return []
    try:
        q = (
            client.table("sensor_readings")
            .select("*")
            .eq("device_id", device_id)
        )
        if field_id:
            q = q.eq("field_id", field_id)
        result = q.order("timestamp", desc=True).limit(limit).execute()
        return result.data or []
    except Exception as e:
        logger.error(f"Failed to fetch reading history: {e}")
        return []


# ─── Anomalies ────────────────────────────────────────────────────────────────

def upsert_anomaly(
    device_id: str,
    sensor: str,
    observed_value: Optional[float],
    expected_value: Optional[float],
    deviation: Optional[float],
    risk_level: str,
    message: str,
    field_id: str = "field_1",
) -> Optional[str]:
    """Insert an anomaly row into the anomalies table and return its ID."""
    client = get_client()
    if client is None:
        return None

    row = {
        "device_id":      device_id,
        "field_id":       field_id,
        "timestamp":      datetime.now(tz=timezone.utc).isoformat(),
        "sensor":         sensor,
        "observed_value": observed_value,
        "expected_value": expected_value,
        "deviation":      deviation,
        "risk_level":     risk_level,
        "message":        message,
    }

    try:
        response = client.table("anomalies").insert(row).execute()
        logger.info(f"Anomaly stored: {sensor} {risk_level} for {device_id} [{field_id}]")
        return response.data[0].get("id") if response.data else None
    except Exception as e:
        err_msg = str(e)
        if "field_id" in err_msg or "PGRST204" in err_msg:
            # Retry without field_id if column not migrated yet
            row.pop("field_id", None)
            try:
                response = client.table("anomalies").insert(row).execute()
                return response.data[0].get("id") if response.data else None
            except Exception as e2:
                logger.error(f"Failed to store anomaly fallback: {e2}")
                return None
        logger.error(f"Failed to store anomaly: {e}")
        return None


def get_recent_anomalies(device_id: str, field_id: Optional[str] = None, limit: int = 20) -> list[dict]:
    """Fetch the most recent anomalies from Supabase, optionally filtered by field_id."""
    client = get_client()
    if client is None:
        return []
    try:
        q = (
            client.table("anomalies")
            .select("*")
            .eq("device_id", device_id)
        )
        if field_id:
            q = q.eq("field_id", field_id)
        result = q.order("timestamp", desc=True).limit(limit).execute()
        return result.data or []
    except Exception as e:
        logger.error(f"Failed to fetch recent anomalies: {e}")
        return []


# ─── AI Analysis ──────────────────────────────────────────────────────────────

def store_ai_analysis(event_id: str, analysis_data: dict) -> bool:
    """Insert AI analysis result into the ai_analysis table."""
    client = get_client()
    if client is None:
        return False

    try:
        client.table("ai_analysis").insert(analysis_data).execute()
        logger.info(f"AI Analysis stored for event_id: {event_id}")
        return True
    except Exception as e:
        logger.error(f"Failed to store AI analysis for {event_id}: {e}")
        return False


def check_ai_analysis_exists(event_id: str) -> bool:
    """Check if an AI analysis already exists for this event ID to ensure idempotency."""
    client = get_client()
    if client is None:
        return False
        
    try:
        result = client.table("ai_analysis").select("id").eq("event_id", event_id).limit(1).execute()
        return len(result.data) > 0
    except Exception as e:
        logger.error(f"Failed to check AI analysis existence for {event_id}: {e}")
        return False


# ─── Device Status ────────────────────────────────────────────────────────────

def upsert_device_status(status: DeviceStatus) -> bool:
    """
    Upsert the device row in the devices table.
    Uses device_id as the unique key.
    """
    client = get_client()
    if client is None:
        return False

    row = {
        "device_id":   status.device_id,
        "device_name": status.device_name,
        "status":      status.status,
        "serial_port": status.serial_port,
        "last_seen":   status.last_seen.isoformat() if status.last_seen else None,
        "updated_at":  datetime.now(tz=timezone.utc).isoformat(),
    }

    try:
        client.table("devices").upsert(row, on_conflict="device_id").execute()
        logger.info(f"Device status updated: {status.device_id} → {status.status}")
        return True
    except Exception as e:
        logger.error(f"Failed to update device status: {e}")
        return False


def get_device_status_from_supabase(device_id: str) -> Optional[dict]:
    """Fetch device status row from Supabase."""
    client = get_client()
    if client is None:
        return None
    try:
        result = (
            client.table("devices")
            .select("*")
            .eq("device_id", device_id)
            .limit(1)
            .execute()
        )
        return result.data[0] if result.data else None
    except Exception as e:
        logger.error(f"Failed to fetch device status: {e}")
        return None


# ─── Device Events ────────────────────────────────────────────────────────────

def log_device_event(event: DeviceEvent) -> bool:
    """Insert a device lifecycle event into device_events."""
    client = get_client()
    if client is None:
        return False

    row = {
        "device_id":  event.device_id,
        "timestamp":  event.timestamp.isoformat(),
        "event_type": event.event_type,
        "message":    event.message,
    }

    try:
        client.table("device_events").insert(row).execute()
        logger.info(f"Device event logged: {event.device_id} {event.event_type}")
        return True
    except Exception as e:
        logger.error(f"Failed to log device event: {e}")
        return False


# ─── Adaptive Baselines ───────────────────────────────────────────────────────

_adaptive_baselines_table_exists = True

def upsert_adaptive_baseline(
    device_id: str,
    sensor: str,
    state_dict: dict,
    field_id: str = "field_1"
) -> bool:
    """
    Upsert one sensor's adaptive baseline state to the adaptive_baselines table.
    Uses (device_id, field_id, sensor) as conflict target.
    """
    global _adaptive_baselines_table_exists
    if not _adaptive_baselines_table_exists:
        return False

    client = get_client()
    if client is None:
        return False

    row = {
        "device_id":  device_id,
        "field_id":   field_id,
        "sensor":     sensor,
        "updated_at": datetime.now(tz=timezone.utc).isoformat(),
    }
    for k, v in state_dict.items():
        row[k] = v

    try:
        client.table("adaptive_baselines").upsert(
            row, on_conflict="device_id,field_id,sensor"
        ).execute()
        logger.debug(f"Adaptive baseline upserted: {device_id}/{field_id}/{sensor}")
        return True
    except Exception as e:
        err_str = str(e)
        if "field_id" in err_str or "conflict" in err_str.lower():
            # Fall back to legacy conflict key if table has not had schema_v4 applied
            row.pop("field_id", None)
            try:
                client.table("adaptive_baselines").upsert(
                    row, on_conflict="device_id,sensor"
                ).execute()
                return True
            except Exception as e2:
                logger.error(f"Failed to upsert adaptive baseline fallback: {e2}")
                return False
        elif "PGRST205" in err_str or "Could not find the table" in err_str:
            _adaptive_baselines_table_exists = False
            logger.warning("Table 'adaptive_baselines' is missing in Supabase. Falling back to in-memory only.")
        else:
            logger.error(f"Failed to upsert adaptive baseline for {device_id}/{sensor}: {e}")
        return False


def load_adaptive_baselines(device_id: str, field_id: Optional[str] = None) -> list[dict]:
    """
    Load adaptive baseline rows for a device and optional field from Supabase.
    Called at startup to restore baseline state.
    """
    client = get_client()
    if client is None:
        return []
    try:
        q = (
            client.table("adaptive_baselines")
            .select("*")
            .eq("device_id", device_id)
        )
        if field_id:
            q = q.eq("field_id", field_id)
        result = q.execute()
        return result.data or []
    except Exception as e:
        logger.error(f"Failed to load adaptive baselines for {device_id}: {e}")
        return []


def get_bounded_reading_history(device_id: str, field_id: str = "field_1", limit: int = 2016) -> list[dict]:
    """
    Fetch the most recent `limit` sensor readings for the adaptive calculation path
    for a specific field.
    NEVER called from the fast path (per-packet).
    Hard-capped at 2016 rows to prevent full-table scans.
    """
    client = get_client()
    if client is None:
        return []
    try:
        result = (
            client.table("sensor_readings")
            .select(
                "timestamp,soil_moisture,soil_temperature,"
                "air_temperature,humidity,light_lux"
            )
            .eq("device_id", device_id)
            .eq("field_id", field_id)
            .order("timestamp", desc=True)
            .limit(min(limit, 2016))
            .execute()
        )
        return result.data or []
    except Exception as e:
        # Fallback without field_id filter if column doesn't exist
        try:
            result = (
                client.table("sensor_readings")
                .select(
                    "timestamp,soil_moisture,soil_temperature,"
                    "air_temperature,humidity,light_lux"
                )
                .eq("device_id", device_id)
                .order("timestamp", desc=True)
                .limit(min(limit, 2016))
                .execute()
            )
            return result.data or []
        except Exception as e2:
            logger.error(f"Failed to fetch bounded reading history for {device_id}: {e2}")
            return []
