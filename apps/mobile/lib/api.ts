/**
 * Typed API client for the VITAL backend. Attaches the stored Bearer token,
 * normalises the error envelope into a thrown `ApiError`, and exposes a small
 * surface of typed endpoint helpers.
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
  User,
  UserBiomarkerResult,
  VitalScore,
} from '@vital/shared';

import { getAccessToken } from './auth';

/**
 * `EXPO_PUBLIC_*` is inlined into the bundle at build time, so a missing value
 * cannot be corrected without a rebuild. Falling back to localhost in a release
 * build makes every request fail as an unexplained network error, so the
 * fallback is development-only and a release build without it fails explicitly
 * instead (see `request`).
 */
const BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000/api/v1');

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
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
    throw new ApiError(
      'configuration_error',
      'This app is not configured correctly: EXPO_PUBLIC_API_URL is missing.',
      0,
    );
  }

  const url = new URL(`${BASE_URL}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = await getAccessToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  // Method and path only, development only. Request and response bodies are
  // NEVER logged: they carry the password on /auth/signup and /auth/login, and
  // the access and refresh tokens in those responses.
  if (process.env.NODE_ENV !== 'production') {
    console.log('[VITAL] →', method, path);
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (networkErr) {
    // fetch() rejects on transport failure (unreachable host, DNS, cleartext
    // blocked). This is NOT an ApiError, which is why the UI shows its generic
    // fallback message.
    if (process.env.NODE_ENV !== 'production') {
      console.error('[VITAL] network failure', method, path, networkErr);
    }
    throw networkErr;
  }

  const text = await res.text();
  if (process.env.NODE_ENV !== 'production') {
    console.log('[VITAL] ←', res.status, method, path);
  }
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const env = data as ApiErrorEnvelope | null;
    throw new ApiError(
      env?.error?.code ?? 'server_error',
      env?.error?.message ?? 'Something went wrong',
      res.status,
      env?.error?.details,
    );
  }

  return data as T;
}

// ── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  // The API never returns a success response without a usable session, so both
  // tokens are non-null on a 201. The signup screen still verifies at runtime.
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
  updateHealthProfile: (input: HealthProfileInput) =>
    request<{ user: User }>('/users/me/health-profile', { method: 'PUT', body: input }),
  updateGoals: (input: GoalsInput) =>
    request<{ user: User }>('/users/me/goals', { method: 'PUT', body: input }),
  updateClientInfo: (input: ClientInfoInput) =>
    request<{ user: User }>('/users/me/client-info', { method: 'PUT', body: input }),
};

// ── Test booking ───────────────────────────────────────────────────────────────
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
  cancel: (id: string) =>
    request<{ success: boolean }>(`/bookings/${id}/cancel`, { method: 'POST' }),
};

// ── Subscriptions / payments ──────────────────────────────────────────────────
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

// ── Biomarkers ────────────────────────────────────────────────────────────────
export const biomarkerApi = {
  list: (params?: { category?: string; search?: string; limit?: number; offset?: number }) =>
    request<BiomarkerListResponse>('/biomarkers', { query: params }),
  get: (id: string) => request<{ biomarker: BiomarkerWithResult }>(`/biomarkers/${id}`),
  categories: () =>
    request<{ categories: BiomarkerListResponse['categories'] }>('/biomarker-categories'),
};

// ── Public content ────────────────────────────────────────────────────────────
export const contentApi = {
  get: () => request<{ content: AppContent }>('/app-content', { auth: false }),
  goals: () => request<{ goals: HealthGoalOption[] }>('/health-goals', { auth: false }),
};

// ── VITAL Score ───────────────────────────────────────────────────────────────
export const scoreApi = {
  get: () => request<{ score: VitalScore }>('/score/me'),
  history: () => request<{ history: ScoreHistoryPoint[] }>('/score/me/history'),
};

// ── AI Health Intelligence ─────────────────────────────────────────────────────
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

// ── Recommendations (supplement / protocol guidance) ───────────────────────────
export const recommendationApi = {
  me: () => request<{ recommendations: RecommendedIntervention[] }>('/recommendations/me'),
};

// ── Notifications & engagement ─────────────────────────────────────────────────
export const notificationApi = {
  feed: () =>
    request<{ notifications: AppNotification[]; unread_count: number }>('/notifications/me'),
  markRead: (ids?: string[]) =>
    request<{ success: boolean }>('/notifications/me/read', { method: 'POST', body: { ids } }),
  registerDevice: (token: string, platform: 'ios' | 'android' | 'web') =>
    request<{ success: boolean }>('/devices', { method: 'POST', body: { token, platform } }),
};

// ── Add-ons (extra paid markers at booking checkout) ───────────────────────────
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

// ── Results ───────────────────────────────────────────────────────────────────
export const resultApi = {
  all: () => request<{ results: UserBiomarkerResult[] }>('/results/me'),
  forBiomarker: (biomarkerId: string) =>
    request<{ results: UserBiomarkerResult[] }>(`/results/me/${biomarkerId}`),
  create: (input: CreateResultInput) =>
    request<{ result: UserBiomarkerResult }>('/results', { method: 'POST', body: input }),
  remove: (id: string) => request<{ success: boolean }>(`/results/${id}`, { method: 'DELETE' }),
};
