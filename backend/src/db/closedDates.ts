/**
 * The only place SQL touches the `provider_closed_dates` table.
 *
 * A closure is an overlay on the provider's slot pattern: closing a date
 * never deletes or edits an `availability_slots` row, so the rest of the
 * week (including the same weekday the following week) is untouched. Every
 * client-facing slot listing excludes slots whose UTC calendar day is
 * closed; the provider's own view keeps the slots visible so the pattern is
 * still there when the closure is removed.
 */
import { and, asc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";

import type { Db } from "./client.js";
import { availabilitySlots, bookings, providerClosedDates } from "./schema.js";

/** `YYYY-MM-DD`, validated as a real calendar date (a regex alone would
 * happily accept `2026-02-30`). Closures are keyed by UTC day. */
export function isValidClosedDate(date: unknown): date is string {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
  );
}

/** The UTC calendar day of an epoch-second start time -- the same expression
 * the slot listings use in SQL, kept in one place so a date a provider closes
 * can never be interpreted differently by the display and the filter. */
export function utcDateFor(startsAt: number): string {
  return new Date(startsAt * 1000).toISOString().slice(0, 10);
}

/**
 * Adds a closure. A second close of the same date is a no-op -- the
 * `ON CONFLICT DO NOTHING` is the SQL-level guarantee, so a retried click can
 * never change the row's original `created_at` or produce a duplicate.
 * Returns `true` only when a new row was inserted.
 */
export async function insertClosedDate(
  db: Db,
  providerProfileId: string,
  date: string,
  now: number = Date.now(),
): Promise<boolean> {
  const result = await db
    .insert(providerClosedDates)
    .values({ providerProfileId, date, createdAt: now })
    .onConflictDoNothing()
    .run();
  return result.changes > 0;
}

/** Removes a closure. Removing a date that was never closed is a no-op.
 * Returns `true` only when a row was actually removed. */
export async function deleteClosedDate(db: Db, providerProfileId: string, date: string): Promise<boolean> {
  const result = await db
    .delete(providerClosedDates)
    .where(and(eq(providerClosedDates.providerProfileId, providerProfileId), eq(providerClosedDates.date, date)));
  return result.changes > 0;
}

/** Every closed UTC date for a provider, ascending. */
export async function listClosedDates(db: Db, providerProfileId: string): Promise<string[]> {
  const rows = await db
    .select({ date: providerClosedDates.date })
    .from(providerClosedDates)
    .where(eq(providerClosedDates.providerProfileId, providerProfileId))
    .orderBy(asc(providerClosedDates.date));
  return rows.map((row) => row.date);
}

export interface ClosedDateBooking {
  bookingId: string;
  slotStartsAt: number;
  escrowState: string;
}

/**
 * The locked bookings a provider would be closing out from under a client.
 * Only bookings with a non-null `escrowState` count: an expired, never-funded
 * hold is not a commitment and must not block taking a day off. The rows are
 * returned so the service/route can name the booking in its error message.
 */
export async function listLockedBookingsOnDate(
  db: Db,
  providerProfileId: string,
  date: string,
): Promise<ClosedDateBooking[]> {
  const dayStart = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
  const dayEnd = dayStart + 24 * 60 * 60;
  const rows = await db
    .select({
      bookingId: bookings.id,
      slotStartsAt: availabilitySlots.startsAt,
      escrowState: bookings.escrowState,
    })
    .from(bookings)
    .innerJoin(availabilitySlots, eq(bookings.slotId, availabilitySlots.id))
    .where(
      and(
        eq(availabilitySlots.providerProfileId, providerProfileId),
        gte(availabilitySlots.startsAt, dayStart),
        lt(availabilitySlots.startsAt, dayEnd),
        isNotNull(bookings.escrowState),
      ),
    );
  return rows.map((row) => ({ bookingId: row.bookingId, slotStartsAt: row.slotStartsAt, escrowState: row.escrowState ?? "locked" }));
}

/** Whether this provider has closed the given UTC date. Used by the hold
 * path as a defense in depth: a stale client still showing a now-closed slot
 * cannot resurrect it by posting its start time directly. */
export async function isDateClosed(db: Db, providerProfileId: string, date: string): Promise<boolean> {
  const rows = await db
    .select({ date: providerClosedDates.date })
    .from(providerClosedDates)
    .where(and(eq(providerClosedDates.providerProfileId, providerProfileId), eq(providerClosedDates.date, date)))
    .limit(1);
  return rows.length > 0;
}

/** SQL fragment shared by every client-facing slot listing: a slot on a
 * closed UTC day is not bookable, exactly as if it had been removed from the
 * pattern -- but the row itself (and the rest of the week) stays put. */
export function slotNotOnClosedDate() {
  return sql`NOT EXISTS (
    SELECT 1 FROM provider_closed_dates pcd
    WHERE pcd.provider_profile_id = ${availabilitySlots.providerProfileId}
      AND pcd.date = strftime('%Y-%m-%d', ${availabilitySlots.startsAt}, 'unixepoch')
  )`;
}
