# =============================================================================
# MARUDAM Backend — Sensor Service (Two-Field Supported)
# =============================================================================
# Converts an ESP32Packet into normalised SensorReading objects with UTC timestamps.
# Generates distinct readings for Field 1 and Field 2 with explicit field_id.
# =============================================================================
from __future__ import annotations

from datetime import datetime, timezone
from typing import List

from app.models.sensor import ESP32Packet, SensorReading, SensorStatus, FieldSoilData
from app.services import supabase_service, soil_dataset_service
from app.config import settings
from app.utils.logger import get_logger

logger = get_logger("sensor_service")


_crop_ref_cache: dict[str, tuple[float | None, float | None]] = {}


def _get_crop_reference(device_id: str) -> tuple[float | None, float | None]:
    if device_id in _crop_ref_cache:
        return _crop_ref_cache[device_id]
    ref_ph = None
    ref_ec = None
    try:
        client = supabase_service.get_client()
        if client:
            farm_res = client.table("farms").select("crop_id").eq("device_id", device_id).limit(1).execute()
            if farm_res.data:
                crop_id = farm_res.data[0].get("crop_id")
                if crop_id:
                    ref_ph, ref_ec = soil_dataset_service.get_crop_soil_reference(crop_id)
            _crop_ref_cache[device_id] = (ref_ph, ref_ec)
    except Exception as e:
        logger.debug(f"Could not resolve crop soil reference for {device_id}: {e}")
    return ref_ph, ref_ec


def normalise_packet_fields(packet: ESP32Packet) -> List[SensorReading]:
    """
    Convert a validated two-field ESP32Packet into a list of SensorReading objects
    (one for each monitored field, e.g. field_1 and field_2).
    - Applies a server-side UTC timestamp (ESP32 has no RTC).
    - Preserves explicit field_id, raw ADC counts, voltages, and probe hardware addresses.
    - Shares atmospheric measurements (DHT22 air temp/humidity, BH1750 lux) consistently.
    - Injects median reference pH/EC from soil dataset based on crop where physical probe is absent.
    """
    logical_device_id = settings.device_id
    now_utc = datetime.now(tz=timezone.utc)
    readings: List[SensorReading] = []

    shared_air_temp = packet.shared.air_temperature if packet.shared else packet.air_temperature
    shared_humidity = packet.shared.humidity if packet.shared else packet.humidity
    shared_light    = packet.shared.light_lux if packet.shared else packet.light_lux

    # Fetch crop reference using cached lookup
    ref_ph, ref_ec = _get_crop_reference(logical_device_id)

    # Process all fields present in packet
    fields_dict = packet.fields or {}
    if not fields_dict:
        fields_dict = {
            "field_1": FieldSoilData(
                field_id         = "field_1",
                soil_moisture    = packet.soil_moisture,
                soil_temperature = packet.soil_temperature,
            )
        }

    for f_key, f_data in fields_dict.items():
        field_id = f_data.field_id or f_key
        reading = SensorReading(
            device_id             = logical_device_id,
            field_id              = field_id,
            timestamp             = now_utc,
            soil_moisture_raw     = f_data.soil_moisture_raw,
            soil_moisture_voltage = f_data.soil_moisture_voltage,
            soil_moisture         = f_data.soil_moisture,
            soil_temperature      = f_data.soil_temperature,
            ds18b20_address       = f_data.ds18b20_address,
            soil_ph               = packet.soil_ph or ref_ph,
            soil_ec               = packet.soil_ec or ref_ec,
            air_temperature       = shared_air_temp,
            humidity              = shared_humidity,
            light_lux             = shared_light,
            firmware_version      = packet.firmware_version,
            sensor_status         = packet.sensor_status or SensorStatus(),
        )
        readings.append(reading)

    return readings


def normalise_packet(packet: ESP32Packet) -> SensorReading:
    """
    Backward-compatible single-reading normaliser.
    Returns the Field 1 reading.
    """
    readings = normalise_packet_fields(packet)
    return readings[0] if readings else SensorReading(
        device_id = settings.device_id,
        timestamp = datetime.now(tz=timezone.utc),
    )
