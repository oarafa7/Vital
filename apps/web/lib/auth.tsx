'use client';

/**
 * Web session management for the VITAL user client.
 *
 * This is the browser equivalent of `apps/mobile/lib/store/auth.ts` +
 * `apps/mobile/lib/auth.ts`, using exactly the same mechanism: the API issues a
 * Supabase access token via /auth/login (or /auth/signup), we persist it, and
 * we send it as `Authorization: Bearer` on every request. The web app holds no
 * Supabase credential of its own and never talks to the database directly.
 *
 * It also caches the user's subscription, because nearly every data route in
 * the API sits behind `requireActiveSubscription` — pages need to know whether
 * to render data or the locked state.
 */
import type { SubscriptionWithPlan, User } from '@vital/shared';
import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  ApiError,
  authApi,
  clearSession,
  getToken,
  setSession,
  setUnauthorizedHandler,
  subscriptionApi,
  userApi,
} from './api';

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthState {
  user: User | null;
  status: AuthStatus;
  subscription: SubscriptionWithPlan | null;
  subscriptionLoaded: boolean;
  /** True when the user may access the subscription-gated parts of the API. */
  hasActiveSubscription: boolean;
  login: (email: string, password: string) => Promise<void>;
  /**
   * Creates the account and signs in. Resolves only once a complete session is
   * held; any other outcome rejects with an `ApiError` for the caller to show.
   * There is no "created but signed out" state — the API cannot return one.
   */
  signup: (input: {
    full_name: string;
    email: string;
    password: string;
    phone: string;
    accepted_terms: true;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  refreshSubscription: () => Promise<void>;
  /** Replaces the cached user after a profile mutation. */
  setUser: (user: User) => void;
}

const AuthContext = createContext<AuthState | null>(null);

function isActive(sub: SubscriptionWithPlan | null): boolean {
  return !!sub && sub.status === 'active' && new Date(sub.expires_at) > new Date();
}

/**
 * Supabase delivers the result of a password-reset (or any email link) as a URL
 * *fragment* on the project's configured Site URL, e.g.
 *
 *   <site-url>/#access_token=…&refresh_token=…&type=recovery
 *   <site-url>/#error=access_denied&error_description=Email+link+…
 *
 * The fragment never reaches the server, so it has to be read here on mount.
 * Without this the tokens are silently discarded and a user who just followed a
 * reset link is bounced to /login as if nothing happened.
 *
 * Signup no longer relies on this path — accounts are created confirmed and get
 * a session directly. It still matters for password reset, which means the
 * project's Site URL must be the deployed web origin; if it is still a
 * localhost value, reset links are useless in production. See
 * AUTH_ARCHITECTURE.md → "Supabase URL configuration".
 */
function readAuthFragment(): { accessToken?: string; refreshToken?: string; error?: string } | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (hash.length < 2) return null;

  const params = new URLSearchParams(hash.slice(1));
  const accessToken = params.get('access_token');
  const error = params.get('error_description') ?? params.get('error');
  if (!accessToken && !error) return null;

  return {
    accessToken: accessToken ?? undefined,
    refreshToken: params.get('refresh_token') ?? undefined,
    error: error ?? undefined,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUserState] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [subscription, setSubscription] = useState<SubscriptionWithPlan | null>(null);
  const [subscriptionLoaded, setSubscriptionLoaded] = useState(false);
  const hydrated = useRef(false);

  const resetLocal = useCallback(() => {
    setUserState(null);
    setSubscription(null);
    setSubscriptionLoaded(false);
    setStatus('unauthenticated');
  }, []);

  // A 401 anywhere in the app means the token is dead — drop to /login.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      resetLocal();
      router.replace('/login');
    });
    return () => setUnauthorizedHandler(null);
  }, [resetLocal, router]);

  const loadSubscription = useCallback(async () => {
    try {
      const { subscription: sub } = await subscriptionApi.mine();
      setSubscription(sub);
    } catch {
      // A failure here must not lock the user out of the app; it only means we
      // can't confirm a subscription, which the gated pages surface themselves.
      setSubscription(null);
    } finally {
      setSubscriptionLoaded(true);
    }
  }, []);

  // Restore the session on first mount (the "stay logged in" behaviour), after
  // adopting any session Supabase handed back via the email-confirmation
  // redirect.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;

    const fragment = readAuthFragment();
    if (fragment) {
      // Strip the tokens from the address bar before anything else, so they
      // don't linger in history or get copied out of the URL.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);

      if (fragment.accessToken) {
        setSession(fragment.accessToken, fragment.refreshToken ?? null);
      } else if (process.env.NODE_ENV !== 'production') {
        // Expired or already-used confirmation link. Falling through leaves the
        // user on /login, which is where they need to be anyway.
        console.error('[VITAL] email confirmation failed:', fragment.error);
      }
    }

    const token = getToken();
    if (!token) {
      setStatus('unauthenticated');
      return;
    }
    (async () => {
      try {
        const { user: me } = await userApi.me();
        setUserState(me);
        setStatus('authenticated');
        void loadSubscription();
      } catch {
        clearSession();
        resetLocal();
      }
    })();
  }, [loadSubscription, resetLocal]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await authApi.login({ email, password });
      setSession(res.access_token, res.refresh_token);
      const { user: me } = await userApi.me();
      setUserState(me);
      setStatus('authenticated');
      void loadSubscription();
    },
    [loadSubscription],
  );

  const signup = useCallback<AuthState['signup']>(
    async (input) => {
      const res = await authApi.signup(input);

      // Defence in depth. The API guarantees a 201 carries both tokens, so
      // this cannot fire — but onboarding without a session means every
      // request 401s, which is exactly the loop this system used to produce.
      if (!res.access_token || !res.refresh_token) {
        throw new ApiError(
          'incomplete_session',
          'Your account was created, but we could not sign you in. Please sign in.',
          500,
          'server',
        );
      }

      setSession(res.access_token, res.refresh_token);
      setUserState(res.user);
      setStatus('authenticated');
      void loadSubscription();
    },
    [loadSubscription],
  );

  const logout = useCallback(async () => {
    await authApi.logout().catch(() => undefined);
    clearSession();
    resetLocal();
    router.replace('/login');
  }, [resetLocal, router]);

  const refreshUser = useCallback(async () => {
    try {
      const { user: me } = await userApi.me();
      setUserState(me);
    } catch (err) {
      // Keep the stale user on transient errors, exactly as mobile does.
      if (err instanceof ApiError && err.kind === 'auth') resetLocal();
    }
  }, [resetLocal]);

  const value = useMemo<AuthState>(
    () => ({
      user,
      status,
      subscription,
      subscriptionLoaded,
      hasActiveSubscription: isActive(subscription),
      login,
      signup,
      logout,
      refreshUser,
      refreshSubscription: loadSubscription,
      setUser: setUserState,
    }),
    [user, status, subscription, subscriptionLoaded, login, signup, logout, refreshUser, loadSubscription],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
