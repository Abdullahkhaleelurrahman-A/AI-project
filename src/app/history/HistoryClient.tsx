'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/client';
import AppShell from '@/components/layout/AppShell';
import { type Language, getTranslations } from '@/lib/i18n/translations';
import { fetchReadingHistory } from '@/lib/supabase/sensors';
import type { SensorReading } from '@/lib/supabase/sensors';
import { getCropName, estimateGrowthStageId, getCropStageName } from '@/lib/data/db';
import { getStoredFarmProfile, buildFarmContext, FARM_PROFILE_UPDATED_EVENT } from '@/lib/data/farmProfile';

export default function HistoryClient() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [language, setLanguage] = useState<Language>('English');
  const [history, setHistory] = useState<SensorReading[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [farmContext, setFarmContext] = useState<any>(null);
  
  const t = useMemo(() => getTranslations(language), [language]);

  const loadProfileAndHistory = useCallback(async () => {
    const stored = getStoredFarmProfile();
    const devId = stored.device_id || 'FIELD_001';
    setDeviceId(devId);
    setFarmContext(buildFarmContext(stored, language));

    if (!isSupabaseConfigured()) {
      setHistory([]);
      setLoading(false);
      return;
    }

    try {
      const supabase = createClient();
      const { data: { user }, error: authErr } = await supabase.auth.getUser();
      if (authErr || !user) {
        setHistory([]);
        setLoading(false);
        return;
      }

      const { data: profile } = await supabase.from('profiles').select('language').eq('user_id', user.id).single();
      if (profile) setLanguage((profile.language as Language) ?? 'English');

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
          growthStage: getCropStageName(farm.crop_id, estimateGrowthStageId(farm.crop_id, farm.sowing_date), (profile?.language as Language) ?? 'English')
        });

        const data = await fetchReadingHistory(farmDevId, 100);
        setHistory(data);
      }
    } catch {}
    setLoading(false);
  }, [language]);

  useEffect(() => {
    loadProfileAndHistory();

    const handleUpdate = () => {
      const stored = getStoredFarmProfile();
      setDeviceId(stored.device_id || 'FIELD_001');
      setFarmContext(buildFarmContext(stored, language));
    };
    window.addEventListener(FARM_PROFILE_UPDATED_EVENT, handleUpdate);
    window.addEventListener('storage', handleUpdate);
    return () => {
      window.removeEventListener(FARM_PROFILE_UPDATED_EVENT, handleUpdate);
      window.removeEventListener('storage', handleUpdate);
    };
  }, [loadProfileAndHistory, language]);

  const handleLanguageChange = async (newLang: Language) => {
    setLanguage(newLang);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) await supabase.from('profiles').update({ language: newLang }).eq('user_id', user.id);
  };

  const handleLogout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  };

  if (loading) return <div style={{minHeight:'100svh', background:'var(--bg-base)'}} />;
  return (
    <AppShell 
      activeRoute="/history" 
      language={language} 
      onLanguageChange={handleLanguageChange} 
      onLogout={handleLogout}
      pageTitle="History"
      farmContext={farmContext}
    >
      <div className="mrd-content" style={{ maxWidth:'1200px', margin:'0 auto', width:'100%', padding:'clamp(1.5rem, 4vw, 2.5rem)' }}>
        <div style={{ marginBottom:'2rem' }}>
          <h1 style={{ fontSize:'2rem', fontWeight:800, margin:'0 0 0.5rem 0', color:'var(--text-primary)' }}>Sensor History</h1>
          <p style={{ color:'var(--text-muted)', margin:0 }}>Historical telemetry logs from {deviceId}</p>
        </div>

        <section style={{ background:'var(--bg-card)', border:'1px solid var(--border-subtle)', borderRadius:'var(--radius-lg)', padding:'1.5rem', overflowX:'auto' }}>
          {history.length > 0 ? (
            <table style={{ width:'100%', textAlign:'left', borderCollapse:'collapse' }}>
              <thead>
                <tr style={{ borderBottom:'1px solid var(--border-subtle)', color:'var(--text-muted)', fontSize:'0.75rem', textTransform:'uppercase', letterSpacing:'0.05em' }}>
                  <th style={{ padding:'1rem' }}>Timestamp</th>
                  <th style={{ padding:'1rem' }}>Moisture</th>
                  <th style={{ padding:'1rem' }}>Temp</th>
                  <th style={{ padding:'1rem' }}>Light</th>
                  <th style={{ padding:'1rem' }}>Humidity</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} style={{ borderBottom:'1px solid var(--border-very-subtle)', fontSize:'0.9rem', color:'var(--text-secondary)' }}>
                    <td style={{ padding:'1rem', whiteSpace:'nowrap' }}>{new Date(r.timestamp).toLocaleString()}</td>
                    <td style={{ padding:'1rem' }}>{r.soil_moisture != null ? Number(r.soil_moisture).toFixed(1) + '%' : '—'}</td>
                    <td style={{ padding:'1rem' }}>{r.soil_temperature != null ? Number(r.soil_temperature).toFixed(1) + '°C' : '—'}</td>
                    <td style={{ padding:'1rem' }}>{r.light_lux != null ? Number(r.light_lux).toFixed(0) + ' lx' : '—'}</td>
                    <td style={{ padding:'1rem' }}>{r.humidity != null ? Number(r.humidity).toFixed(1) + '%' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding:'3rem', textAlign:'center', color:'var(--text-muted)' }}>No historical data available.</div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
