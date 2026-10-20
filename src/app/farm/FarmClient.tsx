'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/client';
import AppShell from '@/components/layout/AppShell';
import { type Language, getTranslations } from '@/lib/i18n/translations';
import {
  CROPS,
  LOCATIONS,
  getCropName,
  estimateGrowthStageId,
  getCropStageName,
  getSeasonName,
  estimateSeasonId,
} from '@/lib/data/db';
import {
  getStoredFarmProfile,
  saveFarmProfile,
  getStateForDistrict,
  FARM_PROFILE_UPDATED_EVENT,
  type FarmProfileData,
} from '@/lib/data/farmProfile';

export default function FarmClient() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [language, setLanguage] = useState<Language>('English');
  const [farmerName, setFarmerName] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');

  // Unified farm data state
  const [farmData, setFarmData] = useState<FarmProfileData>(() => getStoredFarmProfile());
  const [editCropId, setEditCropId] = useState('brinjal');
  const [editDistrict, setEditDistrict] = useState('Vellore');
  const [editState, setEditState] = useState('Tamil Nadu');
  const [editSowingDate, setEditSowingDate] = useState('');
  const [editDeviceId, setEditDeviceId] = useState('FIELD_001');

  const t = useMemo(() => getTranslations(language), [language]);

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

  const CROP_OPTIONS = useMemo(() => {
    return Object.values(CROPS).map(crop => ({
      id: crop.id,
      name: crop.name_en,
      scientific: crop.scientific_name,
    }));
  }, []);

  const syncEditFields = (profile: FarmProfileData) => {
    setEditCropId(profile.crop_id);
    setEditDistrict(profile.district);
    setEditState(profile.state || getStateForDistrict(profile.district));
    setEditSowingDate(profile.sowing_date);
    setEditDeviceId(profile.device_id || 'FIELD_001');
  };

  const loadProfile = useCallback(async () => {
    // 1. Load stored profile immediately
    const stored = getStoredFarmProfile();
    setFarmData(stored);
    setFarmerName(stored.name);
    syncEditFields(stored);

    if (!isSupabaseConfigured()) {
      setLoading(false);
      return;
    }

    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
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
        const fullProfile: FarmProfileData = {
          name: profile?.name || stored.name,
          crop_id: farm.crop_id,
          district: farm.district,
          state: farm.state,
          sowing_date: farm.sowing_date || stored.sowing_date,
          device_id: farm.device_id || stored.device_id,
        };
        setFarmData(fullProfile);
        syncEditFields(fullProfile);
        saveFarmProfile(fullProfile);
      }
    } catch {
      // Retain stored profile on network or auth error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProfile();

    const handleUpdate = (e: Event) => {
      const customEvent = e as CustomEvent<FarmProfileData>;
      if (customEvent && customEvent.detail) {
        setFarmData(customEvent.detail);
        syncEditFields(customEvent.detail);
      } else {
        const stored = getStoredFarmProfile();
        setFarmData(stored);
        syncEditFields(stored);
      }
    };

    window.addEventListener(FARM_PROFILE_UPDATED_EVENT, handleUpdate);
    window.addEventListener('storage', handleUpdate);
    return () => {
      window.removeEventListener(FARM_PROFILE_UPDATED_EVENT, handleUpdate);
      window.removeEventListener('storage', handleUpdate);
    };
  }, [loadProfile]);

  const handleDistrictChange = (newDistrict: string) => {
    setEditDistrict(newDistrict);
    const resolvedState = getStateForDistrict(newDistrict);
    setEditState(resolvedState);
  };

  const handleSaveFarm = async () => {
    setSaving(true);
    setSaveStatus('idle');
    try {
      const resolvedState = editState || getStateForDistrict(editDistrict);
      const updated = await saveFarmProfile({
        name: farmerName,
        crop_id: editCropId,
        district: editDistrict,
        state: resolvedState,
        sowing_date: editSowingDate,
        device_id: editDeviceId || 'FIELD_001',
      });
      setFarmData(updated);
      setIsEditing(false);
      setSaveStatus('success');
    } catch (err) {
      console.error('Failed to save farm details:', err);
      setSaveStatus('error');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
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
        Loading farm details...
      </div>
    );
  }

  const cropId = farmData.crop_id || 'brinjal';
  const sowingDate = farmData.sowing_date || '';
  const stageId = estimateGrowthStageId(cropId, sowingDate);
  const seasonId = estimateSeasonId(sowingDate);

  return (
    <AppShell 
      activeRoute="/farm" 
      language={language} 
      onLanguageChange={handleLanguageChange} 
      onLogout={handleLogout}
      pageTitle="Farm Profile"
    >
      <div className="mrd-content" style={{ maxWidth: '900px', margin: '0 auto', width: '100%', gap: '2rem', padding: 'clamp(1.5rem, 5vw, 3rem)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1 style={{ fontSize: '2rem', fontWeight: 800, margin: '0 0 0.5rem 0', color: 'var(--text-primary)' }}>Farm Profile</h1>
            <p style={{ color: 'var(--text-muted)', margin: 0 }}>
              Manage your agricultural details and synchronized field settings.
            </p>
          </div>
          <button
            id="edit-farm-profile-btn"
            onClick={() => setIsEditing(!isEditing)}
            style={{
              background: isEditing ? 'var(--bg-card)' : 'var(--brand-primary)',
              color: isEditing ? 'var(--text-primary)' : 'var(--bg-base)',
              border: '1px solid var(--border-subtle)',
              padding: '0.65rem 1.25rem',
              borderRadius: '0.5rem',
              fontWeight: 700,
              fontSize: '0.9rem',
              cursor: 'pointer',
              transition: 'background 0.2s',
            }}
          >
            {isEditing ? 'Cancel Editing' : 'Edit Farm Details'}
          </button>
        </div>

        {saveStatus === 'success' && (
          <div style={{ background: 'rgba(74, 222, 128, 0.1)', border: '1px solid rgba(74, 222, 128, 0.3)', color: '#4ade80', padding: '0.75rem 1rem', borderRadius: '0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>
            ✓ Farm details saved successfully! The sidebar and all features have been updated.
          </div>
        )}

        {isEditing ? (
          /* ── EDIT FORM ─────────────────────────────────────────────── */
          <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '2rem', boxShadow: 'var(--shadow-sm)' }}>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--brand-primary)', margin: '0 0 1.25rem 0' }}>
              Edit Agricultural Profile
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                  Crop Type *
                </label>
                <select
                  id="farm-edit-crop-select"
                  value={editCropId}
                  onChange={e => setEditCropId(e.target.value)}
                  style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', padding: '0.75rem', borderRadius: '0.5rem', color: 'var(--text-primary)', fontSize: '0.95rem' }}
                >
                  {CROP_OPTIONS.map(c => (
                    <option key={c.id} value={c.id}>
                      {getCropName(c.id, language)} ({c.name})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                  District *
                </label>
                <select
                  id="farm-edit-district-select"
                  value={editDistrict}
                  onChange={e => handleDistrictChange(e.target.value)}
                  style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', padding: '0.75rem', borderRadius: '0.5rem', color: 'var(--text-primary)', fontSize: '0.95rem' }}
                >
                  {DISTRICT_OPTIONS.map(d => (
                    <option key={d.district} value={d.district}>
                      {d.district} ({d.state})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                  State (Auto-resolved)
                </label>
                <input
                  type="text"
                  readOnly
                  value={editState}
                  style={{ width: '100%', background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', padding: '0.75rem', borderRadius: '0.5rem', color: 'var(--text-primary)', fontSize: '0.95rem', fontWeight: 600, cursor: 'not-allowed' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                  Sowing Date
                </label>
                <input
                  type="date"
                  value={editSowingDate}
                  onChange={e => setEditSowingDate(e.target.value)}
                  style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', padding: '0.75rem', borderRadius: '0.5rem', color: 'var(--text-primary)', fontSize: '0.95rem' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem' }}>
                  Field / Device ID
                </label>
                <input
                  type="text"
                  value={editDeviceId}
                  onChange={e => setEditDeviceId(e.target.value)}
                  style={{ width: '100%', background: 'var(--bg-input)', border: '1px solid var(--border-subtle)', padding: '0.75rem', borderRadius: '0.5rem', color: 'var(--text-primary)', fontSize: '0.95rem', fontFamily: 'monospace' }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', borderTop: '1px solid var(--border-very-subtle)', paddingTop: '1.25rem' }}>
              <button
                id="farm-save-btn"
                onClick={handleSaveFarm}
                disabled={saving}
                style={{
                  background: 'var(--brand-primary)',
                  color: 'var(--bg-base)',
                  border: 'none',
                  padding: '0.75rem 1.75rem',
                  borderRadius: '0.5rem',
                  fontWeight: 700,
                  fontSize: '0.95rem',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                {saving ? 'Saving...' : 'Save & Update Sidebar'}
              </button>
              <button
                onClick={() => setIsEditing(false)}
                style={{
                  background: 'var(--bg-card)',
                  color: 'var(--text-secondary)',
                  border: '1px solid var(--border-subtle)',
                  padding: '0.75rem 1.25rem',
                  borderRadius: '0.5rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </div>
          </section>
        ) : (
          /* ── DISPLAY CARDS ─────────────────────────────────────────── */
          <>
            <section style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '2rem', boxShadow: 'var(--shadow-sm)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--brand-primary)', marginBottom: '1.5rem' }}>
                Location Details
              </div>
              <div className="mrd-two-col-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.5rem' }}>
                <div style={{ background: 'var(--bg-panel)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
                  <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>State</span>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{farmData.state || 'Tamil Nadu'}</span>
                </div>
                <div style={{ background: 'var(--bg-panel)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
                  <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>District</span>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{farmData.district || 'Vellore'}</span>
                </div>
              </div>
            </section>

            <section style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '2rem', boxShadow: 'var(--shadow-sm)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--brand-primary)', marginBottom: '1.5rem' }}>
                Crop Details
              </div>
              <div className="mrd-two-col-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1.5rem' }}>
                <div style={{ background: 'var(--bg-panel)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
                  <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Crop Type</span>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{getCropName(cropId, language)}</span>
                </div>
                <div style={{ background: 'var(--bg-panel)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
                  <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Sowing Date</span>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{farmData.sowing_date || 'Not specified'}</span>
                </div>
                <div style={{ background: 'var(--bg-panel)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
                  <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Growth Stage</span>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{getCropStageName(cropId, stageId, language)}</span>
                </div>
                <div style={{ background: 'var(--bg-panel)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
                  <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Season</span>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{getSeasonName(seasonId, language)}</span>
                </div>
              </div>
            </section>

            <section style={{ background: 'var(--bg-card)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-lg)', padding: '2rem', boxShadow: 'var(--shadow-sm)' }}>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--brand-primary)', marginBottom: '1.5rem' }}>
                Device Details
              </div>
              <div style={{ background: 'var(--bg-panel)', padding: '1rem', borderRadius: 'var(--radius-md)' }}>
                <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '0.25rem' }}>Assigned Field / Device ID</span>
                <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{farmData.device_id || 'FIELD_001'}</span>
              </div>
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
