# =============================================================================
# MARUDAM Backend — Tests: Serial Manager
# =============================================================================
import pytest
import json
from app.services.serial_manager import parse_json_line
from app.models.sensor import ESP32Packet


class TestParseJsonLine:
    """Tests for the JSON Line parser — the most critical parsing path."""

    def test_valid_full_packet(self):
        line = json.dumps({
            "device_id": "MARUDAM-01",
            "timestamp": None,
            "soil_moisture": 55.2,
            "soil_temperature": 27.1,
            "soil_ph": None,
            "soil_ec": None,
            "air_temperature": 32.5,
            "humidity": 65.0,
            "light_lux": 12000.0,
        })
        result = parse_json_line(line)
        assert result is not None
        assert isinstance(result, ESP32Packet)
        assert result.device_id == "MARUDAM-01"
        assert result.soil_moisture == pytest.approx(55.2)
        assert result.soil_ph is None

    def test_valid_partial_packet_nulls_ok(self):
        """A packet with some null sensors is valid — not all sensors required."""
        line = json.dumps({
            "device_id": "MARUDAM-01",
            "soil_moisture": 60.0,
            "soil_temperature": None,
            "air_temperature": None,
            "humidity": None,
            "light_lux": None,
        })
        result = parse_json_line(line)
        assert result is not None
        assert result.soil_moisture == 60.0
        assert result.soil_temperature is None

    def test_empty_line_returns_none(self):
        result = parse_json_line("")
        assert result is None

    def test_whitespace_line_returns_none(self):
        result = parse_json_line("   \n  ")
        assert result is None

    def test_diagnostic_banner_returns_none(self):
        """Startup banners from ESP32 must be silently ignored."""
        result = parse_json_line("===========================================")
        assert result is None

    def test_diagnostic_info_line_returns_none(self):
        result = parse_json_line("  MARUDAM ESP32 Sensor Node")
        assert result is None

    def test_malformed_json_returns_none(self):
        result = parse_json_line("{device_id: broken json}")
        assert result is None

    def test_json_missing_device_id_returns_none(self):
        line = json.dumps({"soil_moisture": 45.0, "temperature": 25.0})
        result = parse_json_line(line)
        assert result is None

    def test_invalid_moisture_value_returns_none(self):
        """soil_moisture > 100 must be rejected."""
        line = json.dumps({
            "device_id": "MARUDAM-01",
            "soil_moisture": 150.0,
        })
        result = parse_json_line(line)
        assert result is None

    def test_invalid_temperature_returns_none(self):
        """Temperature outside -40..85 range must be rejected."""
        line = json.dumps({
            "device_id": "MARUDAM-01",
            "air_temperature": 999.0,
        })
        result = parse_json_line(line)
        assert result is None

    def test_string_moisture_value_returns_none(self):
        """soil_moisture = 'hello' must never be accepted."""
        line = json.dumps({
            "device_id": "MARUDAM-01",
            "soil_moisture": "hello",
        })
        result = parse_json_line(line)
        assert result is None

    def test_empty_device_id_returns_none(self):
        line = json.dumps({"device_id": "", "soil_moisture": 50.0})
        result = parse_json_line(line)
        assert result is None

    def test_json_prefix_bracket_required(self):
        """Lines not starting with { are ignored (diagnostics/banners)."""
        result = parse_json_line("[JSON] {}")
        assert result is None

    def test_partial_json_with_sensor_status(self):
        """sensor_status field should be parsed correctly."""
        line = json.dumps({
            "device_id": "MARUDAM-01",
            "soil_moisture": 52.0,
            "sensor_status": {
                "soil_moisture": "ok",
                "soil_temperature": "unavailable",
                "soil_ph": "unavailable",
                "soil_ec": "unavailable",
                "air_temperature": "ok",
                "humidity": "ok",
                "light_lux": "error",
            }
        })
        result = parse_json_line(line)
        assert result is not None
        assert result.sensor_status is not None
        assert result.sensor_status.soil_moisture == "ok"
        assert result.sensor_status.light_lux == "error"

    def test_parse_serial_line_arduino_test_sketch_block(self):
        """Streaming text lines from Arduino test sketches must be parsed into an ESP32Packet."""
        from app.services.serial_manager import parse_serial_line

        lines = [
            "Probe 1 address: 28E00BBA000000CD",
            "Probe 2 address: 286307B3000000CC",
            "----- SENSOR READINGS -----",
            "Air temperature: 30.40 C",
            "Air humidity: 75.00 %",
            "Light intensity: 73.33 lux",
            "Moisture sensor 1 - A0 raw: 22046, voltage: 2.756 V",
            "Moisture sensor 2 - A1 raw: 21893, voltage: 2.737 V",
            "Soil temperature probe 1: 30.25 C",
            "Soil temperature probe 2: 29.12 C",
            "---------------------------",
        ]

        packet = None
        for line in lines:
            res = parse_serial_line(line)
            if res:
                packet = res

        assert packet is not None
        assert packet.shared.air_temperature == pytest.approx(30.40)
        assert packet.shared.humidity == pytest.approx(75.00)
        assert packet.shared.light_lux == pytest.approx(73.33)

        assert "field_1" in packet.fields
        assert "field_2" in packet.fields

        f1 = packet.fields["field_1"]
        assert f1.soil_moisture_raw == 22046
        assert f1.soil_moisture_voltage == pytest.approx(2.756)
        assert f1.soil_temperature == pytest.approx(30.25)
        assert f1.ds18b20_address == "28E00BBA000000CD"

        f2 = packet.fields["field_2"]
        assert f2.soil_moisture_raw == 21893
        assert f2.soil_moisture_voltage == pytest.approx(2.737)
        assert f2.soil_temperature == pytest.approx(29.12)
        assert f2.ds18b20_address == "286307B3000000CC"
