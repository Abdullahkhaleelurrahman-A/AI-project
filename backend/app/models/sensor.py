# =============================================================================
# MARUDAM Backend — Sensor Pydantic Models (Two-Field Supported)
# =============================================================================
from __future__ import annotations
from datetime import datetime
from typing import Optional, Dict, Any, Union
from pydantic import BaseModel, field_validator, model_validator


# ─── Sensor Status ────────────────────────────────────────────────────────────

class SensorStatus(BaseModel):
    """Per-sensor status as reported by the ESP32."""
    soil_moisture:       str = "unknown"
    soil_temperature:    str = "unknown"
    soil_ph:             str = "unavailable"
    soil_ec:             str = "unavailable"
    air_temperature:     str = "unknown"
    humidity:            str = "unknown"
    light_lux:           str = "unknown"
    dht22:               Optional[str] = None
    bh1750:              Optional[str] = None
    ads1115:             Optional[str] = None
    field_1_moisture:    Optional[str] = None
    field_1_temperature: Optional[str] = None
    field_2_moisture:    Optional[str] = None
    field_2_temperature: Optional[str] = None


# ─── Two-Field Sub-Models ─────────────────────────────────────────────────────

class FieldSoilData(BaseModel):
    """Field-specific soil measurements."""
    field_id:              str = "field_1"
    soil_moisture_raw:     Optional[int]   = None
    soil_moisture_voltage: Optional[float] = None
    soil_moisture:         Optional[float] = None
    soil_temperature:      Optional[float] = None
    ds18b20_address:       Optional[str]   = None
    status_moisture:       Optional[str]   = "ok"
    status_temperature:    Optional[str]   = "ok"

    @field_validator("soil_moisture")
    @classmethod
    def moisture_range(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (0.0 <= v <= 100.0):
            raise ValueError(f"soil_moisture {v} out of range [0, 100]")
        return v

    @field_validator("soil_temperature")
    @classmethod
    def temperature_range(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (-40.0 <= v <= 85.0):
            raise ValueError(f"soil_temperature {v} out of range [-40, 85]")
        return v


class SharedAtmosphericData(BaseModel):
    """Shared environmental measurements for the zone."""
    air_temperature: Optional[float] = None
    humidity:        Optional[float] = None
    light_lux:       Optional[float] = None

    @field_validator("humidity")
    @classmethod
    def humidity_range(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (0.0 <= v <= 100.0):
            raise ValueError(f"humidity {v} out of range [0, 100]")
        return v

    @field_validator("air_temperature")
    @classmethod
    def temperature_range(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (-40.0 <= v <= 85.0):
            raise ValueError(f"air_temperature {v} out of range [-40, 85]")
        return v

    @field_validator("light_lux")
    @classmethod
    def lux_range(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v < 0:
            raise ValueError(f"light_lux {v} must be >= 0")
        return v


# ─── Raw ESP32 Packet ─────────────────────────────────────────────────────────

class ESP32Packet(BaseModel):
    """
    Parsed from the raw JSON Line received over USB serial.
    Supports both Schema v2.0 (two fields + shared context) and Schema v1.0 (flat).
    All sensor values are optional (null if sensor unavailable or errored).
    """
    device_id:        str
    firmware_version: Optional[str]  = None
    schema_version:   Optional[str]  = None
    uptime_ms:        Optional[int]  = None
    timestamp:        Optional[str]  = None   # Ignored — backend applies UTC

    # Schema v2.0 structured objects
    shared:           Optional[SharedAtmosphericData] = None
    fields:           Optional[Dict[str, FieldSoilData]] = None

    # Schema v1.0 flat fields (kept for backward compatibility)
    soil_moisture:    Optional[float] = None
    soil_temperature: Optional[float] = None
    soil_ph:          Optional[float] = None
    soil_ec:          Optional[float] = None
    air_temperature:  Optional[float] = None
    humidity:         Optional[float] = None
    light_lux:        Optional[float] = None
    sensor_status:    Optional[Union[SensorStatus, Dict[str, Any]]] = None

    @field_validator("device_id")
    @classmethod
    def device_id_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("device_id must not be empty")
        return v.strip()

    @field_validator("soil_moisture")
    @classmethod
    def moisture_range(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (0.0 <= v <= 100.0):
            raise ValueError(f"soil_moisture {v} out of range [0, 100]")
        return v

    @field_validator("humidity")
    @classmethod
    def humidity_range(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (0.0 <= v <= 100.0):
            raise ValueError(f"humidity {v} out of range [0, 100]")
        return v

    @field_validator("soil_temperature", "air_temperature")
    @classmethod
    def temperature_range(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (-40.0 <= v <= 85.0):
            raise ValueError(f"temperature {v} out of range [-40, 85]")
        return v

    @field_validator("soil_ph")
    @classmethod
    def ph_range(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and not (0.0 <= v <= 14.0):
            raise ValueError(f"soil_ph {v} out of range [0, 14]")
        return v

    @field_validator("light_lux")
    @classmethod
    def lux_range(cls, v: Optional[float]) -> Optional[float]:
        if v is not None and v < 0:
            raise ValueError(f"light_lux {v} must be >= 0")
        return v

    @model_validator(mode="after")
    def populate_cross_compatibility(self) -> ESP32Packet:
        # If shared is not explicitly populated, populate from root fields
        if self.shared is None:
            self.shared = SharedAtmosphericData(
                air_temperature = self.air_temperature,
                humidity        = self.humidity,
                light_lux       = self.light_lux,
            )
        else:
            # Sync root from shared if root is missing
            if self.air_temperature is None:
                self.air_temperature = self.shared.air_temperature
            if self.humidity is None:
                self.humidity = self.shared.humidity
            if self.light_lux is None:
                self.light_lux = self.shared.light_lux

        # If fields dictionary is not provided, construct field_1 from root
        if not self.fields:
            self.fields = {
                "field_1": FieldSoilData(
                    field_id         = "field_1",
                    soil_moisture    = self.soil_moisture,
                    soil_temperature = self.soil_temperature,
                )
            }
        else:
            # Sync root soil values from field_1 for legacy consumers
            f1 = self.fields.get("field_1")
            if f1:
                if self.soil_moisture is None:
                    self.soil_moisture = f1.soil_moisture
                if self.soil_temperature is None:
                    self.soil_temperature = f1.soil_temperature
        return self


# ─── Normalised Sensor Reading (for Supabase + internal use) ──────────────────

class SensorReading(BaseModel):
    """
    A validated, normalised sensor reading ready to be stored in Supabase.
    Includes explicit field_id to completely isolate Field 1 and Field 2.
    """
    device_id:             str
    field_id:              str = "field_1"
    timestamp:             datetime
    soil_moisture_raw:     Optional[int]   = None
    soil_moisture_voltage: Optional[float] = None
    soil_moisture:         Optional[float] = None
    soil_temperature:      Optional[float] = None
    ds18b20_address:       Optional[str]   = None
    soil_ph:               Optional[float] = None
    soil_ec:               Optional[float] = None
    air_temperature:       Optional[float] = None
    humidity:              Optional[float] = None
    light_lux:             Optional[float] = None
    firmware_version:      Optional[str]   = None
    sensor_status:         Optional[Union[SensorStatus, Dict[str, Any]]] = None


# ─── API Response Models ──────────────────────────────────────────────────────

class SensorReadingResponse(SensorReading):
    """Sensor reading as returned by the API (includes DB id)."""
    id: Optional[str] = None
    created_at: Optional[datetime] = None


class LatestSensorResponse(BaseModel):
    """Response from GET /sensor/latest."""
    device_id: str
    reading: Optional[SensorReading] = None
    source: str = "supabase"  # "supabase" | "local"
