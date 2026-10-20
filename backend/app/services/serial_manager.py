# =============================================================================
# MARUDAM Backend — Serial Manager
# =============================================================================
# Responsibilities:
#   - Scan available COM ports
#   - Auto-detect the ESP32 using USB metadata (VID/PID or description)
#   - Open the serial connection
#   - Read JSON Lines continuously
#   - Detect disconnection and reconnect automatically
#   - Never crash FastAPI when the USB cable is removed
#   - Expose the latest valid packet and device status for other services
#
# Design: runs as a background asyncio task inside the FastAPI process.
# The task is started on app startup and cancelled on shutdown.
# =============================================================================
from __future__ import annotations

import asyncio
import json
import random
import time
from datetime import datetime, timezone
from typing import Callable, Optional

import re
import serial
import serial.tools.list_ports

from app.config import settings
from app.models.sensor import ESP32Packet, SensorStatus, FieldSoilData, SharedAtmosphericData
from app.services import device_service
from app.utils.logger import get_logger

logger = get_logger("serial_manager")

# ─── ESP32 USB vendor/product IDs ─────────────────────────────────────────────
# These cover the most common ESP32 DevKit USB-to-Serial chips.
# CP2102 (Silicon Labs) and CH340 are the most prevalent.
ESP32_USB_VIDS: set[int] = {
    0x10C4,  # Silicon Labs CP2102
    0x1A86,  # QinHeng Electronics CH340
    0x0403,  # FTDI
    0x067B,  # Prolific PL2303
}

# Substrings to look for in port description (case-insensitive fallback)
ESP32_DESCRIPTION_HINTS = [
    "cp210",
    "ch340",
    "ftdi",
    "usb serial",
    "uart",
    "esp32",
    "silicon labs",
]

# ─── Global state (in-process, not shared across workers) ─────────────────────
_current_port:   Optional[str]   = None
_device_status:  str             = "UNKNOWN"   # CONNECTED / DISCONNECTED / UNKNOWN
_last_packet:    Optional[dict]  = None
_last_seen:      Optional[float] = None        # time.time()
_on_packet_cb:   Optional[Callable[[ESP32Packet], None]] = None


# ─── Public accessors ─────────────────────────────────────────────────────────

def get_device_status() -> dict:
    age = round(time.time() - _last_seen, 1) if _last_seen else None
    return {
        "device_id":          settings.device_id,
        "status":             _device_status,
        "serial_port":        _current_port,
        "last_seen":          datetime.fromtimestamp(_last_seen, tz=timezone.utc).isoformat() if _last_seen else None,
        "last_reading_age_s": age,
    }


def get_last_packet() -> Optional[dict]:
    return _last_packet


def inject_wifi_packet(packet: ESP32Packet) -> None:
    """
    Called when a valid ESP32 packet arrives over Wi-Fi (HTTP POST).
    Updates the same global state and fires the same callback as USB serial,
    so the rest of the pipeline (Supabase, anomaly detection, AI) works
    identically regardless of transport.
    """
    global _last_packet, _last_seen, _device_status, _current_port

    pkt_dict = packet.model_dump()
    pkt_dict["received_at"] = datetime.now(tz=timezone.utc).isoformat()
    _last_packet   = pkt_dict
    _last_seen     = time.time()
    _device_status = "CONNECTED"
    _current_port  = "WIFI"
    device_service.update_status("CONNECTED", serial_port="WIFI", last_seen=datetime.now(tz=timezone.utc))

    if _on_packet_cb:
        try:
            _on_packet_cb(packet)
        except Exception as e:
            logger.error(f"Wi-Fi packet callback error: {e}")


def set_packet_callback(cb: Callable[[ESP32Packet], None]) -> None:
    """Register a callback that is called for every valid parsed packet."""
    global _on_packet_cb
    _on_packet_cb = cb


# ─── Port discovery ───────────────────────────────────────────────────────────

def list_ports() -> list[dict]:
    """Return all available serial ports with metadata."""
    ports = []
    for p in serial.tools.list_ports.comports():
        ports.append({
            "port":        p.device,
            "description": p.description or "",
            "vid":         p.vid,
            "pid":         p.pid,
            "hwid":        p.hwid or "",
        })
    return ports


def find_esp32_port() -> Optional[str]:
    """
    Scan COM ports and return the most likely ESP32 port.
    Uses USB VID matching first, then falls back to description hints.
    Returns None if no candidate is found.
    """
    candidates = []
    for p in serial.tools.list_ports.comports():
        score = 0

        # Strong signal: USB VID matches known ESP32 USB chips
        if p.vid in ESP32_USB_VIDS:
            score += 10

        # Weaker signal: description contains known strings
        desc_lower = (p.description or "").lower()
        for hint in ESP32_DESCRIPTION_HINTS:
            if hint in desc_lower:
                score += 5
                break

        if score > 0:
            candidates.append((score, p.device))

    if not candidates:
        return None

    # Return the highest-scoring port
    candidates.sort(key=lambda x: x[0], reverse=True)
    return candidates[0][1]


def resolve_port() -> Optional[str]:
    """
    Determine which serial port to use.
    - If SERIAL_PORT=AUTO → auto-detect ESP32
    - Otherwise use the configured port directly
    """
    if settings.serial_port.upper() == "AUTO":
        port = find_esp32_port()
        if port:
            logger.info(f"ESP32 auto-detected on {port}")
        else:
            logger.warning("ESP32 not detected on any COM port. Is it plugged in?")
        return port
    else:
        logger.info(f"Using configured port: {settings.serial_port}")
        return settings.serial_port


# ─── JSON parsing ─────────────────────────────────────────────────────────────

def parse_json_line(raw_line: str) -> Optional[ESP32Packet]:
    """
    Parse a raw serial line containing exactly one JSON object.
    Rejects malformed JSON, empty lines, and non-JSON text banners.
    Validates sensor values against physical limits and returns ESP32Packet.
    """
    line = raw_line.strip()
    if not line:
        return None

    # Handle optional leading/trailing garbage bytes around JSON object
    start_idx = line.find("{")
    end_idx = line.rfind("}")
    if start_idx == -1 or end_idx <= start_idx:
        return None

    json_str = line[start_idx:end_idx+1]
    try:
        data = json.loads(json_str)
        if not isinstance(data, dict):
            logger.error("JSON payload is not a dictionary object")
            return None
        return ESP32Packet(**data)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON from serial: {e} | raw: {line[:120]}")
        return None
    except Exception as e:
        logger.error(f"Sensor validation failed: {e} | raw: {line[:120]}")
        return None


# ─── Dual-Mode (JSON + Arduino Test Sketch) Serial Parsing ───────────────────

_text_block_buffer: list[str] = []
_discovered_probe_1: str = "28E00BBA000000CD"
_discovered_probe_2: str = "286307B3000000CC"


def parse_text_line(raw_line: str) -> Optional[ESP32Packet]:
    """
    Statefully process streaming text lines from Arduino test sketches.
    Buffers lines between '----- SENSOR READINGS -----' and '---------------------------',
    discovering 1-Wire addresses and building a validated two-field ESP32Packet.
    """
    global _text_block_buffer, _discovered_probe_1, _discovered_probe_2
    line_clean = raw_line.strip()
    if not line_clean:
        return None

    # Track probe discovery lines from bootup
    if m := re.search(r'Probe\s+1\s+address:\s*([0-9A-Fa-f]+)', line_clean, re.I):
        _discovered_probe_1 = m.group(1).upper()
        logger.info(f"Discovered Probe 1 hardware address: {_discovered_probe_1}")
        return None
    if m := re.search(r'Probe\s+2\s+address:\s*([0-9A-Fa-f]+)', line_clean, re.I):
        _discovered_probe_2 = m.group(1).upper()
        logger.info(f"Discovered Probe 2 hardware address: {_discovered_probe_2}")
        return None

    # Header delimiter (matches ====== SENSOR READINGS ====== or ------ SENSOR READINGS ------)
    if re.search(r'[-=~*]{2,}\s*SENSOR READINGS\s*[-=~*]{2,}', line_clean, re.I):
        _text_block_buffer = []
        return None

    if _text_block_buffer is not None:
        _text_block_buffer.append(line_clean)
        # End of reading block reached: footer line with 5+ dashes/equals or buffer filled
        if re.search(r'^[-=~*]{5,}$', line_clean) or len(_text_block_buffer) >= 14:
            text = "\n".join(_text_block_buffer)
            _text_block_buffer = []

            t_air = float(m.group(1)) if (m := re.search(r'Air\s+temperature:\s*([\d\.\-]+)', text, re.I)) else None
            rh    = float(m.group(1)) if (m := re.search(r'Air\s+humidity:\s*([\d\.\-]+)', text, re.I)) else None
            lux   = float(m.group(1)) if (m := re.search(r'Light(?:\s+intensity)?:\s*([\d\.\-]+)', text, re.I)) else None

            # Moisture sensor 1: raw counts, estimated %, and voltage
            m1_raw = int(m.group(1)) if (m := re.search(r'(?:Moisture\s+Sensor\s+1|MOISTURE_1).*?(?:RAW|raw)(?:\s+value)?:\s*(\d+)', text, re.I)) else None
            m1_pct = None
            if m := re.search(r'(?:Moisture\s+Sensor\s+1|MOISTURE_1).*?(?:percent|relative\s+moisture|estimated).*?:\s*([\d\.\-]+)', text, re.I):
                m1_pct = float(m.group(1))
            elif m := re.search(r'(?:Moisture\s+Sensor\s+1|MOISTURE_1)[^:\n]*:\s*([\d\.\-]+)\s*%', text, re.I):
                m1_pct = float(m.group(1))

            m1_v = float(m.group(1)) if (m := re.search(r'(?:Moisture\s+Sensor\s+1|MOISTURE_1).*?voltage:\s*([\d\.\-]+)', text, re.I)) else (round(m1_raw * 0.000125, 3) if m1_raw is not None else None)

            # If raw indicates disconnected/shorted sensor (<= 100), do not accept fake percentage
            if m1_raw is not None and m1_raw <= 100:
                m1_pct = None

            # Moisture sensor 2: raw counts, estimated %, and voltage
            m2_raw = int(m.group(1)) if (m := re.search(r'(?:Moisture\s+Sensor\s+2|MOISTURE_2).*?(?:RAW|raw)(?:\s+value)?:\s*(\d+)', text, re.I)) else None
            m2_pct = None
            if m := re.search(r'(?:Moisture\s+Sensor\s+2|MOISTURE_2).*?(?:percent|relative\s+moisture|estimated).*?:\s*([\d\.\-]+)', text, re.I):
                m2_pct = float(m.group(1))
            elif m := re.search(r'(?:Moisture\s+Sensor\s+2|MOISTURE_2)[^:\n]*:\s*([\d\.\-]+)\s*%', text, re.I):
                m2_pct = float(m.group(1))

            m2_v = float(m.group(1)) if (m := re.search(r'(?:Moisture\s+Sensor\s+2|MOISTURE_2).*?voltage:\s*([\d\.\-]+)', text, re.I)) else (round(m2_raw * 0.000125, 3) if m2_raw is not None else None)

            if m2_raw is not None and m2_raw <= 100:
                m2_pct = None

            # Temperature probes
            t_s1 = float(m.group(1)) if (m := re.search(r'(?:DS18B20\s+Probe\s+1|Soil\s+temperature\s+probe\s+1|Probe\s+1(?:\s+temp)?):\s*([\d\.\-]+)', text, re.I)) else None
            t_s2 = float(m.group(1)) if (m := re.search(r'(?:DS18B20\s+Probe\s+2|Soil\s+temperature\s+probe\s+2|Probe\s+2(?:\s+temp)?):\s*([\d\.\-]+)', text, re.I)) else None

            if any(v is not None for v in [t_air, rh, lux, m1_raw, m1_pct, m2_raw, m2_pct, t_s1, t_s2]):
                try:
                    f1_status = "ok" if (m1_raw is not None and m1_raw > 100) or m1_pct is not None else ("error" if m1_raw is not None and m1_raw <= 100 else "unavailable")
                    f2_status = "ok" if (m2_raw is not None and m2_raw > 100) or m2_pct is not None else ("error" if m2_raw is not None and m2_raw <= 100 else "unavailable")

                    return ESP32Packet(
                        device_id=settings.device_id,
                        firmware_version="1.0.0-sketch",
                        schema_version="2.0",
                        shared=SharedAtmosphericData(air_temperature=t_air, humidity=rh, light_lux=lux),
                        fields={
                            "field_1": FieldSoilData(
                                field_id="field_1",
                                soil_moisture_raw=m1_raw,
                                soil_moisture_voltage=m1_v,
                                soil_moisture=m1_pct,
                                soil_temperature=t_s1,
                                ds18b20_address=_discovered_probe_1,
                                status_moisture=f1_status,
                            ),
                            "field_2": FieldSoilData(
                                field_id="field_2",
                                soil_moisture_raw=m2_raw,
                                soil_moisture_voltage=m2_v,
                                soil_moisture=m2_pct,
                                soil_temperature=t_s2,
                                ds18b20_address=_discovered_probe_2,
                                status_moisture=f2_status,
                            ),
                        },
                        sensor_status={
                            "dht22": "ok" if t_air is not None else "unavailable",
                            "bh1750": "ok" if lux is not None else "unavailable",
                            "ads1115": "ok" if (m1_raw is not None or m2_raw is not None) else "unavailable",
                            "field_1_moisture": f1_status,
                            "field_1_temperature": "ok" if t_s1 is not None else "unavailable",
                            "field_2_moisture": f2_status,
                            "field_2_temperature": "ok" if t_s2 is not None else "unavailable",
                        }
                    )
                except Exception as e:
                    logger.error(f"Error building packet from text block: {e}")
                    return None
    return None


def parse_serial_line(raw_line: str) -> Optional[ESP32Packet]:
    """
    Parse a raw serial line.
    Supports both:
      1. Schema v2.0 JSON Lines (contains '{' and '}')
      2. Arduino IDE test sketch text blocks ('------ SENSOR READINGS ------')
    """
    line = raw_line.strip()
    if not line:
        return None

    if "{" in line and "}" in line:
        pkt = parse_json_line(line)
        if pkt:
            return pkt

    return parse_text_line(line)



# ─── Mock sensor mode ─────────────────────────────────────────────────────────

def _generate_mock_packet() -> ESP32Packet:
    """Generate a realistic fake two-field sensor packet for development without hardware."""
    from app.models.sensor import FieldSoilData, SharedAtmosphericData
    return ESP32Packet(
        device_id        = settings.device_id,
        firmware_version = "2.0.0",
        schema_version   = "2.0",
        uptime_ms        = int(time.time() * 1000) % 10000000,
        timestamp        = None,
        shared           = SharedAtmosphericData(
            air_temperature = round(random.uniform(28.0, 36.0), 1),
            humidity        = round(random.uniform(50.0, 75.0), 1),
            light_lux       = round(random.uniform(5000.0, 65000.0), 0),
        ),
        fields           = {
            "field_1": FieldSoilData(
                field_id              = "field_1",
                soil_moisture_raw     = random.randint(15000, 22000),
                soil_moisture_voltage = round(random.uniform(1.8, 2.5), 3),
                soil_moisture         = round(random.uniform(45.0, 70.0), 1),
                soil_temperature      = round(random.uniform(24.0, 30.0), 1),
                ds18b20_address       = "28FF641E8014029C",
                status_moisture       = "ok",
                status_temperature    = "ok",
            ),
            "field_2": FieldSoilData(
                field_id              = "field_2",
                soil_moisture_raw     = random.randint(16000, 23000),
                soil_moisture_voltage = round(random.uniform(1.9, 2.6), 3),
                soil_moisture         = round(random.uniform(40.0, 65.0), 1),
                soil_temperature      = round(random.uniform(25.0, 31.0), 1),
                ds18b20_address       = "28A472918014035D",
                status_moisture       = "ok",
                status_temperature    = "ok",
            ),
        },
        sensor_status    = SensorStatus(
            soil_moisture    = "ok",
            soil_temperature = "ok",
            soil_ph          = "unavailable",
            soil_ec          = "unavailable",
            air_temperature  = "ok",
            humidity         = "ok",
            light_lux        = "ok",
            dht22            = "ok",
            bh1750           = "ok",
            ads1115          = "ok",
        ),
    )


# ─── Background task ──────────────────────────────────────────────────────────

async def serial_reader_task() -> None:
    """
    Long-running asyncio task.
    - Opens the serial port.
    - Reads JSON Lines continuously.
    - On disconnect: updates status, waits, retries.
    - On valid packet: updates globals, fires callback.
    - Never propagates exceptions to the FastAPI event loop.
    """
    global _current_port, _device_status, _last_packet, _last_seen

    # ── Mock mode ─────────────────────────────────────────────────────────────
    if settings.mock_serial:
        logger.warning("MOCK_SERIAL=true — generating fake sensor data. Disable in production!")
        while True:
            packet = _generate_mock_packet()
            pkt_dict = packet.model_dump()
            pkt_dict["received_at"] = datetime.now(tz=timezone.utc).isoformat()
            _last_packet   = pkt_dict
            _last_seen     = time.time()
            _device_status = "CONNECTED"
            _current_port  = "MOCK"
            if _on_packet_cb:
                try:
                    _on_packet_cb(packet)
                except Exception as e:
                    logger.error(f"Packet callback error: {e}")
            await asyncio.sleep(settings.serial_baud and 5)   # 5s mock interval
        return

    # ── Real serial loop ──────────────────────────────────────────────────────
    logger.info("Serial reader task started.")
    device_service.update_status("DISCONNECTED", serial_port=None)

    while True:
        port = resolve_port()

        if not port:
            if _device_status != "DISCONNECTED":
                _device_status = "DISCONNECTED"
                _current_port  = None
                device_service.update_status("DISCONNECTED", serial_port=None)
                logger.warning("No ESP32 found. Retrying in 10 s...")
            await asyncio.sleep(10)
            continue

        # ── Attempt to open the port ──────────────────────────────────────────
        try:
            ser = serial.Serial(
                port=port,
                baudrate=settings.serial_baud,
                timeout=2.0,
            )
            # Release hardware reset line on ESP32 DevKit auto-reset circuit
            try:
                ser.dtr = False
                ser.rts = False
            except Exception:
                pass
            _current_port  = port
            _device_status = "CONNECTED"
            device_service.update_status("CONNECTED", serial_port=port)
            logger.info(f"Serial connection established on {port} @ {settings.serial_baud} baud.")
        except serial.SerialException as e:
            logger.error(f"Cannot open {port}: {e}. Retrying in 10 s...")
            _device_status = "DISCONNECTED"
            _current_port = None
            device_service.update_status("DISCONNECTED", serial_port=None)
            await asyncio.sleep(10)
            continue

        # ── Read loop ─────────────────────────────────────────────────────────
        try:
            while True:
                # Use run_in_executor to avoid blocking the event loop
                raw = await asyncio.get_event_loop().run_in_executor(
                    None, _readline_safe, ser
                )

                if raw is None:
                    # Port was closed externally / device removed
                    break

                packet = parse_serial_line(raw)
                if packet is None:
                    continue

                # ── Valid packet received ─────────────────────────────────────
                logger.info(
                    f"Received packet from {packet.device_id} | "
                    f"moisture={packet.soil_moisture} temp={packet.soil_temperature} "
                    f"rh={packet.humidity} lux={packet.light_lux}"
                )
                packet_dict = packet.model_dump()
                packet_dict["received_at"] = datetime.now(tz=timezone.utc).isoformat()
                _last_packet   = packet_dict
                _last_seen     = time.time()
                _device_status = "CONNECTED"

                if _on_packet_cb:
                    try:
                        _on_packet_cb(packet)
                    except Exception as e:
                        logger.error(f"Packet callback error: {e}")

        except serial.SerialException as e:
            logger.error(f"Serial read error on {port}: {e}")
        except Exception as e:
            logger.error(f"Unexpected error in serial reader: {e}")
        finally:
            try:
                if ser.is_open:
                    ser.close()
            except Exception:
                pass
            _device_status = "DISCONNECTED"
            _current_port  = None
            device_service.update_status("DISCONNECTED", serial_port=None)
            logger.warning(f"ESP32 disconnected from {port}. Scanning for reconnection in 5 s...")
            await asyncio.sleep(5)


def _readline_safe(ser: serial.Serial) -> Optional[str]:
    """
    Read one line from the serial port.
    Returns None if the port is closed/disconnected.
    Blocks for up to ser.timeout seconds then returns empty string.
    """
    try:
        raw_bytes = ser.readline()
        if not raw_bytes:
            return ""
        return raw_bytes.decode("utf-8", errors="replace")
    except serial.SerialException:
        return None
    except Exception:
        return None
