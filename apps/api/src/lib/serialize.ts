/**
 * Row → API-type serializers. Drizzle returns `decimal` columns as strings and
 * `timestamp`/`date` as Date|string; these helpers normalise to the shapes
 * declared in `@vital/shared`.
 */
import type {
  AddonOrder,
  AiChatMessage,
  AiInsight,
  AiInsightSource,
  AiInsightStatus,
  AiInsightType,
  AppNotification,
  AvailabilityOverride,
  AvailabilityWindow,
  Biomarker,
  BiomarkerCategory,
  BiomarkerStatus,
  Booking,
  EvidenceLevel,
  HealthGoalOption,
  Intervention,
  InterventionCategory,
  LabUpload,
  NotificationTemplate,
  PartnerUserSummary,
  ScoreBand,
  ScoreHistoryPoint,
  ServiceArea,
  Subscription,
  SubscriptionPlan,
  User,
  UserBiomarkerResult,
} from '@vital/shared';

import { coerceRole } from './provisioning.js';
import type {
  AddonOrderItemRow,
  AddonOrderRow,
  AiChatMessageRow,
  AiInsightRow,
  AvailabilityOverrideRow,
  AvailabilityWindowRow,
  BiomarkerCategoryRow,
  BiomarkerRow,
  BookingRow,
  HealthGoalRow,
  InterventionRow,
  LabUploadRow,
  NotificationRow,
  NotificationTemplateRow,
  ScoreSnapshotRow,
  ServiceAreaRow,
  SubscriptionPlanRow,
  SubscriptionRow,
  UserBiomarkerResultRow,
  UserRow,
} from '../db/schema.js';

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function num(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}

export function serializeUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    full_name: row.fullName,
    // Narrowed rather than cast: an unrecognised stored role must degrade to
    // the least-privileged value, not flow through to clients as-is.
    role: coerceRole(row.role),
    phone: row.phone,
    date_of_birth: row.dateOfBirth,
    gender: (row.gender as User['gender']) ?? null,
    height_cm: row.heightCm,
    weight_kg: row.weightKg,
    chronic_conditions: (row.chronicConditions as User['chronic_conditions']) ?? [],
    family_history: (row.familyHistory as User['family_history']) ?? [],
    health_goals: (row.healthGoals as User['health_goals']) ?? [],
    activity_level: (row.activityLevel as User['activity_level']) ?? null,
    address: row.address,
    latitude: row.latitude != null ? num(row.latitude) : null,
    longitude: row.longitude != null ? num(row.longitude) : null,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  };
}

export function serializePlan(row: SubscriptionPlanRow): SubscriptionPlan {
  return {
    id: row.id,
    name: row.name as SubscriptionPlan['name'],
    price_egp: row.priceEgp,
    price_display: row.priceDisplay,
    annual_tests_count: row.annualTestsCount,
    biomarker_count: row.biomarkerCount,
    features: row.features ?? [],
    is_active: row.isActive,
  };
}

export function serializeSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    user_id: row.userId,
    plan_id: row.planId,
    status: row.status as Subscription['status'],
    started_at: iso(row.startedAt),
    expires_at: iso(row.expiresAt),
    payment_reference: row.paymentReference,
    created_at: iso(row.createdAt),
  };
}

export function serializeCategory(row: BiomarkerCategoryRow): BiomarkerCategory {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug as BiomarkerCategory['slug'],
    description: row.description,
    icon: row.icon,
    color: row.color,
    display_order: row.displayOrder,
  };
}

export function serializeBiomarker(row: BiomarkerRow): Biomarker {
  return {
    id: row.id,
    category_id: row.categoryId,
    name: row.name,
    slug: row.slug,
    unit: row.unit,
    description: row.description,
    why_it_matters: row.whyItMatters,
    what_affects_it: row.whatAffectsIt,
    optimal_low: num(row.optimalLow),
    optimal_high: num(row.optimalHigh),
    normal_low: num(row.normalLow),
    normal_high: num(row.normalHigh),
    min_plausible: num(row.minPlausible),
    max_plausible: num(row.maxPlausible),
    is_active: row.isActive,
    display_order: row.displayOrder,
    tags: row.tags ?? [],
    addon_price_egp: row.addonPriceEgp ?? null,
  };
}

export function serializeAddonOrder(row: AddonOrderRow, items: AddonOrderItemRow[]): AddonOrder {
  return {
    id: row.id,
    user_id: row.userId,
    booking_id: row.bookingId,
    status: row.status as AddonOrder['status'],
    subtotal_egp: row.subtotalEgp,
    vat_egp: row.vatEgp,
    total_egp: row.totalEgp,
    items: items.map((i) => ({ biomarker_id: i.biomarkerId, name: i.name, price_egp: i.priceEgp })),
    created_at: iso(row.createdAt),
  };
}

export function serializeResult(row: UserBiomarkerResultRow): UserBiomarkerResult {
  return {
    id: row.id,
    user_id: row.userId,
    biomarker_id: row.biomarkerId,
    value: num(row.value),
    tested_at: row.testedAt,
    lab_name: row.labName,
    notes: row.notes,
    source: (row.source as UserBiomarkerResult['source']) ?? 'manual',
    lab_upload_id: row.labUploadId ?? null,
    reference_range: row.referenceRange ?? null,
    ref_low: row.refLow != null ? num(row.refLow) : null,
    ref_high: row.refHigh != null ? num(row.refHigh) : null,
    created_at: iso(row.createdAt),
  };
}

export function serializeHealthGoal(row: HealthGoalRow): HealthGoalOption {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    icon: row.icon,
    display_order: row.displayOrder,
    is_active: row.isActive,
  };
}

export function serializeLabUpload(row: LabUploadRow): LabUpload {
  return {
    id: row.id,
    user_id: row.userId,
    file_path: row.filePath,
    original_name: row.originalName,
    lab_name: row.labName,
    tested_at: row.testedAt,
    status: row.status as LabUpload['status'],
    parsed: (row.parsed ?? []).map((p) => ({
      biomarker_id: p.biomarkerId,
      biomarker_name: p.biomarkerName,
      matched_name: p.matchedName,
      value: p.value,
      unit: p.unit,
      confidence: p.confidence,
      include: p.include,
      reference_range: p.referenceRange ?? null,
      ref_low: p.refLow ?? null,
      ref_high: p.refHigh ?? null,
    })),
    result_count: row.resultCount,
    uploaded_by: row.uploadedBy ?? null,
    created_at: iso(row.createdAt),
  };
}

export function serializeAiInsight(row: AiInsightRow): AiInsight {
  return {
    id: row.id,
    user_id: row.userId,
    type: row.type as AiInsightType,
    title: row.title,
    body: row.body,
    status: row.status as AiInsightStatus,
    model: row.model,
    source: row.source as AiInsightSource,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    created_at: iso(row.createdAt),
    published_at: row.publishedAt ? iso(row.publishedAt) : null,
  };
}

export function serializeAiChatMessage(row: AiChatMessageRow): AiChatMessage {
  return {
    id: row.id,
    user_id: row.userId,
    role: row.role as AiChatMessage['role'],
    content: row.content,
    created_at: iso(row.createdAt),
  };
}

export function serializeIntervention(row: InterventionRow): Intervention {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    category: row.category as InterventionCategory,
    summary: row.summary,
    detail: row.detail,
    dosage: row.dosage,
    evidence_level: row.evidenceLevel as EvidenceLevel,
    url: row.url,
    target_biomarker_slugs: row.targetBiomarkerSlugs ?? [],
    trigger_statuses: (row.triggerStatuses ?? []) as BiomarkerStatus[],
    is_active: row.isActive,
    display_order: row.displayOrder,
  };
}

export function serializeNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    user_id: row.userId,
    type: row.type as AppNotification['type'],
    severity: row.severity as AppNotification['severity'],
    title: row.title,
    body: row.body,
    link: row.link,
    read_at: row.readAt ? iso(row.readAt) : null,
    created_at: iso(row.createdAt),
  };
}

export function serializeScoreSnapshot(row: ScoreSnapshotRow): ScoreHistoryPoint {
  return {
    id: row.id,
    score: row.score,
    band: row.band as ScoreBand,
    tested_count: row.testedCount,
    total_count: row.totalCount,
    biological_age: row.biologicalAge,
    cardiometabolic_score: row.cardiometabolicScore,
    longevity_score: row.longevityScore,
    confidence: row.confidence,
    recorded_on: row.recordedOn,
    created_at: iso(row.createdAt),
  };
}

export function serializeArea(row: ServiceAreaRow): ServiceArea {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    city: row.city,
    default_slot_minutes: row.defaultSlotMinutes,
    is_active: row.isActive,
    display_order: row.displayOrder,
  };
}

export function serializeWindow(row: AvailabilityWindowRow): AvailabilityWindow {
  return {
    id: row.id,
    area_id: row.areaId,
    day_of_week: row.dayOfWeek,
    start_time: row.startTime,
    end_time: row.endTime,
    capacity: row.capacity,
  };
}

export function serializeOverride(row: AvailabilityOverrideRow): AvailabilityOverride {
  return {
    id: row.id,
    area_id: row.areaId,
    date: row.date,
    is_closed: row.isClosed,
    windows: row.windows
      ? row.windows.map((w) => ({
          start_time: w.startTime,
          end_time: w.endTime,
          capacity: w.capacity,
        }))
      : null,
  };
}

export function serializePartnerUserSummary(row: UserRow): PartnerUserSummary {
  return {
    id: row.id,
    full_name: row.fullName,
    email: row.email,
    phone: row.phone,
    date_of_birth: row.dateOfBirth,
    gender: (row.gender as PartnerUserSummary['gender']) ?? null,
    height_cm: row.heightCm,
  };
}

export function serializeBooking(row: BookingRow, areaName: string): Booking {
  return {
    id: row.id,
    user_id: row.userId,
    area_id: row.areaId,
    area_name: areaName,
    date: row.date,
    start_time: row.startTime,
    end_time: row.endTime,
    status: row.status as Booking['status'],
    address: row.address,
    latitude: row.latitude != null ? num(row.latitude) : null,
    longitude: row.longitude != null ? num(row.longitude) : null,
    notes: row.notes,
    created_at: iso(row.createdAt),
  };
}

export function serializeNotificationTemplate(row: NotificationTemplateRow): NotificationTemplate {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    is_active: row.isActive,
    display_order: row.displayOrder,
  };
}
