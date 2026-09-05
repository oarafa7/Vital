/**
 * VITAL — Drizzle ORM schema (Phase 1)
 *
 * PostgreSQL (Supabase). All Phase 1 tables: users, subscription_plans,
 * subscriptions, biomarker_categories, biomarkers, user_biomarker_results.
 */
import { relations } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  date,
  decimal,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ─────────────────────────────────────────────────────────────────────────────
// users
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ Constraints on this table that live ONLY in SQL (migration 0015), because
 * Drizzle's schema DSL cannot express them against the `auth` schema:
 *
 *   users_id_auth_users_id_fk  id → auth.users(id) ON DELETE CASCADE
 *   users_role_check           role IN ('user','admin','lab_partner')
 *
 * They are real and enforced. `drizzle.config.ts` pins `schemaFilter: ['public']`
 * so drizzle-kit never tries to manage the `auth` schema, but a future
 * `db:generate` still cannot see these two constraints — **review generated SQL
 * before applying it** and do not let it drop them.
 */
export const users = pgTable('users', {
  // Mirrors the Supabase auth.users id (UUID); enforced by the FK above.
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  // 'user' | 'admin' | 'lab_partner' — the sole authorization source, checked
  // by requireAdmin / requireLabPartner. Never read from JWT or metadata.
  role: text('role').notNull().default('user'),
  dateOfBirth: date('date_of_birth'),
  gender: text('gender'),
  heightCm: integer('height_cm'),
  weightKg: integer('weight_kg'),
  chronicConditions: text('chronic_conditions').array().notNull().default([]),
  familyHistory: text('family_history').array().notNull().default([]),
  healthGoals: text('health_goals').array().notNull().default([]),
  activityLevel: text('activity_level'),
  address: text('address'),
  latitude: decimal('latitude', { precision: 10, scale: 7 }),
  longitude: decimal('longitude', { precision: 10, scale: 7 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// subscription_plans
// ─────────────────────────────────────────────────────────────────────────────

export const subscriptionPlans = pgTable('subscription_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(), // 'basic' | 'premium'
  priceEgp: integer('price_egp').notNull(),
  priceDisplay: text('price_display').notNull(),
  annualTestsCount: integer('annual_tests_count').notNull(),
  biomarkerCount: integer('biomarker_count').notNull(),
  features: jsonb('features').$type<string[]>().notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
});

// ─────────────────────────────────────────────────────────────────────────────
// subscriptions
// ─────────────────────────────────────────────────────────────────────────────

export const subscriptions = pgTable('subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  planId: uuid('plan_id')
    .notNull()
    .references(() => subscriptionPlans.id),
  status: text('status').notNull().default('active'), // active | expired | cancelled
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  paymentReference: text('payment_reference'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// biomarker_categories
// ─────────────────────────────────────────────────────────────────────────────

export const biomarkerCategories = pgTable('biomarker_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description').notNull().default(''),
  icon: text('icon').notNull().default(''),
  color: text('color').notNull().default('#C9A84C'),
  displayOrder: integer('display_order').notNull().default(0),
});

// ─────────────────────────────────────────────────────────────────────────────
// biomarkers
// ─────────────────────────────────────────────────────────────────────────────

export const biomarkers = pgTable(
  'biomarkers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => biomarkerCategories.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    unit: text('unit').notNull(),
    description: text('description').notNull().default(''),
    whyItMatters: text('why_it_matters').notNull().default(''),
    whatAffectsIt: text('what_affects_it').notNull().default(''),
    optimalLow: decimal('optimal_low', { precision: 12, scale: 4 }).notNull(),
    optimalHigh: decimal('optimal_high', { precision: 12, scale: 4 }).notNull(),
    normalLow: decimal('normal_low', { precision: 12, scale: 4 }).notNull(),
    normalHigh: decimal('normal_high', { precision: 12, scale: 4 }).notNull(),
    minPlausible: decimal('min_plausible', { precision: 12, scale: 4 }).notNull(),
    maxPlausible: decimal('max_plausible', { precision: 12, scale: 4 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    displayOrder: integer('display_order').notNull().default(0),
    tags: text('tags').array().notNull().default([]),
    // À-la-carte add-on price in EGP; null = not sold outside a plan.
    addonPriceEgp: integer('addon_price_egp'),
  },
  (table) => ({
    slugIdx: uniqueIndex('biomarkers_slug_idx').on(table.slug),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// user_biomarker_results
// ─────────────────────────────────────────────────────────────────────────────

export const userBiomarkerResults = pgTable('user_biomarker_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  biomarkerId: uuid('biomarker_id')
    .notNull()
    .references(() => biomarkers.id, { onDelete: 'cascade' }),
  value: decimal('value', { precision: 12, scale: 4 }).notNull(),
  testedAt: date('tested_at').notNull(),
  labName: text('lab_name'),
  notes: text('notes'),
  // 'manual' (user-entered) | 'admin' (admin-entered) | 'lab_upload' (from a parsed PDF)
  source: text('source').notNull().default('manual'),
  // When source = 'lab_upload', links back to the originating upload.
  labUploadId: uuid('lab_upload_id'),
  // The lab's printed reference range for this result (provenance), when known.
  referenceRange: text('reference_range'),
  refLow: decimal('ref_low', { precision: 12, scale: 4 }),
  refHigh: decimal('ref_high', { precision: 12, scale: 4 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// lab_uploads (admin-uploaded lab PDFs + parse state)
// ─────────────────────────────────────────────────────────────────────────────

export const labUploads = pgTable('lab_uploads', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Supabase Storage object path for the original PDF.
  filePath: text('file_path').notNull(),
  originalName: text('original_name').notNull(),
  labName: text('lab_name'),
  testedAt: date('tested_at'),
  // 'parsed' (awaiting review) | 'confirmed' (results created) | 'failed'
  status: text('status').notNull().default('parsed'),
  // Draft matches extracted from the PDF, pending admin confirmation.
  parsed: jsonb('parsed').$type<ParsedLabRow[]>().notNull().default([]),
  resultCount: integer('result_count').notNull().default(0),
  uploadedBy: uuid('uploaded_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export interface ParsedLabRow {
  biomarkerId: string | null;
  biomarkerName: string;
  matchedName: string | null;
  value: number | null;
  unit: string | null;
  confidence: number; // 0..1
  include: boolean;
  // Reference range as printed on the PDF (the lab's range for this patient).
  referenceRange?: string | null; // raw text, e.g. "40 - 129", "Up to 0.90"
  refLow?: number | null;
  refHigh?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// health_goals (admin-managed onboarding goal options)
// ─────────────────────────────────────────────────────────────────────────────

export const healthGoals = pgTable('health_goals', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  label: text('label').notNull(),
  icon: text('icon').notNull().default(''),
  displayOrder: integer('display_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
});

// ─────────────────────────────────────────────────────────────────────────────
// app_settings (admin-managed app content: tagline, lab partner, support, …)
// ─────────────────────────────────────────────────────────────────────────────

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// score_snapshots (Phase 2 — persisted VITAL Score history, one row per day)
// ─────────────────────────────────────────────────────────────────────────────

export interface CategoryScoreSnapshot {
  slug: string;
  name: string;
  score: number;
  tested: number;
  total: number;
}

export const scoreSnapshots = pgTable(
  'score_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    score: integer('score').notNull(),
    band: text('band').notNull(),
    testedCount: integer('tested_count').notNull().default(0),
    totalCount: integer('total_count').notNull().default(0),
    biologicalAge: integer('biological_age'),
    cardiometabolicScore: integer('cardiometabolic_score'),
    longevityScore: integer('longevity_score'),
    confidence: integer('confidence').notNull().default(0),
    // Full category breakdown at the time of the snapshot.
    breakdown: jsonb('breakdown').$type<CategoryScoreSnapshot[]>().notNull().default([]),
    // The calendar day this snapshot represents (one snapshot per user per day).
    recordedOn: date('recorded_on').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userDayIdx: uniqueIndex('score_snapshots_user_day_idx').on(table.userId, table.recordedOn),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// ai_insights (Phase 2 — AI-generated clinician notes / protocols)
// ─────────────────────────────────────────────────────────────────────────────

export const aiInsights = pgTable('ai_insights', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // 'summary' | 'protocol'
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull().default('draft'), // draft | published | archived
  model: text('model').notNull().default(''),
  source: text('source').notNull().default('system'), // system | admin | user
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});

// ─────────────────────────────────────────────────────────────────────────────
// ai_chat_messages (Phase 2 — grounded chat history)
// ─────────────────────────────────────────────────────────────────────────────

export const aiChatMessages = pgTable('ai_chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Monotonic insertion order — deterministic tiebreaker for messages that share
  // a created_at (user + assistant are inserted in one statement → same now()).
  seq: bigserial('seq', { mode: 'number' }).notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // user | assistant
  content: text('content').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Rolling summary of a user's older chat messages, so long conversations keep
 *  context beyond the recent-message window. `coveredCount` = how many messages
 *  (oldest-first) have been folded into the summary. */
export const aiChatSummaries = pgTable('ai_chat_summaries', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull().default(''),
  coveredCount: integer('covered_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// interventions (Phase 2 — admin-managed supplement / protocol catalog)
// ─────────────────────────────────────────────────────────────────────────────

export const interventions = pgTable('interventions', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  category: text('category').notNull(), // supplement | nutrition | lifestyle | retest
  summary: text('summary').notNull().default(''),
  detail: text('detail').notNull().default(''),
  dosage: text('dosage').notNull().default(''),
  evidenceLevel: text('evidence_level').notNull().default('moderate'),
  url: text('url').notNull().default(''),
  targetBiomarkerSlugs: text('target_biomarker_slugs').array().notNull().default([]),
  triggerStatuses: text('trigger_statuses').array().notNull().default([]),
  isActive: boolean('is_active').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
});

// ─────────────────────────────────────────────────────────────────────────────
// notifications (Phase 2 — in-app alerts & announcements)
// ─────────────────────────────────────────────────────────────────────────────

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // alert | retest | score | insight | announcement | system
    severity: text('severity').notNull().default('info'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    link: text('link'),
    // Idempotency key so system alerts aren't duplicated (null for one-offs).
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userDedupeIdx: uniqueIndex('notifications_user_dedupe_idx').on(table.userId, table.dedupeKey),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// device_tokens (Phase 2 — Expo push registration)
// ─────────────────────────────────────────────────────────────────────────────

export const deviceTokens = pgTable('device_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  platform: text('platform').notNull().default('ios'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ─────────────────────────────────────────────────────────────────────────────
// Test booking (Phase 2 — service areas, availability, bookings)
// ─────────────────────────────────────────────────────────────────────────────

export const serviceAreas = pgTable('service_areas', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  city: text('city').notNull().default(''),
  defaultSlotMinutes: integer('default_slot_minutes').notNull().default(60),
  isActive: boolean('is_active').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Recurring weekly availability window templates. */
export const availabilityWindows = pgTable('availability_windows', {
  id: uuid('id').primaryKey().defaultRandom(),
  areaId: uuid('area_id')
    .notNull()
    .references(() => serviceAreas.id, { onDelete: 'cascade' }),
  dayOfWeek: integer('day_of_week').notNull(), // 0=Sunday … 6=Saturday
  startTime: text('start_time').notNull(), // 'HH:MM'
  endTime: text('end_time').notNull(),
  capacity: integer('capacity').notNull().default(1),
});

export interface OverrideWindowRow {
  startTime: string;
  endTime: string;
  capacity: number;
}

/** Per-date overrides — close a date or replace its windows. */
export const availabilityOverrides = pgTable(
  'availability_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    areaId: uuid('area_id')
      .notNull()
      .references(() => serviceAreas.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    isClosed: boolean('is_closed').notNull().default(false),
    windows: jsonb('windows').$type<OverrideWindowRow[] | null>(),
  },
  (table) => ({
    areaDateIdx: uniqueIndex('availability_overrides_area_date_idx').on(table.areaId, table.date),
  }),
);

/** Materialized concrete slots — the capacity counter booked against. */
export const bookingSlots = pgTable(
  'booking_slots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    areaId: uuid('area_id')
      .notNull()
      .references(() => serviceAreas.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    capacity: integer('capacity').notNull(),
    bookedCount: integer('booked_count').notNull().default(0),
  },
  (table) => ({
    slotIdx: uniqueIndex('booking_slots_area_date_start_idx').on(
      table.areaId,
      table.date,
      table.startTime,
    ),
  }),
);

export const bookings = pgTable('bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  slotId: uuid('slot_id')
    .notNull()
    .references(() => bookingSlots.id, { onDelete: 'cascade' }),
  areaId: uuid('area_id')
    .notNull()
    .references(() => serviceAreas.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  status: text('status').notNull().default('booked'), // booked | cancelled | completed
  address: text('address'),
  latitude: decimal('latitude', { precision: 10, scale: 7 }),
  longitude: decimal('longitude', { precision: 10, scale: 7 }),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A paid order for extra (out-of-plan) markers attached to a booking. */
export const addonOrders = pgTable('addon_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  bookingId: uuid('booking_id')
    .notNull()
    .references(() => bookings.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('pending'), // pending | paid | cancelled
  subtotalEgp: integer('subtotal_egp').notNull(),
  vatEgp: integer('vat_egp').notNull(),
  totalEgp: integer('total_egp').notNull(),
  paymentReference: text('payment_reference'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Line items (one per extra marker) for an add-on order. */
export const addonOrderItems = pgTable('addon_order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id')
    .notNull()
    .references(() => addonOrders.id, { onDelete: 'cascade' }),
  biomarkerId: uuid('biomarker_id')
    .notNull()
    .references(() => biomarkers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), // snapshot of the marker name at purchase time
  priceEgp: integer('price_egp').notNull(),
});

/** Admin-managed messages a visiting doctor can push to a patient
 *  (e.g. "Doctor arriving within 30 minutes"). */
export const notificationTemplates = pgTable('notification_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Service areas a lab partner is assigned to (scopes what they can see). */
export const labPartnerAreas = pgTable(
  'lab_partner_areas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    areaId: uuid('area_id')
      .notNull()
      .references(() => serviceAreas.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    partnerAreaIdx: uniqueIndex('lab_partner_areas_partner_area_idx').on(
      table.partnerId,
      table.areaId,
    ),
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// Relations
// ─────────────────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  subscriptions: many(subscriptions),
  results: many(userBiomarkerResults),
  labUploads: many(labUploads),
}));

export const labUploadsRelations = relations(labUploads, ({ one }) => ({
  user: one(users, { fields: [labUploads.userId], references: [users.id] }),
}));

export const subscriptionPlansRelations = relations(subscriptionPlans, ({ many }) => ({
  subscriptions: many(subscriptions),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.id] }),
  plan: one(subscriptionPlans, {
    fields: [subscriptions.planId],
    references: [subscriptionPlans.id],
  }),
}));

export const biomarkerCategoriesRelations = relations(biomarkerCategories, ({ many }) => ({
  biomarkers: many(biomarkers),
}));

export const biomarkersRelations = relations(biomarkers, ({ one, many }) => ({
  category: one(biomarkerCategories, {
    fields: [biomarkers.categoryId],
    references: [biomarkerCategories.id],
  }),
  results: many(userBiomarkerResults),
}));

export const userBiomarkerResultsRelations = relations(userBiomarkerResults, ({ one }) => ({
  user: one(users, { fields: [userBiomarkerResults.userId], references: [users.id] }),
  biomarker: one(biomarkers, {
    fields: [userBiomarkerResults.biomarkerId],
    references: [biomarkers.id],
  }),
}));

// Convenience inferred types
export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SubscriptionPlanRow = typeof subscriptionPlans.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type BiomarkerCategoryRow = typeof biomarkerCategories.$inferSelect;
export type BiomarkerRow = typeof biomarkers.$inferSelect;
export type UserBiomarkerResultRow = typeof userBiomarkerResults.$inferSelect;
export type LabUploadRow = typeof labUploads.$inferSelect;
export type NewLabUploadRow = typeof labUploads.$inferInsert;
export type HealthGoalRow = typeof healthGoals.$inferSelect;
export type AppSettingRow = typeof appSettings.$inferSelect;
export type ScoreSnapshotRow = typeof scoreSnapshots.$inferSelect;
export type NewScoreSnapshotRow = typeof scoreSnapshots.$inferInsert;
export type AiInsightRow = typeof aiInsights.$inferSelect;
export type AiChatMessageRow = typeof aiChatMessages.$inferSelect;
export type AiChatSummaryRow = typeof aiChatSummaries.$inferSelect;
export type InterventionRow = typeof interventions.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type DeviceTokenRow = typeof deviceTokens.$inferSelect;
export type ServiceAreaRow = typeof serviceAreas.$inferSelect;
export type AvailabilityWindowRow = typeof availabilityWindows.$inferSelect;
export type AvailabilityOverrideRow = typeof availabilityOverrides.$inferSelect;
export type BookingSlotRow = typeof bookingSlots.$inferSelect;
export type BookingRow = typeof bookings.$inferSelect;
export type AddonOrderRow = typeof addonOrders.$inferSelect;
export type AddonOrderItemRow = typeof addonOrderItems.$inferSelect;
export type LabPartnerAreaRow = typeof labPartnerAreas.$inferSelect;
export type NotificationTemplateRow = typeof notificationTemplates.$inferSelect;
