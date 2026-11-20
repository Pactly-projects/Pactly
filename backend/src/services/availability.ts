/**
 * One-off availability closures.
 *
 * A provider's repeating slot pattern is a valuable thing to keep: a single
 * day off must not mean deleting that day's slots and rebuilding them next
 * week. This service therefore closes a *calendar date* as an overlay. The
 * slots stay exactly where they are; every client-facing slot read hides the
 * closed day's slots, and removing the closure reveals them again.
 *
 * Nothing here touches bookings. A date that already carries a locked
 * booking is refused outright (with the booking's id, so the panel can name
 * it) rather than silently cancelling anyone's appointment.
 */
import {
  isValidClosedDate,
  insertClosedDate,
  deleteClosedDate,
  isDateClosed,
  listClosedDates,
  listLockedBookingsOnDate,
} from "../db/closedDates.js";
import type { Db } from "../db/client.js";
import { getProviderProfileByWallet } from "../db/providerProfiles.js";
import { NotAProviderError } from "./profile.js";

export { NotAProviderError };

export class InvalidClosedDateError extends Error {
  readonly details: Record<string, string>;
  constructor(date: unknown) {
    super("Use a calendar date in YYYY-MM-DD form.");
    this.name = "InvalidClosedDateError";
    this.details = { date: `Invalid date "${String(date)}": use YYYY-MM-DD.` };
  }
}

export class ClosedDateBookingError extends Error {
  /** The booking the panel names in its error message. */
  readonly bookingId: string;
  readonly slotStartsAt: number;
  readonly escrowState: string;
  constructor(booking: { bookingId: string; slotStartsAt: number; escrowState: string }) {
    super(`This date has a locked booking (${booking.bookingId}). It can't be closed.`);
    this.name = "ClosedDateBookingError";
    this.bookingId = booking.bookingId;
    this.slotStartsAt = booking.slotStartsAt;
    this.escrowState = booking.escrowState;
  }
}

async function ownProviderId(db: Db, walletAddress: string): Promise<string> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  return profile.id;
}

/**
 * Closes one UTC calendar date for the caller's own shop. Duplicate closes
 * are a no-op (the insert is `ON CONFLICT DO NOTHING`). Returns the full,
 * sorted list of the shop's closed dates, including this one.
 */
export async function closeDate(
  db: Db,
  walletAddress: string,
  date: unknown,
  now: number = Date.now(),
): Promise<string[]> {
  if (!isValidClosedDate(date)) {
    throw new InvalidClosedDateError(date);
  }
  const providerProfileId = await ownProviderId(db, walletAddress);
  // A retry of an already-closed date changes nothing at all -- not even an
  // error about a booking that locked after the closure was first made.
  if (await isDateClosed(db, providerProfileId, date)) {
    return listClosedDates(db, providerProfileId);
  }
  const locked = await listLockedBookingsOnDate(db, providerProfileId, date);
  if (locked.length > 0) {
    // Name a concrete booking so the panel can point at it -- closing the
    // date would be a destructive act against a real appointment.
    throw new ClosedDateBookingError(locked[0]!);
  }
  await insertClosedDate(db, providerProfileId, date, now);
  return listClosedDates(db, providerProfileId);
}

/** Alias named for the shop-facing wording. */
export const closeProviderDate = closeDate;
export const closeAvailabilityDate = closeDate;

/** Removes a closure. Removing a date that was never closed is a no-op. */
export async function reopenDate(db: Db, walletAddress: string, date: unknown): Promise<string[]> {
  if (!isValidClosedDate(date)) {
    throw new InvalidClosedDateError(date);
  }
  const providerProfileId = await ownProviderId(db, walletAddress);
  await deleteClosedDate(db, providerProfileId, date);
  return listClosedDates(db, providerProfileId);
}

export const reopenProviderDate = reopenDate;
export const openDate = reopenDate;
/** Panel wording: a closed date is a blocked date, not a deleted slot. */
export const blockDate = closeDate;
export const unblockDate = reopenDate;
export const setDateClosed = closeDate;

/** Every closed UTC date for the caller's shop, ascending. */
export async function listClosedDatesForWallet(db: Db, walletAddress: string): Promise<string[]> {
  const providerProfileId = await ownProviderId(db, walletAddress);
  return listClosedDates(db, providerProfileId);
}
