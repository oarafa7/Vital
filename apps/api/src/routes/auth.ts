/**
 * Auth routes — signup, login, logout, password reset.
 *
 * The Auth ↔ profile invariant is owned by `lib/provisioning.ts`; this file is
 * the HTTP layer over it. Two rules hold for every response here:
 *
 *   1. A success response always carries a usable session. There is no
 *      201-with-a-null-token: that used to tell clients signup had worked while
 *      leaving them signed out and waiting for an email nobody sent.
 *   2. Clients never receive database errors, SQL, provider internals, or
 *      stack traces. Diagnostics go to the server log via `provisionLogger`.
 *
 * Email confirmation: accounts are created with `email_confirm: true`. The
 * Admin API does not send confirmation mail (only signUp / inviteUserByEmail /
 * generateLink do), and this flow returns a session immediately, so creating
 * unconfirmed identities produced accounts nobody could reach. Turning on a
 * real verification flow means sending the mail, configuring the production
 * redirect, and reworking the clients to wait for it — see the
 * "Email confirmation" section of AUTH_ARCHITECTURE.md.
 */
import { loginSchema, resetPasswordSchema, signupSchema } from '@vital/shared';
import { Hono } from 'hono';

import { errorResponse } from '../lib/http.js';
import { provisionDeps } from '../lib/provisioning-ports.js';
import { provisionAccount, resolveLogin, type ProvisionFailure } from '../lib/provisioning.js';
import { serializeUser } from '../lib/serialize.js';
import { supabaseAdmin } from '../lib/supabase.js';
import { validate } from '../middleware/validate.js';

export const authRoutes = new Hono();

const EMAIL_TAKEN = 'An account with this email already exists. Try signing in instead.';
const PHONE_TAKEN = 'This phone number is already registered to another account.';
const NEEDS_SUPPORT =
  'This email is linked to an account we could not finish setting up. Please contact support.';
const GENERIC_FAILURE = 'Could not create your account. Please try again.';
const SESSION_FAILED =
  'Your account was created, but we could not sign you in automatically. Please sign in.';

/** Maps a typed provisioning failure onto the project's error envelope. */
function respondToFailure(c: Parameters<typeof errorResponse>[0], failure: ProvisionFailure) {
  switch (failure.kind) {
    case 'email_taken':
      return errorResponse(c, 'conflict', EMAIL_TAKEN);
    case 'phone_taken':
      return errorResponse(c, 'conflict', PHONE_TAKEN);
    case 'profile_conflict':
      // An identity exists with no profile, and a *different* profile holds the
      // address. Needs an operator — `db:check-users` reports the pair.
      return errorResponse(c, 'conflict', NEEDS_SUPPORT);
    case 'auth_failed':
      // Supabase-side or configuration problem; the payload already passed
      // `signupSchema`. The real message can name provider internals.
      return errorResponse(c, 'unprocessable', GENERIC_FAILURE);
    case 'provisioning_failed':
      return errorResponse(c, 'server_error', GENERIC_FAILURE);
    case 'session_failed':
      return errorResponse(c, 'server_error', SESSION_FAILED);
  }
}

authRoutes.post('/signup', validate('json', signupSchema), async (c) => {
  const { email, password, full_name, phone } = c.req.valid('json');

  const result = await provisionAccount(provisionDeps, {
    email,
    password,
    fullName: full_name,
    phone,
    // Role is never taken from the request. Self-signup is always a plain user;
    // admin and lab_partner are provisioned by an operator or an admin.
    role: 'user',
  });

  if (!result.ok) return respondToFailure(c, result);

  return c.json(
    {
      user: serializeUser(result.row),
      access_token: result.session.access_token,
      refresh_token: result.session.refresh_token,
    },
    201,
  );
});

authRoutes.post('/login', validate('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');

  const outcome = await resolveLogin(provisionDeps, { email, password });

  switch (outcome.kind) {
    case 'invalid_credentials':
      return errorResponse(c, 'unauthorized', 'That email and password combination is not correct.');

    case 'email_not_confirmed':
      // Distinct from bad credentials: the password was right. Reporting this
      // as a wrong password is what made unconfirmed accounts look unreachable.
      return errorResponse(
        c,
        'forbidden',
        'Your email address has not been confirmed yet. Please confirm it and try again.',
      );

    case 'profile_missing':
      // Authenticated, but no profile — a provisioning inconsistency, not a
      // user error. No token is issued: a profile-less session cannot do
      // anything except fail `requireAuth` on every request.
      return errorResponse(
        c,
        'conflict',
        'Your account setup is incomplete. Please sign up again with this email address to finish setting it up.',
      );

    case 'ok':
      return c.json({
        user: serializeUser(outcome.row),
        access_token: outcome.session.access_token,
        refresh_token: outcome.session.refresh_token,
        // Retained for the existing mobile/web/admin/partner clients.
        user_id: outcome.userId,
      });
  }
});

authRoutes.post('/logout', async (c) => {
  const header = c.req.header('Authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : null;
  if (token) {
    await supabaseAdmin.auth.admin.signOut(token).catch(() => undefined);
  }
  return c.json({ success: true });
});

authRoutes.post('/reset-password', validate('json', resetPasswordSchema), async (c) => {
  const { email } = c.req.valid('json');
  // Always 200 to avoid leaking which emails are registered.
  //
  // NOTE: the link Supabase sends points at the project's configured Site URL.
  // If that is still a localhost value the email is useless in production —
  // see "Supabase URL configuration" in AUTH_ARCHITECTURE.md. That is dashboard
  // state, not something this code can set.
  await supabaseAdmin.auth.resetPasswordForEmail(email).catch(() => undefined);
  return c.json({ success: true });
});
