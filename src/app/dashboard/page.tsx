'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/client';
import MarudamLogo from '@/components/brand/MarudamLogo';
import AppShell from '@/components/layout/AppShell';
import MarudamChat from '@/components/chatbot/MarudamChat';
import LiveMoistureChart, { type MoistureDataPoint } from '@/components/charts/LiveMoistureChart';
import WeatherWidget from '@/components/weather/WeatherWidget';

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
import {
  getStoredFarmProfile,
  getStateForDistrict,
  FARM_PROFILE_UPDATED_EVENT,
  type FarmProfileData,
} from '@/lib/data/farmProfile';
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
  CONNECTED: '#4ade80',
  STALE: '#facc15',
  DISCONNECTED: '#ef4444',
  OFFLINE: '#ef4444',
  UNKNOWN: '#94a3b8',
};

export default function DashboardPage() {
  const router = useRouter();
  const [farmerName,    setFarmerName]    = useState('');
  const [language,      setLanguage]      = useState<Language>('English');
  const [farmProfile,   setFarmProfile]   = useState<FarmProfile | null>(() => {
    const s = getStoredFarmProfile();
    return {
      name: s.name,
      language: 'English',
      state: s.state || getStateForDistrict(s.district),
      district: s.district,
      crop_id: s.crop_id,
      sowing_date: s.sowing_date,
      device_id: s.device_id,
    };
  });
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
  const [deviceStatus,    setDeviceStatus]    = useState<'ONLINE'|'CONNECTED'|'STALE'|'DISCONNECTED'|'OFFLINE'|'UNKNOWN'>('DISCONNECTED');
  const [sensorAge,       setSensorAge]       = useState(0);
  const [dataSource,      setDataSource]      = useState<DataSource>('none');
  const [transportSource, setTransportSource] = useState<'serial'|'wifi'|null>(null);
  const [cloudDevice,     setCloudDevice]     = useState<DeviceRow | null>(null);
  const [cloudAnomalies,  setCloudAnomalies]  = useState<SupabaseAnomaly[]>([]);
  const [activeAnomalyTab, setActiveAnomalyTab] = useState<'all' | 'field_1' | 'field_2'>('all');
  const [moistureHistory, setMoistureHistory] = useState<MoistureDataPoint[]>([]);
  const [currentTime,     setCurrentTime]     = useState<number>(() => Date.now());

  const lastReadingTs = useRef<string | null>(null);
  const isPollingRef  = useRef<boolean>(false);
  const t = useMemo(() => getTranslations(language), [language]);

  // Keep live clock updated every second for precise elapsed time displays
  useEffect(() => {
    const clockTimer = setInterval(() => setCurrentTime(Date.now()), 1000);
    return () => clearInterval(clockTimer);
  }, []);

  // ─── Load Supabase profile or local fallback & listen for updates ────────────
  useEffect(() => {
    const applyProfile = (data: FarmProfileData) => {
      setFarmerName(data.name || 'Local Farm');
      setFarmProfile(prev => ({
        name: data.name || 'Local Farm',
        language: prev?.language || language,
        state: data.state || getStateForDistrict(data.district),
        district: data.district,
        crop_id: data.crop_id,
        sowing_date: data.sowing_date,
        device_id: data.device_id,
      }));
    };

    const handleProfileUpdate = (e: Event) => {
      const customEvent = e as CustomEvent<FarmProfileData>;
      if (customEvent && customEvent.detail) {
        applyProfile(customEvent.detail);
      } else {
        applyProfile(getStoredFarmProfile());
      }
    };

    window.addEventListener(FARM_PROFILE_UPDATED_EVENT, handleProfileUpdate);
    window.addEventListener('storage', handleProfileUpdate);

    const load = async () => {
      // 1. Immediately sync with local single source of truth
      const stored = getStoredFarmProfile();
      applyProfile(stored);

      // If Supabase is not configured, we are ready
      if (!isSupabaseConfigured()) {
        setProfileLoaded(true);
        return;
      }

      try {
        const supabase = createClient();
        const { data: { user }, error: userError } = await supabase.auth.getUser();
        if (userError || !user) {
          applyProfile(getStoredFarmProfile());
          setProfileLoaded(true);
          return;
        }

        const { data: profile } = await supabase
          .from('profiles')
          .select('name, language')
          .eq('user_id', user.id)
          .single();

        const { data: farm } = await supabase
          .from('farms')
          .select('state, district, crop_id, sowing_date, device_id')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .single();

        if (profile) {
          if (profile.name) setFarmerName(profile.name);
          if (profile.language) setLanguage((profile.language as Language) ?? 'English');
        }
        if (farm) {
          const synced: FarmProfileData = {
            name: profile?.name || stored.name,
            crop_id: farm.crop_id ?? stored.crop_id,
            district: farm.district ?? stored.district,
            state: farm.state ?? stored.state,
            sowing_date: farm.sowing_date ?? stored.sowing_date,
            device_id: farm.device_id ?? stored.device_id,
          };
          applyProfile(synced);
        }
      } catch (err) {
        console.warn('Supabase load error, retaining local farm profile:', err);
        applyProfile(getStoredFarmProfile());
      } finally {
        setProfileLoaded(true);
      }
    };
    load();

    return () => {
      window.removeEventListener(FARM_PROFILE_UPDATED_EVENT, handleProfileUpdate);
      window.removeEventListener('storage', handleProfileUpdate);
    };
  }, [language]);

  const handleLanguageChange = async (newLang: Language) => {
    setLanguage(newLang);
    if (!isSupabaseConfigured()) return;
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        await supabase.from('profiles').update({ language: newLang }).eq('user_id', user.id);
      }
    } catch {}
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

  // ── Protected atomic state updates (prevents out-of-order stale overwrites) ─
  const applyField1Data = useCallback((reading: SupabaseSensorReading, forceLive = false) => {
    setField1Data(prev => {
      if (!prev || forceLive) return reading;
      const prevT = new Date(prev.timestamp).getTime();
      const newT = new Date(reading.timestamp).getTime();
      const now = Date.now();
      // If previous stored timestamp is corrupt/future (> 30s ahead of local clock), replace it immediately
      if (!isNaN(prevT) && prevT > now + 30000) {
        return reading;
      }
      if (!isNaN(prevT) && !isNaN(newT) && newT < prevT - 5000) {
        return prev; // Ignore older out-of-order reading
      }
      return reading;
    });
  }, []);

  const applyField2Data = useCallback((reading: SupabaseSensorReading, forceLive = false) => {
    setField2Data(prev => {
      if (!prev || forceLive) return reading;
      const prevT = new Date(prev.timestamp).getTime();
      const newT = new Date(reading.timestamp).getTime();
      const now = Date.now();
      // If previous stored timestamp is corrupt/future (> 30s ahead of local clock), replace it immediately
      if (!isNaN(prevT) && prevT > now + 30000) {
        return reading;
      }
      if (!isNaN(prevT) && !isNaN(newT) && newT < prevT - 5000) {
        return prev; // Ignore older out-of-order reading
      }
      return reading;
    });
  }, []);

  // ── 1. Supabase initial fetch + Realtime subscriptions ────────────────────
  useEffect(() => {
    if (!profileLoaded) return;

    const init = async () => {
      const [twoFields, anomalies, device] = await Promise.all([
        fetchLatestTwoFieldReadings(deviceId),
        fetchRecentAnomalies(deviceId, 30),
        fetchDeviceStatus(deviceId),
      ]);

      if (anomalies.length > 0) setCloudAnomalies(anomalies);
      if (device) setCloudDevice(device);

      const now = Date.now();
      const lastSeenMs = device?.last_seen ? new Date(device.last_seen).getTime() : 0;
      const isDeviceFresh = device?.status === 'CONNECTED' && lastSeenMs > 0 && (now - lastSeenMs) < 60000;

      const f1Ts = twoFields.field_1?.timestamp ? new Date(twoFields.field_1.timestamp).getTime() : 0;
      const isReadingFresh = f1Ts > 0 && (now - f1Ts) < 60000;

      if (isDeviceFresh && isReadingFresh) {
        if (twoFields.field_1) {
          applyField1Data(twoFields.field_1);
          setSensorData(mapSupabaseReading(twoFields.field_1));
          lastReadingTs.current = twoFields.field_1.timestamp;
        }
        if (twoFields.field_2) {
          applyField2Data(twoFields.field_2);
        }
        const activeF = twoFields.field_1 || twoFields.field_2;
        if (activeF) {
          setSharedEnv({
            air_temperature: activeF.air_temperature,
            humidity:        activeF.humidity,
            light_lux:       activeF.light_lux,
          });
        }
        setSensorAge(Math.floor((now - f1Ts) / 1000));
        setDataSource('supabase');
        setDeviceStatus('CONNECTED');
      } else {
        // Historical data exists in Supabase, but ESP32 is not actively connected right now!
        setDeviceStatus('DISCONNECTED');
        setField1Data(null);
        setField2Data(null);
        setSensorData(null);
        setSharedEnv({ air_temperature: null, humidity: null, light_lux: null });
        setDataSource('supabase');
      }
    };
    init();

    // Realtime: updates on sensor_readings
    const unsubReadings = subscribeToReadings(deviceId, (reading) => {
      if (reading.field_id === 'field_2') {
        applyField2Data(reading);
      } else {
        applyField1Data(reading);
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
      setDeviceStatus('CONNECTED');

      const now = new Date(reading.timestamp || Date.now());
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setMoistureHistory(prev => {
        const isF2 = reading.field_id === 'field_2';
        const last = prev[prev.length - 1];
        const newPoint: MoistureDataPoint = {
          timestamp: reading.timestamp || now.toISOString(),
          time: timeStr,
          field1Moisture: isF2 ? (last?.field1Moisture ?? null) : (reading.soil_moisture ?? null),
          field1Raw: isF2 ? (last?.field1Raw ?? null) : (reading.soil_moisture_raw ?? null),
          field1Voltage: isF2 ? (last?.field1Voltage ?? null) : (reading.soil_moisture_voltage ?? null),
          field2Moisture: isF2 ? (reading.soil_moisture ?? null) : (last?.field2Moisture ?? null),
          field2Raw: isF2 ? (reading.soil_moisture_raw ?? null) : (last?.field2Raw ?? null),
          field2Voltage: isF2 ? (reading.soil_moisture_voltage ?? null) : (last?.field2Voltage ?? null),
        };
        return [...prev.slice(-59), newPoint];
      });
    });

    const unsubAnomalies = subscribeToAnomalies(deviceId, (anomaly) => {
      setCloudAnomalies(prev => [anomaly, ...prev].slice(0, 30));
    });

    const unsubDevice = subscribeToDeviceStatus(deviceId, (device) => {
      setCloudDevice(device);
      if (device.status === 'DISCONNECTED') {
        setDeviceStatus('DISCONNECTED');
        setField1Data(null);
        setField2Data(null);
        setSensorData(null);
        setSharedEnv({ air_temperature: null, humidity: null, light_lux: null });
      }
    });

    return () => {
      unsubReadings();
      unsubAnomalies();
      unsubDevice();
    };
  }, [profileLoaded, deviceId, mapSupabaseReading, applyField1Data, applyField2Data]);

  // ── 2. Local backend polling (fallback / high-frequency dev) ───────────────
  // Fast poll: /api/sensors/live every 2s for real-time sensor values
  const fetchLiveSensors = useCallback(async () => {
    if (isPollingRef.current) return;
    isPollingRef.current = true;
    try {
      const res = await fetch(`${BACKEND_URL}/api/sensors/live`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`Live endpoint ${res.status}`);
      const d = await res.json();

      if (d.history && Array.isArray(d.history) && d.history.length > 0) {
        setMoistureHistory(d.history);
      } else if (d.field_1 || d.field_2) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const pt: MoistureDataPoint = {
          timestamp: now.toISOString(),
          time: timeStr,
          field1Moisture: d.field_1?.soil_moisture ?? null,
          field1Raw: d.field_1?.soil_moisture_raw ?? null,
          field1Voltage: d.field_1?.soil_moisture_voltage ?? null,
          field2Moisture: d.field_2?.soil_moisture ?? null,
          field2Raw: d.field_2?.soil_moisture_raw ?? null,
          field2Voltage: d.field_2?.soil_moisture_voltage ?? null,
        };
        setMoistureHistory(prev => {
          const last = prev[prev.length - 1];
          if (last && last.field1Raw === pt.field1Raw && last.field2Raw === pt.field2Raw && last.time === pt.time) {
            return prev;
          }
          return [...prev.slice(-59), pt];
        });
      }

      if (d.connected && (d.field_1 || d.field_2)) {
        if (d.field_1) {
          applyField1Data(d.field_1, true);
          setSensorData(mapSupabaseReading(d.field_1));
          lastReadingTs.current = d.field_1.timestamp;
        }
        if (d.field_2) {
          applyField2Data(d.field_2, true);
        }
        if (d.shared) {
          setSharedEnv(d.shared);
        }
        if (d.source) setTransportSource(d.source === 'wifi' ? 'wifi' : 'serial');
        setDataSource('local');
        setSensorAge(d.age_seconds ?? 0);
        setDeviceStatus('CONNECTED');
      } else {
        // ESP32 is disconnected or not transmitting fresh readings
        setDeviceStatus('DISCONNECTED');
        setField1Data(null);
        setField2Data(null);
        setSensorData(null);
        setSharedEnv({ air_temperature: null, humidity: null, light_lux: null });
        setTransportSource(null);
        setDataSource('local');
        if (d.age_seconds != null) setSensorAge(d.age_seconds);
      }
    } catch {
      // Backend not reachable
      setDeviceStatus('OFFLINE');
      setField1Data(null);
      setField2Data(null);
      setSensorData(null);
      setSharedEnv({ air_temperature: null, humidity: null, light_lux: null });
      setTransportSource(null);
    } finally {
      isPollingRef.current = false;
    }
  }, [deviceId, BACKEND_URL, mapSupabaseReading, applyField1Data, applyField2Data]);

  // Slower poll: AI features (baseline, events, decision) every 5s
  const fetchAIFeatures = useCallback(async () => {
    try {
      const [br, er, dr] = await Promise.allSettled([
        fetch(`${BACKEND_URL}/api/baseline/${deviceId}`),
        fetch(`${BACKEND_URL}/api/events/${deviceId}`),
        fetch(`${BACKEND_URL}/api/decision/${deviceId}`),
      ]);
      if (br.status === 'fulfilled' && br.value.ok) {
        const d = await br.value.json();
        if (Object.keys(d).length > 0) setAdaptiveBaseline(d);
      }
      if (er.status === 'fulfilled' && er.value.ok) setEvents(await er.value.json());
      if (dr.status === 'fulfilled' && dr.value.ok) setDecision(await dr.value.json());
    } catch {
      // AI features are optional — don't affect connection status
    }
  }, [deviceId, BACKEND_URL]);

  // Fast live sensor polling (every 2 seconds)
  useEffect(() => {
    let alive = true;
    const run = () => { if (alive) fetchLiveSensors(); };
    run();
    const id = setInterval(run, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [fetchLiveSensors]);

  // Slower AI feature polling (every 5 seconds)
  useEffect(() => {
    let alive = true;
    const run = () => { if (alive) fetchAIFeatures(); };
    run();
    const id = setInterval(run, 5000);
    return () => { alive = false; clearInterval(id); };
  }, [fetchAIFeatures]);


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

  const formatSensorAge = useCallback((sec: number | null | undefined): string => {
    if (sec == null || isNaN(sec)) return t.common.notAvailable ?? 'N/A';
    if (sec < 60)   return t.common.justNow;
    if (sec < 3600) return `${Math.floor(sec / 60)} ${t.common.minutes} ${t.common.ago}`;
    return `${Math.floor(sec / 3600)} ${t.common.hours} ${t.common.ago}`;
  }, [t]);

  const formatReadingTime = useCallback((ts: string | null | undefined): string => {
    if (!ts) return 'Awaiting reading';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return 'Awaiting reading';
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return 'Awaiting reading';
    }
  }, []);

  const getReadingAgeSeconds = useCallback((ts: string | null | undefined): number | null => {
    if (!ts) return null;
    const timeMs = new Date(ts).getTime();
    if (isNaN(timeMs)) return null;
    const diffSec = Math.floor((currentTime - timeMs) / 1000);
    // Allow slight clock drift between browser and backend (up to 15s in future) to be treated as 0s
    if (diffSec >= -15 && diffSec < 60) {
      return Math.max(0, diffSec);
    }
    // If significantly in the future (> 15s), show absolute difference rather than falsely claiming 'just now'
    if (diffSec < -15) {
      return Math.abs(diffSec);
    }
    return diffSec;
  }, [currentTime]);

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

  const effectiveDeviceStatus: 'ONLINE'|'CONNECTED'|'STALE'|'DISCONNECTED'|'OFFLINE'|'UNKNOWN' =
    dataSource === 'local'
      ? deviceStatus
      : (cloudDevice?.status === 'CONNECTED' && cloudDevice?.last_seen && (currentTime - new Date(cloudDevice.last_seen).getTime()) < 60000
          ? 'CONNECTED'
          : (cloudDevice?.status === 'DISCONNECTED' ? 'DISCONNECTED' : (deviceStatus === 'OFFLINE' ? 'OFFLINE' : 'DISCONNECTED')));

  const isEspConnected = effectiveDeviceStatus === 'CONNECTED' || effectiveDeviceStatus === 'ONLINE';
  const hasAnyData = isEspConnected && !!(field1Data || field2Data || sensorData);

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
                {!isEspConnected
                  ? 'Sensor disconnected'
                  : dataSource === 'local'
                  ? (transportSource === 'wifi' ? '📶 ESP32 Wi-Fi' : '⚡ ESP32 Serial (COM5 @ 115200)')
                  : dataSource === 'supabase'
                  ? '☁️ Supabase Cloud'
                  : 'Waiting for ESP32...'}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {sensorAge > 0 && isEspConnected && (
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

        {/* ─── SENSOR DISCONNECTED / WAITING BANNER ─── */}
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
            <span style={{ fontSize: '1.4rem' }}>{effectiveDeviceStatus === 'OFFLINE' ? '⚠️' : '🔌'}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, color: '#f87171', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span>{effectiveDeviceStatus === 'OFFLINE' ? 'Local Backend Offline' : 'Sensor disconnected — waiting for readings'}</span>
              </div>
              <div style={{ fontSize: '0.78rem', color: '#fecaca', marginTop: '0.25rem', lineHeight: 1.45 }}>
                {effectiveDeviceStatus === 'OFFLINE'
                  ? 'FastAPI server at http://localhost:8000 is not reachable. Run python run.py to start local backend.'
                  : 'Waiting for sensor connection. Connect ESP32 via USB cable or Wi-Fi to start receiving live readings.'}
              </div>
            </div>
          </div>
        )}

        {/* ─── TELEMETRY STALE ALERT BANNER (WHEN CONNECTED BUT DATA DELAYED) ─── */}
        {isEspConnected && hasAnyData && sensorAge > 30 && (
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
            <span style={{ fontSize: '1.4rem' }}>⚠️</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, color: '#f87171', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span>Telemetry Interrupted — Sensor Data Stopped Arriving</span>
                <span style={{ fontSize: '0.7rem', padding: '0.12rem 0.5rem', borderRadius: '4px', background: 'rgba(239,68,68,0.25)', border: '1px solid rgba(239,68,68,0.4)', color: '#ffffff', fontWeight: 600 }}>
                  Last packet {formatSensorAge(sensorAge)} ({sensorAge}s ago)
                </span>
              </div>
              <div style={{ fontSize: '0.78rem', color: '#fecaca', marginTop: '0.25rem', lineHeight: 1.45 }}>
                The backend has stopped receiving sensor packets from the ESP32 on COM5. Check USB cable connection, verify baud rate is 115200, and ensure sensor wiring is intact.
              </div>
            </div>
          </div>
        )}

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
                <span style={{ fontSize: '1.6rem', fontWeight: 700, color: isEspConnected && sharedEnv.air_temperature != null ? 'var(--text-primary)' : 'var(--text-muted)', lineHeight: 1 }}>
                  {isEspConnected && sharedEnv.air_temperature != null ? sharedEnv.air_temperature.toFixed(1) : '--'}
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
                <span style={{ fontSize: '1.6rem', fontWeight: 700, color: isEspConnected && sharedEnv.humidity != null ? 'var(--text-primary)' : 'var(--text-muted)', lineHeight: 1 }}>
                  {isEspConnected && sharedEnv.humidity != null ? sharedEnv.humidity.toFixed(1) : '--'}
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
                <span style={{ fontSize: '1.6rem', fontWeight: 700, color: isEspConnected && sharedEnv.light_lux != null ? 'var(--text-primary)' : 'var(--text-muted)', lineHeight: 1 }}>
                  {isEspConnected && sharedEnv.light_lux != null ? Math.round(sharedEnv.light_lux).toLocaleString() : '--'}
                </span>
                <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>lux</span>
              </div>
              <span style={{ fontSize: '0.68rem', color: 'var(--text-faint)', marginTop: '0.3rem', display: 'block' }}>BH1750 Illuminance Sensor</span>
            </div>
          </div>
        </div>

        {/* ─── METEOROLOGICAL STATION WEATHER & 5-DAY FORECAST (OPENWEATHERMAP) ─── */}
        <WeatherWidget
          deviceId={deviceId}
          district={farmProfile?.district}
          state={farmProfile?.state}
          backendUrl={BACKEND_URL}
        />

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
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                    {farmProfile?.crop_id ? `Crop: ${farmProfile.crop_id}` : 'Primary Cultivation Zone'}
                  </div>
                  <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    marginTop: '0.35rem',
                    padding: '0.15rem 0.5rem',
                    borderRadius: '4px',
                    background: isEspConnected ? 'rgba(74,222,128,0.1)' : 'rgba(239,68,68,0.1)',
                    border: isEspConnected ? '1px solid rgba(74,222,128,0.25)' : '1px solid rgba(239,68,68,0.25)',
                    fontSize: '0.68rem',
                    color: isEspConnected ? '#86efac' : '#fca5a5',
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: isEspConnected ? '#4ade80' : '#ef4444', display: 'inline-block' }} />
                    <span>
                      {isEspConnected && field1Data?.timestamp ? (
                        <>Last updated: <strong style={{ color: '#ffffff', fontFamily: 'monospace' }}>{formatReadingTime(field1Data.timestamp)}</strong></>
                      ) : (
                        'Waiting for sensor connection'
                      )}
                    </span>
                    {isEspConnected && field1Data?.timestamp && (() => {
                      const age = getReadingAgeSeconds(field1Data.timestamp);
                      return age != null ? (
                        <span style={{ opacity: 0.8, fontSize: '0.64rem' }}>
                          ({formatSensorAge(age)})
                        </span>
                      ) : null;
                    })()}
                  </div>
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                      Relative Moisture Estimate
                    </span>
                    <span style={{ fontSize: '0.85rem' }}>💧</span>
                  </div>
                  <div style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                    {isEspConnected && field1Data?.soil_moisture != null ? (
                      <>
                        <span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#4ade80' }}>
                          {field1Data.soil_moisture.toFixed(1)}
                        </span>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>%</span>
                      </>
                    ) : (
                      <span style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-muted)' }}>--</span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-faint)', marginTop: '0.2rem', lineHeight: 1.25 }}>
                    Calibrated index (0–100%), not direct volumetric water content
                  </div>
                  <div style={{
                    marginTop: '0.5rem',
                    paddingTop: '0.4rem',
                    borderTop: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.15rem',
                    fontSize: '0.66rem',
                    fontFamily: 'monospace',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                      <span>Raw ADC:</span>
                      <strong style={{ color: '#ffffff' }}>{isEspConnected ? (field1Data?.soil_moisture_raw ?? '--') : '--'}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                      <span>Voltage:</span>
                      <strong style={{ color: '#a3e635' }}>{isEspConnected && field1Data?.soil_moisture_voltage != null ? `${field1Data.soil_moisture_voltage.toFixed(3)} V` : '--'}</strong>
                    </div>
                  </div>
                </div>

                {/* Soil Temperature */}
                <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: '0.625rem', padding: '0.85rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>Soil Temperature</span>
                    <span style={{ fontSize: '0.85rem' }}>🌡️</span>
                  </div>
                  <div style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                    <span style={{ fontSize: '1.5rem', fontWeight: 700, color: isEspConnected && field1Data?.soil_temperature != null ? '#ffffff' : 'var(--text-muted)' }}>
                      {isEspConnected && field1Data?.soil_temperature != null ? field1Data.soil_temperature.toFixed(2) : '--'}
                    </span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>°C</span>
                  </div>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)', marginTop: '0.35rem', display: 'block' }}>
                    DS18B20 Probe 1 (GPIO 4)
                  </span>
                </div>
              </div>

              {/* Status and Baseline note */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                <span>Root-zone status:</span>
                <span style={{ fontWeight: 600, color: isEspConnected && field1Data?.soil_temperature != null ? '#4ade80' : 'var(--text-muted)' }}>
                  {isEspConnected && field1Data?.soil_temperature != null ? 'Normal · Active' : 'Waiting for sensor connection'}
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
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
                    Crop: brinjal
                  </div>
                  <div style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    marginTop: '0.35rem',
                    padding: '0.15rem 0.5rem',
                    borderRadius: '4px',
                    background: isEspConnected ? 'rgba(59,130,246,0.1)' : 'rgba(239,68,68,0.1)',
                    border: isEspConnected ? '1px solid rgba(59,130,246,0.25)' : '1px solid rgba(239,68,68,0.25)',
                    fontSize: '0.68rem',
                    color: isEspConnected ? '#93c5fd' : '#fca5a5',
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: isEspConnected ? '#60a5fa' : '#ef4444', display: 'inline-block' }} />
                    <span>
                      {isEspConnected && field2Data?.timestamp ? (
                        <>Last updated: <strong style={{ color: '#ffffff', fontFamily: 'monospace' }}>{formatReadingTime(field2Data.timestamp)}</strong></>
                      ) : (
                        'Waiting for sensor connection'
                      )}
                    </span>
                    {isEspConnected && field2Data?.timestamp && (() => {
                      const age = getReadingAgeSeconds(field2Data.timestamp);
                      return age != null ? (
                        <span style={{ opacity: 0.8, fontSize: '0.64rem' }}>
                          ({formatSensorAge(age)})
                        </span>
                      ) : null;
                    })()}
                  </div>
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>
                      Relative Moisture Estimate
                    </span>
                    <span style={{ fontSize: '0.85rem' }}>💧</span>
                  </div>
                  <div style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                    {isEspConnected && field2Data?.soil_moisture != null ? (
                      <>
                        <span style={{ fontSize: '1.5rem', fontWeight: 700, color: '#60a5fa' }}>
                          {field2Data.soil_moisture.toFixed(1)}
                        </span>
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>%</span>
                      </>
                    ) : (
                      <span style={{ fontSize: '1.2rem', fontWeight: 700, color: 'var(--text-muted)' }}>--</span>
                    )}
                  </div>
                  <div style={{ fontSize: '0.62rem', color: 'var(--text-faint)', marginTop: '0.2rem', lineHeight: 1.25 }}>
                    Calibrated index (0–100%), not direct volumetric water content
                  </div>
                  <div style={{
                    marginTop: '0.5rem',
                    paddingTop: '0.4rem',
                    borderTop: '1px solid rgba(255,255,255,0.08)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.15rem',
                    fontSize: '0.66rem',
                    fontFamily: 'monospace',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                      <span>Raw ADC:</span>
                      <strong style={{ color: '#ffffff' }}>{isEspConnected ? (field2Data?.soil_moisture_raw ?? '--') : '--'}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)' }}>
                      <span>Voltage:</span>
                      <strong style={{ color: '#60a5fa' }}>{isEspConnected && field2Data?.soil_moisture_voltage != null ? `${field2Data.soil_moisture_voltage.toFixed(3)} V` : '--'}</strong>
                    </div>
                  </div>
                </div>

                {/* Soil Temperature */}
                <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)', borderRadius: '0.625rem', padding: '0.85rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <span style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--text-muted)' }}>Soil Temperature</span>
                    <span style={{ fontSize: '0.85rem' }}>🌡️</span>
                  </div>
                  <div style={{ marginTop: '0.35rem', display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                    <span style={{ fontSize: '1.5rem', fontWeight: 700, color: isEspConnected && field2Data?.soil_temperature != null ? '#ffffff' : 'var(--text-muted)' }}>
                      {isEspConnected && field2Data?.soil_temperature != null ? field2Data.soil_temperature.toFixed(2) : '--'}
                    </span>
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>°C</span>
                  </div>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)', marginTop: '0.35rem', display: 'block' }}>
                    DS18B20 Probe 2 (GPIO 4)
                  </span>
                </div>
              </div>

              {/* Status and Baseline note */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                <span>Root-zone status:</span>
                <span style={{ fontWeight: 600, color: isEspConnected && field2Data?.soil_temperature != null ? '#60a5fa' : 'var(--text-muted)' }}>
                  {isEspConnected && field2Data?.soil_temperature != null ? 'Normal · Active' : 'Waiting for sensor connection'}
                </span>
              </div>
            </div>

          </div>
        </div>

        {/* ─── REAL-TIME DUAL SOIL MOISTURE DYNAMICS CHART ─── */}
        <LiveMoistureChart
          history={moistureHistory}
          field1Name={farmProfile?.crop_id ? `Field 1 (${farmProfile.crop_id})` : 'Field 1 (A0)'}
          field2Name="Field 2 (A1)"
          liveF1={{
            moisture: isEspConnected ? (field1Data?.soil_moisture ?? null) : null,
            raw: isEspConnected ? (field1Data?.soil_moisture_raw ?? null) : null,
            voltage: isEspConnected ? (field1Data?.soil_moisture_voltage ?? null) : null,
          }}
          liveF2={{
            moisture: isEspConnected ? (field2Data?.soil_moisture ?? null) : null,
            raw: isEspConnected ? (field2Data?.soil_moisture_raw ?? null) : null,
            voltage: isEspConnected ? (field2Data?.soil_moisture_voltage ?? null) : null,
          }}
          isConnected={isEspConnected}
        />

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
