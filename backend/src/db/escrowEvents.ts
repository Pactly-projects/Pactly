/**
 * Issue #31: one in-app event row per party per booking-level action
 * (lock, release, dispute, resolve). Each party has a page of their own
 * events, newest first, linking to the booking. A party never sees the
 * other party's events for a booking they are not in -- reads are scoped by
 * `wallet_address` and the caller must already establish the wallet belongs
 * to the booking (the routes do that via `getBookingForClient` /
 * `getBookingForProvider` / `getBookingForClientOrProvider`).
 */
import { randomBytes } from "node:crypto";

import { desc, and, eq, inArray } from "drizzle-orm";

import type { Db } from "./client.js";
import { escrowEvents } from "./schema.js";

export type EscrowEventType = "lock" | "release" | "dispute" | "resolve";

export interface NewEscrowEvent {
  bookingId: string;
  walletAddress: string;
  type: EscrowEventType;
  /** UTC epoch seconds. */
  createdAt: number;
}

export type EscrowEventRow = typeof escrowEvents.$inferSelect;

/** Records one event row for one party on one booking. Callers insert one
 * row per party (client and provider) whenever a lock, release, dispute or
 * resolve happens on a booking, so each side's own page lists it. */
export async function recordEscrowEvent(db: Db, values: NewEscrowEvent): Promise<void> {
  await db.insert(escrowEvents).values({
    id: randomBytes(16).toString("hex"),
    bookingId: values.bookingId,
    walletAddress: values.walletAddress,
    type: values.type,
    createdAt: values.createdAt,
  });
}

/** Records one event row for each party (the booking's client wallet and
 * its provider wallet) on one booking, so both sides see it on their own
 * event list. */
export async function recordEscrowEventForBothParties(
  db: Db,
  bookingId: string,
  clientWalletAddress: string,
  providerWalletAddress: string,
  type: EscrowEventType,
  createdAt: number,
): Promise<void> {
  await recordEscrowEvent(db, { bookingId, walletAddress: clientWalletAddress, type, createdAt });
  await recordEscrowEvent(db, { bookingId, walletAddress: providerWalletAddress, type, createdAt });
}

/** Every event row visible to `walletAddress` on the bookings that wallet
 * is a party to, newest first. The caller resolves which bookings the
 * wallet may see (client bookings or provider bookings) before calling; this
 * function only filters rows to that wallet and to the given booking ids. */
export async function listEscrowEventsForParties(
  db: Db,
  walletAddress: string,
  bookingIds: string[],
): Promise<EscrowEventRow[]> {
  if (bookingIds.length === 0) return [];
  return db
    .select()
    .from(escrowEvents)
    .where(and(inArray(escrowEvents.bookingId, bookingIds), eq(escrowEvents.walletAddress, walletAddress)))
    .orderBy(desc(escrowEvents.createdAt));
}

export async function getEscrowEventsForBooking(
  db: Db,
  bookingId: string,
  walletAddress: string,
): Promise<EscrowEventRow[]> {
  return db
    .select()
    .from(escrowEvents)
    .where(and(eq(escrowEvents.bookingId, bookingId), eq(escrowEvents.walletAddress, walletAddress)))
    .orderBy(desc(escrowEvents.createdAt));
}
