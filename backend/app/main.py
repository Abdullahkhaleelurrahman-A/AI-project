# =============================================================================
# MARUDAM Backend — FastAPI Application
# =============================================================================
from __future__ import annotations

import asyncio
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncGenerator, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.utils.logger import get_logger
from app.api import health, device, sensor, weather
from app.services import serial_manager, sensor_service, supabase_service, device_service, anomaly_service, adaptive_baseline_service, india_context_service, ai_service, weather_service
from app.models.sensor import ESP32Packet

logger = get_logger("main")

# In-memory rolling history buffer for live dashboard charts (up to 60 readings)
_live_history_buffer: deque[dict] = deque(maxlen=60)


def _record_packet_to_live_history(packet: ESP32Packet) -> None:
    """Appends live packet telemetry into in-memory rolling buffer for real-time charts."""
    try:
        now_utc = datetime.now(tz=timezone.utc)
        now_iso = now_utc.isoformat()
        now_time = now_utc.strftime("%H:%M:%S")

        f1 = packet.fields.get("field_1") if packet.fields else None
        f2 = packet.fields.get("field_2") if packet.fields else None

        m1 = f1.soil_moisture if f1 else packet.soil_moisture
        m1_raw = f1.soil_moisture_raw if f1 else None
        m1_volt = f1.soil_moisture_voltage if f1 else None
        t1 = f1.soil_temperature if f1 else packet.soil_temperature

        m2 = f2.soil_moisture if f2 else None
        m2_raw = f2.soil_moisture_raw if f2 else None
        m2_volt = f2.soil_moisture_voltage if f2 else None
        t2 = f2.soil_temperature if f2 else None

        shared = packet.shared
        air_temp = shared.air_temperature if shared else packet.air_temperature
        humidity = shared.humidity if shared else packet.humidity
        light_lux = shared.light_lux if shared else packet.light_lux

        entry = {
            "timestamp": now_iso,
            "time": now_time,
            "field1Moisture": m1,
            "field1Raw": m1_raw,
            "field1Voltage": m1_volt,
            "field1Temp": t1,
            "field2Moisture": m2,
            "field2Raw": m2_raw,
            "field2Voltage": m2_volt,
            "field2Temp": t2,
            "airTemperature": air_temp,
            "humidity": humidity,
            "lightLux": light_lux,
        }
        _live_history_buffer.append(entry)
    except Exception as e:
        logger.warning(f"Failed to record live history: {e}")


# ─── Packet Processing Pipeline ───────────────────────────────────────────────

def _sync_pipeline_worker(packet: ESP32Packet) -> None:
    """
    Runs in a worker thread to persist sensor readings, update device status,
    and detect anomalies in Supabase without blocking the main asyncio event loop.
    """
    try:
        readings = sensor_service.normalise_packet_fields(packet)

        device_service.record_reading_received(
            port=serial_manager.get_device_status().get("serial_port") or "MOCK"
        )

        for reading in readings:
            stored = supabase_service.upsert_reading(reading)
            if not stored:
                logger.warning(
                    f"[Pipeline] Sensor reading for {reading.device_id} [{reading.field_id}] "
                    f"was not saved to Supabase. Check Supabase service configuration and permissions."
                )

            anomaly_result = anomaly_service.detect(reading)

            # Trigger Gemini AI if an anomaly was successfully stored (event_ids present)
            if anomaly_result and anomaly_result.event_ids:
                async def run_ai(res=anomaly_result, r=reading):
                    try:
                        context = await india_context_service.get_context_for_device(r.device_id)
                        user_lang = context.get("user_language", "English")
                        await ai_service.analyze_events_with_gemini(res, context, user_lang)
                    except Exception as e:
                        logger.error(f"Background AI task failed for {r.field_id}: {e}")

                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(run_ai())
                except RuntimeError:
                    pass
    except Exception as e:
        logger.error(f"Error in background packet pipeline: {e}")


def on_packet_received(packet: ESP32Packet) -> None:
    """
    Called by the serial manager for every valid ESP32 packet.
    1. Immediately record live telemetry in memory for instant API response.
    2. Offload cloud database persistence to a worker thread so the event loop
       never freezes and /api/sensors/live responds in < 2ms.
    """
    try:
        _record_packet_to_live_history(packet)

        try:
            loop = asyncio.get_running_loop()
            loop.create_task(asyncio.to_thread(_sync_pipeline_worker, packet))
        except RuntimeError:
            import threading
            threading.Thread(target=_sync_pipeline_worker, args=(packet,), daemon=True).start()
    except Exception as e:
        logger.error(f"Error dispatching packet pipeline: {e}")


# ─── Lifespan (startup / shutdown) ────────────────────────────────────────────

_serial_task: asyncio.Task | None = None
_adaptive_task: asyncio.Task | None = None


async def _adaptive_baseline_loop(device_id: str) -> None:
    """
    ADAPTIVE PATH background loop.
    Runs periodically for both fields. Fetches bounded history, recalculates
    robust baselines, and persists to Supabase.
    Never called per-packet (that is the FAST PATH in anomaly_service).
    """
    logger.info(f"Adaptive baseline loop started for {device_id} across fields")
    while True:
        try:
            context = await india_context_service.get_context_for_device(device_id)
            min_interval = 24.0
            for fid in ["field_1", "field_2"]:
                state = await adaptive_baseline_service.run_adaptive_calculation(
                    device_id=device_id, context=context, field_id=fid
                )
                min_interval = min(min_interval, max(state.update_interval_hours, 0.25))
            sleep_hours = min_interval
        except Exception as e:
            logger.error(f"Adaptive baseline loop error: {e}")
            sleep_hours = 1.0   # back off 1 h on error

        await asyncio.sleep(sleep_hours * 3600)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator:
    global _serial_task

    logger.info("=" * 55)
    logger.info("  MARUDAM Local Backend starting")
    logger.info(f"  Device ID : {settings.device_id}")
    logger.info(f"  Serial    : {settings.serial_port}")
    logger.info(f"  Mock mode : {settings.mock_serial}")
    logger.info(f"  Supabase  : {'configured' if settings.supabase_configured else 'NOT configured'}")
    logger.info("=" * 55)

    # Register packet callback before starting the reader
    serial_manager.set_packet_callback(on_packet_received)

    # Restore previously persisted adaptive baselines (survives restarts)
    adaptive_baseline_service.restore_from_supabase(settings.device_id)

    # Start the background serial reader task
    _serial_task = asyncio.create_task(
        serial_manager.serial_reader_task(),
        name="serial_reader",
    )
    logger.info("Serial reader task started.")

    # Start the adaptive baseline background task
    _adaptive_task = asyncio.create_task(
        _adaptive_baseline_loop(settings.device_id),
        name="adaptive_baseline",
    )
    logger.info("Adaptive baseline task started.")

    yield  # Application runs here

    # ── Shutdown ──────────────────────────────────────────────────────────────
    logger.info("Shutting down MARUDAM backend...")
    for task in [_serial_task, _adaptive_task]:
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    logger.info("Shutdown complete.")


# ─── FastAPI App ──────────────────────────────────────────────────────────────

app = FastAPI(
    title       = "MARUDAM Local Sensor API",
    description = "Local FastAPI backend for MARUDAM smart soil/plant monitoring system.",
    version     = "1.0.0",
    lifespan    = lifespan,
)

# CORS: allow Next.js frontend (localhost:3000 in dev, Vercel in prod).
# The Vercel frontend reads from Supabase directly, not this local API.
# This CORS config is for local development only.
app.add_middleware(
    CORSMiddleware,
    allow_origins      = settings.cors_origins_list,
    allow_origin_regex = r"http://192\.168\.\d+\.\d+(:\d+)?",
    allow_credentials  = True,
    allow_methods      = ["*"],
    allow_headers      = ["*"],
)

# ─── ESP32 Wi-Fi Ingestion & Live Sensor Endpoints ────────────────────────────

from fastapi import Request
import time

# In-memory store for the latest Wi-Fi reading (shared with serial_manager)
_wifi_last_received: dict | None = None
_wifi_last_timestamp: float | None = None


@app.post("/api/sensors/esp32", tags=["esp32-wifi"])
@app.post("/api/sensors", tags=["esp32-wifi"])
@app.post("/api/sensor/reading", tags=["esp32-wifi"])
async def receive_esp32_wifi_packet(request: Request):
    """
    Receive a sensor reading from ESP32 over Wi-Fi (HTTP POST).
    Accepts Schema v2.0 JSON, Schema v1.0 JSON, flat sensor keys,
    or raw streaming text blocks.
    Injects into the full pipeline: serial_manager → Supabase → anomaly → AI.
    """
    global _wifi_last_received, _wifi_last_timestamp

    body_bytes = await request.body()
    body_text = body_bytes.decode("utf-8", errors="replace").strip()

    packet: Optional[ESP32Packet] = None

    # 1. Try parsing as JSON first
    if body_text.startswith("{") or "{" in body_text:
        try:
            import json as _json
            start_i = body_text.find("{")
            end_i = body_text.rfind("}")
            raw_body = _json.loads(body_text[start_i:end_i+1])

            if isinstance(raw_body, dict):
                if not raw_body.get("device_id"):
                    raw_body["device_id"] = settings.device_id

                # If already Schema 2.0 with fields dict
                if "fields" in raw_body and isinstance(raw_body["fields"], dict):
                    packet = ESP32Packet(**raw_body)
                else:
                    # Check for flat two-field keys (soil_moisture_1, temp_1, etc.)
                    m1_pct = raw_body.get("soil_moisture_1") or raw_body.get("moisture_1") or raw_body.get("moisture_sensor_1")
                    m1_raw = raw_body.get("soil_moisture_1_raw") or raw_body.get("moisture_1_raw") or raw_body.get("moisture_sensor_1_raw")
                    m1_v   = raw_body.get("soil_moisture_1_voltage") or raw_body.get("moisture_1_voltage")

                    m2_pct = raw_body.get("soil_moisture_2") or raw_body.get("moisture_2") or raw_body.get("moisture_sensor_2")
                    m2_raw = raw_body.get("soil_moisture_2_raw") or raw_body.get("moisture_2_raw") or raw_body.get("moisture_sensor_2_raw")
                    m2_v   = raw_body.get("soil_moisture_2_voltage") or raw_body.get("moisture_2_voltage")

                    t1 = raw_body.get("soil_temperature_1") or raw_body.get("soil_temp_1") or raw_body.get("temp_1") or raw_body.get("ds18b20_1")
                    t2 = raw_body.get("soil_temperature_2") or raw_body.get("soil_temp_2") or raw_body.get("temp_2") or raw_body.get("ds18b20_2")

                    t_air = raw_body.get("air_temperature") or raw_body.get("air_temp") or raw_body.get("temperature")
                    rh    = raw_body.get("humidity") or raw_body.get("air_humidity")
                    lux   = raw_body.get("light_lux") or raw_body.get("light_intensity") or raw_body.get("lux")

                    if any(x is not None for x in [m1_pct, m1_raw, m2_pct, m2_raw, t1, t2]):
                        f1_dict = {
                            "field_id": "field_1",
                            "soil_moisture": m1_pct if m1_pct is not None else raw_body.get("soil_moisture"),
                            "soil_moisture_raw": m1_raw,
                            "soil_moisture_voltage": m1_v or (round(m1_raw * 0.000125, 3) if m1_raw is not None else None),
                            "soil_temperature": t1 if t1 is not None else raw_body.get("soil_temperature"),
                        }
                        f2_dict = {
                            "field_id": "field_2",
                            "soil_moisture": m2_pct,
                            "soil_moisture_raw": m2_raw,
                            "soil_moisture_voltage": m2_v or (round(m2_raw * 0.000125, 3) if m2_raw is not None else None),
                            "soil_temperature": t2,
                        }
                        packet = ESP32Packet(
                            device_id=raw_body["device_id"],
                            fields={"field_1": f1_dict, "field_2": f2_dict},
                            shared={"air_temperature": t_air, "humidity": rh, "light_lux": lux},
                            soil_moisture=f1_dict["soil_moisture"],
                            soil_temperature=f1_dict["soil_temperature"],
                            air_temperature=t_air,
                            humidity=rh,
                            light_lux=lux,
                        )
                    else:
                        packet = ESP32Packet(**raw_body)
        except Exception as e:
            logger.warning(f"Wi-Fi JSON parse failed ({e}), checking text block format...")

    # 2. If not parsed as JSON, try parsing as Arduino text format line-by-line
    if packet is None:
        for line in body_text.splitlines():
            res = serial_manager.parse_serial_line(line)
            if res:
                packet = res

    if packet is None:
        return {"status": "error", "message": "Could not parse sensor readings from payload"}

    # Store in-memory for /api/sensors/live
    _wifi_last_received = packet.model_dump()
    _wifi_last_timestamp = time.time()

    # Inject into the same pipeline as USB serial
    serial_manager.inject_wifi_packet(packet)

    logger.info(
        f"Wi-Fi packet received from {packet.device_id} | "
        f"moisture={packet.soil_moisture} temp={packet.soil_temperature} "
        f"rh={packet.humidity} lux={packet.light_lux}"
    )

    return {"status": "ok", "device_id": packet.device_id, "timestamp": datetime.now(tz=timezone.utc).isoformat()}


@app.get("/api/sensors/live", tags=["esp32-wifi"])
async def get_live_sensor_data():
    """
    Returns the latest in-memory sensor data for the dashboard.
    Works with both Serial and Wi-Fi sources.
    No Supabase required — purely in-memory for fast polling.
    """
    pkt = serial_manager.get_last_packet()
    dev = serial_manager.get_device_status()

    if not pkt:
        return {
            "connected": False,
            "source": "none",
            "device_id": settings.device_id,
            "last_updated": None,
            "age_seconds": None,
            "field_1": None,
            "field_2": None,
            "shared": None,
            "sensor_status": None,
            "history": list(_live_history_buffer),
        }

    dev_status = dev.get("status") or "DISCONNECTED"
    age = dev.get("last_reading_age_s")
    is_connected = (dev_status == "CONNECTED") and (age is not None) and (age < 30)
    source = dev.get("serial_port") or "none"
    is_wifi = source == "WIFI"

    if not is_connected:
        return {
            "connected": False,
            "status": "DISCONNECTED" if dev_status in ["DISCONNECTED", "UNKNOWN"] else dev_status,
            "source": "wifi" if is_wifi else ("serial" if source != "none" else "none"),
            "device_id": pkt.get("device_id", settings.device_id) if pkt else settings.device_id,
            "last_updated": dev.get("last_seen"),
            "age_seconds": int(age) if age is not None else None,
            "field_1": None,
            "field_2": None,
            "shared": None,
            "sensor_status": None,
            "history": list(_live_history_buffer),
        }

    # Extract two-field data from packet
    fields_data = pkt.get("fields", {}) if pkt else {}
    shared_data = pkt.get("shared", {}) if pkt else {}

    packet_time = (pkt.get("received_at") if pkt else None) or dev.get("last_seen") or datetime.now(tz=timezone.utc).isoformat()

    def build_field(fid: str) -> dict | None:
        fd = fields_data.get(fid)
        if not fd:
            return None
        return {
            "field_id":              fd.get("field_id", fid),
            "soil_moisture":         fd.get("soil_moisture"),
            "soil_moisture_raw":     fd.get("soil_moisture_raw"),
            "soil_moisture_voltage":  fd.get("soil_moisture_voltage"),
            "soil_temperature":      fd.get("soil_temperature"),
            "ds18b20_address":       fd.get("ds18b20_address"),
            "air_temperature":       shared_data.get("air_temperature") if isinstance(shared_data, dict) else None,
            "humidity":              shared_data.get("humidity") if isinstance(shared_data, dict) else None,
            "light_lux":             shared_data.get("light_lux") if isinstance(shared_data, dict) else None,
            "soil_ph":               None,
            "soil_ec":               None,
            "timestamp":             packet_time,
            "device_id":             pkt.get("device_id", settings.device_id) if pkt else settings.device_id,
        }

    shared_env = {
        "air_temperature": shared_data.get("air_temperature") if isinstance(shared_data, dict) else (pkt.get("air_temperature") if pkt else None),
        "humidity":        shared_data.get("humidity") if isinstance(shared_data, dict) else (pkt.get("humidity") if pkt else None),
        "light_lux":       shared_data.get("light_lux") if isinstance(shared_data, dict) else (pkt.get("light_lux") if pkt else None),
    }

    return {
        "connected":     True,
        "status":        "CONNECTED",
        "source":        "wifi" if is_wifi else "serial",
        "device_id":     pkt.get("device_id", settings.device_id) if pkt else settings.device_id,
        "last_updated":  dev.get("last_seen"),
        "age_seconds":   int(age) if age is not None else None,
        "field_1":       build_field("field_1"),
        "field_2":       build_field("field_2"),
        "shared":        shared_env,
        "sensor_status": pkt.get("sensor_status") if pkt else None,
        "history":       list(_live_history_buffer),
    }


# ─── Routers ─────────────────────────────────────────────────────────────────

app.include_router(health.router,   tags=["health"])
app.include_router(device.router,   tags=["device"])
app.include_router(sensor.router,   tags=["sensor"])
app.include_router(weather.router,  tags=["weather"])

# ─── Legacy compatibility routes ──────────────────────────────────────────────
# Keep the original API paths working so the existing dashboard doesn't break.
# These delegate to the new services transparently.

from fastapi import HTTPException as _HTTPException
from fastapi.responses import JSONResponse

@app.get("/api/status/{device_id}", tags=["legacy"])
async def legacy_device_status(device_id: str):
    info = serial_manager.get_device_status()
    age  = info.get("last_reading_age_s")
    ser_status = info.get("status")
    if ser_status == "DISCONNECTED":
        status = "DISCONNECTED"
    elif age is None:
        status = "CONNECTED" if ser_status == "CONNECTED" else "DISCONNECTED"
    elif age <= 30 and ser_status == "CONNECTED":
        status = "ONLINE"
    elif age <= 120 and ser_status == "CONNECTED":
        status = "STALE"
    else:
        status = "DISCONNECTED"
    return {
        "device_id":   device_id,
        "status":      status,
        "serial_port": info.get("serial_port"),
        "last_seen":   info.get("last_seen"),
        "age_seconds": int(age) if age else None,
    }

@app.get("/api/sensors/compare/{device_id}", tags=["sensors"])
async def compare_two_fields(device_id: str):
    """
    Returns latest readings for both Field 1 and Field 2 side-by-side,
    including shared environmental context, raw ADC counts, and probe addresses.
    """
    data = supabase_service.get_latest_two_field_readings(device_id)
    pkt = serial_manager.get_last_packet()
    dev_status = serial_manager.get_device_status()
    is_live = dev_status.get("status") == "CONNECTED"

    if pkt and isinstance(pkt, dict) and "fields" in pkt:
        pkt_fields = pkt.get("fields", {})
        shared = pkt.get("shared", {})
        now_iso = datetime.now(tz=timezone.utc).isoformat()
        for fid in ["field_1", "field_2"]:
            if fid in pkt_fields:
                live_item = {
                    **pkt_fields[fid],
                    "timestamp": now_iso,
                    "device_id": device_id,
                    **shared,
                }
                # When device is actively streaming, or DB has no reading yet, supply live reading
                if is_live or not data.get(fid):
                    data[fid] = live_item
    
    f1 = data.get("field_1") or {}
    f2 = data.get("field_2") or {}
    shared_from_pkt = pkt.get("shared", {}) if (pkt and isinstance(pkt, dict)) else {}
    shared_env = {
        "air_temperature": f1.get("air_temperature") or f2.get("air_temperature") or shared_from_pkt.get("air_temperature"),
        "humidity":        f1.get("humidity") or f2.get("humidity") or shared_from_pkt.get("humidity"),
        "light_lux":       f1.get("light_lux") or f2.get("light_lux") or shared_from_pkt.get("light_lux"),
    }
    return {
        "device_id": device_id,
        "field_1":   data.get("field_1"),
        "field_2":   data.get("field_2"),
        "shared":    shared_env,
    }

@app.get("/api/sensors/latest/{device_id}", tags=["legacy"])
async def legacy_latest(device_id: str, field_id: Optional[str] = None):
    # Try Supabase first to get injected dataset values (pH, EC) and specific field
    row = await asyncio.to_thread(supabase_service.get_latest_reading, device_id, field_id=field_id)
    if row:
        return row
    
    pkt = serial_manager.get_last_packet()
    if not pkt:
        raise _HTTPException(status_code=404, detail="No readings yet")
    return pkt

@app.get("/api/baseline/{device_id}", tags=["legacy"])
async def legacy_baseline(device_id: str, field_id: str = "field_1"):
    """Returns the full adaptive baseline state for a device and field."""
    return adaptive_baseline_service.get_full_baseline_state(device_id, field_id=field_id)

@app.get("/api/events/{device_id}", tags=["legacy"])
async def legacy_events(device_id: str, field_id: Optional[str] = None):
    rows = await asyncio.to_thread(supabase_service.get_recent_anomalies, device_id, field_id=field_id, limit=20)
    return rows

@app.get("/api/context/{device_id}", tags=["context"])
async def get_device_context(device_id: str):
    """Returns the resolved India agricultural context for a device."""
    context = await india_context_service.get_context_for_device(device_id)
    return context

@app.get("/api/decision/{device_id}", tags=["legacy"])
async def evaluate_decision(device_id: str):
    """
    Phase 5 Core Evidence Fusion Engine. Recomputes decision dynamically.
    Ported from legacy SQLite implementation to Supabase backend architecture.
    """
    latest_reading = await asyncio.to_thread(supabase_service.get_latest_reading, device_id)
    if not latest_reading:
        return {"field_status": "UNCERTAIN", "recommendation_action": "CHECK_FIELD", "evidence_summary": [{"code": "NO_SENSOR_DATA"}]}

    baselines_raw = adaptive_baseline_service.get_full_baseline_state(device_id)
    baselines = baselines_raw.get("sensors", {})
    if not baselines:
        return {"field_status": "UNCERTAIN", "recommendation_action": "MONITOR", "evidence_summary": [{"code": "AWAITING_BASELINE"}]}

    events = await asyncio.to_thread(supabase_service.get_recent_anomalies, device_id, limit=20)
    
    # 1. Root Zone Estimation
    root_zone_moisture = "UNKNOWN"
    rz_confidence = 0.5
    evidence = []

    # Map legacy event status/type to new Supabase anomaly fields
    moisture_event = next((e for e in events if e.get("sensor") == "soil_moisture" and e.get("deviation", 0) < 0), None)
    is_persistent = moisture_event and moisture_event.get("risk_level") in ["HIGH", "CRITICAL"]

    latest_sm = latest_reading.get("soil_moisture")
    if latest_sm is not None and "soil_moisture" in baselines:
        b = baselines["soil_moisture"]
        min_expected = b.get("min_expected", 0)
        max_expected = b.get("max_expected", 100)
        
        if latest_sm < min_expected:
            if is_persistent:
                root_zone_moisture = "LOW"
                rz_confidence = 0.8
                evidence.append({"code": "MOISTURE_DROP_PERSISTENT", "value": latest_sm})
            else:
                root_zone_moisture = "NORMAL" # Wait for persistence
                evidence.append({"code": "MOISTURE_DROP_RECENT"})
        elif latest_sm > max_expected:
            root_zone_moisture = "HIGH"
            evidence.append({"code": "MOISTURE_ABOVE_BASELINE"})
        else:
            root_zone_moisture = "NORMAL"

    # Contextual Modifiers for Root-Zone Confidence
    if root_zone_moisture == "LOW":
        st = latest_reading.get("air_temperature") # mapped from surrounding_temperature
        if st is not None and st > 32:
            rz_confidence = min(1.0, rz_confidence + 0.1)
            evidence.append({"code": "HIGH_SURROUNDING_TEMPERATURE"})
        rh = latest_reading.get("humidity") # mapped from air_humidity
        if rh is not None and rh < 40:
            rz_confidence = min(1.0, rz_confidence + 0.1)
            evidence.append({"code": "LOW_AIR_HUMIDITY"})

    # 2. Weather Fusion
    rain_prob = 0
    weather_status = "unavailable"
    weather_cond = None
    weather_temp = None
    if settings.weather_configured:
        try:
            w_res = await weather_service.get_current_weather(device_id=device_id)
            f_res = await weather_service.get_forecast(device_id=device_id)
            if w_res and "current" in w_res:
                weather_status = "available"
                weather_cond = w_res["current"].get("condition")
                weather_temp = w_res["current"].get("temperature")
            if f_res and "forecast_days" in f_res and len(f_res["forecast_days"]) > 0:
                rain_prob = f_res["forecast_days"][0].get("rain_probability_max", 0)
                evidence.append({"code": "WEATHER_FUSED", "value": f"Rain chance: {rain_prob:.0f}% ({weather_cond})"})
            else:
                evidence.append({"code": "WEATHER_FUSED", "value": f"Current: {weather_cond}"})
        except Exception as e:
            evidence.append({"code": "WEATHER_UNAVAILABLE"})
    else:
        evidence.append({"code": "WEATHER_UNAVAILABLE"})

    # 3. Cause Ranking & Recommendation
    risk_type = "NONE"
    risk_level = "LOW"
    action = "MONITOR"
    decision_confidence = 0.5

    is_water_deficit = root_zone_moisture == "LOW"

    if is_water_deficit:
        risk_type = "WATER_DEFICIT"
        if rain_prob > 70:
            risk_level = "MODERATE"
            action = "WAIT_FOR_RAIN"
            decision_confidence = rz_confidence * 0.9
            evidence.append({"code": "DELAY_IRRIGATION_RAIN_EXPECTED"})
        elif rain_prob < 30:
            risk_level = "HIGH"
            action = "CONSIDER_IRRIGATION"
            decision_confidence = rz_confidence * 0.95
        else:
            risk_level = "MODERATE"
            action = "CONSIDER_IRRIGATION"
            decision_confidence = rz_confidence * 0.8
            
    # Uncertainty / Low Confidence Safety
    if "soil_moisture" in baselines and baselines["soil_moisture"].get("confidence", 1.0) < 0.3:
        action = "CHECK_FIELD"
        decision_confidence = 0.2
        evidence.append({"code": "BASELINE_CONFIDENCE_LOW"})

    status = "NORMAL"
    if risk_level == "MODERATE": status = "WATCH"
    if risk_level == "HIGH": status = "ATTENTION"
    if action == "CHECK_FIELD": status = "UNCERTAIN"
    if risk_type == "NONE" and status == "UNCERTAIN": action = "MONITOR"

    decision = {
        "field_status": status,
        "risk_type": risk_type,
        "risk_level": risk_level,
        "confidence": round(decision_confidence, 2),
        "recommendation_action": action,
        "evidence_summary": evidence,
        "root_zone": {
            "moisture_state": root_zone_moisture,
            "confidence": round(rz_confidence, 2)
        },
        "weather": {
            "rain_probability": rain_prob if weather_status == "available" else None,
            "status": weather_status,
            "condition": weather_cond,
            "temperature": weather_temp,
        }
    }

    # Persistence not supported in current architecture yet
    return decision
