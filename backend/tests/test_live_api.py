# =============================================================================
# MARUDAM Backend — Tests for Live & ESP32 Ingestion Endpoints
# =============================================================================
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.services import serial_manager

client = TestClient(app)


def test_live_sensor_endpoint_empty():
    """Verify GET /api/sensors/live returns structured payload even when empty."""
    response = client.get("/api/sensors/live")
    assert response.status_code == 200
    data = response.json()
    assert "connected" in data
    assert "field_1" in data
    assert "field_2" in data
    assert "shared" in data


def test_post_esp32_wifi_schema_v2():
    """Verify POST /api/sensors/esp32 accepts Schema v2.0 JSON and updates live endpoint."""
    payload = {
        "device_id": "FIELD_001",
        "fields": {
            "field_1": {
                "field_id": "field_1",
                "soil_moisture_raw": 11291,
                "soil_moisture_voltage": 1.411,
                "soil_moisture": 87.1,
                "soil_temperature": 30.19,
                "ds18b20_address": "28E00BBA000000CD"
            },
            "field_2": {
                "field_id": "field_2",
                "soil_moisture_raw": 8327,
                "soil_moisture_voltage": 1.041,
                "soil_moisture": 100.0,
                "soil_temperature": 29.75,
                "ds18b20_address": "286307B3000000CC"
            }
        },
        "shared": {
            "air_temperature": 32.0,
            "humidity": 69.5,
            "light_lux": 311.67
        }
    }
    post_res = client.post("/api/sensors/esp32", json=payload)
    assert post_res.status_code == 200
    assert post_res.json()["status"] == "ok"

    # Now verify GET /api/sensors/live returns this reading
    live_res = client.get("/api/sensors/live")
    assert live_res.status_code == 200
    live_data = live_res.json()
    assert live_data["connected"] is True
    assert live_data["source"] == "wifi"
    assert live_data["field_1"]["soil_moisture"] == 87.1
    assert live_data["field_1"]["soil_moisture_raw"] == 11291
    assert live_data["field_1"]["soil_temperature"] == 30.19
    assert live_data["field_2"]["soil_moisture"] == 100.0
    assert live_data["field_2"]["soil_temperature"] == 29.75
    assert live_data["shared"]["air_temperature"] == 32.0
    assert live_data["shared"]["humidity"] == 69.5
    assert live_data["shared"]["light_lux"] == 311.67


def test_post_esp32_text_block_format():
    """Verify POST /api/sensors/esp32 also accepts the Arduino serial text block format."""
    text_payload = """========== SENSOR READINGS ==========
Moisture Sensor 1 RAW (A0): 11291
Moisture Sensor 1 estimated: 87.1%
Moisture Sensor 2 RAW (A1): 8327
Moisture Sensor 2 estimated: 100.0%
Soil Temperature Probe 1: 30.19 C
Soil Temperature Probe 2: 29.75 C
Air Temperature: 32.00 C
Air Humidity: 69.50 %
Light Intensity: 311.67 lux
====================================="""

    post_res = client.post(
        "/api/sensors/esp32",
        content=text_payload,
        headers={"Content-Type": "text/plain"}
    )
    assert post_res.status_code == 200
    assert post_res.json()["status"] == "ok"

    live_res = client.get("/api/sensors/live")
    assert live_res.status_code == 200
    live_data = live_res.json()
    assert live_data["connected"] is True
    assert live_data["field_1"]["soil_moisture"] == 87.1
    assert live_data["field_2"]["soil_moisture"] == 100.0


def test_live_sensor_endpoint_when_disconnected():
    """Verify that when the device is disconnected, live readings return None and status is DISCONNECTED."""
    from app.services import serial_manager, device_service
    serial_manager._device_status = "DISCONNECTED"
    device_service.update_status("DISCONNECTED", serial_port=None)

    live_res = client.get("/api/sensors/live")
    assert live_res.status_code == 200
    data = live_res.json()
    assert data["connected"] is False
    assert data["status"] == "DISCONNECTED"
    assert data["field_1"] is None
    assert data["field_2"] is None
    assert data["shared"] is None

