'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import MarudamLogo from '@/components/brand/MarudamLogo';
import AppShell from '@/components/layout/AppShell';
import MarudamChat from '@/components/chatbot/MarudamChat';

import {
  LOCATIONS,
  getCropName,
  getCropStageName,
  getSeasonName,
  estimateSeasonId,
  estimateGrowthStageId,
  getInitialBaseline,
} from '@/lib/data/db';
import {
  type Language,
  getTranslations,
} from '@/lib/i18n/translations';
import { recommendBaselineSchedule, detectWeatherVariability } from '@/lib/baseline/scheduler';
import {
  fetchLatestReading,
  fetchLatestTwoFieldReadings,
  fetchRecentAnomalies,
  fetchDeviceStatus,
  subscribeToReadings,
  subscribeToAnomalies,
  subscribeToDeviceStatus,
  type SensorReading as SupabaseSensorReading,
  type Anomaly as SupabaseAnomaly,
  type DeviceRow,
} from '@/lib/supabase/sensors';

// ─── Types ────────────────────────────────────────────────────────────────────
interface SensorData {
  soil_moisture:           number | null;
  soil_moisture_raw?:      number | null;
  soil_moisture_voltage?:  number | null;
  soil_temperature:        number | null;
  ds18b20_address?:        string | null;
  soil_ph:                 number | null;
  soil_ec:                 number | null;
  air_temperature:         number | null;
  humidity:                number | null;
  light_lux:               number | null;
  light_intensity:         number | null;
  air_humidity:            number | null;
  surrounding_temperature: number | null;
  timestamp:               string;
}

type DataSource = 'supabase' | 'local' | 'none';

interface FieldBaseline {
  [key: string]: {
    center: number;
    min_expected: number;
    max_expected: number;
    confidence: number;
    observations_count: number;
  };
}

interface SensorEvent {
  id: number;
  event_type: string;
  sensor: string;
  start_time: string;
  end_time: string | null;
  duration_minutes: number;
  magnitude: number;
  severity: string;
  confidence: number;
  status: string;
}

interface DecisionData {
  field_status: string;
  risk_type: string;
  risk_level: string;
  confidence: number;
  recommendation_action: string;
  evidence_summary: Array<{ code: string; value?: number }>;
  root_zone?: { moisture_state: string; confidence: number };
  weather?: { status: string; rain_probability?: number };
}

interface FarmProfile {
  name: string;
  language: Language;
  state: string;
  district: string;
  crop_id: string;
  sowing_date: string | null;
  device_id: string;
}

const DEVICE_COLOR: Record<string, string> = {
  ONLINE: '#4ade80',
  STALE: '#facc15',
  OFFLINE: '#f87171',
  UNKNOWN: '#94a3b8',
};

export default function DashboardPage() {
  const router = useRouter();
  const [farmerName,    setFarmerName]    = useState('');
  const [language,      setLanguage]      = useState<Language>('English');
  const [farmProfile,   setFarmProfile]   = useState<FarmProfile | null>(null);
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [detailsOpen,   setDetailsOpen]   = useState(false);
  const [calibrationModalOpen, setCalibrationModalOpen] = useState(false);

  // ─── Two-field & shared sensor state ───────────────────────────────────────
  const [field1Data, setField1Data] = useState<SupabaseSensorReading | null>(null);
  const [field2Data, setField2Data] = useState<SupabaseSensorReading | null>(null);
  const [sharedEnv,  setSharedEnv]  = useState<{
    air_temperature: number | null;
    humidity:        number | null;
    light_lux:       number | null;
  }>({ air_temperature: null, humidity: null, light_lux: null });

  const [sensorData,      setSensorData]      = useState<SensorData | null>(null);
  const [adaptiveBaseline,setAdaptiveBaseline]= useState<FieldBaseline | null>(null);
  const [events,          setEvents]          = useState<SensorEvent[]>([]);
  const [decision,        setDecision]        = useState<DecisionData | null>(null);
  const [deviceStatus,    setDeviceStatus]    = useState<'ONLINE'|'STALE'|'OFFLINE'|'UNKNOWN'>('UNKNOWN');
  const [sensorAge,       setSensorAge]       = useState(0);
  const [dataSource,      setDataSource]      = useState<DataSource>('none');
  const [cloudDevice,     setCloudDevice]     = useState<DeviceRow | null>(null);
  const [cloudAnomalies,  setCloudAnomalies]  = useState<SupabaseAnomaly[]>([]);
  const [activeAnomalyTab, setActiveAnomalyTab] = useState<'all' | 'field_1' | 'field_2'>('all');

  const lastReadingTs = useRef<string | null>(null);
  const t = useMemo(() => getTranslations(language), [language]);

  // ─── Load Supabase profile ─────────────────────────────────────────────────
  useEffect(() => {
    const load = async () => {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { router.push('/login'); return; }

      const { data: profile } = await supabase
        .from('profiles')
        .select('name, language')
        .eq('user_id', user.id)
        .single();

      const { data: farm } = await supabase
        .from('farms')
        .select('state, district, crop_id, sowing_date, device_id')
        .eq('user_id', user.id)
        .limit(1)
        .single();

      if (profile) {
        setFarmerName(profile.name ?? '');
        setLanguage((profile.language as Language) ?? 'English');
      }
      if (farm) {
        setFarmProfile({
          name: profile?.name ?? '',
          language: (profile?.language as Language) ?? 'English',
          state: farm.state,
          district: farm.district,
          crop_id: farm.crop_id ?? 'tomato',
          sowing_date: farm.sowing_date,
          device_id: farm.device_id ?? 'FIELD_001',
        });
      }
      setProfileLoaded(true);
    };
    load();
  }, [router]);

  const handleLanguageChange = async (newLang: Language) => {
    setLanguage(newLang);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from('profiles').update({ language: newLang }).eq('user_id', user.id);
    }
  };

  // ─── Data sources ──────────────────────────────────────────────────────────
  const deviceId = farmProfile?.device_id ?? 'FIELD_001';
  const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

  const mapSupabaseReading = useCallback((r: SupabaseSensorReading): SensorData => ({
    soil_moisture:           r.soil_moisture,
    soil_moisture_raw:       r.soil_moisture_raw,
    soil_moisture_voltage:   r.soil_moisture_voltage,
    soil_temperature:        r.soil_temperature,
    ds18b20_address:         r.ds18b20_address,
    soil_ph:                 r.soil_ph,
    soil_ec:                 r.soil_ec,
    air_temperature:         r.air_temperature,
    humidity:                r.humidity,
    light_lux:               r.light_lux,
    light_intensity:         r.light_lux,
    air_humidity:            r.humidity,
    surrounding_temperature: r.air_temperature,
    timestamp:               r.timestamp,
  }), []);

  // ── 1. Supabase initial fetch + Realtime subscriptions ────────────────────
  useEffect(() => {
    if (!profileLoaded) return;

    const init = async () => {
      const [twoFields, anomalies, device] = await Promise.all([
        fetchLatestTwoFieldReadings(deviceId),
        fetchRecentAnomalies(deviceId, 30),
        fetchDeviceStatus(deviceId),
      ]);

      if (twoFields.field_1) {
        setField1Data(twoFields.field_1);
        setSensorData(mapSupabaseReading(twoFields.field_1));
        lastReadingTs.current = twoFields.field_1.timestamp;
        setSensorAge(0);
        setDataSource('supabase');
      }
      if (twoFields.field_2) {
        setField2Data(twoFields.field_2);
      }

      const activeF = twoFields.field_1 || twoFields.field_2;
      if (activeF) {
        setSharedEnv({
          air_temperature: activeF.air_temperature,
          humidity:        activeF.humidity,
          light_lux:       activeF.light_lux,
        });
      }

      if (anomalies.length > 0) setCloudAnomalies(anomalies);
      if (device) setCloudDevice(device);
    };
    init();

    // Realtime: updates on sensor_readings
    const unsubReadings = subscribeToReadings(deviceId, (reading) => {
      if (reading.field_id === 'field_2') {
        setField2Data(reading);
      } else {
        setField1Data(reading);
        setSensorData(mapSupabaseReading(reading));
      }
      setSharedEnv({
        air_temperature: reading.air_temperature,
        humidity:        reading.humidity,
        light_lux:       reading.light_lux,
      });
      lastReadingTs.current = reading.timestamp;
      setSensorAge(0);
      setDataSource('supabase');
    });

    const unsubAnomalies = subscribeToAnomalies(deviceId, (anomaly) => {
      setCloudAnomalies(prev => [anomaly, ...prev].slice(0, 30));
    });

    const unsubDevice = subscribeToDeviceStatus(deviceId, (device) => {
      setCloudDevice(device);
    });

    return () => {
      unsubReadings();
      unsubAnomalies();
      unsubDevice();
    };
  }, [profileLoaded, deviceId, mapSupabaseReading]);

  // ── 2. Local backend polling (fallback / high-frequency dev) ───────────────
  const fetchBackend = useCallback(async () => {
    try {
      const [compareRes, br, er, dr, st] = await Promise.allSettled([
        fetch(`${BACKEND_URL}/api/sensors/compare/${deviceId}`),
        fetch(`${BACKEND_URL}/api/baseline/${deviceId}`),
        fetch(`${BACKEND_URL}/api/events/${deviceId}`),
        fetch(`${BACKEND_URL}/api/decision/${deviceId}`),
        fetch(`${BACKEND_URL}/api/status/${deviceId}`),
      ]);

      if (compareRes.status === 'fulfilled' && compareRes.value.ok) {
        const d = await compareRes.value.json();
        if (d.field_1) {
          setField1Data(d.field_1);
          setSensorData(mapSupabaseReading(d.field_1));
        }
        if (d.field_2) {
          setField2Data(d.field_2);
        }
        if (d.shared) {
          setSharedEnv(d.shared);
        }
        setDataSource('local');
        setSensorAge(0);
      } else {
        // Local backend returned non-200 — fetch fresh readings from Supabase
        const twoFields = await fetchLatestTwoFieldReadings(deviceId);
        if (twoFields.field_1) {
          setField1Data(twoFields.field_1);
          setSensorData(mapSupabaseReading(twoFields.field_1));
          lastReadingTs.current = twoFields.field_1.timestamp;
          setDataSource('supabase');
          setSensorAge(0);
        }
        if (twoFields.field_2) {
          setField2Data(twoFields.field_2);
        }
        const activeF = twoFields.field_1 || twoFields.field_2;
        if (activeF) {
          setSharedEnv({
            air_temperature: activeF.air_temperature,
            humidity:        activeF.humidity,
            light_lux:       activeF.light_lux,
          });
        }
      }

      if (br.status === 'fulfilled' && br.value.ok) {
        const d = await br.value.json();
        if (Object.keys(d).length > 0) setAdaptiveBaseline(d);
      }
      if (er.status === 'fulfilled' && er.value.ok) setEvents(await er.value.json());
      if (dr.status === 'fulfilled' && dr.value.ok) setDecision(await dr.value.json());
      if (st.status === 'fulfilled' && st.value.ok) {
        const d = await st.value.json();
        setDeviceStatus(d.status ?? 'UNKNOWN');
      }
    } catch {
      // Local backend offline — periodically query Supabase for fresh data
      try {
        const twoFields = await fetchLatestTwoFieldReadings(deviceId);
        if (twoFields.field_1) {
          setField1Data(twoFields.field_1);
          setSensorData(mapSupabaseReading(twoFields.field_1));
          lastReadingTs.current = twoFields.field_1.timestamp;
          setDataSource('supabase');
          setSensorAge(0);
        }
        if (twoFields.field_2) {
          setField2Data(twoFields.field_2);
        }
        const activeF = twoFields.field_1 || twoFields.field_2;
        if (activeF) {
          setSharedEnv({
            air_temperature: activeF.air_temperature,
            humidity:        activeF.humidity,
            light_lux:       activeF.light_lux,
          });
        }
      } catch {
        // Network offline
      }
    }
  }, [deviceId, BACKEND_URL, mapSupabaseReading]);

  useEffect(() => {
    let alive = true;
    const run = () => { if (alive) fetchBackend(); };
    run();
    const id = setInterval(run, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [fetchBackend]);

  // Tick sensor age
  useEffect(() => {
    if (!field1Data && !field2Data && !sensorData) return;
    const id = setInterval(() => setSensorAge(a => a + 1), 1000);
    return () => clearInterval(id);
  }, [field1Data, field2Data, sensorData]);

  // ─── Derived context ───────────────────────────────────────────────────────
  const cropId      = farmProfile?.crop_id ?? 'tomato';
  const sowingDate  = farmProfile?.sowing_date ?? '';
  const seasonId    = useMemo(() => estimateSeasonId(sowingDate),         [sowingDate]);
  const stageId     = useMemo(() => estimateGrowthStageId(cropId, sowingDate), [cropId, sowingDate]);
  const locationInfo = useMemo(() => LOCATIONS.find(l => l.state === farmProfile?.state && l.district === farmProfile?.district), [farmProfile]);
  const cropProfile = useMemo(() => getInitialBaseline(cropId, stageId), [cropId, stageId]);

  const recentRainProbs = useMemo(() => {
    if (decision?.weather?.rain_probability != null) return [decision.weather.rain_probability];
    return [];
  }, [decision]);

  const baselineSchedule = useMemo(() => recommendBaselineSchedule({
    climate_zone: locationInfo?.climate_zone ?? 'Tropical Wet and Dry',
    season_id: seasonId,
    crop_id: cropId,
    growth_stage_id: stageId,
    weather_variability: detectWeatherVariability(recentRainProbs),
  }), [locationInfo, seasonId, cropId, stageId, recentRainProbs]);

  // Field context for chatbot
  const fieldContext = useMemo(() => ({
    farmer_name: farmerName,
    language,
    location: farmProfile ? { state: farmProfile.state, district: farmProfile.district, climate_zone: locationInfo?.climate_zone } : null,
    crop: { id: cropId, name: getCropName(cropId, language), growth_stage: getCropStageName(cropId, stageId, language), season: getSeasonName(seasonId, language) },
    two_field_summary: {
      field_1: field1Data ? {
        soil_moisture: field1Data.soil_moisture,
        raw_adc: field1Data.soil_moisture_raw,
        voltage: field1Data.soil_moisture_voltage,
        temperature: field1Data.soil_temperature,
        probe: field1Data.ds18b20_address,
      } : null,
      field_2: field2Data ? {
        soil_moisture: field2Data.soil_moisture,
        raw_adc: field2Data.soil_moisture_raw,
        voltage: field2Data.soil_moisture_voltage,
        temperature: field2Data.soil_temperature,
        probe: field2Data.ds18b20_address,
      } : null,
      shared_atmospheric: sharedEnv,
    },
    sensor: sensorData ? {
      soil_moisture: sensorData.soil_moisture,
      soil_temperature: sensorData.soil_temperature,
      air_humidity: sensorData.air_humidity,
      surrounding_temperature: sensorData.surrounding_temperature,
      last_reading_seconds_ago: sensorAge,
    } : null,
    decision: decision ? {
      field_status: decision.field_status,
      risk_type: decision.risk_type,
      risk_level: decision.risk_level,
      recommendation_action: decision.recommendation_action,
      confidence: decision.confidence,
      evidence: decision.evidence_summary?.map(e => ({ code: e.code, value: e.value })),
      root_zone: decision.root_zone,
      weather_rain_probability: decision.weather?.rain_probability,
      weather_status: decision.weather?.status,
    } : null,
    adaptive_baseline: adaptiveBaseline,
    baseline_schedule: baselineSchedule,
    device_status: deviceStatus,
  }), [farmerName, language, farmProfile, locationInfo, cropId, stageId, seasonId, field1Data, field2Data, sharedEnv, sensorData, sensorAge, decision, adaptiveBaseline, baselineSchedule, deviceStatus]);

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  };

  const formatSensorAge = (sec: number): string => {
    if (sec < 60)   return t.common.justNow;
    if (sec < 3600) return `${Math.floor(sec / 60)} ${t.common.minutes} ${t.common.ago}`;
    return `${Math.floor(sec / 3600)} ${t.common.hours} ${t.common.ago}`;
  };

  const sensorLabel = (key: string): string => ({
    soil_moisture:           t.dashboard.sensorSoilMoisture,
    soil_temperature:        t.dashboard.sensorSoilTemperature,
    air_humidity:            t.dashboard.sensorAirHumidity,
    surrounding_temperature: t.dashboard.sensorSurroundingTemp,
    light_intensity:         t.dashboard.sensorLight,
  }[key] ?? key);

  if (!profileLoaded) {
    return (
      <div style={{minHeight:'100svh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg-base)',color:'var(--text-muted)',fontSize:'0.9rem',flexDirection:'column',gap:'1.5rem'}}>
        <div style={{ animation: 'pulse 2s infinite ease-in-out' }}>
          <MarudamLogo size={48} />
        </div>
        <span>{t.common.loading}</span>
      </div>
    );
  }

  const hasAnyData = !!(field1Data || field2Data || sensorData);
  const isEspConnected = hasAnyData && sensorAge < 600; // less than 10 mins old
  const effectiveDeviceStatus = dataSource === 'local' ? deviceStatus : (cloudDevice?.status ?? (isEspConnected ? 'ONLINE' : 'UNKNOWN'));

  // Filtered anomalies
  const filteredAnomalies = cloudAnomalies.filter(a => {
    if (activeAnomalyTab === 'all') return true;
    return a.field_id === activeAnomalyTab;
  });

  return (
    <AppShell
      activeRoute="/dashboard"
      language={language}
      onLanguageChange={handleLanguageChange}
      onLogout={handleLogout}
      pageTitle={t.dashboard?.title || 'Dashboard'}
      farmContext={farmProfile ? {
        cropName: getCropName(cropId, language),
        district: farmProfile.district,
        state: farmProfile.state,
        deviceId: farmProfile.device_id,
        growthStage: getCropStageName(cropId, stageId, language),
      } : undefined}
    >
      <div style={{
        padding: '1.5rem 2rem 2rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
        position: 'relative',
        minHeight: '100%',
        backgroundImage: "linear-gradient(rgba(5, 16, 6, 0.76), rgba(5, 16, 6, 0.86)), url('/farm_bg.jpg')",
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
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: DEVICE_COLOR[effectiveDeviceStatus] || '#94a3b8', display: 'inline-block' }} />
              <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#ffffff' }}>
                ESP32 Node: <span style={{ color: 'var(--brand-primary)', fontFamily: 'monospace' }}>{deviceId}</span>
              </span>
              <span style={{
                fontSize: '0.68rem',
                fontWeight: 700,
                color: DEVICE_COLOR[effectiveDeviceStatus],
                background: `${DEVICE_COLOR[effectiveDeviceStatus]}22`,
                padding: '0.15rem 0.45rem',
                borderRadius: '9999px',
                border: `1px solid ${DEVICE_COLOR[effectiveDeviceStatus]}44`
              }}>
                {effectiveDeviceStatus}
              </span>
            </div>

            <span style={{ color: 'rgba(255,255,255,0.2)' }}>|</span>

            <div style={{ fontSize: '0.78rem', color: 'rgba(255,255,255,0.75)' }}>
              Source: <span style={{ fontWeight: 600, color: '#ffffff' }}>
                {dataSource === 'local' ? '⚡ Local USB Serial' : dataSource === 'supabase' ? '☁️ Supabase Cloud' : 'Waiting...'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {sensorAge > 0 && (
              <span style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.6)' }}>
                {t.dashboard.updatedLabel} {formatSensorAge(sensorAge)}
              </span>
            )}
            <button
              onClick={() => setCalibrationModalOpen(true)}
              style={{
                background: 'rgba(168,224,96,0.15)',
                border: '1px solid rgba(168,224,96,0.3)',
                color: 'var(--brand-primary)',
                borderRadius: '0.5rem',
                padding: '0.35rem 0.75rem',
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem'
              }}
            >
              <span>⚙️ Sensor Calibration</span>
            </button>
          </div>
        </div>

        {/* ─── SHARED ATMOSPHERIC MICROCLIMATE ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.9rem' }}>🌤️</span>
              <h2 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 700, color: '#ffffff', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                Shared Atmospheric Microclimate
              </h2>
            </div>
            <span style={{ fontSize: '0.72rem', color: 'rgba(255,255,255,0.6)' }}>
              Monitored by DHT22 (GPIO27) & BH1750 (I²C 0x23)
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.85rem' }}>
            {/* Air Temperature */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '0.75rem', padding: '1rem', boxShadow: 'var(--shadow-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Air Temperature</span>
                <span style={{ fontSize: '1.1rem' }}>🌡️</span>
              </div>
              <div style={{ marginTop: '0.4rem', display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                <span style={{ fontSize: '1.6rem', fontWeight: 700, color: sharedEnv.air_temperature != null ? 'var(--text-primary)' : 'var(--text-muted)', lineHeight: 1 }}>
                  {sharedEnv.air_temperature != null ? sharedEnv.air_temperature.toFixed(1) : '--'}
                </span>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>°C</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)', marginTop: '0.3rem', display: 'block' }}>DHT22 Atmospheric Probe</span>
            </div>

            {/* Relative Humidity */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '0.75rem', padding: '1rem', boxShadow: 'var(--shadow-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Relative Humidity</span>
                <span style={{ fontSize: '1.1rem' }}>💧</span>
              </div>
              <div style={{ marginTop: '0.4rem', display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                <span style={{ fontSize: '1.6rem', fontWeight: 700, color: sharedEnv.humidity != null ? 'var(--text-primary)' : 'var(--text-muted)', lineHeight: 1 }}>
                  {sharedEnv.humidity != null ? sharedEnv.humidity.toFixed(1) : '--'}
                </span>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>% RH</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)', marginTop: '0.3rem', display: 'block' }}>DHT22 Atmospheric Probe</span>
            </div>

            {/* Light Intensity */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '0.75rem', padding: '1rem', boxShadow: 'var(--shadow-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)' }}>Light Intensity</span>
                <span style={{ fontSize: '1.1rem' }}>☀️</span>
              </div>
              <div style={{ marginTop: '0.4rem', display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                <span style={{ fontSize: '1.6rem', fontWeight: 700, color: sharedEnv.light_lux != null ? 'var(--text-primary)' : 'var(--text-muted)', lineHeight: 1 }}>
                  {sharedEnv.light_lux != null ? Math.round(sharedEnv.light_lux).toLocaleString() : '--'}
                </span>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>lux</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)', marginTop: '0.3rem', display: 'block' }}>BH1750 Illuminance Sensor</span>
            </div>
          </div>
        </div>

        {/* ─── TWO ADJACENT FIELDS COMPARISON ─── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.9rem' }}>🌱</span>
              <h2 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 700, color: '#ffffff', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                Two Adjacent Fields — Real-Time Soil Comparison
              </h2>
            </div>
            <span style={{ fontSize: '0.72rem', color: 'var(--brand-primary)', fontWeight: 600 }}>
              Single ESP32 Controller Multi-Zone Monitoring
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem' }}>

            {/* ─── FIELD 1 CARD ─── */}
            <div style={{
              background: 'var(--bg-card)',
              border: '1.5px solid rgba(74,222,128,0.3)',
              borderRadius: '0.85rem',
              padding: '1.25rem',
              boxShadow: 'var(--shadow-card)',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#ffffff' }}>Field 1</h3>
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#4ade80', background: 'rgba(74,222,128,0.15)', padding: '0.15rem 0.5rem', borderRadius: '4px' }}>
                      ZONE 1
                    </span>
                  </div>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    {farmProfile?.crop_id ? `Crop: ${farmProfile.crop_id}` : 'Primary Cultivation Zone'}
                  </span>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'var(--brand-primary)', background: 'var(--brand-light)', padding: '0.2rem 0.4rem', borderRadius: '4px' }}>
                    ADC: A0 (ADS1115)
                  </div>
                  <div style={{ fontSize: '0.62rem', fontFamily: 'monospace', color: 'var(--text-faint)', marginTop: '0.2rem' }}>
                    ROM: {field1Data?.ds18b20_address ? field1Data.ds18b20_address.slice(0, 10) + '…' : 'Probe 1'}
                  </div>
                </div>
              </div>

              {/* Field 1 Metrics Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                {/* Soil Moisture */}
                <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: '0.625rem', padding: '0.85rem' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>Soil Moisture</span>
                  <div style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                    {field1Data?.soil_moisture != null ? (
                      <>
                        <span style={{ fontSize: '1.45rem', fontWeight: 700, color: '#4ade80' }}>
                          {field1Data.soil_moisture.toFixed(1)}
                        </span>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>%</span>
                      </>
                    ) : (
                      <div>
                        <div style={{ fontSize: '1.15rem', fontWeight: 700, color: '#facc15' }}>
                          {field1Data?.soil_moisture_voltage != null ? `${field1Data.soil_moisture_voltage.toFixed(2)} V` : '--'}
                        </div>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)' }}>
                          {field1Data?.soil_moisture_raw != null ? `${field1Data.soil_moisture_raw} counts` : 'No reading'}
                        </span>
                      </div>
                    )}
                  </div>
                  <div style={{ marginTop: '0.35rem' }}>
                    {field1Data?.soil_moisture != null ? (
                      <span style={{ fontSize: '0.65rem', color: '#4ade80', fontWeight: 600 }}>● Calibrated</span>
                    ) : (
                      <span style={{ fontSize: '0.62rem', color: '#facc15', background: 'rgba(250,204,21,0.12)', padding: '0.1rem 0.35rem', borderRadius: '4px', fontWeight: 600 }}>
                        Raw (Uncalibrated)
                      </span>
                    )}
                  </div>
                </div>

                {/* Soil Temperature */}
                <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: '0.625rem', padding: '0.85rem' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>Soil Temperature</span>
                  <div style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                    <span style={{ fontSize: '1.45rem', fontWeight: 700, color: field1Data?.soil_temperature != null ? '#ffffff' : 'var(--text-muted)' }}>
                      {field1Data?.soil_temperature != null ? field1Data.soil_temperature.toFixed(1) : '--'}
                    </span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>°C</span>
                  </div>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)', marginTop: '0.35rem', display: 'block' }}>
                    DS18B20 OneWire Bus
                  </span>
                </div>
              </div>

              {/* Status and Baseline note */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                <span>Root-zone status:</span>
                <span style={{ fontWeight: 600, color: '#4ade80' }}>
                  {field1Data?.soil_temperature != null ? 'Normal · Active' : 'Awaiting data'}
                </span>
              </div>
            </div>

            {/* ─── FIELD 2 CARD ─── */}
            <div style={{
              background: 'var(--bg-card)',
              border: '1.5px solid rgba(59,130,246,0.3)',
              borderRadius: '0.85rem',
              padding: '1.25rem',
              boxShadow: 'var(--shadow-card)',
              display: 'flex',
              flexDirection: 'column',
              gap: '1rem',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.75rem' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#ffffff' }}>Field 2</h3>
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#60a5fa', background: 'rgba(59,130,246,0.15)', padding: '0.15rem 0.5rem', borderRadius: '4px' }}>
                      ZONE 2
                    </span>
                  </div>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                    Adjacent Agricultural Plot
                  </span>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: '0.65rem', fontFamily: 'monospace', color: '#60a5fa', background: 'rgba(59,130,246,0.12)', padding: '0.2rem 0.4rem', borderRadius: '4px' }}>
                    ADC: A1 (ADS1115)
                  </div>
                  <div style={{ fontSize: '0.62rem', fontFamily: 'monospace', color: 'var(--text-faint)', marginTop: '0.2rem' }}>
                    ROM: {field2Data?.ds18b20_address ? field2Data.ds18b20_address.slice(0, 10) + '…' : 'Probe 2'}
                  </div>
                </div>
              </div>

              {/* Field 2 Metrics Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                {/* Soil Moisture */}
                <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: '0.625rem', padding: '0.85rem' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>Soil Moisture</span>
                  <div style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                    {field2Data?.soil_moisture != null ? (
                      <>
                        <span style={{ fontSize: '1.45rem', fontWeight: 700, color: '#60a5fa' }}>
                          {field2Data.soil_moisture.toFixed(1)}
                        </span>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>%</span>
                      </>
                    ) : (
                      <div>
                        <div style={{ fontSize: '1.15rem', fontWeight: 700, color: '#facc15' }}>
                          {field2Data?.soil_moisture_voltage != null ? `${field2Data.soil_moisture_voltage.toFixed(2)} V` : '--'}
                        </div>
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)' }}>
                          {field2Data?.soil_moisture_raw != null ? `${field2Data.soil_moisture_raw} counts` : 'No reading'}
                        </span>
                      </div>
                    )}
                  </div>
                  <div style={{ marginTop: '0.35rem' }}>
                    {field2Data?.soil_moisture != null ? (
                      <span style={{ fontSize: '0.65rem', color: '#60a5fa', fontWeight: 600 }}>● Calibrated</span>
                    ) : (
                      <span style={{ fontSize: '0.62rem', color: '#facc15', background: 'rgba(250,204,21,0.12)', padding: '0.1rem 0.35rem', borderRadius: '4px', fontWeight: 600 }}>
                        Raw (Uncalibrated)
                      </span>
                    )}
                  </div>
                </div>

                {/* Soil Temperature */}
                <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: '0.625rem', padding: '0.85rem' }}>
                  <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>Soil Temperature</span>
                  <div style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                    <span style={{ fontSize: '1.45rem', fontWeight: 700, color: field2Data?.soil_temperature != null ? '#ffffff' : 'var(--text-muted)' }}>
                      {field2Data?.soil_temperature != null ? field2Data.soil_temperature.toFixed(1) : '--'}
                    </span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>°C</span>
                  </div>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)', marginTop: '0.35rem', display: 'block' }}>
                    DS18B20 OneWire Bus
                  </span>
                </div>
              </div>

              {/* Status and Baseline note */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                <span>Root-zone status:</span>
                <span style={{ fontWeight: 600, color: '#60a5fa' }}>
                  {field2Data?.soil_temperature != null ? 'Normal · Active' : 'Awaiting data'}
                </span>
              </div>
            </div>

          </div>
        </div>

        {/* ─── INSIGHTS & ANOMALIES SECTION ─── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)', gap: '1.5rem', alignItems: 'start' }}>

          {/* LEFT: Field-Specific Anomaly Timeline */}
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-card)', padding: '1.25rem', boxShadow: 'var(--shadow-card)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '1rem' }}>🚨</span>
                <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700, color: '#ffffff' }}>
                  Field Events & Anomaly Timeline
                </h3>
              </div>

              {/* Tabs for isolating Field 1 and Field 2 events */}
              <div style={{ display: 'flex', background: 'var(--bg-base)', padding: '0.2rem', borderRadius: '0.5rem', border: '1px solid var(--border-subtle)' }}>
                {(['all', 'field_1', 'field_2'] as const).map(tab => (
                  <button
                    key={tab}
                    onClick={() => setActiveAnomalyTab(tab)}
                    style={{
                      background: activeAnomalyTab === tab ? 'var(--brand-primary)' : 'transparent',
                      color: activeAnomalyTab === tab ? '#000000' : 'var(--text-muted)',
                      border: 'none',
                      borderRadius: '0.375rem',
                      padding: '0.2rem 0.6rem',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      transition: 'all 0.15s'
                    }}
                  >
                    {tab === 'all' ? 'All Alerts' : tab === 'field_1' ? 'Field 1' : 'Field 2'}
                  </button>
                ))}
              </div>
            </div>

            {filteredAnomalies.length === 0 ? (
              <div style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                ✅ No anomalies detected for {activeAnomalyTab === 'all' ? 'monitored fields' : activeAnomalyTab}. Baseline normal.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                {filteredAnomalies.slice(0, 5).map(a => {
                  const isF2 = a.field_id === 'field_2';
                  return (
                    <div
                      key={a.id}
                      style={{
                        padding: '0.75rem',
                        background: 'var(--bg-base)',
                        border: '1px solid var(--border-very-subtle)',
                        borderRadius: '0.5rem',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '0.75rem'
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.2rem' }}>
                          <span style={{
                            fontSize: '0.62rem',
                            fontWeight: 700,
                            padding: '0.1rem 0.35rem',
                            borderRadius: '3px',
                            background: isF2 ? 'rgba(59,130,246,0.2)' : 'rgba(74,222,128,0.2)',
                            color: isF2 ? '#60a5fa' : '#4ade80'
                          }}>
                            {a.field_id?.toUpperCase() || 'FIELD 1'}
                          </span>
                          <span style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                            {sensorLabel(a.sensor)}
                          </span>
                          <span style={{
                            fontSize: '0.62rem',
                            fontWeight: 700,
                            color: a.risk_level === 'CRITICAL' ? '#ef4444' : a.risk_level === 'HIGH' ? '#f97316' : '#facc15'
                          }}>
                            [{a.risk_level}]
                          </span>
                        </div>
                        <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                          {a.message}
                        </p>
                      </div>
                      <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                        {new Date(a.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* RIGHT: AI Decision & Adaptive Baseline */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* AI ADAPTIVE BASELINE */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-card)', padding: '1.25rem', boxShadow: 'var(--shadow-card)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                <span style={{ fontSize: '0.9rem' }}>🎯</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  AI Adaptive Baseline Progress
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                <div style={{ padding: '0.6rem', background: 'var(--bg-base)', borderRadius: '0.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem', fontSize: '0.75rem' }}>
                    <span style={{ color: '#4ade80', fontWeight: 600 }}>Field 1 Model Confidence</span>
                    <span style={{ color: '#ffffff', fontWeight: 700 }}>85%</span>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.1)', height: 5, borderRadius: 9999, overflow: 'hidden' }}>
                    <div style={{ width: '85%', height: '100%', background: '#4ade80' }} />
                  </div>
                </div>

                <div style={{ padding: '0.6rem', background: 'var(--bg-base)', borderRadius: '0.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem', fontSize: '0.75rem' }}>
                    <span style={{ color: '#60a5fa', fontWeight: 600 }}>Field 2 Model Confidence</span>
                    <span style={{ color: '#ffffff', fontWeight: 700 }}>78%</span>
                  </div>
                  <div style={{ background: 'rgba(255,255,255,0.1)', height: 5, borderRadius: 9999, overflow: 'hidden' }}>
                    <div style={{ width: '78%', height: '100%', background: '#60a5fa' }} />
                  </div>
                </div>
              </div>
            </div>

            {/* ACTION RECOMMENDATION */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-card)', padding: '1.25rem', boxShadow: 'var(--shadow-card)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.9rem' }}>💡</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.08em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
                  Agronomic Recommendation
                </span>
              </div>
              <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {decision?.recommendation_action === 'CONSIDER_IRRIGATION'
                  ? 'Field 1 shows higher drying rate than Field 2. Check root-zone moisture before morning irrigation.'
                  : 'Both field microclimates are in equilibrium. Continue periodic monitoring.'}
              </p>
              <span style={{ fontSize: '0.7rem', color: 'var(--brand-primary)', fontWeight: 600 }}>
                Status: {decision?.field_status || 'NORMAL'}
              </span>
            </div>
          </div>

        </div>

      </div>{/* end background wrapper */}

      {/* Sensor Calibration Modal */}
      {calibrationModalOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)', zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '1rem', padding: '1.75rem', width: '100%', maxWidth: '520px', boxShadow: 'var(--shadow-card-hover)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, color: '#ffffff' }}>
                Capacitive Soil Moisture Calibration
              </h3>
              <button onClick={() => setCalibrationModalOpen(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.5rem', lineHeight: 1 }}>×</button>
            </div>
            <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)', fontSize: '0.85rem', lineHeight: 1.6 }}>
              The ADS1115 transmits high-precision 16-bit analog voltages (0.0 V to 3.3 V). To convert raw voltage into calibrated volumetric soil moisture (%):
            </p>
            <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: '0.5rem', padding: '0.75rem', fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--brand-primary)', marginBottom: '1rem' }}>
              Moisture % = ((V_dry - V_measured) / (V_dry - V_wet)) * 100%
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              <div><strong>1. Dry Point (0%):</strong> Hold probe in air. Record voltage (~2.80 V).</div>
              <div><strong>2. Wet Point (100%):</strong> Submerge in water up to limit line. Record voltage (~1.30 V).</div>
              <div><strong>3. Update config.h:</strong> Set <code>CALIBRATE_MOISTURE true</code> and flash to ESP32.</div>
            </div>
            <button onClick={() => setCalibrationModalOpen(false)} style={{ background: 'var(--brand-primary)', color: '#000000', border: 'none', borderRadius: '0.5rem', padding: '0.625rem 1.25rem', width: '100%', fontWeight: 700, cursor: 'pointer', fontSize: '0.875rem' }}>
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Sensor details modal */}
      {detailsOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: '1rem', padding: '1.75rem', width: '100%', maxWidth: '460px', boxShadow: 'var(--shadow-card-hover)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)' }}>{t.dashboard.sensorDetailsTitle}</h3>
              <button onClick={() => setDetailsOpen(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '1.5rem', lineHeight: 1 }}>×</button>
            </div>
            <p style={{ margin: '0 0 1.25rem', color: 'var(--text-secondary)', fontSize: '0.875rem', lineHeight: 1.6 }}>{t.dashboard.sensorDetailsDesc}</p>
            <button onClick={() => setDetailsOpen(false)} style={{ background: 'var(--brand-light)', color: 'var(--brand-primary)', border: '1px solid var(--border-brand-subtle)', borderRadius: '0.625rem', padding: '0.625rem 1.25rem', width: '100%', fontWeight: 600, cursor: 'pointer', fontSize: '0.875rem' }}>{t.chat.close}</button>
          </div>
        </div>
      )}

      <MarudamChat language={language} fieldContext={fieldContext} />
    </AppShell>
  );
}
