/**
 * READ-ONLY identity integrity check.
 *
 *   pnpm --filter @vital/api db:check-users
 *   pnpm --filter @vital/api db:check-users -- --json
 *
 * Answers, from the live database and Supabase Auth:
 *
 *   How many Auth users / profiles / matched?
 *   How many Auth-only (orphaned identities)?
 *   How many profile-only (profiles with no identity)?
 *   Any duplicate emails or phones among profiles?
 *   Any role values outside (user, admin, lab_partner)?
 *   Any application rows referencing a user that does not exist?
 *   Is the auth.users foreign key validated yet?
 *
 * This command NEVER writes. It issues SELECTs and Auth Admin GETs only, and
 * contains no delete, insert, or update path — by design, so it is safe to run
 * against production. Repairing what it finds is a separate, deliberate act:
 *   * a user retrying signup with the same password self-heals their own
 *     missing profile (see lib/provisioning.ts)
 *   * `db:ensure-admin` provisions or promotes an operator account
 *   * `db:reset-dev-users` reconciles both sides, development only
 *
 * Exit code is 1 when any inconsistency is found, so CI can gate on it.
 */
import { sql } from 'drizzle-orm';

import { env } from '../lib/env.js';
import { USER_ROLES } from '../lib/provisioning.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { db } from './client.js';

interface AuthUser {
  id: string;
  email: string;
  createdAt: string | null;
  confirmed: boolean;
  lastSignInAt: string | null;
  phone: string | null;
  hasFullNameMetadata: boolean;
}

/** Every table that points at a user, with the column that does the pointing. */
const USER_REFERENCES: { table: string; column: string }[] = [
  { table: 'subscriptions', column: 'user_id' },
  { table: 'user_biomarker_results', column: 'user_id' },
  { table: 'lab_uploads', column: 'user_id' },
  { table: 'lab_uploads', column: 'uploaded_by' },
  { table: 'score_snapshots', column: 'user_id' },
  { table: 'ai_chat_messages', column: 'user_id' },
  { table: 'ai_insights', column: 'user_id' },
  { table: 'ai_chat_summaries', column: 'user_id' },
  { table: 'notifications', column: 'user_id' },
  { table: 'device_tokens', column: 'user_id' },
  { table: 'bookings', column: 'user_id' },
  { table: 'addon_orders', column: 'user_id' },
  { table: 'lab_partner_areas', column: 'partner_id' },
];

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable)';
  }
}

/** Pages through the Auth Admin API, which caps out at 1000 users per page. */
async function listAuthUsers(): Promise<AuthUser[]> {
  const out: AuthUser[] = [];
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Could not list Supabase Auth users: ${error.message}`);
    for (const u of data.users) {
      out.push({
        id: u.id,
        email: u.email ?? '(no email)',
        createdAt: u.created_at ?? null,
        confirmed: !!u.email_confirmed_at,
        lastSignInAt: u.last_sign_in_at ?? null,
        phone: u.phone || null,
        hasFullNameMetadata: !!u.user_metadata?.full_name,
      });
    }
    if (data.users.length < perPage) break;
  }
  return out;
}

async function main() {
  const asJson = process.argv.includes('--json');

  const authUsers = await listAuthUsers();

  const profiles = await db.execute<{
    id: string;
    email: string;
    phone: string | null;
    role: string;
    full_name: string;
    created_at: string;
  }>(sql`SELECT id, email, phone, role, full_name, created_at FROM users ORDER BY created_at`);

  const profileRows = [...profiles];
  const profileById = new Map(profileRows.map((p) => [p.id, p]));
  const authById = new Map(authUsers.map((a) => [a.id, a]));

  // ── Identity reconciliation, always joined on id — never on email ──────────
  const authOnly = authUsers.filter((a) => !profileById.has(a.id));
  const profileOnly = profileRows.filter((p) => !authById.has(p.id));
  const matched = authUsers.filter((a) => profileById.has(a.id));

  // ── Duplicates among profiles ─────────────────────────────────────────────
  const byEmail = new Map<string, string[]>();
  const byPhone = new Map<string, string[]>();
  for (const p of profileRows) {
    const e = (p.email ?? '').toLowerCase();
    if (e) byEmail.set(e, [...(byEmail.get(e) ?? []), p.id]);
    const ph = (p.phone ?? '').replace(/\D/g, '');
    if (ph) byPhone.set(ph, [...(byPhone.get(ph) ?? []), p.id]);
  }
  const duplicateEmails = [...byEmail.entries()].filter(([, ids]) => ids.length > 1);
  const duplicatePhones = [...byPhone.entries()].filter(([, ids]) => ids.length > 1);

  // An Auth-only identity whose address is held by a *different* profile: the
  // `auth.id != profile.id` split, which signup cannot self-heal.
  const splitIdentities = authOnly
    .map((a) => ({ auth: a, profile: byEmail.get(a.email.toLowerCase())?.[0] }))
    .filter((x): x is { auth: AuthUser; profile: string } => !!x.profile);

  const invalidRoles = profileRows.filter(
    (p) => !(USER_ROLES as readonly string[]).includes(p.role),
  );

  // ── Application rows pointing at a user that does not exist ───────────────
  const danglingReferences: { table: string; column: string; count: number }[] = [];
  for (const ref of USER_REFERENCES) {
    const result = await db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n
            FROM ${sql.identifier(ref.table)} t
            LEFT JOIN users u ON u.id = t.${sql.identifier(ref.column)}
           WHERE t.${sql.identifier(ref.column)} IS NOT NULL
             AND u.id IS NULL`,
    );
    const n = [...result][0]?.n ?? 0;
    if (n > 0) danglingReferences.push({ ...ref, count: n });
  }

  // ── Is the auth.users FK validated? ───────────────────────────────────────
  const fkState = await db.execute<{ conname: string; convalidated: boolean }>(
    sql`SELECT conname, convalidated
          FROM pg_constraint
         WHERE conname IN ('users_id_auth_users_id_fk', 'users_role_check')`,
  );
  const constraints = [...fkState];

  const problems =
    authOnly.length +
    profileOnly.length +
    duplicateEmails.length +
    duplicatePhones.length +
    invalidRoles.length +
    danglingReferences.length;

  const report = {
    supabase_project: safeHost(env.SUPABASE_URL).split('.')[0],
    database_host: safeHost(env.DATABASE_URL.replace(/^postgres(ql)?:\/\//, 'https://')),
    totals: {
      auth_users: authUsers.length,
      profiles: profileRows.length,
      matched: matched.length,
      auth_only: authOnly.length,
      profile_only: profileOnly.length,
    },
    auth_only: authOnly.map((a) => ({
      id: a.id,
      email: a.email,
      phone: a.phone,
      created_at: a.createdAt,
      email_confirmed: a.confirmed,
      last_sign_in_at: a.lastSignInAt,
      can_self_heal_on_signup: !byEmail.has(a.email.toLowerCase()),
    })),
    profile_only: profileOnly.map((p) => ({
      id: p.id,
      email: p.email,
      phone: p.phone,
      role: p.role,
      created_at: p.created_at,
    })),
    split_identities: splitIdentities.map((s) => ({
      email: s.auth.email,
      auth_id: s.auth.id,
      profile_id: s.profile,
    })),
    duplicate_profile_emails: duplicateEmails,
    duplicate_profile_phones: duplicatePhones,
    invalid_roles: invalidRoles.map((p) => ({ id: p.id, role: p.role })),
    dangling_user_references: danglingReferences,
    constraints,
    problems,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(problems > 0 ? 1 : 0);
  }

  console.log('VITAL — identity integrity check (read-only)');
  console.log(`  Supabase project   ${report.supabase_project}`);
  console.log(`  Database           ${report.database_host}`);
  console.log('');
  console.log(`  auth.users         ${report.totals.auth_users}`);
  console.log(`  public.users       ${report.totals.profiles}`);
  console.log(`  matched            ${report.totals.matched}`);
  console.log(`  auth only          ${report.totals.auth_only}   (orphaned identities)`);
  console.log(`  profile only       ${report.totals.profile_only}   (profiles with no identity)`);

  if (authOnly.length) {
    console.log('\n  ORPHANED AUTH IDENTITIES (no profile)');
    for (const a of report.auth_only) {
      const heal = a.can_self_heal_on_signup ? 'self-heals on signup' : 'NEEDS OPERATOR (email held by another profile)';
      console.log(`    ${a.email}  ${a.id}  created ${a.created_at}  → ${heal}`);
    }
  }

  if (profileOnly.length) {
    console.log('\n  PROFILES WITH NO AUTH IDENTITY (cannot sign in)');
    for (const p of report.profile_only) {
      console.log(`    ${p.email}  ${p.id}  role ${p.role}  created ${p.created_at}`);
    }
  }

  if (splitIdentities.length) {
    console.log('\n  SPLIT IDENTITIES (same email, different ids on each side)');
    for (const s of report.split_identities) {
      console.log(`    ${s.email}  auth ${s.auth_id}  profile ${s.profile_id}`);
    }
  }

  if (duplicateEmails.length) {
    console.log('\n  DUPLICATE PROFILE EMAILS');
    for (const [email, ids] of duplicateEmails) console.log(`    ${email}  ${ids.join(', ')}`);
  }
  if (duplicatePhones.length) {
    console.log('\n  DUPLICATE PROFILE PHONES');
    for (const [phone, ids] of duplicatePhones) console.log(`    ${phone}  ${ids.join(', ')}`);
  }
  if (invalidRoles.length) {
    console.log('\n  INVALID ROLE VALUES');
    for (const p of report.invalid_roles) console.log(`    ${p.id}  role=${p.role}`);
  }
  if (danglingReferences.length) {
    console.log('\n  APPLICATION ROWS REFERENCING A MISSING USER');
    for (const d of danglingReferences) console.log(`    ${d.table}.${d.column}  ${d.count} row(s)`);
  }

  console.log('\n  CONSTRAINTS');
  if (!constraints.length) {
    console.log('    users_id_auth_users_id_fk  MISSING — migration 0015 has not been applied');
  }
  for (const c of constraints) {
    console.log(`    ${c.conname}  ${c.convalidated ? 'validated' : 'NOT VALID (enforced for new rows only)'}`);
  }

  console.log(
    problems === 0
      ? '\nNo inconsistencies found.'
      : `\n${problems} inconsistency group(s) found. Nothing was changed — this command is read-only.`,
  );
  process.exit(problems > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Check failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
