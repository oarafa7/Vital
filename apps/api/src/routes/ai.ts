/**
 * AI Health Intelligence — user-facing routes (Phase 2). Gated behind an active
 * subscription. What's visible/allowed is governed by the admin AiConfig.
 *
 *   GET  /ai/insights/me          → the user's published insights
 *   POST /ai/insights/me/generate → user-triggered generation (if allowed)
 *   GET  /ai/chat/me              → chat history
 *   POST /ai/chat/me              → send a message, get a grounded reply
 */
import { chatInputSchema } from '@vital/shared';
import { and, asc, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client.js';
import { aiChatMessages, aiInsights } from '../db/schema.js';
import { chatReply, generateAndStoreInsights } from '../lib/ai.js';
import { getAiConfig } from '../lib/ai-config.js';
import { fail } from '../lib/http.js';
import { serializeAiChatMessage, serializeAiInsight } from '../lib/serialize.js';
import { type AuthVariables, requireAuth } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/subscription.js';
import { validate } from '../middleware/validate.js';

export const aiRoutes = new Hono<{ Variables: AuthVariables }>();

// Scoped to this router's own paths, not '*'. These routes are mounted at the
// /api/v1 root, so a '*' matcher registers middleware for the whole API and
// intercepts requests destined for routers mounted after it — which is how
// /lab-partner/* and the public content routes ended up behind a patient
// subscription check. See apps/api/test/route-mounting.test.ts.
aiRoutes.use('/ai/*', requireAuth, requireActiveSubscription);

aiRoutes.get('/ai/insights/me', async (c) => {
  const userId = c.get('userId');
  const rows = await db
    .select()
    .from(aiInsights)
    .where(and(eq(aiInsights.userId, userId), eq(aiInsights.status, 'published')))
    .orderBy(desc(aiInsights.publishedAt));
  return c.json({ insights: rows.map(serializeAiInsight) });
});

aiRoutes.post('/ai/insights/me/generate', async (c) => {
  const userId = c.get('userId');
  const config = await getAiConfig();
  if (!config.enabled) fail('unprocessable', 'AI is disabled.');
  if (!config.allow_user_generate) {
    fail('forbidden', 'Self-service generation is disabled. Your insights are prepared for you.');
  }
  const count = await generateAndStoreInsights(userId, config, 'user');
  return c.json({ success: true, generated: count, pending_review: config.require_review });
});

aiRoutes.get('/ai/chat/me', async (c) => {
  const userId = c.get('userId');
  const rows = await db
    .select()
    .from(aiChatMessages)
    .where(eq(aiChatMessages.userId, userId))
    .orderBy(asc(aiChatMessages.seq))
    .limit(100);
  return c.json({ messages: rows.map(serializeAiChatMessage) });
});

aiRoutes.post('/ai/chat/me', validate('json', chatInputSchema), async (c) => {
  const userId = c.get('userId');
  const { message } = c.req.valid('json');
  const config = await getAiConfig();
  const reply = await chatReply(userId, message, config);
  return c.json({ reply });
});
