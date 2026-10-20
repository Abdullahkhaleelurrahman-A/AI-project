// =============================================================================
// Marudam — Next.js Proxy (replaces deprecated middleware.ts in Next.js 16)
// =============================================================================
// 1. Refreshes the Supabase session cookie on every request.
// 2. Protects authenticated routes — redirects unauthenticated users to /login.
// 3. Redirects already-authenticated users away from /login and /register.
// =============================================================================
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Routes that require authentication.
const PROTECTED_ROUTES = [
  '/dashboard',
  '/sensors',
  '/farm',
  '/ai',
  '/alerts',
  '/history',
  '/settings',
  '/help',
];

// Routes that are only for unauthenticated users (redirect to dashboard if logged in).
const AUTH_ROUTES = ['/login', '/register', '/forgot-password'];

function isProtectedRoute(pathname: string): boolean {
  return PROTECTED_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + '/')
  );
}

function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + '/')
  );
}

function isSupabaseConfigured(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return false;
  if (url.includes('your-project-id') || key.includes('your-supabase-publishable')) return false;
  return true;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── If Supabase is not configured, block protected routes ──────────────
  if (!isSupabaseConfigured()) {
    if (isProtectedRoute(pathname)) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.next({ request });
  }

  // ── Supabase is configured: refresh session & enforce auth ─────────────
  let supabaseResponse = NextResponse.next({ request });

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value)
            );
            supabaseResponse = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options)
            );
          },
        },
      }
    );

    // Refresh session — do NOT remove this.
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // ── Redirect unauthenticated users away from protected routes ──────────
    if (!user && isProtectedRoute(pathname)) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      // Preserve the originally requested URL so we can redirect back after login
      loginUrl.searchParams.set('next', pathname);
      const redirectResponse = NextResponse.redirect(loginUrl);
      supabaseResponse.cookies.getAll().forEach((c) => {
        redirectResponse.cookies.set(c.name, c.value);
      });
      return redirectResponse;
    }

    // ── Redirect authenticated users away from login/register ──────────────
    if (user && isAuthRoute(pathname)) {
      const dashboardUrl = request.nextUrl.clone();
      dashboardUrl.pathname = '/dashboard';
      const redirectResponse = NextResponse.redirect(dashboardUrl);
      supabaseResponse.cookies.getAll().forEach((c) => {
        redirectResponse.cookies.set(c.name, c.value);
      });
      return redirectResponse;
    }
  } catch {
    if (isProtectedRoute(pathname)) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = '/login';
      loginUrl.searchParams.set('next', pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
