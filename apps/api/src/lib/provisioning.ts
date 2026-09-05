/**
 * Account provisioning — the single place that owns the Auth ↔ profile invariant.
 *
 * VITAL keeps an identity in Supabase Auth (`auth.users`) and a profile in
 * `public.users` sharing the same UUID. Those live in two systems that cannot
 * share a transaction: Auth is reached over HTTPS, the profile over Postgres.
 * The invariant we enforce is therefore maintained in three layers:
 *
 *   1. Database   — `public.users.id` REFERENCES `auth.users(id)` ON DELETE
 *                   CASCADE (migration 0015). A profile without an identity is
 *                   impossible, and deleting the identity removes the profile.
 *   2. This file  — every account-creating path funnels through
 *                   `provisionAccount`, which rolls the Auth user back if the
 *                   profile cannot be written, and can re-provision a profile
 *                   for an identity that lost one.
 *   3. Middleware — `requireAuth` refuses a token whose profile is missing, so
 *                   a half-provisioned account can never act on the API.
 *
 * Everything here is dependency-injected through `AuthPort`/`ProfilePort` so
 * the orchestration is unit-testable without a database or a network. The real
 * ports are built in `provisioning-ports.ts`.
 */
import type { UserRole } from '@vital/shared';

// ─────────────────────────────────────────────────────────────────────────────
// Roles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The authoritative role list. Authorization is resolved from
 * `public.users.role` only — never from `user_metadata`, `app_metadata`, JWT
 * claims, or anything the client sends. Mirrored by a CHECK constraint in
 * migration 0015 and by `UserRole` in @vital/shared.
 */
export const USER_ROLES = ['user', 'admin', 'lab_partner'] as const satisfies readonly UserRole[];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** Narrows a stored role, defaulting to the least-privileged value. */
export function coerceRole(value: unknown): UserRole {
  return isUserRole(value) ? value : 'user';
}

// ─────────────────────────────────────────────────────────────────────────────
// Error classification
// ─────────────────────────────────────────────────────────────────────────────

/** Postgres SQLSTATE for a unique-constraint violation. */
export const PG_UNIQUE_VIOLATION = '23505';

/** The parts of a Supabase auth error we act on. */
export interface AuthErrorLike {
  message: string;
  status?: number;
  code?: string;
}

interface PgErrorShape {
  code?: string;
  constraint_name?: string;
  cause?: unknown;
}

/**
 * Digs the driver error out of whatever Drizzle threw. postgres-js raises a
 * `PostgresError` carrying `code` and `constraint_name`; depending on the
 * Drizzle version it can arrive wrapped, so follow the `cause` chain instead
 * of pattern-matching on the message.
 */
export function findPgError(err: unknown, depth = 0): PgErrorShape | null {
  if (depth > 3 || typeof err !== 'object' || err === null) return null;
  const candidate = err as PgErrorShape;
  if (typeof candidate.code === 'string') return candidate;
  return findPgError(candidate.cause, depth + 1);
}

/** The constraint a unique violation hit, or null if this isn't one. */
export function uniqueViolationConstraint(err: unknown): string | null {
  const pg = findPgError(err);
  if (pg?.code !== PG_UNIQUE_VIOLATION) return null;
  return pg.constraint_name ?? '(unknown constraint)';
}

/**
 * Which field an existing Auth identity collided on, from Supabase's
 * structured error code. Older gotrue builds omit `code`, so fall back to the
 * message — but only on a 422, and never on the bare presence of the word
 * "already", which also appears in unrelated failures and used to make a
 * duplicate *phone* report itself as a duplicate *email*.
 */
export function existingAccountField(error: AuthErrorLike | null): 'email' | 'phone' | null {
  if (!error) return null;

  if (error.code === 'email_exists' || error.code === 'user_already_exists') return 'email';
  if (error.code === 'phone_exists') return 'phone';

  if (error.status !== 422) return null;
  const message = error.message.toLowerCase();
  if (/phone.*(already|registered|exists)/.test(message)) return 'phone';
  if (/(email|user).*(already|registered|exists)/.test(message)) return 'email';
  return null;
}

/** True when Supabase refused a sign-in because the address is unconfirmed. */
export function isEmailNotConfirmed(error: AuthErrorLike | null): boolean {
  if (!error) return false;
  if (error.code === 'email_not_confirmed') return true;
  return /email\s+not\s+confirmed/i.test(error.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Ports
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthSession {
  access_token: string;
  refresh_token: string;
}

export interface AuthPort {
  createUser(input: {
    email: string;
    password: string;
    phone?: string;
    /** Always true today — see the email-confirmation note in routes/auth.ts. */
    emailConfirm: boolean;
    metadata: Record<string, unknown>;
  }): Promise<{ userId: string | null; error: AuthErrorLike | null }>;

  deleteUser(userId: string): Promise<{ error: AuthErrorLike | null }>;

  signIn(input: {
    email: string;
    password: string;
  }): Promise<{ userId: string | null; session: AuthSession | null; error: AuthErrorLike | null }>;
}

export interface ProfileInput {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  role: UserRole;
}

export interface ProfilePort<TRow> {
  findById(id: string): Promise<TRow | null>;
  /** Rejects with the driver error on a constraint violation — do not swallow. */
  insert(input: ProfileInput): Promise<TRow | null>;
}

/** Structured, secret-free diagnostics. Never receives a token or a password. */
export type ProvisionLogger = (event: string, detail: Record<string, unknown>) => void;

export interface ProvisionDeps<TRow> {
  auth: AuthPort;
  profiles: ProfilePort<TRow>;
  log: ProvisionLogger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────

export type ProvisionFailure =
  /** The address already has a complete, usable account. */
  | { kind: 'email_taken' }
  /** The phone number belongs to another identity. */
  | { kind: 'phone_taken' }
  /**
   * An identity exists without a profile, and the profile cannot be created
   * because a *different* profile already holds the address. Needs an operator:
   * this is the `auth.id != profile.id` split.
   */
  | { kind: 'profile_conflict'; constraint: string }
  /** Auth rejected the creation for some other reason (configuration, policy). */
  | { kind: 'auth_failed'; detail: string }
  /** The profile write failed; the Auth user was rolled back. */
  | { kind: 'provisioning_failed'; detail: string }
  /**
   * The account is complete and usable but automatic sign-in failed. NOT rolled
   * back — the user owns a working account and can sign in normally.
   */
  | { kind: 'session_failed'; detail: string };

export type ProvisionResult<TRow> =
  | { ok: true; row: TRow; session: AuthSession; recovered: boolean }
  | ({ ok: false } & ProvisionFailure);

export interface ProvisionRequest {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
  role?: UserRole;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compensating delete for a signup that failed once the identity existed.
 * Never throws: a failed cleanup leaves an orphan for an operator to reconcile
 * (`db:check-users` reports it) and is logged loudly, but it must not mask the
 * original failure.
 */
async function rollbackAuthUser<TRow>(
  deps: ProvisionDeps<TRow>,
  userId: string,
  stage: string,
): Promise<void> {
  try {
    const { error } = await deps.auth.deleteUser(userId);
    if (error) throw new Error(error.message);
    deps.log('rollback.ok', { userId, stage });
  } catch (err) {
    deps.log('rollback.FAILED_ORPHAN_LEFT', {
      userId,
      stage,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Writes the profile row, mapping a unique violation to a typed failure. */
async function writeProfile<TRow>(
  deps: ProvisionDeps<TRow>,
  input: ProfileInput,
): Promise<{ ok: true; row: TRow } | { ok: false; constraint: string | null; detail: string }> {
  try {
    const row = await deps.profiles.insert(input);
    if (!row) return { ok: false, constraint: null, detail: 'insert returned no row' };
    return { ok: true, row };
  } catch (err) {
    const constraint = uniqueViolationConstraint(err);
    return {
      ok: false,
      constraint,
      detail: constraint
        ? `unique violation on ${constraint}`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}

/**
 * Creates a complete account — Auth identity, profile, and session — or leaves
 * nothing behind.
 *
 * Recovery path: when Auth reports the address is taken, we sign in with the
 * supplied password. If that succeeds and the identity has no profile, this is
 * an orphan from the old non-atomic signup and we provision the missing profile
 * rather than dead-ending the user on "email already exists" forever. Proving
 * the password is what makes that safe — an attacker cannot claim a profile for
 * an identity they cannot authenticate as.
 */
export async function provisionAccount<TRow>(
  deps: ProvisionDeps<TRow>,
  req: ProvisionRequest,
): Promise<ProvisionResult<TRow>> {
  const role = req.role ?? 'user';
  const phone = req.phone ?? null;

  const created = await deps.auth.createUser({
    email: req.email,
    password: req.password,
    phone: req.phone,
    emailConfirm: true,
    metadata: { full_name: req.fullName },
  });

  // ── Auth creation failed ────────────────────────────────────────────────────
  if (created.error || !created.userId) {
    const taken = existingAccountField(created.error);

    if (taken === 'phone') return { ok: false, kind: 'phone_taken' };

    if (taken === 'email') {
      const recovery = await recoverOrphan(deps, req, role, phone);
      if (recovery) return recovery;
      return { ok: false, kind: 'email_taken' };
    }

    const detail = created.error?.message ?? 'no user returned';
    deps.log('createUser.failed', { detail });
    return { ok: false, kind: 'auth_failed', detail };
  }

  const userId = created.userId;

  // ── Profile write; roll the identity back on any failure ───────────────────
  const written = await writeProfile(deps, {
    id: userId,
    email: req.email,
    fullName: req.fullName,
    phone,
    role,
  });

  if (!written.ok) {
    await rollbackAuthUser(deps, userId, 'profile insert failed');
    deps.log('provision.failed', { userId, detail: written.detail });

    if (written.constraint) {
      return { ok: false, kind: 'profile_conflict', constraint: written.constraint };
    }
    return { ok: false, kind: 'provisioning_failed', detail: written.detail };
  }

  // ── Session. The account is complete now, so failures here are NOT rolled
  //    back: the user owns a usable account and can sign in from /login. What
  //    must never happen is a success response carrying a null token.
  const signedIn = await deps.auth.signIn({ email: req.email, password: req.password });
  if (signedIn.error || !signedIn.session) {
    const detail = signedIn.error?.message ?? 'no session returned';
    deps.log('signup.session_failed', { userId, detail });
    return { ok: false, kind: 'session_failed', detail };
  }

  return { ok: true, row: written.row, session: signedIn.session, recovered: false };
}

export type ManagedProvisionResult<TRow> =
  | { ok: true; row: TRow }
  | ({ ok: false } & Exclude<ProvisionFailure, { kind: 'session_failed' }>);

/**
 * Creates an account on someone else's behalf — an admin adding a lab partner,
 * or the CLI bootstrapping the first administrator.
 *
 * Same identity/profile atomicity as `provisionAccount`, but no sign-in: the
 * operator must not mint a session for another person, and the new account is
 * expected to log in themselves. There is no orphan-recovery path here either,
 * because that requires proving the account's password.
 */
export async function provisionManagedAccount<TRow>(
  deps: ProvisionDeps<TRow>,
  req: ProvisionRequest & { role: UserRole },
): Promise<ManagedProvisionResult<TRow>> {
  const created = await deps.auth.createUser({
    email: req.email,
    password: req.password,
    phone: req.phone,
    emailConfirm: true,
    metadata: { full_name: req.fullName },
  });

  if (created.error || !created.userId) {
    const taken = existingAccountField(created.error);
    if (taken === 'email') return { ok: false, kind: 'email_taken' };
    if (taken === 'phone') return { ok: false, kind: 'phone_taken' };

    const detail = created.error?.message ?? 'no user returned';
    deps.log('managed.createUser.failed', { detail, role: req.role });
    return { ok: false, kind: 'auth_failed', detail };
  }

  const written = await writeProfile(deps, {
    id: created.userId,
    email: req.email,
    fullName: req.fullName,
    phone: req.phone ?? null,
    role: req.role,
  });

  if (!written.ok) {
    await rollbackAuthUser(deps, created.userId, 'managed profile insert failed');
    deps.log('managed.provision.failed', { userId: created.userId, detail: written.detail });
    if (written.constraint) {
      return { ok: false, kind: 'profile_conflict', constraint: written.constraint };
    }
    return { ok: false, kind: 'provisioning_failed', detail: written.detail };
  }

  deps.log('managed.provision.ok', { userId: created.userId, role: req.role });
  return { ok: true, row: written.row };
}

/**
 * Provisions the missing profile for an Auth identity that already exists —
 * the operator-side repair for an orphan whose owner cannot retry signup.
 * Used by the admin bootstrap CLI, never exposed over HTTP.
 */
export async function provisionProfileForExistingIdentity<TRow>(
  deps: ProvisionDeps<TRow>,
  input: ProfileInput,
): Promise<ManagedProvisionResult<TRow>> {
  const existing = await deps.profiles.findById(input.id);
  if (existing) return { ok: true, row: existing };

  const written = await writeProfile(deps, input);
  if (!written.ok) {
    // Never roll back here: this identity was not created by us.
    deps.log('repair.failed', { userId: input.id, detail: written.detail });
    if (written.constraint) {
      return { ok: false, kind: 'profile_conflict', constraint: written.constraint };
    }
    return { ok: false, kind: 'provisioning_failed', detail: written.detail };
  }

  deps.log('repair.ok', { userId: input.id, role: input.role });
  return { ok: true, row: written.row };
}

/**
 * Handles "this address already has an identity". Returns a result when the
 * situation is resolved (recovered, or definitively a conflict), or null when
 * the caller should report a plain duplicate.
 */
async function recoverOrphan<TRow>(
  deps: ProvisionDeps<TRow>,
  req: ProvisionRequest,
  role: UserRole,
  phone: string | null,
): Promise<ProvisionResult<TRow> | null> {
  const signedIn = await deps.auth.signIn({ email: req.email, password: req.password });

  // Wrong password, or the identity is otherwise unusable. Report a duplicate
  // without revealing anything about the account's internal state.
  if (signedIn.error || !signedIn.session || !signedIn.userId) return null;

  const existing = await deps.profiles.findById(signedIn.userId);
  if (existing) {
    // Complete account. They should sign in, not sign up.
    return { ok: false, kind: 'email_taken' };
  }

  // Orphaned identity: provision the profile it never got.
  deps.log('recover.orphan_detected', { userId: signedIn.userId });

  const written = await writeProfile(deps, {
    id: signedIn.userId,
    email: req.email,
    fullName: req.fullName,
    phone,
    role,
  });

  if (!written.ok) {
    // Deliberately NOT rolling back: this identity predates the request and may
    // be a real account. A different profile holding the address is the
    // `auth.id != profile.id` split, which needs a human.
    deps.log('recover.failed', { userId: signedIn.userId, detail: written.detail });
    if (written.constraint) {
      return { ok: false, kind: 'profile_conflict', constraint: written.constraint };
    }
    return { ok: false, kind: 'provisioning_failed', detail: written.detail };
  }

  deps.log('recover.ok', { userId: signedIn.userId });
  return { ok: true, row: written.row, session: signedIn.session, recovered: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Login
// ─────────────────────────────────────────────────────────────────────────────

export type LoginOutcome<TRow> =
  | { kind: 'ok'; userId: string; row: TRow; session: AuthSession }
  | { kind: 'invalid_credentials' }
  | { kind: 'email_not_confirmed' }
  /** Authenticated, but the profile is missing — a provisioning inconsistency. */
  | { kind: 'profile_missing'; userId: string };

/**
 * Signs a user in and resolves their profile in one step, so a token for an
 * identity with no profile is never handed to a client. Distinguishing these
 * outcomes is why the old endpoint's blanket "email and password is not
 * correct" was wrong: it reported a provisioning bug as a user error.
 */
export async function resolveLogin<TRow>(
  deps: Pick<ProvisionDeps<TRow>, 'auth' | 'profiles' | 'log'>,
  input: { email: string; password: string },
): Promise<LoginOutcome<TRow>> {
  const signedIn = await deps.auth.signIn(input);

  if (signedIn.error || !signedIn.session || !signedIn.userId) {
    if (isEmailNotConfirmed(signedIn.error)) return { kind: 'email_not_confirmed' };
    return { kind: 'invalid_credentials' };
  }

  const row = await deps.profiles.findById(signedIn.userId);
  if (!row) {
    deps.log('login.profile_missing', { userId: signedIn.userId });
    return { kind: 'profile_missing', userId: signedIn.userId };
  }

  return { kind: 'ok', userId: signedIn.userId, row, session: signedIn.session };
}
