/**
 * Lab partner API client. Talks to the VITAL Hono backend's /lab-partner routes
 * with the stored Bearer token. Throws ApiError with the backend's error envelope.
 */
import type {
  AppNotification,
  ConfirmLabUploadInput,
  LabUpload,
  NotificationTemplate,
  PartnerAppointment,
  PartnerUserDetail,
  ServiceArea,
  User,
} from '@vital/shared';

/**
 * `NEXT_PUBLIC_*` is inlined at build time, so a missing value cannot be fixed
 * without a redeploy. Falling back to localhost in a production bundle makes
 * every request fail as an unexplained network error, so the fallback is
 * development-only and production fails explicitly instead (see `request`).
 */
const BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ??
  (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:3000/api/v1');
const TOKEN_KEY = 'vital_partner_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

interface Opts {
  method?: string;
  body?: unknown;
  auth?: boolean;
  form?: FormData;
}

async function request<T>(path: string, opts: Opts = {}): Promise<T> {
  const { method = 'GET', body, auth = true, form } = opts;
  if (!BASE_URL) {
    throw new ApiError(
      'configuration_error',
      'This app is not configured correctly: NEXT_PUBLIC_API_URL is missing.',
      0,
    );
  }
  const headers: Record<string, string> = {};
  if (!form) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(
      data?.error?.code ?? 'error',
      data?.error?.message ?? 'Request failed',
      res.status,
    );
  }
  return data as T;
}

export interface PartnerProfile {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  area_ids: string[];
  areas: ServiceArea[];
}

/** Slim biomarker option for the review-row selector. */
export interface BiomarkerOption {
  id: string;
  name: string;
  unit: string;
}

export const api = {
  // auth
  login: (email: string, password: string) =>
    request<{ access_token: string; refresh_token: string; user_id: string }>('/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),
  me: () => request<{ user: User }>('/users/me'),

  // partner
  profile: () => request<{ partner: PartnerProfile }>('/lab-partner/me'),
  appointments: (params: { date?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.date) q.set('date', params.date);
    if (params.status) q.set('status', params.status);
    return request<{ appointments: PartnerAppointment[] }>(`/lab-partner/appointments?${q}`);
  },
  userDetail: (userId: string) => request<PartnerUserDetail>(`/lab-partner/users/${userId}`),
  biomarkers: () => request<{ biomarkers: BiomarkerOption[] }>('/lab-partner/biomarkers'),
  uploadLab: (userId: string, file: File, meta: { lab_name?: string; tested_at?: string }) => {
    const form = new FormData();
    form.append('file', file);
    if (meta.lab_name) form.append('lab_name', meta.lab_name);
    if (meta.tested_at) form.append('tested_at', meta.tested_at);
    return request<{ upload: LabUpload }>(`/lab-partner/users/${userId}/lab-uploads`, {
      method: 'POST',
      form,
    });
  },
  labUpload: (id: string) => request<{ upload: LabUpload }>(`/lab-partner/lab-uploads/${id}`),
  confirmLab: (id: string, body: ConfirmLabUploadInput) =>
    request<{ success: boolean; imported: number }>(`/lab-partner/lab-uploads/${id}/confirm`, {
      method: 'POST',
      body,
    }),

  // visit notifications — preset templates the doctor pushes before/while visiting
  notificationTemplates: () =>
    request<{ templates: NotificationTemplate[] }>('/lab-partner/notification-templates'),
  notify: (userId: string, templateId: string) =>
    request<{ success: boolean }>(`/lab-partner/users/${userId}/notify`, {
      method: 'POST',
      body: { template_id: templateId },
    }),

  // partner's own alert feed (booking added / rescheduled / cancelled)
  notifications: () =>
    request<{ notifications: AppNotification[]; unread_count: number }>('/lab-partner/notifications'),
  markNotificationsRead: (ids?: string[]) =>
    request<{ success: boolean }>('/lab-partner/notifications/read', {
      method: 'POST',
      body: { ids },
    }),
};
