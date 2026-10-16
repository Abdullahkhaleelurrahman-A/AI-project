# =============================================================================
# MARUDAM Backend — Supabase Fallback & Field Preservation Unit Tests
# =============================================================================
import pytest
from unittest.mock import MagicMock
from datetime import datetime, timezone
import importlib.util
import os

from app.models.sensor import SensorReading


def _load_real_supabase_service():
    """Load the real supabase_service module from disk bypassing conftest stub."""
    spec = importlib.util.spec_from_file_location(
        "real_supabase_service",
        os.path.join(os.path.dirname(__file__), "..", "app", "services", "supabase_service.py")
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class TestSupabaseReadingPersistence:
    """Test that upsert_reading preserves field_id and gracefully drops raw columns."""

    def test_upsert_preserves_field_id_when_raw_columns_missing(self):
        real_mod = _load_real_supabase_service()

        # Mock Supabase client
        mock_client = MagicMock()
        mock_table = MagicMock()
        mock_client.table.return_value = mock_table

        # First insert fails with PGRST204 (soil_moisture_raw missing from schema)
        # Second insert (fallback retry) succeeds
        attempt = 0
        inserted_rows = []

        def side_effect_insert(row):
            nonlocal attempt
            inserted_rows.append(dict(row))
            attempt += 1
            mock_res = MagicMock()
            if attempt == 1:
                # First attempt with raw columns fails
                raise Exception("Could not find the 'soil_moisture_raw' column of 'sensor_readings' in the schema cache (code: PGRST204)")
            # Second attempt succeeds
            return mock_res

        mock_table.insert.side_effect = side_effect_insert
        real_mod.get_client = MagicMock(return_value=mock_client)

        # Create reading for field_2 with raw columns
        reading_f2 = SensorReading(
            device_id="FIELD_001",
            field_id="field_2",
            timestamp=datetime.now(tz=timezone.utc),
            soil_moisture_raw=17500,
            soil_moisture_voltage=2.18,
            soil_moisture=48.0,
            soil_temperature=26.0,
            ds18b20_address="28A472918014035D",
            air_temperature=28.5,
            humidity=62.0,
            light_lux=1200.0,
        )

        success = real_mod.upsert_reading(reading_f2)
        assert success is True
        assert len(inserted_rows) == 2

        # First attempt had raw columns and field_id
        assert inserted_rows[0]["field_id"] == "field_2"
        assert inserted_rows[0]["soil_moisture_raw"] == 17500

        # Second attempt (after fallback) MUST still have field_id="field_2"!
        assert inserted_rows[1]["field_id"] == "field_2"
        assert "soil_moisture_raw" not in inserted_rows[1]
        assert "soil_moisture_voltage" not in inserted_rows[1]
        assert "ds18b20_address" not in inserted_rows[1]

        # Next call for another reading should directly use the non-raw format and retain field_id
        inserted_rows.clear()
        reading_f1 = SensorReading(
            device_id="FIELD_001",
            field_id="field_1",
            timestamp=datetime.now(tz=timezone.utc),
            soil_moisture_raw=16500,
            soil_moisture=52.0,
            soil_temperature=25.0,
        )
        mock_table.insert.side_effect = None
        mock_table.insert.return_value.execute.return_value = MagicMock()

        success2 = real_mod.upsert_reading(reading_f1)
        assert success2 is True
        call_row = mock_table.insert.call_args[0][0]
        assert call_row["field_id"] == "field_1"
        assert "soil_moisture_raw" not in call_row
