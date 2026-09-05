# VITAL — Expo Go Trial Runbook

How to stand up the backend and trial the mobile app on a real phone via **Expo Go**.
The app is Expo Go-compatible (Expo SDK 52; no custom native modules) — this is wiring
+ data, not a native build.

---

## 0. Prerequisites
- Node 20+ and `pnpm` (repo uses a pnpm workspace).
- A **Supabase** project (Postgres + Auth + Storage).
- A phone with the **Expo Go** app (SDK 52 compatible).
- (Optional) Paymob test credentials, a Google Maps JS API key.

```bash
pnpm install
pnpm -r typecheck   # sanity check
```

---

## 1. Supabase setup
1. Create a project. From **Project Settings → API/Database**, grab:
   - `DATABASE_URL` (connection string), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
     (service role), `SUPABASE_JWT_SECRET`, and the **anon** key (for mobile).
2. **Auth → Providers → Email:** turn **OFF** "Confirm email" so trial signups can log
   in immediately.
3. **Storage:** create a bucket named `lab-results` (matches `SUPABASE_STORAGE_BUCKET`).

---

## 2. Backend API (`apps/api`)
Create `apps/api/.env` (see `apps/api/.env.example`):
```
NODE_ENV=development
PORT=3000
# Use the TRANSACTION POOLER (port 6543), not the direct 5432 host: the client
# sets prepare:false for it, and direct-connection hostnames are IPv6-only.
DATABASE_URL=postgresql://postgres.[project]:[pwd]@[region].pooler.supabase.com:6543/postgres?sslmode=require
SUPABASE_URL=https://[project].supabase.co
SUPABASE_SERVICE_KEY=...
SUPABASE_JWT_SECRET=...
SUPABASE_STORAGE_BUCKET=lab-results
# Optional — leave Paymob/Anthropic unset to disable those features gracefully
# PAYMOB_API_KEY=... (etc.)   ANTHROPIC_API_KEY=...
```

Apply schema + seed, then run:
```bash
pnpm db:migrate     # applies migrations 0001–0009
pnpm db:seed        # biomarkers, categories, plans, demo "New Cairo" area
pnpm dev:api        # serves on :3000
```

**Make it reachable from the phone.** `localhost` won't work from Expo Go. Either:
- deploy the API and use its public URL, or
- tunnel your local API, e.g. `ngrok http 3000`, and use the https URL below.

---

## 3. Admin dashboard (`apps/admin`) — to grant trial access
```bash
pnpm --filter @vital/admin dev   # http://localhost:3001
```
Create `apps/admin/.env.local` → `NEXT_PUBLIC_API_URL=http://localhost:3000/api/v1`.
Sign in with an **admin** account (set a user's `role` to `admin` in the DB, or promote
via the Users page once you have one admin).

---

## 4. Mobile app (`apps/mobile`)
Create `apps/mobile/.env` (see `.env.example`):
```
EXPO_PUBLIC_API_URL=https://<your-api-or-tunnel>/api/v1
EXPO_PUBLIC_SUPABASE_URL=https://[project].supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>
EXPO_PUBLIC_GOOGLE_MAPS_KEY=          # optional; blank → manual address field
```
Start Metro and scan the QR in Expo Go:
```bash
pnpm --filter @vital/mobile start --tunnel
```
`--tunnel` avoids same-Wi-Fi requirements. (Plain `start` works if phone + computer are
on the same network and `EXPO_PUBLIC_API_URL` points at your machine's LAN IP.)

---

## 5. Walk the trial flow
1. **Sign up** in the app → complete onboarding (health profile → client info/location
   → goals).
2. **Grant a subscription**: in the admin app, open the new user → **Grant** an active
   plan. (This unlocks Biomarkers/Labs Summary without going through Paymob.)
3. **Populate data** so the panel/score are non-empty, either:
   - in-app: open a biomarker → **Add Result**, enter a few values; or
   - via admin/partner: upload a lab-results PDF and confirm it.
4. Explore: **Dashboard**, **Biomarkers → Labs Summary** (dial + grouped markers),
   biomarker detail, **Book a Test**, **Notifications**.

---

## 6. Known limitations in Expo Go (expected — not bugs)
- **Push notifications**: only the server path + a `registerDevice` stub exist; there is
  no `expo-notifications` client wiring, and Expo Go has limited/no remote push. The
  **in-app notification feed still works** (fetched on open). Real push needs a dev build.
- **Payments (Paymob)**: the checkout WebView needs real Paymob credentials + a return
  URL. For trials, use admin-granted subscriptions (step 5.2) instead.
- **Maps**: the location picker needs `EXPO_PUBLIC_GOOGLE_MAPS_KEY`; without it, it falls
  back to a manual address field.

---

## 7. Quick troubleshooting
- Blank/locked Biomarkers → the user has no active subscription (step 5.2) or no results.
- Network errors → `EXPO_PUBLIC_API_URL` isn't reachable from the phone (use a tunnel).
- Login fails right after signup → email confirmation is still ON in Supabase (step 1.2).
