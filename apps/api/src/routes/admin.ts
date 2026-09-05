/**
 * Admin dashboard API. All routes require an authenticated user whose role is
 * 'admin'. Mounted at /api/v1/admin.
 *
 * Modules: overview analytics · users + lab results · plans & pricing ·
 * biomarkers & categories.
 */
import {
  type AdminOverview,
  type AdminUserDetail,
  type AdminUserSummary,
  adminCreateResultSchema,
  adminUpdateUserSchema,
  aiConfigSchema,
  appContentSchema,
  assignPartnerAreasSchema,
  availabilityOverrideInputSchema,
  availabilityWindowInputSchema,
  biomarkerInputSchema,
  createPartnerSchema,
  categoryInputSchema,
  categoryUpdateSchema,
  confirmLabUploadSchema,
  grantSubscriptionSchema,
  healthGoalInputSchema,
  healthGoalUpdateSchema,
  broadcastSchema,
  interventionInputSchema,
  interventionUpdateSchema,
  notificationConfigSchema,
  notificationTemplateInputSchema,
  notificationTemplateUpdateSchema,
  planInputSchema,
  planUpdateSchema,
  serviceAreaInputSchema,
  serviceAreaUpdateSchema,
  updateSubscriptionSchema,
} from '@vital/shared';
import { and, asc, desc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client.js';
import {
  aiChatMessages,
  aiInsights,
  availabilityOverrides,
  availabilityWindows,
  biomarkerCategories,
  biomarkers,
  bookings,
  deviceTokens,
  healthGoals,
  interventions,
  labPartnerAreas,
  labUploads,
  notificationTemplates,
  notifications,
  serviceAreas,
  subscriptionPlans,
  subscriptions,
  userBiomarkerResults,
  users,
} from '../db/schema.js';
import { generateAndStoreInsights } from '../lib/ai.js';
import { getAiConfig, setAiConfig } from '../lib/ai-config.js';
import { getAppContent, setAppContent } from '../lib/content.js';
import { getNotificationConfig, setNotificationConfig } from '../lib/notification-config.js';
import { confirmUpload, parseAndStoreUpload } from '../lib/lab-upload.js';
import { generateUserNotifications } from '../lib/notifications.js';
import { computeUserRecommendations } from '../lib/recommendations.js';
import { provisionDeps } from '../lib/provisioning-ports.js';
import { coerceRole, provisionManagedAccount } from '../lib/provisioning.js';
import { errorResponse } from '../lib/http.js';
import { computeUserScore, recordScoreSnapshot } from '../lib/score.js';
import { supabaseAdmin } from '../lib/supabase.js';
import {
  serializeAiInsight,
  serializeArea,
  serializeBiomarker,
  serializeBooking,
  serializeCategory,
  serializeIntervention,
  serializeHealthGoal,
  serializeLabUpload,
  serializeNotificationTemplate,
  serializeOverride,
  serializePlan,
  serializeResult,
  serializeSubscription,
  serializeUser,
  serializeWindow,
} from '../lib/serialize.js';
import { signLabFile } from '../lib/storage.js';
import { type AuthVariables, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { validate } from '../middleware/validate.js';

export const adminRoutes = new Hono<{ Variables: AuthVariables }>();

adminRoutes.use('*', requireAuth, requireAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// Overview analytics
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/overview', async (c) => {
  const [usersTotal] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  const [adminsTotal] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(eq(users.role, 'admin'));
  const [resultsTotal] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userBiomarkerResults);
  const [uploadsTotal] = await db.select({ n: sql<number>`count(*)::int` }).from(labUploads);
  const [pendingUploads] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(labUploads)
    .where(eq(labUploads.status, 'parsed'));

  // Active subscriptions + revenue from their plans.
  const activeRows = await db
    .select({ priceEgp: subscriptionPlans.priceEgp, planName: subscriptionPlans.name })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptions.planId, subscriptionPlans.id))
    .where(and(eq(subscriptions.status, 'active'), gt(subscriptions.expiresAt, new Date())));

  const revenue = activeRows.reduce((sum, r) => sum + r.priceEgp, 0);
  const planCounts = activeRows.reduce<Record<string, number>>((acc, r) => {
    acc[r.planName] = (acc[r.planName] ?? 0) + 1;
    return acc;
  }, {});

  const overview: AdminOverview = {
    users_total: usersTotal?.n ?? 0,
    admins_total: adminsTotal?.n ?? 0,
    active_subscriptions: activeRows.length,
    revenue_egp: revenue,
    results_total: resultsTotal?.n ?? 0,
    lab_uploads_total: uploadsTotal?.n ?? 0,
    pending_uploads: pendingUploads?.n ?? 0,
    plan_breakdown: Object.entries(planCounts).map(([plan, count]) => ({
      plan: plan as AdminOverview['plan_breakdown'][number]['plan'],
      count,
    })),
  };

  return c.json({ overview });
});

// ─────────────────────────────────────────────────────────────────────────────
// Users
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/users', async (c) => {
  const search = c.req.query('search')?.trim();
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);

  const where = search
    ? or(ilike(users.email, `%${search}%`), ilike(users.fullName, `%${search}%`))
    : undefined;

  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(users)
    .where(where);

  const rows = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);

  const ids = rows.map((r) => r.id);

  // Active subscription (+plan) and result counts for this page of users.
  const subs = ids.length
    ? await db
        .select({
          userId: subscriptions.userId,
          status: subscriptions.status,
          planName: subscriptionPlans.name,
        })
        .from(subscriptions)
        .innerJoin(subscriptionPlans, eq(subscriptions.planId, subscriptionPlans.id))
        .where(
          and(
            inArray(subscriptions.userId, ids),
            eq(subscriptions.status, 'active'),
            gt(subscriptions.expiresAt, new Date()),
          ),
        )
    : [];
  const subByUser = new Map(subs.map((s) => [s.userId, s]));

  const counts = ids.length
    ? await db
        .select({
          userId: userBiomarkerResults.userId,
          n: sql<number>`count(*)::int`,
        })
        .from(userBiomarkerResults)
        .where(inArray(userBiomarkerResults.userId, ids))
        .groupBy(userBiomarkerResults.userId)
    : [];
  const countByUser = new Map(counts.map((r) => [r.userId, r.n]));

  const list: AdminUserSummary[] = rows.map((u) => {
    const sub = subByUser.get(u.id);
    return {
      id: u.id,
      email: u.email,
      full_name: u.fullName,
      role: coerceRole(u.role),
      phone: u.phone,
      subscription_status: (sub?.status as AdminUserSummary['subscription_status']) ?? null,
      plan_name: (sub?.planName as AdminUserSummary['plan_name']) ?? null,
      result_count: countByUser.get(u.id) ?? 0,
      created_at: u.createdAt.toISOString(),
    };
  });

  return c.json({ users: list, total });
});

adminRoutes.get('/users/:id', async (c) => {
  const id = c.req.param('id');
  const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!user) return errorResponse(c, 'not_found', 'User not found');

  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.userId, id))
    .orderBy(desc(subscriptions.startedAt))
    .limit(1);

  let subscriptionPayload: AdminUserDetail['subscription'] = null;
  if (sub) {
    const [plan] = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, sub.planId))
      .limit(1);
    if (plan) {
      subscriptionPayload = { ...serializeSubscription(sub), plan: serializePlan(plan) };
    }
  }

  const results = await db
    .select()
    .from(userBiomarkerResults)
    .where(eq(userBiomarkerResults.userId, id))
    .orderBy(desc(userBiomarkerResults.testedAt));

  const uploads = await db
    .select()
    .from(labUploads)
    .where(eq(labUploads.userId, id))
    .orderBy(desc(labUploads.createdAt));

  const score = results.length > 0 ? await computeUserScore(id) : null;

  const detail: AdminUserDetail = {
    user: serializeUser(user),
    subscription: subscriptionPayload,
    results: results.map(serializeResult),
    lab_uploads: uploads.map(serializeLabUpload),
    score,
  };

  return c.json(detail);
});

adminRoutes.put('/users/:id', validate('json', adminUpdateUserSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const [row] = await db
    .update(users)
    .set({
      ...(body.full_name !== undefined ? { fullName: body.full_name } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
      updatedAt: new Date(),
    })
    .where(eq(users.id, id))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'User not found');
  return c.json({ user: serializeUser(row) });
});

adminRoutes.post('/users/:id/results', validate('json', adminCreateResultSchema), async (c) => {
  const userId = c.req.param('id');
  const body = c.req.valid('json');

  const [bm] = await db
    .select()
    .from(biomarkers)
    .where(eq(biomarkers.id, body.biomarker_id))
    .limit(1);
  if (!bm) return errorResponse(c, 'not_found', 'Biomarker not found');

  const [row] = await db
    .insert(userBiomarkerResults)
    .values({
      userId,
      biomarkerId: body.biomarker_id,
      value: String(body.value),
      testedAt: body.tested_at,
      labName: body.lab_name ?? null,
      notes: body.notes ?? null,
      source: 'admin',
    })
    .returning();

  await recordScoreSnapshot(userId);

  return c.json({ result: serializeResult(row!) }, 201);
});

adminRoutes.delete('/results/:id', async (c) => {
  const id = c.req.param('id');
  const [deleted] = await db
    .delete(userBiomarkerResults)
    .where(eq(userBiomarkerResults.id, id))
    .returning();
  if (!deleted) return errorResponse(c, 'not_found', 'Result not found');
  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lab uploads (PDF → parse → review → confirm)
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.post('/users/:id/lab-uploads', async (c) => {
  const userId = c.req.param('id');
  const admin = c.get('user');

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return errorResponse(c, 'not_found', 'User not found');

  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) {
    return errorResponse(c, 'validation_error', 'Attach a PDF file under the "file" field');
  }

  const labName = typeof body['lab_name'] === 'string' ? (body['lab_name'] as string) : null;
  const testedAt = typeof body['tested_at'] === 'string' ? (body['tested_at'] as string) : null;

  const payload = await parseAndStoreUpload({
    userId,
    file,
    labName,
    testedAt,
    uploadedById: admin.id,
  });
  return c.json({ upload: payload }, 201);
});

adminRoutes.get('/lab-uploads/:id', async (c) => {
  const id = c.req.param('id');
  const [row] = await db.select().from(labUploads).where(eq(labUploads.id, id)).limit(1);
  if (!row) return errorResponse(c, 'not_found', 'Upload not found');
  const payload = serializeLabUpload(row);
  payload.file_url = (await signLabFile(row.filePath)) ?? undefined;
  return c.json({ upload: payload });
});

adminRoutes.post(
  '/lab-uploads/:id/confirm',
  validate('json', confirmLabUploadSchema),
  async (c) => {
    const { imported } = await confirmUpload(c.req.param('id'), c.req.valid('json'));
    return c.json({ success: true, imported });
  },
);

adminRoutes.delete('/lab-uploads/:id', async (c) => {
  const id = c.req.param('id');
  const [deleted] = await db.delete(labUploads).where(eq(labUploads.id, id)).returning();
  if (!deleted) return errorResponse(c, 'not_found', 'Upload not found');
  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Plans & pricing
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/plans', async (c) => {
  const rows = await db.select().from(subscriptionPlans).orderBy(asc(subscriptionPlans.priceEgp));
  return c.json({ plans: rows.map(serializePlan) });
});

adminRoutes.post('/plans', validate('json', planInputSchema), async (c) => {
  const body = c.req.valid('json');
  const [row] = await db
    .insert(subscriptionPlans)
    .values({
      name: body.name,
      priceEgp: body.price_egp,
      priceDisplay: body.price_display,
      annualTestsCount: body.annual_tests_count,
      biomarkerCount: body.biomarker_count,
      features: body.features,
      isActive: body.is_active ?? true,
    })
    .returning();
  return c.json({ plan: serializePlan(row!) }, 201);
});

adminRoutes.put('/plans/:id', validate('json', planUpdateSchema), async (c) => {
  const id = c.req.param('id');
  const b = c.req.valid('json');
  const [row] = await db
    .update(subscriptionPlans)
    .set({
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.price_egp !== undefined ? { priceEgp: b.price_egp } : {}),
      ...(b.price_display !== undefined ? { priceDisplay: b.price_display } : {}),
      ...(b.annual_tests_count !== undefined ? { annualTestsCount: b.annual_tests_count } : {}),
      ...(b.biomarker_count !== undefined ? { biomarkerCount: b.biomarker_count } : {}),
      ...(b.features !== undefined ? { features: b.features } : {}),
      ...(b.is_active !== undefined ? { isActive: b.is_active } : {}),
    })
    .where(eq(subscriptionPlans.id, id))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'Plan not found');
  return c.json({ plan: serializePlan(row) });
});

adminRoutes.delete('/plans/:id', async (c) => {
  // Soft-deactivate to preserve historical subscriptions referencing the plan.
  const id = c.req.param('id');
  const [row] = await db
    .update(subscriptionPlans)
    .set({ isActive: false })
    .where(eq(subscriptionPlans.id, id))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'Plan not found');
  return c.json({ success: true, plan: serializePlan(row) });
});

// ─────────────────────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/categories', async (c) => {
  const rows = await db
    .select()
    .from(biomarkerCategories)
    .orderBy(asc(biomarkerCategories.displayOrder));
  return c.json({ categories: rows.map(serializeCategory) });
});

adminRoutes.post('/categories', validate('json', categoryInputSchema), async (c) => {
  const b = c.req.valid('json');
  const [row] = await db
    .insert(biomarkerCategories)
    .values({
      name: b.name,
      slug: b.slug,
      description: b.description ?? '',
      icon: b.icon ?? '',
      color: b.color,
      displayOrder: b.display_order ?? 0,
    })
    .returning();
  return c.json({ category: serializeCategory(row!) }, 201);
});

adminRoutes.put('/categories/:id', validate('json', categoryUpdateSchema), async (c) => {
  const id = c.req.param('id');
  const b = c.req.valid('json');
  const [row] = await db
    .update(biomarkerCategories)
    .set({
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.slug !== undefined ? { slug: b.slug } : {}),
      ...(b.description !== undefined ? { description: b.description } : {}),
      ...(b.icon !== undefined ? { icon: b.icon } : {}),
      ...(b.color !== undefined ? { color: b.color } : {}),
      ...(b.display_order !== undefined ? { displayOrder: b.display_order } : {}),
    })
    .where(eq(biomarkerCategories.id, id))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'Category not found');
  return c.json({ category: serializeCategory(row) });
});

adminRoutes.delete('/categories/:id', async (c) => {
  const id = c.req.param('id');
  const [child] = await db
    .select({ id: biomarkers.id })
    .from(biomarkers)
    .where(eq(biomarkers.categoryId, id))
    .limit(1);
  if (child) {
    return errorResponse(c, 'conflict', 'Reassign or remove this category’s biomarkers first');
  }
  const [deleted] = await db
    .delete(biomarkerCategories)
    .where(eq(biomarkerCategories.id, id))
    .returning();
  if (!deleted) return errorResponse(c, 'not_found', 'Category not found');
  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Biomarkers
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/biomarkers', async (c) => {
  const search = c.req.query('search')?.trim().toLowerCase();
  const category = c.req.query('category');

  const conditions = [] as ReturnType<typeof eq>[];
  if (category && category !== 'all') {
    const [cat] = await db
      .select({ id: biomarkerCategories.id })
      .from(biomarkerCategories)
      .where(eq(biomarkerCategories.slug, category))
      .limit(1);
    if (cat) conditions.push(eq(biomarkers.categoryId, cat.id));
  }

  const rows = await db
    .select()
    .from(biomarkers)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(biomarkers.displayOrder), asc(biomarkers.name));

  const filtered = search
    ? rows.filter(
        (b) =>
          b.name.toLowerCase().includes(search) ||
          (b.tags ?? []).some((t) => t.toLowerCase().includes(search)),
      )
    : rows;

  return c.json({ biomarkers: filtered.map(serializeBiomarker), total: filtered.length });
});

function biomarkerValues(b: ReturnType<typeof biomarkerInputSchema.parse>) {
  return {
    categoryId: b.category_id,
    name: b.name,
    slug: b.slug,
    unit: b.unit,
    description: b.description ?? '',
    whyItMatters: b.why_it_matters ?? '',
    whatAffectsIt: b.what_affects_it ?? '',
    optimalLow: String(b.optimal_low),
    optimalHigh: String(b.optimal_high),
    normalLow: String(b.normal_low),
    normalHigh: String(b.normal_high),
    minPlausible: String(b.min_plausible),
    maxPlausible: String(b.max_plausible),
    isActive: b.is_active ?? true,
    displayOrder: b.display_order ?? 0,
    tags: b.tags ?? [],
    // null clears the add-on price; undefined (field omitted) leaves it untouched on update.
    addonPriceEgp: b.addon_price_egp ?? null,
  };
}

adminRoutes.post('/biomarkers', validate('json', biomarkerInputSchema), async (c) => {
  const b = c.req.valid('json');
  const [row] = await db.insert(biomarkers).values(biomarkerValues(b)).returning();
  return c.json({ biomarker: serializeBiomarker(row!) }, 201);
});

adminRoutes.put('/biomarkers/:id', validate('json', biomarkerInputSchema), async (c) => {
  const id = c.req.param('id');
  const b = c.req.valid('json');
  const [row] = await db
    .update(biomarkers)
    .set(biomarkerValues(b))
    .where(eq(biomarkers.id, id))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'Biomarker not found');
  return c.json({ biomarker: serializeBiomarker(row) });
});

adminRoutes.delete('/biomarkers/:id', async (c) => {
  // Soft-deactivate so historical results keep their reference.
  const id = c.req.param('id');
  const [row] = await db
    .update(biomarkers)
    .set({ isActive: false })
    .where(eq(biomarkers.id, id))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'Biomarker not found');
  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Subscriptions (grant / update / cancel)
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.post(
  '/users/:id/subscription',
  validate('json', grantSubscriptionSchema),
  async (c) => {
    const userId = c.req.param('id');
    const { plan_id, months, payment_reference } = c.req.valid('json');

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return errorResponse(c, 'not_found', 'User not found');

    const [plan] = await db
      .select({ id: subscriptionPlans.id })
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, plan_id))
      .limit(1);
    if (!plan) return errorResponse(c, 'not_found', 'Plan not found');

    // Supersede any currently-active subscription, then grant the new one.
    await db
      .update(subscriptions)
      .set({ status: 'expired' })
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.status, 'active')));

    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + (months ?? 12));

    const [row] = await db
      .insert(subscriptions)
      .values({
        userId,
        planId: plan_id,
        status: 'active',
        startedAt: new Date(),
        expiresAt,
        paymentReference: payment_reference ?? 'admin_grant',
      })
      .returning();

    return c.json({ subscription: serializeSubscription(row!) }, 201);
  },
);

adminRoutes.put(
  '/subscriptions/:id',
  validate('json', updateSubscriptionSchema),
  async (c) => {
    const id = c.req.param('id');
    const b = c.req.valid('json');
    const [row] = await db
      .update(subscriptions)
      .set({
        ...(b.status !== undefined ? { status: b.status } : {}),
        ...(b.plan_id !== undefined ? { planId: b.plan_id } : {}),
        ...(b.expires_at !== undefined ? { expiresAt: new Date(b.expires_at) } : {}),
      })
      .where(eq(subscriptions.id, id))
      .returning();
    if (!row) return errorResponse(c, 'not_found', 'Subscription not found');
    return c.json({ subscription: serializeSubscription(row) });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Health goals
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/health-goals', async (c) => {
  const rows = await db.select().from(healthGoals).orderBy(asc(healthGoals.displayOrder));
  return c.json({ goals: rows.map(serializeHealthGoal) });
});

adminRoutes.post('/health-goals', validate('json', healthGoalInputSchema), async (c) => {
  const b = c.req.valid('json');
  const [row] = await db
    .insert(healthGoals)
    .values({
      slug: b.slug,
      label: b.label,
      icon: b.icon ?? '',
      displayOrder: b.display_order ?? 0,
      isActive: b.is_active ?? true,
    })
    .returning();
  return c.json({ goal: serializeHealthGoal(row!) }, 201);
});

adminRoutes.put('/health-goals/:id', validate('json', healthGoalUpdateSchema), async (c) => {
  const id = c.req.param('id');
  const b = c.req.valid('json');
  const [row] = await db
    .update(healthGoals)
    .set({
      ...(b.slug !== undefined ? { slug: b.slug } : {}),
      ...(b.label !== undefined ? { label: b.label } : {}),
      ...(b.icon !== undefined ? { icon: b.icon } : {}),
      ...(b.display_order !== undefined ? { displayOrder: b.display_order } : {}),
      ...(b.is_active !== undefined ? { isActive: b.is_active } : {}),
    })
    .where(eq(healthGoals.id, id))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'Goal not found');
  return c.json({ goal: serializeHealthGoal(row) });
});

adminRoutes.delete('/health-goals/:id', async (c) => {
  const id = c.req.param('id');
  const [deleted] = await db.delete(healthGoals).where(eq(healthGoals.id, id)).returning();
  if (!deleted) return errorResponse(c, 'not_found', 'Goal not found');
  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// App content / settings
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/app-content', async (c) => {
  const content = await getAppContent();
  return c.json({ content });
});

adminRoutes.put('/app-content', validate('json', appContentSchema), async (c) => {
  const content = await setAppContent(c.req.valid('json'));
  return c.json({ content });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI Health Intelligence (config, review queue, generation, usage)
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/ai/config', async (c) => {
  const config = await getAiConfig();
  return c.json({ config });
});

adminRoutes.put('/ai/config', validate('json', aiConfigSchema), async (c) => {
  const config = await setAiConfig(c.req.valid('json'));
  return c.json({ config });
});

// Insight review queue. Filter by status and/or user.
adminRoutes.get('/ai/insights', async (c) => {
  const status = c.req.query('status');
  const userId = c.req.query('userId');
  const conditions = [];
  if (status) conditions.push(eq(aiInsights.status, status));
  if (userId) conditions.push(eq(aiInsights.userId, userId));
  const rows = await db
    .select()
    .from(aiInsights)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(aiInsights.createdAt))
    .limit(200);
  return c.json({ insights: rows.map(serializeAiInsight) });
});

adminRoutes.post('/ai/insights/:id/publish', async (c) => {
  const id = c.req.param('id');
  const [row] = await db
    .update(aiInsights)
    .set({ status: 'published', publishedAt: new Date() })
    .where(eq(aiInsights.id, id))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'Insight not found');
  return c.json({ insight: serializeAiInsight(row) });
});

adminRoutes.post('/ai/insights/:id/archive', async (c) => {
  const id = c.req.param('id');
  const [row] = await db
    .update(aiInsights)
    .set({ status: 'archived' })
    .where(eq(aiInsights.id, id))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'Insight not found');
  return c.json({ insight: serializeAiInsight(row) });
});

adminRoutes.delete('/ai/insights/:id', async (c) => {
  const id = c.req.param('id');
  const [deleted] = await db.delete(aiInsights).where(eq(aiInsights.id, id)).returning();
  if (!deleted) return errorResponse(c, 'not_found', 'Insight not found');
  return c.json({ success: true });
});

// Admin triggers generation for a specific user.
adminRoutes.post('/users/:id/ai/generate', async (c) => {
  const userId = c.req.param('id');
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return errorResponse(c, 'not_found', 'User not found');
  const config = await getAiConfig();
  if (!config.enabled) return errorResponse(c, 'unprocessable', 'AI is disabled.');
  const generated = await generateAndStoreInsights(userId, config, 'admin');
  return c.json({ success: true, generated, pending_review: config.require_review });
});

// Token usage / cost visibility.
adminRoutes.get('/ai/usage', async (c) => {
  const [ins] = await db
    .select({
      input: sql<number>`coalesce(sum(${aiInsights.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${aiInsights.outputTokens}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(aiInsights);
  const [chat] = await db
    .select({
      input: sql<number>`coalesce(sum(${aiChatMessages.inputTokens}), 0)`,
      output: sql<number>`coalesce(sum(${aiChatMessages.outputTokens}), 0)`,
      count: sql<number>`count(*)`,
    })
    .from(aiChatMessages);
  return c.json({
    usage: {
      total_input_tokens: Number(ins?.input ?? 0) + Number(chat?.input ?? 0),
      total_output_tokens: Number(ins?.output ?? 0) + Number(chat?.output ?? 0),
      insight_count: Number(ins?.count ?? 0),
      chat_message_count: Number(chat?.count ?? 0),
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Interventions (supplement / protocol catalog)
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/interventions', async (c) => {
  const rows = await db.select().from(interventions).orderBy(asc(interventions.displayOrder));
  return c.json({ interventions: rows.map(serializeIntervention) });
});

adminRoutes.post('/interventions', validate('json', interventionInputSchema), async (c) => {
  const body = c.req.valid('json');
  const [row] = await db
    .insert(interventions)
    .values({
      name: body.name,
      slug: body.slug,
      category: body.category,
      summary: body.summary,
      detail: body.detail,
      dosage: body.dosage,
      evidenceLevel: body.evidence_level,
      url: body.url,
      targetBiomarkerSlugs: body.target_biomarker_slugs,
      triggerStatuses: body.trigger_statuses,
      isActive: body.is_active,
      displayOrder: body.display_order,
    })
    .returning();
  return c.json({ intervention: serializeIntervention(row!) }, 201);
});

adminRoutes.put('/interventions/:id', validate('json', interventionUpdateSchema), async (c) => {
  const id = c.req.param('id');
  const b = c.req.valid('json');
  const [row] = await db
    .update(interventions)
    .set({
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.slug !== undefined ? { slug: b.slug } : {}),
      ...(b.category !== undefined ? { category: b.category } : {}),
      ...(b.summary !== undefined ? { summary: b.summary } : {}),
      ...(b.detail !== undefined ? { detail: b.detail } : {}),
      ...(b.dosage !== undefined ? { dosage: b.dosage } : {}),
      ...(b.evidence_level !== undefined ? { evidenceLevel: b.evidence_level } : {}),
      ...(b.url !== undefined ? { url: b.url } : {}),
      ...(b.target_biomarker_slugs !== undefined
        ? { targetBiomarkerSlugs: b.target_biomarker_slugs }
        : {}),
      ...(b.trigger_statuses !== undefined ? { triggerStatuses: b.trigger_statuses } : {}),
      ...(b.is_active !== undefined ? { isActive: b.is_active } : {}),
      ...(b.display_order !== undefined ? { displayOrder: b.display_order } : {}),
    })
    .where(eq(interventions.id, id))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'Intervention not found');
  return c.json({ intervention: serializeIntervention(row) });
});

adminRoutes.delete('/interventions/:id', async (c) => {
  const id = c.req.param('id');
  const [deleted] = await db.delete(interventions).where(eq(interventions.id, id)).returning();
  if (!deleted) return errorResponse(c, 'not_found', 'Intervention not found');
  return c.json({ success: true });
});

// A user's computed recommendations (read-only, for admin review).
adminRoutes.get('/users/:id/recommendations', async (c) => {
  const userId = c.req.param('id');
  const recommendations = await computeUserRecommendations(userId);
  return c.json({ recommendations });
});

// ─────────────────────────────────────────────────────────────────────────────
// Notifications & engagement
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/notification-config', async (c) => {
  const config = await getNotificationConfig();
  return c.json({ config });
});

adminRoutes.put('/notification-config', validate('json', notificationConfigSchema), async (c) => {
  const config = await setNotificationConfig(c.req.valid('json'));
  return c.json({ config });
});

// Broadcast an announcement to every user.
adminRoutes.post('/notifications/broadcast', validate('json', broadcastSchema), async (c) => {
  const body = c.req.valid('json');
  const allUsers = await db.select({ id: users.id }).from(users);
  if (allUsers.length === 0) return c.json({ success: true, sent: 0 });
  const stamp = new Date().toISOString();
  await db.insert(notifications).values(
    allUsers.map((u) => ({
      userId: u.id,
      type: 'announcement' as const,
      severity: body.severity,
      title: body.title,
      body: body.body,
      dedupeKey: `announcement:${stamp}`,
    })),
  );
  return c.json({ success: true, sent: allUsers.length });
});

// Trigger system-alert generation for a user.
adminRoutes.post('/users/:id/notifications/generate', async (c) => {
  const userId = c.req.param('id');
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return errorResponse(c, 'not_found', 'User not found');
  await generateUserNotifications(userId);
  return c.json({ success: true });
});

adminRoutes.get('/notifications/stats', async (c) => {
  const [total] = await db.select({ n: sql<number>`count(*)::int` }).from(notifications);
  const [unread] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(notifications)
    .where(isNull(notifications.readAt));
  const [devices] = await db.select({ n: sql<number>`count(*)::int` }).from(deviceTokens);
  return c.json({
    stats: { total: total?.n ?? 0, unread: unread?.n ?? 0, device_count: devices?.n ?? 0 },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test booking — areas, availability, bookings
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/areas', async (c) => {
  const rows = await db.select().from(serviceAreas).orderBy(asc(serviceAreas.displayOrder));
  return c.json({ areas: rows.map(serializeArea) });
});

adminRoutes.post('/areas', validate('json', serviceAreaInputSchema), async (c) => {
  const b = c.req.valid('json');
  const [row] = await db
    .insert(serviceAreas)
    .values({
      name: b.name,
      slug: b.slug,
      city: b.city,
      defaultSlotMinutes: b.default_slot_minutes,
      isActive: b.is_active,
      displayOrder: b.display_order,
    })
    .returning();
  return c.json({ area: serializeArea(row!) }, 201);
});

adminRoutes.put('/areas/:id', validate('json', serviceAreaUpdateSchema), async (c) => {
  const id = c.req.param('id');
  const b = c.req.valid('json');
  const [row] = await db
    .update(serviceAreas)
    .set({
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.slug !== undefined ? { slug: b.slug } : {}),
      ...(b.city !== undefined ? { city: b.city } : {}),
      ...(b.default_slot_minutes !== undefined ? { defaultSlotMinutes: b.default_slot_minutes } : {}),
      ...(b.is_active !== undefined ? { isActive: b.is_active } : {}),
      ...(b.display_order !== undefined ? { displayOrder: b.display_order } : {}),
    })
    .where(eq(serviceAreas.id, id))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'Area not found');
  return c.json({ area: serializeArea(row) });
});

adminRoutes.delete('/areas/:id', async (c) => {
  const id = c.req.param('id');
  const [deleted] = await db.delete(serviceAreas).where(eq(serviceAreas.id, id)).returning();
  if (!deleted) return errorResponse(c, 'not_found', 'Area not found');
  return c.json({ success: true });
});

// Weekly windows for an area.
adminRoutes.get('/areas/:id/windows', async (c) => {
  const areaId = c.req.param('id');
  const rows = await db
    .select()
    .from(availabilityWindows)
    .where(eq(availabilityWindows.areaId, areaId))
    .orderBy(asc(availabilityWindows.dayOfWeek), asc(availabilityWindows.startTime));
  return c.json({ windows: rows.map(serializeWindow) });
});

adminRoutes.post(
  '/areas/:id/windows',
  validate('json', availabilityWindowInputSchema),
  async (c) => {
    const areaId = c.req.param('id');
    const b = c.req.valid('json');
    const [row] = await db
      .insert(availabilityWindows)
      .values({
        areaId,
        dayOfWeek: b.day_of_week,
        startTime: b.start_time,
        endTime: b.end_time,
        capacity: b.capacity,
      })
      .returning();
    return c.json({ window: serializeWindow(row!) }, 201);
  },
);

adminRoutes.delete('/windows/:id', async (c) => {
  const id = c.req.param('id');
  const [deleted] = await db
    .delete(availabilityWindows)
    .where(eq(availabilityWindows.id, id))
    .returning();
  if (!deleted) return errorResponse(c, 'not_found', 'Window not found');
  return c.json({ success: true });
});

// Date overrides for an area (upsert by date).
adminRoutes.get('/areas/:id/overrides', async (c) => {
  const areaId = c.req.param('id');
  const rows = await db
    .select()
    .from(availabilityOverrides)
    .where(eq(availabilityOverrides.areaId, areaId))
    .orderBy(asc(availabilityOverrides.date));
  return c.json({ overrides: rows.map(serializeOverride) });
});

adminRoutes.put(
  '/areas/:id/overrides',
  validate('json', availabilityOverrideInputSchema),
  async (c) => {
    const areaId = c.req.param('id');
    const b = c.req.valid('json');
    const windows = b.windows
      ? b.windows.map((w) => ({ startTime: w.start_time, endTime: w.end_time, capacity: w.capacity }))
      : null;
    const [row] = await db
      .insert(availabilityOverrides)
      .values({ areaId, date: b.date, isClosed: b.is_closed, windows })
      .onConflictDoUpdate({
        target: [availabilityOverrides.areaId, availabilityOverrides.date],
        set: { isClosed: b.is_closed, windows },
      })
      .returning();
    return c.json({ override: serializeOverride(row!) });
  },
);

adminRoutes.delete('/overrides/:id', async (c) => {
  const id = c.req.param('id');
  const [deleted] = await db
    .delete(availabilityOverrides)
    .where(eq(availabilityOverrides.id, id))
    .returning();
  if (!deleted) return errorResponse(c, 'not_found', 'Override not found');
  return c.json({ success: true });
});

// All bookings (with user + area), filterable.
adminRoutes.get('/bookings', async (c) => {
  const areaId = c.req.query('areaId');
  const date = c.req.query('date');
  const status = c.req.query('status');
  const conditions = [];
  if (areaId) conditions.push(eq(bookings.areaId, areaId));
  if (date) conditions.push(eq(bookings.date, date));
  if (status) conditions.push(eq(bookings.status, status));

  const rows = await db
    .select({
      booking: bookings,
      userName: users.fullName,
      userEmail: users.email,
      areaName: serviceAreas.name,
    })
    .from(bookings)
    .innerJoin(users, eq(bookings.userId, users.id))
    .innerJoin(serviceAreas, eq(bookings.areaId, serviceAreas.id))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(bookings.date), asc(bookings.startTime))
    .limit(300);

  return c.json({
    bookings: rows.map((r) => ({
      ...serializeBooking(r.booking, r.areaName),
      user_name: r.userName,
      user_email: r.userEmail,
    })),
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lab partners — accounts + area assignment
// ─────────────────────────────────────────────────────────────────────────────

/** List lab-partner accounts with their assigned areas. */
adminRoutes.get('/partners', async (c) => {
  const partners = await db
    .select()
    .from(users)
    .where(eq(users.role, 'lab_partner'))
    .orderBy(desc(users.createdAt));

  const ids = partners.map((p) => p.id);
  const assignments = ids.length
    ? await db
        .select({
          partnerId: labPartnerAreas.partnerId,
          areaId: serviceAreas.id,
          name: serviceAreas.name,
          city: serviceAreas.city,
        })
        .from(labPartnerAreas)
        .innerJoin(serviceAreas, eq(labPartnerAreas.areaId, serviceAreas.id))
        .where(inArray(labPartnerAreas.partnerId, ids))
    : [];

  const byPartner = new Map<string, { id: string; name: string; city: string }[]>();
  for (const a of assignments) {
    const list = byPartner.get(a.partnerId) ?? [];
    list.push({ id: a.areaId, name: a.name, city: a.city });
    byPartner.set(a.partnerId, list);
  }

  return c.json({
    partners: partners.map((p) => {
      const areas = byPartner.get(p.id) ?? [];
      return {
        id: p.id,
        email: p.email,
        full_name: p.fullName,
        phone: p.phone,
        area_ids: areas.map((a) => a.id),
        areas,
      };
    }),
  });
});

/** Create a lab-partner account (Supabase auth user + users row). */
adminRoutes.post('/partners', validate('json', createPartnerSchema), async (c) => {
  const { email, full_name, password, phone } = c.req.valid('json');

  // Same atomicity as self-signup: if the profile cannot be written the Auth
  // identity is rolled back, so an admin's failed partner creation can never
  // leave an orphan holding the address. No session is minted for the partner.
  const result = await provisionManagedAccount(provisionDeps, {
    email,
    password,
    fullName: full_name,
    phone,
    role: 'lab_partner',
  });

  if (!result.ok) {
    switch (result.kind) {
      case 'email_taken':
        return errorResponse(c, 'conflict', 'An account with this email already exists');
      case 'phone_taken':
        return errorResponse(c, 'conflict', 'This phone number is already registered to another account');
      case 'profile_conflict':
        return errorResponse(
          c,
          'conflict',
          'This email is linked to an account that could not be set up. Run db:check-users.',
        );
      default:
        return errorResponse(c, 'unprocessable', 'Could not create the partner account');
    }
  }
  const row = result.row;

  return c.json(
    {
      partner: {
        id: row.id,
        email: row.email,
        full_name: row.fullName,
        phone: row.phone,
        area_ids: [],
        areas: [],
      },
    },
    201,
  );
});

/** Replace a partner's assigned service areas. */
adminRoutes.put('/partners/:id/areas', validate('json', assignPartnerAreasSchema), async (c) => {
  const partnerId = c.req.param('id');
  const { area_ids } = c.req.valid('json');

  const [partner] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, partnerId))
    .limit(1);
  if (!partner || partner.role !== 'lab_partner') {
    return errorResponse(c, 'not_found', 'Lab partner not found');
  }

  await db.delete(labPartnerAreas).where(eq(labPartnerAreas.partnerId, partnerId));
  if (area_ids.length > 0) {
    await db
      .insert(labPartnerAreas)
      .values(area_ids.map((areaId) => ({ partnerId, areaId })))
      .onConflictDoNothing();
  }
  return c.json({ success: true, area_ids });
});

/** Remove a partner: clear area assignments and demote to a regular user. */
adminRoutes.delete('/partners/:id', async (c) => {
  const partnerId = c.req.param('id');
  await db.delete(labPartnerAreas).where(eq(labPartnerAreas.partnerId, partnerId));
  const [row] = await db
    .update(users)
    .set({ role: 'user' })
    .where(and(eq(users.id, partnerId), eq(users.role, 'lab_partner')))
    .returning({ id: users.id });
  if (!row) return errorResponse(c, 'not_found', 'Lab partner not found');
  return c.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Visit notification templates (messages the visiting doctor pushes)
// ─────────────────────────────────────────────────────────────────────────────

adminRoutes.get('/notification-templates', async (c) => {
  const rows = await db
    .select()
    .from(notificationTemplates)
    .orderBy(asc(notificationTemplates.displayOrder), asc(notificationTemplates.title));
  return c.json({ templates: rows.map(serializeNotificationTemplate) });
});

adminRoutes.post('/notification-templates', validate('json', notificationTemplateInputSchema), async (c) => {
  const b = c.req.valid('json');
  const [row] = await db
    .insert(notificationTemplates)
    .values({ title: b.title, body: b.body, isActive: b.is_active, displayOrder: b.display_order })
    .returning();
  return c.json({ template: serializeNotificationTemplate(row!) }, 201);
});

adminRoutes.put('/notification-templates/:id', validate('json', notificationTemplateUpdateSchema), async (c) => {
  const b = c.req.valid('json');
  const [row] = await db
    .update(notificationTemplates)
    .set({
      ...(b.title !== undefined ? { title: b.title } : {}),
      ...(b.body !== undefined ? { body: b.body } : {}),
      ...(b.is_active !== undefined ? { isActive: b.is_active } : {}),
      ...(b.display_order !== undefined ? { displayOrder: b.display_order } : {}),
    })
    .where(eq(notificationTemplates.id, c.req.param('id')))
    .returning();
  if (!row) return errorResponse(c, 'not_found', 'Template not found');
  return c.json({ template: serializeNotificationTemplate(row) });
});

adminRoutes.delete('/notification-templates/:id', async (c) => {
  const [deleted] = await db
    .delete(notificationTemplates)
    .where(eq(notificationTemplates.id, c.req.param('id')))
    .returning();
  if (!deleted) return errorResponse(c, 'not_found', 'Template not found');
  return c.json({ success: true });
});
