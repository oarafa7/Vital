/**
 * Provisioning tests. Run with:
 *   pnpm --filter @vital/api test
 *
 * These exercise the real orchestration in `provisioning.ts` against in-memory
 * fakes for Supabase Auth and the profiles table, so the invariants are checked
 * without a database, a network, or any production credential. That is the
 * whole reason the ports are injected.
 *
 * Covered: successful signup, duplicate email, duplicate phone, profile-insert
 * failure with rollback, the never-null-session rule, orphan self-healing, the
 * split-identity conflict, managed (admin-created) provisioning, and the login
 * outcomes including the missing-profile case.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { signupSchema } from '@vital/shared';

import {
  coerceRole,
  existingAccountField,
  isUserRole,
  provisionAccount,
  provisionManagedAccount,
  resolveLogin,
  uniqueViolationConstraint,
  type AuthPort,
  type ProfileInput,
  type ProfilePort,
  type ProvisionDeps,
} from './provisioning.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

interface FakeRow extends ProfileInput {}

/** Mimics postgres-js's PostgresError for a unique violation. */
function uniqueViolation(constraint: string) {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint_name: constraint,
  });
}

interface FakeWorld {
  /** auth.users, keyed by id. `unconfirmed` mirrors a null email_confirmed_at. */
  identities: Map<
    string,
    { id: string; email: string; phone?: string; password: string; unconfirmed?: boolean }
  >;
  /** public.users, keyed by id. */
  profiles: Map<string, FakeRow>;
  /** Forces the next profile insert to fail with this error. */
  failNextInsert?: unknown;
  /** Forces sign-in to fail even with the right password. */
  breakSignIn?: boolean;
  /** Forces the compensating delete to fail. */
  breakDelete?: boolean;
  events: string[];
}

function makeWorld(): FakeWorld {
  return { identities: new Map(), profiles: new Map(), events: [] };
}

let idCounter = 0;
function makeDeps(world: FakeWorld): ProvisionDeps<FakeRow> {
  const auth: AuthPort = {
    async createUser({ email, password, phone }) {
      for (const u of world.identities.values()) {
        if (u.email === email) {
          return { userId: null, error: { message: 'already registered', status: 422, code: 'email_exists' } };
        }
        if (phone && u.phone === phone) {
          return { userId: null, error: { message: 'already registered', status: 422, code: 'phone_exists' } };
        }
      }
      const id = `auth-${++idCounter}`;
      world.identities.set(id, { id, email, phone, password });
      return { userId: id, error: null };
    },

    async deleteUser(userId) {
      if (world.breakDelete) return { error: { message: 'auth service unavailable', status: 500 } };
      world.identities.delete(userId);
      return { error: null };
    },

    async signIn({ email, password }) {
      const hit = [...world.identities.values()].find((u) => u.email === email);
      if (!hit || hit.password !== password) {
        // Shape verified against the deployed gotrue: 400 / invalid_credentials.
        return {
          userId: null,
          session: null,
          error: { message: 'Invalid login credentials', status: 400, code: 'invalid_credentials' },
        };
      }
      if (hit.unconfirmed) {
        return {
          userId: null,
          session: null,
          error: { message: 'Email not confirmed', status: 400, code: 'email_not_confirmed' },
        };
      }
      if (world.breakSignIn) {
        return { userId: null, session: null, error: { message: 'gotrue unavailable', status: 500 } };
      }
      return {
        userId: hit.id,
        session: { access_token: `at-${hit.id}`, refresh_token: `rt-${hit.id}` },
        error: null,
      };
    },
  };

  const profiles: ProfilePort<FakeRow> = {
    async findById(id) {
      return world.profiles.get(id) ?? null;
    },
    async insert(input) {
      if (world.failNextInsert !== undefined) {
        const err = world.failNextInsert;
        world.failNextInsert = undefined;
        throw err;
      }
      for (const p of world.profiles.values()) {
        if (p.email === input.email) throw uniqueViolation('users_email_unique');
      }
      world.profiles.set(input.id, input);
      return input;
    },
  };

  return { auth, profiles, log: (event) => void world.events.push(event) };
}

const NEW_USER = {
  email: 'new@example.com',
  password: 'Passw0rd!',
  fullName: 'New User',
  phone: '+201000000001',
};

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — a new signup produces identity + profile + session
// ─────────────────────────────────────────────────────────────────────────────

describe('provisionAccount', () => {
  it('creates the identity, the profile and a usable session', async () => {
    const world = makeWorld();
    const result = await provisionAccount(makeDeps(world), NEW_USER);

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(world.identities.size, 1, 'one auth identity');
    assert.equal(world.profiles.size, 1, 'one profile');

    const identity = [...world.identities.values()][0];
    assert.ok(identity);
    assert.equal(result.row.id, identity.id, 'profile id mirrors the auth id');
    assert.equal(result.row.role, 'user', 'self-signup is always a plain user');
    assert.ok(result.session.access_token, 'access token present');
    assert.ok(result.session.refresh_token, 'refresh token present');
    assert.equal(result.recovered, false);
  });

  // Test 2 — duplicate email
  it('reports a duplicate email without creating a second identity', async () => {
    const world = makeWorld();
    await provisionAccount(makeDeps(world), NEW_USER);

    const again = await provisionAccount(makeDeps(world), {
      ...NEW_USER,
      phone: '+201000000009',
    });

    assert.equal(again.ok, false);
    if (again.ok) return;
    assert.equal(again.kind, 'email_taken');
    assert.equal(world.identities.size, 1, 'no second identity created');
    assert.equal(world.profiles.size, 1, 'no second profile created');
  });

  // Test 3 — duplicate phone
  it('reports a duplicate phone distinctly from a duplicate email', async () => {
    const world = makeWorld();
    await provisionAccount(makeDeps(world), NEW_USER);

    const other = await provisionAccount(makeDeps(world), {
      ...NEW_USER,
      email: 'someone.else@example.com',
    });

    assert.equal(other.ok, false);
    if (other.ok) return;
    assert.equal(other.kind, 'phone_taken', 'must not be misreported as email_taken');
    assert.equal(world.identities.size, 1);
  });

  // Test 4 — profile insert failure rolls the identity back
  it('rolls the Auth identity back when the profile insert throws', async () => {
    const world = makeWorld();
    world.failNextInsert = new Error('connection terminated unexpectedly');

    const result = await provisionAccount(makeDeps(world), NEW_USER);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'provisioning_failed');
    assert.equal(world.identities.size, 0, 'NO ORPHAN: the identity was deleted');
    assert.equal(world.profiles.size, 0);
    assert.ok(world.events.includes('rollback.ok'));
  });

  it('rolls back on a unique violation too, and reports a conflict', async () => {
    const world = makeWorld();
    world.failNextInsert = uniqueViolation('users_email_unique');

    const result = await provisionAccount(makeDeps(world), NEW_USER);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'profile_conflict');
    assert.equal(world.identities.size, 0, 'NO ORPHAN');
  });

  it('reports the orphan loudly when even the rollback fails', async () => {
    const world = makeWorld();
    world.failNextInsert = new Error('db down');
    world.breakDelete = true;

    const result = await provisionAccount(makeDeps(world), NEW_USER);

    assert.equal(result.ok, false);
    assert.equal(world.identities.size, 1, 'orphan survives — nothing else could be done');
    assert.ok(
      world.events.includes('rollback.FAILED_ORPHAN_LEFT'),
      'must log an operator-actionable event',
    );
  });

  // Test 5 — never a success with a null session
  it('never reports success when the session could not be created', async () => {
    const world = makeWorld();
    world.breakSignIn = true;

    const result = await provisionAccount(makeDeps(world), NEW_USER);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'session_failed');
    // The account is complete and usable — deliberately NOT rolled back.
    assert.equal(world.identities.size, 1);
    assert.equal(world.profiles.size, 1);
  });

  // Orphan self-healing
  it('self-heals an orphaned identity when the password proves ownership', async () => {
    const world = makeWorld();
    // An orphan exactly as the old non-atomic signup left them.
    world.identities.set('auth-orphan', {
      id: 'auth-orphan',
      email: NEW_USER.email,
      password: NEW_USER.password,
    });

    const result = await provisionAccount(makeDeps(world), NEW_USER);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.recovered, true, 'flagged as a recovery');
    assert.equal(result.row.id, 'auth-orphan', 'profile adopts the existing identity id');
    assert.equal(world.identities.size, 1, 'no duplicate identity');
    assert.ok(result.session.access_token);
  });

  it('refuses to heal an orphan without the correct password', async () => {
    const world = makeWorld();
    world.identities.set('auth-orphan', {
      id: 'auth-orphan',
      email: NEW_USER.email,
      password: 'the-real-password',
    });

    const result = await provisionAccount(makeDeps(world), {
      ...NEW_USER,
      password: 'a-guess',
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'email_taken', 'leaks nothing about the account state');
    assert.equal(world.profiles.size, 0, 'no profile claimed');
  });

  it('reports a split identity as a conflict needing an operator', async () => {
    const world = makeWorld();
    // The abdelrahman@bridgefi.me shape: identity and profile, different ids.
    world.identities.set('auth-new', {
      id: 'auth-new',
      email: NEW_USER.email,
      password: NEW_USER.password,
    });
    world.profiles.set('profile-old', {
      id: 'profile-old',
      email: NEW_USER.email,
      fullName: 'Older Profile',
      phone: null,
      role: 'user',
    });

    const result = await provisionAccount(makeDeps(world), NEW_USER);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'profile_conflict');
    assert.equal(result.constraint, 'users_email_unique');
    assert.equal(world.identities.size, 1, 'the pre-existing identity is NOT deleted');
    assert.equal(world.profiles.size, 1, 'the pre-existing profile is NOT touched');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7/8 — managed (admin-created) accounts carry a role and mint no session
// ─────────────────────────────────────────────────────────────────────────────

describe('provisionManagedAccount', () => {
  it('creates a partner with the requested role and no session', async () => {
    const world = makeWorld();
    const result = await provisionManagedAccount(makeDeps(world), {
      ...NEW_USER,
      role: 'lab_partner',
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.row.role, 'lab_partner');
    assert.ok(!('session' in result), 'an operator never mints a session for someone else');
  });

  it('rolls the identity back when the managed profile insert fails', async () => {
    const world = makeWorld();
    world.failNextInsert = new Error('db down');

    const result = await provisionManagedAccount(makeDeps(world), {
      ...NEW_USER,
      role: 'lab_partner',
    });

    assert.equal(result.ok, false);
    assert.equal(world.identities.size, 0, 'NO ORPHAN from an admin-created account either');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5/6 — login outcomes
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveLogin', () => {
  it('returns a session and the profile for valid credentials', async () => {
    const world = makeWorld();
    await provisionAccount(makeDeps(world), NEW_USER);

    const outcome = await resolveLogin(makeDeps(world), {
      email: NEW_USER.email,
      password: NEW_USER.password,
    });

    assert.equal(outcome.kind, 'ok');
    if (outcome.kind !== 'ok') return;
    assert.ok(outcome.session.access_token);
    assert.equal(outcome.row.email, NEW_USER.email);
  });

  it('rejects a wrong password as invalid credentials', async () => {
    const world = makeWorld();
    await provisionAccount(makeDeps(world), NEW_USER);

    const outcome = await resolveLogin(makeDeps(world), {
      email: NEW_USER.email,
      password: 'wrong',
    });

    assert.equal(outcome.kind, 'invalid_credentials');
  });

  it('distinguishes an unconfirmed address from a wrong password', async () => {
    const world = makeWorld();
    world.identities.set('auth-unconfirmed', {
      id: 'auth-unconfirmed',
      email: NEW_USER.email,
      password: NEW_USER.password,
      unconfirmed: true,
    });

    const outcome = await resolveLogin(makeDeps(world), {
      email: NEW_USER.email,
      password: NEW_USER.password,
    });

    // The password was correct — reporting this as a credential failure is what
    // made unconfirmed accounts look permanently unreachable.
    assert.equal(outcome.kind, 'email_not_confirmed');
  });

  it('distinguishes a missing profile from a credential problem', async () => {
    const world = makeWorld();
    world.identities.set('auth-orphan', {
      id: 'auth-orphan',
      email: NEW_USER.email,
      password: NEW_USER.password,
    });

    const outcome = await resolveLogin(makeDeps(world), {
      email: NEW_USER.email,
      password: NEW_USER.password,
    });

    assert.equal(outcome.kind, 'profile_missing', 'must not be reported as a bad password');
    if (outcome.kind !== 'profile_missing') return;
    assert.equal(outcome.userId, 'auth-orphan');
    assert.ok(world.events.includes('login.profile_missing'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Error classification and roles
// ─────────────────────────────────────────────────────────────────────────────

describe('error classification', () => {
  it('uses structured codes, not the word "already"', () => {
    assert.equal(existingAccountField({ message: 'x', code: 'email_exists' }), 'email');
    assert.equal(existingAccountField({ message: 'x', code: 'phone_exists' }), 'phone');
    assert.equal(existingAccountField({ message: 'x', code: 'user_already_exists' }), 'email');
    // No code: only a 422 may fall back to the message.
    assert.equal(
      existingAccountField({ message: 'Phone number already registered', status: 422 }),
      'phone',
    );
    assert.equal(
      existingAccountField({ message: 'A user with this email already exists', status: 422 }),
      'email',
    );
    // The old fragile match: this must NOT be classified as a duplicate.
    assert.equal(
      existingAccountField({ message: 'Signups are already disabled', status: 500 }),
      null,
    );
    assert.equal(existingAccountField(null), null);
  });

  it('finds a unique violation through a wrapped cause chain', () => {
    const direct = uniqueViolation('users_email_unique');
    assert.equal(uniqueViolationConstraint(direct), 'users_email_unique');

    const wrapped = new Error('Failed query');
    (wrapped as Error & { cause?: unknown }).cause = direct;
    assert.equal(uniqueViolationConstraint(wrapped), 'users_email_unique');

    assert.equal(uniqueViolationConstraint(new Error('timeout')), null);
    assert.equal(uniqueViolationConstraint(null), null);
  });
});

describe('roles', () => {
  it('accepts exactly the three application roles', () => {
    assert.ok(isUserRole('user'));
    assert.ok(isUserRole('admin'));
    assert.ok(isUserRole('lab_partner'));
    assert.ok(!isUserRole('superadmin'));
    assert.ok(!isUserRole(''));
    assert.ok(!isUserRole(undefined));
  });

  it('degrades an unrecognised stored role to least privilege', () => {
    assert.equal(coerceRole('admin'), 'admin');
    assert.equal(coerceRole('root'), 'user');
    assert.equal(coerceRole(null), 'user');
  });

  it('strips a client-supplied role from the signup payload', () => {
    // Privilege escalation guard. The route hardcodes role: 'user', and the
    // schema must not carry an attacker-supplied role through to it. This fails
    // if anyone adds a `role` field here or makes the object passthrough.
    const parsed = signupSchema.parse({
      full_name: 'Attacker Person',
      email: 'attacker@example.com',
      password: 'Passw0rd!',
      phone: '+201000000002',
      accepted_terms: true,
      role: 'admin',
    });

    assert.ok(!('role' in parsed), 'signupSchema must not accept a role');
  });
});
