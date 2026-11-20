/**
 * Free-cancellation timing driven by the server clock.
 *
 * The browser clock is used only to measure elapsed time since the last
 * sync. Absolute "has the deadline passed?" decisions use `serverTime` from
 * the booking payload, so a client whose clock is an hour ahead cannot keep
 * the cancel action enabled after the server deadline.
 */

export interface ServerCancelClock {
  /** UTC epoch seconds -- `bookings.cancel_deadline`. Absent/null means
   * this booking has no free-cancellation deadline to count down. */
  cancelDeadline: number | null | undefined;
  /** UTC epoch seconds from the booking payload. */
  serverTime: number;
  /** `Date.now()` when `serverTime` was received (or last resynced). */
  syncedAtMs: number;
  /** Injectable "now" for tests -- defaults to `Date.now()`. */
  nowMs?: number;
}

/** Seconds remaining until the free-cancellation deadline on the server
 * clock, or `null` when this booking has no deadline. Negative when the
 * free window has already ended. */
export function remainingFreeCancelSeconds(clock: ServerCancelClock): number | null {
  if (clock.cancelDeadline == null) {
    return null;
  }
  const nowMs = clock.nowMs ?? Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - clock.syncedAtMs) / 1000));
  const effectiveServerNow = clock.serverTime + elapsedSeconds;
  return clock.cancelDeadline - effectiveServerNow;
}

/** `true` only while a deadline exists and still lies ahead of the
 * effective server clock. */
export function isFreeCancelOpen(clock: ServerCancelClock): boolean {
  const remaining = remainingFreeCancelSeconds(clock);
  return remaining !== null && remaining > 0;
}
