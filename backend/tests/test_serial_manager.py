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

    def test_marudam_sensor_test_sketch_format(self):
        """Test the real physical ESP32 MARUDAM SENSOR TEST output format."""
        from app.services.serial_manager import parse_serial_line
        lines = [
            "------ SENSOR READINGS ------",
            "Moisture Sensor 1 raw: 14754",
            "Moisture Sensor 1: 52.5% estimated",
            "Moisture Sensor 2 raw: 14630",
            "Moisture Sensor 2: 53.7% estimated",
            "DS18B20 Probe 1: 30.44 C",
            "DS18B20 Probe 2: 30.37 C",
            "Air Temperature: 31.20 C",
            "Air Humidity: 74.50 %",
            "Light Intensity: 38.33 lux",
            "-----------------------------",
        ]
        packet = None
        for line in lines:
            res = parse_serial_line(line)
            if res:
                packet = res

        assert packet is not None
        assert packet.shared.air_temperature == pytest.approx(31.20)
        assert packet.shared.humidity == pytest.approx(74.50)
        assert packet.shared.light_lux == pytest.approx(38.33)
        assert packet.fields["field_1"].soil_moisture_raw == 14754
        assert packet.fields["field_1"].soil_moisture == pytest.approx(52.5)
        assert packet.fields["field_1"].soil_temperature == pytest.approx(30.44)
        assert packet.fields["field_2"].soil_moisture_raw == 14630
        assert packet.fields["field_2"].soil_moisture == pytest.approx(53.7)
        assert packet.fields["field_2"].soil_temperature == pytest.approx(30.37)

    def test_diagnostic_moisture_raw_format_without_percentage(self):
        """Diagnostic sketch output with MOISTURE_1_RAW/MOISTURE_2_RAW must preserve raw values without fake percentage."""
        from app.services.serial_manager import parse_serial_line
        lines = [
            "------ SENSOR READINGS ------",
            "MOISTURE_1_RAW: 14743",
            "Moisture Sensor 1 - A0 raw: 14743, voltage: 1.843 V",
            "MOISTURE_2_RAW: 14621",
            "Moisture Sensor 2 - A1 raw: 14621, voltage: 1.828 V",
            "-----------------------------",
        ]
        packet = None
        for line in lines:
            res = parse_serial_line(line)
            if res:
                packet = res

        assert packet is not None
        assert packet.fields["field_1"].soil_moisture_raw == 14743
        assert packet.fields["field_1"].soil_moisture_voltage == pytest.approx(1.843, abs=0.01)
        assert packet.fields["field_1"].soil_moisture is None  # Uncalibrated: must NOT assume 100%!
        assert packet.fields["field_1"].status_moisture == "ok"

        assert packet.fields["field_2"].soil_moisture_raw == 14621
        assert packet.fields["field_2"].soil_moisture_voltage == pytest.approx(1.828, abs=0.01)
        assert packet.fields["field_2"].soil_moisture is None
        assert packet.fields["field_2"].status_moisture == "ok"

    def test_disconnected_sensor_does_not_clamp_to_100_percent(self):
        """A disconnected sensor reading raw <= 100 must be marked as error, never reported as 100% moisture."""
        from app.services.serial_manager import parse_serial_line
        lines = [
            "------ SENSOR READINGS ------",
            "MOISTURE_1_RAW: 0",
            "Moisture Sensor 1: 100.0% estimated",
            "MOISTURE_2_RAW: 14621",
            "Moisture Sensor 2: 53.7% estimated",
            "-----------------------------",
        ]
        packet = None
        for line in lines:
            res = parse_serial_line(line)
            if res:
                packet = res

        assert packet is not None
        assert packet.fields["field_1"].soil_moisture is None  # Ignored fake 100%
        assert packet.fields["field_1"].status_moisture == "error"
        assert packet.fields["field_2"].soil_moisture == pytest.approx(53.7)
        assert packet.fields["field_2"].status_moisture == "ok"

    def test_moisture_percent_and_raw_labels(self):
        """Must parse MOISTURE_1_PERCENT with space and MOISTURE_1_RAW without error."""
        from app.services.serial_manager import parse_serial_line
        lines = [
            "------ SENSOR READINGS ------",
            "MOISTURE_1_RAW: 8232",
            "MOISTURE_1_PERCENT: 99.9 %",
            "MOISTURE_2_RAW: 7936",
            "MOISTURE_2_PERCENT: 100.0 %",
            "Soil temperature probe 1: 27.62 C",
            "Soil temperature probe 2: 27.69 C",
            "Air temperature: 30.80 C",
            "Air humidity: 77.60 %",
            "Light intensity: 10.83 lux",
            "-----------------------------",
        ]
        packet = None
        for line in lines:
            res = parse_serial_line(line)
            if res:
                packet = res

        assert packet is not None
        assert packet.fields["field_1"].soil_moisture_raw == 8232
        assert packet.fields["field_1"].soil_moisture == pytest.approx(99.9)
        assert packet.fields["field_1"].soil_moisture_voltage == pytest.approx(1.029, abs=0.005)
        assert packet.fields["field_1"].soil_temperature == pytest.approx(27.62)

        assert packet.fields["field_2"].soil_moisture_raw == 7936
        assert packet.fields["field_2"].soil_moisture == pytest.approx(100.0)
        assert packet.fields["field_2"].soil_moisture_voltage == pytest.approx(0.992, abs=0.005)
        assert packet.fields["field_2"].soil_temperature == pytest.approx(27.69)

        assert packet.shared.air_temperature == pytest.approx(30.80)
        assert packet.shared.humidity == pytest.approx(77.60)
        assert packet.shared.light_lux == pytest.approx(10.83)

    def test_user_live_example_text_format(self):
        """Must parse raw value, voltage, and relative moisture lines with °C symbols."""
        from app.services.serial_manager import parse_serial_line
        lines = [
            "------ SENSOR READINGS ------",
            "Moisture sensor 1 raw value: 8232",
            "Moisture sensor 1 voltage: 1.029 V",
            "Moisture sensor 1 relative moisture: 99.9%",
            "Moisture sensor 2 raw value: 7936",
            "Moisture sensor 2 voltage: 0.992 V",
            "Moisture sensor 2 relative moisture: 100.0%",
            "Soil temperature probe 1: 27.62°C",
            "Soil temperature probe 2: 27.69°C",
            "Air temperature: 30.80°C",
            "Air humidity: 77.60%",
            "Light intensity: 10.83 lux",
            "-----------------------------",
        ]
        packet = None
        for line in lines:
            res = parse_serial_line(line)
            if res:
                packet = res

        assert packet is not None
        assert packet.fields["field_1"].soil_moisture_raw == 8232
        assert packet.fields["field_1"].soil_moisture_voltage == pytest.approx(1.029)
        assert packet.fields["field_1"].soil_moisture == pytest.approx(99.9)
        assert packet.fields["field_1"].soil_temperature == pytest.approx(27.62)

        assert packet.fields["field_2"].soil_moisture_raw == 7936
        assert packet.fields["field_2"].soil_moisture_voltage == pytest.approx(0.992)
        assert packet.fields["field_2"].soil_moisture == pytest.approx(100.0)
        assert packet.fields["field_2"].soil_temperature == pytest.approx(27.69)

        assert packet.shared.air_temperature == pytest.approx(30.80)
        assert packet.shared.humidity == pytest.approx(77.60)
        assert packet.shared.light_lux == pytest.approx(10.83)

