/**
 * Test booking — customer routes (Phase 2). Gated behind an active subscription.
 *   GET  /areas                       → active service areas
 *   GET  /areas/:id/availability      → resolved slots for the next N days
 *   GET  /bookings/me                 → the user's bookings
 *   POST /bookings                    → book a slot (atomic capacity)
 *   PUT  /bookings/:id                → reschedule / edit notes (atomic capacity)
 *   POST /bookings/:id/cancel         → cancel a booking
 */
import { createBookingSchema } from '@vital/shared';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/client.js';
import { bookings, serviceAreas, users } from '../db/schema.js';
import { listAddonMarkers } from '../lib/addons.js';
import { cancelBooking, createBooking, rescheduleBooking, resolveRange } from '../lib/booking.js';
import { errorResponse } from '../lib/http.js';
import { partnerIdsForArea } from '../lib/lab-partner.js';
import { notifyUser } from '../lib/notifications.js';
import { serializeArea, serializeBooking } from '../lib/serialize.js';
import { type AuthVariables, requireAuth } from '../middleware/auth.js';
import { requireActiveSubscription } from '../middleware/subscription.js';
import { validate } from '../middleware/validate.js';

export const bookingRoutes = new Hono<{ Variables: AuthVariables }>();

// Scoped to this router's own paths — see the note in ai.ts and
// apps/api/test/route-mounting.test.ts. Both the exact collection paths and the
// nested wildcards are listed so every route below stays gated.
bookingRoutes.use('/areas', requireAuth, requireActiveSubscription);
bookingRoutes.use('/areas/*', requireAuth, requireActiveSubscription);
bookingRoutes.use('/bookings', requireAuth, requireActiveSubscription);
bookingRoutes.use('/bookings/*', requireAuth, requireActiveSubscription);
bookingRoutes.use('/addons', requireAuth, requireActiveSubscription);

/** Fan a visit alert out to every partner (doctor) assigned to a booking's area. */
async function notifyAreaPartners(
  areaId: string,
  n: { title: string; body: string; link: string; dedupeKey: string },
) {
  const partnerIds = await partnerIdsForArea(areaId);
  await Promise.all(
    partnerIds.map((pid) => notifyUser(pid, { type: 'booking', severity: 'info', ...n })),
  );
}

/** Patient's display name for partner-facing alert copy. */
async function patientName(userId: string): Promise<string> {
  const [row] = await db.select({ name: users.fullName }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.name ?? 'A patient';
}

/** Extra markers a customer can pay to add on top of their plan at checkout. */
bookingRoutes.get('/addons', async (c) => {
  return c.json({ addons: await listAddonMarkers() });
});

bookingRoutes.get('/areas', async (c) => {
  const rows = await db
    .select()
    .from(serviceAreas)
    .where(eq(serviceAreas.isActive, true))
    .orderBy(asc(serviceAreas.displayOrder));
  return c.json({ areas: rows.map(serializeArea) });
});

bookingRoutes.get('/areas/:id/availability', async (c) => {
  const areaId = c.req.param('id');
  const from = c.req.query('from') ?? new Date().toISOString().slice(0, 10);
  const days = Math.min(Math.max(Number(c.req.query('days') ?? 14), 1), 60);
  const availability = await resolveRange(areaId, from, days);
  return c.json({ availability });
});

bookingRoutes.get('/bookings/me', async (c) => {
  const userId = c.get('userId');
  const rows = await db
    .select()
    .from(bookings)
    .where(eq(bookings.userId, userId))
    .orderBy(desc(bookings.date));
  const areaIds = [...new Set(rows.map((r) => r.areaId))];
  const areas = areaIds.length
    ? await db.select().from(serviceAreas).where(inArray(serviceAreas.id, areaIds))
    : [];
  const nameById = new Map(areas.map((a) => [a.id, a.name]));
  return c.json({
    bookings: rows.map((r) => serializeBooking(r, nameById.get(r.areaId) ?? '')),
  });
});

bookingRoutes.post('/bookings', validate('json', createBookingSchema), async (c) => {
  const userId = c.get('userId');
  const { booking, areaName } = await createBooking(userId, c.req.valid('json'));

  await notifyUser(userId, {
    type: 'booking',
    severity: 'info',
    title: 'Test booked ✓',
    body: `Your home test in ${areaName} is confirmed for ${booking.date}, ${booking.startTime}–${booking.endTime}.`,
    link: 'booking',
    dedupeKey: `booking-confirmed:${booking.id}`,
  });

  // Alert the visiting doctor(s) for that area of the new visit.
  await notifyAreaPartners(booking.areaId, {
    title: 'New booking',
    body: `${await patientName(userId)} booked a home test for ${booking.date}, ${booking.startTime}–${booking.endTime} (${areaName}).`,
    link: `appointments/${userId}`,
    dedupeKey: `partner-booking-new:${booking.id}`,
  });

  return c.json({ booking: serializeBooking(booking, areaName) }, 201);
});

bookingRoutes.put('/bookings/:id', validate('json', createBookingSchema), async (c) => {
  const userId = c.get('userId');
  const result = await rescheduleBooking(userId, c.req.param('id'), c.req.valid('json'));
  if (!result) return errorResponse(c, 'not_found', 'Booking not found or not editable');
  const { booking, areaName } = result;

  await notifyUser(userId, {
    type: 'booking',
    severity: 'info',
    title: 'Booking updated',
    body: `Your home test in ${areaName} is now set for ${booking.date}, ${booking.startTime}–${booking.endTime}.`,
    link: 'booking',
    // Unique per change so each reschedule produces its own feed entry.
    dedupeKey: `booking-updated:${booking.id}:${booking.date}:${booking.startTime}`,
  });

  // Alert the visiting doctor(s) for the new area that the visit moved.
  await notifyAreaPartners(booking.areaId, {
    title: 'Booking rescheduled',
    body: `${await patientName(userId)} moved their home test to ${booking.date}, ${booking.startTime}–${booking.endTime} (${areaName}).`,
    link: `appointments/${userId}`,
    dedupeKey: `partner-booking-resched:${booking.id}:${booking.date}:${booking.startTime}`,
  });

  return c.json({ booking: serializeBooking(booking, areaName) });
});

bookingRoutes.post('/bookings/:id/cancel', async (c) => {
  const userId = c.get('userId');
  const booking = await cancelBooking(userId, c.req.param('id'));
  if (!booking) return errorResponse(c, 'not_found', 'Booking not found or not cancellable');

  await notifyUser(userId, {
    type: 'booking',
    severity: 'info',
    title: 'Booking cancelled',
    body: `Your test booking on ${booking.date} at ${booking.startTime} was cancelled.`,
    link: 'booking',
    dedupeKey: `booking-cancelled:${booking.id}`,
  });

  // Alert the visiting doctor(s) for that area that the visit is off.
  await notifyAreaPartners(booking.areaId, {
    title: 'Booking cancelled',
    body: `${await patientName(userId)} cancelled their home test on ${booking.date} at ${booking.startTime}.`,
    link: `appointments/${userId}`,
    dedupeKey: `partner-booking-cancel:${booking.id}`,
  });

  return c.json({ success: true });
});
