'use client';

// =============================================================================
// MARUDAM — AppShell
// Shared authenticated layout: header (no nav) + persistent left sidebar.
// Mobile: sidebar becomes an off-canvas drawer opened via hamburger button.
//
// Usage:
//   <AppShell
//     activeRoute="dashboard"
//     language={language}
//     onLanguageChange={fn}
//     onLogout={fn}
//     pageTitle="Dashboard"
//     farmContext={{ cropName, district, state, deviceId }}
//   >
//     {children}
//   </AppShell>
// =============================================================================

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/client';
import MarudamLogo from '@/components/brand/MarudamLogo';
import MarudamSelect from '@/components/ui/MarudamSelect';
import { type Language, getTranslations } from '@/lib/i18n/translations';
import {
  getStoredFarmProfile,
  buildFarmContext,
  FARM_PROFILE_UPDATED_EVENT,
  type FarmProfileData,
} from '@/lib/data/farmProfile';

// ─── Route config ─────────────────────────────────────────────────────────────
// Every entry navigates to a real page.
// Items are listed in priority order (most important first).
const NAV_ITEMS = [
  { route: '/dashboard', label: 'Dashboard', icon: IcoDashboard  },
  { route: '/farm',      label: 'Farm',      icon: IcoFarm       },
  { route: '/sensors',   label: 'Sensors',   icon: IcoSensors    },
  { route: '/ai',        label: 'AI Insights',icon: IcoAI        },
  { route: '/alerts',    label: 'Alerts',    icon: IcoAlerts     },
  { route: '/history',   label: 'History',   icon: IcoHistory    },
  { route: '/settings',  label: 'Settings',  icon: IcoSettings   },
  { route: '/help',      label: 'Help Center',icon: IcoHelp      },
] as const;

export type AppRoute = typeof NAV_ITEMS[number]['route'];

export interface FarmContext {
  cropName?: string;
  district?: string;
  state?: string;
  deviceId?: string;
  growthStage?: string;
}

interface AppShellProps {
  activeRoute: AppRoute;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  onLogout: () => void;
  pageTitle?: string;
  farmContext?: FarmContext;
  children: React.ReactNode;
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────
function IcoDashboard() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>;
}
function IcoFarm() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
}
function IcoSensors() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>;
}
function IcoAI() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>;
}
function IcoAlerts() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>;
}
function IcoHistory() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-.08-1"/></svg>;
}
function IcoSettings() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>;
}
function IcoHelp() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>;
}

function IcoMoon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>;
}
function IcoSun() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;
}



// ─── AppShell ─────────────────────────────────────────────────────────────────
export default function AppShell({
  activeRoute,
  language,
  onLanguageChange,
  onLogout,
  pageTitle,
  farmContext,
  children,
}: AppShellProps) {
  const router = useRouter();
  const t = getTranslations(language);
  const [theme, setTheme] = useState<'light'|'dark'>('light');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const storedTheme = localStorage.getItem('marudam-theme') || 'light';
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTheme(storedTheme as 'light'|'dark');
      if (storedTheme === 'dark') {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    if (newTheme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('marudam-theme', newTheme);
  };

  useEffect(() => {
    if (!isSupabaseConfigured()) {
      router.push('/login');
      return;
    }
    try {
      const supabase = createClient();
      supabase.auth.getUser().then(({ data: { user } }) => {
        if (!user) {
          router.push('/login');
        }
      }).catch(() => {
        router.push('/login');
      });
    } catch {
      router.push('/login');
    }
  }, [router]);

  const navigate = useCallback((route: string) => {
    router.push(route);
  }, [router]);

  const ALL_LANGUAGES: Language[] = ['English', 'Hindi', 'Bengali', 'Telugu', 'Marathi', 'Tamil', 'Gujarati', 'Urdu', 'Kannada', 'Odia', 'Malayalam', 'Punjabi', 'Assamese', 'Maithili', 'Sanskrit', 'Konkani', 'Manipuri', 'Kashmiri', 'Nepali', 'Sindhi', 'Dogri', 'Santali'];
  
  const LANG_OPTIONS = ALL_LANGUAGES.map(l => ({ 
    value: l, 
    label: l 
  }));

  const isRTL = ['Urdu', 'Kashmiri', 'Sindhi'].includes(language);
  
  useEffect(() => {
    document.documentElement.dir = isRTL ? 'rtl' : 'ltr';
    document.documentElement.setAttribute('data-lang', language);
  }, [language, isRTL]);

  const [profile, setProfile] = useState<FarmProfileData>(() => getStoredFarmProfile());

  useEffect(() => {
    // Synchronize stored farm profile upon client mount
    setProfile(getStoredFarmProfile());

    const handleProfileUpdate = (e: Event) => {
      const customEvent = e as CustomEvent<FarmProfileData>;
      if (customEvent && customEvent.detail) {
        setProfile(customEvent.detail);
      } else {
        setProfile(getStoredFarmProfile());
      }
    };

    window.addEventListener(FARM_PROFILE_UPDATED_EVENT, handleProfileUpdate);
    window.addEventListener('storage', handleProfileUpdate);
    return () => {
      window.removeEventListener(FARM_PROFILE_UPDATED_EVENT, handleProfileUpdate);
      window.removeEventListener('storage', handleProfileUpdate);
    };
  }, []);

  const dynamicContext = buildFarmContext(profile, language);
  const activeFarm = {
    cropName: dynamicContext.cropName,
    growthStage: dynamicContext.growthStage,
    district: dynamicContext.district,
    state: dynamicContext.state,
    deviceId: farmContext?.deviceId || dynamicContext.deviceId,
  };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '240px 1fr',
      minHeight: '100svh',
      background: 'var(--bg-base)',
      color: 'var(--text-primary)',
    }}>
      {/* ══════ SIDEBAR ══════════════════════════════════════════════════════ */}
      <aside
        id="mrd-sidebar"
        style={{
          position: 'sticky',
          top: 0,
          height: '100svh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-panel)',
          borderRight: '1px solid var(--border-subtle)',
          overflow: 'hidden',
          zIndex: 20,
        }}
        aria-label="Site navigation"
      >
        {/* MARUDAM Branding */}
        <div style={{ padding: '1.5rem 1.25rem 1rem', borderBottom: '1px solid var(--border-very-subtle)' }}>
          <button
            onClick={() => navigate('/dashboard')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}
            aria-label="Go to Dashboard"
          >
            <MarudamLogo
              size={26}
              color="var(--brand-primary)"
              showWordmark
              wordmarkStyle={{ fontSize: '1.1rem', fontWeight: 800, letterSpacing: '0.06em', color: 'var(--text-primary)' }}
            />
          </button>
        </div>

        {/* Nav items */}
        <nav style={{ flex: 1, padding: '1rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }} aria-label="Primary navigation">
          {NAV_ITEMS.map(({ route, label, icon: Icon }) => {
            const isActive = activeRoute === route;
            return (
              <button
                key={route}
                onClick={() => navigate(route)}
                aria-current={isActive ? 'page' : undefined}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  padding: '0.6rem 0.875rem',
                  borderRadius: '0.625rem',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: isActive ? 600 : 400,
                  fontSize: '0.875rem',
                  color: isActive ? 'var(--brand-primary)' : 'var(--text-secondary)',
                  background: isActive ? 'rgba(160,224,80,0.1)' : 'transparent',
                  transition: 'background 0.15s, color 0.15s',
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <span style={{ color: isActive ? 'var(--brand-primary)' : 'var(--text-muted)', flexShrink: 0 }}>
                  <Icon />
                </span>
                <span>{(t.nav as Record<string, string>)[route.replace('/', '') === '' ? 'home' : (route.replace('/', '') === 'ai' ? 'aiInsights' : route.replace('/', ''))] || label}</span>
              </button>
            );
          })}
        </nav>

        {/* Farm context card */}
        <div style={{
          margin: '0 0.75rem 1rem',
          padding: '0.875rem',
          background: 'var(--bg-card)',
          border: '1px solid var(--border-very-subtle)',
          borderRadius: '0.75rem',
        }}>
          <div style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.625rem' }}>
            YOUR FARM
          </div>
          {[
            { label: 'Crop',     value: activeFarm.cropName },
            { label: 'Stage',    value: activeFarm.growthStage },
            { label: 'District', value: activeFarm.district },
            { label: 'State',    value: activeFarm.state },
            { label: 'Field ID', value: activeFarm.deviceId },
          ].map(({ label, value }) => value ? (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.3rem' }}>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', flexShrink: 0 }}>{label}</span>
              <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 500, textAlign: 'right', maxWidth: '110px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value}>
                {value}
              </span>
            </div>
          ) : null)}
        </div>
      </aside>

      {/* ══════ MAIN CONTENT AREA ══════════════════════════════════════════ */}
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100svh', background: 'var(--bg-base)' }}>
        {/* Top Header Bar containing Language, Theme, and Sign Out */}
        <header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 30,
            width: '100%',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.75rem 1.75rem',
            background: 'var(--bg-panel)',
            borderBottom: '1px solid var(--border-subtle)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            boxShadow: '0 1px 4px rgba(0, 0, 0, 0.04)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {/* Active page title or breadcrumb */}
            <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
              {pageTitle || (NAV_ITEMS.find(n => n.route === activeRoute)?.label || 'Dashboard')}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            {/* Language selector */}
            <div style={{ minWidth: '135px' }}>
              <MarudamSelect
                id="topbar-lang-selector"
                value={language}
                onChange={val => onLanguageChange(val as Language)}
                options={LANG_OPTIONS}
              />
            </div>

            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              aria-label="Toggle theme"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '0.5rem',
                padding: '0.45rem 0.6rem',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              {theme === 'light' ? <IcoMoon /> : <IcoSun />}
            </button>

            {/* Sign Out button */}
            <button
              id="app-logout-btn"
              onClick={onLogout}
              aria-label="Sign Out"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '0.5rem',
                padding: '0.45rem 1rem',
                cursor: 'pointer',
                color: 'var(--text-secondary)',
                fontSize: '0.85rem',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              {t.nav.logout || 'Sign Out'}
            </button>
          </div>
        </header>

        {/* Page Content */}
        <main
          id="main-content"
          style={{
            flex: 1,
            background: 'var(--bg-base)',
          }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
