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
import { closeSlotsInRange } from "../db/availabilitySlots.js";
import { releaseUnpaidHoldsForProviderDate } from "../db/bookings.js";
import type { Db } from "../db/client.js";
import { getProviderProfileByWallet } from "../db/providerProfiles.js";
import { NotAProviderError } from "./profile.js";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_SECONDS = 24 * 60 * 60;
/** `Date#getTimezoneOffset`'s own documented range, in minutes. */
const MIN_TZ_OFFSET_MINUTES = -14 * 60;
const MAX_TZ_OFFSET_MINUTES = 14 * 60;

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
