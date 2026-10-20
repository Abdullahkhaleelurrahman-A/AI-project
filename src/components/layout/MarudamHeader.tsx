'use client';

import { useRouter } from 'next/navigation';
import MarudamLogo from '@/components/brand/MarudamLogo';
import MarudamSelect from '@/components/ui/MarudamSelect';
import { type Language, getTranslations } from '@/lib/i18n/translations';

interface MarudamHeaderProps {
  activeRoute: 'dashboard' | 'settings' | 'help';
  language: Language;
  onLanguageChange: (lang: Language) => void;
  onLogout: () => void;
}

export default function MarudamHeader({
  activeRoute,
  language,
  onLanguageChange,
  onLogout
}: MarudamHeaderProps) {
  const router = useRouter();
  const t = getTranslations(language);

  const handleScrollTo = (id: string) => {
    if (activeRoute !== 'dashboard') {
      if (id === 'top') router.push('/dashboard');
      else router.push(`/dashboard#${id}`);
      return;
    }
    
    if (id === 'top') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      const el = document.getElementById(id);
      if (el) {
        const y = el.getBoundingClientRect().top + window.scrollY - 80;
        window.scrollTo({ top: y, behavior: 'smooth' });
      } else {
        // Fallback if not found on current page
        router.push(`/dashboard#${id}`);
      }
    }
  };

  const navItemStyle = (isActive: boolean) => ({
    color: isActive ? 'var(--brand-primary)' : 'var(--text-muted)',
    fontWeight: isActive ? 600 : 500,
    fontSize: '0.9rem',
    cursor: 'pointer',
    transition: 'color 0.2s'
  });

  return (
    <header style={{ 
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between', 
      padding: '1rem 1.5rem',
      background: 'var(--bg-header)', 
      borderBottom: '1px solid var(--border-brand-subtle)', 
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)', 
      position: 'sticky',
      top: 0,
      left: 0,
      right: 0,
      width: '100%',
      zIndex: 50,
      flexShrink: 0,
      alignSelf: 'stretch',
      boxShadow: '0 2px 10px rgba(0, 0, 0, 0.04)',
    }}>
      <div style={{ display:'flex', alignItems:'center', gap:'2rem' }}>
        <MarudamLogo size={32} showWordmark wordmarkStyle={{ fontSize:'1.2rem', fontWeight:800, letterSpacing:'0.05em' }} />
        <nav style={{ display:'flex', gap:'1.5rem', alignItems:'center', flexWrap:'wrap' }}>
           <span onClick={() => handleScrollTo('top')} style={navItemStyle(activeRoute === 'dashboard')}>{t.nav.dashboard}</span>
           <span onClick={() => handleScrollTo('section-field')} style={navItemStyle(false)}>{t.nav.farm}</span>
           <span onClick={() => handleScrollTo('section-sensors')} style={navItemStyle(false)}>{t.nav.sensors}</span>
           <span onClick={() => handleScrollTo('section-insights')} style={navItemStyle(false)}>{t.nav.aiInsights}</span>
           <span onClick={() => router.push('/settings')} style={navItemStyle(activeRoute === 'settings')}>{t.settings.title}</span>
           <span onClick={() => router.push('/help')} style={navItemStyle(activeRoute === 'help')}>{t.helpCenter.title}</span>
        </nav>
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:'1rem' }}>
        <div style={{ width: '130px' }}>
          <MarudamSelect
            value={language}
            onChange={val => onLanguageChange(val as Language)}
            options={(['English', 'Hindi', 'Bengali', 'Telugu', 'Marathi', 'Tamil', 'Gujarati', 'Urdu', 'Kannada', 'Odia', 'Malayalam', 'Punjabi', 'Assamese', 'Maithili', 'Sanskrit', 'Konkani', 'Manipuri', 'Kashmiri', 'Nepali', 'Sindhi', 'Dogri', 'Santali'] as Language[]).map(l => ({value: l, label: l}))}
            style={{ background: 'transparent', border: 'none' }}
          />
        </div>
        
        <button id="dashboard-logout" onClick={onLogout} style={{ background:'transparent', border:'1px solid var(--border-subtle)', color:'var(--text-secondary)', borderRadius:'9999px', padding:'0.4rem 1rem', fontSize:'0.85rem', cursor:'pointer', fontWeight:500, transition:'background 0.2s' }}>
          {t.nav.logout}
        </button>
      </div>
    </header>
  );
}
