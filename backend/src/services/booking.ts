/**
 * Booking service functions later stories' routes call. Everything here is
 * thin: SQL lives in `../db/`, the escrow boundary lives in `../escrow/`,
 * and this module only composes the two -- the layering the whole backend
 * is written against (routes -> services -> db/escrow/anchor, one-way).
 *
 * What is deliberately *not* here: nothing in this file invents an
 * `escrow_state`. That column belongs to `../escrow/trustless-work/
 * reconciler.ts` alone (AD-1/AD-3, Story 2.6's retarget of
 * `../chain/event-worker.ts`); `lockDeposit` and `fundDeposit` below only
 * ever build unsigned XDR -- the booking's `escrowState` stays `null`
 * until the reconciler processes chain-confirmed evidence that the
 * resulting signed-and-submitted transactions actually landed. The one
 * exception is `releaseDeposit`, which mirrors an *already recorded*
 * chain-derived `"released"` transition onto `escrow_state` when that write
 * had not landed yet -- never a transition of its own.
 *
 * `lockDeposit`/`fundDeposit`/`resolveBookingDispute` no longer call
 * `../chain/client.ts` (Story 2.6): that module is superseded, not deleted
 * -- it stays in the tree, reviewed and tested, as a record of the
 * pre-pivot design (AD-8's own "no completed history is erased").
 *
 * **Why deploy and fund are two separate exported functions.** Building a
 * fund transaction against a contract that is not yet on chain is
 * unverified, and both transactions would otherwise share the client's
 * sequence number. `lockDeposit` builds and persists the deploy; a caller
 * signs and submits it, then calls `fundDeposit` once it has landed.
 * `lockDeposit` never overwrites a `contractId` that may already have
 * landed (and possibly been funded): once one is persisted, it either
 * returns the exact same stored deploy XDR (a retry within the hold -- see
 * Story 3.4's own Design Notes, "Why retry reuses the stored deploy XDR")
 * or, only once chain evidence confirms the old contract was never
 * actually deployed, clears it and builds a fresh one (the abandoned-deploy
 * recovery Story 2.6 deferred to Epic 3, now implemented here).
 *
 * Story 3.4 also adds the real AD-13 slot hold (`holdSlot`), the owner
 * check every booking route shares (`getBookingForClient`), `submit`
 * (relaying a client-signed XDR), the booking read view (`getBookingView`),
 * and the hold-expiry double-sale detector (`expireHolds`) -- see each
 * function's own doc comment below.
 */
import { randomBytes } from "node:crypto";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { and, eq, gte, isNotNull, isNull, ne, or } from "drizzle-orm";

import { config } from "../config.js";
import { isWithinBookingWindow } from "./bookingWindow.js";
import { defaultEscrowAdapter } from "../escrow/trustless-work/client.js";
import {
  getEscrowLifecycle,
  getEscrowLifecycleForBookings,
  type EscrowLifecycle,
  type EscrowLifecycleAction,
} from "../escrow/trustless-work/reconciler.js";
import type { DeployEscrowResult, EscrowAdapter, SubmitTransactionResult, UnsignedTransaction } from "../escrow/interface.js";
import { transactionReachedSuccess } from "../escrow/transaction-status.js";
import {
  getBookingById,
  getBookingsByIds,
  getActiveBookingForWalletAndSlot,
  getExpiredHoldForWalletAndSlot,
  getReconcilableBookings,
  countPendingHoldsForWallet,
  deleteUnlockedHold,
  insertBooking,
  insertBookingHoldIfSlotFree,
  listBookingRowsForClient,
  listBookingRowsForProvider,
  listPotentialDoubleSales,
  listConflictingSlotBookings,
  clearUnsubmittedEscrowContractId,
  claimEscrowLock,
  releaseEscrowLock,
  markBalancePaidCashIfUnpaid,
  markBalancePaidPlatform,
  markBookingArrived,
  markClientReminderShown,
  declineBookingHold,
  markProviderReminderShown,
  recordDeploySubmission,
  recordProviderCancellationCountedSync,
  setEscrowActionSubmittedAt,
  setBalancePaymentBuiltHash,
  setEscrowActionTxHash,
  setEscrowActionTxHashSync,
  setEscrowFundTxHash,
  setPendingDispute,
  updateBalanceState,
  updateClientEmail,
  updateEscrowContractId,
  updateEscrowStateIfNotTerminalSync,
  type BookingRow,
  type EscrowActionKind,
} from "../db/bookings.js";
import { getSlotById, getSlotByProviderAndStart } from "../db/availabilitySlots.js";
import { isDateClosed, utcDateFor } from "../db/closedDates.js";
import {
  isSlotInsideBufferAfterLocked,
  listLockedBookingStarts,
  listOfferedSlotsInRange,
} from "./availability.js";
import { recordEscrowDisputeResolution } from "../db/escrowDisputeResolutions.js";
import { listContractDeployments, recordContractDeployment } from "../db/escrowContractDeployments.js";
import { escrowDisputeOpenings, bookings } from "../db/schema.js";
import { getEscrowDisputeOpening, getEscrowDisputeOpeningsForBookings, recordEscrowDisputeOpening } from "../db/escrowDisputeOpenings.js";
import { getProviderProfileById, getProviderProfileByWallet } from "../db/providerProfiles.js";
import { getReviewByBookingId, getReviewsForBookings, toReviewView, type ReviewView } from "../db/reviews.js";
import { computeDepositAmount, NotAProviderError, ProviderNotFoundError } from "./profile.js";
import { requireUsdcTrustline, type UsdcTrustlineDeps } from "../anchor/trustline.js";
import { resolveUsdcAsset, type ResolveUsdcAssetOptions, type UsdcAsset } from "../anchor/usdc.js";
import {
  buildBalancePaymentTransaction,
  submitBalancePaymentTransaction,
  type BuildPaymentDeps,
  type SubmitPaymentDeps,
} from "../payments/stellar.js";
import { PaymentUnavailableError } from "../payments/errors.js";
import type { Db } from "../db/client.js";
import { BALANCE_STATES, type BalanceState, type DisputeOpenerRole, type DisputeOutcome, type DisputeReason } from "../db/schema.js";

/** Pactly's only supported asset for now (PRD): the deposit's trustline
 * symbol every `lockDeposit` deploy names. Not yet a per-booking or
 * per-provider choice -- when Pactly supports more than one asset, this
 * becomes an input instead of a constant. */
const DEPOSIT_ASSET_SYMBOL = "USDC";

/** 16 random bytes, hex-encoded -- the shape `db/schema.ts`'s
 * `bookings.id` and the contract's `BytesN<16>` both expect. AD-13 calls
 * this an "off-chain ULID"; a true ULID also encodes a sortable timestamp,
 * which nothing here currently relies on, so this story uses the simpler
 * shape that still satisfies every constraint the contract and the schema
 * actually enforce. */
export function generateBookingId(): string {
  return randomBytes(16).toString("hex");
}

export interface CreateBookingHoldInput {
  providerProfileId: string;
  clientWalletAddress: string;
  tokenAddress: string;
  /** Integer string, smallest unit (AD-7). */
  depositAmount: string;
  /** Integer string, smallest unit (AD-7); defaults to `"0"`. */
  balanceAmount?: string;
  /** UTC epoch seconds. */
  cancelDeadline: number;
  /** Supply only for tests that need a deterministic id; a real caller
   * lets this generate one (AD-13: the backend, not the client, mints
   * `booking_id`). */
  bookingId?: string;
  /** Story 3.4: the slot this hold occupies, and the hold's own expiry.
   * Optional so every pre-3.4 caller (existing tests, `seed/demo.ts`) still
   * compiles unchanged; a real client-facing hold always goes through
   * {@link holdSlot} below instead, which always sets both. */
  slotId?: string;
  holdExpiresAt?: number;
}

/**
 * Writes a booking's hold row (AD-13): before any chain call, so the
 * event worker has a row to mirror state onto once `locked` arrives.
 * Returns the booking id the caller (eventually, Epic 3's payment route)
 * passes to `lockDeposit`.
 *
 * This is the plain, unconditional insert -- it never checks whether a
 * slot is already held. `holdSlot` below is the real entry point a
 * `POST /bookings/hold` route uses; this function stays for tests and
 * seed data that just need a booking row to exist.
 */
export async function createBookingHold(db: Db, input: CreateBookingHoldInput): Promise<string> {
  const bookingId = input.bookingId ?? generateBookingId();
  await insertBooking(db, {
    id: bookingId,
    providerProfileId: input.providerProfileId,
    clientWalletAddress: input.clientWalletAddress,
    tokenAddress: input.tokenAddress,
    depositAmount: input.depositAmount,
    balanceAmount: input.balanceAmount,
    cancelDeadline: input.cancelDeadline,
    slotId: input.slotId,
    holdExpiresAt: input.holdExpiresAt,
    createdAt: Date.now(),
  });
  return bookingId;
}

export function getBooking(db: Db, bookingId: string): Promise<BookingRow | undefined> {
  return getBookingById(db, bookingId);
}

// ---------------------------------------------------------------------------
// Story 3.4: the real AD-13 slot hold, the owner-only escrow steps, and the
// booking read route's own service functions.
// ---------------------------------------------------------------------------

/** Matches `services/profile.ts`'s own `ASSET` -- Pactly's only supported
 * asset for now. Kept as a separate constant (not imported) the same way
 * `DEPOSIT_ASSET_SYMBOL` above already is; both name the same value for
 * different reasons (a trustline symbol vs. a response's `asset` field). */
const ASSET = "USDC";

export interface Money {
  /** Integer string, smallest unit (AD-7) -- never a float. */
  amount: string;
  asset: string;
}

export interface BookingProviderSummary {
  id: string;
  displayName: string;
  title: string;
}

/** The AD-13 hold's own duration -- 10 minutes, per the spec's "Always"
 * rule ("blocks the slot for 10 minutes"). */
export const HOLD_DURATION_SECONDS = 10 * 60;
const DISPUTE_OPEN_WINDOW_SECONDS = 7 * 24 * 60 * 60;

function getDisputeDeadline(slotStartsAt: number | null): number | null {
  return slotStartsAt === null ? null : slotStartsAt + DISPUTE_OPEN_WINDOW_SECONDS;
}

/** Issue #62: the shop has paused new bookings. A new hold is refused
 * (`409 BOOKINGS_PAUSED`); existing locks, releases and disputes never
 * consult this flag, so they keep working. */
export class BookingsPausedError extends Error {
  constructor(message = "This shop has paused new bookings. Try again later.") {
    super(message);
    this.name = "BookingsPausedError";
  }
}

export class SlotUnavailableError extends Error {
  constructor(message = "That slot isn't available.") {
    super(message);
    this.name = "SlotUnavailableError";
  }
}

export class SlotTakenError extends Error {
  /** The provider's other open slots on the same calendar day (the
   * caller's own local day when `tzOffsetMinutes` was supplied, UTC
   * otherwise) as the one that was just lost -- the spec's own
   * `details.sameDaySlots`. */
  readonly sameDaySlots: number[];
  constructor(sameDaySlots: number[]) {
    super("That slot just went.");
    this.name = "SlotTakenError";
    this.sameDaySlots = sameDaySlots;
  }
}

/** Story #18: a provider cannot book its own slot */
export class ProviderSelfBookingError extends Error {
  constructor() {
    super("A provider cannot book its own slot.");
    this.name = "ProviderSelfBookingError";
  }
}

/** Review follow-up (Issue #51): a per-wallet cap on *pending* holds (not
 * yet locked) across every provider, so one wallet cannot tie up an
 * unbounded number of slots at once. The limit is 3 open holds. */
export class TooManyHoldsError extends Error {
  constructor(message = "You already have 3 slots on hold. Complete or let one expire before holding another.") {
    super(message);
    this.name = "TooManyHoldsError";
  }
}

/** A booking id that does not exist, or exists but is not owned by the
 * caller's own wallet -- both collapse to the same shape (spec's own
 * "Always" rule: "Anyone else gets 404 BOOKING_NOT_FOUND, so bookings are
 * not enumerable"). Never distinguishes the two cases in its message. */
export class BookingNotFoundError extends Error {
  constructor(message = "No booking was found with that id.") {
    super(message);
    this.name = "BookingNotFoundError";
  }
}

/** The slot this booking occupies has already started (or is starting
 * right now) according to the server clock. Locking or funding a deposit
 * for a past slot is not allowed -- no contract is created. */
export class SlotInPastError extends Error {
  readonly slotStartsAt: number;
  readonly now: number;
  constructor(slotStartsAt: number, now: number) {
    super("This slot has already started. Please pick a later slot.");
    this.name = "SlotInPastError";
    this.slotStartsAt = slotStartsAt;
    this.now = now;
  }
}

/** The AD-13 hold's 10-minute window has passed while `escrowState` is
 * still `null` -- `lock` and `fund` both refuse with this; `submit` never
 * checks it (a transaction the client already signed must still be allowed
 * to land, per the spec's own "Never" rule on this point). */
export class BookingHoldExpiredError extends Error {
  constructor(message = "This hold has expired. The slot may already be taken again.") {
    super(message);
    this.name = "BookingHoldExpiredError";
  }
}

/** Issue #6: this booking's first setup is already running on another
 * request, which holds its one in-flight claim, so no second one is built
 * here. The client's own double click lands on this refusal rather than a
 * second contract -- plain words, since the message reaches the screen. */
export class BookingDeployInFlightError extends Error {
  bookingId: string;

  constructor(bookingId: string, message = "This booking is already being set up. Give it a moment.") {
    super(message);
    this.name = "BookingDeployInFlightError";
    this.bookingId = bookingId;
  }
}

export interface HoldSlotInput {
  providerProfileId: string;
  clientWalletAddress: string;
  /** UTC epoch seconds -- must match one of the provider's own published
   * slots exactly. */
  slotStartsAt: number;
  /** `true` only for an explicit "hold this slot again" action. Resume
   * reads must not silently replace an expired hold. */
  renewExpired?: boolean;
  /** The caller's own `Date.prototype.getTimezoneOffset()` value (minutes
   * to add to local time to reach UTC) -- used only to compute
   * `sameDaySlots`'s calendar-day window in the caller's own local day
   * rather than UTC. Omitted (or `0`) means UTC, the previous behavior. */
  tzOffsetMinutes?: number;
  /** Optional client contact email for the shop's post-release mailto draft. */
  clientEmail?: string | null;
}

export interface HoldSlotResult {
  bookingId: string;
  holdExpiresAt: number;
  deposit: Money;
  balance: Money;
  price: Money;
  cancelDeadline: number;
  /** UTC epoch seconds -- the server clock at response time. The client
   * drives its free-cancellation countdown from this plus
   * `cancelDeadline`, never from the browser clock alone. */
  serverTime: number;
  provider: BookingProviderSummary;
  /** Set when a resume read finds an expired, never-deployed hold rather
   * than an active hold or a new hold. */
  isExpiredHold?: true;
  /** `true` only when `cancelDeadline` has already passed at hold time --
   * the deposit is still locked as normal, but there is no free
   * cancellation window left to speak of. Omitted (never `false`) when it
   * has not. */
  freeCancellationEnded?: boolean;
}

export interface HoldSlotDeps {
  /** Injectable clock (UTC epoch seconds) -- defaults to the real one. */
  now?: number;
  /** Overrides how the USDC token address is resolved -- defaults to the
   * real, cached anchor lookup (`anchor/usdc.ts`). */
  resolveUsdcAsset?: (options?: ResolveUsdcAssetOptions) => Promise<{ contractId: string }>;
}

/** The calendar day `[start, end)` (UTC epoch seconds) containing
 * `startsAt`, in the day boundary implied by `tzOffsetMinutes` (the JS
 * `getTimezoneOffset()` convention: minutes to *add* to local time to reach
 * UTC) -- the window `SLOT_TAKEN`'s `sameDaySlots` searches. Defaults to
 * `0` (UTC) when the caller supplied none, the previous behavior. */
function dayRange(startsAt: number, tzOffsetMinutes = 0): { start: number; end: number } {
  const SECONDS_PER_DAY = 24 * 60 * 60;
  const offsetSeconds = tzOffsetMinutes * 60;
  const localStartsAt = startsAt - offsetSeconds;
  const localDayStart = Math.floor(localStartsAt / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const start = localDayStart + offsetSeconds;
  return { start, end: start + SECONDS_PER_DAY };
}

/**
 * The real AD-13 slot hold (`POST /bookings/hold`): validates the provider
 * and slot, derives every amount from the provider's own profile (the
 * spec's own "Always" rule -- "The frontend never supplies any amount"),
 * and atomically claims the slot via {@link insertBookingHoldIfSlotFree}.
 *
 * Refuses {@link SlotUnavailableError} (`404`/`409` per the route -- an
 * unknown/unapproved/suspended provider is `404 PROVIDER_NOT_FOUND`,
 * everything else about the slot itself is `409 SLOT_UNAVAILABLE`) for an
 * unknown provider,
 * an unapproved provider, a slot that does not exist for this provider, or
 * a slot in the past. Refuses {@link SlotTakenError} (`409 SLOT_TAKEN`)
 * when another active booking already holds this exact slot -- the one
 * check this function's own single atomic insert statement decides, never
 * a separate read this function does first.
 */
const MAX_PENDING_HOLDS_PER_WALLET = 3;

export async function holdSlot(db: Db, input: HoldSlotInput, deps: HoldSlotDeps = {}): Promise<HoldSlotResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const resolveUsdc = deps.resolveUsdcAsset ?? resolveUsdcAsset;

  const profile = await getProviderProfileById(db, input.providerProfileId);
  // A suspended shop is refused exactly like an unapproved one: it cannot
  // take a new hold (and so cannot receive a new lock), and the client
  // learns nothing about why it disappeared. Existing bookings never call
  // this path, so they keep working.
  if (!profile || !profile.isApproved || profile.suspendedAt !== null) {
    throw new ProviderNotFoundError();
  }
  // Issue #62: the shop's own pause refuses only a *new* hold. Everything
  // already locked keeps working (no other function reads this flag).
  if (profile.bookingsPaused) {
    throw new BookingsPausedError();
  }
  const slot = await getSlotByProviderAndStart(db, profile.id, input.slotStartsAt);
  if (!slot || slot.startsAt <= now) {
    throw new SlotUnavailableError();
  }
  if (!isWithinBookingWindow(slot.startsAt, now, profile.maxBookingDaysAhead)) {
    throw new SlotUnavailableError();
  }
  // A one-off closure hides the slot from every list; refuse a direct post of
  // a stale start time too. The slot row itself is left alone, so reopening
  // the date makes it bookable again with no pattern edit.
  if (await isDateClosed(db, profile.id, utcDateFor(slot.startsAt))) {
    throw new SlotUnavailableError();
  }

  // Issue #36: a slot sooner than the shop's notice period cannot be held.
  if (profile.minimumNoticeMinutes > 0) {
    const minStartTime = now + profile.minimumNoticeMinutes * 60;
    if (slot.startsAt < minStartTime) {
      throw new SlotUnavailableError();
    }
  }

  // A slot inside the post-lock buffer is not offered -- refuse the hold the
  // same way as an unknown/past slot so a stale deep-link cannot claim it.
  if (profile.bufferMinutes > 0) {
    const lockedStarts = await listLockedBookingStarts(db, profile.id);
    const blocked = lockedStarts.some((lockedStartsAt) =>
      isSlotInsideBufferAfterLocked(
        input.slotStartsAt,
        lockedStartsAt,
        profile.sessionLengthMinutes,
        profile.bufferMinutes,
      ),
    );
    if (blocked) {
      throw new SlotUnavailableError();
    }
  }

  const provider: BookingProviderSummary = { id: profile.id, displayName: profile.displayName, title: profile.title };

  // Review follow-up: the same wallet asking to hold a slot it already
  // actively holds gets that same booking back, not a spurious
  // `SLOT_TAKEN` -- a double-click, a retried request, or a reopened tab
  // are all the same wallet asking for what it already has.
  const existing = await getActiveBookingForWalletAndSlot(db, slot.id, input.clientWalletAddress, now);
  if (existing) {
    if (input.clientEmail !== undefined) {
      await updateClientEmail(db, existing.id, input.clientEmail);
    }
    return {
      bookingId: existing.id,
      holdExpiresAt: existing.holdExpiresAt ?? now,
      deposit: { amount: existing.depositAmount, asset: ASSET },
      balance: { amount: existing.balanceAmount, asset: ASSET },
      price: { amount: (BigInt(existing.depositAmount) + BigInt(existing.balanceAmount)).toString(), asset: ASSET },
      cancelDeadline: existing.cancelDeadline,
      serverTime: now,
      provider,
      ...(existing.cancelDeadline <= now ? { freeCancellationEnded: true as const } : {}),
    };
  }

  if (!input.renewExpired) {
    const expired = await getExpiredHoldForWalletAndSlot(db, slot.id, input.clientWalletAddress, now);
    if (expired) {
      return {
        bookingId: expired.id,
        holdExpiresAt: expired.holdExpiresAt ?? now,
        deposit: { amount: expired.depositAmount, asset: ASSET },
        balance: { amount: expired.balanceAmount, asset: ASSET },
        price: { amount: (BigInt(expired.depositAmount) + BigInt(expired.balanceAmount)).toString(), asset: ASSET },
        cancelDeadline: expired.cancelDeadline,
        serverTime: now,
        provider,
        isExpiredHold: true,
      };
    }
  }

  // Review follow-up: cap pending (unlocked) holds per wallet so one wallet
  // cannot tie up an unbounded number of slots at once.
  const pendingHolds = await countPendingHoldsForWallet(db, input.clientWalletAddress, now);
  if (pendingHolds >= MAX_PENDING_HOLDS_PER_WALLET) {
    throw new TooManyHoldsError();
  }

  const usdc = await resolveUsdc();
  const depositAmount = computeDepositAmount(profile.priceAmount, profile.depositRateBps);
  const balanceAmount = (BigInt(profile.priceAmount) - BigInt(depositAmount)).toString();
  const cancelDeadline = input.slotStartsAt - profile.cancellationWindowHours * 3600;
  const bookingId = generateBookingId();
  const holdExpiresAt = now + HOLD_DURATION_SECONDS;

  const inserted = await insertBookingHoldIfSlotFree(
    db,
    {
      id: bookingId,
      providerProfileId: profile.id,
      clientWalletAddress: input.clientWalletAddress,
      clientEmail: input.clientEmail?.trim() || null,
      tokenAddress: usdc.contractId,
      depositAmount,
      balanceAmount,
      cancelDeadline,
      slotId: slot.id,
      holdExpiresAt,
      createdAt: Date.now(),
    },
    now,
  );

  if (!inserted) {
    const { start, end } = dayRange(input.slotStartsAt, input.tzOffsetMinutes);
    const sameDaySlots = await listOfferedSlotsInRange(
      db,
      profile.id,
      start,
      end,
      profile.sessionLengthMinutes,
      profile.bufferMinutes,
      now,
    );
    throw new SlotTakenError(sameDaySlots.filter((startsAt) => startsAt !== input.slotStartsAt));
  }

  return {
    bookingId,
    holdExpiresAt,
    deposit: { amount: depositAmount, asset: ASSET },
    balance: { amount: balanceAmount, asset: ASSET },
    price: { amount: profile.priceAmount, asset: ASSET },
    cancelDeadline,
    serverTime: now,
    provider,
    ...(cancelDeadline <= now ? { freeCancellationEnded: true as const } : {}),
  };
}

export { ProviderNotFoundError };

/** The backend's own half of AD-3: only ever touches `balance_state`,
 * validated against the three values that column may hold. */
export async function setBalanceState(db: Db, bookingId: string, balanceState: BalanceState): Promise<void> {
  if (!BALANCE_STATES.includes(balanceState)) {
    throw new TypeError(`balanceState must be one of ${BALANCE_STATES.join(", ")}, got "${balanceState}"`);
  }
  await updateBalanceState(db, bookingId, balanceState);
}

/**
 * `lockDeposit`'s own response shape (review follow-up, replacing the old
 * `{contractId, deploy}` shape): `deployed: true` means a signed deploy has
 * already been submitted and accepted for this booking -- there is no XDR
 * to sign again, and the caller should go straight to `fundDeposit`.
 * `deployed: false` carries the unsigned deploy XDR (and its own `txHash`,
 * always the real one Trustless Work returned -- never the `contractId`
 * used as a stand-in, which is what this shape replaces) still waiting for
 * a signature.
 */
export type LockDepositResult =
  | { deployed: true; contractId: string }
  | { deployed: false; contractId: string; unsignedXdr: string; txHash: string };

/** Refuses a `lockDeposit`/`fundDeposit`/`resolveBookingDispute` call whose
 * booking is not in the state that call requires -- e.g. `escrowState`
 * already set, or no `contractId` persisted yet. Named per the I/O
 * matrix's typed-refusal rows; this is a service-level state check, never
 * a Trustless Work condition, so it stays its own class rather than one of
 * `escrow/trustless-work/errors.ts`'s adapter-boundary errors. */
export class BookingEscrowStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingEscrowStateError";
  }
}

export class DisputeWindowClosedError extends Error {
  constructor(message = "A dispute may only be opened from the appointment time until 7 days afterward.") {
    super(message);
    this.name = "DisputeWindowClosedError";
  }
}

/** A signed transaction `submitSignedTransaction` was handed does not
 * match this booking's own stored deploy or fund `txHash` -- either a
 * stale/foreign envelope, or one that failed to decode at all. Refused
 * before the transaction is ever relayed to Trustless Work. */
export class XdrMismatchError extends Error {
  constructor(message = "This transaction doesn't match what Pactly built for this booking.") {
    super(message);
    this.name = "XdrMismatchError";
  }
}

/**
 * Issue #48: Thrown when a client attempts to lock a deposit but the
 * anchor transfer credited less than the required amount. The hold remains,
 * and the client sees both amounts (with asset) so they can either top up or abandon.
 */
export class ShortDepositError extends Error {
  constructor(
    public readonly receivedAmount: string,
    public readonly requiredAmount: string,
    public readonly asset: string = "USDC",
    message = "The anchor transfer did not credit enough to cover this booking's deposit.",
  ) {
    super(message);
    this.name = "ShortDepositError";
  }
}

/** Story 3.6 (review round): a fresh build of an action was requested while
 * an earlier signed transaction for that *same* action kind on this booking
 * has already been relayed and the reconciler's own chain-derived lifecycle
 * has not yet moved past what that action would produce -- refused rather
 * than silently building a second, competing transaction for a signature
 * that may already be in flight (`db/bookings.ts`'s per-kind
 * `escrow*SubmittedAt` columns are what this checks). */
export class BookingActionPendingError extends Error {
  constructor(message = "This action is already awaiting on-chain confirmation.") {
    super(message);
    this.name = "BookingActionPendingError";
  }
}

/** Story 3.6 (review round): a dispute `reason` that either does not exist
 * at all, or is not one the caller's own role may claim (e.g. a client
 * claiming `client-no-show`, which only the provider may claim). */
export class InvalidDisputeReasonError extends Error {
  constructor(message = "That reason isn't valid for your role on this booking.") {
    super(message);
    this.name = "InvalidDisputeReasonError";
  }
}

/** The party who opened an unresolved dispute tries to withdraw it --
 * restoring the booking to its previous locked state while keeping the
 * deposit where it was. Preserves the dispute note on the withdrawn record. */
export class UnauthorizedDisputeWithdrawalError extends Error {
  constructor(message = "Only the party who opened the dispute may withdraw it.") {
    super(message);
    this.name = "UnauthorizedDisputeWithdrawalError";
  }
}

/** A dispute has already been resolved (by an admin) -- withdrawing is no
 * longer possible. The booking's escrow state reflects the resolution. */
export class DisputeAlreadyResolvedError extends Error {
  constructor(message = "This dispute has already been resolved and cannot be withdrawn.") {
    super(message);
    this.name = "DisputeAlreadyResolvedError";
  }
}

async function requireBooking(db: Db, bookingId: string): Promise<BookingRow> {
  const booking = await getBookingById(db, bookingId);
  if (!booking) {
    throw new TypeError(`No booking hold exists for id "${bookingId}"`);
  }
  return booking;
}

async function requireProviderAddress(db: Db, booking: BookingRow): Promise<string> {
  const providerProfile = await getProviderProfileById(db, booking.providerProfileId);
  if (!providerProfile) {
    throw new TypeError(`Booking "${booking.id}" references a provider profile that no longer exists`);
  }
  return providerProfile.walletAddress;
}

/** Refuses {@link BookingHoldExpiredError} once `holdExpiresAt` has passed
 * (`< now` strictly past; exactly at `holdExpiresAt` is still active) with
 * `escrowState` still `null` and no contract id. A `null` `holdExpiresAt`
 * (a booking inserted before Story 3.4, or through the plain
 * `createBookingHold` helper) never expires -- there is nothing to compare
 * against. Once `escrowState` is set the hold is moot (the deposit already
 * reconciled), so this never fires for a booking past that point either;
 * the same goes for a persisted `escrowContractId`, which is the evidence
 * that a deploy was already submitted and this is no longer an uncommitted
 * hold. */
function requireHoldNotExpired(booking: BookingRow, now: number): void {
  if (
    booking.escrowState === null
    && booking.escrowContractId === null
    && booking.holdExpiresAt !== null
    && booking.holdExpiresAt < now
  ) {
    throw new BookingHoldExpiredError();
  }
}

/** Refuses lock/fund/submit on a hold the shop declined. Checked before the
 * expiry guard because a declined hold that already had a contract id built
 * is not caught by it. */
function requireHoldNotDeclined(booking: BookingRow): void {
  if (booking.declinedAt !== null) {
    throw new BookingEscrowStateError(`Booking "${booking.id}" was declined by the shop`);
  }
}

/**
 * A shop declines an unlocked hold on its own slot: the hold ends at once,
 * the slot is bookable again, and the client's views report it as declined.
 * Another shop's booking (or a missing one) is refused the same
 * {@link BookingNotFoundError} every ownership check gives. A booking that
 * has a recorded `escrowState` (locked, released, refunded), has a deploy
 * already relayed to the chain, or was already declined cannot be declined
 * ({@link BookingEscrowStateError}).
 */
export async function declineHold(
  db: Db,
  bookingId: string,
  providerWalletAddress: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const booking = await getBookingForProvider(db, bookingId, providerWalletAddress);
  const declined = await declineBookingHold(db, booking.id, now);
  if (!declined) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be an unlocked hold to decline it (escrowState is "${booking.escrowState}")`,
    );
  }
}

export interface LockDepositDeps {
  /** Injectable clock (UTC epoch seconds) -- defaults to the real one. */
  now?: number;
  /** An explicit request to discard the currently-persisted (never
   * submitted) deploy and build a fresh one -- the caller's own decision,
   * made only after a submit attempt failed and the client wants a new
   * transaction rather than retrying the old one. Ignored (never rebuilds)
   * once a deploy has actually been submitted for this booking. */
  rebuild?: boolean;
  /** Issue #4: the seams {@link requireUsdcTrustline} asks the network
   * through (anchor USDC discovery, Horizon's account load). Defaults to the
   * real reads, exactly as `buildBalancePaymentTransaction`'s own
   * `resolveUsdcAsset` seam does; a test injects answers and never opens a
   * socket. */
  usdcTrustline?: UsdcTrustlineDeps;
}

/**
 * Builds the unsigned deploy XDR for an already-held booking and persists
 * the escrow's predicted `contractId` (and Trustless Work's own `txHash`
 * for it) -- once, ever, per booking, unless the caller explicitly asks to
 * rebuild one that was never submitted. Replaces the old direct
 * `chain.createBooking` call with the vendor-neutral `EscrowAdapter`, and
 * no longer also builds `fund` in the same call (see this module's own top
 * doc comment). The client address always comes from the booking's own
 * `clientWalletAddress` (AD-13's hold already recorded it). Resolves the
 * professional's wallet from the booking's own provider profile, so a
 * caller only ever needs the booking id.
 *
 * Refused (typed {@link BookingEscrowStateError}) once `escrowState` is
 * already set -- the reconciler has already confirmed this booking's money
 * state, so a lock call at that point could only be stale. Refused (typed
 * {@link BookingHoldExpiredError}) once the hold has expired with
 * `escrowState` still `null`.
 *
 * **Retry (Story 3.4, Design Notes: "Why retry reuses the stored deploy
 * XDR").** When a `contractId` is already persisted and a deploy has
 * already been submitted for it (`deploySubmittedAt` set), this returns
 * `{deployed: true, contractId}` -- there is nothing left to sign, the
 * caller should move straight to `fundDeposit`. Otherwise, absent
 * `rebuild: true`, this returns the exact same stored `{contractId,
 * unsignedXdr, txHash}` again, with no new adapter call -- a declined
 * wallet signature must be retryable within the hold. If no XDR is stored
 * at all (a pre-review-follow-up row) and `rebuild` was not requested, this
 * refuses (typed {@link BookingEscrowStateError}) rather than return an
 * incomplete result; the caller must pass `rebuild: true` to get a usable
 * XDR.
 *
 * **Rebuild.** `rebuild: true` clears the stored (never-submitted) deploy
 * and builds a fresh one, conditioned in SQL on no deploy submission being
 * recorded and `escrowState` still `null` ({@link clearUnsubmittedEscrowContractId})
 * -- this never risks abandoning money already in flight, and no longer
 * guesses via a `listEscrows` chain read (removed: the caller, who knows
 * whether their own submit attempt actually failed, is a better judge of
 * "abandoned" than an inferred chain read ever was).
 *
 * **Concurrency (issue #6).** A first deploy is preceded by one conditioned
 * SQL write that takes the booking's only in-flight claim
 * (`db/bookings.ts`'s `claimEscrowLock`) -- so a second `lockDeposit` for
 * the same booking never reaches the adapter at all. While that claimant is
 * still mid-deploy this refuses (typed {@link BookingDeployInFlightError},
 * naming the same booking id) rather than building a second escrow; once it
 * has finished this re-runs from the top and returns whatever the winner
 * actually persisted (a `{deployed: true}`, a retryable stored XDR, or a
 * typed {@link BookingEscrowStateError} if the booking has moved on further
 * still). A deploy that fails releases its claim immediately, so a retry is
 * not locked out until the stale window passes, and two *different*
 * bookings claim independently and still deploy at the same time. The older
 * conditioned-write race inside {@link updateEscrowContractId} remains as
 * the last line of defense for a rebuild that interleaves with a submit.
 *
 * **Issue #4: a wallet that cannot hold the deposit is never offered an
 * escrow.** On the path that actually builds one -- not a retry returning a
 * stored XDR -- the client's own wallet is asked, of the chain, whether it
 * can hold the anchor's USDC at all
 * (`anchor/trustline.ts`'s {@link requireUsdcTrustline}): deploying against
 * a wallet that cannot leaves a contract no refund can ever reach. A
 * network that cannot answer refuses too, rather than guess.
 */
export async function lockDeposit(
  db: Db,
  bookingId: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
  deps: LockDepositDeps = {},
): Promise<LockDepositResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const booking = await requireBooking(db, bookingId);
  if (booking.escrowState !== null) {
    throw new BookingEscrowStateError(`Booking "${bookingId}" already has escrow_state "${booking.escrowState}"; lockDeposit cannot run again`);
  }
  requireHoldNotDeclined(booking);
  requireHoldNotExpired(booking, now);
  await requireSlotNotInPast(db, booking, now);

  // Issue #48: Validate that the anchor transfer credited enough to cover
  // the deposit. A missing transfer (no anchorDepositId) is refused, as is
  // a short amount. A null amountIn (transfer exists but credited nothing)
  // is treated as "0" received. The asset uses the booking's depositAsset symbol.
  if (!booking.anchorDepositId) {
    throw new ShortDepositError("0", booking.depositAmount, DEPOSIT_ASSET_SYMBOL, "No anchor transfer was found for this booking.");
  }
  
  const receivedAmount = booking.anchorDepositAmountIn ?? "0";
  const requiredAmount = booking.depositAmount;
  
  const received = BigInt(receivedAmount);
  const required = BigInt(requiredAmount);
  
  if (received < required) {
    throw new ShortDepositError(receivedAmount, requiredAmount, DEPOSIT_ASSET_SYMBOL);
  }

  if (booking.escrowContractId !== null) {
    if (booking.deploySubmittedAt !== null) {
      return { deployed: true, contractId: booking.escrowContractId };
    }
    if (deps.rebuild) {
      // Clears the stale contractId so the recursive call below builds a
      // fresh deploy. If this write lost a race (a submit landed, or the
      // reconciler moved the booking on, between the read above and here),
      // it is simply a no-op and the recursive call below re-reads the
      // row's actual current state instead of trusting this now-possibly-
      // stale snapshot.
      await clearUnsubmittedEscrowContractId(db, bookingId, booking.escrowContractId);
      return lockDeposit(db, bookingId, adapter, { ...deps, rebuild: false });
    }
    if (!booking.escrowDeployXdr || !booking.escrowDeployTxHash) {
      throw new BookingEscrowStateError(
        `Booking "${bookingId}" has a persisted escrow contractId with no stored deploy XDR to retry; pass rebuild: true to build a fresh one`,
      );
    }
    return { deployed: false, contractId: booking.escrowContractId, unsignedXdr: booking.escrowDeployXdr, txHash: booking.escrowDeployTxHash };
  }

  // A shop an admin suspended after this hold was placed must not start a
  // new lock. A deploy already built and stored before the suspension is
  // still handed back by the retry path above -- its fund/submit may be in
  // flight, and cutting that off would strand a transaction the client has
  // already signed -- but no *new* deploy is ever built below.
  const providerProfile = await getProviderProfileById(db, booking.providerProfileId);
  if (providerProfile && providerProfile.suspendedAt !== null) {
    throw new BookingEscrowStateError(`Provider for booking "${bookingId}" is suspended; no new lock can be created.`);
  }

  const providerAddress = await requireProviderAddress(db, booking);

  // Issue #4: a deposit this deploy locks can only come back out of -- or
  // ever into -- a wallet that can hold the asset at all, so a wallet that
  // cannot would trap the money in its own escrow. Asked before the claim
  // and before the adapter call, so a refusal costs no contract and leaves
  // nothing in flight.
  await requireUsdcTrustline(booking.clientWalletAddress, deps.usdcTrustline);

  // Issue #6: take this booking's one in-flight first-deploy claim *before*
  // the adapter call, in one conditioned SQL write (`db/bookings.ts`'s
  // `claimEscrowLock`) -- the persisted `contractId` below could only ever
  // settle which of two racing deploys *won*, never stop the second deploy
  // from happening at all.
  const claimToken = randomBytes(16).toString("hex");
  const claimed = await claimEscrowLock(db, bookingId, claimToken, now);
  if (!claimed) {
    const current = await requireBooking(db, bookingId);
    if (current.escrowContractId === null && current.escrowState === null) {
      throw new BookingDeployInFlightError(bookingId);
    }
    // The claimant has already finished -- re-run from the top and return
    // from the row's actual state (its persisted contractId, or the typed
    // refusal if the booking has moved on further still).
    return lockDeposit(db, bookingId, adapter, deps);
  }

  let deployResult: DeployEscrowResult;
  try {
    deployResult = await adapter.deploy({
      bookingId: booking.id,
      clientAddress: booking.clientWalletAddress,
      providerAddress,
      tokenAddress: booking.tokenAddress,
      assetSymbol: DEPOSIT_ASSET_SYMBOL,
      amount: booking.depositAmount,
      title: `Pactly booking ${booking.id}`,
      description: `Pactly session deposit for booking ${booking.id}`,
    });
  } catch (error) {
    // Issue #6: a failed deploy that stored no contract id releases the
    // claim on the way out, so an immediate retry is not locked out until
    // the stale window passes.
    await releaseEscrowLock(db, bookingId, claimToken);
    throw error;
  }
  try {
    await updateEscrowContractId(db, bookingId, deployResult.contractId, deployResult.unsignedXdr, deployResult.txHash);
  } catch (error) {
    await releaseEscrowLock(db, bookingId, claimToken);
    if (error instanceof TypeError) {
      // Lost a race to a concurrent lockDeposit call that persisted first
      // -- never let that raw TypeError escape as an untyped 500. Re-read
      // and let the guards above decide from the row's actual state.
      return lockDeposit(db, bookingId, adapter, deps);
    }
    throw error;
  }
  // Issue #31: a fresh deploy persisted means the lock action is underway --
  // record a "lock" event for both parties so each side sees it on their
  // own event list.
  await recordEscrowEventForBothParties(
    db,
    booking.id,
    booking.clientWalletAddress,
    providerAddress,
    "lock",
    now,
  );

  // Issue #7: recorded beside the id itself, once it is actually persisted.
  // A deploy that failed, or one that lost the race above and never stored
  // anything, reaches neither line -- so a contract id only ever enters the
  // history when the booking really had it.
  await recordContractDeployment(db, { bookingId, contractId: deployResult.contractId, deployedAt: now });

  return { deployed: false, contractId: deployResult.contractId, unsignedXdr: deployResult.unsignedXdr, txHash: deployResult.txHash };
}

export interface FundDepositDeps {
  now?: number;
  /** Issue #5: asks the network whether one transaction hash has already
   * settled successfully. Only ever consulted for a fund transaction this
   * booking has already built (a stored `escrowFundTxHash`), i.e. on a
   * rebuild -- never on a booking's first fund, and it never writes
   * anything. Defaults to {@link transactionReachedSuccess}'s own real
   * Soroban RPC read; a test injects a canned answer. */
  transactionReachedSuccess?: (txHash: string) => Promise<boolean>;
}

/** Issue #5: the fund transaction Pactly already built for this booking has
 * settled successfully on chain, so the deposit is in -- building another
 * would put the client one signature away from paying twice. Refused rather
 * than rebuilt; the reconciler's own chain evidence is what moves
 * `escrow_state` and turns this into a confirmed funding (AD-1). */
export class DepositAlreadyLandedError extends Error {
  bookingId: string;

  constructor(bookingId: string, message = "Your deposit has already reached the escrow. This will show in a moment.") {
    super(message);
    this.name = "DepositAlreadyLandedError";
    this.bookingId = bookingId;
  }
}

/**
 * Builds the unsigned fund XDR against the `contractId` `lockDeposit`
 * already persisted -- never a caller-supplied one, so `fundDeposit` can
 * never be pointed at an escrow this booking never deployed. Stores
 * Trustless Work's own `txHash` for the built transaction so
 * `submitSignedTransaction` can match a signed envelope against it.
 *
 * Refused (typed {@link BookingEscrowStateError}) when no `contractId` is
 * persisted yet, or no deploy has actually been submitted for it yet
 * (review follow-up: building a fund transaction against a contract that
 * may not exist on chain is unverified -- `deploySubmittedAt` is the
 * booking's own recorded evidence that a deploy was relayed, not merely
 * built), or `escrowState` is already set (the reconciler has already
 * confirmed this booking's own money state; a fund call at that point
 * could only be stale or a replay). Refused (typed
 * {@link BookingHoldExpiredError}) once the hold has expired with
 * `escrowState` still `null`.
 *
 * **Issue #5: a fund that already landed is never asked for again.** Only a
 * *rebuild* can be a duplicate -- a booking with no stored
 * `escrowFundTxHash` has never had a fund transaction built, so nothing is
 * read from the network for it, and `fundDeposit` goes straight to the
 * adapter exactly as before. Once one has been built, its own hash is asked
 * of the chain first: a SUCCESS settles it (typed
 * {@link DepositAlreadyLandedError} -- the deposit is in, and signing a
 * second fund XDR would put the client one tap away from paying twice),
 * anything else (still flying, or failed) leaves the retry open. A network
 * that cannot answer at all refuses too ({@link
 * TransactionStatusUnavailableError}, retryable) rather than have a missing
 * answer read as permission to build another.
 */
export async function fundDeposit(
  db: Db,
  bookingId: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
  deps: FundDepositDeps = {},
): Promise<UnsignedTransaction> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const booking = await requireBooking(db, bookingId);
  if (!booking.escrowContractId || !booking.deploySubmittedAt) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no confirmed deploy submission yet; call lockDeposit and submit it first`,
    );
  }
  if (booking.escrowState !== null) {
    throw new BookingEscrowStateError(`Booking "${bookingId}" already has escrow_state "${booking.escrowState}"; cannot fund again`);
  }
  requireHoldNotDeclined(booking);
  requireHoldNotExpired(booking, now);
  await requireSlotNotInPast(db, booking, now);

  if (booking.escrowFundTxHash) {
    const reachedSuccess = deps.transactionReachedSuccess ?? ((txHash: string) => transactionReachedSuccess(txHash));
    if (await reachedSuccess(booking.escrowFundTxHash)) {
      throw new DepositAlreadyLandedError(bookingId);
    }
  }

  const result = await adapter.fund({
    contractId: booking.escrowContractId,
    clientAddress: booking.clientWalletAddress,
    amount: booking.depositAmount,
  });
  await setEscrowFundTxHash(db, bookingId, result.txHash);
  return result;
}

export interface ResolveBookingDisputeResult extends UnsignedTransaction {
  outcome: DisputeOutcome;
}

/**
 * Builds Pactly's own unsigned resolve-dispute XDR and records the
 * decision (Design Notes: "Why the resolution decision is recorded with
 * its txHash"; "Why dispute resolution is always one full-amount
 * distribution" -- Pactly's cancellation rule never splits a deposit).
 * Never triggered by a deadline (Story 1.8 AC7) -- only ever called on
 * Pactly's own explicit decision, made elsewhere (booking-policy logic
 * outside this story's scope), about who cancelled and when.
 *
 * Refused (typed {@link BookingEscrowStateError}), before the adapter is
 * ever called, unless the booking is `locked` with a persisted
 * `contractId` *and* the reconciler's own latest recorded lifecycle action
 * for that same `contractId` is `"disputed"` ({@link getEscrowLifecycle}) --
 * a dispute can only be resolved once the chain itself shows one open
 * against the escrow this booking actually deployed, never merely because
 * the booking's own `escrowState` happens to read `"locked"` (which is
 * also true before any dispute exists at all). Recording the decision is
 * an upsert ({@link recordEscrowDisputeResolution}): calling this again
 * replaces the earlier decision rather than raising a raw SQLite error,
 * since an unsigned or expired XDR from a first attempt must not
 * permanently lock the booking to a decision nobody ever signed.
 */
export async function resolveBookingDispute(
  db: Db,
  bookingId: string,
  outcome: DisputeOutcome,
  adapter: EscrowAdapter = defaultEscrowAdapter,
  audit?: { adminWallet: string; reason?: string },
): Promise<ResolveBookingDisputeResult> {
  const booking = await requireBooking(db, bookingId);
  // Issue #33: a second resolve returns the stored outcome and does not
  // call the escrow again. A booking whose deposit was already allocated
  // by an earlier resolution is not re-resolved.
  const existing = await getEscrowDisputeResolution(db, bookingId);
  if (existing) {
    return { unsignedXdr: "", txHash: existing.txHash, outcome: existing.outcome };
  }
  if (booking.escrowState !== "locked" || !booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be "locked" with a persisted escrow contractId to resolve a dispute ` +
        `(escrowState is "${booking.escrowState}")`,
    );
  }
  const lifecycle = await getEscrowLifecycle(db, bookingId);
  if (lifecycle?.contractId !== booking.escrowContractId || lifecycle.action !== "disputed") {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no chain-confirmed "disputed" evidence for its current escrow contractId; ` +
        "resolveBookingDispute refuses to build a resolution without it",
    );
  }
  if (booking.escrowResolveSubmittedAt !== null) {
    // A resolve for this same dispute is already awaiting chain
    // confirmation (the lifecycle above is still "disputed", not yet
    // "resolved") -- refuse a second, competing resolve XDR rather than
    // building one nobody asked to replace the first with.
    throw new BookingActionPendingError();
  }
  const providerAddress = await requireProviderAddress(db, booking);
  const targetAddress = outcome === "refund-client" ? booking.clientWalletAddress : providerAddress;

  const result = await adapter.resolveDispute({
    contractId: booking.escrowContractId,
    distributions: [{ address: targetAddress, amount: booking.depositAmount }],
  });

  const decidedAt = Math.floor(Date.now() / 1000);
  db.transaction((tx) => {
    recordEscrowDisputeResolutionSync(tx, {
      bookingId,
      contractId: booking.escrowContractId as string,
      outcome,
      txHash: result.txHash,
      decidedAt,
    });
    // Also stored on the booking row itself (duplicated from the row above)
    // so `submitSignedTransaction`'s hash-matching rule can check every
    // Story 3.6 action's hash from one row, without a second query.
    setEscrowActionTxHashSync(tx, bookingId, "resolve", result.txHash);
    if (audit) {
      const cleanReason = typeof audit.reason === "string" ? audit.reason.trim() : "";
      insertAdminDecisionAuditSync(tx, {
        adminWallet: audit.adminWallet,
        action: "resolve-dispute",
        targetId: bookingId,
        reason: cleanReason.length > 0 ? cleanReason : null,
        decidedAt: Date.now(),
      });
    }
  });

  return { ...result, outcome };
}

/**
 * "Withdraw Dispute" (opener only): the party who opened an unresolved
 * dispute may withdraw it -- restoring the booking to its previous `locked`
 * state while keeping the deposit where it was. The dispute note (reason,
 * opener, suggested outcome) is preserved in `escrow_dispute_openings` with
 * a new `withdrawnAt` timestamp so the history remains readable. Withdrawing
 * an already-withdrawn/locked dispute is a safe no-op that still reflects the
 * locked state.
 * 
 * Rejects:
 * - Anyone other than the opener (403 UNAUTHORIZED_WITHDRAWAL)
 * - Anyone after an admin has already resolved the dispute (409 DISPUTE_RESOLVED)
 * - A booking that is not in a `disputed` state (409 BOOKING_STATE)
 */
export async function withdrawDispute(
  db: Db,
  bookingId: string,
  walletAddress: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<{ bookingId: string; escrowState: "locked" | "disputed"; withdrawnAt: number | null }> {
  const booking = await requireBooking(db, bookingId);
  
  // Check if the caller is the opener of the dispute
  const isOpener = booking.pendingDisputeOpenerWallet === walletAddress;
  if (!isOpener) {
    // Also check the escrow_dispute_openings table for submitted disputes
    const opening = await getEscrowDisputeOpening(db, bookingId);
    if (!opening || opening.openedByWallet !== walletAddress) {
      throw new UnauthorizedDisputeWithdrawalError();
    }
  }
  
  // If the dispute is already resolved (escrowState is not "disputed"), reject withdrawal
  if (booking.escrowState !== "disputed") {
    // If it's already locked (previously withdrawn), this is a safe no-op
    if (booking.escrowState === "locked") {
      const opening = await getEscrowDisputeOpening(db, bookingId);
      return { bookingId, escrowState: "locked", withdrawnAt: opening?.withdrawnAt ?? null };
    }
    throw new DisputeAlreadyResolvedError();
  }
  
  // Check if there's a chain-confirmed dispute for this contract
  const lifecycle = await getEscrowLifecycle(db, bookingId);
  if (lifecycle?.contractId !== booking.escrowContractId || lifecycle.action !== "disputed") {
    // No chain-confirmed dispute, but escrowState says "disputed" -- this could be
    // a locally opened dispute that was never submitted, or the reconciler hasn't
    // caught up. In either case, we can withdraw locally.
  }
  
  // Check if a resolve is already pending (awaiting chain confirmation)
  if (booking.escrowResolveSubmittedAt !== null) {
    throw new DisputeAlreadyResolvedError();
  }
  
  // Withdraw the dispute: clear the pending dispute fields and set escrowState back to "locked"
  await db.update(bookings).set({
    escrowState: "locked",
    escrowDisputeTxHash: null,
    pendingDisputeReason: null,
    pendingDisputeOpenerWallet: null,
    pendingDisputeOpenerRole: null,
    escrowDisputeSubmittedAt: null,
  }).where(eq(bookings.id, bookingId));
  
  // Record the withdrawal in escrow_dispute_openings (preserving the note)
  const opening = await getEscrowDisputeOpening(db, bookingId);
  if (opening && opening.contractId === booking.escrowContractId) {
    await db.update(escrowDisputeOpenings).set({ withdrawnAt: now }).where(eq(escrowDisputeOpenings.bookingId, bookingId));
  }
  
  return { bookingId, escrowState: "locked", withdrawnAt: now };
}

// ---------------------------------------------------------------------------
// Story 3.6: appointment completion, release and resolution. Every action
// below follows the same shape: resolve ownership (404 if the caller does
// not hold the required role on this booking), guard the current lifecycle
// state (409 BOOKING_STATE otherwise), call the adapter, then store the
// built transaction's own txHash on the booking so `submitSignedTransaction`
// can relay only a signed envelope Pactly actually built for this booking
// and this role (the spec's own "Always" rule).
// ---------------------------------------------------------------------------

/**
 * "Complete" (provider only): the provider's own signed declaration that the
 * appointment happened -- `EscrowAdapter.complete`, milestone 0 status
 * `"completed"`. Refused (typed {@link BookingEscrowStateError}) unless the
 * booking is `locked` with a persisted `contractId` and the reconciler's own
 * latest recorded lifecycle action is `"funded"` (or nothing has been
 * recorded past that yet is impossible once `escrowState` reads `"locked"`,
 * since that column is only ever set alongside a recorded action) -- calling
 * this again once the appointment is already `completed`/`approved`/
 * `disputed`/`released` is refused the same way. Never moves money itself;
 * `escrow_state` stays `locked` either way (AD-1).
 */
export async function completeAppointment(
  db: Db,
  bookingId: string,
  providerWalletAddress: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
): Promise<UnsignedTransaction> {
  const booking = await getBookingForProvider(db, bookingId, providerWalletAddress);
  if (booking.escrowState !== "locked" || !booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be locked with a persisted escrow contractId to complete it (escrowState is "${booking.escrowState}")`,
    );
  }
  const lifecycle = await getEscrowLifecycle(db, bookingId);
  if (lifecycle?.contractId !== booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no chain-confirmed evidence yet for its current escrow contractId`,
    );
  }
  if (booking.escrowCompleteSubmittedAt !== null && lifecycle.action === "funded") {
    throw new BookingActionPendingError();
  }
  if (lifecycle.action !== "funded") {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" cannot be completed from its current lifecycle state ("${lifecycle.action}")`,
    );
  }
  const result = await adapter.complete({ contractId: booking.escrowContractId, providerAddress: providerWalletAddress });
  await setEscrowActionTxHash(db, bookingId, "complete", result.txHash);
  return result;
}

/**
 * "Approve" (client only): the approver's own signature -- allowed once the
 * appointment is either merely `funded` or already `completed` (the spec's
 * own I/O-matrix row: "Approve | Client, lifecycle completed or funded"),
 * refused (typed {@link BookingEscrowStateError}) from any other state
 * (`disputed`, `approved` again, `released`, `resolved`, or not locked at
 * all).
 */
export async function approveAppointment(
  db: Db,
  bookingId: string,
  clientWalletAddress: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
): Promise<UnsignedTransaction> {
  const booking = await getBookingForClient(db, bookingId, clientWalletAddress);
  if (booking.escrowState !== "locked" || !booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be locked with a persisted escrow contractId to approve it (escrowState is "${booking.escrowState}")`,
    );
  }
  const lifecycle = await getEscrowLifecycle(db, bookingId);
  if (lifecycle?.contractId !== booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no chain-confirmed evidence yet for its current escrow contractId`,
    );
  }
  if (booking.escrowApproveSubmittedAt !== null && (lifecycle.action === "funded" || lifecycle.action === "completed")) {
    throw new BookingActionPendingError();
  }
  if (lifecycle.action !== "funded" && lifecycle.action !== "completed") {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" cannot be approved from its current lifecycle state ("${lifecycle.action}")`,
    );
  }
  const result = await adapter.approve({ contractId: booking.escrowContractId, clientAddress: clientWalletAddress });
  await setEscrowActionTxHash(db, bookingId, "approve", result.txHash);
  return result;
}

/**
 * "Release" (provider only, self-claim):
 *
 * - Once the reconciler's own chain-derived lifecycle shows the release
 *   already applied (`"released"`, or the booking is already `released`),
 *   this marks the booking released (when that write had not landed yet)
 *   and returns `{ status: "applied" }` **without building or submitting
 *   anything** -- a second click can never submit a second release against
 *   an escrow that already paid.
 * - Otherwise, refused (typed {@link BookingEscrowStateError}) unless the
 *   latest recorded lifecycle action is exactly `"approved"` -- per the
 *   spec's own role map row ("release: provider wallet (release signer),
 *   only when the latest lifecycle is approved and not disputed"). A
 *   dispute opened after approval would itself become the *latest*
 *   recorded action (the reconciler's own rank puts `disputed` above
 *   `approved`), so checking for `"approved"` alone already excludes that
 *   case -- no separate "not disputed" check is needed.
 *
 * A release that was already signed and relayed (`escrowReleaseSubmittedAt`
 * set) but has not been applied on chain is retryable: this rebuilds a
 * release XDR against the *same* `escrowContractId`, so the retry can never
 * point at a different escrow. Once the chain-confirmed `"released"`
 * evidence is recorded, that retry path is refused (returns `"applied"`)
 * and no adapter call happens at all.
 */
export type ReleaseDepositResult =
  | { status: "ready"; contractId: string; unsignedXdr: string; txHash: string }
  | { status: "applied"; contractId: string };

export async function releaseDeposit(
  db: Db,
  bookingId: string,
  providerWalletAddress: string,
  adapter: EscrowAdapter = defaultEscrowAdapter,
): Promise<ReleaseDepositResult> {
  const booking = await getBookingForProvider(db, bookingId, providerWalletAddress);
  if (!booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be locked with a persisted escrow contractId to release it (escrowState is "${booking.escrowState}")`,
    );
  }

  // Already released, by the booking's own state or by the reconciler's
  // chain-derived lifecycle. Mirror a lifecycle-confirmed release onto
  // `escrow_state` when that write had not landed yet, then return without
  // touching the adapter -- the deposit has already moved. This check sits
  // before the `locked`/`approved` guards on purpose: a booking whose chain
  // evidence is ahead of its stored state must never look releasable again.
  if (booking.escrowState === "released") {
    return { status: "applied", contractId: booking.escrowContractId };
  }
  const lifecycle = await getEscrowLifecycle(db, bookingId);
  if (lifecycle?.contractId !== booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no chain-confirmed evidence yet for its current escrow contractId`,
    );
  }
  if (lifecycle.action === "released") {
    // `updateEscrowStateIfNotTerminalSync` is the reconciler's own writer:
    // this mirrors evidence the reconciler has already recorded, never
    // invents a chain transition (AD-1).
    updateEscrowStateIfNotTerminalSync(db, bookingId, "released");
    return { status: "applied", contractId: booking.escrowContractId };
  }

  if (booking.escrowState !== "locked") {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be locked with a persisted escrow contractId to release it (escrowState is "${booking.escrowState}")`,
    );
  }
  if (lifecycle.action !== "approved") {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" cannot be released from its current lifecycle state ("${lifecycle.action}"); it must be "approved"`,
    );
  }

  // A previously signed-but-unapplied release is retried here, on the same
  // persisted contractId. `escrowReleaseSubmittedAt` deliberately does not
  // block this: the retry exists precisely for that in-flight case, and the
  // chain-applied check above is what refuses a retry after success.
  const result = await adapter.release({ contractId: booking.escrowContractId, providerAddress: providerWalletAddress });
  await setEscrowActionTxHash(db, bookingId, "release", result.txHash);
  return { status: "ready", contractId: booking.escrowContractId, ...result };
}

/**
 * Story 3.6 (review round): each dispute reason is bound to whichever role
 * may actually claim it -- a client may claim that the client is cancelling,
 * that the provider did not show up, or a plain disagreement; a provider's
 * own three mirror that. `openDispute` refuses (typed
 * {@link InvalidDisputeReasonError}) any reason outside the caller's own
 * role's set, including the other role's reasons and any unrecognized
 * string.
 */
const CLIENT_DISPUTE_REASONS: readonly DisputeReason[] = ["client-cancel", "provider-no-show", "disagreement"];
const PROVIDER_DISPUTE_REASONS: readonly DisputeReason[] = ["provider-cancel", "client-no-show", "disagreement"];

function isDisputeReasonAllowedForRole(reason: DisputeReason, role: "client" | "provider"): boolean {
  const allowed = role === "client" ? CLIENT_DISPUTE_REASONS : PROVIDER_DISPUTE_REASONS;
  return (allowed as readonly string[]).includes(reason);
}

/**
 * The cancellation and no-show policy (decided 2026-09-18, "who cancels
 * decides", stated in EXPERIENCE.md before any dispute ever opens): the
 * provider cancelling, or the provider not showing up, both point at a full
 * refund to the client; the client not showing up points at the full
 * deposit going to the provider; the client cancelling points at a full
 * refund at or before `cancelDeadline`, and the full deposit to the provider
 * after it. `"disagreement"` has no policy-implied outcome at all --
 * `undefined`, never a guessed value -- so the admin picks with no steer
 * (Story 3.6's own Boundaries: "The suggestion is guidance, never automatic"
 * applies doubly here, since there is no suggestion).
 */
function computeSuggestedOutcome(reason: DisputeReason, booking: BookingRow, now: number): DisputeOutcome | undefined {
  switch (reason) {
    case "provider-cancel":
    case "provider-no-show":
      return "refund-client";
    case "client-no-show":
      return "pay-provider";
    case "client-cancel":
      return now <= booking.cancelDeadline ? "refund-client" : "pay-provider";
    case "disagreement":
      return undefined;
  }
}

export interface OpenDisputeResult extends UnsignedTransaction {
  reason: DisputeReason;
  suggestedOutcome?: DisputeOutcome;
  /** Issue #22: the note the opener attached (free text, may be empty). */
  note?: string;
  /** Issue #22: the SHA-256 hex evidence hash the opener attached (or undefined). */
  evidenceHash?: string;
}

async function requireDisputeWindowOpen(
  db: Db,
  booking: Pick<BookingRow, "slotId">,
  reason: DisputeReason,
  now: number,
): Promise<void> {
  const slot = booking.slotId ? await getSlotById(db, booking.slotId) : undefined;
  if (!slot) {
    throw new DisputeWindowClosedError();
  }
  if (now < slot.startsAt && (reason === "client-cancel" || reason === "provider-cancel")) {
    return;
  }
  const deadline = getDisputeDeadline(slot.startsAt);
  if (deadline === null || now < slot.startsAt || now > deadline) {
    throw new DisputeWindowClosedError();
  }
}

/**
 * "Dispute" (client or provider): either side may raise one while the
 * booking is `locked` and no dispute is already open for it -- refused
 * (typed {@link BookingEscrowStateError}) once `escrowState` is not
 * `locked` at all (never locked yet, or already `released`/`refunded`,
 * covering the spec's own "Released or resolved: 409" row), the reconciler's
 * own chain-derived lifecycle has not yet caught up to the booking's current
 * `contractId`, or the reconciler's own latest recorded action is already
 * `"disputed"`. Refused (typed {@link InvalidDisputeReasonError}) for a
 * `reason` outside the caller's own role's whitelist. Refused (typed
 * {@link BookingActionPendingError}) while an earlier dispute build for this
 * booking has already been submitted and the lifecycle has not yet observed
 * it. The linked appointment must have started and be within seven days;
 * the same server-time check runs again before a signed dispute is relayed.
 * Pactly itself never opens a dispute (Story 1.8 AC7): `signerAddress`
 * is always the caller's own wallet, one of the two parties, never Pactly's.
 *
 * Review round: building the XDR no longer writes `escrow_dispute_openings`
 * -- it only stores the pending hash/reason/opener on the booking row
 * ({@link setPendingDispute}, "last builder wins": a "Never mind" that never
 * signs leaves no opening record at all). The real record, with its
 * `suggestedOutcome` computed against the *submit*-time clock, is written by
 * `submitSignedTransaction` once a signed transaction matching this hash is
 * actually relayed.
 */
export async function openDispute(
  db: Db,
  bookingId: string,
  walletAddress: string,
  reason: DisputeReason,
  adapter: EscrowAdapter = defaultEscrowAdapter,
  now: number = Math.floor(Date.now() / 1000),
  /** Issue #22: a free-text note the opener attaches to the dispute (may be empty). */
  note: string = "",
  /** Issue #22: a SHA-256 hex evidence hash the opener attests to (64 lowercase hex chars, or ""). */
  evidenceHash: string = "",
): Promise<OpenDisputeResult> {
  const { booking, role } = await getBookingForClientOrProvider(db, bookingId, walletAddress);
  if (!isDisputeReasonAllowedForRole(reason, role)) {
    throw new InvalidDisputeReasonError();
  }
  if (evidenceHash !== "" && !/^[0-9a-f]{64}$/.test(evidenceHash)) {
    throw new InvalidDisputeReasonError("The evidence hash must be 64 lowercase hex characters.");
  }
  const trimmedNote = note?.trim();
  if (trimmedNote !== undefined && trimmedNote.length > 500) {
    throw new InvalidDisputeReasonError("The dispute note must be 500 characters or less.");
  }
  if (booking.escrowState !== "locked" || !booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be locked with a persisted escrow contractId to open a dispute (escrowState is "${booking.escrowState}")`,
    );
  }
  const lifecycle = await getEscrowLifecycle(db, bookingId);
  if (lifecycle?.contractId !== booking.escrowContractId) {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" has no chain-confirmed evidence yet for its current escrow contractId`,
    );
  }
  if (booking.escrowDisputeSubmittedAt !== null && lifecycle.action !== "disputed") {
    throw new BookingActionPendingError();
  }
  if (lifecycle.action === "disputed") {
    throw new BookingEscrowStateError(`Booking "${bookingId}" already has an open dispute`);
  }
  await requireDisputeWindowOpen(db, booking, reason, now);
  if ((reason === "client-no-show" || reason === "provider-no-show") && now <= booking.cancelDeadline) {
    throw new BookingActionPendingError(
      `No-show can only be claimed after the cancellation deadline.`,
    );
  }
  const result = await adapter.startDispute({ contractId: booking.escrowContractId, signerAddress: walletAddress, reason });
  const suggestedOutcome = computeSuggestedOutcome(reason, booking, now);
  const providerAddress = await requireProviderAddress(db, booking);
  await setPendingDispute(db, bookingId, { txHash: result.txHash, reason, openerWallet: walletAddress, openerRole: role, note: trimmedNote || undefined, evidenceHash: evidenceHash || undefined });
  // Issue #31: record a "dispute" event for both parties.
  await recordEscrowEventForBothParties(db, booking.id, booking.clientWalletAddress, providerAddress, "dispute", now);
  return { ...result, reason, suggestedOutcome, note: trimmedNote || undefined, evidenceHash: evidenceHash || undefined };
}

export interface AdminDisputeListItem {
  bookingId: string;
  contractId: string;
  /** `""` when no opening record exists for this booking's current
   * contract (a dispute raised outside Pactly's own route, in principle) --
   * see this function's own doc comment. */
  openedByWallet: string;
  openedByRole?: DisputeOpenerRole;
  reason: DisputeReason | "unknown";
  suggestedOutcome?: DisputeOutcome;
  amount: Money;
  provider: BookingProviderSummary;
  clientWalletAddress: string;
  slotStartsAt: number | null;
  /** Story 3.6 (review round): `"resolve"` while an admin's resolve is
   * already awaiting chain confirmation for this booking -- the admin UI
   * hides/disables the row rather than let a second resolve be built. */
  pendingAction: EscrowActionKind | null;
}

/**
 * `GET /admin/disputes`: every booking whose reconciler-derived lifecycle
 * currently reads `"disputed"` for its own `contractId` (review round: driven
 * from the bookings themselves, not from `escrow_dispute_openings`, since an
 * opening is now only ever recorded once a dispute build is actually
 * submitted -- a booking can be genuinely disputed on chain with no opening
 * record at all if the dispute was raised outside Pactly's own route),
 * left-joined to its own opening record (`reason: "unknown"` when none
 * matches the booking's current contract), plus the opener's role, the
 * policy's own suggested outcome (guidance only -- "The admin may pick
 * either outcome" per the spec's own "Always" rule), and the deposit amount.
 * Provider/slot lookups are batched (deduped ids, `Promise.all`), never one
 * query per row. Route-level authorization (an admin wallet) is the
 * caller's job; this function itself has no notion of "who is allowed to
 * call it".
 */
export async function listOpenDisputes(db: Db): Promise<AdminDisputeListItem[]> {
  const candidates = await getReconcilableBookings(db);
  if (candidates.length === 0) return [];

  const candidateBookings = candidates.map((candidate) => candidate.booking);
  const lifecycleByBooking = await getEscrowLifecycleForBookings(db, candidateBookings);
  const disputedBookings = candidateBookings.filter((booking) => lifecycleByBooking.get(booking.id)?.action === "disputed");
  if (disputedBookings.length === 0) return [];

  const openingByBooking = await getEscrowDisputeOpeningsForBookings(
    db,
    disputedBookings.map((booking) => booking.id),
  );

  const providerIds = [...new Set(disputedBookings.map((booking) => booking.providerProfileId))];
  const profiles = await Promise.all(providerIds.map((id) => getProviderProfileById(db, id)));
  const profileById = new Map(profiles.filter((profile): profile is NonNullable<typeof profile> => Boolean(profile)).map((profile) => [profile.id, profile]));

  const slotIds = [...new Set(disputedBookings.map((booking) => booking.slotId).filter((id): id is string => id !== null))];
  const slots = await Promise.all(slotIds.map((id) => getSlotById(db, id)));
  const slotById = new Map(slots.filter((slot): slot is NonNullable<typeof slot> => Boolean(slot)).map((slot) => [slot.id, slot]));

  return disputedBookings.map((booking) => {
    const opening = openingByBooking.get(booking.id);
    const matchesCurrentContract = opening !== undefined && opening.contractId === booking.escrowContractId;
    const profile = profileById.get(booking.providerProfileId);
    const slot = booking.slotId ? slotById.get(booking.slotId) : undefined;
    return {
      bookingId: booking.id,
      contractId: booking.escrowContractId as string,
      openedByWallet: matchesCurrentContract ? opening.openedByWallet : "",
      openedByRole: matchesCurrentContract ? (opening.openedByRole ?? undefined) : undefined,
      reason: matchesCurrentContract ? opening.reason : "unknown",
      suggestedOutcome: matchesCurrentContract ? (opening.suggestedOutcome ?? undefined) : undefined,
      amount: { amount: booking.depositAmount, asset: ASSET },
      provider: profile
        ? { id: profile.id, displayName: profile.displayName, title: profile.title }
        : { id: booking.providerProfileId, displayName: "", title: "" },
      clientWalletAddress: booking.clientWalletAddress,
      slotStartsAt: slot?.startsAt ?? null,
      pendingAction: derivePendingAction(booking, "disputed"),
    };
  });
}

// ---------------------------------------------------------------------------
// Story 3.7: paying the balance before the session. Two independent paths,
// entirely separate from every escrow write above (AD-3: neither ever
// touches `escrow_state` or the Trustless Work adapter): the client pays
// through Pactly (a plain Stellar USDC payment this backend builds, the
// client signs, and this backend submits and polls to a confirmed ledger
// result before ever writing `paid_platform`), or the provider records a
// cash payment directly. `balance_state` moves forward only, and only
// through these two functions plus `markBalancePaidCash` below.
// ---------------------------------------------------------------------------

/** `balanceAmount` is `"0"` -- there is nothing to build a payment for. The
 * spec's own "Always" rule: "A zero balance means nothing to pay, and the
 * UI hides the action" -- this is the server-side backstop for that same
 * rule, not the primary defense. */
export class NothingToPayError extends Error {
  constructor(message = "There's nothing to pay -- this booking's balance is zero.") {
    super(message);
    this.name = "NothingToPayError";
  }
}

/** Review follow-up: a platform payment was confirmed on chain
 * (`submitBalancePaymentTransaction` returned SUCCESS) but
 * {@link markBalancePaidPlatform}'s own guarded write reported `false` --
 * the booking's `balanceState` had already moved on (a race with a
 * concurrent cash mark, or a resubmit of an already-recorded payment) by the
 * time this call tried to record it. The money moved; this is never shown
 * as a plain success, and never silently dropped either. */
export class BalanceAlreadySettledError extends Error {
  constructor(
    public readonly bookingId: string,
    public readonly txHash: string,
  ) {
    super(
      "This payment landed on chain, but Pactly could not record it because the booking's balance was no longer unpaid. " +
        "Contact support with this transaction so it can be reconciled.",
    );
    this.name = "BalanceAlreadySettledError";
  }
}

/** Refuses (typed {@link BookingEscrowStateError}) unless the booking is
 * `locked` with `balanceState` still `"unpaid"` and has a slot on record
 * whose appointment has not started yet -- the two preconditions
 * {@link buildBalancePayment} checks before ever building a transaction,
 * and {@link submitBalancePayment} re-checks again immediately before ever
 * relaying anything to the network (review follow-up: state can move
 * between build and submit, e.g. the provider marking cash paid, or the
 * appointment's own start time simply passing, while the client is still
 * mid-flow with a signed envelope in hand). A booking with no `slotId` at
 * all (a pre-3.4 row with no recorded appointment time) is refused the same
 * way -- there is no time to check "before the session" against, so this
 * never assumes it is still safe to pay (review follow-up: the appointment-
 * started gate previously skipped entirely for such a booking). */
async function requireBalancePayable(db: Db, booking: BookingRow, now: number, action: string): Promise<void> {
  if (booking.escrowState !== "locked" || booking.balanceState !== "unpaid") {
    throw new BookingEscrowStateError(
      `Booking "${booking.id}" must be locked with an unpaid balance to ${action} ` +
        `(escrowState is "${booking.escrowState}", balanceState is "${booking.balanceState}")`,
    );
  }
  const slot = booking.slotId ? await getSlotById(db, booking.slotId) : undefined;
  if (!slot || slot.startsAt <= now) {
    throw new BookingEscrowStateError(
      `Booking "${booking.id}"'s appointment has already started, or has no scheduled time on record; ` +
        `the balance can no longer be paid through Pactly`,
    );
  }
}

export interface BuildBalancePaymentDeps extends BuildPaymentDeps {
  now?: number;
  /** Overrides how the USDC asset is resolved -- defaults to the real,
   * cached anchor lookup (`anchor/usdc.ts`), same seam `holdSlot` already
   * uses. */
  resolveUsdcAsset?: (options?: ResolveUsdcAssetOptions) => Promise<UsdcAsset>;
}

export interface BuildBalancePaymentResult {
  unsignedXdr: string;
}

/**
 * `POST /bookings/:id/balance/pay`: builds the unsigned "pay the balance"
 * transaction -- a plain classic Stellar USDC payment from the booking's own
 * client wallet to the provider's wallet, using the anchor-resolved USDC
 * asset (3.4's resolver) and the booking's own persisted `balanceAmount`,
 * converted with exact string arithmetic (never a float). Refused (typed
 * {@link BookingEscrowStateError}) via {@link requireBalancePayable} unless
 * the booking is `locked` with an unpaid balance and a not-yet-started
 * appointment; refused (typed {@link NothingToPayError}) when the balance is
 * `"0"`. The built transaction's own hash is persisted
 * (`balancePaymentBuiltHash`) so `submitBalancePayment` can later refuse
 * anything that is not the exact envelope this call built (3.4's own
 * submit-binding rule, extended to this payment).
 *
 * Review follow-up: both of this function's own network calls (resolving
 * the anchor's USDC asset, loading the client's account) are wrapped so a
 * failure surfaces as a typed {@link PaymentUnavailableError} (the route's
 * own `503 PAYMENT_UNAVAILABLE`), never an unhandled 500 -- a data-integrity
 * failure in the amount itself (the SDK's own validation) still escapes as
 * a plain {@link TypeError}, since retrying that would never help.
 */
export async function buildBalancePayment(
  db: Db,
  bookingId: string,
  clientWalletAddress: string,
  deps: BuildBalancePaymentDeps = {},
): Promise<BuildBalancePaymentResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const resolveUsdc = deps.resolveUsdcAsset ?? resolveUsdcAsset;
  const booking = await getBookingForClient(db, bookingId, clientWalletAddress);
  await requireBalancePayable(db, booking, now, "pay it");
  if (booking.balanceAmount === "0") {
    throw new NothingToPayError();
  }
  const providerAddress = await requireProviderAddress(db, booking);

  let usdc: UsdcAsset;
  try {
    usdc = await resolveUsdc();
  } catch (error) {
    throw new PaymentUnavailableError(
      `Could not resolve the anchor's USDC asset to build the balance payment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let built: BuildBalancePaymentResult & { txHash: string };
  try {
    built = await buildBalancePaymentTransaction(
      {
        sourceAddress: booking.clientWalletAddress,
        destinationAddress: providerAddress,
        assetCode: usdc.code,
        assetIssuer: usdc.issuer,
        amount: booking.balanceAmount,
      },
      deps,
    );
  } catch (error) {
    if (error instanceof TypeError) {
      // A data-integrity failure (a malformed amount) -- retrying against
      // the network would never help, so this is never disguised as one.
      throw error;
    }
    throw new PaymentUnavailableError(
      `Could not reach the Stellar network to build the balance payment: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await setBalancePaymentBuiltHash(db, bookingId, built.txHash);
  return { unsignedXdr: built.unsignedXdr };
}

export interface SubmitBalancePaymentResult {
  txHash: string;
}

/**
 * `POST /bookings/:id/balance/submit`: re-validates every one of
 * {@link buildBalancePayment}'s own preconditions ({@link requireBalancePayable}
 * -- state can move between build and submit) and that a built hash even
 * exists, then relays the client's signed envelope, but only once its own
 * computed hash matches that stored `balancePaymentBuiltHash` (refused,
 * typed {@link XdrMismatchError}, otherwise -- the same submit-binding rule
 * 3.4's escrow submit already enforces). Unlike the escrow submit, this
 * polls all the way to a confirmed ledger result itself (`payments/
 * stellar.ts`'s `submitBalancePaymentTransaction`) and only then writes
 * `balance_state` to `"paid_platform"` (and clears the now-spent
 * `balancePaymentBuiltHash`, so a stale envelope can never be relayed again)
 * -- there is no reconciler for this payment (AD-3: it never touches
 * Trustless Work), so this call's own confirmed result is the evidence, not
 * a later background process's. A `FAILED` ledger result or an
 * unreachable/timed-out RPC surfaces as {@link PaymentFailedError}/
 * {@link PaymentUnavailableError} (`payments/errors.ts`) for the route to
 * map to `502`/`503`; `balance_state` stays `"unpaid"` either way.
 *
 * Review follow-up: once the payment has actually landed on chain,
 * {@link markBalancePaidPlatform}'s own guarded write is never assumed to
 * have succeeded -- a `false` (the booking's `balanceState` moved on
 * between the re-check above and this write, e.g. a concurrent cash mark)
 * is logged with the booking id and the landed `txHash`, and surfaced as a
 * typed {@link BalanceAlreadySettledError} rather than a silent `200`.
 */
export async function submitBalancePayment(
  db: Db,
  bookingId: string,
  clientWalletAddress: string,
  signedXdr: string,
  deps: SubmitPaymentDeps = {},
  now: number = Math.floor(Date.now() / 1000),
): Promise<SubmitBalancePaymentResult> {
  const booking = await getBookingForClient(db, bookingId, clientWalletAddress);
  await requireBalancePayable(db, booking, now, "pay it");
  if (!booking.balancePaymentBuiltHash) {
    throw new BookingEscrowStateError(`Booking "${bookingId}" has no built balance payment to submit; call buildBalancePayment first`);
  }
  const hash = computeSignedTransactionHash(signedXdr);
  if (booking.balancePaymentBuiltHash.toLowerCase() !== hash) {
    throw new XdrMismatchError();
  }
  const result = await submitBalancePaymentTransaction(signedXdr, deps);
  const recorded = await markBalancePaidPlatform(db, bookingId, result.txHash);
  if (!recorded) {
    console.error(
      `[balance-payment] booking ${bookingId} confirmed on chain (tx ${result.txHash}) but could not be recorded -- ` +
        "balance_state was no longer \"unpaid\" by the time the write ran",
    );
    throw new BalanceAlreadySettledError(bookingId, result.txHash);
  }
  return result;
}

/**
 * `POST /bookings/:id/balance/mark-cash`: the provider's own record that the
 * balance was paid in person -- refused (typed {@link BookingNotFoundError})
 * for anyone but this booking's own provider; refused (typed
 * {@link BookingEscrowStateError}) unless `escrowState` is `"locked"` or
 * `"released"` (a cash payment can be recorded any time after the deposit
 * locked, including after release -- only a `"refunded"` booking, or one
 * never locked at all, refuses); refused (typed {@link NothingToPayError})
 * for a zero balance, same as {@link buildBalancePayment}. Never checks the
 * appointment's own start time (unlike the platform-payment path) -- a
 * provider can still record a cash payment collected at, or just after, the
 * session itself.
 *
 * The write itself ({@link markBalancePaidCashIfUnpaid}) is guarded in SQL
 * on `balance_state` still being `"unpaid"` at the moment it runs (review
 * follow-up: this used to write unconditionally, which could clobber a
 * platform payment that had just confirmed) and clears
 * `balancePaymentBuiltHash` in the same write, so a client cannot then
 * relay a previously-built platform-payment envelope to pay the same
 * balance a second time. A lost race re-reads the booking's current
 * `balanceState` and refuses with it named, rather than reporting a silent
 * success.
 */
export async function markBalancePaidCash(db: Db, bookingId: string, providerWalletAddress: string): Promise<void> {
  const booking = await getBookingForProvider(db, bookingId, providerWalletAddress);
  if (booking.escrowState !== "locked" && booking.escrowState !== "released") {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be locked or released to mark its balance paid in cash (escrowState is "${booking.escrowState}")`,
    );
  }
  if (booking.balanceState !== "unpaid") {
    throw new BookingEscrowStateError(`Booking "${bookingId}" balance is already "${booking.balanceState}"; cannot mark it paid in cash again`);
  }
  if (booking.balanceAmount === "0") {
    throw new NothingToPayError();
  }
  const recorded = await markBalancePaidCashIfUnpaid(db, bookingId);
  if (!recorded) {
    const current = await getBookingById(db, bookingId);
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" balance is already "${current?.balanceState ?? "unknown"}"; cannot mark it paid in cash again`,
    );
  }
}

/**
 * `POST /bookings/:id/arrived`: the shop marks when a client walks in for a
 * locked booking. Refused (typed {@link BookingNotFoundError}) for anyone
 * but this booking's own provider; refused (typed
 * {@link BookingEscrowStateError}) unless `escrowState` is `"locked"` (cannot
 * mark arrived for a booking that hasn't locked yet, or one already
 * released/refunded). Refused when the appointment hasn't started yet
 * (slotStartsAt is in the future). The write itself ({@link markBookingArrived})
 * keeps the first timestamp if called twice.
 */
export async function markArrived(db: Db, bookingId: string, providerWalletAddress: string, now: number): Promise<void> {
  const booking = await getBookingForProvider(db, bookingId, providerWalletAddress);
  if (booking.escrowState !== "locked") {
    throw new BookingEscrowStateError(
      `Booking "${bookingId}" must be locked to mark arrived (escrowState is "${booking.escrowState}")`,
    );
  }
  
  // Get the slot to check start time
  const slot = booking.slotId ? await getSlotById(db, booking.slotId) : null;
  if (!slot) {
    throw new BookingEscrowStateError(`Booking "${bookingId}" has no slot to determine start time`);
  }
  
  if (slot.startsAt > now) {
    throw new BookingEscrowStateError(`Cannot mark arrived before appointment start (starts at ${slot.startsAt}, now is ${now})`);
  }
  
  await markBookingArrived(db, bookingId, now);
}

// ---------------------------------------------------------------------------
// Story 3.4: the owner check every booking route shares, `submit`, the
// booking read view, and the hold-expiry runner tick.
// ---------------------------------------------------------------------------

/**
 * The one place `lock`/`fund`/`submit`/`GET /bookings/:id` all resolve
 * "does this booking exist, and does the caller's own wallet own it" --
 * both a missing booking and an owner mismatch throw the identical
 * {@link BookingNotFoundError}, so a caller can never learn which one it
 * was (the spec's own "Always" rule: "bookings are not enumerable").
 */
export async function getBookingForClient(db: Db, bookingId: string, walletAddress: string): Promise<BookingRow> {
  const booking = await getBookingById(db, bookingId);
  if (!booking || booking.clientWalletAddress !== walletAddress) {
    throw new BookingNotFoundError();
  }
  return booking;
}

/**
 * Issue #119: a client gives back their own unlocked hold
 * (`DELETE /bookings/:id/hold`). The hold row is removed, so the slot is
 * offered again at once.
 *
 * - Another client's hold (or an unknown id): {@link BookingNotFoundError},
 *   same as every other ownership check, so bookings are not enumerable.
 * - A locked booking (`escrowState` set) or one whose deploy was already
 *   submitted: {@link BookingEscrowStateError}. A locked cancellation follows
 *   the frozen terms, never this path.
 * - A hold whose window already passed: {@link BookingHoldExpiredError}. The
 *   slot is already free and nothing is changed.
 */
export async function cancelHold(
  db: Db,
  bookingId: string,
  walletAddress: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const booking = await getBookingForClient(db, bookingId, walletAddress);
  if (booking.escrowState !== null || booking.deploySubmittedAt !== null) {
    throw new BookingEscrowStateError("This booking is already locked. A locked booking can't be cancelled as a hold.");
  }
  if (booking.holdExpiresAt !== null && booking.holdExpiresAt < now) {
    throw new BookingHoldExpiredError();
  }
  const removed = await deleteUnlockedHold(db, bookingId, walletAddress, now);
  if (!removed) {
    // The booking changed between the read above and the delete.
    throw new BookingEscrowStateError("This booking changed while cancelling. Reload and try again.");
  }
}

/**
 * Story 3.6: the provider-side sibling of {@link getBookingForClient} --
 * `complete`/`release` are provider-only actions, so a booking whose own
 * provider profile does not resolve to the caller's wallet is refused the
 * identical {@link BookingNotFoundError} every other ownership check in this
 * file gives (never revealing whether the booking exists at all).
 */
export async function getBookingForProvider(db: Db, bookingId: string, providerWalletAddress: string): Promise<BookingRow> {
  const booking = await getBookingById(db, bookingId);
  if (!booking) {
    throw new BookingNotFoundError();
  }
  const providerAddress = await requireProviderAddress(db, booking);
  if (providerAddress !== providerWalletAddress) {
    throw new BookingNotFoundError();
  }
  return booking;
}

/**
 * Story 3.6: `dispute` may be opened by either side (the client, as
 * approver, or the provider) -- this resolves "does this wallet own either
 * role on this booking", returning which one it is so the caller can pass
 * the right `signerAddress` to the adapter. Anyone else gets the same
 * {@link BookingNotFoundError} every other ownership check gives.
 */
export async function getBookingForClientOrProvider(
  db: Db,
  bookingId: string,
  walletAddress: string,
): Promise<{ booking: BookingRow; role: "client" | "provider" }> {
  const booking = await getBookingById(db, bookingId);
  if (!booking) {
    throw new BookingNotFoundError();
  }
  if (booking.clientWalletAddress === walletAddress) {
    return { booking, role: "client" };
  }
  const providerAddress = await requireProviderAddress(db, booking);
  if (providerAddress === walletAddress) {
    return { booking, role: "provider" };
  }
  throw new BookingNotFoundError();
}

/**
 * Story 3.6 (review round): which of the five Story 3.6 actions this
 * booking has a signed transaction already relayed for, but whose own
 * chain-derived lifecycle has not yet moved past it -- `null` when no
 * action is pending. Checked in this priority order (dispute first: it can
 * be raised from any state, so a pending dispute matters more than whatever
 * else was also mid-flight): `dispute` (submitted, lifecycle not yet
 * `"disputed"`), `resolve` (submitted, lifecycle still `"disputed"`),
 * `release` (submitted, lifecycle still `"approved"`), `approve` (submitted,
 * lifecycle still `"funded"`/`"completed"`), `complete` (submitted,
 * lifecycle still `"funded"`). Shared by `getBookingView` and the two list
 * builders below so the three routes can never derive a different answer
 * for the same booking.
 */
function derivePendingAction(booking: BookingRow, lifecycleAction: EscrowLifecycleAction | undefined): EscrowActionKind | null {
  if (booking.escrowDisputeSubmittedAt !== null && lifecycleAction !== "disputed") return "dispute";
  if (booking.escrowResolveSubmittedAt !== null && lifecycleAction === "disputed") return "resolve";
  if (booking.escrowReleaseSubmittedAt !== null && lifecycleAction === "approved") return "release";
  if (booking.escrowApproveSubmittedAt !== null && (lifecycleAction === "funded" || lifecycleAction === "completed")) return "approve";
  if (booking.escrowCompleteSubmittedAt !== null && lifecycleAction === "funded") return "complete";
  return null;
}

export interface BookingView {
  id: string;
  escrowState: BookingRow["escrowState"];
  /** The finer lifecycle label Epic 3's UI needs (Story 2.6's
   * `getEscrowLifecycle`) -- `undefined` fields when nothing has been
   * recorded yet. */
  lifecycle: { contractId?: string; action?: string; outcome?: DisputeOutcome };
  /** Story 3.6 (review round): see {@link derivePendingAction}. */
  pendingAction: EscrowActionKind | null;
  holdExpiresAt: number | null;
  /** UTC epoch seconds when the shop declined this hold, `null` otherwise. */
  declinedAt: number | null;
  contractId: string | null;
  /** Issue #5: one of the two facts the status panel now shows separately --
   * Pactly's own recorded evidence that a signed deploy for this booking
   * was relayed (`deploySubmittedAt` is set by `recordDeploySubmission`,
   * which only ever runs on a successful relay). Deliberately *not* the
   * same thing as "funded": that stays the reconciler's own answer, read
   * back from `escrowState` above (AD-1) -- a deploy Pactly relayed proves
   * the escrow was created, never that money moved into it. */
  deploySubmitted: boolean;
  /** Issue #7: every contract id a deploy ever returned for this booking,
   * oldest first, with the one the booking currently settles against marked
   * -- so a contract a retry lost track of stays openable in the escrow
   * viewer instead of vanishing. `[]` for a booking that has never deployed
   * (and for a pre-#7 booking that deployed before any history was kept),
   * which the panel renders as nothing at all. Read-only: no settlement
   * call takes an id from here. */
  contractHistory: { contractId: string; active: boolean }[];
  deposit: Money;
  balance: Money;
  price: Money;
  slotStartsAt: number | null;
  disputeDeadline: number | null;
  cancelDeadline: number;
  /** UTC epoch seconds -- the server clock at response time. Resynced on
   * every refetch so the client's free-cancellation countdown stays
   * aligned with the clock that will actually accept or refuse a cancel. */
  serverTime: number;
  provider: BookingProviderSummary;
  /** Story 3.7: the on-chain transaction hash once the balance was paid
   * through Pactly (`null` otherwise -- unpaid, or paid in cash, which has
   * no transaction to point at). Drives the balance row's own Stellar
   * Expert link, per the spec's own "Always" rule. */
  balancePaymentTxHash: string | null;
  /** The anchor's own transaction id for the local-currency (SEP-6)
   * deposit that funds this booking, `null` when none was started. Lets
   * support tie a failed or partial deposit back to the booking. Shown to
   * the booking's client and shop only -- never on the public profile or
   * proof page. */
  anchorTransactionId: string | null;
  /** Story 3.8: the client's private note on this booking (visible to the
   * shop and the client on the booking detail page, never on the public
   * profile or discovery). */
  note: string | null;
  /** Set only when the shop closed this date and released this unpaid
   * hold early (`shop-closed-date`); `null` for a plain expiry or a locked
   * booking. Drives the client's "the shop closed this date, no deposit was
   * taken" copy. */
  holdReleasedReason: BookingRow["holdReleaseReason"];
  /** Issue #35: true when this read triggered showing a reminder (appointment
   * day-before notice). False when already shown or conditions not met. */
  reminderShown: boolean;
  /** Issue #158: the address stored for this booking's shop -- the escrow's
   * own receiver, shown (and copyable) on the booking for both sides.
   * `null` only when the shop's profile cannot be found. */
  receivingAddress: string | null;
}

/** `GET /bookings/:id`'s own response shape: the booking's amounts (each
 * derived the same way `holdSlot` derived them, from the persisted
 * `depositAmount`/`balanceAmount` -- never recomputed from the current
 * provider profile, which could have changed its rules since), its
 * chain-derived lifecycle, and a small provider summary. The UI is told
 * `locked` only from here (`escrowState`), never from a submit response
 * (spec's own "Always" rule).
 *
 * Issue #35: checks if a reminder should be shown and marks it. A reminder
 * shows when the appointment is locked, within 24h, and not yet shown. */
export async function getBookingView(
  db: Db,
  bookingId: string,
  walletAddress: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<BookingView> {
  const booking = await getBookingForClient(db, bookingId, walletAddress);
  const profile = await getProviderProfileById(db, booking.providerProfileId);
  const lifecycle = (await getEscrowLifecycle(db, bookingId)) ?? {};
  const slot = booking.slotId ? await getSlotById(db, booking.slotId) : undefined;
  const slotStartsAt = slot?.startsAt ?? null;

  // Issue #35: check and mark reminder
  let reminderShown = false;
  const isLocked = booking.escrowState === "locked";
  const hasSlot = slotStartsAt !== null;
  const within24h = hasSlot && slotStartsAt - now <= 24 * 60 * 60 && slotStartsAt - now > 0;
  // `outcome` is only ever set once a dispute has been resolved (either
  // side may have won), so any outcome means this booking is no longer a
  // reminder candidate.
  const notCancelled = lifecycle.outcome === undefined;
  const notDisputed = lifecycle.action !== "disputed";

  if (isLocked && within24h && notCancelled && notDisputed) {
    // Client is reading, check client reminder
    if (booking.clientReminderShownAt === null) {
      await markClientReminderShown(db, bookingId, now);
      reminderShown = true;
    }
  }

  // Issue #44: include the dispute opener wallet when a dispute is open
  let disputeOpenedByWallet: string | null = null;
  if (lifecycle.action === "disputed") {
    const opening = await getEscrowDisputeOpening(db, bookingId);
    if (opening && opening.contractId === booking.escrowContractId) {
      disputeOpenedByWallet = opening.openedByWallet;
    }
  }

  return {
    id: booking.id,
    escrowState: booking.escrowState,
    lifecycle: { contractId: lifecycle.contractId, action: lifecycle.action, outcome: lifecycle.outcome },
    pendingAction: derivePendingAction(booking, lifecycle.action),
    holdExpiresAt: booking.holdExpiresAt,
    declinedAt: booking.declinedAt,
    contractId: booking.escrowContractId,
    deploySubmitted: booking.deploySubmittedAt !== null,
    contractHistory: (await listContractDeployments(db, booking.id)).map((row) => ({
      contractId: row.contractId,
      active: row.contractId === booking.escrowContractId,
    })),
    deposit: { amount: booking.depositAmount, asset: ASSET },
    balance: { amount: booking.balanceAmount, asset: ASSET },
    price: { amount: (BigInt(booking.depositAmount) + BigInt(booking.balanceAmount)).toString(), asset: ASSET },
    slotStartsAt,
    disputeDeadline: getDisputeDeadline(slotStartsAt),
    cancelDeadline: booking.cancelDeadline,
    serverTime: now,
    provider: profile
      ? { id: profile.id, displayName: profile.displayName, title: profile.title }
      : { id: booking.providerProfileId, displayName: "", title: "" },
    balancePaymentTxHash: booking.balancePaymentTxHash,
    anchorTransactionId: booking.anchorDepositId,
    note: booking.note,
    holdReleasedReason: booking.holdReleaseReason,
    reminderShown,
    receivingAddress: profile?.walletAddress ?? null,
    disputeOpenedByWallet,
  };
}

/** Decodes a signed transaction envelope and returns its hash as lowercase
 * hex -- signing a transaction never changes the hash used to verify it
 * (the hash covers the signature payload, not the signatures themselves),
 * so this is exactly comparable to the `txHash` Trustless Work returned
 * when it built the corresponding *unsigned* XDR. Throws
 * {@link XdrMismatchError} for anything that does not decode as a
 * transaction at all, rather than let a raw stellar-sdk parse error escape. */
function computeSignedTransactionHash(signedXdr: string): string {
  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, config.stellarNetworkPassphrase);
    // `Transaction.hash()` returns a `Uint8Array`, not a Node `Buffer` --
    // wrap it to get `.toString("hex")`.
    return Buffer.from(tx.hash()).toString("hex").toLowerCase();
  } catch {
    throw new XdrMismatchError();
  }
}

/**
 * Story 3.6 (review round): who is submitting -- resolved once, here, from
 * the booking and Pactly's own admin config, so both the route and
 * {@link submitSignedTransaction} agree on it without re-deriving it twice.
 * `"resolver"` is a global role (Pactly's own dispute-resolver wallet,
 * `config.adminWallets` intersected with `config.trustlessWorkPlatformAddress`)
 * -- unlike `"client"`/`"provider"`, it is not itself a role *on this
 * booking*, so it is checked last, after ownership. A wallet holding none
 * of the three gets the same {@link BookingNotFoundError} every other
 * ownership check in this file gives.
 */
export type SubmitRole = "client" | "provider" | "resolver";

export async function resolveSubmitRole(db: Db, bookingId: string, walletAddress: string): Promise<{ booking: BookingRow; role: SubmitRole }> {
  const booking = await getBookingById(db, bookingId);
  if (!booking) {
    throw new BookingNotFoundError();
  }
  if (booking.clientWalletAddress === walletAddress) {
    return { booking, role: "client" };
  }
  const providerAddress = await requireProviderAddress(db, booking);
  if (providerAddress === walletAddress) {
    return { booking, role: "provider" };
  }
  if (config.adminWallets.includes(walletAddress) && walletAddress === config.trustlessWorkPlatformAddress) {
    return { booking, role: "resolver" };
  }
  throw new BookingNotFoundError();
}

/** Story 3.6: every action past deploy/fund that stores its own `txHash` on
 * the booking row (see `db/bookings.ts`'s `EscrowActionKind`/
 * `setEscrowActionTxHash`) -- named here alongside `deploy`/`fund` so
 * {@link submitSignedTransaction} can match a signed envelope against every
 * hash Pactly has ever built for this booking, from one row, in one place. */
type CandidateActionKind = "deploy" | "fund" | EscrowActionKind;

function candidateActionHashes(booking: BookingRow): ReadonlyArray<{ kind: CandidateActionKind; hash: string | null }> {
  return [
    { kind: "deploy", hash: booking.escrowDeployTxHash },
    { kind: "fund", hash: booking.escrowFundTxHash },
    { kind: "complete", hash: booking.escrowCompleteTxHash },
    { kind: "approve", hash: booking.escrowApproveTxHash },
    { kind: "release", hash: booking.escrowReleaseTxHash },
    { kind: "dispute", hash: booking.escrowDisputeTxHash },
    { kind: "resolve", hash: booking.escrowResolveTxHash },
  ];
}

/**
 * Story 3.6 (review round): which action kinds each {@link SubmitRole} may
 * ever relay -- the client signs deploy/fund/approve (and a dispute, but
 * only the one *it itself* built: see the `"dispute"` special case below);
 * the provider signs complete/release (and, symmetrically, its own
 * dispute); the resolver signs only resolve. Never `"deploy"`/`"fund"` for
 * anyone but the client, never `"complete"`/`"release"` for anyone but the
 * provider, never `"resolve"` for anyone but the resolver.
 */
const ROLE_ALLOWED_KINDS: Record<SubmitRole, ReadonlySet<CandidateActionKind>> = {
  client: new Set<CandidateActionKind>(["deploy", "fund", "approve"]),
  provider: new Set<CandidateActionKind>(["complete", "release"]),
  resolver: new Set<CandidateActionKind>(["resolve"]),
};

/** A dispute's own hash may only be relayed by whichever role actually
 * built it (`booking.pendingDisputeOpenerRole`) -- a client cannot relay a
 * dispute the provider opened, and vice versa, even though both roles may
 * open *some* dispute. */
function isKindAllowedForRole(kind: CandidateActionKind, role: SubmitRole, booking: BookingRow): boolean {
  if (kind === "dispute") {
    return (role === "client" || role === "provider") && booking.pendingDisputeOpenerRole === role;
  }
  return ROLE_ALLOWED_KINDS[role].has(kind);
}

/**
 * Relays a signed transaction to Trustless Work, over the adapter's own
 * `submit` -- but only once this booking's own records confirm both that
 * the signed envelope actually is one Pactly built for it, *and* that the
 * caller's own resolved {@link SubmitRole} is the role that XDR was built
 * for (review round: previously client-only, which 404'd every provider
 * complete/release/dispute and every admin resolve). This decodes the
 * envelope, computes its own hash, and requires that hash to equal one of
 * the booking's own stored action hashes for a kind {@link isKindAllowedForRole}
 * grants this role; anything else is refused (typed {@link XdrMismatchError})
 * before the adapter is ever called.
 *
 * Never checks the hold's expiry (the spec's own "Never" rule: "Submit is
 * allowed after expiry, because a transaction the client already signed
 * must still land and be reconciled") -- and never itself writes
 * `escrow_state` (AD-1); the reconciler is still the only writer, once it
 * reads this transaction's evidence back out of Trustless Work's own read
 * model.
 *
 * On a deploy match, once the adapter accepts it, this records
 * `deploySubmittedAt` and extends the hold to ten minutes from now (a
 * write-once, best-effort record -- see {@link recordDeploySubmission}'s
 * own doc comment for why a race or a resubmit never turns into an error
 * here). On a dispute match, this is the one place `escrow_dispute_openings`
 * is ever written (review round: no longer at build time -- see
 * `openDispute`'s own doc comment): `suggestedOutcome` is computed fresh
 * against *this* call's own clock, never a possibly-stale build-time one.
 * On complete/approve/release/resolve, this records that action's own
 * `submittedAt` so a fresh build of the same action is refused
 * (`409 ACTION_PENDING`) until the reconciler observes it.
 */
export async function submitSignedTransaction(
  db: Db,
  bookingId: string,
  signedXdr: string,
  role: SubmitRole,
  adapter: EscrowAdapter = defaultEscrowAdapter,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SubmitTransactionResult> {
  const booking = await requireBooking(db, bookingId);
  requireHoldNotDeclined(booking);
  const hash = computeSignedTransactionHash(signedXdr);

  const match = candidateActionHashes(booking).find(
    (candidate) => candidate.hash !== null && candidate.hash.toLowerCase() === hash && isKindAllowedForRole(candidate.kind, role, booking),
  );
  if (!match) {
    throw new XdrMismatchError();
  }

  if (match.kind === "dispute") {
    if (!booking.pendingDisputeReason) {
      throw new BookingEscrowStateError("This dispute has no recorded reason.");
    }
    await requireDisputeWindowOpen(db, booking, booking.pendingDisputeReason, now);
  }

  const result = await adapter.submit(signedXdr);

  if (match.kind === "deploy" && booking.escrowContractId && booking.escrowDeployTxHash) {
    await recordDeploySubmission(db, bookingId, booking.escrowContractId, booking.escrowDeployTxHash, now + HOLD_DURATION_SECONDS, now);
  } else if (match.kind === "dispute") {
    if (booking.escrowContractId && booking.pendingDisputeReason && booking.pendingDisputeOpenerWallet && booking.pendingDisputeOpenerRole) {
      const suggestedOutcome = computeSuggestedOutcome(booking.pendingDisputeReason, booking, now);
      await recordEscrowDisputeOpening(db, {
        bookingId,
        contractId: booking.escrowContractId,
        openedByWallet: booking.pendingDisputeOpenerWallet,
        openedByRole: booking.pendingDisputeOpenerRole,
        reason: booking.pendingDisputeReason,
        suggestedOutcome,
        txHash: hash,
        openedAt: now,
      });
      // Issue #2: the provider's cancellation counter moves only when the
      // provider is the cancelling party -- the reason the dispute was opened
      // under is what names that, never who pressed the button (either side
      // may report a provider cancellation). The booking-level marker makes
      // this once-only. A client cancel, a no-show, a plain disagreement and
      // every refund/release path leave it untouched.
      if (booking.pendingDisputeReason === "provider-cancel") {
        db.transaction((tx) => {
          recordProviderCancellationCountedSync(tx, bookingId, booking.providerProfileId, now);
        });
      }
    }
    await setEscrowActionSubmittedAt(db, bookingId, "dispute", now);
  } else if (match.kind === "complete" || match.kind === "approve" || match.kind === "release" || match.kind === "resolve") {
    await setEscrowActionSubmittedAt(db, bookingId, match.kind, now);
  }

  return result;
}

/**
 * Story 3.4's hold-expiry runner tick: a read-only sweep that logs two
 * kinds of double-sale risk (never writes anything; the actual freeing of
 * a slot happens implicitly, at the next `holdSlot` call's own atomic
 * insert):
 *
 * 1. The spec's own Design Notes case: an expired hold whose deploy is
 *    still in flight (`escrowContractId` set, `escrowState` still `null`)
 *    on a slot some other active booking has since re-held.
 * 2. Review follow-up, a safety net: two distinct bookings sharing one
 *    slot where at least one already has a non-null, non-refunded
 *    `escrow_state` and the other is also locked/released/refunded or
 *    still an actively-held pending hold -- something
 *    {@link insertBookingHoldIfSlotFree}'s own atomic guarantee should
 *    make impossible, logged if it is ever seen anyway. Each unordered
 *    `(slotId, bookingA, bookingB)` pair is logged at most once per process
 *    (an in-memory set -- restarting the process re-arms it, which is fine
 *    for a log line, not a correctness mechanism).
 */
const loggedConflictPairs = new Set<string>();

export function expireHolds(db: Db, now: number = Math.floor(Date.now() / 1000), log: (message: string) => void = console.error): number {
  const potentialDoubleSales = listPotentialDoubleSales(db, now);
  for (const risk of potentialDoubleSales) {
    log(
      `[hold-expiry] anomaly: booking ${risk.bookingId}'s hold expired with escrow ${risk.contractId} still unconfirmed, ` +
        `and slot ${risk.slotId} has since been re-held by another booking -- watch for a double-sale if ${risk.contractId} funds`,
    );
  }

  let newlyLoggedConflicts = 0;
  for (const pair of listConflictingSlotBookings(db, now)) {
    const key = [pair.slotId, ...[pair.bookingIdA, pair.bookingIdB].sort()].join("|");
    if (loggedConflictPairs.has(key)) continue;
    loggedConflictPairs.add(key);
    newlyLoggedConflicts += 1;
    log(
      `[hold-expiry] anomaly: slot ${pair.slotId} has conflicting bookings ${pair.bookingIdA} and ${pair.bookingIdB}, ` +
        "both locked/released or actively held -- this should be impossible; investigate a possible double-sale",
    );
  }

  return potentialDoubleSales.length + newlyLoggedConflicts;
}

// ---------------------------------------------------------------------------
// Story 3.5: the two-sided status panel's own list reads
// (`GET /me/bookings`, `GET /me/provider/bookings`). Both share the same
// per-item shape and appointment-date sort (the spec's own "Always" rule);
// only the "whose summary" field differs -- a provider summary for the
// client's own list, the client wallet for the provider's own list.
// ---------------------------------------------------------------------------

export interface BookingListItemBase {
  id: string;
  /** UTC epoch seconds -- `null` only for a pre-3.4 booking with no
   * `slotId`. */
  slotStartsAt: number | null;
  disputeDeadline: number | null;
  deposit: Money;
  balance: Money;
  price: Money;
  escrowState: BookingRow["escrowState"];
  lifecycle: { contractId?: string; action?: string; outcome?: DisputeOutcome };
  /** Story 3.6 (review round): see `derivePendingAction`'s own doc comment. */
  pendingAction: EscrowActionKind | null;
  balanceState: BalanceState;
  /** Story 3.7: the on-chain transaction hash once the balance was paid
   * through Pactly (`null` for unpaid or paid-in-cash). */
  balancePaymentTxHash: string | null;
  /** The anchor's own transaction id for the local-currency (SEP-6)
   * deposit that funds this booking, `null` when none was started. Lets
   * support tie a failed or partial deposit back to the booking. Shown to
   * the booking's client and shop only -- never on the public profile or
   * proof page. */
  anchorTransactionId: string | null;
  cancelDeadline: number;
  /** UTC epoch seconds -- the server clock at response time. */
  serverTime: number;
  contractId: string | null;
  holdExpiresAt: number | null;
  /** Set when a shop's close-date action released this unpaid hold early;
   * the client's card says so instead of showing a bare expiry. */
  holdReleasedReason: BookingRow["holdReleaseReason"];
  /** The AD-13 hold's own 10-minute window has passed with `escrowState`
   * still `null` -- the spec's own "Always" rule: "An expired, never-funded
   * hold is listed under 'Expired holds' (collapsed), never as a booking."
   * The frontend groups on this flag; the row itself is never dropped here
   * (Story 3.4's own double-sale note: an expired hold's escrow may still
   * reconcile later, so it must stay traceable from this list too). */
  isExpiredHold: boolean;
  /** UTC epoch seconds -- when the provider marked the client as arrived,
   * `null` until marked. */
  arrivedAt: number | null;
  /** Issue #158: the address stored for this booking's shop, which is what
   * the escrow releases to. `null` only when the shop's profile is gone. */
  receivingAddress: string | null;
}

export interface ClientBookingListItem extends BookingListItemBase {
  provider: BookingProviderSummary;
}

export interface ProviderBookingListItem extends BookingListItemBase {
  /** The full wallet address -- shortened only at render time (the
   * frontend's own `shortenStellarId`, the same helper `EscrowProof` already
   * uses), never truncated here (this backend never invents a display
   * format; see `lib/money.ts`'s own equivalent discipline for amounts). */
  clientWalletAddress: string;
  /** Optional client contact email for the shop's post-release mailto draft. */
  clientEmail: string | null;
}

function isExpiredHoldRow(booking: BookingRow, now: number): boolean {
  return (
    booking.escrowState === null
    && booking.escrowContractId === null
    && booking.declinedAt === null
    && booking.holdExpiresAt !== null
    && booking.holdExpiresAt < now
  );
}

/** Upcoming appointments first, soonest first; then past ones, most recent
 * first -- the spec's own "Always" sort rule, shared by both lists. A
 * booking with no slot (a pre-3.4 row with no `slotId`) sorts after every
 * dated one, in whatever order it was read in among themselves. */
function compareByAppointmentDate(a: { slotStartsAt: number | null }, b: { slotStartsAt: number | null }, now: number): number {
  if (a.slotStartsAt === null && b.slotStartsAt === null) return 0;
  if (a.slotStartsAt === null) return 1;
  if (b.slotStartsAt === null) return -1;
  const aUpcoming = a.slotStartsAt >= now;
  const bUpcoming = b.slotStartsAt >= now;
  if (aUpcoming !== bUpcoming) return aUpcoming ? -1 : 1;
  return aUpcoming ? a.slotStartsAt - b.slotStartsAt : b.slotStartsAt - a.slotStartsAt;
}

function toBookingListItemBase(
  booking: BookingRow,
  slotStartsAt: number | null,
  lifecycle: EscrowLifecycle | undefined,
  now: number,
  reminderShown: boolean = false,
): BookingListItemBase {
  return {
    id: booking.id,
    slotStartsAt,
    disputeDeadline: getDisputeDeadline(slotStartsAt),
    deposit: { amount: booking.depositAmount, asset: ASSET },
    balance: { amount: booking.balanceAmount, asset: ASSET },
    price: { amount: (BigInt(booking.depositAmount) + BigInt(booking.balanceAmount)).toString(), asset: ASSET },
    escrowState: booking.escrowState,
    lifecycle: { contractId: lifecycle?.contractId, action: lifecycle?.action, outcome: lifecycle?.outcome },
    pendingAction: derivePendingAction(booking, lifecycle?.action),
    balanceState: booking.balanceState,
    balancePaymentTxHash: booking.balancePaymentTxHash,
    anchorTransactionId: booking.anchorDepositId,
    cancelDeadline: booking.cancelDeadline,
    serverTime: now,
    contractId: booking.escrowContractId,
    holdExpiresAt: booking.holdExpiresAt,
    holdReleasedReason: booking.holdReleaseReason,
    isExpiredHold: isExpiredHoldRow(booking, now),
    arrivedAt: booking.arrivedAt,
  };
}

/**
 * `GET /me/bookings`: every booking the caller's own wallet is the client
 * on, across every provider (the spec's own "Always" rule), ordered by
 * appointment date. Isolation rests entirely on
 * {@link listBookingRowsForClient}'s own `WHERE client_wallet_address = ?`
 * -- this function never filters by anything else, so another wallet's rows
 * can never leak in here.
 * 
 * Issue #35: checks and marks client reminders for qualifying bookings.
 */
export async function listBookingsForClient(
  db: Db,
  clientWalletAddress: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ClientBookingListItem[]> {
  const rows = await listBookingRowsForClient(db, clientWalletAddress);
  if (rows.length === 0) return [];

  const lifecycleByBooking = await getEscrowLifecycleForBookings(
    db,
    rows.map((row) => row.booking),
  );
  const reviewByBooking = await getReviewsForBookings(
    db,
    rows.map((row) => row.booking.id),
  );
  const providerIds = [...new Set(rows.map((row) => row.booking.providerProfileId))];
  const profiles = await Promise.all(providerIds.map((id) => getProviderProfileById(db, id)));
  const profileById = new Map(profiles.filter((profile): profile is NonNullable<typeof profile> => Boolean(profile)).map((profile) => [profile.id, profile]));

  // Issue #35: check and mark client reminders
  const remindersShown = new Set<string>();
  for (const { booking, slotStartsAt } of rows) {
    const lifecycle = lifecycleByBooking.get(booking.id);
    const isLocked = booking.escrowState === "locked";
    const hasSlot = slotStartsAt !== null;
    const within24h = hasSlot && slotStartsAt - now <= 24 * 60 * 60 && slotStartsAt - now > 0;
    const notCancelled = lifecycle?.outcome === undefined;
    const notDisputed = lifecycle?.action !== "disputed";

    if (isLocked && within24h && notCancelled && notDisputed && booking.clientReminderShownAt === null) {
      await markClientReminderShown(db, booking.id, now);
      remindersShown.add(booking.id);
    }
  }

  const items: ClientBookingListItem[] = rows.map(({ booking, slotStartsAt }) => {
    const profile = profileById.get(booking.providerProfileId);
    return {
      ...toBookingListItemBase(booking, slotStartsAt, lifecycleByBooking.get(booking.id), now, remindersShown.has(booking.id)),
      provider: profile
        ? { id: profile.id, displayName: profile.displayName, title: profile.title }
        : { id: booking.providerProfileId, displayName: "", title: "" },
      receivingAddress: profile?.walletAddress ?? null,
    };
  });
  items.sort((a, b) => compareByAppointmentDate(a, b, now));
  return items;
}

/**
 * `GET /me/provider/bookings`: every booking against the caller's own
 * provider profile -- resolved from the caller's own wallet, never a
 * caller-supplied id (the same discipline every other `/me/provider` route
 * already follows), so another provider's bookings can never be requested
 * through this function at all. Refuses {@link NotAProviderError} for a
 * wallet with no provider profile.
 * 
 * Issue #35: checks and marks provider reminders for qualifying bookings.
 */
export async function listBookingsForProvider(
  db: Db,
  providerWalletAddress: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ProviderBookingListItem[]> {
  const profile = await getProviderProfileByWallet(db, providerWalletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
  const rows = await listBookingRowsForProvider(db, profile.id);
  if (rows.length === 0) return [];

  const lifecycleByBooking = await getEscrowLifecycleForBookings(
    db,
    rows.map((row) => row.booking),
  );

  // Issue #35: check and mark provider reminders
  const remindersShown = new Set<string>();
  for (const { booking, slotStartsAt } of rows) {
    const lifecycle = lifecycleByBooking.get(booking.id);
    const isLocked = booking.escrowState === "locked";
    const hasSlot = slotStartsAt !== null;
    const within24h = hasSlot && slotStartsAt - now <= 24 * 60 * 60 && slotStartsAt - now > 0;
    const notCancelled = lifecycle?.outcome === undefined;
    const notDisputed = lifecycle?.action !== "disputed";

    if (isLocked && within24h && notCancelled && notDisputed && booking.providerReminderShownAt === null) {
      await markProviderReminderShown(db, booking.id, now);
      remindersShown.add(booking.id);
    }
  }

  const items: ProviderBookingListItem[] = rows.map(({ booking, slotStartsAt }) => ({
    ...toBookingListItemBase(booking, slotStartsAt, lifecycleByBooking.get(booking.id), now, remindersShown.has(booking.id)),
    clientWalletAddress: booking.clientWalletAddress,
    clientEmail: booking.clientEmail ?? null,
    receivingAddress: profile.walletAddress,
  }));
  items.sort((a, b) => compareByAppointmentDate(a, b, now));
  return items;
}

export type SlotUnbookableReason = "past" | "too soon" | "buffered" | "held" | "closed" | "paused";

/**
 * Issue #141: Returns why a slot cannot be booked, or null if it is bookable.
 * Checked strictly in this order:
 * 1. "past": slotStartsAt <= now
 * 2. "too soon": within provider's minimumNoticeMinutes
 * 3. "buffered": inside the provider's buffer window after a locked booking
 * 4. "held": another active booking/hold already occupies the slot
 * 5. "closed": provider marked the date as closed
 * 6. "paused": provider has paused new bookings
 */
export async function getSlotUnbookableReason(
  db: Db,
  providerProfileId: string,
  slotStartsAt: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<SlotUnbookableReason | null> {
  const profile = await getProviderProfileById(db, providerProfileId);
  if (!profile) {
    throw new ProviderNotFoundError();
  }

  // 1. past
  if (slotStartsAt <= now) {
    return "past";
  }

  // 2. too soon
  if (profile.minimumNoticeMinutes && profile.minimumNoticeMinutes > 0) {
    const minStart = now + profile.minimumNoticeMinutes * 60;
    if (slotStartsAt < minStart) {
      return "too soon";
    }
  }

  // 3. buffered
  if (profile.bufferMinutes && profile.bufferMinutes > 0) {
    const lockedStarts = await listLockedBookingStarts(db, profile.id);
    const buffered = lockedStarts.some((lockedStartsAt) =>
      isSlotInsideBufferAfterLocked(
        slotStartsAt,
        lockedStartsAt,
        profile.sessionLengthMinutes,
        profile.bufferMinutes,
      ),
    );
    if (buffered) {
      return "buffered";
    }
  }

  // 4. held
  const slot = await getSlotByProviderAndStart(db, profile.id, slotStartsAt);
  if (slot) {
    const activeBookings = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.slotId, slot.id),
          or(
            and(isNotNull(bookings.escrowState), ne(bookings.escrowState, "refunded")),
            and(isNull(bookings.escrowState), gte(bookings.holdExpiresAt, now)),
          ),
        ),
      )
      .limit(1);
    if (activeBookings.length > 0) {
      return "held";
    }
  }

  // 5. closed
  if (await isDateClosed(db, profile.id, utcDateFor(slotStartsAt))) {
    return "closed";
  }

  // 6. paused
  if (profile.bookingsPaused) {
    return "paused";
  }

  return null;
}

