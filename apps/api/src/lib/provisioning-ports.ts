/**
 * The real `AuthPort` / `ProfilePort` implementations behind `provisioning.ts`.
 *
 * Kept separate from the orchestration so the orchestration can be unit-tested
 * with fakes (see provisioning.test.ts) — and so there is exactly one place
 * where Supabase Auth and the `users` table are touched for provisioning.
 */
import { eq } from 'drizzle-orm';

import { db } from '../db/client.js';
import { users, type UserRow } from '../db/schema.js';
import type { AuthPort, ProfilePort, ProvisionLogger } from './provisioning.js';
import { supabaseAdmin } from './supabase.js';

export const authPort: AuthPort = {
  async createUser({ email, password, phone, emailConfirm, metadata }) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      phone,
      email_confirm: emailConfirm,
      user_metadata: metadata,
    });
    return {
      userId: data?.user?.id ?? null,
      error: error ? { message: error.message, status: error.status, code: error.code } : null,
    };
  },

  async deleteUser(userId) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    return {
      error: error ? { message: error.message, status: error.status, code: error.code } : null,
    };
  },

  async signIn({ email, password }) {
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });
    const session = data?.session
      ? { access_token: data.session.access_token, refresh_token: data.session.refresh_token }
      : null;
    return {
      userId: data?.user?.id ?? null,
      session,
      error: error ? { message: error.message, status: error.status, code: error.code } : null,
    };
  },
};

export const profilePort: ProfilePort<UserRow> = {
  async findById(id) {
    const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ?? null;
  },

  async insert({ id, email, fullName, phone, role }) {
    // Deliberately not `.onConflictDoNothing()`: a conflict is information the
    // caller must act on, not something to swallow.
    const [row] = await db.insert(users).values({ id, email, fullName, phone, role }).returning();
    return row ?? null;
  },
};

/**
 * Structured server-side logging for provisioning. Receives ids and reasons
 * only — never a password, token, connection string, or key.
 */
export const provisionLogger: ProvisionLogger = (event, detail) => {
  const parts = Object.entries(detail)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  console.error(`[provisioning] ${event} ${parts}`);
};

export const provisionDeps = {
  auth: authPort,
  profiles: profilePort,
  log: provisionLogger,
};
