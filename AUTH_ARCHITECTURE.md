# VITAL — Authentication & User Provisioning Architecture

Status: implemented 2026-09-04. Supersedes the signup/login sections of
`ARCHITECTURE_AUDIT.md`, which describes the pre-fix flow and is kept as a
point-in-time artifact.

---

## 1. The invariant

```text
                 SUPABASE AUTH  (auth.users)
                      │
                      │ same UUID
                      ▼
                 public.users            ← the only source of authorization
                      │
       ┌──────────────┼───────────────┐
       ▼              ▼               ▼
   bookings     subscriptions     health data
```

> Every application user has exactly one Auth identity, and every Auth identity
> intended to use the application has exactly one `public.users` profile with
> the same id.

Auth lives behind HTTPS and the profile behind Postgres, so the two writes can
never share a transaction. The invariant is therefore held by **three
independent layers**, each of which closes a different failure window:

| Layer | Mechanism | What it makes impossible |
|---|---|---|
| Database | `public.users.id → auth.users(id) ON DELETE CASCADE` (migration 0015) | A profile with no identity. Deleting an identity leaves its profile behind. |
| Application | Every account-creating path goes through `lib/provisioning.ts`, which rolls the identity back if the profile cannot be written | An identity with no profile. |
| Middleware | `requireAuth` refuses a token whose profile is missing | A half-provisioned account acting on the API. |

### Why not a database trigger on `auth.users`

The common Supabase pattern (`handle_new_user` trigger inserting into a
profiles table) was rejected deliberately:

- `full_name` and `phone` come from the signup request. A trigger can only see
  `raw_user_meta_data`, so provisioning quality would depend on metadata being
  populated correctly — and two of the three orphans found in this project had
  no `full_name` metadata at all.
- A trigger failure surfaces as an opaque gotrue 500 with no route-level
  context, and blocks signup entirely.
- It lives outside the repository's migration/test tooling, so it cannot be
  unit-tested and drifts invisibly.

Explicit application provisioning is testable (19 unit tests), produces precise
error messages, and — with the FK plus rollback — has the same end state.

---

## 2. Signup

```text
POST /api/v1/auth/signup
        │
        ▼
signupSchema  ─── invalid ──▶ 400 validation_error   (nothing created)
        │
        ▼
auth.admin.createUser({ email_confirm: true })
        │
        ├── email exists ──▶ recovery path (§3)
        ├── phone exists ──▶ 409 "phone already registered"
        ├── other error  ──▶ 422 generic  (public.users untouched)
        │
        ▼  identity created
INSERT public.users (role = 'user')
        │
        ├── throws / no row ──▶ deleteUser(identity) ──▶ 409 or 500
        │                        └─ NO ORPHAN
        ▼  profile created
signInWithPassword
        │
        ├── fails ──▶ 500 "created, but could not sign you in"
        │              └─ account left intact and usable, NOT rolled back
        ▼
201 { user, access_token, refresh_token }
```

Two rules hold for every response:

1. **A success response always carries a usable session.** There is no
   `201` with a null token — that used to tell clients signup had worked while
   leaving them signed out, waiting for an email nobody sent.
2. **Clients never see internal detail.** No SQL, no driver text, no provider
   internals, no stack traces. Diagnostics go to the server log through
   `provisionLogger`, which receives ids and reasons only — never a password,
   token, key, or connection string.

`role` is never read from the request. Self-signup is always `user`.

---

## 3. Orphan self-healing

An identity whose profile is missing is not a dead end any more. When
`createUser` reports the address is taken, provisioning signs in with the
supplied password:

```text
email taken
   │
   ├── password wrong ─────────────────▶ 409 "already exists, sign in"   (leaks nothing)
   │
   └── password correct
          │
          ├── profile exists ──────────▶ 409 "already exists, sign in"
          │
          └── no profile  ─── ORPHAN ──▶ provision profile ──▶ 201 + session
                                            │
                                            └── address held by a *different*
                                                profile ──▶ 409 "contact support"
                                                (split identity — needs an operator;
                                                 neither side is touched)
```

Proving the password is what makes this safe: nobody can claim a profile for an
identity they cannot authenticate as. It means the orphans created by the old
flow repair themselves the next time their owner signs up, with no operator
action and **no data deletion**.

---

## 4. Login

```text
POST /api/v1/auth/login
        │
        ▼
signInWithPassword ── invalid ─────────▶ 401 "email and password not correct"
        │            └─ unconfirmed ───▶ 403 "email not confirmed"
        ▼
resolve public.users by id
        │
        ├── missing ───────────────────▶ 409 "setup incomplete, sign up again
        │                                    with this address to finish"
        │                                 NO TOKEN IS ISSUED
        ▼
200 { user, access_token, refresh_token, user_id }
```

The old endpoint collapsed every failure into "that email and password
combination is not correct" — reporting a provisioning bug as a user error, and
handing out tokens for profile-less identities that then 401'd on the very next
request. Four outcomes are now distinguished, and a profile-less session never
circulates.

`user_id` is retained alongside the new `user` object so the existing mobile,
web, admin and partner clients keep working.

---

## 5. Roles and authorization

Authorization comes from `public.users.role` and nothing else — not
`user_metadata`, not `app_metadata`, not JWT claims, never client input.

| Where | Enforcement |
|---|---|
| `USER_ROLES` (`lib/provisioning.ts`) | The authoritative list: `user`, `admin`, `lab_partner` |
| `users_role_check` (migration 0015) | The same list, enforced by the database |
| `coerceRole()` | An unrecognised stored value degrades to `user` (least privilege) rather than flowing through as-is |
| `requireAuth` | Resolves identity from the verified token, then loads the profile row; sets no role of its own |
| `requireAdmin` / `requireLabPartner` | Exact comparison against the profile's role |
| `adminUpdateUserSchema` | `z.enum(['user','admin'])` — partners are managed through `/admin/partners` |

The web, admin and partner clients also check roles after login. That is UX, not
security: every protected endpoint is enforced server-side.

---

## 6. Provisioning the first administrator

There is deliberately **no HTTP endpoint that can grant `admin`**. Escalation is
impossible from any client. Admins are provisioned from the CLI:

```bash
# promote an existing, complete account
pnpm --filter @vital/api db:ensure-admin ops@vital.app

# create the very first admin (identity + profile together, with rollback)
VITAL_ADMIN_PASSWORD='…' pnpm --filter @vital/api db:ensure-admin ops@vital.app \
  --create --full-name="Ops Team"
```

`db:ensure-admin` is idempotent and handles all four identity states: promotes a
complete account, provisions the missing profile for an orphaned identity,
refuses to act on a split identity, and creates both sides when nothing exists.
The password is read from the environment (not a flag, so it stays out of shell
history and the process list) and is never logged.

`db:make-admin` is kept for the simple promote-by-email case.

---

## 7. Diagnostics

```bash
pnpm --filter @vital/api db:check-users            # human-readable
pnpm --filter @vital/api db:check-users -- --json  # machine-readable
```

Read-only by construction — SELECTs and Auth Admin GETs only, with no delete,
insert, or update path anywhere in the file, so it is safe against production.
Exit code 1 when anything is inconsistent, so CI can gate on it. It reports:

- totals: Auth users, profiles, matched, Auth-only, profile-only
- each orphaned identity, and whether it can self-heal on signup
- each profile with no identity
- split identities (same address, different ids per side)
- duplicate profile emails and phones
- role values outside the legal set
- application rows referencing a user that does not exist, per table/column
- whether `users_id_auth_users_id_fk` and `users_role_check` are validated

Repair is always a separate, deliberate act. `db:reset-dev-users` remains
development-only and still refuses to run with `NODE_ENV=production`.

---

## 8. Email confirmation — the current, coherent position

Accounts are created with `email_confirm: true` and receive a session
immediately.

This is a real decision, not a shortcut. The Admin API does not send
confirmation mail — only `signUp()`, `inviteUserByEmail()` and
`generateLink()` do — so `email_confirm: false` produced identities that were
unconfirmed, unemailed, unable to sign in, and reported by `/login` as a wrong
password. The application told users to check an inbox that would never receive
anything.

Switching to real verification is a coherent, separate piece of work and needs
all of it, not half:

1. send the mail (`generateLink` / `inviteUserByEmail`, or the public `signUp()`)
2. configure the production Site URL and redirect allowlist (§10)
3. configure custom SMTP — Supabase's built-in sender is rate-limited to a few
   messages an hour and only delivers to project-team addresses
4. rework web and mobile signup to wait for confirmation instead of expecting a
   session
5. keep `/login`'s `email_not_confirmed` branch, which already exists

Until then the flow is internally consistent, and no message claims an email was
sent.

---

## 9. Account deletion — decided, not implemented

No deletion endpoint or CLI exists today, and this work did not add one. What
the current schema does on delete:

| Data | On profile delete | Assessment |
|---|---|---|
| `subscriptions` | CASCADE | Financial record — should arguably be retained |
| `bookings` | CASCADE | Also releases nothing: `booking_slots.booked_count` is application-maintained, so capacity leaks (`reset-dev-users.ts` compensates by hand) |
| `user_biomarker_results` | CASCADE | **Medical data** |
| `lab_uploads` (`user_id`) | CASCADE | **Medical data** |
| `lab_uploads.uploaded_by` | **SET NULL** (new, migration 0015) | Correct: an upload must outlive the staff account that performed it |
| `score_snapshots` | CASCADE | Derived health history |
| `ai_insights`, `ai_chat_messages`, `ai_chat_summaries` | CASCADE | Health-adjacent conversation history |
| `notifications`, `device_tokens` | CASCADE | Correct — transient |
| `addon_orders` | CASCADE | Financial record |
| `lab_partner_areas` | CASCADE | Correct — assignment only |

Deleting a VITAL user therefore destroys medical and financial history
irreversibly. **Recommendation: soft-delete/anonymise rather than cascade** —
retain clinical rows, null the identifying columns on the profile, and delete
only the Auth identity so the person can no longer sign in.

That is a product and legal decision (data-retention obligations, Egyptian
medical-record rules, the subscription/payment trail), not an engineering one,
so the existing cascade behaviour was left exactly as it was rather than
changed unilaterally. Note that migration 0015's `ON DELETE CASCADE` from
`public.users` to `auth.users` means **deleting an Auth identity now removes
its profile and everything cascading from it** — worth knowing before anyone
deletes a user from the Supabase dashboard.

---

## 10. Required external configuration

None of the following can be set from this repository. **None of it was changed
by this work.**

### Supabase (project `uwoxelinwwhdocckulvl`)

| Setting | Required value | Why |
|---|---|---|
| Authentication → URL Configuration → **Site URL** | `https://vital-web-woad.vercel.app` | Password-reset links land here. If it is still a localhost value, every reset email is useless in production. |
| → **Redirect URLs** | add `https://vital-web-woad.vercel.app/**` | Otherwise the redirect is rejected. |
| Authentication → Providers → Email → **Confirm email** | Either state now works; the flow no longer depends on it | With it on, `/login` returns the correct `email_not_confirmed` error instead of a wrong-password lie. |
| **Custom SMTP** | Required before relying on any Supabase-sent email | Built-in sender is rate-limited and team-only. Affects password reset today. |
| Database password | Rotate, then update `DATABASE_URL` on Render | The value in the local `apps/api/.env` is stale — it fails `28P01`, which is why migration 0015 could not be applied from here. |

### Vercel (`vital-web-woad`)

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://vital-t0y2.onrender.com/api/v1` |

`NEXT_PUBLIC_*` is inlined at build time, so this needs a **redeploy** to take
effect. A production build without it now fails with an explicit
"API address is missing" error instead of silently trying `localhost:3000`.

### Render (`vital-t0y2`)

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Transaction pooler, port **6543**, `sslmode=require`, URL-encoded password, same project ref as `SUPABASE_URL` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Backend only — the service key must never reach web or mobile |
| `NODE_ENV` | `production`, which is what keeps `db:reset-dev-users` locked out |

### Credential rotation (do this)

`apps/api/.env.example` is tracked in git and contained a live-looking
`SUPABASE_SERVICE_KEY` and `SUPABASE_JWT_SECRET`. The values have been replaced
with placeholders, but **they remain in git history and must be rotated** in the
Supabase dashboard, then updated on Render. A service-role key grants full
database access and bypasses RLS.

---

## 11. Known limitations

- **Migration 0015 has not been applied.** The local `DATABASE_URL` password is
  stale (`28P01`), so no migration could be run from this machine. Until
  `pnpm --filter @vital/api db:migrate` runs against production, the FK, the
  role CHECK and the `uploaded_by` FK do not exist there — the application-level
  rollback and self-healing work regardless, but the database is not yet
  enforcing its half.
- **The FK ships `NOT VALID`.** It enforces immediately for new and updated
  rows while tolerating existing violators, so the migration always applies.
  After reconciling, run
  `ALTER TABLE users VALIDATE CONSTRAINT users_id_auth_users_id_fk;`.
  `db:check-users` reports validation state.
- **`db:check-users` and `db:ensure-admin` are unexecuted.** They typecheck, but
  they need a working `DATABASE_URL` and have not been run against a live
  database.
- **Two constraints are invisible to drizzle-kit.** `users_id_auth_users_id_fk`
  and `users_role_check` exist only in SQL, because Drizzle's DSL cannot express
  a reference into the `auth` schema. `drizzle.config.ts` now pins
  `schemaFilter: ['public']` so generation never touches `auth`, but a future
  `db:generate` still cannot see them — **review generated SQL before applying
  it** and do not let it drop them. `schema.ts` carries the same warning.
- **A pre-existing *unconfirmed* orphan cannot self-heal.** Recovery needs a
  successful sign-in to prove the password, and Supabase refuses sign-in for an
  unconfirmed address, so such an identity falls through to a 409. New accounts
  are created confirmed so this cannot arise going forward, and none of the
  three orphans in this project is affected (all are confirmed). Repair for one
  would be operator-side, via the same path `db:ensure-admin` uses.
- **No rate limiting** on `/auth/*`. Signup, login and reset are unthrottled,
  and the self-healing path performs a sign-in attempt per duplicate-email
  signup. Worth adding.
