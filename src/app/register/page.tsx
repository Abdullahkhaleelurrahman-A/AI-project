'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient, isSupabaseConfigured } from '@/lib/supabase/client';
import MarudamLogo from '@/components/brand/MarudamLogo';
import MarudamSelect from '@/components/ui/MarudamSelect';
import { LOCATIONS, CROPS, STATES, type Language } from '@/lib/data/db';
import { getTranslations } from '@/lib/i18n/translations';
import { saveFarmProfile, getStateForDistrict } from '@/lib/data/farmProfile';

const LANGUAGES: Language[] = [
  'English', 'Hindi', 'Bengali', 'Telugu', 'Marathi', 'Tamil', 'Gujarati', 'Urdu', 'Kannada', 'Odia', 'Malayalam', 'Punjabi', 'Assamese', 'Maithili', 'Sanskrit', 'Konkani', 'Manipuri', 'Kashmiri', 'Nepali', 'Sindhi', 'Dogri', 'Santali'
];

export default function RegisterPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [language, setLanguage] = useState<Language>('English');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('marudam-lang');
      if (stored) setLanguage(stored as Language);
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('marudam-lang', language);
    }
    const rtlLangs = ['Urdu', 'Kashmiri', 'Sindhi'];
    document.documentElement.dir = rtlLangs.includes(language) ? 'rtl' : 'ltr';
  }, [language]);

  const t = useMemo(() => getTranslations(language), [language]);

  // Step 1: Account
  const [name, setName]             = useState('');
  const [email, setEmail]           = useState('');
  const [password, setPassword]     = useState('');
  const [confirmPw, setConfirmPw]   = useState('');

  // Step 2: Location
  const [state, setState]           = useState('');
  const [district, setDistrict]     = useState('');

  // Step 3: Crop
  const [cropId, setCropId]         = useState('tomato');
  const [sowingDate, setSowingDate] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 10); return d.toISOString().split('T')[0];
  });
  const [deviceId, setDeviceId]     = useState('FIELD_001');

  const [loading, setLoading]               = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [success, setSuccess]               = useState(false);
  const [emailConfirmNeeded, setEmailConfirmNeeded] = useState(false);

  const availableDistricts = useMemo(
    () => LOCATIONS.filter(l => l.state === state).map(l => l.district).sort(),
    [state]
  );

  /* ── Validation ─────────────────────────────────────────────────────── */
  const validateStep = (): boolean => {
    setError(null);
    if (step === 1) {
      if (!name.trim())                               { setError(t.register.errorNameRequired);    return false; }
      if (!email.trim() || !email.includes('@'))      { setError(t.register.errorEmailInvalid);    return false; }
      if (password.length < 8)                        { setError(t.register.errorPasswordShort);   return false; }
      if (password !== confirmPw)                     { setError(t.register.errorPasswordMatch);   return false; }
    }
    if (step === 2) {
      if (!state)    { setError(t.register.errorStateRequired);    return false; }
      if (!district) { setError(t.register.errorDistrictRequired); return false; }
    }
    if (step === 3) {
      if (!cropId) { setError(t.register.errorCropRequired); return false; }
    }
    return true;
  };

  /* ── Navigation ─────────────────────────────────────────────────────── */
  const handleNext = () => {
    if (!validateStep()) return;
    setStep(s => s + 1);
  };

  /* ── Submit ─────────────────────────────────────────────────────────── */
  const handleSubmit = async () => {
    if (!validateStep()) return;
    setLoading(true);
    setError(null);

    const resolvedState = state || getStateForDistrict(district);
    await saveFarmProfile({
      name: name.trim() || 'Local Farmer',
      crop_id: cropId,
      district: district,
      state: resolvedState,
      sowing_date: sowingDate || new Date().toISOString().slice(0, 10),
      device_id: deviceId.trim() || 'FIELD_001',
    });

    if (!isSupabaseConfigured()) {
      setLoading(false);
      setError(
        'Authentication service is not configured. ' +
        'Please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in your .env.local file.'
      );
      return;
    }

    try {
      // ── Step 1: Sign up via the SSR browser client ─────────────────────
      // The SSR client handles cookie-based session management for page
      // navigation after login.  We use it only for auth.signUp() here.
      const supabase = createClient();

      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          // Store name/language in user_metadata as a recoverable fallback
          // for the email-confirmation flow where no session is returned.
          data: { name: name.trim(), language },
        },
      });

      if (authError) {
        setError(authError.message);
        setLoading(false);
        return;
      }

    if (!authData.user) {
      setError('Registration failed: no user returned from Supabase. Please try again.');
      setLoading(false);
      return;
    }

    // ── Step 2: Check whether a session was returned immediately ───────
    // Email confirmation DISABLED  → session is non-null; insert now.
    // Email confirmation ENABLED   → session is null; cannot insert yet
    //   because RLS requires auth.uid() which requires an active JWT.
    //   Ask the farmer to confirm their email, then sign in.
    if (!authData.session) {
      setLoading(false);
      setSuccess(true);
      setEmailConfirmNeeded(true);
      return;
    }

    // ── Step 3: Build a one-shot client with the JWT in headers ────────
    // @supabase/ssr stores sessions in cookies, and the cookie write
    // may not be visible to the same browser-side fetch before the
    // next tick.  Instead of relying on cookie timing, we create a
    // transient @supabase/supabase-js client that explicitly carries
    // the access_token in every request's Authorization header.
    // This is the most reliable way to guarantee auth.uid() resolves
    // correctly in the PostgREST RLS check on the very first insert.
    const { createClient: createRawClient } = await import('@supabase/supabase-js');

    const authedClient = createRawClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        auth: {
          // This client is ephemeral — we never want it to persist or
          // refresh the session.  All we need is the one-shot insert.
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
        global: {
          // Explicitly include the user's JWT on every request.
          // PostgREST reads this header and resolves auth.uid() from it,
          // which makes the RLS policy `auth.uid() = user_id` pass.
          headers: {
            Authorization: `Bearer ${authData.session.access_token}`,
          },
        },
      }
    );

    const userId = authData.user.id;

    // ── Step 4: Insert profile ─────────────────────────────────────────
    const { error: profileError } = await authedClient.from('profiles').insert({
      user_id:  userId,
      name:     name.trim(),
      language,
    });

    if (profileError) {
      // Show the real Supabase error for debugging.
      setError(
        `Profile insert failed — ${profileError.message}` +
        ` [code: ${profileError.code ?? 'n/a'}, hint: ${profileError.hint ?? 'none'}].` +
        ` Your account was created. You can sign in and your profile will be set up.`
      );
      setLoading(false);
      setTimeout(() => router.push('/dashboard'), 4000);
      return;
    }

    // ── Step 5: Insert farm ────────────────────────────────────────────
    // Non-fatal: if this fails, the profile is already saved and the
    // farmer can update their farm details from the dashboard.
    const { error: farmError } = await authedClient.from('farms').insert({
      user_id:     userId,
      name:        `${name.trim()}'s Field`,
      state,
      district,
      crop_id:     cropId,
      sowing_date: sowingDate || null,
      device_id:   deviceId.trim() || 'FIELD_001',
    });

    if (farmError) {
      console.error(
        '[Marudam] Farm insert error:',
        farmError.message,
        `code=${farmError.code}`,
        `hint=${farmError.hint}`
      );
    }

    // ── Step 6: Persist the real session for page navigation ──────────
    // Now that the DB writes are done, hand the session back to the SSR
    // client so the dashboard middleware can read it from cookies.
    await supabase.auth.setSession({
      access_token:  authData.session.access_token,
      refresh_token: authData.session.refresh_token,
    });

    setLoading(false);
    setSuccess(true);
    setTimeout(() => router.push('/dashboard'), 1500);
  } catch (err: unknown) {
    setLoading(false);
    const message = err instanceof Error ? err.message : 'Registration failed. Please try again.';
    setError(message);
  }
};



  /* ── Styles ─────────────────────────────────────────────────────────── */
  const fieldStyle: React.CSSProperties = {
    width:'100%',background:'var(--border-very-subtle)',border:'1px solid rgba(255,255,255,0.12)',
    borderRadius:'0.75rem',padding:'0.72rem 1rem',color:'var(--text-primary)',fontSize:'0.92rem',
    outline:'none',boxSizing:'border-box',transition:'border-color 0.2s',
  };

  const focusField = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) =>
    (e.currentTarget.style.borderColor = 'rgba(160,224,80,0.55)');
  const blurField = (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) =>
    (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)');
  const labelStyle: React.CSSProperties = {
    display:'block',color:'rgba(255,255,255,0.68)',fontSize:'0.82rem',fontWeight:500,marginBottom:'0.4rem'
  };
  const groupStyle: React.CSSProperties = { marginBottom: '1rem' };

  const stepTitles = [t.register.step1Title, t.register.step2Title, t.register.step3Title];

  return (
    <div style={{minHeight:'100svh',display:'flex',alignItems:'center',justifyContent:'center',background:'linear-gradient(135deg,#0a1a0a 0%,#0e2e18 42%,#0a1e2a 100%)',padding:'1.5rem',position:'relative',overflow:'hidden'}}>
      {/* Decorative glows */}
      <div aria-hidden style={{position:'absolute',top:'-8%',right:'-4%',width:'580px',height:'580px',borderRadius:'50%',background:'radial-gradient(circle,rgba(80,165,60,0.08) 0%,transparent 68%)',pointerEvents:'none'}}/>
      <div aria-hidden style={{position:'absolute',bottom:'-8%',left:'-4%',width:'500px',height:'500px',borderRadius:'50%',background:'radial-gradient(circle,rgba(38,120,165,0.08) 0%,transparent 68%)',pointerEvents:'none'}}/>

      {/* Back button */}
      <button onClick={()=>router.push('/')} style={{position:'fixed',top:'1.25rem',left:'1.25rem',background:'var(--border-very-subtle)',border:'1px solid rgba(255,255,255,0.10)',color:'rgba(255,255,255,0.65)',padding:'0.48rem 1rem',borderRadius:'9999px',fontSize:'0.82rem',cursor:'pointer',backdropFilter:'blur(8px)',zIndex:10}}>
        ← {t.login.backToHome}
      </button>

      {/* Card */}
      <div style={{width:'100%',maxWidth:'480px',background:'rgba(255,255,255,0.04)',backdropFilter:'blur(22px)',WebkitBackdropFilter:'blur(22px)',border:'1px solid rgba(255,255,255,0.09)',borderRadius:'1.5rem',padding:'clamp(2rem,4vw,2.75rem)',boxShadow:'0 25px 65px rgba(0,0,0,0.45)',position:'relative',zIndex:1}}>

        {/* Brand */}
        <div style={{display:'flex',alignItems:'center',gap:'0.6rem',marginBottom:'1.5rem'}}>
          <MarudamLogo size={32} showWordmark wordmarkStyle={{fontSize:'1.2rem'}} />
        </div>

        {/* Step indicator */}
        <div style={{display:'flex',gap:'0.4rem',marginBottom:'1.5rem'}}>
          {[1,2,3].map(s=>(
            <div key={s} style={{flex:1,height:3,borderRadius:9999,background:s<=step?'var(--brand-primary)':'rgba(255,255,255,0.12)',transition:'background 0.3s'}}/>
          ))}
        </div>

        <h1 style={{color:'var(--text-primary)',fontSize:'1.4rem',fontWeight:700,margin:'0 0 0.3rem 0'}}>
          {t.register.title}
        </h1>
        <p style={{color:'rgba(255,255,255,0.45)',fontSize:'0.85rem',margin:'0 0 1.5rem 0'}}>
          {stepTitles[step - 1]}
        </p>

        {/* Error */}
        {error && (
          <div role="alert" style={{background:'rgba(239,68,68,0.12)',border:'1px solid rgba(239,68,68,0.25)',borderRadius:'0.75rem',padding:'0.65rem 1rem',color:'#f87171',fontSize:'0.83rem',marginBottom:'1.25rem'}}>
            {error}
          </div>
        )}
        {/* Success */}
        {success && (
          <div style={{background:'rgba(74,222,128,0.12)',border:'1px solid rgba(74,222,128,0.25)',borderRadius:'0.75rem',padding:'0.65rem 1rem',color:'#4ade80',fontSize:'0.83rem',marginBottom:'1.25rem'}}>
            {emailConfirmNeeded
              ? `Check your email at ${email} to confirm your account, then sign in.`
              : t.register.successMessage
            }
          </div>
        )}

        {/* ── STEP 1: Account ──────────────────────────────────────────── */}
        {step === 1 && (
          <div>
            {/* Language first (affects copy instantly) */}
            <div style={groupStyle}>
              <label style={labelStyle}>{t.register.language}</label>
              <MarudamSelect
                id="reg-language"
                value={language}
                onChange={(val) => setLanguage(val as Language)}
                options={LANGUAGES.map((l) => ({ value: l, label: l }))}
                className="reg-select"
              />
            </div>
            <div style={groupStyle}>
              <label style={labelStyle}>{t.register.name}</label>
              <input id="reg-name" type="text" value={name} onChange={e=>setName(e.target.value)} placeholder={t.register.namePlaceholder} style={fieldStyle} onFocus={focusField} onBlur={blurField}/>
            </div>
            <div style={groupStyle}>
              <label style={labelStyle}>{t.register.email}</label>
              <input id="reg-email" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder={t.register.emailPlaceholder} autoComplete="email" style={fieldStyle} onFocus={focusField} onBlur={blurField}/>
            </div>
            <div style={groupStyle}>
              <label style={labelStyle}>{t.register.password}</label>
              <input id="reg-password" type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder={t.register.passwordPlaceholder} autoComplete="new-password" style={fieldStyle} onFocus={focusField} onBlur={blurField}/>
            </div>
            <div style={{...groupStyle, marginBottom:'1.75rem'}}>
              <label style={labelStyle}>{t.register.confirmPassword}</label>
              <input id="reg-confirm-password" type="password" value={confirmPw} onChange={e=>setConfirmPw(e.target.value)} placeholder={t.register.confirmPasswordPlaceholder} autoComplete="new-password" style={fieldStyle} onFocus={focusField} onBlur={blurField}/>
            </div>
          </div>
        )}

        {/* ── STEP 2: Location ─────────────────────────────────────────── */}
        {step === 2 && (
          <div>
            <div style={groupStyle}>
              <label style={labelStyle}>{t.register.state}</label>
              <MarudamSelect
                id="reg-state"
                value={state}
                onChange={(val) => { setState(val); setDistrict(''); }}
                options={[
                  { value: '', label: t.register.selectState, disabled: true },
                  ...STATES.map((s) => ({ value: s, label: s })),
                ]}
                placeholder={t.register.selectState}
              />
            </div>
            <div style={{...groupStyle, marginBottom:'1.75rem'}}>
              <label style={labelStyle}>{t.register.district}</label>
              <MarudamSelect
                id="reg-district"
                value={district}
                onChange={(val) => setDistrict(val)}
                disabled={!state}
                options={[
                  { value: '', label: t.register.selectDistrict, disabled: true },
                  ...availableDistricts.map((d) => ({ value: d, label: d })),
                ]}
                placeholder={t.register.selectDistrict}
              />
            </div>
          </div>
        )}

        {/* ── STEP 3: Crop ─────────────────────────────────────────────── */}
        {step === 3 && (
          <div>
            <div style={groupStyle}>
              <label style={labelStyle}>{t.register.crop}</label>
              <MarudamSelect
                id="reg-crop"
                value={cropId}
                onChange={(val) => setCropId(val)}
                options={Object.values(CROPS).map((c) => ({ value: c.id, label: c.name_en }))}
              />
            </div>
            <div style={groupStyle}>
              <label style={labelStyle}>{t.register.sowingDate}</label>
              <input id="reg-sowing-date" type="date" value={sowingDate} onChange={e=>setSowingDate(e.target.value)} style={fieldStyle} onFocus={focusField} onBlur={blurField}/>
            </div>
            <div style={{...groupStyle, marginBottom:'1.75rem'}}>
              <label style={labelStyle}>
                {t.register.deviceId}{' '}
                <span style={{color:'rgba(255,255,255,0.35)',fontSize:'0.75rem',fontWeight:400}}>({t.register.deviceIdOptional})</span>
              </label>
              <input id="reg-device-id" type="text" value={deviceId} onChange={e=>setDeviceId(e.target.value)} placeholder={t.register.deviceIdPlaceholder} style={fieldStyle} onFocus={focusField} onBlur={blurField}/>
            </div>
          </div>
        )}

        {/* ── Buttons ──────────────────────────────────────────────────── */}
        <div style={{display:'flex',gap:'0.75rem'}}>
          {step > 1 && (
            <button onClick={()=>{setError(null);setStep(s=>s-1);}} style={{flex:1,background:'var(--border-very-subtle)',color:'var(--text-primary)',border:'1px solid rgba(255,255,255,0.12)',borderRadius:'9999px',padding:'0.78rem',fontSize:'0.92rem',fontWeight:600,cursor:'pointer'}}>
              {t.register.back}
            </button>
          )}
          {step < 3 ? (
            <button id="reg-next" onClick={handleNext} style={{flex:1,background:'linear-gradient(135deg,#4e8838 0%,#74b438 100%)',color:'var(--text-primary)',border:'none',borderRadius:'9999px',padding:'0.78rem',fontSize:'0.92rem',fontWeight:700,cursor:'pointer',boxShadow:'0 4px 22px rgba(78,136,56,0.38)'}}>
              {t.register.next}
            </button>
          ) : (
            <button id="reg-submit" onClick={handleSubmit} disabled={loading||success} style={{flex:1,background:loading?'rgba(78,136,56,0.45)':'linear-gradient(135deg,#4e8838 0%,#74b438 100%)',color:'var(--text-primary)',border:'none',borderRadius:'9999px',padding:'0.78rem',fontSize:'0.92rem',fontWeight:700,cursor:loading?'not-allowed':'pointer',boxShadow:'0 4px 22px rgba(78,136,56,0.38)',display:'flex',alignItems:'center',justifyContent:'center',gap:'0.5rem'}}>
              {loading && (
                <span style={{
                  display:'inline-block',width:'14px',height:'14px',
                  border:'2px solid rgba(255,255,255,0.3)',borderTopColor:'white',
                  borderRadius:'50%',animation:'marudam-spin 0.6s linear infinite',
                }}/>
              )}
              {loading ? t.register.creatingAccount : t.register.createAccount}
            </button>
          )}
        </div>

        <p style={{textAlign:'center',color:'rgba(255,255,255,0.38)',fontSize:'0.82rem',marginTop:'1.5rem',marginBottom:0}}>
          {t.register.alreadyHaveAccount}{' '}
          <a href="/login" style={{color:'rgba(160,224,80,0.82)',textDecoration:'none',fontWeight:600}}>
            {t.register.signIn}
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
