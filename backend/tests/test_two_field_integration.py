# =============================================================================
# MARUDAM Backend — Two-Field Integration Unit Tests
# =============================================================================
import pytest
import json
from datetime import datetime, timezone

from app.models.sensor import ESP32Packet, SensorReading, FieldSoilData, SharedAtmosphericData
from app.services.serial_manager import parse_json_line
from app.services.sensor_service import normalise_packet_fields
from app.services import anomaly_service, adaptive_baseline_service


class TestTwoFieldFirmwarePayload:
    """Test parsing and validation of the ESP32 Schema v2.0 two-field payloads."""

    def test_parse_valid_two_field_payload(self):
        payload = {
            "device_id": "FIELD_001",
            "firmware_version": "2.0.0",
            "schema_version": "2.0",
            "uptime_ms": 45120,
            "timestamp": None,
            "shared": {
                "air_temperature": 29.4,
                "humidity": 63.8,
                "light_lux": 18500.0,
            },
            "fields": {
                "field_1": {
                    "field_id": "field_1",
                    "soil_moisture_raw": 17200,
                    "soil_moisture_voltage": 2.150,
                    "soil_moisture": None,
                    "soil_temperature": 26.2,
                    "ds18b20_address": "28FF641E8014029C",
                },
                "field_2": {
                    "field_id": "field_2",
                    "soil_moisture_raw": 19450,
                    "soil_moisture_voltage": 2.431,
                    "soil_moisture": None,
                    "soil_temperature": 27.5,
                    "ds18b20_address": "28A472918014035D",
                },
            },
            "sensor_status": {
                "dht22": "ok",
                "bh1750": "ok",
                "ads1115": "ok",
                "field_1_moisture": "ok",
                "field_1_temperature": "ok",
                "field_2_moisture": "ok",
                "field_2_temperature": "ok",
            },
        }

        packet = parse_json_line(json.dumps(payload))
        assert packet is not None
        assert packet.device_id == "FIELD_001"
        assert packet.firmware_version == "2.0.0"
        assert packet.shared.air_temperature == pytest.approx(29.4)
        assert packet.shared.light_lux == pytest.approx(18500.0)

        assert "field_1" in packet.fields
        assert "field_2" in packet.fields

        f1 = packet.fields["field_1"]
        assert f1.soil_moisture_raw == 17200
        assert f1.soil_moisture_voltage == pytest.approx(2.150)
        assert f1.soil_moisture is None  # Uncalibrated moisture remains null!
        assert f1.soil_temperature == pytest.approx(26.2)
        assert f1.ds18b20_address == "28FF641E8014029C"

        f2 = packet.fields["field_2"]
        assert f2.soil_moisture_raw == 19450
        assert f2.soil_moisture_voltage == pytest.approx(2.431)
        assert f2.soil_temperature == pytest.approx(27.5)
        assert f2.ds18b20_address == "28A472918014035D"

    def test_two_field_normalisation(self):
        packet = ESP32Packet(
            device_id="FIELD_001",
            firmware_version="2.0.0",
            schema_version="2.0",
            shared=SharedAtmosphericData(
                air_temperature=31.0,
                humidity=55.0,
                light_lux=25000.0,
            ),
            fields={
                "field_1": FieldSoilData(
                    field_id="field_1",
                    soil_moisture_raw=16500,
                    soil_moisture_voltage=2.06,
                    soil_moisture=52.0,
                    soil_temperature=25.0,
                    ds18b20_address="28FF641E8014029C",
                ),
                "field_2": FieldSoilData(
                    field_id="field_2",
                    soil_moisture_raw=21000,
                    soil_moisture_voltage=2.62,
                    soil_moisture=38.0,
                    soil_temperature=28.5,
                    ds18b20_address="28A472918014035D",
                ),
            },
        )

        readings = normalise_packet_fields(packet)
        assert len(readings) == 2

        r1 = next(r for r in readings if r.field_id == "field_1")
        r2 = next(r for r in readings if r.field_id == "field_2")

        # Atmospheric readings are shared consistently
        assert r1.air_temperature == r2.air_temperature == 31.0
        assert r1.humidity == r2.humidity == 55.0
        assert r1.light_lux == r2.light_lux == 25000.0

        # Field 1 soil readings
        assert r1.soil_moisture == 52.0
        assert r1.soil_temperature == 25.0
        assert r1.soil_moisture_raw == 16500
        assert r1.ds18b20_address == "28FF641E8014029C"

        # Field 2 soil readings
        assert r2.soil_moisture == 38.0
        assert r2.soil_temperature == 28.5
        assert r2.soil_moisture_raw == 21000
        assert r2.ds18b20_address == "28A472918014035D"

    def test_missing_measurements_remain_null(self):
        """Missing sensor measurements must not fabricate 0.0 or defaults."""
        payload = {
            "device_id": "FIELD_001",
            "fields": {
                "field_1": {
                    "field_id": "field_1",
                    "soil_moisture_raw": None,
                    "soil_moisture_voltage": None,
                    "soil_moisture": None,
                    "soil_temperature": None,
                },
                "field_2": {
                    "field_id": "field_2",
                    "soil_moisture_raw": 18000,
                    "soil_moisture_voltage": 2.25,
                    "soil_moisture": None,
                    "soil_temperature": None,
                },
            },
        }
        packet = parse_json_line(json.dumps(payload))
        assert packet is not None
        readings = normalise_packet_fields(packet)
        r1 = next(r for r in readings if r.field_id == "field_1")
        assert r1.soil_moisture is None
        assert r1.soil_temperature is None
        assert r1.soil_moisture_raw is None


class TestTwoFieldIsolation:
    """Verify that Field 1 and Field 2 baselines and anomalies never contaminate each other."""

    def test_field_baseline_and_persistence_isolation(self):
        dev = "TEST_DEVICE_ISO"

        # Explicitly configure distinct baselines for Field 1 and Field 2
        state_f1 = adaptive_baseline_service._get_or_create_state(dev, "field_1")
        state_f1.sensors["soil_moisture"] = adaptive_baseline_service.SensorBaselineState(
            sensor="soil_moisture",
            center=50.0,
            mad=2.0,
            mad_eff=2.0,
            k_multiplier=3.0,
            min_expected=44.0,
            max_expected=56.0,
        )

        state_f2 = adaptive_baseline_service._get_or_create_state(dev, "field_2")
        state_f2.sensors["soil_moisture"] = adaptive_baseline_service.SensorBaselineState(
            sensor="soil_moisture",
            center=50.0,
            mad=2.0,
            mad_eff=2.0,
            k_multiplier=3.0,
            min_expected=40.0,
            max_expected=60.0,
        )

        # Inject anomaly on field_1 only (75.0 is outside [44.0, 56.0])
        reading_f1_anomaly = SensorReading(
            device_id=dev,
            field_id="field_1",
            timestamp=datetime.now(tz=timezone.utc),
            soil_moisture=75.0,  # Out-of-bounds anomaly for field 1
            soil_temperature=25.0,
            air_temperature=30.0,
            humidity=60.0,
            light_lux=10000.0,
        )

        reading_f2_normal = SensorReading(
            device_id=dev,
            field_id="field_2",
            timestamp=datetime.now(tz=timezone.utc),
            soil_moisture=50.0,  # In-bounds normal for field 2
            soil_temperature=25.0,
            air_temperature=30.0,
            humidity=60.0,
            light_lux=10000.0,
        )

        # Detect on field 1
        res1 = anomaly_service.detect(reading_f1_anomaly)
        assert res1.field_id == "field_1"
        assert res1.risk_level in ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
        assert len(res1.evidence) >= 1
        assert "SOIL_MOISTURE_ABOVE_BASELINE" in res1.evidence[0].code

        # Detect on field 2
        res2 = anomaly_service.detect(reading_f2_normal)
        assert res2.field_id == "field_2"
        # Field 2 must remain NORMAL, unaffected by Field 1's anomaly
        assert res2.risk_level == "NORMAL"
        assert res2.field_status == "NORMAL"
        assert len(res2.evidence) == 0
