/**
 * Bearer-token auth middleware. Verifies the Supabase JWT and attaches the
 * authenticated user id + the application user row to the request context.
 *
 * This is the third layer of the Auth ↔ profile invariant (see
 * `lib/provisioning.ts`): a token can be perfectly valid and still belong to an
 * identity with no profile. Such a token is refused here, so a half-provisioned
 * account can never act on the API — and because roles live only on the profile
 * row, no role is ever inferred, defaulted, or read from the token.
 */
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';

import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { UserRow } from '../db/schema.js';
import { errorResponse } from '../lib/http.js';
import { supabaseAdmin } from '../lib/supabase.js';

export interface AuthVariables {
  userId: string;
  user: UserRow;
}

export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header || !header.startsWith('Bearer ')) {
      return errorResponse(c, 'unauthorized', 'Missing or malformed Authorization header');
    }

    const token = header.slice('Bearer '.length).trim();
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data.user) {
      return errorResponse(c, 'unauthorized', 'Invalid or expired session token');
    }

    const [row] = await db.select().from(users).where(eq(users.id, data.user.id)).limit(1);
    if (!row) {
      // A valid identity with no profile. Log it — this should be unreachable
      // now that provisioning is atomic and the FK is in place, so if it ever
      // fires there is a provisioning path that still needs fixing.
      // `db:check-users` lists these; 401 is correct so clients drop the token.
      console.error(
        `[auth] profile missing for authenticated identity ${data.user.id} — orphaned auth user`,
      );
      return errorResponse(c, 'unauthorized', 'User profile not found');
    }

    // Identity and role both come from the verified token + the profile row.
    // Nothing here trusts a client-supplied id, role, or flag.
    c.set('userId', row.id);
    c.set('user', row);
    await next();
  },
);
