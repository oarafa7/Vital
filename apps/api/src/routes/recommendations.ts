/**
 * Personalized recommendations (Phase 2). Gated behind an active subscription.
 *   GET /recommendations/me → interventions matched to the user's results
 */
import { Hono } from 'hono';

import { computeUserRecommendations } from '../lib/recommendations.js';
import { type AuthVariables, requireAuth } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/subscription.js';

export const recommendationRoutes = new Hono<{ Variables: AuthVariables }>();

// Scoped to this router's own paths — see the note in ai.ts and
// apps/api/test/route-mounting.test.ts.
recommendationRoutes.use('/recommendations/*', requireAuth, requireActiveSubscription);

recommendationRoutes.get('/recommendations/me', async (c) => {
  const userId = c.get('userId');
  const recommendations = await computeUserRecommendations(userId);
  return c.json({ recommendations });
});
