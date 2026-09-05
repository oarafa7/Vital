/**
 * Admin API client. Talks to the VITAL Hono backend's /admin routes with the
 * stored Bearer token. Throws ApiError with the backend's error envelope.
 */
import type {
  AdminOverview,
  AdminUpdateUserInput,
  AdminUserDetail,
  AdminUserSummary,
  AiConfig,
  AiConfigInput,
  AiInsight,
  AiUsageStats,
  AdminBooking,
  AppContent,
  AppContentInput,
  AssignPartnerAreasInput,
  CreatePartnerInput,
  LabPartnerSummary,
  AvailabilityOverride,
  AvailabilityOverrideInput,
  AvailabilityWindow,
  AvailabilityWindowInput,
  BroadcastInput,
  Biomarker,
  BiomarkerCategory,
  BiomarkerInput,
  CategoryInput,
  CategoryUpdateInput,
  ConfirmLabUploadInput,
  GrantSubscriptionInput,
  HealthGoalInput,
  HealthGoalOption,
  HealthGoalUpdateInput,
  Intervention,
  InterventionInput,
  InterventionUpdateInput,
  LabUpload,
  NotificationConfig,
  NotificationConfigInput,
  NotificationStats,
  NotificationTemplate,
  NotificationTemplateInput,
  NotificationTemplateUpdateInput,
  PlanInput,
  PlanUpdateInput,
  RecommendedIntervention,
  ServiceArea,
  ServiceAreaInput,
  ServiceAreaUpdateInput,
  Subscription,
  SubscriptionPlan,
  UpdateSubscriptionInput,
  User,
  UserBiomarkerResult,
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
const TOKEN_KEY = 'vital_admin_token';

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

export const api = {
  // auth
  login: (email: string, password: string) =>
    request<{ access_token: string; refresh_token: string; user_id: string }>('/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    }),
  me: () => request<{ user: User }>('/users/me'),

  // overview
  overview: () => request<{ overview: AdminOverview }>('/admin/overview'),

  // users
  users: (params: { search?: string; limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.offset) q.set('offset', String(params.offset));
    return request<{ users: AdminUserSummary[]; total: number }>(`/admin/users?${q}`);
  },
  user: (id: string) => request<AdminUserDetail>(`/admin/users/${id}`),
  updateUser: (id: string, body: AdminUpdateUserInput) =>
    request<{ user: User }>(`/admin/users/${id}`, { method: 'PUT', body }),

  // results
  addResult: (
    userId: string,
    body: { biomarker_id: string; value: number; tested_at: string; lab_name?: string; notes?: string },
  ) => request<{ result: UserBiomarkerResult }>(`/admin/users/${userId}/results`, { method: 'POST', body }),
  deleteResult: (id: string) =>
    request<{ success: boolean }>(`/admin/results/${id}`, { method: 'DELETE' }),

  // lab uploads
  uploadLab: (userId: string, file: File, meta: { lab_name?: string; tested_at?: string }) => {
    const form = new FormData();
    form.append('file', file);
    if (meta.lab_name) form.append('lab_name', meta.lab_name);
    if (meta.tested_at) form.append('tested_at', meta.tested_at);
    return request<{ upload: LabUpload }>(`/admin/users/${userId}/lab-uploads`, {
      method: 'POST',
      form,
    });
  },
  labUpload: (id: string) => request<{ upload: LabUpload }>(`/admin/lab-uploads/${id}`),
  confirmLab: (id: string, body: ConfirmLabUploadInput) =>
    request<{ success: boolean; imported: number }>(`/admin/lab-uploads/${id}/confirm`, {
      method: 'POST',
      body,
    }),
  deleteLab: (id: string) =>
    request<{ success: boolean }>(`/admin/lab-uploads/${id}`, { method: 'DELETE' }),

  // plans
  plans: () => request<{ plans: SubscriptionPlan[] }>('/admin/plans'),
  createPlan: (body: PlanInput) => request<{ plan: SubscriptionPlan }>('/admin/plans', { method: 'POST', body }),
  updatePlan: (id: string, body: PlanUpdateInput) =>
    request<{ plan: SubscriptionPlan }>(`/admin/plans/${id}`, { method: 'PUT', body }),
  deletePlan: (id: string) =>
    request<{ success: boolean }>(`/admin/plans/${id}`, { method: 'DELETE' }),

  // categories
  categories: () => request<{ categories: BiomarkerCategory[] }>('/admin/categories'),
  createCategory: (body: CategoryInput) =>
    request<{ category: BiomarkerCategory }>('/admin/categories', { method: 'POST', body }),
  updateCategory: (id: string, body: CategoryUpdateInput) =>
    request<{ category: BiomarkerCategory }>(`/admin/categories/${id}`, { method: 'PUT', body }),
  deleteCategory: (id: string) =>
    request<{ success: boolean }>(`/admin/categories/${id}`, { method: 'DELETE' }),

  // biomarkers
  biomarkers: (params: { search?: string; category?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.category) q.set('category', params.category);
    return request<{ biomarkers: Biomarker[]; total: number }>(`/admin/biomarkers?${q}`);
  },
  createBiomarker: (body: BiomarkerInput) =>
    request<{ biomarker: Biomarker }>('/admin/biomarkers', { method: 'POST', body }),
  updateBiomarker: (id: string, body: BiomarkerInput) =>
    request<{ biomarker: Biomarker }>(`/admin/biomarkers/${id}`, { method: 'PUT', body }),
  deleteBiomarker: (id: string) =>
    request<{ success: boolean }>(`/admin/biomarkers/${id}`, { method: 'DELETE' }),

  // subscriptions
  grantSubscription: (userId: string, body: GrantSubscriptionInput) =>
    request<{ subscription: Subscription }>(`/admin/users/${userId}/subscription`, {
      method: 'POST',
      body,
    }),
  updateSubscription: (id: string, body: UpdateSubscriptionInput) =>
    request<{ subscription: Subscription }>(`/admin/subscriptions/${id}`, { method: 'PUT', body }),

  // health goals
  goals: () => request<{ goals: HealthGoalOption[] }>('/admin/health-goals'),
  createGoal: (body: HealthGoalInput) =>
    request<{ goal: HealthGoalOption }>('/admin/health-goals', { method: 'POST', body }),
  updateGoal: (id: string, body: HealthGoalUpdateInput) =>
    request<{ goal: HealthGoalOption }>(`/admin/health-goals/${id}`, { method: 'PUT', body }),
  deleteGoal: (id: string) =>
    request<{ success: boolean }>(`/admin/health-goals/${id}`, { method: 'DELETE' }),

  // app content
  content: () => request<{ content: AppContent }>('/admin/app-content'),
  saveContent: (body: AppContentInput) =>
    request<{ content: AppContent }>('/admin/app-content', { method: 'PUT', body }),

  // AI Health Intelligence
  aiConfig: () => request<{ config: AiConfig }>('/admin/ai/config'),
  saveAiConfig: (body: AiConfigInput) =>
    request<{ config: AiConfig }>('/admin/ai/config', { method: 'PUT', body }),
  aiInsights: (params: { status?: string; userId?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.userId) q.set('userId', params.userId);
    return request<{ insights: AiInsight[] }>(`/admin/ai/insights?${q}`);
  },
  publishInsight: (id: string) =>
    request<{ insight: AiInsight }>(`/admin/ai/insights/${id}/publish`, { method: 'POST' }),
  archiveInsight: (id: string) =>
    request<{ insight: AiInsight }>(`/admin/ai/insights/${id}/archive`, { method: 'POST' }),
  deleteInsight: (id: string) =>
    request<{ success: boolean }>(`/admin/ai/insights/${id}`, { method: 'DELETE' }),
  generateUserInsights: (userId: string) =>
    request<{ success: boolean; generated: number; pending_review: boolean }>(
      `/admin/users/${userId}/ai/generate`,
      { method: 'POST' },
    ),
  aiUsage: () => request<{ usage: AiUsageStats }>('/admin/ai/usage'),

  // interventions (supplement / protocol catalog)
  interventions: () => request<{ interventions: Intervention[] }>('/admin/interventions'),
  createIntervention: (body: InterventionInput) =>
    request<{ intervention: Intervention }>('/admin/interventions', { method: 'POST', body }),
  updateIntervention: (id: string, body: InterventionUpdateInput) =>
    request<{ intervention: Intervention }>(`/admin/interventions/${id}`, { method: 'PUT', body }),
  deleteIntervention: (id: string) =>
    request<{ success: boolean }>(`/admin/interventions/${id}`, { method: 'DELETE' }),
  userRecommendations: (userId: string) =>
    request<{ recommendations: RecommendedIntervention[] }>(
      `/admin/users/${userId}/recommendations`,
    ),

  // notifications & engagement
  notificationConfig: () => request<{ config: NotificationConfig }>('/admin/notification-config'),
  saveNotificationConfig: (body: NotificationConfigInput) =>
    request<{ config: NotificationConfig }>('/admin/notification-config', { method: 'PUT', body }),
  broadcast: (body: BroadcastInput) =>
    request<{ success: boolean; sent: number }>('/admin/notifications/broadcast', {
      method: 'POST',
      body,
    }),
  notificationStats: () => request<{ stats: NotificationStats }>('/admin/notifications/stats'),

  // visit-notification templates (presets the visiting doctor pushes to patients)
  notificationTemplates: () =>
    request<{ templates: NotificationTemplate[] }>('/admin/notification-templates'),
  createNotificationTemplate: (body: NotificationTemplateInput) =>
    request<{ template: NotificationTemplate }>('/admin/notification-templates', {
      method: 'POST',
      body,
    }),
  updateNotificationTemplate: (id: string, body: NotificationTemplateUpdateInput) =>
    request<{ template: NotificationTemplate }>(`/admin/notification-templates/${id}`, {
      method: 'PUT',
      body,
    }),
  deleteNotificationTemplate: (id: string) =>
    request<{ success: boolean }>(`/admin/notification-templates/${id}`, { method: 'DELETE' }),

  // test booking — areas, availability, bookings
  areas: () => request<{ areas: ServiceArea[] }>('/admin/areas'),
  createArea: (body: ServiceAreaInput) =>
    request<{ area: ServiceArea }>('/admin/areas', { method: 'POST', body }),
  updateArea: (id: string, body: ServiceAreaUpdateInput) =>
    request<{ area: ServiceArea }>(`/admin/areas/${id}`, { method: 'PUT', body }),
  deleteArea: (id: string) =>
    request<{ success: boolean }>(`/admin/areas/${id}`, { method: 'DELETE' }),
  windows: (areaId: string) =>
    request<{ windows: AvailabilityWindow[] }>(`/admin/areas/${areaId}/windows`),
  createWindow: (areaId: string, body: AvailabilityWindowInput) =>
    request<{ window: AvailabilityWindow }>(`/admin/areas/${areaId}/windows`, {
      method: 'POST',
      body,
    }),
  deleteWindow: (id: string) =>
    request<{ success: boolean }>(`/admin/windows/${id}`, { method: 'DELETE' }),
  overrides: (areaId: string) =>
    request<{ overrides: AvailabilityOverride[] }>(`/admin/areas/${areaId}/overrides`),
  saveOverride: (areaId: string, body: AvailabilityOverrideInput) =>
    request<{ override: AvailabilityOverride }>(`/admin/areas/${areaId}/overrides`, {
      method: 'PUT',
      body,
    }),
  deleteOverride: (id: string) =>
    request<{ success: boolean }>(`/admin/overrides/${id}`, { method: 'DELETE' }),
  bookings: (params: { areaId?: string; date?: string; status?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.areaId) q.set('areaId', params.areaId);
    if (params.date) q.set('date', params.date);
    if (params.status) q.set('status', params.status);
    return request<{ bookings: AdminBooking[] }>(`/admin/bookings?${q}`);
  },

  // lab partners
  partners: () => request<{ partners: LabPartnerSummary[] }>('/admin/partners'),
  createPartner: (body: CreatePartnerInput) =>
    request<{ partner: LabPartnerSummary }>('/admin/partners', { method: 'POST', body }),
  assignPartnerAreas: (id: string, body: AssignPartnerAreasInput) =>
    request<{ success: boolean; area_ids: string[] }>(`/admin/partners/${id}/areas`, {
      method: 'PUT',
      body,
    }),
  deletePartner: (id: string) =>
    request<{ success: boolean }>(`/admin/partners/${id}`, { method: 'DELETE' }),
};
