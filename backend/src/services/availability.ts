/**
 * Appointment buffer: after a locked booking ends, keep `bufferMinutes`
 * free before another slot of the same shop is offered. Weekly hours and
 * existing locked bookings are never rewritten here -- this module only
 * filters what clients are shown (and what `holdSlot` may claim).
 */
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { availabilitySlots, bookings } from "../db/schema.js";
import {
  listEarliestFutureSlotsByProvider,
  listOpenFutureSlots,
  listOpenSlotsInRange,
  type ListFutureSlotsOptions,
} from "../db/availabilitySlots.js";

/** True when `slotStartsAt` falls in the half-open window
 * `[sessionEnd, sessionEnd + buffer)` after a locked booking that started
 * at `lockedStartsAt`. A buffer of zero never blocks (adjacent stays). */
export function isSlotInsideBufferAfterLocked(
  slotStartsAt: number,
  lockedStartsAt: number,
  sessionLengthMinutes: number,
  bufferMinutes: number,
): boolean {
  if (bufferMinutes <= 0) {
    return false;
  }
  const sessionEnd = lockedStartsAt + sessionLengthMinutes * 60;
  const bufferEnd = sessionEnd + bufferMinutes * 60;
  return slotStartsAt >= sessionEnd && slotStartsAt < bufferEnd;
}

/** Drops every start time that sits inside the post-session buffer of any
 * locked booking. Locked starts from other shops are never passed in --
 * callers scope them to one provider. */
export function filterSlotsOutsideAppointmentBuffer(
  slotStarts: readonly number[],
  lockedStarts: readonly number[],
  sessionLengthMinutes: number,
  bufferMinutes: number,
): number[] {
  if (bufferMinutes <= 0 || lockedStarts.length === 0) {
    return [...slotStarts];
  }
  return slotStarts.filter(
    (slotStartsAt) =>
      !lockedStarts.some((lockedStartsAt) =>
        isSlotInsideBufferAfterLocked(slotStartsAt, lockedStartsAt, sessionLengthMinutes, bufferMinutes),
      ),
  );
}

/** UTC epoch seconds for every slot this shop currently has in `locked`
 * escrow -- the only bookings the buffer cares about (holds do not count). */
export async function listLockedBookingStarts(db: Db, providerProfileId: string): Promise<number[]> {
  const rows = await db
    .select({ startsAt: availabilitySlots.startsAt })
    .from(bookings)
    .innerJoin(availabilitySlots, eq(bookings.slotId, availabilitySlots.id))
    .where(and(eq(bookings.providerProfileId, providerProfileId), eq(bookings.escrowState, "locked")));
  return rows.map((row) => row.startsAt);
}

export interface OfferedSlotsOptions extends ListFutureSlotsOptions {
  sessionLengthMinutes: number;
  bufferMinutes: number;
}

/** Open future slots for one shop, minus any start that lands inside the
 * buffer after a locked booking on that same shop. */
export async function listOfferedSlots(db: Db, providerProfileId: string, options: OfferedSlotsOptions): Promise<number[]> {
  const open = await listOpenFutureSlots(db, providerProfileId, {
    now: options.now,
    withinSeconds: options.withinSeconds,
  });
  if (options.bufferMinutes <= 0) {
    return open.map((slot) => slot.startsAt);
  }
  const lockedStarts = await listLockedBookingStarts(db, providerProfileId);
  return filterSlotsOutsideAppointmentBuffer(
    open.map((slot) => slot.startsAt),
    lockedStarts,
    options.sessionLengthMinutes,
    options.bufferMinutes,
  );
}

/** Same-day open slots for `SLOT_TAKEN`, with the appointment buffer applied. */
export async function listOfferedSlotsInRange(
  db: Db,
  providerProfileId: string,
  rangeStart: number,
  rangeEnd: number,
  sessionLengthMinutes: number,
  bufferMinutes: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<number[]> {
  const open = await listOpenSlotsInRange(db, providerProfileId, rangeStart, rangeEnd, now);
  if (bufferMinutes <= 0) {
    return open;
  }
  const lockedStarts = await listLockedBookingStarts(db, providerProfileId);
  return filterSlotsOutsideAppointmentBuffer(open, lockedStarts, sessionLengthMinutes, bufferMinutes);
}

export interface ProviderBufferProfile {
  id: string;
  sessionLengthMinutes: number;
  bufferMinutes: number;
}

/** Earliest offered starts per provider (Discover cards), buffer-aware.
 * Providers with buffer 0 reuse the batch open-slot query; others re-list
 * and filter so a buffered gap never consumes a card's three-slot budget. */
export async function listEarliestOfferedSlotsByProvider(
  db: Db,
  profiles: readonly ProviderBufferProfile[],
  now: number,
  limit: number,
): Promise<Map<string, number[]>> {
  const result = await listEarliestFutureSlotsByProvider(
    db,
    profiles.map((profile) => profile.id),
    { now, limit },
  );

  for (const profile of profiles) {
    if (profile.bufferMinutes <= 0) {
      continue;
    }
    const offered = await listOfferedSlots(db, profile.id, {
      now,
      sessionLengthMinutes: profile.sessionLengthMinutes,
      bufferMinutes: profile.bufferMinutes,
    });
    result.set(profile.id, offered.slice(0, limit));
  }

  return result;
}
