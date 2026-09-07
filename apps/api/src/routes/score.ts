/**
 * VITAL Score routes (Phase 2). Gated behind an active subscription, like the
 * rest of the biomarker data.
 *
 *   GET /score/me           → the user's current computed VITAL Score
 *   GET /score/me/history   → persisted daily snapshots (oldest → newest)
 */
import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client.js';
import { scoreSnapshots } from '../db/schema.js';
import { computeUserScore } from '../lib/score.js';
import { serializeScoreSnapshot } from '../lib/serialize.js';
import { type AuthVariables, requireAuth } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/subscription.js';

export const scoreRoutes = new Hono<{ Variables: AuthVariables }>();

// Scoped to this router's own paths — see the note in ai.ts and
// apps/api/test/route-mounting.test.ts.
scoreRoutes.use('/score/*', requireAuth, requireActiveSubscription);

scoreRoutes.get('/score/me', async (c) => {
  const userId = c.get('userId');
  const score = await computeUserScore(userId);
  return c.json({ score });
});

scoreRoutes.get('/score/me/history', async (c) => {
  const userId = c.get('userId');
  const rows = await db
    .select()
    .from(scoreSnapshots)
    .where(eq(scoreSnapshots.userId, userId))
    .orderBy(asc(scoreSnapshots.recordedOn));
  return c.json({ history: rows.map(serializeScoreSnapshot) });
});
