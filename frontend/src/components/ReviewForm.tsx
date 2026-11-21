import { useState } from "react";

import { ApiError } from "../api/client";
import { createBookingReview } from "../api/hooks";
import type { ProviderReview } from "../api/types";
import { signOut, type Session } from "../wallet";

/** Mirrors the backend's own cap (`services/reviews.ts`) so the counter and
 * the error sentence agree. */
const MAX_COMMENT_LENGTH = 500;

export interface ReviewFormProps {
  bookingId: string;
  session: Session;
  /** Called once the review is saved -- the caller's own cue to refetch its
   * list (so the profile shows it and this form disappears). */
  onReviewed: (review: ProviderReview) => void;
  onUnauthorized?: () => void;
}

/** Issue #3: the client's one review, shown on a released booking's card.
 * Plain language only, no wallet vocabulary; the second-submit refusal comes
 * from the backend (`REVIEW_EXISTS`) rather than being guessed here. */
export function ReviewForm({ bookingId, session, onReviewed, onUnauthorized }: ReviewFormProps) {
  const [rating, setRating] = useState(5);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; alert?: boolean } | undefined>();

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setNotice(undefined);
    try {
      const { review } = await createBookingReview(bookingId, rating, comment, session);
      onReviewed(review);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        signOut();
        onUnauthorized?.();
        return;
      }
      setNotice({
        text: error instanceof ApiError ? error.message : "Connection dropped. Nothing changed.",
        alert: true,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="booking-card__review-form">
      <p className="booking-card__review-heading">How was your appointment?</p>
      <label className="booking-card__review-field">
        <span>Rating</span>
        <select value={rating} onChange={(event) => setRating(Number(event.target.value))} disabled={busy}>
          {[5, 4, 3, 2, 1].map((value) => (
            <option key={value} value={value}>
              {value} out of 5
            </option>
          ))}
        </select>
      </label>
      <label className="booking-card__review-field">
        <span>A short comment (optional)</span>
        <textarea
          value={comment}
          maxLength={MAX_COMMENT_LENGTH}
          rows={3}
          placeholder="What should the next client know?"
          onChange={(event) => setComment(event.target.value)}
          disabled={busy}
        />
        <span className="booking-card__review-count">
          {comment.length}/{MAX_COMMENT_LENGTH}
        </span>
      </label>
      <button type="button" className="button-primary" disabled={busy} onClick={() => void submit()}>
        {busy ? "Saving…" : "Leave a review"}
      </button>
      {notice && (
        <p className={`booking-card__notice${notice.alert ? " booking-card__notice--alert" : ""}`} aria-live="polite">
          {notice.text}
        </p>
      )}
    </div>
  );
}
