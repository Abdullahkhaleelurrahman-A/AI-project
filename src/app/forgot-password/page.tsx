'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/client';
import MarudamLogo from '@/components/brand/MarudamLogo';
import { type Language, getTranslations } from '@/lib/i18n/translations';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [language, setLanguage] = useState<Language>('English');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('marudam-lang');
      if (stored) setLanguage(stored as Language);
    }
  }, []);

  useEffect(() => {
    const rtlLangs = ['Urdu', 'Kashmiri', 'Sindhi'];
    document.documentElement.dir = rtlLangs.includes(language) ? 'rtl' : 'ltr';
  }, [language]);

  const t = useMemo(() => getTranslations(language), [language]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError(t.login.errorEmailRequired);
      return;
    }

    if (!isSupabaseConfigured()) {
      setError(
        'Authentication service is not configured. ' +
        'Please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in your .env.local file.'
      );
      return;
    }

    setLoading(true);

    try {
      const supabase = createClient();
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/login`,
      });
      setLoading(false);

      if (resetError) {
        setError(resetError.message);
        return;
      }

      setSuccess(true);
    } catch {
      setLoading(false);
      setError('Something went wrong. Please try again.');
    }
  };

  /* ── style helpers ─────────────────────────────────────────────────── */
  const fieldStyle: React.CSSProperties = {
    width: '100%',
    background: 'var(--border-very-subtle)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '0.75rem',
    padding: '0.72rem 1rem',
    color: 'var(--text-primary)',
    fontSize: '0.92rem',
    outline: 'none',
    transition: 'border-color 0.2s',
    boxSizing: 'border-box',
  };
  const focusField = (e: React.FocusEvent<HTMLInputElement>) =>
    (e.currentTarget.style.borderColor = 'rgba(160,224,80,0.55)');
  const blurField = (e: React.FocusEvent<HTMLInputElement>) =>
    (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)');

  return (
    <div
      style={{
        minHeight: '100svh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'linear-gradient(135deg, #0a1a0a 0%, #0e2e18 42%, #0a1e2a 100%)',
        padding: '1.5rem', position: 'relative', overflow: 'hidden',
      }}
    >
      {/* Decorative glows */}
      <div aria-hidden style={{ position:'absolute',top:'-8%',right:'-4%',width:'580px',height:'580px',borderRadius:'50%',background:'radial-gradient(circle,rgba(80,165,60,0.08) 0%,transparent 68%)',pointerEvents:'none'}}/>
      <div aria-hidden style={{ position:'absolute',bottom:'-8%',left:'-4%',width:'500px',height:'500px',borderRadius:'50%',background:'radial-gradient(circle,rgba(38,120,165,0.08) 0%,transparent 68%)',pointerEvents:'none'}}/>

      {/* Back button */}
      <button
        onClick={() => router.push('/login')}
        aria-label={t.login.backToHome}
        style={{position:'fixed',top:'1.25rem',left:'1.25rem',background:'var(--border-very-subtle)',border:'1px solid rgba(255,255,255,0.10)',color:'rgba(255,255,255,0.65)',padding:'0.48rem 1rem',borderRadius:'9999px',fontSize:'0.82rem',cursor:'pointer',display:'inline-flex',alignItems:'center',gap:'0.38rem',transition:'background 0.2s',backdropFilter:'blur(8px)',zIndex:10}}
        onMouseEnter={e=>{e.currentTarget.style.background='rgba(255,255,255,0.11)';e.currentTarget.style.color='var(--text-primary)';}}
        onMouseLeave={e=>{e.currentTarget.style.background='var(--border-very-subtle)';e.currentTarget.style.color='rgba(255,255,255,0.65)';}}
      >
        ← Back to Sign In
      </button>

      {/* Card */}
      <div style={{width:'100%',maxWidth:'420px',background:'rgba(255,255,255,0.04)',backdropFilter:'blur(22px)',WebkitBackdropFilter:'blur(22px)',border:'1px solid rgba(255,255,255,0.09)',borderRadius:'1.5rem',padding:'clamp(2rem,4vw,2.75rem)',boxShadow:'0 25px 65px rgba(0,0,0,0.45)',position:'relative',zIndex:1}}>

        {/* Brand */}
        <div style={{display:'flex',alignItems:'center',gap:'0.6rem',marginBottom:'2rem'}}>
          <MarudamLogo size={36} showWordmark wordmarkStyle={{fontSize:'1.3rem'}} />
        </div>

        <h1 style={{color:'var(--text-primary)',fontSize:'1.6rem',fontWeight:700,margin:'0 0 0.35rem 0',letterSpacing:'-0.02em'}}>
          Reset Password
        </h1>
        <p style={{color:'rgba(255,255,255,0.48)',fontSize:'0.88rem',margin:'0 0 2rem 0'}}>
          Enter your email address and we&apos;ll send you a link to reset your password.
        </p>

        {/* Error */}
        {error && (
          <div role="alert" style={{background:'rgba(239,68,68,0.12)',border:'1px solid rgba(239,68,68,0.25)',borderRadius:'0.75rem',padding:'0.65rem 1rem',color:'#f87171',fontSize:'0.83rem',marginBottom:'1.25rem',display:'flex',alignItems:'flex-start',gap:'0.5rem'}}>
            <span style={{flexShrink:0,marginTop:'0.05rem'}}>⚠</span>
            <span>{error}</span>
          </div>
        )}

        {/* Success */}
        {success && (
          <div style={{background:'rgba(74,222,128,0.12)',border:'1px solid rgba(74,222,128,0.25)',borderRadius:'0.75rem',padding:'0.65rem 1rem',color:'#4ade80',fontSize:'0.83rem',marginBottom:'1.25rem'}}>
            ✓ If an account exists for <strong>{email}</strong>, a password reset link has been sent. Please check your email.
          </div>
        )}

        {!success ? (
          <form onSubmit={handleSubmit} noValidate>
            <div style={{marginBottom:'1.75rem'}}>
              <label htmlFor="reset-email" style={{display:'block',color:'rgba(255,255,255,0.68)',fontSize:'0.82rem',fontWeight:500,marginBottom:'0.4rem'}}>
                {t.login.email}
              </label>
              <input id="reset-email" type="email" value={email}
                onChange={e=>setEmail(e.target.value)}
                placeholder="you@example.com" required autoComplete="email"
                disabled={loading}
                style={{...fieldStyle, opacity: loading ? 0.6 : 1}} onFocus={focusField} onBlur={blurField}/>
            </div>

            <button
              type="submit" disabled={loading}
              style={{width:'100%',background:loading?'rgba(78,136,56,0.45)':'linear-gradient(135deg,#4e8838 0%,#74b438 100%)',color:'var(--text-primary)',border:'none',borderRadius:'9999px',padding:'0.82rem',fontSize:'0.95rem',fontWeight:700,cursor:loading?'not-allowed':'pointer',transition:'transform 0.2s,box-shadow 0.2s',boxShadow:loading?'none':'0 4px 22px rgba(78,136,56,0.38)',display:'flex',alignItems:'center',justifyContent:'center',gap:'0.5rem'}}
              onMouseEnter={e=>{if(!loading)e.currentTarget.style.transform='translateY(-1px)';}}
              onMouseLeave={e=>{e.currentTarget.style.transform='';}}
            >
              {loading && (
                <span style={{
                  display:'inline-block',width:'16px',height:'16px',
                  border:'2px solid rgba(255,255,255,0.3)',borderTopColor:'white',
                  borderRadius:'50%',
                  animation:'marudam-spin 0.6s linear infinite',
                }}/>
              )}
              {loading ? 'Sending…' : 'Send Reset Link'}
            </button>
          </form>
        ) : (
          <button
            onClick={() => router.push('/login')}
            style={{width:'100%',background:'linear-gradient(135deg,#4e8838 0%,#74b438 100%)',color:'var(--text-primary)',border:'none',borderRadius:'9999px',padding:'0.82rem',fontSize:'0.95rem',fontWeight:700,cursor:'pointer',transition:'transform 0.2s,box-shadow 0.2s',boxShadow:'0 4px 22px rgba(78,136,56,0.38)'}}
            onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-1px)';}}
            onMouseLeave={e=>{e.currentTarget.style.transform='';}}
          >
            Back to Sign In
          </button>
        )}

        <p style={{textAlign:'center',color:'rgba(255,255,255,0.38)',fontSize:'0.82rem',marginTop:'1.5rem',marginBottom:0}}>
          Remember your password?{' '}
          <a href="/login" style={{color:'rgba(160,224,80,0.82)',textDecoration:'none',fontWeight:600}}>
            Sign in
          </a>
        </p>
      </div>

      {/* Spinner keyframes */}
      <style>{`
        @keyframes marudam-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
