/**
 * Story 4.4 / issue #3: one verified review per released booking.
 *
 * The reviewer is always the booking's own client, resolved from the
 * caller's wallet (never from a body field), and only a booking whose
 * deposit was released can be reviewed. The rest of the statuses -- open,
 * disputed, refunded, cancelled -- are refused before anything is written.
 */
import { randomUUID } from "node:crypto";

import {
  getReviewByBookingId,
  insertReview,
  listReviewsForProvider,
  toReviewView,
  type ReviewView,
} from "../db/reviews.js";
import type { Db } from "../db/client.js";
import { getBookingForClient, BookingEscrowStateError } from "./booking.js";

/** How long a review's comment may be, stated in the validation error so a
 * caller never has to guess. */
export const MAX_REVIEW_COMMENT_LENGTH = 500;
const MIN_RATING = 1;
const MAX_RATING = 5;

export type { ReviewView };

export class ReviewExistsError extends Error {
  constructor(message = "This booking already has a review. You can only review it once.") {
    super(message);
    this.name = "ReviewExistsError";
  }
}

export class InvalidReviewError extends Error {
  readonly details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("One or more review values are invalid.");
    this.name = "InvalidReviewError";
    this.details = details;
  }
}

export function validateReviewInput(input: { rating: unknown; comment: unknown }): Record<string, string> {
  const details: Record<string, string> = {};
  if (
    typeof input.rating !== "number" ||
    !Number.isInteger(input.rating) ||
    input.rating < MIN_RATING ||
    input.rating > MAX_RATING
  ) {
    details.rating = `Rating must be a whole number from ${MIN_RATING} to ${MAX_RATING}.`;
  }
  if (typeof input.comment !== "string") {
    details.comment = `Comment must be text of at most ${MAX_REVIEW_COMMENT_LENGTH} characters.`;
  } else if (input.comment.trim().length > MAX_REVIEW_COMMENT_LENGTH) {
    details.comment = `Comment must be ${MAX_REVIEW_COMMENT_LENGTH} characters or fewer.`;
  }
  return details;
}

export interface CreateReviewInput {
  rating: unknown;
  comment: unknown;
}

/** `POST /bookings/:id/review`: the booking's own client, on a released
 * booking, once. A different wallet or a missing booking is the same
 * `404 BOOKING_NOT_FOUND` every other ownership check gives. */
export async function createReview(
  db: Db,
  bookingId: string,
  walletAddress: string,
  input: CreateReviewInput,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ReviewView> {
  const booking = await getBookingForClient(db, bookingId, walletAddress);

  if (booking.escrowState !== "released") {
    throw new BookingEscrowStateError("Only a booking whose deposit was released can be reviewed.");
  }

  const details = validateReviewInput(input);
  if (Object.keys(details).length > 0) {
    throw new InvalidReviewError(details);
  }

  const existing = await getReviewByBookingId(db, bookingId);
  if (existing) {
    throw new ReviewExistsError();
  }

  const id = randomUUID();
  const comment = (input.comment as string).trim();
  await insertReview(db, {
    id,
    bookingId,
    clientWalletAddress: walletAddress,
    rating: input.rating as number,
    comment,
    createdAt: now,
  });
  return { id, bookingId, rating: input.rating as number, comment, createdAt: now };
}

/** The public profile's review list -- newest first, with the booking id a
 * reader can link back to. */
export async function getProviderReviews(db: Db, providerProfileId: string): Promise<ReviewView[]> {
  const rows = await listReviewsForProvider(db, providerProfileId);
  return rows.map(toReviewView);
}
