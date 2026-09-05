/**
 * Typed API client for the VITAL backend.
 *
 * Mirrors `apps/mobile/lib/api.ts` endpoint-for-endpoint so the web client and
 * the mobile app share one contract. All business logic stays in the API —
 * this file only transports.
 *
 * Error handling differs deliberately from mobile: transport failures are
 * distinguished from HTTP error envelopes (see `ApiError.kind`), so the UI can
 * say "can't reach the server" instead of a generic fallback.
 */
import type {
  AddonMarker,
  AddonOrder,
  AiChatMessage,
  AiInsight,
  AiStatus,
  ApiError as ApiErrorEnvelope,
  AppContent,
  AppNotification,
  BiomarkerListResponse,
  BiomarkerWithResult,
  Booking,
  ClientInfoInput,
  CreateBookingInput,
  CreateResultInput,
  DayAvailability,
  GoalsInput,
  HealthGoalOption,
  HealthProfileInput,
  LoginInput,
  RecommendedIntervention,
  ScoreHistoryPoint,
  ServiceArea,
  SignupInput,
  SubscriptionPlan,
  SubscriptionWithPlan,
  UpdateUserInput,
  User,
  UserBiomarkerResult,
  VitalScore,
} from '@vital/shared';

/**
 * Base URL of the VITAL API.
 *
 * `NEXT_PUBLIC_*` values are inlined into the bundle at build time, so a
 * missing one cannot be corrected without a redeploy. Silently falling back to
 * localhost in a production build is the worst outcome: every request fails
 * with "could not reach the server" and nothing says why. The fallback is
 * therefore development-only, and a production build with no API URL fails
 * loudly and specifically on the first request instead.
 */
const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000/api/v1');

const ACCESS_KEY = 'vital.web.access_token';
const REFRESH_KEY = 'vital.web.refresh_token';

// ── Token persistence ────────────────────────────────────────────────────────
// The mobile app stores tokens in expo-secure-store. The browser equivalent is
// localStorage: the token is a short-lived Supabase JWT issued by our API, and
// the web client never holds any privileged Supabase credential.

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(ACCESS_KEY);
}

export function setSession(accessToken: string, refreshToken?: string | null) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACCESS_KEY, accessToken);
  if (refreshToken) window.localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearSession() {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACCESS_KEY);
  window.localStorage.removeItem(REFRESH_KEY);
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * What went wrong, at a granularity the UI can act on.
 * - `validation`   → the payload was rejected; show field-level detail
 * - `auth`         → not signed in / token expired; bounce to /login
 * - `forbidden`    → signed in but not allowed (usually: no active subscription)
 * - `not_found`    → the resource is gone
 * - `conflict`     → duplicate (e.g. email already registered)
 * - `network`      → the request never reached the API
 * - `server`       → the API failed
 */
export type ApiErrorKind =
  | 'validation'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'network'
  | 'server';

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public kind: ApiErrorKind,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the failure means "you don't have an active subscription". */
  get isSubscriptionGate() {
    return this.kind === 'forbidden' && /subscription/i.test(this.message);
  }
}

function kindFor(status: number, code: string): ApiErrorKind {
  if (status === 0) return 'network';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409 || code === 'conflict') return 'conflict';
  if (status === 400 || status === 422) return 'validation';
  return 'server';
}

/** Called when the API rejects our token, so the app can drop to /login. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  auth?: boolean; // default true
  query?: Record<string, string | number | undefined>;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, query } = opts;

  if (!BASE_URL) {
    // Production build with NEXT_PUBLIC_API_URL unset. Say so precisely rather
    // than letting an invalid URL surface as a generic network failure.
    throw new ApiError(
      'configuration_error',
      'This app is not configured correctly: the API address is missing. Please contact support.',
      0,
      'server',
    );
  }

  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Track whether we actually presented credentials: a 401 only means "your
  // session is dead" if we sent a token. A 401 from an endpoint we called
  // anonymously says nothing about our session and must not sign the user out.
  let sentToken = false;
  if (auth) {
    const token = getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      sentToken = true;
    }
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    // fetch() rejects only on transport failure (server down, DNS, CORS,
    // offline). Technical detail stays in the console; the user gets plain
    // language.
    if (process.env.NODE_ENV !== 'production') {
      console.error('[VITAL] network failure', method, url.toString(), networkErr);
    }
    throw new ApiError(
      'network_error',
      'Could not reach the VITAL server. Check your connection and try again.',
      0,
      'network',
    );
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // A non-JSON body from a proxy or crash page.
      if (!res.ok) {
        throw new ApiError('bad_response', 'The server returned an unreadable response.', res.status, 'server');
      }
    }
  }

  if (!res.ok) {
    const env = data as ApiErrorEnvelope | null;
    const code = env?.error?.code ?? 'server_error';
    const message = env?.error?.message ?? 'Something went wrong. Please try again.';
    const kind = kindFor(res.status, code);

    if (process.env.NODE_ENV !== 'production') {
      console.error('[VITAL] api error', res.status, code, message, env?.error?.details);
    }

    if (kind === 'auth' && sentToken) {
      clearSession();
      onUnauthorized?.();
    }
    throw new ApiError(code, message, res.status, kind, env?.error?.details);
  }

  return data as T;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  // The API never returns a success response without a usable session, so both
  // tokens are non-null on a 201. `lib/auth.tsx` still verifies that at runtime.
  signup: (input: SignupInput) =>
    request<{ user: User; access_token: string; refresh_token: string }>('/auth/signup', {
      method: 'POST',
      body: input,
      auth: false,
    }),
  login: (input: LoginInput) =>
    request<{ user: User; access_token: string; refresh_token: string; user_id: string }>(
      '/auth/login',
      { method: 'POST', body: input, auth: false },
    ),
  logout: () => request<{ success: boolean }>('/auth/logout', { method: 'POST' }),
  resetPassword: (email: string) =>
    request<{ success: boolean }>('/auth/reset-password', {
      method: 'POST',
      body: { email },
      auth: false,
    }),
};

// ── Users ────────────────────────────────────────────────────────────────────
export const userApi = {
  me: () => request<{ user: User }>('/users/me'),
  update: (input: UpdateUserInput) => request<{ user: User }>('/users/me', { method: 'PUT', body: input }),
  updateHealthProfile: (input: HealthProfileInput) =>
    request<{ user: User }>('/users/me/health-profile', { method: 'PUT', body: input }),
  updateGoals: (input: GoalsInput) =>
    request<{ user: User }>('/users/me/goals', { method: 'PUT', body: input }),
  updateClientInfo: (input: ClientInfoInput) =>
    request<{ user: User }>('/users/me/client-info', { method: 'PUT', body: input }),
};

// ── Test booking ─────────────────────────────────────────────────────────────
export const bookingApi = {
  areas: () => request<{ areas: ServiceArea[] }>('/areas'),
  availability: (areaId: string, from: string, days = 14) =>
    request<{ availability: DayAvailability[] }>(
      `/areas/${areaId}/availability?from=${from}&days=${days}`,
    ),
  mine: () => request<{ bookings: Booking[] }>('/bookings/me'),
  book: (input: CreateBookingInput) =>
    request<{ booking: Booking }>('/bookings', { method: 'POST', body: input }),
  reschedule: (id: string, input: CreateBookingInput) =>
    request<{ booking: Booking }>(`/bookings/${id}`, { method: 'PUT', body: input }),
  cancel: (id: string) => request<{ success: boolean }>(`/bookings/${id}/cancel`, { method: 'POST' }),
};

// ── Subscriptions / payments ─────────────────────────────────────────────────
export const subscriptionApi = {
  plans: () => request<{ plans: SubscriptionPlan[] }>('/subscription-plans', { auth: false }),
  mine: () => request<{ subscription: SubscriptionWithPlan | null }>('/subscriptions/me'),
  initiatePayment: (planId: string) =>
    request<{
      payment_key: string;
      iframe_url: string;
      order_id: string;
      subscription_id: string;
      amount_egp: number;
    }>('/payments/initiate', { method: 'POST', body: { plan_id: planId } }),
};

// ── Biomarkers ───────────────────────────────────────────────────────────────
export const biomarkerApi = {
  list: (params?: { category?: string; search?: string; limit?: number; offset?: number }) =>
    request<BiomarkerListResponse>('/biomarkers', { query: params }),
  get: (id: string) => request<{ biomarker: BiomarkerWithResult }>(`/biomarkers/${id}`),
  categories: () =>
    request<{ categories: BiomarkerListResponse['categories'] }>('/biomarker-categories'),
};

// ── Public content ───────────────────────────────────────────────────────────
export const contentApi = {
  get: () => request<{ content: AppContent }>('/app-content', { auth: false }),
  goals: () => request<{ goals: HealthGoalOption[] }>('/health-goals', { auth: false }),
};

// ── VITAL Score ──────────────────────────────────────────────────────────────
export const scoreApi = {
  get: () => request<{ score: VitalScore }>('/score/me'),
  history: () => request<{ history: ScoreHistoryPoint[] }>('/score/me/history'),
};

// ── AI Health Intelligence ───────────────────────────────────────────────────
export const aiApi = {
  status: () => request<{ status: AiStatus }>('/ai-status', { auth: false }),
  insights: () => request<{ insights: AiInsight[] }>('/ai/insights/me'),
  generate: () =>
    request<{ success: boolean; generated: number; pending_review: boolean }>(
      '/ai/insights/me/generate',
      { method: 'POST' },
    ),
  chatHistory: () => request<{ messages: AiChatMessage[] }>('/ai/chat/me'),
  sendChat: (message: string) =>
    request<{ reply: string }>('/ai/chat/me', { method: 'POST', body: { message } }),
};

// ── Recommendations ──────────────────────────────────────────────────────────
export const recommendationApi = {
  me: () => request<{ recommendations: RecommendedIntervention[] }>('/recommendations/me'),
};

// ── Notifications ────────────────────────────────────────────────────────────
export const notificationApi = {
  feed: () =>
    request<{ notifications: AppNotification[]; unread_count: number }>('/notifications/me'),
  markRead: (ids?: string[]) =>
    request<{ success: boolean }>('/notifications/me/read', { method: 'POST', body: { ids } }),
};

// ── Add-ons ──────────────────────────────────────────────────────────────────
export const addonApi = {
  list: () => request<{ addons: AddonMarker[] }>('/addons'),
  initiatePayment: (bookingId: string, biomarkerIds: string[]) =>
    request<{
      payment_key: string;
      iframe_url: string;
      order_id: string;
      order: AddonOrder;
      amount_egp: number;
    }>('/payments/addons/initiate', {
      method: 'POST',
      body: { booking_id: bookingId, biomarker_ids: biomarkerIds },
    }),
};

// ── Results ──────────────────────────────────────────────────────────────────
export const resultApi = {
  all: () => request<{ results: UserBiomarkerResult[] }>('/results/me'),
  forBiomarker: (biomarkerId: string) =>
    request<{ results: UserBiomarkerResult[] }>(`/results/me/${biomarkerId}`),
  create: (input: CreateResultInput) =>
    request<{ result: UserBiomarkerResult }>('/results', { method: 'POST', body: input }),
  remove: (id: string) => request<{ success: boolean }>(`/results/${id}`, { method: 'DELETE' }),
};
