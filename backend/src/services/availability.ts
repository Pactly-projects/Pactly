/**

 * Issue #52: Weekly availability range management and validation.
 * Providers can define recurring weekly availability ranges (e.g., "Monday 09:00-12:00")
 * that are validated for overlaps before saving.
 */

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

/**
 * Formats minutes since midnight as HH:MM
 */
function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

/**
 * Checks if two time ranges overlap on the same day.
 * A range that ends at another's start is considered an overlap (touching ranges overlap).
 */
function rangesOverlap(range1: WeeklyTimeRange, range2: WeeklyTimeRange): boolean {
  if (range1.weekday !== range2.weekday) {
    return false;
  }
  
  // Two ranges overlap if one starts before the other ends AND the other starts before the first ends
  // Since touching is considered an overlap, we use <= instead of <
  return range1.startMinutes < range2.endMinutes && range2.startMinutes < range1.endMinutes;
}

/**
 * Issue #52: Validates that weekly availability ranges don't overlap on the same weekday.
 * Returns an array of overlap errors. Empty array means valid.
 * 
 * Edge cases:
 * - Ranges on different weekdays may share clock times (not an overlap)
 * - A range that ends at the next range's start is an overlap
 */
export function validateWeeklyRanges(ranges: WeeklyTimeRange[]): OverlapError[] {
  const errors: OverlapError[] = [];
  
  // Check each pair of ranges for overlaps
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const range1 = ranges[i]!;
      const range2 = ranges[j]!;
      
      if (rangesOverlap(range1, range2)) {
        errors.push({
          weekday: range1.weekday,
          range1: {
            start: formatTime(range1.startMinutes),
            end: formatTime(range1.endMinutes),
          },
          range2: {
            start: formatTime(range2.startMinutes),
            end: formatTime(range2.endMinutes),
          },
        });
      }
    }
  }
  
  return errors;
}

/**
 * Formats overlap errors into a human-readable error message.
 */
export function formatOverlapErrors(errors: OverlapError[]): string {
  if (errors.length === 0) {
    return "";
  }
  
  const messages = errors.map((error) => {
    const weekdayName = WEEKDAY_NAMES[error.weekday] ?? `Day ${error.weekday}`;
    return `${weekdayName}: ${error.range1.start}–${error.range1.end} overlaps with ${error.range2.start}–${error.range2.end}`;
  });
  
  return messages.join("; ");
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

/**
 * Availability services: one-off closures as an overlay on a provider's
 * repeating slot pattern, and the appointment buffer that keeps a gap after
 * a locked booking.
 *
 * A single day off must not mean deleting that day's slots and rebuilding
 * them next week, so a closure hides a *calendar date*; the slot rows stay
 * exactly where they are and reopening the date reveals them again. Nothing
 * here touches bookings: a date holding a locked booking is refused outright
 * (with the booking's id, so the panel can name it) rather than silently
 * cancelling anyone's appointment.
 *
 * After a locked booking ends, `bufferMinutes` stay free before another
 * slot of the same shop is offered. Weekly hours and existing locked
 * bookings are never rewritten here -- this module only filters what clients
 * are shown (and what `holdSlot` may claim).
 * Availability services:
 * - Weekly recurring availability validation (Issue #52)
 * - Break windows inside a day's hours (Issue #65)
 * - One-off date closures as an overlay on repeating patterns
 * - Appointment buffer gaps between bookings
 * - Rescheduling locked bookings and provider date closure window
 */
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { availabilitySlots, bookings } from "../db/schema.js";
import {
  closeSlotsInRange,
  getSlotById,
  getSlotByProviderAndStart,
  listEarliestFutureSlotsByProvider,
  listOpenFutureSlots,
  listOpenSlotsInRange,
  type ListFutureSlotsOptions,
} from "../db/availabilitySlots.js";
import { releaseUnpaidHoldsForProviderDate, rescheduleBookingSlot } from "../db/bookings.js";
import {
  releaseUnpaidHoldsForProviderDate,
  rescheduleBookingSlot,
} from "../db/bookings.js";
import {
  isValidClosedDate,
  insertClosedDate,
  deleteClosedDate,
  isDateClosed,
  listClosedDates,
  listLockedBookingsOnDate,
} from "../db/closedDates.js";
import { getProviderProfileById, getProviderProfileByWallet } from "../db/providerProfiles.js";
import { NotAProviderError } from "./profile.js";
import {
  BookingEscrowStateError,
  SlotUnavailableError,
  getBookingForClient,
  getBookingView,
  type BookingView,
} from "./booking.js";
import { NotAProviderError } from "./profile.js";
import { zonedClock } from "./timezone.js";

export { NotAProviderError };
// ---------------------------------------------------------------------------
// Weekly availability range validation (Issue #52)
// ---------------------------------------------------------------------------
/**
 * Issue #52: Weekly availability range management and validation.
 * Providers can define recurring weekly availability ranges (e.g., "Monday 09:00-12:00")
 * that are validated for overlaps before saving.
 */

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

/**
 * Formats minutes since midnight as HH:MM
 */
function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

/**
 * Checks if two time ranges overlap on the same day.
 * A range that ends at another's start is considered an overlap (touching ranges overlap).
 */
function rangesOverlap(range1: WeeklyTimeRange, range2: WeeklyTimeRange): boolean {
  if (range1.weekday !== range2.weekday) {
    return false;
  }
  
  // Two ranges overlap if one starts before the other ends AND the other starts before the first ends
  // Since touching is considered an overlap, we use <= instead of <
  return range1.startMinutes <= range2.endMinutes && range2.startMinutes <= range1.endMinutes;
}

/**
 * Issue #52: Validates that weekly availability ranges don't overlap on the same weekday.
 * Returns an array of overlap errors. Empty array means valid.
 * 
 * Edge cases:
 * - Ranges on different weekdays may share clock times (not an overlap)
 * - A range that ends at the next range's start is an overlap
 */
export function validateWeeklyRanges(ranges: WeeklyTimeRange[]): OverlapError[] {
  const errors: OverlapError[] = [];
  
  // Check each pair of ranges for overlaps
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const range1 = ranges[i]!;
      const range2 = ranges[j]!;
      
      if (rangesOverlap(range1, range2)) {
        errors.push({
          weekday: range1.weekday,
          range1: {
            start: formatTime(range1.startMinutes),
            end: formatTime(range1.endMinutes),
          },
          range2: {
            start: formatTime(range2.startMinutes),
            end: formatTime(range2.endMinutes),
          },
        });
      }
    }
  }
  
  return errors;
}

/**
 * Formats overlap errors into a human-readable error message.
 */
export function formatOverlapErrors(errors: OverlapError[]): string {
  if (errors.length === 0) {
    return "";
  }
  
  const messages = errors.map((error) => {
    const weekdayName = WEEKDAY_NAMES[error.weekday] ?? `Day ${error.weekday}`;
    return `${weekdayName}: ${error.range1.start}–${error.range1.end} overlaps with ${error.range2.start}–${error.range2.end}`;
  });
  
  return messages.join("; ");
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
// Break windows inside working hours (Issue #65)
// ---------------------------------------------------------------------------
/**
 * Issue #65: a break cut out of one day's hours.
 *
 * A weekday's working hours are a continuous range; a break is a
 * `[startMinute, endMinute)` window inside that range, named in the shop's
 * own wall clock. Slots are not offered during it; the hours before and
 * after stay bookable. Everything here is pure -- `services/profile.ts`
 * owns the database writes.
 */

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
// One-off date closures
// ---------------------------------------------------------------------------
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

/** Alias named for the shop-facing wording of the date-closure overlay. */

/** Alias named for the shop-facing wording. */

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

----------------------------------------------------------------------
// Appointment buffers
// ---------------------------------------------------------------------------
/**
 * Appointment buffer: after a locked booking ends, keep `bufferMinutes`
 * free before another slot of the same shop is offered. Weekly hours and
 * existing locked bookings are never rewritten here -- this module only
 * filters what clients are shown (and what `holdSlot` may claim).
 */
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
// ---------------------------------------------------------------------------
// Issue #65: a break cut out of one day's hours. A weekday's working hours
// are a continuous range; a break is a `[startMinute, endMinute)` window
// inside that range, named in the shop's own wall clock. Slots are not
// offered during it; the hours before and after stay bookable. Everything
// here is pure -- `services/profile.ts` owns the database writes.
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
export function assertBreaksWithinRanges(breaks: ProviderBreak[], ranges: Map<number, WorkingRange>): void {
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
export function isSlotInsideBreak(startsAt: number, timeZone: string, breaks: ProviderBreak[]): boolean {
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
export function filterSlotsOutsideBreaks(slots: number[], timeZone: string, breaks: ProviderBreak[]): number[] {
  if (breaks.length === 0) {
    return slots;
  }
  return slots.filter((startsAt) => !isSlotInsideBreak(startsAt, timeZone, breaks));
}

// ---------------------------------------------------------------------------
// Closing a whole date and moving a locked booking: a shop that will not
// work on a given day must not leave a client's unpaid hold sitting on that
// day's slot, and a locked booking may move inside its free-cancellation
// window without creating a second escrow.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Rescheduling & Date Closure Resolution
// ---------------------------------------------------------------------------
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


const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_SECONDS = 24 * 60 * 60;
/** Longest holiday a single close action may cover, inclusive. */
export const MAX_CLOSE_RANGE_DAYS = 31;
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
    super(details.endDate ?? "Pick a valid date to close.");
    this.name = "InvalidCloseDateError";
    this.details = details;
  }
}

export interface CloseProviderDateInput {
  /** Local calendar date, `YYYY-MM-DD` -- the first day closed. */
  date: string;
  /** Optional last day closed, inclusive, `YYYY-MM-DD`. Omitted means only
   * `date`. At most {@link MAX_CLOSE_RANGE_DAYS} days in all. */
  endDate?: string;
  /** `new Date().getTimezoneOffset()` from the caller's browser -- the same
   * signed-minutes convention `POST /bookings/hold` already uses. Omitted
   * means UTC. */
  tzOffsetMinutes?: number;
}

export interface CloseProviderDateView {
  date: string;
  endDate: string;
  /** Number of calendar dates closed (1 for a single date). */
  dayCount: number;
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
 * window `[start, end)`. Offset sign matches `getTimezoneOffset`: it is UTC
 * minus local, so local midnight is `Date.UTC(...) + offset * 60_000`.
 */
export function localDateRange(date: string, tzOffsetMinutes = 0): { rangeStart: number; rangeEnd: number } {
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
 * contract id, deposit amounts, client and provider are untouched.
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
 * provider profile and closes one date, or every date from `date` through
 * `endDate` inclusive (at most 31). Releases those dates' active unpaid holds (recording
 * `shop-closed-date` on them so their clients see why), then removes that
 * date's future open slots. Other dates are untouched.
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
  const tzOffset = input.tzOffsetMinutes ?? 0;
  const endDate = input.endDate && input.endDate !== "" ? input.endDate : input.date;
  const { rangeStart } = localDateRange(input.date, tzOffset);
  const { rangeEnd } = localDateRange(endDate, tzOffset);
  if (rangeEnd <= rangeStart) {
    throw new InvalidCloseDateError({ endDate: "The end date cannot be before the start date." });
  }
  const dayCount = Math.round((rangeEnd - rangeStart) / DAY_SECONDS);
  if (dayCount > MAX_CLOSE_RANGE_DAYS) {
    throw new InvalidCloseDateError({ endDate: `Close at most ${MAX_CLOSE_RANGE_DAYS} days at once.` });
  }

  const release = await releaseUnpaidHoldsForProviderDate(db, profile.id, rangeStart, rangeEnd, now);
  const closedSlotCount = await closeSlotsInRange(db, profile.id, rangeStart, rangeEnd, now);

  return {
    date: input.date,
    endDate,
    dayCount,
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