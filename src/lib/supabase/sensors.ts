// =============================================================================
// MARUDAM — Supabase Sensor Query Utilities (Two-Field Supported)
// =============================================================================
// These functions read sensor data from Supabase for the Next.js frontend.
// Uses the public/publishable key — only public tables (sensor_readings,
// anomalies, devices) can be accessed this way.
// NEVER import the service-role key here.
// =============================================================================

import { createClient } from '@/lib/supabase/client';

export interface SensorReading {
  id: string;
  device_id: string;
  field_id?: string;
  timestamp: string;
  soil_moisture: number | null;
  soil_moisture_raw?: number | null;
  soil_moisture_voltage?: number | null;
  soil_temperature: number | null;
  ds18b20_address?: string | null;
  soil_ph: number | null;
  soil_ec: number | null;
  air_temperature: number | null;
  humidity: number | null;
  light_lux: number | null;
  created_at: string;
}

export interface Anomaly {
  id: string;
  device_id: string;
  field_id?: string;
  timestamp: string;
  sensor: string;
  observed_value: number | null;
  expected_value: number | null;
  deviation: number | null;
  risk_level: 'NORMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
  created_at: string;
}

export interface DeviceRow {
  id: string;
  device_id: string;
  device_name: string;
  status: 'CONNECTED' | 'DISCONNECTED' | 'SENSOR_ERROR' | 'BACKEND_ERROR' | 'UNKNOWN';
  serial_port: string | null;
  last_seen: string | null;
  updated_at: string;
}

// ─── Latest reading ───────────────────────────────────────────────────────────

export async function fetchLatestReading(
  deviceId: string,
  fieldId?: string
): Promise<SensorReading | null> {
  const supabase = createClient();
  let query = supabase
    .from('sensor_readings')
    .select('*')
    .eq('device_id', deviceId);

  if (fieldId) {
    query = query.eq('field_id', fieldId);
  }

  const { data, error } = await query
    .order('timestamp', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as SensorReading;
}

export async function fetchLatestTwoFieldReadings(
  deviceId: string
): Promise<{ field_1: SensorReading | null; field_2: SensorReading | null }> {
  const [f1, f2] = await Promise.all([
    fetchLatestReading(deviceId, 'field_1'),
    fetchLatestReading(deviceId, 'field_2'),
  ]);

  // Graceful fallback: If no field_id column or tagged rows yet,
  // return generic latest reading as field_1
  if (!f1 && !f2) {
    const generic = await fetchLatestReading(deviceId);
    return { field_1: generic, field_2: null };
  }
  return { field_1: f1, field_2: f2 };
}

// ─── Reading history ──────────────────────────────────────────────────────────

export async function fetchReadingHistory(
  deviceId: string,
  limit = 100,
  fieldId?: string
): Promise<SensorReading[]> {
  const supabase = createClient();
  let query = supabase
    .from('sensor_readings')
    .select('*')
    .eq('device_id', deviceId);

  if (fieldId) {
    query = query.eq('field_id', fieldId);
  }

  const { data, error } = await query
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data as SensorReading[];
}

// ─── Anomalies ────────────────────────────────────────────────────────────────

export async function fetchRecentAnomalies(
  deviceId: string,
  limit = 20,
  fieldId?: string
): Promise<Anomaly[]> {
  const supabase = createClient();
  let query = supabase
    .from('anomalies')
    .select('*')
    .eq('device_id', deviceId);

  if (fieldId) {
    query = query.eq('field_id', fieldId);
  }

  const { data, error } = await query
    .order('timestamp', { ascending: false })
    .limit(limit);

  if (error || !data) return [];
  return data as Anomaly[];
}

// ─── Device status ────────────────────────────────────────────────────────────

export async function fetchDeviceStatus(
  deviceId: string
): Promise<DeviceRow | null> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('devices')
    .select('*')
    .eq('device_id', deviceId)
    .maybeSingle();

  if (error || !data) return null;
  return data as DeviceRow;
}

// ─── Realtime subscriptions ───────────────────────────────────────────────────

/**
 * Subscribe to new sensor readings for a device.
 * Returns an unsubscribe function — call it on component unmount.
 */
export function subscribeToReadings(
  deviceId: string,
  onReading: (reading: SensorReading) => void
): () => void {
  const supabase = createClient();

  const channel = supabase
    .channel(`sensor_readings:${deviceId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'sensor_readings',
        filter: `device_id=eq.${deviceId}`,
      },
      (payload) => {
        if (payload.new) {
          onReading(payload.new as SensorReading);
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Subscribe to new anomalies for a device.
 */
export function subscribeToAnomalies(
  deviceId: string,
  onAnomaly: (anomaly: Anomaly) => void
): () => void {
  const supabase = createClient();

  const channel = supabase
    .channel(`anomalies:${deviceId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'anomalies',
        filter: `device_id=eq.${deviceId}`,
      },
      (payload) => {
        if (payload.new) {
          onAnomaly(payload.new as Anomaly);
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}

/**
 * Subscribe to device status changes.
 */
export function subscribeToDeviceStatus(
  deviceId: string,
  onStatusChange: (device: DeviceRow) => void
): () => void {
  const supabase = createClient();

  const channel = supabase
    .channel(`devices:${deviceId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'devices',
        filter: `device_id=eq.${deviceId}`,
      },
      (payload) => {
        if (payload.new) {
          onStatusChange(payload.new as DeviceRow);
        }
      }
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
