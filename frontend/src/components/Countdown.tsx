import { useEffect, useState } from "react";

import { remainingFreeCancelSeconds } from "../lib/serverCancel";

export interface CountdownProps {
  /** UTC epoch seconds -- `bookings.cancel_deadline`. Absent/null means
   * this booking has no free-cancellation deadline; no countdown is shown. */
  cancelDeadline: number | null | undefined;
  /** UTC epoch seconds from the booking payload. Required whenever a
   * deadline is present -- the countdown is computed from this and
   * `cancelDeadline`, not from the browser clock alone. */
  serverTime: number | undefined;
  /** Free-cancellation copy only applies once the deposit is actually in
   * escrow. A hold with no lock has nothing to refund yet. */
  depositLocked?: boolean;
}

/** Turns `alert` under six hours -- the spec's own "Always" rule. */
const ALERT_THRESHOLD_SECONDS = 6 * 60 * 60;

/** "No more than one announcement per minute" (the spec's own "Always"
 * rule) -- the countdown's own text only changes on this tick, so the
 * `aria-live="polite"` region it lives in is never updated more often than
 * this. */
const TICK_MS = 60_000;

function formatDurationLabel(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${Math.max(minutes, 0)}m`;
}

/**
 * The free-cancellation countdown (Boundaries & Constraints): "Free
 * cancellation · 2d 19h" while time remains, an alert tone under six hours,
 * and "Window closed" plus the policy consequence once the deadline has
 * passed -- worded so it never claims any money has actually moved, since
 * automatic policy enforcement is not something this backend does (Epic 3
 * context: "Nothing here is automatic").
 *
 * Remaining time is `cancelDeadline - (serverTime + elapsedSinceSync)`.
 * Each refetch supplies a fresh `serverTime`, which resyncs the offset.
 */
export function Countdown({ cancelDeadline, serverTime, depositLocked = true }: CountdownProps) {
  const [syncedAtMs, setSyncedAtMs] = useState(() => Date.now());
  const [, setTick] = useState(0);

  // Resync the local elapsed baseline whenever the server clock (or
  // deadline) arrives or is refreshed from a refetch.
  useEffect(() => {
    setSyncedAtMs(Date.now());
  }, [serverTime, cancelDeadline]);

  useEffect(() => {
    const interval = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(interval);
  }, []);

  if (!depositLocked) {
    return (
      <p className="countdown" aria-live="polite">
        Slot held · the deposit is not locked yet, so there is nothing to cancel. Continue to pay, or let this hold expire.
      </p>
    );
  }

  if (cancelDeadline == null || serverTime == null) {
    return null;
  }

  const secondsLeft = remainingFreeCancelSeconds({
    cancelDeadline,
    serverTime,
    syncedAtMs,
  });

  if (secondsLeft === null) {
    return null;
  }

  if (secondsLeft <= 0) {
    return (
      <p className="countdown countdown--alert" aria-live="polite">
        Window closed · the free-cancellation window has ended. A cancellation now follows this booking's resolution policy, not an
        automatic refund
      </p>
    );
  }

  const alert = secondsLeft < ALERT_THRESHOLD_SECONDS;
  return (
    <p className={`countdown tabular-nums${alert ? " countdown--alert" : ""}`} aria-live="polite">
      Free cancellation · {formatDurationLabel(secondsLeft)}
    </p>
  );
}
