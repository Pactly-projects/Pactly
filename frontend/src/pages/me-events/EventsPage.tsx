import { useEffect, useState } from "react";
import { Link } from "react-router";
import { CalendarIcon } from "@phosphor-icons/react";

import { ApiError } from "../../api/client";
import { useMyEvents } from "../../api/hooks";
import { PageMasthead } from "../../components/PageMasthead";
import { shortenStellarId } from "../../lib/stellar";
import { formatSlotDay, formatSlotTime } from "../../lib/time";
import { SignInPanel } from "../../components/SignInPanel";
import { getSession, signOut, type Session } from "../../wallet";
import type { EscrowEvent } from "../../api/types";

const EVENT_LABEL: Record<EscrowEvent["type"], string> = {
  lock: "Deposit locked",
  release: "Deposit released",
  dispute: "Dispute opened",
  resolve: "Dispute resolved",
};


export function EventsPage() {
  const [session, setSession] = useState<Session | undefined>(() => {
    try {
      return getSession();
    } catch {
      return undefined;
    }
  });
  const [sessionExpired, setSessionExpired] = useState(false);

  const eventsQuery = useMyEvents(session);

  function handleSignedIn(nextSession: Session): void {
    setSession(nextSession);
    setSessionExpired(false);
  }

  function handleSignOut(): void {
    signOut();
    setSession(undefined);
  }

  function handleUnauthorized(): void {
    signOut();
    setSession(undefined);
    setSessionExpired(true);
  }

  if (!session) {
    return (
      <div className="page">
        <PageMasthead
          eyebrow="Pactly"
          icon={<CalendarIcon size={14} weight="bold" aria-hidden="true" />}
          title="My events"
          lede="Sign in to see the lock, release, dispute and resolve events for your bookings."
        />
        {sessionExpired && (
          <div className="banner banner--alert" role="alert">
            <p>Your session ended. Sign in again to continue.</p>
          </div>
        )}
        <SignInPanel onSignedIn={handleSignedIn} onRateLimited={(waitMs) => setError(`Too many failed sign-in attempts. Please wait ${Math.ceil(waitMs / 1000)} second${Math.ceil(waitMs / 1000) !== 1 ? "s" : ""} before trying again.`)} />
      </div>
    );
  }

  const unauthorized = eventsQuery.error instanceof ApiError && eventsQuery.error.status === 401;
  useEffect(() => {
    if (unauthorized) {
      handleUnauthorized();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unauthorized]);

  if (eventsQuery.isLoading) {
    return <div className="page"><p>Loading your events…</p></div>;
  }

  if (eventsQuery.error) {
    if (unauthorized) {
      return null;
    }
    return (
      <div className="page">
        <div className="banner banner--alert" role="alert">
          <p>Connection dropped. Try again.</p>
        </div>
        <button type="button" className="button-ghost" onClick={handleSignOut} style={{ marginTop: "var(--space-4)" }}>
          Sign out
        </button>
      </div>
    );
  }

  const events = eventsQuery.data?.events ?? [];

  return (
    <div className="page">
      <PageMasthead
        eyebrow="Pactly"
        icon={<CalendarIcon size={14} weight="bold" aria-hidden="true" />}
        title="My events"
        lede="Lock, release, dispute and resolve events for your bookings, newest first."
        actions={
          <button type="button" className="button-ghost" onClick={handleSignOut}>
            Sign out
          </button>
        }
      />

      {events.length === 0 && (
        <div className="banner" role="status">
          <p>No events yet. Locking, releasing, disputing or resolving a booking adds an event here.</p>
        </div>
      )}

      {events.length > 0 && (
        <div className="booking-list">
          {events.map((event) => (
            <article key={event.id} className="booking-card">
              <header className="booking-card__header">
                <div>
                  <p className="booking-card__heading">{EVENT_LABEL[event.type]}</p>
                  <p className="booking-card__subheading">
                    Booking {shortenStellarId(event.bookingId)} · {formatSlotDay(event.createdAt)} · {formatSlotTime(event.createdAt)}
                  </p>
                </div>
              </header>
              <p>
                Recorded for <b>{shortenStellarId(event.walletAddress)}</b>.
              </p>
              <div className="booking-card__actions">
                <Link to="/me/bookings" className="button-ghost">
                  Open My bookings
                </Link>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
