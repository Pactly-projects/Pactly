/**
 * The only place SQL touches the `bookings` table. `updateEscrowState` is
 * called from exactly one place in the whole codebase --
 * `../chain/event-worker.ts` -- which is what AD-1/AD-3 mean in practice:
 * nothing else may write `escrow_state`.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql } from "drizzle-orm";

import type { Db, DbOrTx } from "./client.js";
import {
  availabilitySlots,
  bookings,
  providerProfiles,
  type BalanceState,
  type DisputeOpenerRole,
  type DisputeReason,
  type EscrowState,
} from "./schema.js";

/** `escrow_state` values the reconciler must never move a booking past --
 * once here, a booking is excluded from every future reconciliation poll
 * (AC4's "for bookings whose escrow_state is not terminal"). */
export const TERMINAL_ESCROW_STATES: readonly EscrowState[] = ["released", "refunded"];

export interface NewBooking {
  id: string;
  providerProfileId: string;
  clientWalletAddress: string;
  /** Optional client contact email for post-release mailto drafts. */
  clientEmail?: string | null;
  tokenAddress: string;
  depositAmount: string;
  balanceAmount?: string;
  cancelDeadline: number;
  balanceState?: BalanceState;
  /** Story 3.4 (AD-13): the slot this booking holds. `undefined` only for a
   * pre-3.4 caller (existing tests) -- a real hold always sets this. */
  slotId?: string;
  /** Story 3.4 (AD-13): the hold's own expiry, UTC epoch seconds.
   * `undefined` only for a pre-3.4 caller. */
  holdExpiresAt?: number;
  createdAt: number;
}

export type BookingRow = typeof bookings.$inferSelect;

/** Writes a booking's initial row -- before any chain call, per AD-13: the
 * backend's hold generates the id and this row exists so the event worker
 * has something to mirror state onto once the chain confirms it. Never
 * sets `escrowState`; it starts `null` and stays that way until the event
 * worker processes this booking's first event.
 *
 * Story 3.4: a real slot hold never calls this directly -- it goes through
 * {@link insertBookingHoldIfSlotFree}, whose own single `INSERT ... SELECT
 * ... WHERE NOT EXISTS` statement is what actually enforces "at most one
 * active booking per slot" in SQL. This function stays the plain,
 * unconditional insert existing tests (and `seed/demo.ts`) already rely on. */
export async function insertBooking(db: Db, values: NewBooking): Promise<void> {
  await db.insert(bookings).values({
    id: values.id,
    providerProfileId: values.providerProfileId,
    clientWalletAddress: values.clientWalletAddress,
    clientEmail: values.clientEmail ?? null,
    tokenAddress: values.tokenAddress,
    depositAmount: values.depositAmount,
    balanceAmount: values.balanceAmount ?? "0",
    cancelDeadline: values.cancelDeadline,
    balanceState: values.balanceState ?? "unpaid",
    slotId: values.slotId,
    holdExpiresAt: values.holdExpiresAt,
    createdAt: values.createdAt,
  });
}

/**
 * The AD-13 slot hold's own write path (Story 3.4): a single `INSERT ...
 * SELECT ... WHERE NOT EXISTS` statement, so "a slot has at most one active
 * booking" (the spec's own "Always" rule) is enforced by SQLite itself, in
 * one atomic statement, never by a separate JS-level check-then-insert that
 * a second concurrent caller could interleave with. "Active" means a
 * non-expired hold (`hold_expires_at >= now`) or a booking whose
 * `escrow_state` is already non-null (a locked/released/refunded booking
 * never frees its slot merely because its own hold's clock ran out).
 *
 * Returns `true` when the row was actually inserted (the slot was free),
 * `false` when another active booking already holds this exact `slotId` --
 * the caller (`services/booking.ts`'s `holdSlot`) turns a `false` into the
 * `409 SLOT_TAKEN` response, never a raw constraint error.
 */
export async function insertBookingHoldIfSlotFree(
  db: Db,
  values: NewBooking & { slotId: string; holdExpiresAt: number },
  now: number,
): Promise<boolean> {
  const result = db.run(sql`
    INSERT INTO bookings (
      id, provider_profile_id, client_wallet_address, client_email, token_address,
      deposit_amount, balance_amount, cancel_deadline, slot_id, hold_expires_at,
      balance_state, created_at
    )
    SELECT
      ${values.id}, ${values.providerProfileId}, ${values.clientWalletAddress}, ${values.clientEmail ?? null}, ${values.tokenAddress},
      ${values.depositAmount}, ${values.balanceAmount ?? "0"}, ${values.cancelDeadline}, ${values.slotId}, ${values.holdExpiresAt},
      ${values.balanceState ?? "unpaid"}, ${values.createdAt}
    WHERE NOT EXISTS (
      SELECT 1 FROM bookings existing
      WHERE existing.slot_id = ${values.slotId}
        AND (
          (existing.escrow_state IS NOT NULL AND existing.escrow_state != 'refunded')
          OR (existing.escrow_state IS NULL AND existing.hold_expires_at >= ${now})
        )
    )
  `);
  return result.changes > 0;
}

/** Same "active" definition as {@link insertBookingHoldIfSlotFree}'s own
 * `WHERE NOT EXISTS` clause (review follow-up: a refunded booking never
 * counts), for a caller (`holdSlot`) that needs to find -- not merely
 * refuse to duplicate -- the one active booking a wallet already holds on
 * a given slot. `undefined` when the wallet has no active booking there. */
export async function getActiveBookingForWalletAndSlot(
  db: Db,
  slotId: string,
  clientWalletAddress: string,
  now: number,
): Promise<BookingRow | undefined> {
  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.slotId, slotId),
        eq(bookings.clientWalletAddress, clientWalletAddress),
        or(
          and(isNotNull(bookings.escrowState), ne(bookings.escrowState, "refunded")),
          and(isNull(bookings.escrowState), gte(bookings.holdExpiresAt, now)),
        ),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Finds the original, never-deployed hold for one wallet and slot. A hold
 * is expired only while `escrowState` is null, `escrowContractId` is null,
 * and `holdExpiresAt` is strictly before `now`. Exactly at the boundary
 * the hold remains active. */
export async function getExpiredHoldForWalletAndSlot(
  db: Db,
  slotId: string,
  clientWalletAddress: string,
  now: number,
): Promise<BookingRow | undefined> {
  const rows = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.slotId, slotId),
        eq(bookings.clientWalletAddress, clientWalletAddress),
        isNull(bookings.escrowState),
        isNull(bookings.escrowContractId),
        isNull(bookings.declinedAt),
        lt(bookings.holdExpiresAt, now),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Removes one client's own hold, in a single atomic `DELETE`, so the slot is
 * free again for the next `insertBookingHoldIfSlotFree`. Only an unlocked,
 * unexpired hold qualifies: `escrow_state` still null, no deploy submitted
 * on chain, and `hold_expires_at` not yet passed (exactly at the boundary
 * the hold is still active). Returns `true` when a row was removed.
 */
export async function deleteUnlockedHold(
  db: Db,
  bookingId: string,
  clientWalletAddress: string,
  now: number,
): Promise<boolean> {
  const result = db.run(sql`
    DELETE FROM bookings
    WHERE id = ${bookingId}
      AND client_wallet_address = ${clientWalletAddress}
      AND escrow_state IS NULL
      AND deploy_submitted_at IS NULL
      AND (hold_expires_at IS NULL OR hold_expires_at >= ${now})
  `);
  return result.changes > 0;
}

/** How many *pending* holds (`escrow_state IS NULL`, not yet expired) a
 * wallet currently has open across every provider -- `holdSlot`'s own
 * per-wallet cap (review follow-up: caps abuse from one wallet opening
 * unlimited simultaneous holds). A booking that has already locked,
 * released or refunded is not "holding" anything anymore and never counts
 * here, regardless of how many of those a wallet has accumulated over
 * time. */
export async function countPendingHoldsForWallet(db: Db, clientWalletAddress: string, now: number): Promise<number> {
  const rows = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.clientWalletAddress, clientWalletAddress), isNull(bookings.escrowState), gte(bookings.holdExpiresAt, now)));
  return rows.length;
}

/** One booking touched by a shop closing a whole date -- either a hold
 * released by that action, or a billed appointment the action deliberately
 * left alone. */
export interface DateHoldBooking {
  bookingId: string;
  slotStartsAt: number;
  clientWalletAddress: string;
  /** `null` for a released hold; the booking's state for one left alone. */
  escrowState: EscrowState | null;
}

export interface ReleaseHoldsForDateResult {
  /** Unpaid holds that were active on this date and are now released. */
  released: DateHoldBooking[];
  /** Bookings with a funded escrow on this date -- never released; the
   * shop must resolve them itself. */
  needsResolution: DateHoldBooking[];
}

/**
 * Story: closing a date. Releases every still-active, unpaid hold whose slot
 * starts inside `[rangeStart, rangeEnd)` for this provider: `holdExpiresAt`
 * moves to `now` (the slot is therefore free for someone else), and
 * `holdReleasedAt`/`holdReleaseReason` record why, so the client's own views
 * can say "the shop closed this date" rather than a bare expiry.
 *
 * A booking whose `escrowState` is already set is *never* touched -- money
 * has moved or the appointment happened; it comes back in
 * `needsResolution` instead. Expired holds and refunded bookings are not
 * "active" and are ignored. The whole read-and-release runs in one SQL
 * transaction so a concurrent lock/fund can never slip between them.
 */
export async function releaseUnpaidHoldsForProviderDate(
  db: Db,
  providerProfileId: string,
  rangeStart: number,
  rangeEnd: number,
  now: number,
): Promise<ReleaseHoldsForDateResult> {
  return db.transaction((tx) => {
    const rows = tx
      .select({ booking: bookings, slotStartsAt: availabilitySlots.startsAt })
      .from(bookings)
      .innerJoin(availabilitySlots, eq(bookings.slotId, availabilitySlots.id))
      .where(
        and(
          eq(bookings.providerProfileId, providerProfileId),
          gte(availabilitySlots.startsAt, rangeStart),
          lt(availabilitySlots.startsAt, rangeEnd),
        ),
      )
      .all();

    const released: DateHoldBooking[] = [];
    const needsResolution: DateHoldBooking[] = [];
    for (const { booking, slotStartsAt } of rows) {
      if (booking.escrowState !== null) {
        // A funded (or already settled) booking is never released by a
        // close-date action; only a live `locked` one needs the shop's
        // attention, so terminal/settled rows are simply ignored.
        if (booking.escrowState === "locked") {
          needsResolution.push({
            bookingId: booking.id,
            slotStartsAt,
            clientWalletAddress: booking.clientWalletAddress,
            escrowState: booking.escrowState,
          });
        }
        continue;
      }
      if (booking.holdExpiresAt !== null && booking.holdExpiresAt > now && booking.holdReleasedAt === null) {
        released.push({
          bookingId: booking.id,
          slotStartsAt,
          clientWalletAddress: booking.clientWalletAddress,
          escrowState: booking.escrowState,
        });
      }
    }

    if (released.length > 0) {
      tx.update(bookings)
        .set({ holdExpiresAt: now, holdReleasedAt: now, holdReleaseReason: "shop-closed-date" })
        .where(
          and(
            inArray(
              bookings.id,
              released.map((row) => row.bookingId),
            ),
            isNull(bookings.escrowState),
          ),
        )
        .run();
    }

    return { released, needsResolution };
  });
}

/**
 * Story: reschedule a locked booking. Moves the booking's own `slot_id` to
 * `newSlotId` and recomputes `cancel_deadline` for the new appointment, but
 * touches nothing else -- the escrow contract id, deposit, balance, client
 * and provider stay exactly as they were, so no second escrow is ever
 * deployed.
 *
 * One synchronous transaction does both the availability check and the
 * write: `false` means the target slot was taken between the caller's own
 * read and here (or this booking is no longer the locked booking on
 * `expectedSlotId`), and in that case nothing is written -- a taken slot is
 * a refusal, never an overwrite. The "active" predicate is the same one
 * `listOpenFutureSlots` uses: a non-refunded escrow, or a non-expired hold.
 * The booking being moved is excluded from that check, so moving a booking
 * to its own current slot is a harmless no-op (the service short-circuits
 * it before getting here).
 */
export async function rescheduleBookingSlot(
  db: Db,
  bookingId: string,
  expectedSlotId: string,
  newSlotId: string,
  newCancelDeadline: number,
  now: number,
): Promise<boolean> {
  return db.transaction((tx) => {
    const conflict = tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.slotId, newSlotId),
          ne(bookings.id, bookingId),
          or(
            and(isNotNull(bookings.escrowState), ne(bookings.escrowState, "refunded")),
            and(isNull(bookings.escrowState), gt(bookings.holdExpiresAt, now)),
          ),
        ),
      )
      .limit(1)
      .all();
    if (conflict.length > 0) {
      return false;
    }

    const result = tx
      .update(bookings)
      .set({ slotId: newSlotId, cancelDeadline: newCancelDeadline })
      .where(and(eq(bookings.id, bookingId), eq(bookings.slotId, expectedSlotId), eq(bookings.escrowState, "locked")))
      .run();
    return result.changes > 0;
  });
}

export async function getBookingById(db: Db, id: string): Promise<BookingRow | undefined> {
  const rows = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1);
  return rows[0];
}

/** Story 3.6: every booking named in `ids`, in one query -- the admin
 * disputes list's own N+1 avoidance (same discipline as
 * `getEscrowLifecycleForBookings`). Empty input short-circuits to an empty
 * array. */
export async function getBookingsByIds(db: Db, ids: string[]): Promise<BookingRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(bookings).where(inArray(bookings.id, ids));
}

/** The event worker's own write path, as a synchronous call -- callable
 * either directly or (its reason for existing) from inside a
 * `db.transaction()` callback, which on better-sqlite3 must never `await`
 * (a transaction there is a real synchronous BEGIN/COMMIT wrapped around a
 * plain function call; an `await` inside would let the driver COMMIT
 * before the awaited write actually runs). Touches `escrowState` alone --
 * never `balanceState`, which is a different owner's column (AD-3).
 * Throws if `id` matches no row, rather than silently writing nothing. */
export function updateEscrowStateSync(db: DbOrTx, id: string, escrowState: EscrowState): void {
  const result = db.update(bookings).set({ escrowState }).where(eq(bookings.id, id)).run();
  if (result.changes === 0) {
    throw new TypeError(`No booking exists with id "${id}"`);
  }
}

/** The event worker's own write path. Touches `escrowState` alone -- never
 * `balanceState`, which is a different owner's column (AD-3). */
export async function updateEscrowState(db: Db, id: string, escrowState: EscrowState): Promise<void> {
  updateEscrowStateSync(db, id, escrowState);
}

/** Stores an optional client contact email for post-release mailto drafts.
 * Empty / whitespace clears the field back to null. */
export async function updateClientEmail(db: Db, id: string, clientEmail: string | null): Promise<void> {
  const trimmed = clientEmail?.trim() || null;
  await db.update(bookings).set({ clientEmail: trimmed }).where(eq(bookings.id, id));
}

/** Same as {@link updateEscrowStateSync}, except the write itself is
 * conditioned in SQL on the row not already being terminal -- `WHERE id = ?
 * AND (escrow_state IS NULL OR escrow_state NOT IN ('released',
 * 'refunded'))`. The reconciler's own in-memory terminal check
 * (`processEscrowRow`) reads a booking snapshot fetched once per batch, so
 * a second row for the same escrow processed later in that same batch
 * could otherwise regress an already-terminal booking (e.g.
 * `released` -> `locked`) before the first row's own write is even
 * visible to that stale snapshot. Returns `true` only when a row was
 * actually written -- `false` when the booking was already terminal (by
 * this point, not necessarily by the caller's own possibly-stale check) or
 * does not exist. */
export function updateEscrowStateIfNotTerminalSync(db: DbOrTx, id: string, escrowState: EscrowState): boolean {
  const result = db
    .update(bookings)
    .set({ escrowState })
    .where(
      and(
        eq(bookings.id, id),
        or(isNull(bookings.escrowState), notInArray(bookings.escrowState, [...TERMINAL_ESCROW_STATES])),
      ),
    )
    .run();
  return result.changes > 0;
}

/** Story 3.8: sets the client's private note on a booking (up to 500 chars).
 * The note is visible on the booking detail page to the shop and the client,
 * never on the public profile or discovery. An empty note clears the
 * previous note. Throws if `id` matches no row. */
export async function setBookingNote(db: Db, id: string, note: string): Promise<void> {
  // Enforce 500-character limit
  if (note.length > 500) {
    throw new TypeError(`Note must be 500 characters or fewer, got ${note.length} characters.`);
  }
  // Check booking exists and is not in a terminal state
  const booking = await getBookingById(db, id);
  if (!booking) {
    throw new TypeError(`No booking exists with id "${id}"`);
  }
  // Note can only be set on non-terminal bookings (not released or refunded)
  if (booking.escrowState === "released" || booking.escrowState === "refunded") {
    throw new TypeError(`Cannot set note on a booking that is "${booking.escrowState}".`);
  }
  const result = await db
    .update(bookings)
    .set({ note })
    .where(eq(bookings.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No booking exists with id "${id}"`);
  }
}

/** Clears the private note on a booking. Returns `false` if the booking
 * does not exist. */
export async function clearBookingNote(db: Db, id: string): Promise<boolean> {
  // Check booking exists and is not in a terminal state
  const booking = await getBookingById(db, id);
  if (!booking) {
    return false;
  }
  // Note can only be cleared on non-terminal bookings (not released or refunded)
  if (booking.escrowState === "released" || booking.escrowState === "refunded") {
    return false;
  }
  const result = await db
    .update(bookings)
    .set({ note: null })
    .where(eq(bookings.id, id));
  return result.changes > 0;
}

/** The backend's own write path for the balance side of AD-3. Touches
 * `balanceState` alone -- never `escrowState`. Throws if `id` matches no
 * row, rather than silently writing nothing. */
export async function updateBalanceState(db: Db, id: string, balanceState: BalanceState): Promise<void> {
  const result = await db.update(bookings).set({ balanceState }).where(eq(bookings.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No booking exists with id "${id}"`);
  }
}

/** Issue #6: how long a first-deploy claim is honored before a later lock
 * request may take it over. Generous enough to outlast any single escrow
 * deploy call, and bounded because a claim that never expired would wedge
 * the booking out of ever deploying if the request holding it died (a
 * crashed process, a dropped connection) between taking the claim and
 * persisting a `contractId`. */
export const ESCROW_LOCK_CLAIM_STALE_AFTER_SECONDS = 120;

/**
 * Issue #6: takes the one in-flight first-deploy claim for this booking, in
 * the same conditioned `UPDATE` style {@link insertBookingHoldIfSlotFree}
 * already uses for the slot hold -- the "at most one deploy in flight per
 * booking" rule is enforced by SQLite in one statement, never by a
 * check-then-act a second concurrent caller can interleave with. Unlike
 * {@link updateEscrowContractId}'s own guarded write, which only lands
 * *after* the escrow adapter has already been called (so two racing
 * requests both deployed and one lost), this is taken *before* the call,
 * which is what keeps the deploy itself single.
 *
 * Claimable only while the booking still has no `escrowState` and no
 * `contractId` (the same precondition the deploy itself has), and either no
 * claim at all or one older than {@link ESCROW_LOCK_CLAIM_STALE_AFTER_SECONDS}.
 * Returns `true` when this caller now holds the claim, `false` when another
 * request holds a fresh one (or the booking has moved on) -- the caller
 * returns the booking's own current state rather than deploying.
 */
export async function claimEscrowLock(db: Db, id: string, claimToken: string, now: number): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ escrowLockClaimToken: claimToken, escrowLockClaimedAt: now })
    .where(
      and(
        eq(bookings.id, id),
        isNull(bookings.escrowState),
        isNull(bookings.escrowContractId),
        or(
          isNull(bookings.escrowLockClaimedAt),
          lte(bookings.escrowLockClaimedAt, now - ESCROW_LOCK_CLAIM_STALE_AFTER_SECONDS),
        ),
      ),
    );
  return result.changes > 0;
}

/** Releases the claim only if `claimToken` is still the one holding it -- so
 * a slow request whose claim was already taken over (or already persisted a
 * `contractId`, which clears the claim in that same write) can never release
 * someone else's. Called when a deploy fails, so "a failed deploy that
 * stored no contract id can be retried" stays true without waiting out the
 * stale window. Returns `true` when this caller's own claim was released. */
export async function releaseEscrowLock(db: Db, id: string, claimToken: string): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ escrowLockClaimToken: null, escrowLockClaimedAt: null })
    .where(and(eq(bookings.id, id), eq(bookings.escrowLockClaimToken, claimToken)));
  return result.changes > 0;
}

/** `services/booking.ts`'s `lockDeposit` write path: persists the escrow's
 * predicted `contractId` the moment the deploy XDR is built -- once, ever,
 * per booking. The write itself is conditioned in SQL (`WHERE id = ? AND
 * escrow_state IS NULL AND escrow_contract_id IS NULL`) so a second
 * `lockDeposit` can never silently overwrite a `contractId` whose deploy
 * (and possibly `fundDeposit`) may already have landed on chain -- doing so
 * would orphan whatever was actually funded, since every later call
 * (`fundDeposit`, the reconciler) only ever looks at the *current* column
 * value. Throws when the write did not happen, whether because `id` does
 * not exist, an `escrowState` is already recorded, or a `contractId` is
 * already persisted -- `services/booking.ts`'s own pre-check is expected to
 * have already ruled out the first two cases with a more specific error;
 * this is the defense against the same race in the small window between
 * that check and this write. */
export async function updateEscrowContractId(
  db: Db,
  id: string,
  contractId: string,
  /** Story 3.4: the unsigned deploy XDR built for this same `contractId`,
   * stored alongside it (same guarded write, same atomicity) so a retried
   * `lockDeposit` can return the identical XDR rather than deploying a
   * second, competing escrow (Design Notes: "Why retry reuses the stored
   * deploy XDR"). `undefined` for a caller that has no XDR to store (kept
   * optional so every pre-3.4 call site -- and every test that seeds an
   * "abandoned deploy with nothing stored" row -- still compiles). */
  unsignedXdr?: string,
  /** Review follow-up: the Trustless-Work-returned `txHash` for this same
   * deploy XDR, stored so `submitSignedTransaction` can match a signed
   * envelope's own computed hash against it before ever relaying it. */
  txHash?: string,
  /** Issue #7: the SEP-38 quote id to persist on the booking. Null if not
   * provided (keeps existing behavior for pre-7 bookings). */
  anchorQuoteId?: string,
): Promise<void> {
  const result = await db
    .update(bookings)
    .set({
      escrowContractId: contractId,
      escrowDeployXdr: unsignedXdr ?? null,
      escrowDeployTxHash: txHash ?? null,
      // Issue #7: persist the SEP-38 quote id at lock time so the booking
      // retains its reference even if the quote later ages out or the deposit
      // fails.
      anchorQuoteId: anchorQuoteId ?? null,
      // Issue #6: the deploy is no longer in flight -- this booking now has
      // a persisted contractId, so the claim taken for it is released in
      // this same atomic write (every later lock call returns from the
      // persisted row instead).
      escrowLockClaimToken: null,
      escrowLockClaimedAt: null,
    })
    .where(and(eq(bookings.id, id), isNull(bookings.escrowState), isNull(bookings.escrowContractId)));
  if (result.changes === 0) {
    throw new TypeError(
      `Could not persist escrowContractId for booking "${id}": it does not exist, or already has an escrow_state or a contractId`,
    );
  }
}

/**
 * Clears a persisted `contractId` (and its stored deploy XDR/txHash, if
 * any) so `lockDeposit` can rebuild a fresh deploy on an explicit
 * `rebuild: true` request. Conditioned on the row still naming the exact
 * `contractId` the caller read, on no deploy having been submitted yet
 * (`deploy_submitted_at IS NULL` -- once a signed deploy has actually been
 * relayed, rebuilding would abandon money in flight), and on `escrow_state`
 * still being `null`. Returns `false` on any of those no longer holding
 * (a race with a concurrent submit or the reconciler) rather than throwing
 * -- the caller re-reads the booking and proceeds from its current state.
 */
export async function clearUnsubmittedEscrowContractId(db: Db, id: string, expectedContractId: string): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ escrowContractId: null, escrowDeployXdr: null, escrowDeployTxHash: null })
    .where(
      and(
        eq(bookings.id, id),
        eq(bookings.escrowContractId, expectedContractId),
        isNull(bookings.escrowState),
        isNull(bookings.deploySubmittedAt),
      ),
    );
  return result.changes > 0;
}

/**
 * Records that a signed deploy transaction matching `expectedTxHash` was
 * successfully relayed, and extends the hold to `newHoldExpiresAt` (ten
 * minutes from the moment of submission -- the client has now committed a
 * real signature and needs time to complete funding). Conditioned on the
 * row still naming the exact `contractId`/`txHash` the caller matched
 * against, on no earlier submission already recorded (write-once: a
 * resubmit of the identical signed envelope is harmless but must not keep
 * re-extending the hold indefinitely), and on `escrow_state` still being
 * `null`. Returns `false` -- never throws -- when any of those no longer
 * holds; the caller (`submitSignedTransaction`) still relays the
 * transaction either way, since a `false` here only means "already
 * recorded" or "already moved past this", not a reason to refuse the
 * relay itself.
 */
export async function recordDeploySubmission(
  db: Db,
  id: string,
  expectedContractId: string,
  expectedTxHash: string,
  newHoldExpiresAt: number,
  submittedAt: number,
): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ deploySubmittedAt: submittedAt, holdExpiresAt: newHoldExpiresAt })
    .where(
      and(
        eq(bookings.id, id),
        eq(bookings.escrowContractId, expectedContractId),
        eq(bookings.escrowDeployTxHash, expectedTxHash),
        isNull(bookings.deploySubmittedAt),
        isNull(bookings.escrowState),
      ),
    );
  return result.changes > 0;
}

/** `services/booking.ts`'s `fundDeposit` write path: stores the
 * Trustless-Work-returned `txHash` for the fund XDR just built, so
 * `submitSignedTransaction` can match a signed envelope against it.
 * Unlike the deploy XDR, funding is not write-once -- each call simply
 * overwrites whatever was stored before, since only the most recently
 * built fund transaction is ever the one worth signing. */
export async function setEscrowFundTxHash(db: Db, id: string, txHash: string): Promise<void> {
  await db.update(bookings).set({ escrowFundTxHash: txHash }).where(eq(bookings.id, id));
}

/** Story 3.6: every action past deploy/fund shares this one write path --
 * stores the just-built unsigned XDR's own `txHash` on the booking so
 * `submitSignedTransaction`'s hash-matching rule (3.4's submit allow-list)
 * extends to it. Not write-once, unlike the deploy XDR: a declined
 * signature must still be retryable, and each call simply overwrites
 * whatever was stored before -- only the most recently built transaction
 * for that action is ever the one worth signing. */
export type EscrowActionKind = "complete" | "approve" | "release" | "dispute" | "resolve";

export async function setEscrowActionTxHash(db: Db, id: string, action: EscrowActionKind, txHash: string): Promise<void> {
  setEscrowActionTxHashSync(db, id, action, txHash);
}

export function setEscrowActionTxHashSync(db: DbOrTx, id: string, action: EscrowActionKind, txHash: string): void {
  switch (action) {
    case "complete":
      db.update(bookings).set({ escrowCompleteTxHash: txHash }).where(eq(bookings.id, id)).run();
      return;
    case "approve":
      db.update(bookings).set({ escrowApproveTxHash: txHash }).where(eq(bookings.id, id)).run();
      return;
    case "release":
      db.update(bookings).set({ escrowReleaseTxHash: txHash }).where(eq(bookings.id, id)).run();
      return;
    case "dispute":
      db.update(bookings).set({ escrowDisputeTxHash: txHash }).where(eq(bookings.id, id)).run();
      return;
    case "resolve":
      db.update(bookings).set({ escrowResolveTxHash: txHash }).where(eq(bookings.id, id)).run();
      return;
  }
}

/**
 * Story 3.6 (review round): the pending dispute's own build-time record --
 * "last builder wins", so a caller opening a second dispute before ever
 * submitting the first simply overwrites this row's own hash, reason,
 * opener wallet and opener role together. Never itself writes
 * `escrow_dispute_openings` -- that only happens once a signed transaction
 * matching this same hash is actually relayed ({@link setEscrowActionTxHash}'s
 * `"dispute"` case is not used for this column any more; this function is
 * `openDispute`'s one write path instead).
 */
export interface PendingDispute {
  txHash: string;
  reason: DisputeReason;
  openerWallet: string;
  openerRole: DisputeOpenerRole;
  /** Issue #22: the note the opener attached (free text, may be empty). */
  note?: string;
  /** Issue #22: the SHA-256 hex evidence hash the opener attached
   * (64 lowercase hex characters, or undefined). */
  evidenceHash?: string;
}

export async function setPendingDispute(db: Db, id: string, pending: PendingDispute): Promise<void> {
  await db
    .update(bookings)
    .set({
      escrowDisputeTxHash: pending.txHash,
      pendingDisputeReason: pending.reason,
      pendingDisputeOpenerWallet: pending.openerWallet,
      pendingDisputeOpenerRole: pending.openerRole,
      pendingDisputeNote: pending.note ?? null,
      pendingDisputeEvidenceHash: pending.evidenceHash ?? null,
    })
    .where(eq(bookings.id, id));
}

/**
 * Story 3.6 (review round): records that a signed transaction for `action`
 * was actually relayed -- mirrors `recordDeploySubmission`'s role for the
 * deploy step, one column per action kind. `services/booking.ts` reads this
 * back (per action, against the reconciler's own current lifecycle) to
 * refuse building the *same* action again while it is already awaiting
 * chain confirmation (`409 ACTION_PENDING`), and to compute `pendingAction`
 * for `GET /bookings/:id` and the two list routes.
 */
export async function setEscrowActionSubmittedAt(db: Db, id: string, action: EscrowActionKind, submittedAt: number): Promise<void> {
  switch (action) {
    case "complete":
      await db.update(bookings).set({ escrowCompleteSubmittedAt: submittedAt }).where(eq(bookings.id, id));
      return;
    case "approve":
      await db.update(bookings).set({ escrowApproveSubmittedAt: submittedAt }).where(eq(bookings.id, id));
      return;
    case "release":
      await db.update(bookings).set({ escrowReleaseSubmittedAt: submittedAt }).where(eq(bookings.id, id));
      return;
    case "dispute":
      await db.update(bookings).set({ escrowDisputeSubmittedAt: submittedAt }).where(eq(bookings.id, id));
      return;
    case "resolve":
      await db.update(bookings).set({ escrowResolveSubmittedAt: submittedAt }).where(eq(bookings.id, id));
      return;
  }
}

/** Story 3.7's own submit-binding write path (mirrors
 * `updateEscrowContractId`'s `escrowDeployXdr`/`escrowDeployTxHash` pair):
 * stores the hash of the plain Stellar USDC payment `buildBalancePayment`
 * just built, so `submitBalancePayment` can later refuse anything whose own
 * computed hash does not match it. Not write-once -- a declined signature
 * must still be retryable, so a later `buildBalancePayment` call simply
 * overwrites whatever was stored before. */
export async function setBalancePaymentBuiltHash(db: Db, id: string, hash: string): Promise<void> {
  await db.update(bookings).set({ balancePaymentBuiltHash: hash }).where(eq(bookings.id, id));
}

/**
 * Story 3.7's own write path for "paid through Pactly": moves
 * `balanceState` to `"paid_platform"`, stores the on-chain `txHash`, and
 * clears `balancePaymentBuiltHash` (review follow-up: a spent envelope's
 * hash must never stay around to be relayed again), all in one write,
 * conditioned on `balanceState` still being `"unpaid"` (the same
 * defense-in-depth shape as `updateEscrowContractId`'s own guarded write) so
 * a race -- the provider marking cash paid at the same moment a client's
 * platform payment confirms -- can never silently overwrite whichever write
 * landed first. Returns `false` (never throws) when the row was no longer
 * `"unpaid"`; the caller (`services/booking.ts`'s `submitBalancePayment`)
 * treats a `false` here as a real failure (the payment already landed on
 * chain but could not be recorded), never a silent success, since its own
 * re-check just before submitting already ruled out the ordinary case. */
export async function markBalancePaidPlatform(db: Db, id: string, txHash: string): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ balanceState: "paid_platform", balancePaymentTxHash: txHash, balancePaymentBuiltHash: null })
    .where(and(eq(bookings.id, id), eq(bookings.balanceState, "unpaid")));
  return result.changes > 0;
}

/**
 * Story 3.7's own write path for "paid in person": moves `balanceState` to
 * `"paid_cash"` and clears `balancePaymentBuiltHash` in the same write
 * (review follow-up: a previously-built, never-submitted platform-payment
 * envelope must never remain relayable once the provider has recorded a
 * cash payment for the same balance -- that would let the client pay it a
 * second time), conditioned on `balanceState` still being `"unpaid"` (same
 * guarded-write shape as {@link markBalancePaidPlatform}, and for the same
 * reason: this must never clobber a platform payment that confirmed a
 * moment earlier). Returns `false` (never throws) when the row was no
 * longer `"unpaid"` -- the caller re-reads and refuses with the row's
 * actual current state. */
export async function markBalancePaidCashIfUnpaid(db: Db, id: string): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ balanceState: "paid_cash", balancePaymentBuiltHash: null })
    .where(and(eq(bookings.id, id), eq(bookings.balanceState, "unpaid")));
  return result.changes > 0;
}

/**
 * Story 3.4's hold-expiry tick (`runner.ts`): every booking whose hold has
 * expired with an escrow deploy still in flight (`escrowContractId` set,
 * `escrowState` still `null`) *and* whose slot has since been re-held by a
 * different active booking -- the double-sale risk the story's own Design
 * Notes name ("A slot freed from an expired hold whose escrow later
 * reconciles as funded is logged as an anomaly"). Both rows are left
 * exactly as they are; this is a read-only detector for the runner to log,
 * never a writer.
 */
export interface PotentialDoubleSale {
  bookingId: string;
  contractId: string;
  slotId: string;
}

export function listPotentialDoubleSales(db: Db, now: number): PotentialDoubleSale[] {
  // "Expired" is `<= now` everywhere in this codebase (matches
  // `services/booking.ts`'s `requireHoldNotExpired`); "active" is `> now`.
  // A row exactly at `now` is expired, never both.
  const rows = db.all<{ booking_id: string; contract_id: string; slot_id: string }>(sql`
    SELECT b.id AS booking_id, b.escrow_contract_id AS contract_id, b.slot_id AS slot_id
    FROM bookings b
    WHERE b.escrow_state IS NULL
      AND b.escrow_contract_id IS NOT NULL
      AND b.slot_id IS NOT NULL
      AND b.hold_expires_at IS NOT NULL
      AND b.hold_expires_at < ${now}
      AND EXISTS (
        SELECT 1 FROM bookings other
        WHERE other.slot_id = b.slot_id
          AND other.id != b.id
          AND (
            (other.escrow_state IS NOT NULL AND other.escrow_state != 'refunded')
            OR (other.escrow_state IS NULL AND other.hold_expires_at >= ${now})
          )
      )
  `);
  return rows.map((row) => ({ bookingId: row.booking_id, contractId: row.contract_id, slotId: row.slot_id }));
}

/**
 * Review follow-up: a second, more general double-sale detector alongside
 * {@link listPotentialDoubleSales} -- two *distinct* bookings sharing the
 * same `slot_id` where at least one already has a non-null, non-`refunded`
 * `escrow_state` (a real, committed booking) and the other is *also*
 * locked/released/refunded or still an actively-held pending hold. This
 * should never happen given {@link insertBookingHoldIfSlotFree}'s own
 * atomic guarantee -- it exists as a safety-net sweep, not a path anything
 * is expected to hit. Returns one row per ordered pair (so a caller can
 * dedupe by an unordered pair key itself, which `expireHolds` does, to log
 * each conflict once rather than twice).
 */
export interface ConflictingBookingPair {
  slotId: string;
  bookingIdA: string;
  bookingIdB: string;
}

export function listConflictingSlotBookings(db: Db, now: number): ConflictingBookingPair[] {
  const rows = db.all<{ slot_id: string; booking_a: string; booking_b: string }>(sql`
    SELECT b1.slot_id AS slot_id, b1.id AS booking_a, b2.id AS booking_b
    FROM bookings b1
    JOIN bookings b2 ON b1.slot_id = b2.slot_id AND b1.id != b2.id
    WHERE b1.slot_id IS NOT NULL
      AND b1.escrow_state IS NOT NULL
      AND b1.escrow_state != 'refunded'
      AND (
        (b2.escrow_state IS NOT NULL AND b2.escrow_state != 'refunded')
        OR (b2.escrow_state IS NULL AND b2.hold_expires_at >= ${now})
      )
  `);
  return rows.map((row) => ({ slotId: row.slot_id, bookingIdA: row.booking_a, bookingIdB: row.booking_b }));
}

/** One booking the reconciler is allowed to poll, plus the provider wallet
 * its escrow's `receiver`/`serviceProviders`/`releaseSigners` roles must
 * name (Story 1.8's role map) -- resolved once here so
 * `reconciler.ts` never re-joins `provider_profiles` itself. */
export interface ReconcilableBooking {
  booking: BookingRow;
  providerAddress: string;
}

/**
 * Every booking the reconciler may poll this run (AC4, amended
 * 2026-09-19): a persisted `escrowContractId` and an `escrowState` that is
 * not yet terminal (`released`/`refunded`) -- once a booking reaches a
 * terminal state it is never polled again, which is what keeps a stale or
 * out-of-order read-model row from ever regressing it (the I/O matrix's
 * "stale or out-of-order row" guard starts here, at the query itself, not
 * only in the reconciler's own per-row logic).
 */
export async function getReconcilableBookings(db: Db): Promise<ReconcilableBooking[]> {
  const rows = await db
    .select({ booking: bookings, providerAddress: providerProfiles.walletAddress })
    .from(bookings)
    .innerJoin(providerProfiles, eq(bookings.providerProfileId, providerProfiles.id))
    .where(
      and(
        isNotNull(bookings.escrowContractId),
        // `escrowState` starts `null` (before the reconciler's first
        // confirmed transition) and must stay pollable then -- SQL's
        // three-valued logic means a plain `NOT IN` silently excludes NULL
        // rows, which would make the very first "funded" transition
        // unreachable for every booking.
        or(isNull(bookings.escrowState), notInArray(bookings.escrowState, [...TERMINAL_ESCROW_STATES])),
      ),
    );
  return rows.map((row) => ({ booking: row.booking, providerAddress: row.providerAddress }));
}

// ---------------------------------------------------------------------------
// Story 3.5: the two-sided status panel's own list reads. Each pairs a
// booking row with its own slot's `startsAt` (`null` for a pre-3.4 booking
// with no `slotId`), via a `LEFT JOIN` so a booking is never dropped just
// because it has no slot -- `services/booking.ts` is where the appointment-
// date ordering and the per-item view shape actually get built; these two
// functions are only the SQL that scopes a list to one wallet's own rows.
// ---------------------------------------------------------------------------

export interface BookingWithSlot {
  booking: BookingRow;
  slotStartsAt: number | null;
}

/** `GET /me/bookings`'s own read: every booking `clientWalletAddress` is the
 * client on, across every provider (the spec's own "Always" rule) -- this
 * `WHERE` clause is the one thing standing between one client's list and
 * another's (the spec's own "Isolation" row). */
export async function listBookingRowsForClient(db: Db, clientWalletAddress: string): Promise<BookingWithSlot[]> {
  const rows = await db
    .select({ booking: bookings, slotStartsAt: availabilitySlots.startsAt })
    .from(bookings)
    .leftJoin(availabilitySlots, eq(bookings.slotId, availabilitySlots.id))
    .where(eq(bookings.clientWalletAddress, clientWalletAddress));
  return rows.map((row) => ({ booking: row.booking, slotStartsAt: row.slotStartsAt ?? null }));
}

/** `GET /me/provider/bookings`'s own read: every booking against one
 * provider profile -- the caller resolves `providerProfileId` from their own
 * wallet first (`services/booking.ts`'s `listBookingsForProvider`), never
 * from a caller-supplied id, so another provider's bookings can never be
 * requested through this function at all. */
export async function listBookingRowsForProvider(db: Db, providerProfileId: string): Promise<BookingWithSlot[]> {
  const rows = await db
    .select({ booking: bookings, slotStartsAt: availabilitySlots.startsAt })
    .from(bookings)
    .leftJoin(availabilitySlots, eq(bookings.slotId, availabilitySlots.id))
    .where(eq(bookings.providerProfileId, providerProfileId));
  return rows.map((row) => ({ booking: row.booking, slotStartsAt: row.slotStartsAt ?? null }));
}

/** Issue #67: one provider's bookings whose own slot starts inside
 * `[from, to]` (UTC epoch seconds, inclusive) -- the CSV export's read.
 * A booking with no slot has no appointment time and is never in a range.
 * Scoped to one provider profile, so another shop's rows can never be
 * selected through this function. */
export async function listBookingRowsForProviderInRange(
  db: Db,
  providerProfileId: string,
  from: number,
  to: number,
): Promise<BookingWithSlot[]> {
  const rows = await db
    .select({ booking: bookings, slotStartsAt: availabilitySlots.startsAt })
    .from(bookings)
    .innerJoin(availabilitySlots, eq(bookings.slotId, availabilitySlots.id))
    .where(
      and(
        eq(bookings.providerProfileId, providerProfileId),
        gte(availabilitySlots.startsAt, from),
        lte(availabilitySlots.startsAt, to),
      ),
    )
    .orderBy(asc(availabilitySlots.startsAt));
  return rows.map((row) => ({ booking: row.booking, slotStartsAt: row.slotStartsAt ?? null }));
}

export interface AnchorDepositSnapshot {
  id: string;
  status: string;
  moreInfoUrl?: string | null;
  bankDetailsJson?: string | null;
  expiresAt?: number | null;
  amountIn?: string | null;
  updatedAt: number;
}

/** Story 2.4: persists the SEP-6 deposit snapshot on the booking.
 *
 * The stored `anchorDepositId` is the only link between the booking and the
 * anchor's own records, so a deposit that already completed is never
 * replaced by a different id (a later retry attempt cannot orphan the
 * transfer that actually funded the booking). Refreshing the same id is
 * always allowed. Returns `false` when the write was refused. */
export async function setAnchorDeposit(db: Db, bookingId: string, snapshot: AnchorDepositSnapshot): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({
      anchorDepositId: snapshot.id,
      anchorDepositStatus: snapshot.status,
      anchorDepositMoreInfoUrl: snapshot.moreInfoUrl ?? null,
      anchorDepositBankDetails: snapshot.bankDetailsJson ?? null,
      anchorDepositExpiresAt: snapshot.expiresAt ?? null,
      anchorDepositAmountIn: snapshot.amountIn ?? null,
      anchorDepositUpdatedAt: snapshot.updatedAt,
    })
    .where(
      and(
        eq(bookings.id, bookingId),
        or(
          isNull(bookings.anchorDepositId),
          eq(bookings.anchorDepositId, snapshot.id),
          isNull(bookings.anchorDepositStatus),
          ne(bookings.anchorDepositStatus, "completed"),
        ),
      ),
    );
  return result.changes > 0;
}

/** Story 2.4: extend the hold while a local-currency transfer is still
 * progressing -- only while `escrow_state` is still null, so a lock that
 * lands mid-poll cannot have its hold rewritten. */
export async function extendHoldExpiresAt(db: Db, bookingId: string, holdExpiresAt: number): Promise<void> {
  await db
    .update(bookings)
    .set({ holdExpiresAt })
    .where(and(eq(bookings.id, bookingId), isNull(bookings.escrowState)));
}

export async function setAnchorTrustlineTxHash(db: Db, bookingId: string, txHash: string): Promise<void> {
  await db.update(bookings).set({ anchorTrustlineTxHash: txHash }).where(eq(bookings.id, bookingId));
}

/**
 * Declines an unlocked hold: stamps `declined_at` and ends the hold at once
 * (`hold_expires_at` moves strictly before `now`), which frees the slot for
 * every availability and hold query. One conditional UPDATE, so a lock that
 * lands, a deploy that is relayed, or a second decline between the caller's
 * read and this write is a no-op. Returns `true` when the hold was declined.
 */
export async function declineBookingHold(db: Db, bookingId: string, now: number): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ declinedAt: now, holdExpiresAt: now - 1 })
    .where(
      and(
        eq(bookings.id, bookingId),
        isNull(bookings.escrowState),
        isNull(bookings.deploySubmittedAt),
        isNull(bookings.declinedAt),
      ),
    );
  return result.changes > 0;
}

/** Issue #35: marks client reminder as shown at the given timestamp. Once set,
 * never cleared, so a booking only shows its client reminder once. */
export async function markClientReminderShown(db: Db, bookingId: string, shownAt: number): Promise<void> {
  await db.update(bookings).set({ clientReminderShownAt: shownAt }).where(eq(bookings.id, bookingId));
}

/** Issue #35: marks provider reminder as shown at the given timestamp. Once set,
 * never cleared, so a booking only shows its provider reminder once. */
export async function markProviderReminderShown(db: Db, bookingId: string, shownAt: number): Promise<void> {
  await db.update(bookings).set({ providerReminderShownAt: shownAt }).where(eq(bookings.id, bookingId));
}
/**
 * Marks a booking as arrived -- the provider's record that the client showed
 * up. Succeeds (returns `true`) only once: the first call for a booking with
 * no `arrivedAt` yet set. A second call returns `false` (keeps the first
 * timestamp), and a call for a nonexistent booking also returns `false`.
 */
export async function markBookingArrived(db: Db, bookingId: string, arrivedAt: number): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ arrivedAt })
    .where(and(eq(bookings.id, bookingId), isNull(bookings.arrivedAt)));
  return result.changes > 0;
}
/** Increments `provider_profiles.verified_session_count` for `bookingId` at
 * most once, and returns whether it did. The `WHERE ... IS NULL` on the
 * marker is what enforces "the same booking cannot increase the count
 * twice" independently of any dedupe ledger. */
export function recordVerifiedSessionCountedSync(
  db: DbOrTx,
  bookingId: string,
  providerProfileId: string,
  now: number,
): boolean {
  const marked = db
    .update(bookings)
    .set({ verifiedSessionCountedAt: now })
    .where(and(eq(bookings.id, bookingId), isNull(bookings.verifiedSessionCountedAt)))
    .run();
  if (marked.changes === 0) {
    return false;
  }
  db.update(providerProfiles)
    .set({ verifiedSessionCount: sql`${providerProfiles.verifiedSessionCount} + 1` })
    .where(eq(providerProfiles.id, providerProfileId))
    .run();
  return true;
}
/** The provider-cancellation sibling of
 * {@link recordVerifiedSessionCountedSync}: increments
 * `provider_profiles.provider_cancellation_count` at most once per booking. */
/**
 * Marks a booking as arrived -- the provider's record that the client showed
 * up. Succeeds (returns `true`) only once: the first call for a booking with
 * no `arrivedAt` yet set. A second call returns `false` (keeps the first
 * timestamp), and a call for a nonexistent booking also returns `false`.
 */
export async function markBookingArrived(db: Db, bookingId: string, arrivedAt: number): Promise<boolean> {
  const result = await db
    .update(bookings)
    .set({ arrivedAt })
    .where(and(eq(bookings.id, bookingId), isNull(bookings.arrivedAt)));
  return result.changes > 0;
}

/** The provider-cancellation sibling of
 * {@link recordVerifiedSessionCountedSync}: increments
 * `provider_profiles.provider_cancellation_count` at most once per booking.
 * Only a dispute whose reason is `provider-cancel` ever calls this; a client
 * cancelling, a no-show, a plain disagreement, a refund or a release never
 * does. */
export function recordProviderCancellationCountedSync(
  db: DbOrTx,
  bookingId: string,
  providerProfileId: string,
  now: number,
): boolean {
  const marked = db
    .update(bookings)
    .set({ providerCancellationCountedAt: now })
    .where(and(eq(bookings.id, bookingId), isNull(bookings.providerCancellationCountedAt)))
    .run();
  if (marked.changes === 0) {
    return false;
  }
  db.update(providerProfiles)
    .set({ providerCancellationCount: sql`${providerProfiles.providerCancellationCount} + 1` })
    .where(eq(providerProfiles.id, providerProfileId))
    .run();
  return true;
}
