// =============================================================================
// Marudam — Supabase Browser Client
// =============================================================================
// Uses the publishable key for client-side access.
// Never import the service-role key here.
// =============================================================================
import { createBrowserClient } from '@supabase/ssr';

export function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return false;
  if (url.includes('your-project-id') || key.includes('your-supabase-publishable')) return false;
  return true;
}

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://placeholder.supabase.co',
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'placeholder'
  );
}
