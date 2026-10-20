'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/client';
import AppShell from '@/components/layout/AppShell';
import { type Language, getTranslations } from '@/lib/i18n/translations';
import { fetchLatestTwoFieldReadings, type SensorReading } from '@/lib/supabase/sensors';
import { getCropName, estimateGrowthStageId, getCropStageName } from '@/lib/data/db';
import { getStoredFarmProfile, buildFarmContext, FARM_PROFILE_UPDATED_EVENT } from '@/lib/data/farmProfile';

interface FieldSoilReading {
  field_id: string;
  soil_moisture: number | null;
  soil_moisture_raw: number | null;
  soil_moisture_voltage: number | null;
  soil_temperature: number | null;
  ds18b20_address: string | null;
  timestamp?: string;
  device_id?: string;
}

interface SharedEnvironment {
  air_temperature: number | null;
  humidity: number | null;
  light_lux: number | null;
}

const DEVICE_COLOR: Record<string, string> = {
  ONLINE: '#4ade80',
  CONNECTED: '#60a5fa',
  DISCONNECTED: '#ef4444',
  STALE: '#facc15',
  OFFLINE: '#f87171',
  UNKNOWN: '#94a3b8',
};

export default function SensorsClient() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [language, setLanguage] = useState<Language>('English');
  const [deviceId, setDeviceId] = useState<string>('FIELD_001');
  const [farmContext, setFarmContext] = useState<any>(null);

  // ─── Farm tab selection ('farm_1' vs 'farm_2') ──────────────────────────────
  const [selectedFarm, setSelectedFarm] = useState<'farm_1' | 'farm_2'>('farm_1');

  // ─── Live sensor data from ESP32 / FastAPI ─────────────────────────────────
  const [field1Data, setField1Data] = useState<FieldSoilReading | null>(null);
  const [field2Data, setField2Data] = useState<FieldSoilReading | null>(null);
  const [sharedEnv, setSharedEnv] = useState<SharedEnvironment>({
    air_temperature: null,
    humidity: null,
    light_lux: null,
  });

  const [deviceStatus, setDeviceStatus] = useState<'ONLINE' | 'CONNECTED' | 'DISCONNECTED' | 'STALE' | 'OFFLINE' | 'UNKNOWN'>('UNKNOWN');
  const [sensorAge, setSensorAge] = useState<number>(0);
  const [dataSource, setDataSource] = useState<'local' | 'supabase' | 'none'>('none');
  const [transportSource, setTransportSource] = useState<'serial' | 'wifi' | null>(null);

  const t = useMemo(() => getTranslations(language), [language]);
  const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

  // ─── 1. Load user profile / initial state ──────────────────────────────────
  const loadProfile = useCallback(async () => {
    const stored = getStoredFarmProfile();
    const devId = stored.device_id || 'FIELD_001';
    setDeviceId(devId);
    setFarmContext(buildFarmContext(stored, language));

    if (!isSupabaseConfigured()) {
      setLoading(false);
      return;
    }

    try {
      const supabase = createClient();
      const { data: { user }, error: authErr } = await supabase.auth.getUser();
      if (authErr || !user) {
        setLoading(false);
        return;
      }

      const { data: profile } = await supabase.from('profiles').select('language').eq('user_id', user.id).single();
      if (profile?.language) setLanguage(profile.language as Language);

      const { data: farm } = await supabase.from('farms')
        .select('state, district, crop_id, sowing_date, device_id')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(1).single();

      if (farm) {
        const farmDevId = farm.device_id ?? 'FIELD_001';
        setDeviceId(farmDevId);
        setFarmContext({
          cropName: getCropName(farm.crop_id, (profile?.language as Language) ?? 'English'),
          district: farm.district,
          state: farm.state,
          deviceId: farmDevId,
          growthStage: getCropStageName(farm.crop_id, estimateGrowthStageId(farm.crop_id, farm.sowing_date), (profile?.language as Language) ?? 'English'),
        });
      }
    } catch {
      // Offline fallback
      const s = getStoredFarmProfile();
      setDeviceId(s.device_id || 'FIELD_001');
      setFarmContext(buildFarmContext(s, language));
    } finally {
      setLoading(false);
    }
  }, [language]);

  useEffect(() => {
    loadProfile();

    const handleUpdate = () => {
      const s = getStoredFarmProfile();
      setDeviceId(s.device_id || 'FIELD_001');
      setFarmContext(buildFarmContext(s, language));
    };
    window.addEventListener(FARM_PROFILE_UPDATED_EVENT, handleUpdate);
    window.addEventListener('storage', handleUpdate);
    return () => {
      window.removeEventListener(FARM_PROFILE_UPDATED_EVENT, handleUpdate);
      window.removeEventListener('storage', handleUpdate);
    };
  }, [loadProfile, language]);

  // ─── 2. Real-time Live Sensor Polling (every 3 seconds) ────────────────────
  const fetchLiveSensors = useCallback(async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/sensors/live`);
      if (res.ok) {
        const d = await res.json();
        if (d.connected && (d.field_1 || d.field_2)) {
          if (d.field_1) setField1Data(d.field_1);
          if (d.field_2) setField2Data(d.field_2);
          if (d.shared) {
            setSharedEnv({
              air_temperature: d.shared.air_temperature ?? null,
              humidity: d.shared.humidity ?? null,
              light_lux: d.shared.light_lux ?? null,
            });
          }
          setDataSource('local');
          setSensorAge(d.age_seconds ?? 0);
          if (d.source) setTransportSource(d.source === 'wifi' ? 'wifi' : 'serial');
          setDeviceStatus('CONNECTED');
          return;
        } else {
          // Disconnected or no live readings
          setField1Data(null);
          setField2Data(null);
          setSharedEnv({ air_temperature: null, humidity: null, light_lux: null });
          setDataSource('local');
          setSensorAge(d.age_seconds ?? 0);
          setDeviceStatus('DISCONNECTED');
          return;
        }
      }
    } catch {
      // Local backend offline, attempt Supabase fallback
    }

    if (isSupabaseConfigured() && deviceId) {
      try {
        const two = await fetchLatestTwoFieldReadings(deviceId);
        const active = two.field_1 || two.field_2;
        const readingTime = active?.created_at ? new Date(active.created_at).getTime() : 0;
        const isFresh = readingTime > 0 && (Date.now() - readingTime) < 60000;
        if (isFresh) {
          if (two.field_1) setField1Data(two.field_1 as any);
          if (two.field_2) setField2Data(two.field_2 as any);
          if (active) {
            setSharedEnv({
              air_temperature: active.air_temperature ?? null,
              humidity: active.humidity ?? null,
              light_lux: active.light_lux ?? null,
            });
          }
          setDataSource('supabase');
          setDeviceStatus('CONNECTED');
          setSensorAge(Math.round((Date.now() - readingTime) / 1000));
        } else {
          setField1Data(null);
          setField2Data(null);
          setSharedEnv({ air_temperature: null, humidity: null, light_lux: null });
          setDataSource('supabase');
          setDeviceStatus('DISCONNECTED');
        }
      } catch {
        setDeviceStatus('OFFLINE');
      }
    } else {
      setDeviceStatus('OFFLINE');
    }
  }, [BACKEND_URL, deviceId]);

  useEffect(() => {
    fetchLiveSensors();
    const id = setInterval(fetchLiveSensors, 3000);
    return () => clearInterval(id);
  }, [fetchLiveSensors]);

  // Tick sensor age every second
  useEffect(() => {
    if (!field1Data && !field2Data) return;
    const id = setInterval(() => setSensorAge(a => a + 1), 1000);
    return () => clearInterval(id);
  }, [field1Data, field2Data]);

  const handleLanguageChange = async (newLang: Language) => {
    setLanguage(newLang);
    if (!isSupabaseConfigured()) return;
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) await supabase.from('profiles').update({ language: newLang }).eq('user_id', user.id);
    } catch {}
  };

  const handleLogout = async () => {
    if (isSupabaseConfigured()) {
      try {
        const supabase = createClient();
        await supabase.auth.signOut();
      } catch {}
    }
    router.push('/login');
  };

  const formatSensorAge = (sec: number): string => {
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  };

  const isEspConnected = deviceStatus === 'CONNECTED' || deviceStatus === 'ONLINE';

  // Helper for soil moisture status badge
  const getMoistureStatus = (val: number | null) => {
    if (val == null || !isEspConnected) return { label: 'Waiting for sensor connection', color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' };
    if (val > 75) return { label: 'Saturated / Wet', color: '#60a5fa', bg: 'rgba(96,165,250,0.18)' };
    if (val >= 40) return { label: 'Optimal Moisture', color: '#4ade80', bg: 'rgba(74,222,128,0.18)' };
    return { label: 'Dry / Low Moisture', color: '#f87171', bg: 'rgba(248,113,113,0.18)' };
  };

  // Helper for soil temperature status badge
  const getTemperatureStatus = (val: number | null) => {
    if (val == null || !isEspConnected) return { label: 'Waiting for sensor connection', color: '#94a3b8', bg: 'rgba(148,163,184,0.15)' };
    if (val > 34) return { label: 'Elevated Temperature', color: '#fbbf24', bg: 'rgba(251,191,36,0.18)' };
    if (val >= 20) return { label: 'Optimal Temperature', color: '#4ade80', bg: 'rgba(74,222,128,0.18)' };
    return { label: 'Cool Soil', color: '#60a5fa', bg: 'rgba(96,165,250,0.18)' };
  };

  // Active farm soil readings
  const activeReading = isEspConnected ? (selectedFarm === 'farm_1' ? field1Data : field2Data) : null;
  const isFarm1 = selectedFarm === 'farm_1';

  return (
    <AppShell
      activeRoute="/sensors"
      language={language}
      onLanguageChange={handleLanguageChange}
      onLogout={handleLogout}
      pageTitle="Sensors"
      farmContext={farmContext}
    >
      <div style={{
        padding: '1.5rem 2rem 2.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
        position: 'relative',
        minHeight: '100%',
        backgroundImage: "linear-gradient(rgba(5, 16, 6, 0.78), rgba(5, 16, 6, 0.88)), url('/farm_bg.jpg')",
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        backgroundAttachment: 'fixed',
      }}>

        {/* ─── SYSTEM STATUS BAR ─── */}
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          background: 'rgba(255, 255, 255, 0.05)',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          borderRadius: '0.75rem',
          padding: '0.75rem 1.25rem',
          backdropFilter: 'blur(8px)',
          gap: '1rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: DEVICE_COLOR[deviceStatus] || '#94a3b8',
                display: 'inline-block',
                boxShadow: `0 0 8px ${DEVICE_COLOR[deviceStatus] || '#94a3b8'}`,
              }} />
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#ffffff' }}>
                ESP32 Node: <span style={{ color: 'var(--brand-primary)', fontFamily: 'monospace' }}>{deviceId}</span>
              </span>
              <span style={{
                fontSize: '0.68rem',
                fontWeight: 700,
                color: DEVICE_COLOR[deviceStatus] || '#94a3b8',
                background: `${DEVICE_COLOR[deviceStatus] || '#94a3b8'}22`,
                padding: '0.15rem 0.45rem',
                borderRadius: '9999px',
                border: `1px solid ${DEVICE_COLOR[deviceStatus] || '#94a3b8'}44`,
              }}>
                {deviceStatus}
              </span>
            </div>

            <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>

            <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.75)' }}>
              Source: <span style={{ fontWeight: 600, color: '#ffffff' }}>
                {!isEspConnected
                  ? 'Sensor disconnected'
                  : dataSource === 'local'
                  ? (transportSource === 'wifi' ? '📶 ESP32 Wi-Fi' : '⚡ Local USB Serial')
                  : dataSource === 'supabase'
                  ? '☁️ Supabase Cloud'
                  : 'Awaiting Stream...'}
              </span>
            </div>

            <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>

            <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.75)' }}>
              Active View: <span style={{ fontWeight: 700, color: '#4ade80' }}>
                {isFarm1 ? '🌱 Farm 1' : '🌾 Farm 2'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {sensorAge > 0 && isEspConnected && (
              <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.6)' }}>
                Updated {formatSensorAge(sensorAge)}
              </span>
            )}
          </div>
        </div>

        {/* ─── SENSOR DISCONNECTED BANNER ─── */}
        {!isEspConnected && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.12)',
            border: '1.5px solid rgba(239, 68, 68, 0.45)',
            borderRadius: '0.75rem',
            padding: '0.9rem 1.25rem',
            color: '#fca5a5',
            fontSize: '0.85rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.85rem',
            boxShadow: '0 4px 12px rgba(239, 68, 68, 0.15)',
          }}>
            <span style={{ fontSize: '1.4rem' }}>{deviceStatus === 'OFFLINE' ? '⚠️' : '🔌'}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, color: '#f87171', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span>{deviceStatus === 'OFFLINE' ? 'Local Backend Offline' : 'Sensor disconnected — waiting for readings'}</span>
              </div>
              <div style={{ fontSize: '0.78rem', color: '#fecaca', marginTop: '0.25rem', lineHeight: 1.45 }}>
                {deviceStatus === 'OFFLINE'
                  ? 'FastAPI server at http://localhost:8000 is not reachable. Run python run.py to start local backend.'
                  : 'Waiting for sensor connection. Connect ESP32 via USB cable or Wi-Fi to start receiving live readings.'}
              </div>
            </div>
          </div>
        )}

        {/* ─── PAGE TITLE & SUBTITLE ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <h1 style={{ fontSize: '1.85rem', fontWeight: 800, margin: 0, color: '#ffffff', letterSpacing: '-0.02em' }}>
            Live Sensors Telemetry
          </h1>
          <p style={{ color: 'rgba(255, 255, 255, 0.7)', fontSize: '0.88rem', margin: 0 }}>
            Real-time multi-channel telemetry received directly from your physical ESP32 node.
          </p>
        </div>

        {/* ─── FARM SELECTION TABS ─── */}
        <div style={{
          display: 'flex',
          gap: '0.75rem',
          background: 'rgba(0, 0, 0, 0.35)',
          border: '1px solid rgba(255, 255, 255, 0.1)',
          padding: '0.4rem',
          borderRadius: '0.85rem',
          backdropFilter: 'blur(10px)',
          width: 'fit-content',
        }}>
          {/* Farm 1 Button */}
          <button
            onClick={() => setSelectedFarm('farm_1')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.65rem',
              padding: '0.65rem 1.4rem',
              borderRadius: '0.65rem',
              border: isFarm1 ? '1.5px solid #4ade80' : '1px solid transparent',
              background: isFarm1
                ? 'linear-gradient(135deg, rgba(74, 222, 128, 0.22), rgba(34, 197, 94, 0.12))'
                : 'transparent',
              color: isFarm1 ? '#ffffff' : 'rgba(255, 255, 255, 0.65)',
              fontWeight: isFarm1 ? 700 : 500,
              fontSize: '0.92rem',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              boxShadow: isFarm1 ? '0 0 16px rgba(74, 222, 128, 0.25)' : 'none',
            }}
          >
            <span style={{ fontSize: '1.25rem' }}>🌱</span>
            <div style={{ textAlign: 'left' }}>
              <div style={{ lineHeight: 1.2 }}>Farm 1</div>
              <div style={{ fontSize: '0.7rem', opacity: 0.8, fontWeight: 400 }}>
                Moisture A0 · Soil Temp 1
              </div>
            </div>
            {isFarm1 && (
              <span style={{
                marginLeft: '0.25rem',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#4ade80',
                boxShadow: '0 0 6px #4ade80',
              }} />
            )}
          </button>

          {/* Farm 2 Button */}
          <button
            onClick={() => setSelectedFarm('farm_2')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.65rem',
              padding: '0.65rem 1.4rem',
              borderRadius: '0.65rem',
              border: !isFarm1 ? '1.5px solid #4ade80' : '1px solid transparent',
              background: !isFarm1
                ? 'linear-gradient(135deg, rgba(74, 222, 128, 0.22), rgba(34, 197, 94, 0.12))'
                : 'transparent',
              color: !isFarm1 ? '#ffffff' : 'rgba(255, 255, 255, 0.65)',
              fontWeight: !isFarm1 ? 700 : 500,
              fontSize: '0.92rem',
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              boxShadow: !isFarm1 ? '0 0 16px rgba(74, 222, 128, 0.25)' : 'none',
            }}
          >
            <span style={{ fontSize: '1.25rem' }}>🌾</span>
            <div style={{ textAlign: 'left' }}>
              <div style={{ lineHeight: 1.2 }}>Farm 2</div>
              <div style={{ fontSize: '0.7rem', opacity: 0.8, fontWeight: 400 }}>
                Moisture A1 · Soil Temp 2
              </div>
            </div>
            {!isFarm1 && (
              <span style={{
                marginLeft: '0.25rem',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#4ade80',
                boxShadow: '0 0 6px #4ade80',
              }} />
            )}
          </button>
        </div>

        {/* ─── ACTIVE FARM SELECTED INDICATOR BANNER ─── */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          background: 'rgba(74, 222, 128, 0.08)',
          border: '1px solid rgba(74, 222, 128, 0.25)',
          borderRadius: '0.75rem',
          padding: '0.75rem 1.25rem',
          gap: '0.75rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span style={{ fontSize: '1.3rem' }}>{isFarm1 ? '🌱' : '🌾'}</span>
            <div>
              <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: '#4ade80', fontWeight: 800 }}>
                Active Selection
              </span>
              <h3 style={{ margin: 0, fontSize: '0.98rem', fontWeight: 700, color: '#ffffff' }}>
                {isFarm1
                  ? 'Farm 1 — Soil Moisture Sensor 1 & Temperature Probe 1'
                  : 'Farm 2 — Soil Moisture Sensor 2 & Temperature Probe 2'}
              </h3>
            </div>
          </div>

          <div style={{
            fontSize: '0.75rem',
            color: 'rgba(255,255,255,0.85)',
            background: 'rgba(0,0,0,0.3)',
            padding: '0.35rem 0.75rem',
            borderRadius: '0.5rem',
            border: '1px solid rgba(255,255,255,0.1)',
            fontFamily: 'monospace',
          }}>
            {isFarm1 ? 'ADS1115 Channel A0 · DS18B20 #1' : 'ADS1115 Channel A1 · DS18B20 #2'}
          </div>
        </div>

        {/* ─── SECTION 1: DEDICATED SOIL SENSORS FOR SELECTED FARM ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1rem' }}>🪴</span>
            <h2 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: '#ffffff', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              {isFarm1 ? 'Farm 1 Soil Health & Sub-Surface Probes' : 'Farm 2 Soil Health & Sub-Surface Probes'}
            </h2>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: '1rem',
          }}>
            {/* 1. Soil Moisture Card */}
            {(() => {
              const moistureVal = activeReading?.soil_moisture ?? null;
              const status = getMoistureStatus(moistureVal);
              const rawCount = activeReading?.soil_moisture_raw;
              const voltage = activeReading?.soil_moisture_voltage;

              return (
                <div style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '0.85rem',
                  padding: '1.25rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                  backdropFilter: 'blur(8px)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontSize: '1.3rem' }}>💧</span>
                      <div>
                        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#ffffff' }}>
                          {isFarm1 ? 'Soil Moisture (Sensor 1)' : 'Soil Moisture (Sensor 2)'}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.6)' }}>
                          {isFarm1 ? 'ADS1115 Channel A0' : 'ADS1115 Channel A1'}
                        </div>
                      </div>
                    </div>
                    <span style={{
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      color: status.color,
                      background: status.bg,
                      padding: '0.2rem 0.55rem',
                      borderRadius: '9999px',
                      border: `1px solid ${status.color}44`,
                    }}>
                      {status.label}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.35rem', marginTop: '0.25rem' }}>
                    <span style={{
                      fontSize: '2.4rem',
                      fontWeight: 800,
                      color: moistureVal != null ? '#ffffff' : 'rgba(255,255,255,0.4)',
                      lineHeight: 1,
                    }}>
                      {moistureVal != null ? moistureVal.toFixed(1) : '--'}
                    </span>
                    <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'rgba(255,255,255,0.6)' }}>
                      %
                    </span>
                  </div>

                  {/* Moisture Progress Bar */}
                  <div style={{
                    width: '100%',
                    height: '6px',
                    background: 'rgba(255,255,255,0.1)',
                    borderRadius: '9999px',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.min(100, Math.max(0, moistureVal ?? 0))}%`,
                      background: status.color,
                      borderRadius: '9999px',
                      transition: 'width 0.5s ease',
                    }} />
                  </div>

                  {/* Diagnostic telemetry breakdown */}
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.72rem',
                    color: 'rgba(255,255,255,0.65)',
                    background: 'rgba(0,0,0,0.25)',
                    padding: '0.45rem 0.65rem',
                    borderRadius: '0.5rem',
                    marginTop: '0.25rem',
                  }}>
                    <span>
                      Raw ADC: <strong style={{ color: '#ffffff' }}>{rawCount != null ? rawCount.toLocaleString() : '--'}</strong>
                    </span>
                    <span>
                      Voltage: <strong style={{ color: '#ffffff' }}>{voltage != null ? `${voltage.toFixed(3)} V` : '--'}</strong>
                    </span>
                  </div>
                </div>
              );
            })()}

            {/* 2. Soil Temperature Card */}
            {(() => {
              const tempVal = activeReading?.soil_temperature ?? null;
              const status = getTemperatureStatus(tempVal);
              const probeAddress = activeReading?.ds18b20_address || (isFarm1 ? '28E00BBA000000CD' : '286307B3000000CC');

              return (
                <div style={{
                  background: 'rgba(255, 255, 255, 0.05)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '0.85rem',
                  padding: '1.25rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                  backdropFilter: 'blur(8px)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontSize: '1.3rem' }}>🌡️</span>
                      <div>
                        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: '#ffffff' }}>
                          {isFarm1 ? 'Soil Temperature (Probe 1)' : 'Soil Temperature (Probe 2)'}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.6)' }}>
                          DS18B20 OneWire Bus (GPIO 4)
                        </div>
                      </div>
                    </div>
                    <span style={{
                      fontSize: '0.68rem',
                      fontWeight: 700,
                      color: status.color,
                      background: status.bg,
                      padding: '0.2rem 0.55rem',
                      borderRadius: '9999px',
                      border: `1px solid ${status.color}44`,
                    }}>
                      {status.label}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.35rem', marginTop: '0.25rem' }}>
                    <span style={{
                      fontSize: '2.4rem',
                      fontWeight: 800,
                      color: tempVal != null ? '#ffffff' : 'rgba(255,255,255,0.4)',
                      lineHeight: 1,
                    }}>
                      {tempVal != null ? tempVal.toFixed(1) : '--'}
                    </span>
                    <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'rgba(255,255,255,0.6)' }}>
                      °C
                    </span>
                  </div>

                  {/* Temperature scale bar (0 to 50 C) */}
                  <div style={{
                    width: '100%',
                    height: '6px',
                    background: 'rgba(255,255,255,0.1)',
                    borderRadius: '9999px',
                    overflow: 'hidden',
                  }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.min(100, Math.max(0, ((tempVal ?? 0) / 50) * 100))}%`,
                      background: status.color,
                      borderRadius: '9999px',
                      transition: 'width 0.5s ease',
                    }} />
                  </div>

                  {/* Probe hardware identifier */}
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.72rem',
                    color: 'rgba(255,255,255,0.65)',
                    background: 'rgba(0,0,0,0.25)',
                    padding: '0.45rem 0.65rem',
                    borderRadius: '0.5rem',
                    marginTop: '0.25rem',
                  }}>
                    <span>Probe ROM:</span>
                    <strong style={{ color: '#4ade80', fontFamily: 'monospace' }}>
                      {probeAddress}
                    </strong>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>

        {/* ─── SECTION 2: SHARED ATMOSPHERIC SENSORS ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '1rem' }}>🌤️</span>
              <h2 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: '#ffffff', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                Shared Environmental Microclimate
              </h2>
            </div>
            <span style={{
              fontSize: '0.72rem',
              color: 'rgba(255,255,255,0.7)',
              background: 'rgba(255,255,255,0.06)',
              padding: '0.25rem 0.65rem',
              borderRadius: '9999px',
              border: '1px solid rgba(255,255,255,0.1)',
            }}>
              Shared by Farm 1 & Farm 2 (Single Central Atmospheric Hub)
            </span>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '1rem',
          }}>
            {/* 1. Air Temperature */}
            <div style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '0.85rem',
              padding: '1.15rem',
              backdropFilter: 'blur(8px)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.75)' }}>
                  Air Temperature
                </span>
                <span style={{ fontSize: '1.2rem' }}>🌡️</span>
              </div>
              <div style={{ marginTop: '0.4rem', display: 'flex', alignItems: 'baseline', gap: '0.25rem' }}>
                <span style={{
                  fontSize: '2rem',
                  fontWeight: 800,
                  color: isEspConnected && sharedEnv.air_temperature != null ? '#ffffff' : 'rgba(255,255,255,0.4)',
                  lineHeight: 1,
                }}>
                  {isEspConnected && sharedEnv.air_temperature != null ? sharedEnv.air_temperature.toFixed(1) : '--'}
                </span>
                <span style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)' }}>°C</span>
              </div>
              <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)', marginTop: '0.4rem', display: 'block' }}>
                DHT22 Atmospheric Sensor (GPIO 27)
              </span>
            </div>

            {/* 2. Relative Humidity */}
            <div style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '0.85rem',
              padding: '1.15rem',
              backdropFilter: 'blur(8px)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.75)' }}>
                  Air Humidity
                </span>
                <span style={{ fontSize: '1.2rem' }}>💦</span>
              </div>
              <div style={{ marginTop: '0.4rem', display: 'flex', alignItems: 'baseline', gap: '0.25rem' }}>
                <span style={{
                  fontSize: '2rem',
                  fontWeight: 800,
                  color: isEspConnected && sharedEnv.humidity != null ? '#ffffff' : 'rgba(255,255,255,0.4)',
                  lineHeight: 1,
                }}>
                  {isEspConnected && sharedEnv.humidity != null ? sharedEnv.humidity.toFixed(1) : '--'}
                </span>
                <span style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)' }}>% RH</span>
              </div>
              <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)', marginTop: '0.4rem', display: 'block' }}>
                DHT22 Atmospheric Sensor (GPIO 27)
              </span>
            </div>

            {/* 3. Light Intensity */}
            <div style={{
              background: 'rgba(255, 255, 255, 0.05)',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              borderRadius: '0.85rem',
              padding: '1.15rem',
              backdropFilter: 'blur(8px)',
              boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'rgba(255,255,255,0.75)' }}>
                  Light Intensity
                </span>
                <span style={{ fontSize: '1.2rem' }}>☀️</span>
              </div>
              <div style={{ marginTop: '0.4rem', display: 'flex', alignItems: 'baseline', gap: '0.25rem' }}>
                <span style={{
                  fontSize: '2rem',
                  fontWeight: 800,
                  color: isEspConnected && sharedEnv.light_lux != null ? '#ffffff' : 'rgba(255,255,255,0.4)',
                  lineHeight: 1,
                }}>
                  {isEspConnected && sharedEnv.light_lux != null ? Math.round(sharedEnv.light_lux).toLocaleString() : '--'}
                </span>
                <span style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)' }}>lux</span>
              </div>
              <span style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.5)', marginTop: '0.4rem', display: 'block' }}>
                BH1750 Ambient Light (I²C 0x23)
              </span>
            </div>
          </div>
        </div>

      </div>
    </AppShell>
  );
}
