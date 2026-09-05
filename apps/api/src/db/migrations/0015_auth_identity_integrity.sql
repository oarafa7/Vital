-- 0015 — Auth ↔ profile integrity
--
-- Makes the identity model explicit at the database level. Historically
-- `public.users.id` mirrored `auth.users.id` by convention only, with no
-- foreign key between them, which allowed two kinds of orphan:
--
--   * an Auth identity with no profile  (signup created the identity, then the
--     profile insert failed and nothing rolled it back)
--   * a profile with no Auth identity   (the identity was deleted directly)
--
-- Three changes, all additive. No row is deleted by this migration.
--
--   1. public.users.id  →  auth.users(id)  ON DELETE CASCADE
--        Makes a profile without an identity impossible, and makes deleting an
--        Auth user remove its profile (so the application's rollback path is
--        guaranteed complete). Added NOT VALID so the migration always applies:
--        enforcement starts immediately for inserts/updates, while any existing
--        violating row is tolerated until an operator reconciles it. See below.
--
--   2. CHECK on public.users.role
--        Authorization is resolved from this column alone, so the set of legal
--        values belongs in the database, not only in TypeScript.
--
--   3. lab_uploads.uploaded_by  →  public.users(id)  ON DELETE SET NULL
--        The only user reference in the schema that had no FK. SET NULL, not
--        CASCADE: an upload is clinical data and must outlive the staff account
--        that happened to perform it. Dangling values are reconciled to NULL
--        first, which is the same repair reset-dev-users.ts already does by hand.
--
-- ── Finishing the FK ────────────────────────────────────────────────────────
-- If constraint 1 stays NOT VALID, existing profiles violate it. List them:
--
--   SELECT u.id, u.email, u.created_at
--   FROM public.users u
--   LEFT JOIN auth.users a ON a.id = u.id
--   WHERE a.id IS NULL;
--
-- Decide what happens to each (they are reported by `pnpm db:check-users`),
-- then validate:
--
--   ALTER TABLE "users" VALIDATE CONSTRAINT "users_id_auth_users_id_fk";
--
-- ── Rollback ────────────────────────────────────────────────────────────────
--   ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_id_auth_users_id_fk";
--   ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_role_check";
--   ALTER TABLE "lab_uploads" DROP CONSTRAINT IF EXISTS "lab_uploads_uploaded_by_users_id_fk";

-- 1. public.users.id → auth.users(id)
DO $$ BEGIN
 ALTER TABLE "users"
   ADD CONSTRAINT "users_id_auth_users_id_fk"
   FOREIGN KEY ("id") REFERENCES "auth"."users"("id")
   ON DELETE cascade ON UPDATE no action
   NOT VALID;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "users" VALIDATE CONSTRAINT "users_id_auth_users_id_fk";
 RAISE NOTICE 'users_id_auth_users_id_fk validated: every profile has an Auth identity.';
EXCEPTION
 WHEN foreign_key_violation THEN
  RAISE WARNING 'users_id_auth_users_id_fk left NOT VALID: some public.users rows have no auth.users row. New rows are already enforced. Run "pnpm db:check-users" to list them, reconcile, then: ALTER TABLE users VALIDATE CONSTRAINT users_id_auth_users_id_fk;';
END $$;--> statement-breakpoint

-- 2. Legal role values
DO $$ BEGIN
 ALTER TABLE "users"
   ADD CONSTRAINT "users_role_check"
   CHECK ("role" IN ('user', 'admin', 'lab_partner'))
   NOT VALID;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "users" VALIDATE CONSTRAINT "users_role_check";
EXCEPTION
 WHEN check_violation THEN
  RAISE WARNING 'users_role_check left NOT VALID: public.users.role contains values outside (user, admin, lab_partner). Fix them, then: ALTER TABLE users VALIDATE CONSTRAINT users_role_check;';
END $$;--> statement-breakpoint

-- 3. lab_uploads.uploaded_by → public.users(id), SET NULL
--    Reconcile dangling references first so the constraint can validate.
UPDATE "lab_uploads"
   SET "uploaded_by" = NULL
 WHERE "uploaded_by" IS NOT NULL
   AND "uploaded_by" NOT IN (SELECT "id" FROM "users");--> statement-breakpoint

DO $$ BEGIN
 ALTER TABLE "lab_uploads"
   ADD CONSTRAINT "lab_uploads_uploaded_by_users_id_fk"
   FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id")
   ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
