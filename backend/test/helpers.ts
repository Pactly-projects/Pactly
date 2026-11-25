/**
 * Shared fixtures for tests that need a real, migrated, temporary database
 * with a booking already on it. Not itself a test file (does not match
 * `test/*.test.ts`, so `npm run -w backend test` never runs it directly) --
 * every test file below imports from here instead of re-deriving the
 * category -> provider profile -> booking chain the schema's foreign keys
 * require.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { openDatabase, closeDatabase, type OpenDatabaseResult } from "../src/db/client.js";
import { availabilitySlots, categories, type BalanceState } from "../src/db/schema.js";
import { insertProviderProfile } from "../src/db/providerProfiles.js";
import { insertBooking } from "../src/db/bookings.js";
import type { ChainEvent, EventName } from "../src/chain/events.js";
import type { UsdcTrustlineDeps } from "../src/anchor/trustline.js";
import type { UsdcAsset } from "../src/anchor/usdc.js";

/** Issue #4: a stand-in for the anchor's own USDC, same shape
 * `app-booking-balance.test.ts`'s `FAKE_USDC` uses -- the issuer is a real
 * account id so an issuer comparison has something to compare. */
export const FAKE_USDC: UsdcAsset = {
  code: "USDC",
  issuer: "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H",
  contractId: "CUSDCFAKE00000000000000000000000000000000000000000",
};

/** A real, migrated, throwaway SQLite database -- `openDatabase(":memory:")`
 * per the story's own test convention. */
export function openTestDatabase(): OpenDatabaseResult {
  return openDatabase(":memory:");
}

export { closeDatabase };

export async function seedCategory(
  result: OpenDatabaseResult,
  id: string = randomUUID(),
  /** Story 3.3: category name search needs a distinctive name to search
   * for -- defaults to "Consulting" (every existing caller's assumption)
   * so this stays a purely additive change. */
  name: string = "Consulting",
): Promise<string> {
  await result.db.insert(categories).values({
    id,
    name,
    slug: `consulting-${id}`,
  });
  return id;
}

export interface SeedProviderProfileOptions {
  id?: string;
  categoryId?: string;
  walletAddress?: string;
  displayName?: string;
  title?: string;
  location?: string;
  /** Story 3.3: search covers this too -- most tests never need it, so it
   * defaults to `''` (the schema's own default), same as every other
   * unspecified profile column here. */
  bio?: string;
  sessionFormat?: string;
  sessionLengthMinutes?: number;
  priceAmount?: string;
  depositRateBps?: number;
  cancellationWindowHours?: number;
  minimumNoticeMinutes?: number;
  bufferMinutes?: number;
  /** Defaults to `false`, matching the real default -- a profile this
   * story creates is unapproved until Story 4.1/4.2 decides otherwise
   * (PRD Story 4.1 AC4: an unapproved profile must never appear in a
   * marketplace listing). */
  isApproved?: boolean;
}

export async function seedProviderProfile(
  result: OpenDatabaseResult,
  options: SeedProviderProfileOptions = {},
): Promise<string> {
  const id = options.id ?? randomUUID();
  const categoryId = options.categoryId ?? (await seedCategory(result));
  await insertProviderProfile(result.db, {
    id,
    walletAddress: options.walletAddress ?? `GPROVIDER${id.replace(/-/g, "").toUpperCase().slice(0, 20)}`,
    categoryId,
    displayName: options.displayName ?? "Test Provider",
    title: options.title ?? "Licensed Professional",
    location: options.location ?? "Istanbul",
    bio: options.bio ?? "",
    sessionFormat: options.sessionFormat ?? "video",
    sessionLengthMinutes: options.sessionLengthMinutes ?? 50,
    priceAmount: options.priceAmount ?? "10000000",
    depositRateBps: options.depositRateBps ?? 2000,
    cancellationWindowHours: options.cancellationWindowHours ?? 24,
    minimumNoticeMinutes: options.minimumNoticeMinutes ?? 0,
    bufferMinutes: options.bufferMinutes ?? 0,
    isApproved: options.isApproved ?? false,
    createdAt: Date.now(),
  });
  return id;
}

export interface SeedBookingOptions {
  bookingId?: string;
  providerProfileId?: string;
  /** Defaults to a fake, non-checksummed placeholder -- fine for db-layer
   * tests, which store this as plain text. A test that goes through
   * `chain/client.ts` (e.g. `lockDeposit`) needs a real Stellar strkey
   * here instead, since `Address(...)` validates it. */
  clientWalletAddress?: string;
  /** Same caveat as `clientWalletAddress`: a fake placeholder by default,
   * override with a real contract strkey for a test that reaches the
   * chain client. */
  tokenAddress?: string;
  depositAmount?: string;
  balanceAmount?: string;
  balanceState?: BalanceState;
  cancelDeadline?: number;
  slotStartsAt?: number;
}

/** 32 lowercase hex characters -- the same shape `chain/client.ts`'s
 * `BOOKING_ID_PATTERN` expects and `db/schema.ts`'s `bookings.id` stores. */
export function randomBookingId(): string {
  return randomBytes(16).toString("hex");
}

/** Seeds a category, a provider profile under it, and a booking hold row
 * referencing both -- the minimum the schema's foreign keys require before
 * the event worker can mirror any state onto a booking. Returns the
 * booking id. */
export async function seedBooking(result: OpenDatabaseResult, options: SeedBookingOptions = {}): Promise<string> {
  const bookingId = options.bookingId ?? randomBookingId();
  const providerProfileId = options.providerProfileId ?? (await seedProviderProfile(result));
  const slotId = options.slotStartsAt === undefined ? undefined : randomUUID();
  if (slotId && options.slotStartsAt !== undefined) {
    await result.db.insert(availabilitySlots).values({
      id: slotId,
      providerProfileId,
      startsAt: options.slotStartsAt,
      withdrawnAt: null,
      createdAt: Date.now(),
    });
  }
  await insertBooking(result.db, {
    id: bookingId,
    providerProfileId,
    clientWalletAddress: options.clientWalletAddress ?? `GCLIENT${bookingId.toUpperCase().slice(0, 20)}`,
    tokenAddress: options.tokenAddress ?? `CTOKEN${bookingId.toUpperCase().slice(0, 20)}`,
    depositAmount: options.depositAmount ?? "1000000",
    balanceAmount: options.balanceAmount,
    cancelDeadline: options.cancelDeadline ?? Math.floor(Date.now() / 1000) + 3600,
    ...(slotId ? { slotId } : {}),
    balanceState: options.balanceState,
    createdAt: Date.now(),
  });
  return bookingId;
}

/** Issue #4: the wallet-readiness answers the new trustline gate needs,
 * injected exactly the way `FAKE_USDC_DEPS` injects USDC discovery in
 * `app-booking-balance.test.ts` -- so a test that was already exercising
 * the deploy (or the approval) still reaches it, and a test that is
 * specifically about readiness passes the other one. Neither ever opens a
 * socket. */
export const USDC_READY_WALLET_DEPS: UsdcTrustlineDeps = {
  resolveUsdcAsset: async () => FAKE_USDC,
  hasTrustline: async () => true,
};

export const USDC_MISSING_WALLET_DEPS: UsdcTrustlineDeps = {
  resolveUsdcAsset: async () => FAKE_USDC,
  hasTrustline: async () => false,
};

/** Issue #4 edge case: "a missing Horizon answer is a retryable error, not
 * an approval" -- the same upstream failure every other network seam in
 * this backend is tested with. */
export const USDC_CHECK_UNAVAILABLE_WALLET_DEPS: UsdcTrustlineDeps = {
  resolveUsdcAsset: async () => {
    throw new Error("Could not reach tr-mock-anchor.fly.dev");
  },
};

export function fakeChainEvent(event: {
  bookingId: string;
  eventType: EventName;
  id?: string;
  ledger?: number;
  amount?: string;
}): ChainEvent {
  return {
    id: event.id ?? randomUUID(),
    ledger: event.ledger ?? 1,
    bookingId: event.bookingId,
    eventType: event.eventType,
    amount: event.amount ?? "1000000",
  };
}
