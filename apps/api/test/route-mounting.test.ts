/**
 * Route-mounting regression tests.
 *
 * These exist because of a production defect in the lab partner portal. Several
 * routers register their own full paths and are therefore mounted at the
 * `/api/v1` root:
 *
 *   v1.route('/', biomarkerRoutes)   // ← registers /biomarkers, /biomarker-categories
 *   v1.route('/', scoreRoutes)       // ← registers /score/me, …
 *   …
 *   v1.route('/lab-partner', labPartnerRoutes)
 *
 * When such a router calls `use('*', requireAuth, requireActiveSubscription)`,
 * Hono records that middleware at `/api/v1/*` — matching the WHOLE API, not
 * just that router's own routes. Because middleware runs for every matching
 * path in registration order, `biomarkerRoutes`' wildcard intercepted requests
 * intended for routers mounted after it. Two things broke:
 *
 *   * /api/v1/lab-partner/*  → "An active subscription is required to access
 *     biomarker data". A lab partner must not need a *patient* subscription.
 *   * /api/v1/app-content, /health-goals, /ai-status → 401, even though they
 *     are public endpoints.
 *
 * The fix is middleware path scoping (never bypassing the subscription check).
 * These tests lock that in from two independent directions:
 *
 *   1. Structurally — no subscription middleware may be registered at a path
 *      that matches another router's routes.
 *   2. By real dispatch — the public endpoints must not answer 401/403, and the
 *      gated endpoints must still refuse an unauthenticated caller.
 *
 * The mount list below is checked against apps/api/src/index.ts on every run,
 * so this harness cannot silently drift from production.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// Type-only: erased at compile time, so it does not affect the deliberate
// import ordering below (configuration must be stubbed before the real
// modules load).
import type { Hono as HonoApp } from 'hono';

// Stub configuration BEFORE importing anything that reads it. dotenv does not
// override already-set variables, so these dummies win over any local .env —
// no real credential is used, and nothing here connects on import. The database
// URL points at a port that refuses immediately so handler-reaching requests
// fail fast rather than hanging.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/postgres';
process.env.SUPABASE_URL ??= 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key-not-a-real-credential';
process.env.PAYMOB_API_KEY ??= 'test';
process.env.PAYMOB_INTEGRATION_ID ??= '1';
process.env.PAYMOB_IFRAME_ID ??= '1';
process.env.PAYMOB_HMAC_SECRET ??= 'test';

const { Hono } = await import('hono');
const { requireAuth } = await import('../src/middleware/auth.js');
const { requireAdmin } = await import('../src/middleware/admin.js');
const { requireLabPartner } = await import('../src/middleware/lab-partner.js');
const { requireActiveSubscription } = await import('../src/middleware/subscription.js');

const { authRoutes } = await import('../src/routes/auth.js');
const { userRoutes } = await import('../src/routes/users.js');
const { resultRoutes } = await import('../src/routes/results.js');
const { paymentRoutes } = await import('../src/routes/payments.js');
const { adminRoutes } = await import('../src/routes/admin.js');
const { subscriptionRoutes } = await import('../src/routes/subscriptions.js');
const { biomarkerRoutes } = await import('../src/routes/biomarkers.js');
const { contentRoutes } = await import('../src/routes/content.js');
const { scoreRoutes } = await import('../src/routes/score.js');
const { aiRoutes } = await import('../src/routes/ai.js');
const { recommendationRoutes } = await import('../src/routes/recommendations.js');
const { notificationRoutes } = await import('../src/routes/notifications.js');
const { bookingRoutes } = await import('../src/routes/bookings.js');
const { labPartnerRoutes } = await import('../src/routes/lab-partner.js');

/** Mirrors apps/api/src/index.ts exactly — asserted against it below. */
const MOUNTS: [string, HonoApp][] = [
  ['/auth', authRoutes as unknown as HonoApp],
  ['/users', userRoutes as unknown as HonoApp],
  ['/results', resultRoutes as unknown as HonoApp],
  ['/payments', paymentRoutes as unknown as HonoApp],
  ['/admin', adminRoutes as unknown as HonoApp],
  ['/', subscriptionRoutes as unknown as HonoApp],
  ['/', biomarkerRoutes as unknown as HonoApp],
  ['/', contentRoutes as unknown as HonoApp],
  ['/', scoreRoutes as unknown as HonoApp],
  ['/', aiRoutes as unknown as HonoApp],
  ['/', recommendationRoutes as unknown as HonoApp],
  ['/', notificationRoutes as unknown as HonoApp],
  ['/', bookingRoutes as unknown as HonoApp],
  ['/lab-partner', labPartnerRoutes as unknown as HonoApp],
];

function buildApp() {
  const v1 = new Hono();
  for (const [path, router] of MOUNTS) v1.route(path, router);
  const app = new Hono();
  app.route('/api/v1', v1);
  return app;
}

const app = buildApp();

/** Turns a recorded Hono path into a matcher (`*` → any suffix, `:x` → one segment). */
function patternToRegex(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((seg) => {
      if (seg === '*') return '.*';
      if (seg.startsWith(':')) return '[^/]+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${body}$`);
}

/** Paths where `requireActiveSubscription` is actually registered. */
function subscriptionGatedPatterns(): string[] {
  return app.routes.filter((r) => r.handler === requireActiveSubscription).map((r) => r.path);
}

function isSubscriptionGated(url: string): boolean {
  return subscriptionGatedPatterns().some((p) => patternToRegex(p).test(url));
}

function isRegisteredFor(url: string, handler: unknown): boolean {
  return app.routes.some((r) => r.handler === handler && patternToRegex(r.path).test(url));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1 + 2. The lab partner portal must not sit behind a patient subscription
// ─────────────────────────────────────────────────────────────────────────────

describe('lab-partner routes are not intercepted by requireActiveSubscription', () => {
  const LAB_PARTNER_URLS = [
    '/api/v1/lab-partner/me',
    '/api/v1/lab-partner/biomarkers',
    '/api/v1/lab-partner/appointments',
    '/api/v1/lab-partner/users/00000000-0000-0000-0000-000000000000',
    '/api/v1/lab-partner/users/00000000-0000-0000-0000-000000000000/lab-uploads',
    '/api/v1/lab-partner/users/00000000-0000-0000-0000-000000000000/notify',
    '/api/v1/lab-partner/lab-uploads/00000000-0000-0000-0000-000000000000',
    '/api/v1/lab-partner/lab-uploads/00000000-0000-0000-0000-000000000000/confirm',
    '/api/v1/lab-partner/notification-templates',
    '/api/v1/lab-partner/notifications',
    '/api/v1/lab-partner/notifications/read',
  ];

  for (const url of LAB_PARTNER_URLS) {
    it(`${url} has no subscription gate`, () => {
      assert.equal(
        isSubscriptionGated(url),
        false,
        `${url} is behind requireActiveSubscription. A lab partner must not need a patient ` +
          `subscription. Registered subscription paths: ${subscriptionGatedPatterns().join(', ')}`,
      );
    });
  }

  it('is still protected by requireAuth and requireLabPartner', () => {
    // The fix must not have opened the portal up — only removed the wrong gate.
    for (const url of LAB_PARTNER_URLS) {
      assert.ok(isRegisteredFor(url, requireAuth), `${url} lost requireAuth`);
      assert.ok(isRegisteredFor(url, requireLabPartner), `${url} lost requireLabPartner`);
    }
  });

  it('refuses an unauthenticated caller at the lab-partner gate', async () => {
    const res = await app.request('/api/v1/lab-partner/me');
    assert.equal(res.status, 401, 'lab-partner must remain authenticated');
    const body = (await res.json()) as { error?: { message?: string } };
    assert.doesNotMatch(
      body.error?.message ?? '',
      /subscription/i,
      'the failure must come from the auth gate, never from a subscription check',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Subscription-gated routes stay gated
// ─────────────────────────────────────────────────────────────────────────────

describe('subscription-gated routes remain gated', () => {
  const GATED_URLS = [
    '/api/v1/biomarkers',
    '/api/v1/biomarkers/00000000-0000-0000-0000-000000000000',
    '/api/v1/biomarker-categories',
    '/api/v1/score/me',
    '/api/v1/score/me/history',
    '/api/v1/ai/insights/me',
    '/api/v1/ai/insights/me/generate',
    '/api/v1/ai/chat/me',
    '/api/v1/recommendations/me',
    '/api/v1/bookings',
    '/api/v1/bookings/me',
    '/api/v1/bookings/00000000-0000-0000-0000-000000000000',
    '/api/v1/bookings/00000000-0000-0000-0000-000000000000/cancel',
    '/api/v1/areas',
    '/api/v1/areas/00000000-0000-0000-0000-000000000000/availability',
    '/api/v1/addons',
    '/api/v1/results/me',
    '/api/v1/notifications/me',
  ];

  for (const url of GATED_URLS) {
    it(`${url} keeps requireActiveSubscription`, () => {
      assert.ok(
        isSubscriptionGated(url),
        `${url} lost its subscription gate — this scoping fix must not weaken access control`,
      );
    });
  }

  it('rejects unauthenticated callers on gated routes', async () => {
    for (const url of ['/api/v1/biomarkers', '/api/v1/score/me', '/api/v1/bookings/me']) {
      const res = await app.request(url);
      assert.equal(res.status, 401, `${url} must require authentication`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Scoping stays correct after mounting
// ─────────────────────────────────────────────────────────────────────────────

describe('middleware scoping survives router mounting', () => {
  it('registers no auth or subscription middleware at the bare /api/v1/* root', () => {
    const rootWildcards = app.routes.filter(
      (r) =>
        r.path === '/api/v1/*' &&
        (r.handler === requireActiveSubscription ||
          r.handler === requireAuth ||
          r.handler === requireAdmin ||
          r.handler === requireLabPartner),
    );
    assert.deepEqual(
      rootWildcards.map((r) => r.path),
      [],
      "a router mounted at '/' used use('*'), which registers middleware for the entire API " +
        'and intercepts every router mounted after it',
    );
  });

  it('scopes every subscription registration under a known prefix', () => {
    const ALLOWED = [
      '/api/v1/results/*',
      '/api/v1/biomarkers',
      '/api/v1/biomarkers/*',
      '/api/v1/biomarker-categories',
      '/api/v1/score/*',
      '/api/v1/ai/*',
      '/api/v1/recommendations/*',
      '/api/v1/notifications/*',
      '/api/v1/areas',
      '/api/v1/areas/*',
      '/api/v1/bookings',
      '/api/v1/bookings/*',
      '/api/v1/addons',
    ];
    for (const path of subscriptionGatedPatterns()) {
      assert.ok(
        ALLOWED.includes(path),
        `unexpected subscription middleware path "${path}" — if this is intentional, add it here ` +
          'and confirm it cannot match another router',
      );
    }
  });

  it('leaves the public endpoints public', async () => {
    // The regression made these 401. They hit the database, which is not
    // reachable from the test environment, so assert only that no auth or
    // subscription gate answered.
    for (const url of ['/api/v1/app-content', '/api/v1/health-goals', '/api/v1/ai-status']) {
      const res = await app.request(url);
      assert.ok(
        res.status !== 401 && res.status !== 403,
        `${url} is public but answered ${res.status} — a root-mounted gate intercepted it`,
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Admin routes, including lab uploads
// ─────────────────────────────────────────────────────────────────────────────

describe('admin routes are not intercepted by requireActiveSubscription', () => {
  const ADMIN_URLS = [
    '/api/v1/admin/overview',
    '/api/v1/admin/users',
    '/api/v1/admin/users/00000000-0000-0000-0000-000000000000',
    '/api/v1/admin/users/00000000-0000-0000-0000-000000000000/lab-uploads',
    '/api/v1/admin/lab-uploads/00000000-0000-0000-0000-000000000000',
    '/api/v1/admin/lab-uploads/00000000-0000-0000-0000-000000000000/confirm',
    '/api/v1/admin/partners',
    '/api/v1/admin/plans',
  ];

  for (const url of ADMIN_URLS) {
    it(`${url} has no subscription gate`, () => {
      assert.equal(
        isSubscriptionGated(url),
        false,
        `${url} is behind requireActiveSubscription — an administrator does not hold a ` +
          'patient subscription',
      );
    });
  }

  it('is still protected by requireAuth and requireAdmin', () => {
    for (const url of ADMIN_URLS) {
      assert.ok(isRegisteredFor(url, requireAuth), `${url} lost requireAuth`);
      assert.ok(isRegisteredFor(url, requireAdmin), `${url} lost requireAdmin`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. This harness must match production
// ─────────────────────────────────────────────────────────────────────────────

describe('test harness matches the production mounting in index.ts', () => {
  it('mounts the same prefixes in the same order', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    const mounted = [...source.matchAll(/v1\.route\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)].map(
      (m) => [m[1], m[2]] as [string, string],
    );

    assert.ok(mounted.length > 0, 'could not parse v1.route(...) calls from index.ts');
    assert.equal(
      mounted.length,
      MOUNTS.length,
      `index.ts mounts ${mounted.length} routers but this test mounts ${MOUNTS.length}. ` +
        'Update MOUNTS so the test keeps reflecting production.',
    );
    assert.deepEqual(
      mounted.map(([path]) => path),
      MOUNTS.map(([path]) => path),
      'mount prefixes or their order differ from index.ts',
    );
  });

  it('mounts every router registered under /api/v1', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(
      source,
      /app\.route\('\/api\/v1',\s*v1\)/,
      'index.ts no longer mounts v1 at /api/v1 — these path assertions would be wrong',
    );
  });
});
