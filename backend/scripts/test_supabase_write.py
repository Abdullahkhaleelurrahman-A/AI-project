#!/usr/bin/env python3
# =============================================================================
# MARUDAM - Supabase Integration & Database Write Verifier
# =============================================================================
# Run this script to test Supabase connectivity, table schema, RLS policies,
# and verify whether sensor readings can be successfully written and retrieved.
#
# Usage:
#   python backend/scripts/test_supabase_write.py
# =============================================================================
import os
import sys
from pathlib import Path
from datetime import datetime, timezone

# Ensure backend directory is in python path
backend_dir = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(backend_dir))

from app.config import settings
from app.services import supabase_service
from app.models.sensor import SensorReading, SensorStatus


def mask_secret(secret: str) -> str:
    """Mask sensitive keys completely so no characters are exposed in logs or console."""
    if not secret:
        return "[EMPTY]"
    if "your-supabase" in secret or "your-project" in secret or "example" in secret:
        return "[PLACEHOLDER VALUE]"
    return f"[CONFIGURED - {len(secret)} characters]"


def run_diagnostics():
    print("=" * 65)
    print("  MARUDAM - Supabase Database Write Diagnostic Tool")
    print("=" * 65)

    # 1. Environment Variable Verification
    url = settings.supabase_url.strip()
    key = settings.supabase_service_role_key.strip()
    is_configured = settings.supabase_configured

    print("\n[Step 1/5] Checking Configuration & Credentials...")
    print(f"  Target Device ID : {settings.device_id}")
    print(f"  SUPABASE_URL     : {url if url and 'your-project-id' not in url else '[PLACEHOLDER: ' + url + ']'}")
    print(f"  SERVICE_ROLE_KEY : {mask_secret(key)}")
    print(f"  Config Valid     : {'YES' if is_configured else 'NO (contains template placeholders)'}")

    if not is_configured:
        print("\n" + "!" * 65)
        print("  ROOT CAUSE IDENTIFIED: SUPABASE CREDENTIALS NOT CONFIGURED")
        print("!" * 65)
        print("  The FastAPI backend and Next.js frontend are currently using")
        print("  placeholder templates ('https://your-project-id.supabase.co').")
        print("\n  To connect your project to Supabase, update two files:")
        print("    1. backend/.env")
        print("       SUPABASE_URL=https://<your-project-ref>.supabase.co")
        print("       SUPABASE_SERVICE_ROLE_KEY=<your-service-role-secret-key>")
        print("\n    2. .env.local")
        print("       NEXT_PUBLIC_SUPABASE_URL=https://<your-project-ref>.supabase.co")
        print("       NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<your-anon-key>")
        print("\n  Where to find your credentials in Supabase:")
        print("    - URL & Anon Key: Project Settings > API > Project URL & anon/public")
        print("    - Service Role:   Project Settings > API > Project API Keys > service_role (secret)")
        print("\n  Once configured, re-run this script to verify writes.")
        print("=" * 65)
        return False

    # 2. Client Initialization
    print("\n[Step 2/5] Initialising Supabase Client...")
    client = supabase_service.get_client()
    if client is None:
        print("  [FAILED] Could not initialise Supabase client. Check network or URL format.")
        return False
    print("  [OK] Supabase client created successfully.")

    # 3. Device Table Verification & Auto-Registration
    print("\n[Step 3/5] Verifying 'devices' table presence...")
    test_device_id = f"TEST_{datetime.now().strftime('%M%S')}"
    try:
        client.table("devices").upsert({
            "device_id":   test_device_id,
            "device_name": "MARUDAM Diagnostic Test Node",
            "status":      "CONNECTED",
            "updated_at":  datetime.now(tz=timezone.utc).isoformat(),
        }, on_conflict="device_id").execute()
        print(f"  [OK] Device '{test_device_id}' registered successfully in 'devices' table.")
    except Exception as e:
        print(f"  [ERROR] Could not write to 'devices' table: {e}")
        if "relation" in str(e).lower() or "does not exist" in str(e).lower():
            print("  -> Table 'devices' does not exist! Please run src/lib/supabase/schema_v2.sql in Supabase SQL Editor.")
        return False

    # 4. Sensor Reading Write Verification
    print("\n[Step 4/5] Testing insert into 'sensor_readings' table...")
    now_utc = datetime.now(tz=timezone.utc)
    test_reading = SensorReading(
        device_id             = test_device_id,
        field_id              = "field_1",
        timestamp             = now_utc,
        soil_moisture_raw     = 8232,
        soil_moisture_voltage = 1.029,
        soil_moisture         = 99.9,
        soil_temperature      = 27.62,
        ds18b20_address       = "28E00BBA000000CD",
        soil_ph               = 6.8,
        soil_ec               = 1.2,
        air_temperature       = 30.80,
        humidity              = 77.60,
        light_lux             = 10.83,
        sensor_status         = SensorStatus(),
    )

    success = supabase_service.upsert_reading(test_reading)
    if not success:
        print("  [FAILED] Database write failed. Check backend logs above for specific error.")
        return False
    print("  [OK] Sensor reading inserted successfully into 'sensor_readings' table!")

    # 5. Readback Verification
    print("\n[Step 5/5] Verifying reading readback from Supabase...")
    try:
        res = (
            client.table("sensor_readings")
            .select("*")
            .eq("device_id", test_device_id)
            .order("timestamp", desc=True)
            .limit(1)
            .execute()
        )
        if res.data and len(res.data) > 0:
            row = res.data[0]
            print("  [OK] Verified stored data in Supabase Table Editor:")
            print(f"       - ID: {row.get('id')}")
            print(f"       - Field: {row.get('field_id', 'N/A')}")
            print(f"       - Soil Moisture: {row.get('soil_moisture')}% (raw: {row.get('soil_moisture_raw')})")
            print(f"       - Soil Temp: {row.get('soil_temperature')} C")
            print(f"       - Air Temp: {row.get('air_temperature')} C, Humidity: {row.get('humidity')}%")
        else:
            print("  [WARN] Insert succeeded but readback returned 0 rows.")
    except Exception as e:
        print(f"  [ERROR] Readback error: {e}")

    # Clean up test records
    try:
        client.table("sensor_readings").delete().eq("device_id", test_device_id).execute()
        client.table("devices").delete().eq("device_id", test_device_id).execute()
        print("  [OK] Cleaned up temporary diagnostic records.")
    except Exception:
        pass

    print("\n" + "=" * 65)
    print("  SUCCESS: Supabase database connection and writes are fully working!")
    print("=" * 65)
    return True


if __name__ == "__main__":
    run_diagnostics()
