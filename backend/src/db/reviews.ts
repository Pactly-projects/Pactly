/**
 * Story 4.4 / issue #3: the one-review-per-booking rows. The schema's own
 * unique `booking_id` is the database-level guarantee; `services/reviews.ts`
 * is the layer that turns it into the route's own `409` and enforces the
 * "released booking, client only" preconditions, so nothing here decides
 * who may write a review.
 */
import { and, desc, eq, inArray } from "drizzle-orm";

import type { Db } from "./client.js";
import { bookings, reviews } from "./schema.js";

export type ReviewRow = typeof reviews.$inferSelect;

export interface NewReview {
  id: string;
  bookingId: string;
  clientWalletAddress: string;
  rating: number;
  comment: string;
  createdAt: number;
}

export async function getReviewByBookingId(db: Db, bookingId: string): Promise<ReviewRow | undefined> {
  const rows = await db.select().from(reviews).where(eq(reviews.bookingId, bookingId)).limit(1);
  return rows[0];
}

/** One query for a whole list of bookings -- the status lists' own N+1
 * avoidance, keyed by booking id. */
export async function getReviewsForBookings(db: Db, bookingIds: string[]): Promise<Map<string, ReviewRow>> {
  if (bookingIds.length === 0) return new Map();
  const rows = await db.select().from(reviews).where(inArray(reviews.bookingId, bookingIds));
  return new Map(rows.map((row) => [row.bookingId, row]));
}

export async function insertReview(db: Db, values: NewReview): Promise<void> {
  await db.insert(reviews).values(values);
}

export interface ProviderReviewRow {
  id: string;
  bookingId: string;
  rating: number;
  comment: string;
  createdAt: number;
}

/** The one HTTP-facing review shape -- shared by the provider profile's
 * public list, the booking status lists and `GET /bookings/:id`, so they can
 * never drift apart. */
export type ReviewView = ProviderReviewRow;

export function toReviewView(row: ProviderReviewRow): ReviewView {
  return { id: row.id, bookingId: row.bookingId, rating: row.rating, comment: row.comment, createdAt: row.createdAt };
}

/** Every review for a provider's bookings, newest first. Joined through
 * `bookings` so a review can never be listed against a provider it does not
 * belong to, and so the row carries the booking id a reader can link to. */
export async function listReviewsForProvider(db: Db, providerProfileId: string): Promise<ProviderReviewRow[]> {
  const rows = await db
    .select({
      id: reviews.id,
      bookingId: reviews.bookingId,
      rating: reviews.rating,
      comment: reviews.comment,
      createdAt: reviews.createdAt,
    })
    .from(reviews)
    .innerJoin(bookings, eq(reviews.bookingId, bookings.id))
    .where(and(eq(bookings.providerProfileId, providerProfileId)))
    .orderBy(desc(reviews.createdAt), desc(reviews.id));
  return rows;
}
