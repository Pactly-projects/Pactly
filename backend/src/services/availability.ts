/**
 * Closing a whole date (this issue's own slice of availability): a shop
 * that will not work on a given day must not leave a client's unpaid hold
 * sitting on that day's slot until its ten-minute clock runs out.
 *
 * "Closing a date" here means removing that date's concrete future slots
 * (this build has no recurring weekly rule to preserve -- every other date
 * is left exactly as it was) and releasing every still-active, unpaid hold
 * whose slot starts on it. A booking that already has a funded escrow is
 * never touched: the response names it in `needsResolution`, which the
 * provider panel shows with a link to Bookings. Storage for a *blocked*
 * date as its own row is explicitly out of scope for this issue.
 *
 * No SQL lives here -- the two writes are `db/bookings.ts`'s
 * `releaseUnpaidHoldsForProviderDate` and `db/availabilitySlots.ts`'s
 * `closeSlotsInRange`.
 */
import { closeSlotsInRange, getSlotByProviderAndStart } from "../db/availabilitySlots.js";
import { releaseUnpaidHoldsForProviderDate, rescheduleBookingSlot } from "../db/bookings.js";
import type { Db } from "../db/client.js";
import { getProviderProfileById, getProviderProfileByWallet } from "../db/providerProfiles.js";
import {
  BookingEscrowStateError,
  SlotUnavailableError,
  getBookingForClient,
  getBookingView,
  type BookingView,
} from "./booking.js";
import { NotAProviderError } from "./profile.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_SECONDS = 24 * 60 * 60;
/** `Date#getTimezoneOffset`'s own documented range, in minutes. */
const MIN_TZ_OFFSET_MINUTES = -14 * 60;
const MAX_TZ_OFFSET_MINUTES = 14 * 60;

/** A locked booking can only move while its own free-cancellation window
 * (the existing `cancel_deadline`) is still open. */
export class BookingOutsideCancellationWindowError extends Error {
  constructor(message = "This booking is past its free-cancellation window and can no longer move.") {
    super(message);
    this.name = "BookingOutsideCancellationWindowError";
  }
}

export class InvalidCloseDateError extends Error {
  readonly details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("Pick a valid date to close.");
    this.name = "InvalidCloseDateError";
    this.details = details;
  }
}

export interface CloseProviderDateInput {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** `new Date().getTimezoneOffset()` from the caller's browser -- the same
   * signed-minutes convention `POST /bookings/hold` already uses. Omitted
   * means UTC. */
  tzOffsetMinutes?: number;
}

export interface CloseProviderDateView {
  date: string;
  /** UTC epoch seconds of the local day's start/end, echoed so a caller can
   * check exactly which window was closed. */
  rangeStart: number;
  rangeEnd: number;
  releasedHoldCount: number;
  releasedBookingIds: string[];
  /** Future open slots removed from this date's availability. */
  closedSlotCount: number;
  /** Funded bookings left alone -- the shop resolves these from Bookings. */
  needsResolution: Array<{ bookingId: string; slotStartsAt: number }>;
}

/**
 * Turns a local `YYYY-MM-DD` plus the browser's offset into the UTC epoch
 * window`[start, end)`. Offset sign matches `getTimezoneOffset`: it is UTC
 * minus local, so local midnight is `Date.UTC(...) + offset * 60_000`.
 * Throws {@link InvalidCloseDateError} for a malformed or impossible date,
 * or a non-integer/out-of-range offset -- never a raw `Date` NaN.
 */
export function localDateRange(
  date: string,
  tzOffsetMinutes = 0,
): { rangeStart: number; rangeEnd: number } {
  const match = DATE_PATTERN.exec(date);
  if (!match) {
    throw new InvalidCloseDateError({ date: "Use a calendar date in YYYY-MM-DD form." });
  }
  if (
    !Number.isInteger(tzOffsetMinutes) ||
    tzOffsetMinutes < MIN_TZ_OFFSET_MINUTES ||
    tzOffsetMinutes > MAX_TZ_OFFSET_MINUTES
  ) {
    throw new InvalidCloseDateError({ tzOffsetMinutes: "Timezone offset must be whole minutes between -840 and 840." });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMidnight = Date.UTC(year, month - 1, day);
  const check = new Date(utcMidnight);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new InvalidCloseDateError({ date: "That date does not exist." });
  }
  const rangeStart = Math.floor(utcMidnight / 1000) + tzOffsetMinutes * 60;
  return { rangeStart, rangeEnd: rangeStart + DAY_SECONDS };
}

/**
 * `POST /bookings/:id/reschedule`: moves the caller's own locked booking to
 * another open slot of the same shop, inside the booking's free-cancellation
 * window. Only `slot_id` and `cancel_deadline` are written -- the escrow
 * contract id, deposit amounts, client and provider are untouched, so the
 * deposit keeps sitting in the same contract and no second escrow is
 * created. The old slot simply stops being booked (it becomes available);
 * the new slot becomes this booking's slot.
 *
 * The target is looked up by this booking's own `provider_profile_id`, so a
 * different shop's slot can never match, and both slots share the one
 * `sessionLengthMinutes` that belongs to that shop -- the duration is
 * therefore the same by construction. A slot taken between the caller's
 * click and this write makes the atomic DB move return `false`, which is
 * surfaced as {@link SlotUnavailableError}; nothing is overwritten.
 */
export async function rescheduleLockedBooking(
  db: Db,
  bookingId: string,
  walletAddress: string,
  newSlotStartsAt: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<BookingView> {
  const booking = await getBookingForClient(db, bookingId, walletAddress);
  if (booking.escrowState !== "locked") {
    throw new BookingEscrowStateError("Only a booking with a locked deposit can move to another time.");
  }
  if (now >= booking.cancelDeadline) {
    throw new BookingOutsideCancellationWindowError();
  }
  if (!booking.slotId) {
    throw new SlotUnavailableError("This booking has no slot to move from.");
  }
  if (!Number.isInteger(newSlotStartsAt)) {
    throw new SlotUnavailableError("Pick a valid slot start time.");
  }

  const newSlot = await getSlotByProviderAndStart(db, booking.providerProfileId, newSlotStartsAt);
  if (!newSlot || newSlot.withdrawnAt !== null || newSlot.startsAt <= now) {
    throw new SlotUnavailableError("That time is no longer open.");
  }
  if (newSlot.id === booking.slotId) {
    return getBookingView(db, bookingId, walletAddress);
  }

  const profile = await getProviderProfileById(db, booking.providerProfileId);
  if (!profile) {
    // Unreachable: `provider_profile_id` is a foreign key.
    throw new SlotUnavailableError("That shop no longer has a profile.");
  }
  const newCancelDeadline = newSlot.startsAt - profile.cancellationWindowHours * 3600;

  const moved = await rescheduleBookingSlot(db, bookingId, booking.slotId, newSlot.id, newCancelDeadline, now);
  if (!moved) {
    throw new SlotUnavailableError("That time was taken just now. Pick another open time.");
  }
  return getBookingView(db, bookingId, walletAddress);
}

/**
 * `POST /me/provider/availability/close-date`: resolves the caller's own
 * provider profile, releases the date's active unpaid holds (recording
 * `shop-closed-date` on them so their clients see why), then removes that
 * date's future open slots. Other dates are untouched. Idempotent: closing
 * an already-closed or hold-free date succeeds and reports zero releases.
 */
export async function closeProviderDate(
  db: Db,
  walletAddress: string,
  input: CloseProviderDateInput,
  now: number = Math.floor(Date.now() / 1000),
): Promise<CloseProviderDateView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  const { rangeStart, rangeEnd } = localDateRange(input.date, input.tzOffsetMinutes ?? 0);

  const release = await releaseUnpaidHoldsForProviderDate(db, profile.id, rangeStart, rangeEnd, now);
  const closedSlotCount = await closeSlotsInRange(db, profile.id, rangeStart, rangeEnd, now);

  return {
    date: input.date,
    rangeStart,
    rangeEnd,
    releasedHoldCount: release.released.length,
    releasedBookingIds: release.released.map((booking) => booking.bookingId),
    closedSlotCount,
    needsResolution: release.needsResolution.map((booking) => ({
      bookingId: booking.bookingId,
      slotStartsAt: booking.slotStartsAt,
    })),
  };
}
