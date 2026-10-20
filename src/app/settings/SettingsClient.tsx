'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/client';
import AppShell from '@/components/layout/AppShell';
import { type Language, getTranslations } from '@/lib/i18n/translations';
import { CROPS, LOCATIONS, getCropName } from '@/lib/data/db';
import {
  getStoredFarmProfile,
  saveFarmProfile,
  getStateForDistrict,
  FARM_PROFILE_UPDATED_EVENT,
  type FarmProfileData,
} from '@/lib/data/farmProfile';

export default function SettingsClient({ hasAi }: { hasAi: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingFarm, setSavingFarm] = useState(false);
  const [profileSaveStatus, setProfileSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [farmSaveStatus, setFarmSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  
  const [language, setLanguage] = useState<Language>('English');
  const [farmerName, setFarmerName] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');
  
  // Farm personal details state
  const [cropId, setCropId] = useState('brinjal');
  const [district, setDistrict] = useState('Vellore');
  const [state, setState] = useState('Tamil Nadu');
  const [sowingDate, setSowingDate] = useState('');
  const [deviceId, setDeviceId] = useState('FIELD_001');

  const [sensorAge, setSensorAge] = useState<number | null>(null);

  const t = useMemo(() => getTranslations(language), [language]);

  // Unique list of districts for selection
  const DISTRICT_OPTIONS = useMemo(() => {
    const seen = new Set<string>();
    const list: { district: string; state: string }[] = [];
    LOCATIONS.forEach(loc => {
      if (!seen.has(loc.district)) {
        seen.add(loc.district);
        list.push({ district: loc.district, state: loc.state });
      }
    });
    return list.sort((a, b) => a.district.localeCompare(b.district));
  }, []);

  // Crop list
  const CROP_OPTIONS = useMemo(() => {
    return Object.values(CROPS).map(crop => ({
      id: crop.id,
      name: crop.name_en,
      scientific: crop.scientific_name,
    }));
  }, []);

  const checkSensorAge = useCallback(async (devId: string) => {
    try {
      const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';
      const res = await fetch(`${BACKEND_URL}/api/sensors/latest/${devId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.timestamp) {
        const diff = Math.floor((Date.now() - new Date(data.timestamp).getTime()) / 1000);
        setSensorAge(diff);
      }
    } catch {
      // API unreachable or device offline
    }
  }, []);

  const loadProfile = useCallback(async () => {
    // 1. Always load stored local profile first (persisted single source of truth)
    const stored = getStoredFarmProfile();
    setFarmerName(stored.name);
    setCropId(stored.crop_id);
    setDistrict(stored.district);
    setState(stored.state || getStateForDistrict(stored.district));
    setSowingDate(stored.sowing_date);
    setDeviceId(stored.device_id);
    checkSensorAge(stored.device_id || 'FIELD_001');

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

      const { data: profile } = await supabase.from('profiles').select('name, language').eq('user_id', user.id).single();
      if (profile) {
        if (profile.name) setFarmerName(profile.name);
        if (profile.language) setLanguage((profile.language as Language) ?? 'English');
      }

      const { data: farm } = await supabase.from('farms')
        .select('state, district, crop_id, sowing_date, device_id')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(1).single();
      
      if (farm) {
        setCropId(farm.crop_id);
        setDistrict(farm.district);
        setState(farm.state);
        setSowingDate(farm.sowing_date || stored.sowing_date);
        setDeviceId(farm.device_id || stored.device_id);
        checkSensorAge(farm.device_id ?? 'FIELD_001');

        // Keep local store synchronized
        saveFarmProfile({
          name: profile?.name || stored.name,
          crop_id: farm.crop_id,
          district: farm.district,
          state: farm.state,
          sowing_date: farm.sowing_date,
          device_id: farm.device_id,
        });
      }
    } catch {
      // Never overwrite with default values on error
    } finally {
      setLoading(false);
    }
  }, [checkSensorAge]);

  useEffect(() => {
    loadProfile();
    if (typeof window !== 'undefined') {
      const storedTheme = localStorage.getItem('marudam-theme');
      if (storedTheme === 'light' || document.documentElement.getAttribute('data-theme') === 'light') {
        setTheme('light');
      }
    }
  }, [loadProfile]);

  // Handle district selection change — automatically updates State to Tamil Nadu when Vellore is selected
  const handleDistrictChange = (newDistrict: string) => {
    setDistrict(newDistrict);
    const resolvedState = getStateForDistrict(newDistrict);
    setState(resolvedState);
  };

  const handleLanguageChange = async (newLang: Language) => {
    setLanguage(newLang);
    if (isSupabaseConfigured()) {
      try {
        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          await supabase.from('profiles').update({ language: newLang }).eq('user_id', user.id);
        }
      } catch (err) {
        console.warn('Language update error:', err);
      }
    }
  };

  const handleSaveFarmerProfile = async () => {
    setSavingProfile(true);
    setProfileSaveStatus('idle');
    try {
      await saveFarmProfile({ name: farmerName });
      setProfileSaveStatus('success');
    } catch {
      setProfileSaveStatus('error');
    } finally {
      setSavingProfile(false);
      setTimeout(() => setProfileSaveStatus('idle'), 3000);
    }
  };

  const handleSaveFarmDetails = async () => {
    setSavingFarm(true);
    setFarmSaveStatus('idle');
    try {
      const resolvedState = state || getStateForDistrict(district);
      await saveFarmProfile({
        name: farmerName,
        crop_id: cropId,
        district: district,
        state: resolvedState,
        sowing_date: sowingDate,
        device_id: deviceId || 'FIELD_001',
      });
      setState(resolvedState);
      setFarmSaveStatus('success');
    } catch (err) {
      console.error('Failed to save farm details:', err);
      setFarmSaveStatus('error');
    } finally {
      setSavingFarm(false);
      setTimeout(() => setFarmSaveStatus('idle'), 3000);
    }
  };

  const handleLogout = async () => {
    if (isSupabaseConfigured()) {
      const supabase = createClient();
      await supabase.auth.signOut();
    }
    router.push('/login');
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100svh', background: 'var(--bg-base)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
        {t.common.loading}
      </div>
    );
  }

  const isEspConnected = sensorAge !== null && sensorAge < 600;

  return (
    <AppShell
      activeRoute="/settings"
      language={language}
      onLanguageChange={handleLanguageChange}
      onLogout={handleLogout}
      pageTitle={t.settings.title}
    >
      <div style={{ flex: 1, padding: 'clamp(1.5rem, 5vw, 3rem)', maxWidth: '850px', margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>{t.settings.title}</h1>
          <p style={{ color: 'var(--text-muted)', margin: '0.4rem 0 0 0', fontSize: '0.95rem' }}>
            Customize your farm details, field sensors, and system preferences.
          </p>
        </div>

        {/* 1. CROP & FIELD (YOUR FARM DETAILS) */}
        <section id="crop-field-settings" style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: '1rem', padding: '1.75rem', boxShadow: 'var(--shadow-sm)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem' }}>
            <div>
              <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--brand-primary)', margin: 0 }}>
                {t.settings.cropAndField} (Your Farm Details)
              </h2>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', margin: '0.25rem 0 0 0' }}>
                Changes here immediately update the sidebar and all agricultural recommendations.
              </p>
            </div>
            {farmSaveStatus === 'success' && (
              <span style={{ color: '#4ade80', fontSize: '0.85rem', fontWeight: 600, background: 'rgba(74, 222, 128, 0.1)', padding: '0.3rem 0.75rem', borderRadius: '0.375rem' }}>
                ✓ {t.settings.savedSuccessfully || 'Saved to Farm'}
              </span>
            )}
            {farmSaveStatus === 'error' && (
              <span style={{ color: '#f87171', fontSize: '0.85rem', fontWeight: 600, background: 'rgba(248, 113, 113, 0.1)', padding: '0.3rem 0.75rem', borderRadius: '0.375rem' }}>
                ✕ {t.settings.saveFailed || 'Save failed'}
              </span>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
            {/* Crop Selection */}
            <div>
              <label htmlFor="settings-crop-select" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                {t.dashboard.crop} *
              </label>
              <select
                id="settings-crop-select"
                value={cropId}
                onChange={e => setCropId(e.target.value)}
                style={{
                  width: '100%',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-subtle)',
                  padding: '0.75rem 0.85rem',
                  borderRadius: '0.5rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                  outline: 'none',
                }}
              >
                {CROP_OPTIONS.map(c => (
                  <option key={c.id} value={c.id}>
                    {getCropName(c.id, language)} ({c.name})
                  </option>
                ))}
              </select>
            </div>

            {/* District Selection */}
            <div>
              <label htmlFor="settings-district-select" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                {t.dashboard.district} *
              </label>
              <select
                id="settings-district-select"
                value={district}
                onChange={e => handleDistrictChange(e.target.value)}
                style={{
                  width: '100%',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-subtle)',
                  padding: '0.75rem 0.85rem',
                  borderRadius: '0.5rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                  outline: 'none',
                }}
              >
                {DISTRICT_OPTIONS.map(d => (
                  <option key={d.district} value={d.district}>
                    {d.district} ({d.state})
                  </option>
                ))}
              </select>
            </div>

            {/* State (Auto-resolved) */}
            <div>
              <label htmlFor="settings-state-input" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                {t.dashboard.state} (Auto-resolved)
              </label>
              <input
                id="settings-state-input"
                type="text"
                readOnly
                value={state}
                style={{
                  width: '100%',
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border-subtle)',
                  padding: '0.75rem 0.85rem',
                  borderRadius: '0.5rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                  fontWeight: 600,
                  cursor: 'not-allowed',
                }}
              />
            </div>

            {/* Sowing Date */}
            <div>
              <label htmlFor="settings-sowing-date" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                {t.settings.sowingDate}
              </label>
              <input
                id="settings-sowing-date"
                type="date"
                value={sowingDate}
                onChange={e => setSowingDate(e.target.value)}
                style={{
                  width: '100%',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-subtle)',
                  padding: '0.75rem 0.85rem',
                  borderRadius: '0.5rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                  outline: 'none',
                }}
              />
            </div>

            {/* Assigned Device / Field ID */}
            <div>
              <label htmlFor="settings-device-id" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                Field / Device ID
              </label>
              <input
                id="settings-device-id"
                type="text"
                value={deviceId}
                onChange={e => setDeviceId(e.target.value)}
                placeholder="FIELD_001"
                style={{
                  width: '100%',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-subtle)',
                  padding: '0.75rem 0.85rem',
                  borderRadius: '0.5rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.95rem',
                  fontFamily: 'monospace',
                  outline: 'none',
                }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', borderTop: '1px solid var(--border-very-subtle)', paddingTop: '1.25rem' }}>
            <button
              id="save-farm-details-btn"
              onClick={handleSaveFarmDetails}
              disabled={savingFarm}
              style={{
                background: 'var(--brand-primary)',
                color: 'var(--bg-base)',
                border: 'none',
                padding: '0.75rem 1.75rem',
                borderRadius: '0.5rem',
                fontWeight: 700,
                fontSize: '0.95rem',
                cursor: savingFarm ? 'not-allowed' : 'pointer',
                transition: 'opacity 0.2s',
                opacity: savingFarm ? 0.7 : 1,
              }}
            >
              {savingFarm ? t.settings.saving : 'Save Farm Details'}
            </button>
            <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Updates sidebar immediately & persists across page reloads.
            </span>
          </div>
        </section>

        {/* 2. FARMER PROFILE */}
        <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: '1rem', padding: '1.75rem', boxShadow: 'var(--shadow-sm)' }}>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--brand-primary)', margin: '0 0 1rem 0' }}>
            {t.settings.profile}
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label htmlFor="settings-farmer-name" style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                {t.settings.farmerName}
              </label>
              <input 
                id="settings-farmer-name"
                type="text"
                value={farmerName}
                onChange={e => setFarmerName(e.target.value)}
                style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', padding: '0.75rem', borderRadius: '0.5rem', color: 'var(--text-primary)', fontSize: '1rem' }} 
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <button
                id="save-farmer-profile-btn"
                onClick={handleSaveFarmerProfile}
                disabled={savingProfile}
                style={{ background: 'var(--brand-primary)', color: 'var(--bg-base)', border: 'none', padding: '0.6rem 1.25rem', borderRadius: '0.5rem', fontWeight: 600, cursor: 'pointer' }}
              >
                {savingProfile ? t.settings.saving : t.settings.save}
              </button>
              {profileSaveStatus === 'success' && <span style={{ color: '#4ade80', fontSize: '0.9rem' }}>{t.settings.savedSuccessfully}</span>}
              {profileSaveStatus === 'error' && <span style={{ color: '#f87171', fontSize: '0.9rem' }}>{t.settings.saveFailed}</span>}
            </div>
          </div>
        </section>

        {/* 3. APPEARANCE */}
        <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: '1rem', padding: '1.75rem', boxShadow: 'var(--shadow-sm)' }}>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--brand-primary)', margin: '0 0 1rem 0' }}>Appearance</h2>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '1rem', background: 'var(--bg-input)', borderRadius: '0.5rem' }}>
            <span style={{ color: 'var(--text-secondary)' }}>Light theme</span>
            <label style={{ position: 'relative', display: 'inline-block', width: '44px', height: '24px' }}>
              <input 
                type="checkbox" 
                style={{ opacity: 0, width: 0, height: 0 }} 
                checked={theme === 'light'}
                onChange={(e) => {
                  const newTheme = e.target.checked ? 'light' : 'dark';
                  setTheme(newTheme);
                  if (newTheme === 'light') {
                    document.documentElement.setAttribute('data-theme', 'light');
                    localStorage.setItem('marudam-theme', 'light');
                  } else {
                    document.documentElement.removeAttribute('data-theme');
                    localStorage.setItem('marudam-theme', 'dark');
                  }
                }}
              />
              <span style={{
                position: 'absolute', cursor: 'pointer', top: 0, left: 0, right: 0, bottom: 0, 
                backgroundColor: theme === 'light' ? 'var(--brand-primary)' : 'var(--bg-glass-heavy)', 
                transition: '.3s', borderRadius: '24px'
              }}>
                <span style={{
                  position: 'absolute', content: '""', height: '16px', width: '16px', left: '4px', bottom: '4px', 
                  backgroundColor: 'white', transition: '.3s', borderRadius: '50%',
                  transform: theme === 'light' ? 'translateX(20px)' : 'translateX(0)'
                }}/>
              </span>
            </label>
          </div>
        </section>

        {/* 4. NOTIFICATIONS */}
        <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: '1rem', padding: '1.75rem', boxShadow: 'var(--shadow-sm)' }}>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--brand-primary)', margin: '0 0 1rem 0' }}>{t.settings.notifications}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
              <input type="checkbox" defaultChecked style={{ width: 18, height: 18, accentColor: 'var(--brand-primary)' }} />
              <span style={{ fontSize: '0.95rem' }}>{t.settings.fieldEvents}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
              <input type="checkbox" defaultChecked style={{ width: 18, height: 18, accentColor: 'var(--brand-primary)' }} />
              <span style={{ fontSize: '0.95rem' }}>{t.settings.recommendations}</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
              <input type="checkbox" defaultChecked style={{ width: 18, height: 18, accentColor: 'var(--brand-primary)' }} />
              <span style={{ fontSize: '0.95rem' }}>{t.settings.deviceAlerts}</span>
            </label>
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>Local browser preferences</p>
          </div>
        </section>

        {/* 5. ADAPTIVE BASELINE */}
        <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: '1rem', padding: '1.75rem', boxShadow: 'var(--shadow-sm)' }}>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--brand-primary)', margin: '0 0 1rem 0' }}>{t.settings.adaptiveBaseline}</h2>
          <p style={{ margin: '0 0 1rem 0', fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            {t.settings.baselineExplanation}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div style={{ background: 'var(--bg-input)', padding: '1rem', borderRadius: '0.5rem' }}>
              <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t.settings.learningStatus}</span>
              <span style={{ fontWeight: 600, color: '#4ade80' }}>{t.baseline.learning}</span>
            </div>
            <div style={{ background: 'var(--bg-input)', padding: '1rem', borderRadius: '0.5rem' }}>
              <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>{t.settings.reviewSchedule}</span>
              <span style={{ fontWeight: 600 }}>Every 7 days</span>
            </div>
          </div>
        </section>

        {/* 6. DEVICE / ESP32 */}
        <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: '1rem', padding: '1.75rem', boxShadow: 'var(--shadow-sm)' }}>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--brand-primary)', margin: '0 0 1rem 0' }}>{t.settings.device}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: 'var(--bg-input)', borderRadius: '0.5rem' }}>
              <span style={{ color: 'var(--text-primary)' }}>{t.settings.esp32Status}</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 600, color: isEspConnected ? '#4ade80' : '#f87171' }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: isEspConnected ? '#4ade80' : '#f87171', boxShadow: isEspConnected ? '0 0 8px #4ade80' : 'none' }} />
                {isEspConnected ? 'Online' : t.settings.waitingForEsp}
              </span>
            </div>
          </div>
        </section>

        {/* 7. AI ASSISTANT */}
        <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: '1rem', padding: '1.75rem', boxShadow: 'var(--shadow-sm)' }}>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--brand-primary)', margin: '0 0 1rem 0' }}>{t.settings.aiAssistant}</h2>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: 'var(--bg-input)', borderRadius: '0.5rem' }}>
            <span style={{ color: 'var(--text-primary)' }}>{t.settings.configStatus}</span>
            {hasAi ? (
              <span style={{ color: '#4ade80', fontWeight: 600 }}>{t.onboarding.setupComplete}</span>
            ) : (
              <span style={{ color: '#f87171', fontWeight: 600 }}>{t.settings.aiNotConfigured}</span>
            )}
          </div>
        </section>

        {/* 8. ABOUT MARUDAM */}
        <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: '1rem', padding: '1.75rem', marginBottom: '4rem', boxShadow: 'var(--shadow-sm)' }}>
          <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--brand-primary)', margin: '0 0 1rem 0' }}>{t.settings.aboutMarudam}</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <span style={{ color: 'var(--text-primary)' }}><strong>Marudam</strong></span>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{t.settings.version}: 1.0.0</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: '0.5rem' }}>A premium agricultural intelligence platform.</span>
          </div>
        </section>

      </div>
    </AppShell>
  );
}
