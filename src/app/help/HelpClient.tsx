'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/client';
import AppShell from '@/components/layout/AppShell';
import { type Language, getTranslations } from '@/lib/i18n/translations';
import { getCropName, estimateGrowthStageId, getCropStageName } from '@/lib/data/db';
import { getStoredFarmProfile, buildFarmContext, FARM_PROFILE_UPDATED_EVENT } from '@/lib/data/farmProfile';

export default function HelpClient() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [language, setLanguage] = useState<Language>('English');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [farmContext, setFarmContext] = useState<any>(null);

  const t = useMemo(() => getTranslations(language), [language]);

  const loadProfile = useCallback(async () => {
    const stored = getStoredFarmProfile();
    const devId = stored.device_id || 'FIELD_001';
    setDeviceId(devId);
    setFarmContext(buildFarmContext(stored, language));

    if (typeof window !== 'undefined') {
      const storedLang = localStorage.getItem('marudam-lang');
      if (storedLang) setLanguage(storedLang as Language);
    }

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
      if (profile?.language) {
        setLanguage((profile.language as Language) ?? 'English');
      }

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
      }
    } catch {
      // offline fallback
    } finally {
      setLoading(false);
    }
  }, [language]);

  useEffect(() => {
    loadProfile();

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
  }, [loadProfile, language]);

  const handleLanguageChange = async (newLang: Language) => {
    setLanguage(newLang);
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      await supabase.from('profiles').update({ language: newLang }).eq('user_id', user.id);
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
    return <div style={{ minHeight: '100svh', background: 'var(--bg-base)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>{t.common.loading}</div>;
  }

  // Common styles for the Help Center matching History page design system
  const sectionStyle = {
    background: 'var(--bg-card)', 
    border: '1px solid var(--border-subtle)', 
    borderRadius: 'var(--radius-lg, 0.75rem)', 
    padding: '1.75rem',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '1.5rem',
  };

  const titleStyle = {
    fontSize: '1.25rem', 
    fontWeight: 700, 
    color: 'var(--brand-primary)', 
    margin: 0,
    borderBottom: '1px solid var(--border-subtle)',
    paddingBottom: '0.875rem',
  };

  const subheadingStyle = {
    fontSize: '1rem',
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: '0 0 0.5rem 0',
  };

  const pStyle = {
    margin: 0,
    fontSize: '0.95rem',
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
  };

  return (
    <AppShell
      activeRoute="/help"
      language={language}
      onLanguageChange={handleLanguageChange}
      onLogout={handleLogout}
      pageTitle={t.helpCenter.title || 'Help Center'}
      farmContext={farmContext}
    >
      <div className="mrd-content" style={{ maxWidth: '1000px', margin: '0 auto', width: '100%', padding: 'clamp(1.5rem, 4vw, 2.5rem)', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 800, margin: '0 0 0.5rem 0', color: 'var(--text-primary)' }}>{t.helpCenter.title}</h1>
          <p style={{ color: 'var(--text-muted)', margin: 0 }}>Your comprehensive guide to using the Marudam system.</p>
        </div>

        {/* GETTING STARTED */}
        <section style={sectionStyle}>
          <h2 style={titleStyle}>{t.helpCenter.gettingStarted}</h2>
          <div>
            <h3 style={subheadingStyle}>{t.helpCenter.howItWorks}</h3>
            <p style={pStyle}>
              Marudam continuously collects data from your field using sensors. It combines this with your specific crop profile and local weather conditions to provide highly accurate insights.
            </p>
          </div>
          <div>
            <h3 style={subheadingStyle}>{t.helpCenter.readFieldHealth}</h3>
            <p style={pStyle}>
              The main Field Health indicator gives you a quick glance at your farm. 
              <strong> {t.helpCenter.healthy}</strong> means everything is optimal. 
              <strong> {t.helpCenter.watch}</strong> means you should keep an eye on changing conditions. 
              <strong> {t.helpCenter.attention}</strong> means action is required soon.
            </p>
          </div>
        </section>

        {/* SENSORS */}
        <section style={sectionStyle}>
          <h2 style={titleStyle}>{t.helpCenter.sensors}</h2>
          <p style={pStyle}>{t.helpCenter.howSensorsWork}</p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem', marginTop: '0.5rem' }}>
            <div style={{ background: 'var(--bg-input)', padding: '1rem', borderRadius: '0.5rem', border: '1px solid var(--border-very-subtle)' }}>
              <h4 style={{ margin: '0 0 0.25rem 0', color: 'var(--status-normal, #16a34a)', fontWeight: 600 }}>{t.helpCenter.soilMoisture}</h4>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Measures the volumetric water content in the soil.</p>
            </div>
            <div style={{ background: 'var(--bg-input)', padding: '1rem', borderRadius: '0.5rem', border: '1px solid var(--border-very-subtle)' }}>
              <h4 style={{ margin: '0 0 0.25rem 0', color: 'var(--status-normal, #16a34a)', fontWeight: 600 }}>{t.helpCenter.soilTemp}</h4>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Monitors root zone temperature for crop health.</p>
            </div>
            <div style={{ background: 'var(--bg-input)', padding: '1rem', borderRadius: '0.5rem', border: '1px solid var(--border-very-subtle)' }}>
              <h4 style={{ margin: '0 0 0.25rem 0', color: 'var(--status-normal, #16a34a)', fontWeight: 600 }}>{t.helpCenter.lightIntensity}</h4>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Measures sunlight available for photosynthesis.</p>
            </div>
            <div style={{ background: 'var(--bg-input)', padding: '1rem', borderRadius: '0.5rem', border: '1px solid var(--border-very-subtle)' }}>
              <h4 style={{ margin: '0 0 0.25rem 0', color: 'var(--status-normal, #16a34a)', fontWeight: 600 }}>{t.helpCenter.airHumidity}</h4>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Tracks moisture in the air to predict disease risk.</p>
            </div>
            <div style={{ background: 'var(--bg-input)', padding: '1rem', borderRadius: '0.5rem', border: '1px solid var(--border-very-subtle)' }}>
              <h4 style={{ margin: '0 0 0.25rem 0', color: 'var(--status-normal, #16a34a)', fontWeight: 600 }}>{t.helpCenter.surroundingTemp}</h4>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Ambient temperature affecting crop growth and evaporation.</p>
            </div>
          </div>
        </section>

        {/* RECOMMENDATIONS */}
        <section style={sectionStyle}>
          <h2 style={titleStyle}>{t.helpCenter.recommendations}</h2>
          <div>
            <h3 style={subheadingStyle}>{t.helpCenter.whatRecommendationsMean}</h3>
            <p style={pStyle}>
              Marudam provides actionable advice based on all available data. For example, it might advise delaying irrigation if rain is highly probable, saving you water and effort.
            </p>
          </div>
          <div>
            <h3 style={subheadingStyle}>{t.helpCenter.confidence} &amp; {t.helpCenter.urgency}</h3>
            <p style={pStyle}>
              Each recommendation shows a confidence level (e.g. 95%), which represents how sure the AI is about the advice based on historical and sensor data. The urgency dictates if action is needed today or later.
            </p>
          </div>
        </section>

        {/* ADAPTIVE BASELINE */}
        <section style={sectionStyle}>
          <h2 style={titleStyle}>{t.helpCenter.adaptiveBaseline}</h2>
          <div>
            <h3 style={subheadingStyle}>{t.helpCenter.whatMarudamLearns}</h3>
            <p style={pStyle}>
              Every farm is unique. Marudam learns what is &quot;normal&quot; for your specific soil type and microclimate, rather than using generic textbook values.
            </p>
          </div>
          <div>
            <h3 style={subheadingStyle}>{t.helpCenter.whyBaselineChanges}</h3>
            <p style={pStyle}>
              The baseline adapts as the season progresses. What is considered normal soil moisture in early growth stages may differ from the harvesting stage. {t.helpCenter.whyWeatherAffects}
            </p>
          </div>
        </section>

        {/* ESP32 */}
        <section style={sectionStyle}>
          <h2 style={titleStyle}>{t.helpCenter.esp32}</h2>
          <div>
            <h3 style={subheadingStyle}>{t.helpCenter.howToConnect}</h3>
            <p style={pStyle}>
              Power on the ESP32 device in your field. It will automatically connect to Marudam servers using the pre-configured credentials and begin transmitting the 5 sensor readings.
            </p>
          </div>
          <div>
            <h3 style={subheadingStyle}>{t.helpCenter.deviceOffline}</h3>
            <p style={pStyle}>
              If the dashboard displays &quot;Waiting for ESP32&quot;, the device is currently not sending data. Marudam will not show fabricated or old data; it waits for a live connection to ensure safety.
            </p>
          </div>
        </section>

        {/* ASK MARUDAM */}
        <section style={{ ...sectionStyle, marginBottom: '4rem' }}>
          <h2 style={titleStyle}>{t.helpCenter.askMarudam}</h2>
          <div>
            <h3 style={subheadingStyle}>{t.helpCenter.howToAsk}</h3>
            <p style={pStyle}>
              Click the floating button on the bottom right of the dashboard to open the AI Chatbot. You can ask anything about your field&apos;s current state, or for general agricultural advice.
            </p>
          </div>
          <div>
            <h3 style={subheadingStyle}>{t.helpCenter.supportedLanguages}</h3>
            <p style={pStyle}>
              You can ask questions in English, Hindi, Tamil, Telugu, or Kannada. Marudam will reply in the language you selected.
            </p>
          </div>
        </section>
      </div>
    </AppShell>
  );
}
