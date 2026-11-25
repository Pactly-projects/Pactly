/**
 * Closing a whole date (this issue's own slice of availability): a shop
 * that will not work on a given day must not leave a client's unpaid hold
 * sitting on that day's slot until its ten-minute clock runs out.
 *
 * A single day off must not mean deleting that day's slots and rebuilding
 * them next week, so a closure hides a *calendar date*; the slot rows stay
 * exactly where they are and reopening the date reveals them again. Nothing
 * here touches bookings: a date holding a locked booking is refused outright
 * (with the booking's id, so the panel can name it) rather than silently
 * cancelling anyone's appointment.
 *
 * No SQL lives here -- the two writes are `db/bookings.ts`'s
 * `releaseUnpaidHoldsForProviderDate` and `db/availabilitySlots.ts`'s
 * `closeSlotsInRange`.
 */
import { and, eq } from "drizzle-orm";

import {
  closeSlotsInRange,
  getSlotByProviderAndStart,
  listEarliestFutureSlotsByProvider,
  listOpenFutureSlots,
  listOpenSlotsInRange,
  type ListFutureSlotsOptions,
} from "../db/availabilitySlots.js";
import { availabilitySlots, bookings } from "../db/schema.js";
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
import { zonedClock } from "./timezone.js";

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

// ---------------------------------------------------------------------------
// Issue #65: a break cut out of one day's hours.
//
// A weekday's working hours are a continuous range; a break is a
// `[startMinute, endMinute)` window inside that range, named in the shop's
// own wall clock. Slots are not offered during it; the hours before and
// after stay bookable. Everything here is pure -- `services/profile.ts`
// owns the database writes.
// ---------------------------------------------------------------------------

export interface ProviderBreak {
  /** `0` = Sunday .. `6` = Saturday, in the shop's timezone. */
  weekday: number;
  /** Minutes since the shop's midnight (0..1440). */
  startMinute: number;
  endMinute: number;
}

export interface WorkingRange {
  startMinute: number;
  endMinute: number;
}

/** A break that is malformed, overlaps another, or sits outside the day's
 * own working hours. `details` names the offending value(s) -- never a raw
 * error at the HTTP boundary. */
export class InvalidBreaksError extends Error {
  readonly details: Record<string, unknown>;
  constructor(details: Record<string, unknown>) {
    super("One or more breaks are invalid.");
    this.name = "InvalidBreaksError";
    this.details = details;
  }
}

const MINUTES_PER_DAY = 24 * 60;

/** Validates the request shape and returns normalized, sorted breaks.
 * Rejects an out-of-range weekday/minute, an empty or inverted window, and
 * two breaks that overlap on the same weekday. */
export function validateBreaks(input: unknown): ProviderBreak[] {
  if (!Array.isArray(input)) {
    throw new InvalidBreaksError({ breaks: "Breaks must be an array." });
  }

  const breaks: ProviderBreak[] = input.map((raw, index) => {
    const value = (raw ?? {}) as Partial<Record<keyof ProviderBreak, unknown>>;
    const weekday = value.weekday;
    const startMinute = value.startMinute;
    const endMinute = value.endMinute;
    if (typeof weekday !== "number" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      throw new InvalidBreaksError({ [`breaks.${index}.weekday`]: "Weekday must be 0 (Sunday) through 6 (Saturday)." });
    }
    if (
      typeof startMinute !== "number" ||
      !Number.isInteger(startMinute) ||
      startMinute < 0 ||
      startMinute >= MINUTES_PER_DAY
    ) {
      throw new InvalidBreaksError({ [`breaks.${index}.startMinute`]: "Break start must be a minute of the day." });
    }
    if (
      typeof endMinute !== "number" ||
      !Number.isInteger(endMinute) ||
      endMinute <= 0 ||
      endMinute > MINUTES_PER_DAY
    ) {
      throw new InvalidBreaksError({ [`breaks.${index}.endMinute`]: "Break end must be a minute of the day." });
    }
    if (endMinute <= startMinute) {
      throw new InvalidBreaksError({ [`breaks.${index}`]: "A break must end after it starts." });
    }
    return { weekday, startMinute, endMinute };
  });

  const sorted = [...breaks].sort(
    (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute || a.endMinute - b.endMinute,
  );
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (previous.weekday === current.weekday && current.startMinute < previous.endMinute) {
      throw new InvalidBreaksError({ overlapping: [previous, current] });
    }
  }
  return sorted;
}

/** The working range each weekday's own future slots imply -- earliest slot
 * start through the latest slot's end (its start plus one session), in the
 * shop's timezone. Weekdays with no slots have no entry. */
export function workingRangesForSlots(
  slots: number[],
  sessionLengthMinutes: number,
  timeZone: string,
): Map<number, WorkingRange> {
  const ranges = new Map<number, WorkingRange>();
  for (const startsAt of slots) {
    const clock = zonedClock(startsAt, timeZone);
    const endMinute = clock.minuteOfDay + sessionLengthMinutes;
    const existing = ranges.get(clock.weekday);
    if (!existing) {
      ranges.set(clock.weekday, { startMinute: clock.minuteOfDay, endMinute });
    } else {
      existing.startMinute = Math.min(existing.startMinute, clock.minuteOfDay);
      existing.endMinute = Math.max(existing.endMinute, endMinute);
    }
  }
  return ranges;
}

/** Rejects a break that starts before the day's range or ends after it. A
 * weekday with no saved slots has no range to compare against, so its break
 * is accepted as-is. */
export function assertBreaksWithinRanges(
  breaks: ProviderBreak[],
  ranges: Map<number, WorkingRange>,
): void {
  for (const providerBreak of breaks) {
    const range = ranges.get(providerBreak.weekday);
    if (!range) {
      continue;
    }
    if (providerBreak.startMinute < range.startMinute || providerBreak.endMinute > range.endMinute) {
      throw new InvalidBreaksError({
        range: `A break on weekday ${providerBreak.weekday} must start and end inside that day's working hours.`,
      });
    }
  }
}

/** `true` when a slot's own start falls inside one of `breaks` on its
 * weekday (in the shop's timezone). */
export function isSlotInsideBreak(
  startsAt: number,
  timeZone: string,
  breaks: ProviderBreak[],
): boolean {
  if (breaks.length === 0) {
    return false;
  }
  const clock = zonedClock(startsAt, timeZone);
  return breaks.some(
    (providerBreak) =>
      providerBreak.weekday === clock.weekday &&
      clock.minuteOfDay >= providerBreak.startMinute &&
      clock.minuteOfDay < providerBreak.endMinute,
  );
}

/** Every slot outside every break -- what a save actually stores. */
export function filterSlotsOutsideBreaks(
  slots: number[],
  timeZone: string,
  breaks: ProviderBreak[],
): number[] {
  if (breaks.length === 0) {
    return slots;
  }
  return slots.filter((startsAt) => !isSlotInsideBreak(startsAt, timeZone, breaks));
}

// ---------------------------------------------------------------------------
// Issue #52: weekly availability range management and validation.
// ---------------------------------------------------------------------------

export interface WeeklyTimeRange {
  /** 0=Sunday, 1=Monday, ..., 6=Saturday */
  weekday: number;
  /** Start time in minutes from midnight (0-1439) */
  startMinutes: number;
  /** End time in minutes from midnight (0-1439) */
  endMinutes: number;
}

export interface OverlapError {
  weekday: number;
  range1: { start: string; end: string };
  range2: { start: string; end: string };
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

function rangesOverlap(range1: WeeklyTimeRange, range2: WeeklyTimeRange): boolean {
  if (range1.weekday !== range2.weekday) {
    return false;
  }
  return range1.startMinutes < range2.endMinutes && range2.startMinutes < range1.endMinutes;
}

/** Validates that weekly availability ranges don't overlap on the same
 * weekday. Empty array means valid. Touching ranges count as overlapping. */
export function validateWeeklyRanges(ranges: WeeklyTimeRange[]): OverlapError[] {
  const errors: OverlapError[] = [];
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const range1 = ranges[i]!;
      const range2 = ranges[j]!;
      if (rangesOverlap(range1, range2)) {
        errors.push({
          weekday: range1.weekday,
          range1: { start: formatTime(range1.startMinutes), end: formatTime(range1.endMinutes) },
          range2: { start: formatTime(range2.startMinutes), end: formatTime(range2.endMinutes) },
        });
      }
    }
  }
  return errors;
}

export function formatOverlapErrors(errors: OverlapError[]): string {
  if (errors.length === 0) {
    return "";
  }
  return errors
    .map((error) => {
      const weekdayName = WEEKDAY_NAMES[error.weekday] ?? `Day ${error.weekday}`;
      return `${weekdayName}: ${error.range1.start}–${error.range1.end} overlaps with ${error.range2.start}–${error.range2.end}`;
    })
    .join("; ");
}

export class WeeklyRangeOverlapError extends Error {
  constructor(
    public readonly overlaps: OverlapError[],
    message?: string,
  ) {
    super(message || formatOverlapErrors(overlaps));
    this.name = "WeeklyRangeOverlapError";
  }
}

// ---------------------------------------------------------------------------
// The appointment buffer: minutes kept free after a locked booking.
// ---------------------------------------------------------------------------

/** True when `slotStartsAt` falls in the half-open window
 * `[sessionEnd, sessionEnd + buffer)` after a locked booking. */
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
