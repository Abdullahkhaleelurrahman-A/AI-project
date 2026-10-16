# Database Schema and Documentation

The central data store for MARUDAM is a PostgreSQL database hosted on Supabase.

## 1. Tables Overview

| Table Name | Purpose | Status |
| :--- | :--- | :--- |
| `sensor_readings` | Stores historical sensor telemetry. | EXISTS |
| `devices` | Stores ESP32 field devices and connection status. | EXISTS |
| `farms` | Maps devices to physical farm locations and crop types. | EXISTS |
| `anomalies` | Stores active and resolved threshold breach events. | EXISTS |
| `adaptive_baselines` | Stores the ML baseline models per sensor. | REFERENCED BUT MISSING |
| `users` | Maps user profiles (handled by Supabase Auth). | REFERENCED (Auth) |
| `india_locations` | Indian district context data. | EXISTS |

*(Note: `adaptive_baselines` was defined in `schema_v3.sql` but not yet migrated to the live cloud instance, triggering an in-memory fallback).*

## 2. Table Structures

### `sensor_readings`
- **id (uuid, PK):** Unique record identifier.
- **device_id (text):** Foreign key to `devices.id`.
- **timestamp (timestamptz):** Backend-applied UTC timestamp.
- **soil_moisture (numeric):** Percentage (0-100).
- **soil_temperature (numeric):** Celsius.
- **soil_ph (numeric):** Injected median from dataset.
- **soil_ec (numeric):** Injected median from dataset.
- **air_temperature (numeric):** Celsius.
- **humidity (numeric):** Percentage (0-100).
- **light_lux (numeric):** Lux intensity.
- **created_at (timestamptz):** Supabase insert time.

### `anomalies`
- **id (uuid, PK):** Unique event ID.
- **device_id (text):** Foreign key to `devices.id`.
- **sensor (text):** e.g., 'air_temperature'.
- **anomaly_type (text):** 'HIGH' or 'LOW'.
- **severity (numeric):** 0.0 to 1.0.
- **status (text):** 'ACTIVE' or 'RESOLVED'.

## 3. Row Level Security (RLS)

By default, Supabase blocks all public reads. 
- The **FastAPI Backend** bypasses RLS using the `SUPABASE_SERVICE_ROLE_KEY`.
- The **Next.js Frontend** uses the `SUPABASE_PUBLISHABLE_KEY`.
- A custom SQL script (`setup_rls.sql`) was created to execute `CREATE POLICY` to explicitly allow `SELECT` queries for the `anon` and `authenticated` roles on the dashboard tables, solving the `401 Unauthorized` errors on Vercel.
