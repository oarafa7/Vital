/**
 * Provisions or repairs an administrator account. CLI only — there is
 * deliberately no HTTP endpoint that can grant `admin`, so no request from any
 * client can escalate itself.
 *
 *   # promote an existing, complete account
 *   pnpm --filter @vital/api db:ensure-admin ops@vital.app
 *
 *   # create the very first admin (identity + profile together)
 *   VITAL_ADMIN_PASSWORD='…' pnpm --filter @vital/api db:ensure-admin ops@vital.app --create --full-name="Ops Team"
 *
 * Idempotent: running it against an account that is already an admin is a
 * no-op success. It never deletes anything, and it never prints the password.
 *
 * Handles all four states the identity model can be in:
 *
 *   identity + profile   → set role = 'admin'
 *   identity, no profile → provision the missing profile with role 'admin'
 *   profile, no identity → refuse; an operator must decide (see db:check-users)
 *   neither              → create both, with rollback if the profile fails
 */
import { eq } from 'drizzle-orm';

import { provisionDeps } from '../lib/provisioning-ports.js';
import {
  provisionManagedAccount,
  provisionProfileForExistingIdentity,
} from '../lib/provisioning.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { db } from './client.js';
import { users } from './schema.js';

interface Options {
  email: string;
  create: boolean;
  fullName: string | null;
  phone: string | null;
}

function parseArgs(argv: string[]): Options | null {
  const email = argv.find((a) => !a.startsWith('--'));
  if (!email) return null;
  const get = (flag: string) => {
    const hit = argv.find((a) => a.startsWith(`${flag}=`));
    return hit ? hit.slice(flag.length + 1) : null;
  };
  return {
    email: email.trim().toLowerCase(),
    create: argv.includes('--create'),
    fullName: get('--full-name'),
    phone: get('--phone'),
  };
}

/** Finds the Auth identity for an address, paging as needed. */
async function findAuthUserByEmail(email: string) {
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Could not list Supabase Auth users: ${error.message}`);
    const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < perPage) return null;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error(
      'Usage: db:ensure-admin <email> [--create] [--full-name="Name"] [--phone=+20…]\n' +
        '  --create requires the VITAL_ADMIN_PASSWORD environment variable.',
    );
    process.exit(1);
  }

  const authUser = await findAuthUserByEmail(opts.email);
  const [profile] = await db.select().from(users).where(eq(users.email, opts.email)).limit(1);

  // ── identity + profile ─────────────────────────────────────────────────────
  if (authUser && profile) {
    if (profile.id !== authUser.id) {
      console.error(
        `Refusing to act: "${opts.email}" is a split identity.\n` +
          `  auth.users.id    ${authUser.id}\n` +
          `  public.users.id  ${profile.id}\n` +
          'These are different users to the database. Run db:check-users and reconcile deliberately.',
      );
      process.exit(1);
    }
    if (profile.role === 'admin') {
      console.log(`${opts.email} is already an admin (${profile.id}). Nothing to do.`);
      process.exit(0);
    }
    const [updated] = await db
      .update(users)
      .set({ role: 'admin', updatedAt: new Date() })
      .where(eq(users.id, profile.id))
      .returning({ id: users.id, email: users.email, role: users.role });
    console.log(`Promoted ${updated?.email} → ${updated?.role} (${updated?.id})`);
    process.exit(0);
  }

  // ── identity, no profile: repair the orphan into an admin ──────────────────
  if (authUser && !profile) {
    const fullName =
      opts.fullName ??
      (typeof authUser.user_metadata?.full_name === 'string'
        ? authUser.user_metadata.full_name
        : null);
    if (!fullName) {
      console.error(
        `"${opts.email}" has an Auth identity (${authUser.id}) but no profile, and no name to\n` +
          'create one with. Re-run with --full-name="Their Name".',
      );
      process.exit(1);
    }

    const result = await provisionProfileForExistingIdentity(provisionDeps, {
      id: authUser.id,
      email: opts.email,
      fullName,
      phone: opts.phone ?? authUser.phone ?? null,
      role: 'admin',
    });

    if (!result.ok) {
      console.error(`Could not provision the profile: ${result.kind}`);
      if (result.kind === 'profile_conflict') {
        console.error(
          `  Another profile already holds ${opts.email}. Run db:check-users and reconcile.`,
        );
      }
      process.exit(1);
    }
    console.log(`Provisioned admin profile for existing identity ${authUser.id}.`);
    process.exit(0);
  }

  // ── profile, no identity ───────────────────────────────────────────────────
  if (!authUser && profile) {
    console.error(
      `"${opts.email}" has a profile (${profile.id}) but no Auth identity, so it cannot sign in.\n` +
        'Creating a new identity would give it a different id, which is the split this system\n' +
        'is designed to prevent. Decide deliberately — see db:check-users.',
    );
    process.exit(1);
  }

  // ── neither: create both ───────────────────────────────────────────────────
  if (!opts.create) {
    console.error(
      `No account exists for "${opts.email}".\n` +
        'Re-run with --create and VITAL_ADMIN_PASSWORD set to create one.',
    );
    process.exit(1);
  }

  const password = process.env.VITAL_ADMIN_PASSWORD;
  if (!password) {
    console.error(
      'VITAL_ADMIN_PASSWORD is not set. Pass it via the environment, not a CLI flag,\n' +
        'so it does not land in your shell history or the process list.',
    );
    process.exit(1);
  }
  if (!opts.fullName) {
    console.error('--full-name="Their Name" is required when creating a new admin.');
    process.exit(1);
  }

  const result = await provisionManagedAccount(provisionDeps, {
    email: opts.email,
    password,
    fullName: opts.fullName,
    phone: opts.phone ?? undefined,
    role: 'admin',
  });

  if (!result.ok) {
    console.error(`Could not create the admin account: ${result.kind}`);
    process.exit(1);
  }

  console.log(`Created admin ${opts.email} (${(result.row as { id: string }).id}).`);
  console.log('Sign in through the admin app to verify. The password was not logged.');
  process.exit(0);
}

main().catch((err) => {
  console.error('ensure-admin failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
