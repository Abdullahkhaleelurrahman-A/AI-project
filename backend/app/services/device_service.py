# =============================================================================
# MARUDAM Backend — Device Service
# =============================================================================
# Tracks in-memory device state and synchronises with Supabase.
# Fires device events when status transitions occur.
# =============================================================================
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Optional

from app.config import settings
from app.models.device import DeviceStatus, DeviceEvent
from app.utils.logger import get_logger
import app.services.supabase_service as supa

logger = get_logger("device_service")

# In-process device state (single-device model)
_state = DeviceStatus(device_id=settings.device_id)
_prev_status: str = "UNKNOWN"


def get_status() -> DeviceStatus:
    return _state


_last_db_sync: float = 0


def update_status(
    new_status: str,
    serial_port: Optional[str] = None,
    last_seen: Optional[datetime] = None,
) -> None:
    """
    Update device status. If it changed from the previous value,
    log a device event to Supabase and emit a console log.
    """
    global _prev_status, _last_db_sync

    _state.status      = new_status  # type: ignore[assignment]
    _state.updated_at  = datetime.now(tz=timezone.utc)

    if serial_port is not None:
        _state.serial_port = serial_port

    if last_seen is not None:
        _state.last_seen = last_seen

    # Only act on transitions (or periodic 30s heartbeat)
    if new_status == _prev_status:
        now_ts = time.time()
        if now_ts - _last_db_sync >= 30:
            supa.upsert_device_status(_state)
            _last_db_sync = now_ts
        return

    _last_db_sync = time.time()

    logger.info(f"Device status: {_prev_status} -> {new_status}")

    # Map status to event type
    event_type_map = {
        "CONNECTED":    "connected" if _prev_status != "UNKNOWN" else "connected",
        "DISCONNECTED": "disconnected",
        "SENSOR_ERROR": "sensor_error",
        "BACKEND_ERROR":"backend_error",
    }
    event_type = event_type_map.get(new_status, "connected")

    # Special case: DISCONNECTED → CONNECTED = reconnected
    if _prev_status == "DISCONNECTED" and new_status == "CONNECTED":
        event_type = "reconnected"

    event = DeviceEvent(
        device_id  = settings.device_id,
        timestamp  = datetime.now(tz=timezone.utc),
        event_type = event_type,  # type: ignore[arg-type]
        message    = f"Status changed to {new_status}" + (f" on {serial_port}" if serial_port else ""),
    )

    supa.upsert_device_status(_state)
    supa.log_device_event(event)

    _prev_status = new_status


def record_reading_received(port: str) -> None:
    """Call this each time a valid sensor packet is received."""
    now = datetime.now(tz=timezone.utc)
    update_status("CONNECTED", serial_port=port, last_seen=now)
