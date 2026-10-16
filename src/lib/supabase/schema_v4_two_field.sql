-- =============================================================================
-- MARUDAM — Schema v4 Migration (Two-Field Single-ESP32 Architecture)
-- =============================================================================
-- Run this in: Supabase Dashboard > SQL Editor > New Query
--
-- This migration safely extends existing tables to support two agricultural
-- fields monitored by one ESP32 device node, with raw ADC / voltage metrics,
-- probe hardware addresses, and completely isolated field baselines & anomalies.
--
-- Safe to re-run: All statements are idempotent and non-destructive.
-- Existing data is preserved and defaults to 'field_1'.
-- =============================================================================

-- ─── 1. sensor_readings: add field_id, raw ADC counts, voltage, probe address ──

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'sensor_readings'
  ) THEN
    -- Field Identifier
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sensor_readings' AND column_name='field_id') THEN
      ALTER TABLE public.sensor_readings ADD COLUMN field_id text NOT NULL DEFAULT 'field_1';
    END IF;

    -- Raw ADC counts from ADS1115 (0 to ~26400)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sensor_readings' AND column_name='soil_moisture_raw') THEN
      ALTER TABLE public.sensor_readings ADD COLUMN soil_moisture_raw integer;
    END IF;

    -- Computed voltage from ADS1115 (0.0V to 3.3V)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sensor_readings' AND column_name='soil_moisture_voltage') THEN
      ALTER TABLE public.sensor_readings ADD COLUMN soil_moisture_voltage numeric(6,3);
    END IF;

    -- DS18B20 64-bit hardware address (hex string)
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='sensor_readings' AND column_name='ds18b20_address') THEN
      ALTER TABLE public.sensor_readings ADD COLUMN ds18b20_address text;
    END IF;
  END IF;
END $$;

-- Fast index for querying readings by device and field
CREATE INDEX IF NOT EXISTS idx_sensor_readings_device_field_time
  ON public.sensor_readings (device_id, field_id, timestamp DESC);


-- ─── 2. anomalies: add field_id to isolate field anomalies ───────────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'anomalies'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='anomalies' AND column_name='field_id') THEN
      ALTER TABLE public.anomalies ADD COLUMN field_id text NOT NULL DEFAULT 'field_1';
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_anomalies_device_field_time
  ON public.anomalies (device_id, field_id, timestamp DESC);


-- ─── 3. adaptive_baselines: add field_id with unique constraint ──────────────

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'adaptive_baselines'
  ) THEN
    -- Add field_id column if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='adaptive_baselines' AND column_name='field_id') THEN
      ALTER TABLE public.adaptive_baselines ADD COLUMN field_id text NOT NULL DEFAULT 'field_1';
    END IF;

    -- Drop legacy single-field unique constraint if it exists
    ALTER TABLE public.adaptive_baselines
      DROP CONSTRAINT IF EXISTS adaptive_baselines_device_id_sensor_key;

    -- Add composite unique constraint for device + field + sensor
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'adaptive_baselines_device_field_sensor_key'
    ) THEN
      ALTER TABLE public.adaptive_baselines
        ADD CONSTRAINT adaptive_baselines_device_field_sensor_key
        UNIQUE (device_id, field_id, sensor);
    END IF;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_adaptive_baselines_device_field
  ON public.adaptive_baselines (device_id, field_id);


-- ─── 4. farms: add field_id to associate farm records with specific fields ───

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'farms'
  ) THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='farms' AND column_name='field_id') THEN
      ALTER TABLE public.farms ADD COLUMN field_id text NOT NULL DEFAULT 'field_1';
    END IF;
  END IF;
END $$;

-- ─── Verification query ──────────────────────────────────────────────────────
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'sensor_readings'
-- ORDER BY ordinal_position;
