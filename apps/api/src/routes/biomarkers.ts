/**
 * Biomarker library + detail routes. Data is gated behind an active
 * subscription. Each biomarker is returned with the requesting user's latest
 * result and a computed status.
 */
import {
  type BiomarkerStatus,
  type BiomarkerWithResult,
  applyLabRange,
  biomarkerQuerySchema,
  classifyBiomarkerSafe,
} from '@vital/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client.js';
import { biomarkerCategories, biomarkers, userBiomarkerResults } from '../db/schema.js';
import { errorResponse } from '../lib/http.js';
import { serializeBiomarker, serializeCategory, serializeResult } from '../lib/serialize.js';
import { type AuthVariables, requireAuth } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/subscription.js';
import { validate } from '../middleware/validate.js';

export const biomarkerRoutes = new Hono<{ Variables: AuthVariables }>();

// Scoped to this router's own paths — see the note in ai.ts and
// apps/api/test/route-mounting.test.ts. Both the exact collection paths and the
// nested wildcard are listed so every route below stays gated.
biomarkerRoutes.use('/biomarkers/*', requireAuth, requireActiveSubscription);
biomarkerRoutes.use('/biomarkers', requireAuth, requireActiveSubscription);
biomarkerRoutes.use('/biomarker-categories', requireAuth, requireActiveSubscription);

/**
 * Returns a map of biomarkerId → latest result for the given user, choosing
 * the most recent `tested_at` per biomarker.
 */
async function latestResultsByBiomarker(userId: string, biomarkerIds: string[]) {
  if (biomarkerIds.length === 0) return new Map<string, ReturnType<typeof serializeResult>>();

  const rows = await db
    .select()
    .from(userBiomarkerResults)
    .where(
      and(
        eq(userBiomarkerResults.userId, userId),
        inArray(userBiomarkerResults.biomarkerId, biomarkerIds),
      ),
    )
    .orderBy(desc(userBiomarkerResults.testedAt), desc(userBiomarkerResults.createdAt));

  const map = new Map<string, ReturnType<typeof serializeResult>>();
  for (const row of rows) {
    if (!map.has(row.biomarkerId)) {
      map.set(row.biomarkerId, serializeResult(row));
    }
  }
  return map;
}

biomarkerRoutes.get('/biomarkers', validate('query', biomarkerQuerySchema), async (c) => {
  const userId = c.get('userId');
  const { category, search, limit, offset } = c.req.valid('query');

  const conditions = [eq(biomarkers.isActive, true)];

  if (category && category !== 'all') {
    const [cat] = await db
      .select({ id: biomarkerCategories.id })
      .from(biomarkerCategories)
      .where(eq(biomarkerCategories.slug, category))
      .limit(1);
    if (cat) conditions.push(eq(biomarkers.categoryId, cat.id));
  }

  // Full list (filtered by category) — fuzzy search is applied in memory so we
  // can match across name/description/tags consistently with the client.
  const all = await db
    .select()
    .from(biomarkers)
    .where(and(...conditions))
    .orderBy(asc(biomarkers.displayOrder), asc(biomarkers.name));

  const term = search?.trim().toLowerCase();
  const matched = term
    ? all.filter(
        (b) =>
          b.name.toLowerCase().includes(term) ||
          b.description.toLowerCase().includes(term) ||
          (b.tags ?? []).some((t) => t.toLowerCase().includes(term)),
      )
    : all;

  const total = matched.length;
  const page = matched.slice(offset, offset + limit);

  const latest = await latestResultsByBiomarker(
    userId,
    page.map((b) => b.id),
  );

  const categories = await db
    .select()
    .from(biomarkerCategories)
    .orderBy(asc(biomarkerCategories.displayOrder));

  const result: BiomarkerWithResult[] = page.map((row) => {
    const bm = serializeBiomarker(row);
    const latestResult = latest.get(row.id) ?? null;
    // Classify against the patient's own lab range (age/sex-specific) when present.
    const ranges = applyLabRange(bm, {
      ref_low: latestResult?.ref_low ?? null,
      ref_high: latestResult?.ref_high ?? null,
    });
    const status: BiomarkerStatus = classifyBiomarkerSafe(latestResult?.value, ranges);
    return { ...bm, latest_result: latestResult, status };
  });

  return c.json({
    biomarkers: result,
    total,
    categories: categories.map(serializeCategory),
  });
});

biomarkerRoutes.get('/biomarkers/:id', async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const [row] = await db.select().from(biomarkers).where(eq(biomarkers.id, id)).limit(1);
  if (!row) return errorResponse(c, 'not_found', 'Biomarker not found');

  const [catRow] = await db
    .select()
    .from(biomarkerCategories)
    .where(eq(biomarkerCategories.id, row.categoryId))
    .limit(1);

  const latest = await latestResultsByBiomarker(userId, [row.id]);
  const bm = serializeBiomarker(row);
  const latestResult = latest.get(row.id) ?? null;

  const ranges = applyLabRange(bm, {
    ref_low: latestResult?.ref_low ?? null,
    ref_high: latestResult?.ref_high ?? null,
  });
  const payload: BiomarkerWithResult = {
    ...bm,
    category: catRow ? serializeCategory(catRow) : undefined,
    latest_result: latestResult,
    status: classifyBiomarkerSafe(latestResult?.value, ranges),
  };

  return c.json({ biomarker: payload });
});

biomarkerRoutes.get('/biomarker-categories', async (c) => {
  const rows = await db
    .select()
    .from(biomarkerCategories)
    .orderBy(asc(biomarkerCategories.displayOrder));
  return c.json({ categories: rows.map(serializeCategory) });
});
