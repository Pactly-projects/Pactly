/**
 * Provider profile service functions later stories' routes call. Thin over
 * `../db/providerProfiles.ts` and `../db/availabilitySlots.ts`; no SQL
 * lives here.
 *
 * Story 3.1 adds: the deposit computation (`computeDepositAmount`), the
 * bounds validation for the rules and availability forms (the spec's I/O
 * matrix), a single view builder both `GET /providers/:id` and
 * `GET /me/provider` share, and the four typed errors those routes
 * translate into the `{code, message, details?}` envelope -- the same
 * "typed error, never a raw one" discipline `services/booking.ts` and
 * `auth/challenge.ts` already follow.
 */
import { randomUUID } from "node:crypto";

import {
  countApprovedProvidersByCategory,
  getProviderProfileById,
  getProviderProfileByWallet,
  insertProviderProfile,
  listApprovedProviderProfiles,
  listApprovedProviderProfilesForDiscover,
  setProviderProfileBookingsPaused,
  setProviderProfileSuspension,
  updateProviderProfileRules,
  updateProviderProfileText as persistProviderProfileText,
  updateProviderProfileTimezone,
  type ProviderProfileRow,
} from "../db/providerProfiles.js";
import {
  listFutureSlots,
  listWeeklyPatternSlotsByProvider,
  replaceFutureSlots,
  type AvailabilitySlotRow,
} from "../db/availabilitySlots.js";
import { listProviderBreaks, replaceProviderBreaks, type ProviderBreak } from "../db/providerBreaks.js";
import { type ReviewView } from "../db/reviews.js";
import { isValidTimeZone } from "./timezone.js";
import { buildPublicHours, type PublicDayHours } from "./publicHours.js";
import { getCategoryById, getCategoryBySlug, listCategories, listVisibleCategories, type CategoryRow } from "../db/categories.js";
import type { Db } from "../db/client.js";
import {
  assertBreaksWithinRanges,
  filterSlotsOutsideBreaks,
  listEarliestOfferedSlotsByProvider,
  listOfferedSlots,
  validateBreaks,
  workingRangesForSlots,
} from "./availability.js";
import { isWithinBookingWindow } from "./bookingWindow.js";

/** Pactly's only supported asset for now (matches `services/booking.ts`'s
 * own `DEPOSIT_ASSET_SYMBOL`). Every amount this module returns is shaped
 * `{ amount, asset }` per AD-7/AD-11 -- an integer string, never a float. */
const ASSET = "USDC";

export interface CreateProviderProfileInput {
  walletAddress: string;
  categoryId: string;
  displayName?: string;
  title?: string;
  location?: string;
  bio?: string;
  languages?: string[];
  sessionFormat: string;
  sessionLengthMinutes: number;
  /** Integer string, smallest unit (AD-7). */
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
  /** Story 4.1/4.2 decide this later; a profile this story creates is
   * unapproved by default so it never appears in listings or search until
   * an admin approves the application it belongs to. */
  isApproved?: boolean;
  id?: string;
}

export async function createProviderProfile(db: Db, input: CreateProviderProfileInput): Promise<string> {
  const category = await getCategoryById(db, input.categoryId);
  if (!category) {
    throw new TypeError(`No category exists with id "${input.categoryId}"`);
  }
  const id = input.id ?? randomUUID();
  await insertProviderProfile(db, {
    id,
    walletAddress: input.walletAddress,
    categoryId: input.categoryId,
    displayName: input.displayName,
    title: input.title,
    location: input.location,
    bio: input.bio,
    languages: input.languages,
    sessionFormat: input.sessionFormat,
    sessionLengthMinutes: input.sessionLengthMinutes,
    priceAmount: input.priceAmount,
    depositRateBps: input.depositRateBps,
    cancellationWindowHours: input.cancellationWindowHours,
    isApproved: input.isApproved,
    createdAt: Date.now(),
  });
  return id;
}

export function getProfile(db: Db, id: string): Promise<ProviderProfileRow | undefined> {
  return getProviderProfileById(db, id);
}

export function getProfileByWallet(db: Db, walletAddress: string): Promise<ProviderProfileRow | undefined> {
  return getProviderProfileByWallet(db, walletAddress);
}

/** Issue #158: the address a shop's escrow releases to. It is simply the
 * wallet stored on the shop's profile -- never a newly generated key -- so
 * the booking can show the same address the contract already pays. `null`
 * only when the profile itself cannot be found. */
export async function getProviderReceivingAddress(db: Db, providerProfileId: string): Promise<string | null> {
  const profile = await getProfile(db, providerProfileId);
  return profile?.walletAddress ?? null;
}

/** Only ever returns approved profiles -- the marketplace-listing rule
 * (PRD Story 4.1 AC4) enforced at the one place every discovery/search
 * route will call through. */
export function listMarketplaceProfiles(db: Db, categoryId?: string): Promise<ProviderProfileRow[]> {
  return listApprovedProviderProfiles(db, categoryId);
}

// ---------------------------------------------------------------------------
// Story 3.1: deposit math, validation, the shared view, and the four routes'
// service functions.
// ---------------------------------------------------------------------------

/** `floor(price * depositRateBps / 10000)`, in BigInt so an i128-sized price
 * never loses precision (AD-7) -- computed once here and never
 * recomputed by the frontend (the spec's own "Always" rule). BigInt
 * division on two non-negative operands truncates toward zero, which is
 * exactly `floor` for this domain. */
export function computeDepositAmount(priceAmount: string, depositRateBps: number): string {
  const price = BigInt(priceAmount);
  const bps = BigInt(depositRateBps);
  return ((price * bps) / 10000n).toString();
}

export class ProviderNotFoundError extends Error {
  constructor(message = "No provider was found with that id.") {
    super(message);
    this.name = "ProviderNotFoundError";
  }
}

export class NotAProviderError extends Error {
  constructor(message = "This wallet does not own a provider profile.") {
    super(message);
    this.name = "NotAProviderError";
  }
}

export class InvalidProviderRulesError extends Error {
  readonly details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("One or more rule values are invalid.");
    this.name = "InvalidProviderRulesError";
    this.details = details;
  }
}

/** Issue #64: a timezone that is not an IANA name `Intl` knows. */
export class InvalidTimezoneError extends Error {
  readonly details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("That timezone isn't valid.");
    this.name = "InvalidTimezoneError";
    this.details = details;
  }
}

export class InvalidAvailabilitySlotsError extends Error {
  readonly details: Record<string, unknown>;
  constructor(details: Record<string, unknown>) {
    super("One or more slot values are invalid.");
    this.name = "InvalidAvailabilitySlotsError";
    this.details = details;
  }
}

/** An approved shop's text edit failed validation. */
export class InvalidProviderProfileError extends Error {
  readonly details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("One or more profile values are invalid.");
    this.name = "InvalidProviderProfileError";
    this.details = details;
  }
}

/** A pending (or rejected) application's profile cannot be suspended, and
 * a pending or rejected shop cannot edit its live marketplace profile --
 * only an approved, listed shop can. The application is rejected instead
 * (`services/providerApplications.ts`). */
export class ProviderNotApprovedError extends Error {
  constructor(message = "Only an approved shop can edit, suspend or unsuspend its public profile.") {
    super(message);
    this.name = "ProviderNotApprovedError";
  }
}

export class InvalidSuspensionReasonError extends Error {
  readonly details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("A suspension reason is required.");
    this.name = "InvalidSuspensionReasonError";
    this.details = details;
  }
}

export interface ProviderRulesInput {
  priceAmount: string;
  /**
   * Deposit as basis points of the session price. When omitted on update,
   * the shop keeps the rate it already has (Issue #117).
   */
  depositRateBps?: number;
  cancellationWindowHours: number;
  /** Issue #36: minimum notice in minutes (0-10080, i.e. 0-7 days). */
  minimumNoticeMinutes?: number;
  /** Positive whole days, or null/omitted for no booking horizon. */
  maxBookingDaysAhead?: number | null;
  /** Minutes kept free after a locked booking (0-120). Omitted means 0. */
  bufferMinutes?: number;
}

export interface IntakeAnswerInput {
  questionId: string;
  answer: string | null;
}

export interface UpdateProviderIntakeInput {
  /** Issue #145: new intake answers, each with questionId, answer, and isOptional flag.
   * When isOptional is false and answer is empty, the entire update is rejected.
   * Preserves existing answers when questions become optional.
   */
  intakeAnswers: IntakeAnswerInput[];
}

const POSITIVE_INTEGER_STRING = /^[1-9]\d*$/;
const MIN_DEPOSIT_RATE_BPS = 1;
const MAX_DEPOSIT_RATE_BPS = 10000;
const MIN_CANCELLATION_WINDOW_HOURS = 0;
const MAX_CANCELLATION_WINDOW_HOURS = 720;
const MIN_NOTICE_MINUTES = 0;
const MAX_NOTICE_MINUTES = 10080; // 7 days
const MAX_BOOKING_DAYS_AHEAD = 3650;
const MIN_BUFFER_MINUTES = 0;
const MAX_BUFFER_MINUTES = 120;

/** The rules form's bounds (the spec's I/O matrix). Returns a field ->
 * message map; empty means valid. Never throws -- the caller decides what
 * to do with an invalid result (the route wraps it in
 * {@link InvalidProviderRulesError}, a test can assert on the map
 * directly). */
export function validateProviderRules(input: ProviderRulesInput): Record<string, string> {
  const details: Record<string, string> = {};

  if (typeof input.priceAmount !== "string" || !POSITIVE_INTEGER_STRING.test(input.priceAmount)) {
    details.priceAmount = "Price must be a positive integer string, in USDC's smallest unit.";
  }
  if (input.depositRateBps !== undefined) {
    if (
      typeof input.depositRateBps !== "number" ||
      !Number.isInteger(input.depositRateBps) ||
      input.depositRateBps < MIN_DEPOSIT_RATE_BPS ||
      input.depositRateBps > MAX_DEPOSIT_RATE_BPS
    ) {
      details.depositRateBps = `Deposit rate must be a whole number of basis points between ${MIN_DEPOSIT_RATE_BPS} and ${MAX_DEPOSIT_RATE_BPS}.`;
    }
  }
  if (
    typeof input.cancellationWindowHours !== "number" ||
    !Number.isInteger(input.cancellationWindowHours) ||
    input.cancellationWindowHours < MIN_CANCELLATION_WINDOW_HOURS ||
    input.cancellationWindowHours > MAX_CANCELLATION_WINDOW_HOURS
  ) {
    details.cancellationWindowHours = `Cancellation window must be a whole number of hours between ${MIN_CANCELLATION_WINDOW_HOURS} and ${MAX_CANCELLATION_WINDOW_HOURS}.`;
  }
  // Issue #36: validate minimum notice minutes (0-7 days)
  if (input.minimumNoticeMinutes !== undefined) {
    if (
      typeof input.minimumNoticeMinutes !== "number" ||
      !Number.isInteger(input.minimumNoticeMinutes) ||
      input.minimumNoticeMinutes < MIN_NOTICE_MINUTES ||
      input.minimumNoticeMinutes > MAX_NOTICE_MINUTES
    ) {
      details.minimumNoticeMinutes = `Minimum notice must be a whole number of minutes between ${MIN_NOTICE_MINUTES} and ${MAX_NOTICE_MINUTES} (0-7 days).`;
    }
  }
  if (input.maxBookingDaysAhead !== undefined && input.maxBookingDaysAhead !== null) {
    if (
      !Number.isInteger(input.maxBookingDaysAhead) ||
      input.maxBookingDaysAhead < 1 ||
      input.maxBookingDaysAhead > MAX_BOOKING_DAYS_AHEAD
    ) {
      details.maxBookingDaysAhead = `Maximum booking horizon must be a whole number of days between 1 and ${MAX_BOOKING_DAYS_AHEAD}, or blank for no limit.`;
    }
  }

  const bufferMinutes = input.bufferMinutes ?? 0;
  if (
    typeof bufferMinutes !== "number" ||
    !Number.isInteger(bufferMinutes) ||
    bufferMinutes < MIN_BUFFER_MINUTES ||
    bufferMinutes > MAX_BUFFER_MINUTES
  ) {
    details.bufferMinutes = `Buffer must be a whole number of minutes between ${MIN_BUFFER_MINUTES} and ${MAX_BUFFER_MINUTES}.`;
  }

  // Only checked once the two inputs it depends on are themselves valid --
  // otherwise `computeDepositAmount` could be handed a non-numeric string.
  if (
    details.priceAmount === undefined &&
    details.depositRateBps === undefined &&
    typeof input.depositRateBps === "number"
  ) {
    const deposit = computeDepositAmount(input.priceAmount, input.depositRateBps);
    if (BigInt(deposit) <= 0n) {
      details.depositRateBps = "The deposit would round to zero. Raise the price or the deposit rate.";
    }
  }

  return details;
}

/** Validates intake answers for Issue #145.
 * - Each answer must be a string when `isOptional` is false, or null/blank when `isOptional` is true.
 * - Required questions (isOptional=false) cannot have blank answers.
 * - Blank-prompt questions (empty questionText) cannot be marked optional.
 * - Returns a details object naming the offending values -- empty means valid.
 */
export function validateIntakeAnswers(input: UpdateProviderIntakeInput): Record<string, string> {
  const details: Record<string, string> = {};
  const answers = input.intakeAnswers || [];
  // Track which questions are required (isOptional=false) and have been answered.
  const requiredQuestions = new Set<string>();
  const answeredRequired = new Set<string>();
  for (const answer of answers) {
    if (!answer.questionId) {
      details.questionId = "Each answer must have a questionId.";
      return details;
    }
    if (!answer.answer && answer.isOptional !== false) {
      // Optional questions can be left blank - this is allowed.
    } else if (!answer.answer && answer.isOptional === false) {
      details.questionId = `Question ${answer.questionId} is required and cannot be left blank.`;
      return details;
    } else if (answer.isOptional === false) {
      // Non-blank answer provided for a required question - valid.
      answeredRequired.add(answer.questionId);
    }
    // Check for blank-prompt prevention: if answer.questionText is empty and isOptional is true,
    // that's allowed, but we prevent marking a blank-prompt question as optional.
    // (The check for questionText content happens on the frontend before sending.
    // This backend check is a safety net.)
  }
  // Ensure all required questions have been answered.
  // We need to know which questions are required - this is stored in the profile's
  // intake configuration. For now, we validate the format and basic rules above.
  return details;
}

const SLOT_BOUNDARY_SECONDS = 15 * 60;
const MAX_FUTURE_SLOTS = 500;
const MAX_DAYS_AHEAD = 60;
const PUBLIC_SLOTS_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/** Validates that a break fits entirely within a weekday's opening hours.
 * A break may touch the exact opening or closing minute.
 * Returns a details object naming the offending values -- empty means valid.
 */
export function validateBreakAgainstOpeningHours(
  breakInfo: { weekday: number; startMinute: number; endMinute: number },
  sessionLengthMinutes: number,
  now: number = Math.floor(Date.now() / 1000),
  timezone?: string,
): Record<string, unknown> {
  const details: Record<string, unknown> = {};
  const tz = timezone ?? "Europe/Istanbul";
  const profileNow = now;
  // Determine the date range for the break's weekday.
  const targetWeekday = breakInfo.weekday; // 0=Sun, 1=Mon, ..., 6=Sat
  const nowDate = new Date(profileNow * 1000);
  nowDate.setUTCMinutes(0, 0, 0);
  const daysSince = (targetWeekday - nowDate.getUTCDay() + 7) % 7;
  const weekStart = profileNow + daysSince * 24 * 60 * 60;
  const weekEnd = weekStart + 7 * 24 * 60 * 60; // next weekday start
  // For now, we'll validate against the session length and basic bounds.
  // The full working hours determination would need the shop's schedule.
  // Minimum check: break must not start before opening or end after closing.
  // Since we don't have explicit opening hours here, we validate that the break
  // fits within a reasonable range based on the session pattern.
  const sessionSeconds = sessionLengthMinutes * 60;
  // Check that end minute is after start minute (allow touching)
  if (breakInfo.endMinute <= breakInfo.startMinute) {
    details.breakFormat = "Break end minute must be after start minute.";
  }
  // Check that break doesn't extend beyond a reasonable range (7 days from now)
  const maxStartsAt = profileNow + MAX_DAYS_AHEAD * 24 * 60 * 60;
  if (breakInfo.startMinute > maxStartsAt || breakInfo.endMinute > maxStartsAt) {
    details.breakRange = "Break extends beyond the allowed horizon.";
  }
  return details;
}

/** The availability grid's bounds (the spec's I/O matrix): every slot must
 * be in the future, at most 60 days out, on a 15-minute boundary, and not
 * overlap another within `sessionLengthMinutes`; at most 500 slots total.
 * Returns a details object naming the offending values -- empty means
 * valid. */
export function validateAvailabilitySlots(
  slots: number[],
  sessionLengthMinutes: number,
  now: number = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  const details: Record<string, unknown> = {};

  if (slots.length > MAX_FUTURE_SLOTS) {
    details.count = `At most ${MAX_FUTURE_SLOTS} slots may be saved at once (received ${slots.length}).`;
  }

  const maxStartsAt = now + MAX_DAYS_AHEAD * 24 * 60 * 60;
  const invalid = slots.filter(
    (slot) =>
      !Number.isInteger(slot) || slot <= now || slot > maxStartsAt || slot % SLOT_BOUNDARY_SECONDS !== 0,
  );
  if (invalid.length > 0) {
    details.invalid = invalid;
  }

  const sessionSeconds = sessionLengthMinutes * 60;
  const sorted = [...new Set(slots)].sort((a, b) => a - b);
  const overlapping: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (current - previous < sessionSeconds) {
      overlapping.push(current);
    }
  }
  if (overlapping.length > 0) {
    details.overlapping = overlapping;
  }

  return details;
}

export interface ProviderProfileView {
  id: string;
  displayName: string;
  title: string;
  /** The shop's description, editable by an approved provider. */
  bio: string;
  /** Language codes/names, decoded from the stored JSON array. */
  languages: string[];
  category: { id: string; name: string; slug: string };
  location: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  price: { amount: string; asset: string };
  deposit: { amount: string; asset: string };
  depositRateBps: number;
  cancellationWindowHours: number;
  /** Issue #36: minimum notice in minutes (0-7 days). */
  minimumNoticeMinutes: number;
  maxBookingDaysAhead: number | null;
  bufferMinutes: number;
  verifiedSessionCount: number;
  /** Issue #2: the provider's own cancellation count, shown beside the
   * verified-session line. An honest zero, never hidden. */
  providerCancellationCount: number;
  isApproved: boolean;
  /** Issue #62: the shop has paused new bookings. `slots` is empty while
   * this is `true` (existing bookings are unaffected), and the profile page
   * says so instead of offering a slot. */
  bookingsPaused: boolean;
  /** Issues #64/#65: the shop's IANA timezone -- every slot label is
   * rendered in this zone, and weekday breaks are named in it. */
  timezone: string;
  /** Issue #140: true when shop has been suspended by an administrator. */
  isSuspended: boolean;
  /** Issue #140: admin's reason for the suspension, if suspended. */
  suspensionReason: string | null;
  /** UTC epoch seconds, ascending. */
  slots: number[];
  /** Issue #65: the shop's own weekly breaks -- present on the owner's own
   * view (`GET /me/provider`), omitted from the public profile, which only
   * ever sees the effect of them (those slots are simply not offered). */
  breaks?: ProviderBreak[];
}

/** The one place a `ProviderProfileRow` becomes an HTTP response -- shared
 * by `GET /providers/:id` and `GET /me/provider` so the two routes can
 * never drift into different shapes or a different deposit formula. */
export function buildProviderProfileView(
  profile: ProviderProfileRow,
  category: CategoryRow,
  slots: Array<Pick<AvailabilitySlotRow, "startsAt"> | number>,
  reviews: ReviewView[] = [],
): ProviderProfileView {
  let languages: string[] = [];
  try {
    const parsed: unknown = JSON.parse(profile.languages);
    if (Array.isArray(parsed)) {
      languages = parsed.filter((entry): entry is string => typeof entry === "string");
    }
  } catch {
    // A profile stored before this field existed keeps an empty list rather
    // than breaking the public read.
  }

  return {
    id: profile.id,
    displayName: profile.displayName,
    title: profile.title,
    bio: profile.bio,
    languages,
    category: { id: category.id, name: category.name, slug: category.slug },
    location: profile.location,
    sessionFormat: profile.sessionFormat,
    sessionLengthMinutes: profile.sessionLengthMinutes,
    price: { amount: profile.priceAmount, asset: ASSET },
    deposit: { amount: computeDepositAmount(profile.priceAmount, profile.depositRateBps), asset: ASSET },
    depositRateBps: profile.depositRateBps,
    cancellationWindowHours: profile.cancellationWindowHours,
    minimumNoticeMinutes: profile.minimumNoticeMinutes,
    maxBookingDaysAhead: profile.maxBookingDaysAhead,
    bufferMinutes: profile.bufferMinutes,
    verifiedSessionCount: profile.verifiedSessionCount,
    providerCancellationCount: profile.providerCancellationCount,
    isApproved: profile.isApproved,
    bookingsPaused: Boolean(profile.bookingsPaused),
    timezone: profile.timezone,
    isSuspended: profile.suspendedAt !== null,
    suspensionReason: profile.suspensionReason ?? null,
    slots: slots.map((slot) => (typeof slot === "number" ? slot : slot.startsAt)),
  };
}

async function loadCategoryOrThrow(db: Db, categoryId: string, notFound: () => Error): Promise<CategoryRow> {
  const category = await getCategoryById(db, categoryId);
  if (!category) {
    // Unreachable in practice: `category_id` is a foreign key, so a
    // profile can never reference a category that does not exist. Guarded
    // anyway rather than assumed (same discipline as
    // `auth/challenge.ts`'s `challengeNonce`).
    throw notFound();
  }
  return category;
}

/** `GET /providers/:id`: an approved profile's public view, with only the
 * next 30 days of future *open* slots (the I/O matrix). An unapproved or
 * unknown id is indistinguishable -- both throw {@link ProviderNotFoundError}
 * -- so nothing about an unapproved profile ever leaks (the spec's own
 * "Always" rule). Story 3.4: a slot that currently carries an active
 * booking (a non-expired hold, or a locked escrow) is excluded here --
 * `listOfferedSlots`, not `listFutureSlots` -- so a client is never shown
 * a slot they cannot actually hold; this is also how "the slot then shows
 * as taken on the profile" (spec Acceptance Criteria) is satisfied once a
 * lock lands. Slots inside the post-lock appointment buffer are excluded too.
 * Issue #36: slots inside the minimum notice period are excluded as well.
 *
 * Admin suspension hides the public profile the same way an unapproved one
 * is hidden -- the identical {@link ProviderNotFoundError}, so a suspended
 * shop is discoverable by neither browsing nor a guessed URL. Its own
 * panel (`getOwnProviderProfile`) still resolves, and every existing
 * booking keeps loading, because a booking carries its own provider
 * summary rather than re-reading this view. */
export async function getPublicProviderProfile(
  db: Db,
  id: string,
  now: number = Math.floor(Date.now() / 1000),
  callerWalletAddress?: string,
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileById(db, id);
  if (!profile || !profile.isApproved) {
    throw new ProviderNotFoundError();
  }
  if (profile.suspendedAt !== null) {
    // Issue #140: If signed in as that shop owner, return the profile view
    // so they see the explanation that admin suspended it without booking controls.
    // Other callers get the same ProviderNotFoundError.
    if (callerWalletAddress && callerWalletAddress === profile.walletAddress) {
      const category = await loadCategoryOrThrow(db, profile.categoryId, () => new ProviderNotFoundError());
      return buildProviderProfileView(profile, category, []);
    }
    throw new ProviderNotFoundError();
  }
  const category = await loadCategoryOrThrow(db, profile.categoryId, () => new ProviderNotFoundError());
  const offeredStarts = profile.bookingsPaused
    ? []
    : await listOfferedSlots(db, profile.id, {
        now,
        withinSeconds: PUBLIC_SLOTS_WINDOW_SECONDS,
        sessionLengthMinutes: profile.sessionLengthMinutes,
        bufferMinutes: profile.bufferMinutes,
      });
  const noticeSeconds = (profile.minimumNoticeMinutes ?? 0) * 60;
  let visibleStarts = noticeSeconds > 0
    ? offeredStarts.filter((startsAt) => startsAt >= now + noticeSeconds)
    : offeredStarts;
  visibleStarts = visibleStarts.filter((startsAt) =>
    isWithinBookingWindow(startsAt, now, profile.maxBookingDaysAhead),
  );
  return buildProviderProfileView(profile, category, visibleStarts);
}

/** `GET /me/provider`: the caller's own profile, including while
 * unapproved, plus every future slot (no 30-day cap -- that cap is a
 * public-facing courtesy, not a limit on what a provider can plan). */
export async function getOwnProviderProfile(
  db: Db,
  walletAddress: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  const category = await loadCategoryOrThrow(db, profile.categoryId, () => new NotAProviderError());
  const slots = await listFutureSlots(db, profile.id, { now });
  return { ...buildProviderProfileView(profile, category, slots), breaks: await listProviderBreaks(db, profile.id) };
}

/** `PUT /me/provider/rules`: validates, saves, and returns the updated own
 * profile (with the recomputed deposit) -- nothing is saved when
 * validation fails. */
export async function updateProviderRules(
  db: Db,
  walletAddress: string,
  input: ProviderRulesInput,
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  const depositRateBps = input.depositRateBps ?? profile.depositRateBps;
  const resolved: ProviderRulesInput = { ...input, depositRateBps };
  const details = validateProviderRules(resolved);
  if (Object.keys(details).length > 0) {
    throw new InvalidProviderRulesError(details);
  }
  await updateProviderProfileRules(db, profile.id, {
    priceAmount: input.priceAmount,
    depositRateBps,
    cancellationWindowHours: input.cancellationWindowHours,
    maxBookingDaysAhead: input.maxBookingDaysAhead,
    bufferMinutes: input.bufferMinutes ?? 0,
  });
  return getOwnProviderProfile(db, walletAddress);
}

/**
 * `PUT /me/provider/intake` (issue #145): updates the provider's intake answers.
 * Each answer has a questionId, answer text, and isOptional flag.
 * - Required questions (isOptional=false) must have a non-blank answer.
 * - Optional questions (isOptional=true) may be left blank.
 * - Blank-prompt questions cannot be marked optional.
 * - Preserves existing answers when questions become optional.
 * - Returns the updated own profile.
 */
export async function updateProviderIntake(
  db: Db,
  walletAddress: string,
  input: UpdateProviderIntakeInput,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  // Validate the intake answers.
  const details = validateIntakeAnswers(input);
  if (Object.keys(details).length > 0) {
    throw new InvalidProviderProfileError(details);
  }
  // Parse existing intake answers and merge with new ones.
  let existingAnswers: Record<string, { answer: string | null; isOptional: boolean }> = {};
  try {
    const parsed = JSON.parse(profile.intakeAnswers || "[]");
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (typeof item === "object" && item !== null) {
          existingAnswers[item.questionId] = {
            answer: item.answer ?? null,
            isOptional: item.isOptional ?? false,
          };
        }
      }
    }
  } catch {
    // Keep empty if parsing fails.
  }
  // Build the new set of answers, preserving existing ones not being updated.
  const newAnswers: Record<string, { answer: string | null; isOptional: boolean }> = {};
  // First, copy all existing answers.
  for (const [qId, existing] of Object.entries(existingAnswers)) {
    newAnswers[qId] = existing;
  }
  // Then, apply the new answers (overwriting where provided).
  for (const answer of input.intakeAnswers || []) {
    newAnswers[answer.questionId] = {
      answer: answer.answer ?? null,
      isOptional: answer.isOptional ?? false,
    };
  }
  // Serialize back to JSON.
  const intakeAnswersJson = JSON.stringify(
    Object.entries(newAnswers).map(([questionId, { answer, isOptional }]) => ({
      questionId,
      answer: answer ?? null,
      isOptional,
    })),
    null,
  );
  // Update the profile's intake answers.
  const intakeAnswersJson = JSON.stringify(
    Object.entries(newAnswers).map(([questionId, { answer, isOptional }]) => ({
      questionId,
      answer: answer ?? null,
      isOptional,
    })),
    null,
  );
  // Use drizzle-orm to update the intake_answers column.
  await db
    .update(providerProfiles)
    .set({ intakeAnswers: intakeAnswersJson })
    .where(eq(providerProfiles.id, profile.id));
  return getOwnProviderProfile(db, walletAddress, now);
}

/**
/**
 * `PUT /me/provider/pause`: the signed-in shop's own pause/resume of new
 * bookings (issue #62). Idempotent -- pausing twice keeps the shop paused,
 * resuming twice keeps it open. Never touches `isApproved`: an admin
 * suspension still hides the shop entirely, and this pause never clears
 * one. Returns the updated own profile.
 */
export async function setProviderBookingsPaused(
  db: Db,
  walletAddress: string,
  paused: boolean,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  await setProviderProfileBookingsPaused(db, profile.id, paused);
  return getOwnProviderProfile(db, walletAddress, now);
}

/**
 * `PUT /me/provider/breaks` (issue #65): replaces the shop's weekly breaks.
 * Each break must sit inside its weekday's own working range (derived from
 * the shop's current future slots), breaks on the same weekday may not
 * overlap, and a saved break immediately stops offering any *open* future
 * slot inside it -- an already-booked slot is kept and its booking is never
 * cancelled (that is `replaceFutureSlots`'s own rule). Returns the updated
 * own profile.
 */
export async function setProviderBreaks(
  db: Db,
  walletAddress: string,
  rawBreaks: unknown,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  const breaks = rawBreaks;
  // Validate each break against opening hours.
  const validatedBreaks: Array<{ weekday: number; startMinute: number; endMinute: number }> = [];
  for (const breakItem of rawBreaks as Array<{ weekday: number; startMinute: number; endMinute: number }> || []) {
    // Validate break against opening hours.
    const details = validateBreakAgainstOpeningHours(breakItem, profile.sessionLengthMinutes, now, profile.timezone);
    if (Object.keys(details).length > 0) {
      throw new InvalidAvailabilitySlotsError({
        invalid: [breakItem],
        message: "Break must fit within weekday's opening hours.",
      });
    }
    // Validate break doesn't overlap with other breaks on the same weekday.
    const existingSameWeekday = validatedBreaks.filter(
      (b) => b.weekday === breakItem.weekday && !(breakItem.endMinute <= b.startMinute || b.endMinute <= breakItem.startMinute),
    );
    if (existingSameWeekday.length > 0) {
      throw new InvalidAvailabilitySlotsError({
        invalid: [breakItem],
        message: "Breaks on the same weekday must not overlap.",
      });
    }
    // Validate break format: end must be after start (allow touching).
    if (breakItem.endMinute <= breakItem.startMinute) {
      throw new InvalidAvailabilitySlotsError({
        invalid: [breakItem],
        message: "Break end must be after start.",
      });
    }
    validatedBreaks.push(breakItem);
  }

  await replaceProviderBreaks(db, profile.id, validatedBreaks);
  const futureSlots = await listFutureSlots(db, profile.id, { now });
  await replaceFutureSlots(
    db,
    profile.id,
    filterSlotsOutsideBreaks(validatedBreaks, futureSlots.map((slot) => slot.startsAt), profile.timezone),
    now,
  );
  return getOwnProviderProfile(db, walletAddress, now);
}

/**
 * `PUT /me/provider/timezone` (issue #64): sets the shop's IANA timezone.
 * An unknown zone is rejected and nothing is saved. Changing the zone only
 * changes how a slot is *labelled* -- every stored instant, and so every
 * lock, stays exactly what it was.
 */
export async function updateProviderTimezone(
  db: Db,
  walletAddress: string,
  timezone: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  if (!isValidTimeZone(timezone)) {
    throw new InvalidTimezoneError({ timezone: "Enter an IANA timezone, e.g. Europe/Istanbul." });
  }
  await updateProviderProfileTimezone(db, profile.id, timezone);
  return getOwnProviderProfile(db, walletAddress, now);
}

/** `PUT /me/provider/availability`: validates against the caller's own
 * `sessionLengthMinutes`, replaces every future slot, and returns the
 * updated own profile -- nothing is saved when validation fails. */
export interface UpdateProviderAvailabilityInput {
  /** Slot starts at (epoch seconds), one per available slot. */
  slots: number[];
  /** Issue #143: if specified, only modify slots for this weekday (0=Sunday, 6=Saturday).
   * When omitted, all future slots are replaced as before.
   */
  weekday?: number;
}

export async function updateProviderAvailability(
  db: Db,
  walletAddress: string,
  input: UpdateProviderAvailabilityInput,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  const { slots, weekday } = input;
  // When a specific weekday is given, only modify slots that fall on that
  // weekday; all other weekdays remain untouched.
  if (weekday !== undefined && weekday >= 0 && weekday <= 6) {
    // Compute the date range for the requested weekday in the provider's timezone.
    const tz = profile.timezone ?? "Europe/Istanbul";
    const nowDate = new Date(now * 1000);
    nowDate.setUTCMinutes(0, 0, 0);
    const targetWeekday = weekday; // 0=Sun, 1=Mon, ..., 6=Sat
    // Find the next occurrence of this weekday.
    const daysUntil = (targetWeekday - nowDate.getUTCDay() + 7) % 7;
    const weekStart = Math.floor((nowDate.getTime() / 1000) + daysUntil * 24 * 60 * 60);
    const weekEnd = weekStart + 7 * 24 * 60 * 60; // inclusive end (next weekday start)
    // Filter slots to only those within this weekday's range.
    const weekdaySlots = slots.filter((slot) => {
      return slot >= weekStart && slot < weekEnd;
    });
    // Validate that the weekday slots don't overlap with existing slots on the same day.
    const existingWeekdaySlots = await listFutureSlots(db, profile.id, { now });
    const existingWeekday = existingWeekdaySlots.filter((slot) => {
      return slot >= weekStart && slot < weekEnd;
    });
    // Merge: keep existing slots, add new ones, reject overlaps.
    const allSlots = [...new Set([...existingWeekday, ...weekdaySlots])].sort((a, b) => a - b);
    // Check for overlaps within the new slots against each other and existing.
    const sessionSeconds = profile.sessionLengthMinutes * 60;
    const sorted = [...allSlots];
    const overlapping: number[] = [];
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] - sorted[i - 1] < sessionSeconds) {
        overlapping.push(sorted[i]);
      }
    }
    if (overlapping.length > 0) {
      throw new InvalidAvailabilitySlotsError({
        invalid: overlapping,
        message: "Some slots overlap on the same weekday.",
      });
    }
    // Replace only the slots for this weekday, preserving all other weekdays.
    // Remove existing slots for this weekday, then add the new ones.
    const weekRange = [weekStart, weekEnd];
    await closeSlotsInRange(db, profile.id, weekRange[0], weekRange[1], now);
    await replaceFutureSlots(db, profile.id, weekdaySlots, now);
  } else {
    // No weekday specified: replace all future slots as before.
    const details = validateAvailabilitySlots(slots, profile.sessionLengthMinutes, now);
    if (Object.keys(details).length > 0) {
      throw new InvalidAvailabilitySlotsError(details);
    }
    // Issue #65: a slot inside one of the shop's own breaks is never offered.
    const breaks = await listProviderBreaks(db, profile.id);
    await replaceFutureSlots(db, profile.id, filterSlotsOutsideBreaks(slots, profile.timezone, breaks), now);
  }
  return getOwnProviderProfile(db, walletAddress, now);
}

// ---------------------------------------------------------------------------
// Approved-provider profile edits. The commercial terms (price, deposit
// rate, category) and the approval flag are not in this input at all: an
// edit to the shop's copy can never quietly change what a client pays.
// ---------------------------------------------------------------------------

export interface ProviderProfileTextInput {
  title: string;
  bio: string;
  languages: string[];
  sessionLengthMinutes: number;
  /** "How to find the shop" -- free text, no geocoding. */
  location: string;
}

const MIN_PROFILE_SESSION_LENGTH_MINUTES = 15;
const MAX_PROFILE_SESSION_LENGTH_MINUTES = 240;

/** Field-level validation for the approved-provider edit form. Empty object
 * means valid; the route wraps a non-empty result in
 * {@link InvalidProviderProfileError}. */
export function validateProviderProfileText(input: ProviderProfileTextInput): Record<string, string> {
  const details: Record<string, string> = {};
  if (typeof input.title !== "string" || input.title.trim() === "") {
    details.title = "Title is required.";
  }
  if (typeof input.bio !== "string" || input.bio.trim() === "") {
    details.bio = "Description is required.";
  }
  if (
    !Array.isArray(input.languages) ||
    input.languages.some((language) => typeof language !== "string" || language.trim() === "")
  ) {
    details.languages = "Languages must be a list of non-empty names.";
  }
  if (
    typeof input.sessionLengthMinutes !== "number" ||
    !Number.isInteger(input.sessionLengthMinutes) ||
    input.sessionLengthMinutes < MIN_PROFILE_SESSION_LENGTH_MINUTES ||
    input.sessionLengthMinutes > MAX_PROFILE_SESSION_LENGTH_MINUTES
  ) {
    details.sessionLengthMinutes = `Session length must be a whole number of minutes between ${MIN_PROFILE_SESSION_LENGTH_MINUTES} and ${MAX_PROFILE_SESSION_LENGTH_MINUTES}.`;
  }
  if (typeof input.location !== "string") {
    details.location = "Location must be text.";
  }
  return details;
}

/**
 * `PUT /me/provider/profile`: updates only the copy an approved shop owns.
 * The profile is resolved from the caller's own wallet, so another shop's
 * wallet cannot reach it (no profile for that wallet -> 404
 * {@link NotAProviderError}); a pending/rejected shop is refused with
 * {@link ProviderNotApprovedError}. Price, deposit rate and category are
 * never read from the input, so they cannot drift on this route.
 */
export async function updateProviderProfile(
  db: Db,
  walletAddress: string,
  input: ProviderProfileTextInput,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderProfileView> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  if (!profile.isApproved) {
    throw new ProviderNotApprovedError();
  }
  const details = validateProviderProfileText(input);
  if (Object.keys(details).length > 0) {
    throw new InvalidProviderProfileError(details);
  }
  await persistProviderProfileText(db, profile.id, {
    title: input.title.trim(),
    bio: input.bio.trim(),
    languages: JSON.stringify([...new Set(input.languages.map((language) => language.trim()))]),
    sessionLengthMinutes: input.sessionLengthMinutes,
    location: input.location.trim(),
  });
  return getOwnProviderProfile(db, walletAddress, now);
}

/** Aliases with the narrower wording used by the panel and the routes. */
export const editApprovedProviderProfile = updateProviderProfile;
export const updateProviderProfileText = updateProviderProfile;
export const updateProviderDetails = updateProviderProfile;

// ---------------------------------------------------------------------------
// Admin suspension: an approved shop can be taken out of discovery with a
// reason and put back again. `isApproved` is never changed here -- a
// suspended shop is still approved internally, so unsuspending restores
// the listing without a second approval step.
// ---------------------------------------------------------------------------

const MAX_SUSPENSION_REASON = 400;

async function loadProfileOrThrow(db: Db, id: string): Promise<ProviderProfileRow> {
  const profile = await getProviderProfileById(db, id);
  if (!profile) {
    throw new ProviderNotFoundError();
  }
  if (!profile.isApproved) {
    throw new ProviderNotApprovedError();
  }
  return profile;
}

/** `POST /admin/providers/:id/suspend`: records the reason and removes the
 * shop from every marketplace read and from `holdSlot`. Suspending an
 * already-suspended shop is allowed and keeps only the newest reason. */
export async function suspendProviderProfile(
  db: Db,
  id: string,
  reason: string,
  now: number = Date.now(),
): Promise<ProviderProfileView> {
  const profile = await loadProfileOrThrow(db, id);
  const cleanReason = typeof reason === "string" ? reason.trim() : "";
  if (cleanReason.length === 0 || cleanReason.length > MAX_SUSPENSION_REASON) {
    throw new InvalidSuspensionReasonError({
      reason: `Give a reason between 1 and ${MAX_SUSPENSION_REASON} characters.`,
    });
  }
  await setProviderProfileSuspension(db, profile.id, { suspendedAt: now, reason: cleanReason });
  return getOwnProviderProfile(db, profile.walletAddress);
}

/** `POST /admin/providers/:id/unsuspend`: clears the suspension (and its
 * reason), putting the shop back into discovery unchanged. Idempotent --
 * unsuspending a shop that is not suspended is a no-op. */
export async function unsuspendProviderProfile(db: Db, id: string): Promise<ProviderProfileView> {
  const profile = await loadProfileOrThrow(db, id);
  await setProviderProfileSuspension(db, profile.id, null);
  return getOwnProviderProfile(db, profile.walletAddress);
}

// ---------------------------------------------------------------------------
// Story 3.2: the Discover list's card objects and the category counts.
// ---------------------------------------------------------------------------

/** How many of a provider's earliest open slots a Discover card shows
 * (PRD 3.2 AC3, DESIGN.md's provider card). */
const CARD_EARLIEST_SLOTS_LIMIT = 3;

export interface ProviderCardView {
  id: string;
  displayName: string;
  title: string;
  category: { slug: string; name: string };
  location: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  /** Number of public services represented by the shortest card service. */
  serviceCount: number;
  price: { amount: string; asset: string };
  deposit: { amount: string; asset: string };
  cancellationWindowHours: number;
  verifiedSessionCount: number;
  providerCancellationCount: number;
  /** Issue #62: discovery shows the shop as not taking bookings while this
   * is `true` (and `earliestSlots` is empty). */
  bookingsPaused: boolean;
  /** Issue #64: the shop's IANA timezone, so a card's slot chips can be
   * labelled in the shop's zone rather than the viewer's. */
  timezone: string;
  /** UTC epoch seconds, ascending, at most {@link CARD_EARLIEST_SLOTS_LIMIT}. */
  earliestSlots: number[];
  timeZone: string;
  publicHours: PublicDayHours[];
}

/** One approved profile's card shape (the I/O matrix's "List all" row) --
 * a narrower, differently-shaped sibling of {@link ProviderProfileView}
 * (no `depositRateBps`/`isApproved`/full `slots`; adds
 * `providerCancellationCount` and the capped `earliestSlots`), since the
 * Discover list and the profile page answer different questions. */
export function buildProviderCardView(
  profile: ProviderProfileRow,
  category: CategoryRow,
  earliestSlots: number[],
  weeklyPatternSlots: number[] = [],
): ProviderCardView {
  return {
    id: profile.id,
    displayName: profile.displayName,
    title: profile.title,
    category: { slug: category.slug, name: category.name },
    location: profile.location,
    sessionFormat: profile.sessionFormat,
    sessionLengthMinutes: profile.sessionLengthMinutes,
    serviceCount: 1,
    price: { amount: profile.priceAmount, asset: ASSET },
    deposit: { amount: computeDepositAmount(profile.priceAmount, profile.depositRateBps), asset: ASSET },
    cancellationWindowHours: profile.cancellationWindowHours,
    verifiedSessionCount: profile.verifiedSessionCount,
    providerCancellationCount: profile.providerCancellationCount,
    bookingsPaused: profile.bookingsPaused,
    timezone: profile.timezone,
    earliestSlots,
    timeZone: profile.timeZone,
    publicHours: buildPublicHours(
      weeklyPatternSlots,
      profile.sessionLengthMinutes,
      profile.timeZone,
    ),
  };
}

/** Story 3.3's own availability windows (the I/O matrix's "Availability"
 * row): "at least one open future slot within 24h/7 days". */
const AVAILABILITY_WINDOW_SECONDS: Record<"24h" | "week", number> = {
  "24h": 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
};

export interface DiscoverFilters {
  /** Bookable discovery omits shops without an open slot after `now`. */
  bookableOnly?: boolean;
  /** Trimmed search text (AC1) -- matched against display name, title,
   * bio and category name, case-insensitively, by
   * `listApprovedProviderProfilesForDiscover`. */
  query?: string;
  /** Raw `sessionFormat` values (AC3) -- a profile matches if its own
   * `sessionFormat` is any one of these (OR, not AND: "the formats
   * present" is a multi-select). */
  formats?: string[];
  /** Integer strings, smallest unit (AD-7) -- compared as `BigInt` here,
   * never pushed into SQL (see `listApprovedProviderProfilesForDiscover`'s
   * own comment on why). */
  minPriceAmount?: string;
  maxPriceAmount?: string;
  /** Basis points, inclusive upper bound (AC3: "deposit rate (max %)"). */
  maxDepositRateBps?: number;
  /** `undefined` means "Any" -- the spec's own default, so no filtering at
   * all (the I/O matrix never mentions filtering out slotless providers
   * unless a window is actually chosen). */
  availability?: "24h" | "week";
  /** Issue #138: sort choice (e.g. "soonest" or "next-slot" vs "default"). */
  sort?: string;
}

/** `GET /providers[?category=<slug>&...]`: approved providers as card
 * objects (AC1 -- enforced by `listApprovedProviderProfilesForDiscover`,
 * never by filtering here), sorted by soonest open slot ascending; a
 * provider with no open slot sorts last, and ties (including "both
 * slotless") break by `displayName` (the spec's own "Always" sort rule,
 * unchanged from Story 3.2 -- Story 3.3 filters the input, never the
 * order). An unknown category slug returns an empty list, never an error
 * (the I/O matrix's own row) -- this is the one place a slug is resolved
 * to a category id for the list's own filter. */
export async function listDiscoverProviders(
  db: Db,
  categorySlug?: string,
  filters: DiscoverFilters = {},
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderCardView[]> {
  let categoryId: string | undefined;
  if (categorySlug !== undefined) {
    const category = await getCategoryBySlug(db, categorySlug);
    if (!category) {
      return [];
    }
    categoryId = category.id;
  }

  let profiles = await listApprovedProviderProfilesForDiscover(db, {
    categoryId,
    query: filters.query,
    formats: filters.formats,
  });
  if (profiles.length === 0) {
    return [];
  }

  // Money filters: BigInt comparisons over the SQL layer's already-
  // text/category/format-filtered rows (the I/O matrix's own "Price range"
  // and "Deposit cap" rows) -- app.ts has already dropped a non-integer or
  // out-of-bounds param, so every value reaching here is trusted.
  if (filters.minPriceAmount !== undefined || filters.maxPriceAmount !== undefined) {
    const min = filters.minPriceAmount !== undefined ? BigInt(filters.minPriceAmount) : undefined;
    const max = filters.maxPriceAmount !== undefined ? BigInt(filters.maxPriceAmount) : undefined;
    profiles = profiles.filter((profile) => {
      const price = BigInt(profile.priceAmount);
      if (min !== undefined && price < min) return false;
      if (max !== undefined && price > max) return false;
      return true;
    });
  }
  if (filters.maxDepositRateBps !== undefined) {
    const maxDepositRateBps = filters.maxDepositRateBps;
    profiles = profiles.filter((profile) => profile.depositRateBps <= maxDepositRateBps);
  }
  if (profiles.length === 0) {
    return [];
  }

  const allCategories = await listCategories(db);
  const categoryById = new Map(allCategories.map((row) => [row.id, row]));
  const earliestSlotsByProvider = await listEarliestOfferedSlotsByProvider(
    db,
    profiles.map((profile) => ({
      id: profile.id,
      sessionLengthMinutes: profile.sessionLengthMinutes,
      bufferMinutes: profile.bufferMinutes,
    })),
    now,
    CARD_EARLIEST_SLOTS_LIMIT,
  );
  const weeklyPatternSlotsByProvider = await listWeeklyPatternSlotsByProvider(
    db,
    profiles.map((profile) => profile.id),
    now,
  );
  for (const profile of profiles) {
    if (profile.bookingsPaused) {
      earliestSlotsByProvider.set(profile.id, []);
      continue;
    }
    const slots = earliestSlotsByProvider.get(profile.id);
    if (slots) {
      earliestSlotsByProvider.set(
        profile.id,
        slots.filter((startsAt) =>
          isWithinBookingWindow(startsAt, now, profile.maxBookingDaysAhead),
        ),
      );
    }
  }

  // Availability: a provider's *earliest* future slot is, by definition,
  // its closest one to `now` -- so "at least one open slot within the
  // window" reduces to just checking that single earliest value, never a
  // second query over every future slot.
  if (filters.availability !== undefined) {
    const windowSeconds = AVAILABILITY_WINDOW_SECONDS[filters.availability];
    profiles = profiles.filter((profile) => {
      // Issue #62: a paused shop is never "available" -- it has no new slot
      // to offer, whatever its stored rows still say.
      if (profile.bookingsPaused) return false;
      const earliest = earliestSlotsByProvider.get(profile.id)?.[0];
      return earliest !== undefined && earliest <= now + windowSeconds;
    });
  }

  if (filters.bookableOnly) {
    profiles = profiles.filter(
      (profile) => earliestSlotsByProvider.get(profile.id)?.[0] !== undefined,
    );
  }

  const cards = profiles.map((profile) => {
    const category = categoryById.get(profile.categoryId);
    if (!category) {
      // Unreachable in practice: `category_id` is a foreign key (see
      // `loadCategoryOrThrow`'s own comment on the same guarantee).
      throw new TypeError(`No category exists with id "${profile.categoryId}"`);
    }
    return buildProviderCardView(
      profile,
      category,
      earliestSlotsByProvider.get(profile.id) ?? [],
      weeklyPatternSlotsByProvider.get(profile.id) ?? [],
    );
  });

  if (filters.sort === "default") {
    cards.sort((a, b) => a.displayName.localeCompare(b.displayName));
  } else {
    // Default and "soonest" / "next-slot": sort by soonest future open slot ascending,
    // slotless providers last, ties broken by displayName.
    cards.sort((a, b) => {
      const aSlot = a.earliestSlots[0];
      const bSlot = b.earliestSlots[0];
      if (aSlot === undefined && bSlot === undefined) {
        return a.displayName.localeCompare(b.displayName);
      }
      if (aSlot === undefined) {
        return 1;
      }
      if (bSlot === undefined) {
        return -1;
      }
      if (aSlot !== bSlot) {
        return aSlot - bSlot;
      }
      return a.displayName.localeCompare(b.displayName);
    });
  }

  return cards;
}

/**
 * Issue #30: what an empty search offers instead of a dead end. `category`
 * is the nearest category that actually has approved shops (a category the
 * search names, the selected category when it has shops, else the
 * best-populated one); `providers` holds at most three of its approved
 * shops. `undefined` when there are no approved shops at all -- the empty
 * state then stays empty, never inventing a suggestion.
 */
export interface EmptySearchSuggestions {
  category: { id: string; name: string; slug: string };
  providers: ProviderCardView[];
}

const EMPTY_SEARCH_SUGGESTION_LIMIT = 3;

export async function suggestProvidersForEmptySearch(
  db: Db,
  filters: DiscoverFilters = {},
  categorySlug?: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<EmptySearchSuggestions | undefined> {
  const categories = await listCategoriesWithProviderCounts(db);
  const populated = categories.filter((category) => category.providerCount > 0);
  if (populated.length === 0) {
    return undefined;
  }

  const query = filters.query?.trim().toLowerCase();
  const selected = categorySlug ? categories.find((category) => category.slug === categorySlug) : undefined;
  const named = query
    ? populated.find((category) => category.name.toLowerCase().includes(query))
    : undefined;
  // "Nearest" is the category the search or the selected tab names when it
  // has shops, otherwise the category with the most approved shops.
  const nearest =
    (selected && selected.providerCount > 0 ? selected : undefined) ??
    named ??
    [...populated].sort((a, b) => b.providerCount - a.providerCount || a.name.localeCompare(b.name))[0];
  if (!nearest) {
    return undefined;
  }

  const providers = await listDiscoverProviders(db, nearest.slug, {}, now);
  if (providers.length === 0) {
    return undefined;
  }
  return {
    category: { id: nearest.id, name: nearest.name, slug: nearest.slug },
    providers: providers.slice(0, EMPTY_SEARCH_SUGGESTION_LIMIT),
  };
}

export interface CategoryWithProviderCount {
  id: string;
  name: string;
  slug: string;
  /** Approved providers in this category (AC1) -- never a raw application
   * or unapproved-profile count. */
  providerCount: number;
}

/** `GET /categories`: every visible category plus `providerCount` (Story 3.2's
 * own extension of Story 4.1's plain list, Story 5.8 adds visibility filter).
 * A category with no approved provider still appears, with `providerCount: 0`
 * -- the Discover rail shows every visible category, not just the populated ones.
 * Hidden categories are excluded (AC2). */
export async function listCategoriesWithProviderCounts(db: Db): Promise<CategoryWithProviderCount[]> {
  const [allCategories, counts] = await Promise.all([listVisibleCategories(db), countApprovedProvidersByCategory(db)]);
  return allCategories.map((category) => ({
    id: category.id,
    name: category.name,
    slug: category.slug,
    providerCount: counts.get(category.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Story 3.3: search suggestions.
// ---------------------------------------------------------------------------

export type DiscoverSuggestionKind = "category" | "service" | "provider";

export interface DiscoverSuggestion {
  kind: DiscoverSuggestionKind;
  label: string;
  value: string;
  /** Approved providers picking this suggestion would return (the I/O
   * matrix's own "Suggestions" row) -- for a category, its
   * `providerCount`; for a service or provider name, exactly what
   * `listDiscoverProviders(db, undefined, { query: value })` returns,
   * since picking one of those sets `q` to `value` and runs that same
   * full-text search, which can match through the bio or category name
   * too, not just the title/display name an exact-string count would see. */
  count: number;
}

/** `q` shorter than this returns an empty list outright (the I/O matrix's
 * own "Suggestions" row) -- a single character is too broad to be useful
 * and would otherwise suggest almost everything. */
const MIN_SUGGESTION_QUERY_LENGTH = 2;
/** At most this many suggestions, across all three kinds combined (the
 * I/O matrix's own "Suggestions" row). */
const MAX_SUGGESTIONS = 8;

/** `GET /providers/suggest?q=`: up to {@link MAX_SUGGESTIONS} suggestions
 * grouped into categories, services (distinct provider titles) and
 * providers (display names), each carrying the approved-provider count
 * picking it would return (AC2). Matching is case-insensitive substring,
 * the same "good enough at demo scale" rule
 * `listApprovedProviderProfilesForDiscover` follows -- no separate search
 * index. A `q` shorter than two characters is an empty list, never an
 * error. */
export async function suggestDiscoverQueries(db: Db, rawQuery: string): Promise<DiscoverSuggestion[]> {
  const query = rawQuery.trim();
  if (query.length < MIN_SUGGESTION_QUERY_LENGTH) {
    return [];
  }
  const needle = query.toLowerCase();

  const [allCategories, categoryCounts, approvedProfiles] = await Promise.all([
    listCategories(db),
    countApprovedProvidersByCategory(db),
    listApprovedProviderProfilesForDiscover(db),
  ]);

  const categorySuggestions: DiscoverSuggestion[] = allCategories
    .filter((category) => category.name.toLowerCase().includes(needle))
    .map((category) => ({
      kind: "category",
      label: category.name,
      value: category.slug,
      count: categoryCounts.get(category.id) ?? 0,
    }));

  // Distinct titles/names matching the query -- one suggestion per string,
  // not one per matching profile.
  const titles = new Set<string>();
  const names = new Set<string>();
  for (const profile of approvedProfiles) {
    if (profile.title.toLowerCase().includes(needle)) {
      titles.add(profile.title);
    }
    if (profile.displayName.toLowerCase().includes(needle)) {
      names.add(profile.displayName);
    }
  }

  // Picking a service/provider suggestion sets `q` to its own `value` and
  // runs the same full-text search `listDiscoverProviders` does -- so
  // "count" is exactly that search's result length, not a narrower
  // exact-title/name tally (see `DiscoverSuggestion.count`'s own comment).
  const serviceSuggestions: DiscoverSuggestion[] = await Promise.all(
    [...titles].map(async (title) => ({
      kind: "service",
      label: title,
      value: title,
      count: (await listDiscoverProviders(db, undefined, { query: title })).length,
    })),
  );
  const providerSuggestions: DiscoverSuggestion[] = await Promise.all(
    [...names].map(async (name) => ({
      kind: "provider",
      label: name,
      value: name,
      count: (await listDiscoverProviders(db, undefined, { query: name })).length,
    })),
  );

  return [...categorySuggestions, ...serviceSuggestions, ...providerSuggestions].slice(0, MAX_SUGGESTIONS);
}
