import { useState } from "react";
import { Link } from "react-router";
import { StorefrontIcon } from "@phosphor-icons/react";

import { ApiError } from "../../api/client";
import { useOwnProviderProfile, useProviderBookings } from "../../api/hooks";
import { BookingActions } from "../../components/BookingActions";
import { BookingCard, BALANCE_STATE_LABEL } from "../../components/BookingCard";
import { Countdown } from "../../components/Countdown";
import { DeclineHoldButton } from "../../components/DeclineHoldButton";
import { PageMasthead } from "../../components/PageMasthead";
import { StateLabel } from "../../components/StateLabel";
import { TryAmount } from "../../components/TryAmount";
import { bookingProofUrl, buildReleaseMailto } from "../../lib/releaseMailto";
import { shortenStellarId, stellarExplorerContractUrl, stellarExplorerTransactionUrl, trustlessWorkViewerUrl } from "../../lib/stellar";
import { formatSlotDay, formatSlotTime } from "../../lib/time";
import { SignInPanel } from "../../components/SignInPanel";
import { getSession, signOut, type Session } from "../../wallet";
import type { ProviderBookingListItem } from "../../api/types";

function ReleaseMailtoLink({
  escrowState,
  clientEmail,
  shopName,
  slotStartsAt,
  bookingId,
}: {
  escrowState: ProviderBookingListItem["escrowState"];
  clientEmail: string | null;
  shopName: string;
  slotStartsAt: number | null;
  bookingId: string;
}) {
  const mailto = buildReleaseMailto({
    escrowState,
    clientEmail,
    shopName,
    slotStartsAt,
    proofUrl: bookingProofUrl(bookingId),
  });
  if (!mailto) return null;
  return (
    <a className="button-ghost" href={mailto} style={{ textDecoration: "none", display: "inline-flex", marginTop: "var(--space-2)" }}>
      Email the client
    </a>
  );
}

/** A shop can decline only a live hold that has not locked yet. */
function canDeclineHold(booking: ProviderBookingListItem): boolean {
  return booking.escrowState === null && booking.declinedAt === null && !booking.isExpiredHold;
}

/**
 * `/panel/bookings` -- the provider panel's own "Bookings" view (Task
 * list): every booking against the caller's own provider profile, a table
 * at >=1024px and cards below (DESIGN.md: "Provider panel: desktop-first,
 * table layout. On mobile the table becomes a card list."). Both markups
 * render the same data; only CSS decides which one shows at a given width,
 * so there is exactly one source of truth for the list itself.
 */
export function BookingsPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());

  const bookingsQuery = useProviderBookings(session);
  const ownProfileQuery = useOwnProviderProfile(session);
  const shopName = ownProfileQuery.data?.displayName ?? "";

  function handleSignOut(): void {
    signOut();
    setSession(undefined);
  }

  if (!session) {
    return (
      <div className="page">
        <PageMasthead
          eyebrow="Provider panel"
          icon={<StorefrontIcon size={14} weight="bold" aria-hidden="true" />}
          title="Bookings"
          lede="Sign in to see your incoming bookings."
        />
        <SignInPanel onSignedIn={setSession} onRateLimited={(waitMs) => setError(`Too many failed sign-in attempts. Please wait ${Math.ceil(waitMs / 1000)} second${Math.ceil(waitMs / 1000) !== 1 ? "s" : ""} before trying again.`)} />
      </div>
    );
  }

  if (bookingsQuery.isLoading) {
    return (
      <div className="page">
        <p>Loading your bookings…</p>
      </div>
    );
  }

  if (bookingsQuery.error) {
    const notAProvider = bookingsQuery.error instanceof ApiError && bookingsQuery.error.code === "NOT_A_PROVIDER";
    return (
      <div className="page">
        <div className="banner" role="status">
          <p>{notAProvider ? "This account doesn't have a provider profile yet." : "Connection dropped. Try again."}</p>
          {notAProvider && (
            <Link to="/providers/apply" className="button-primary" style={{ textDecoration: "none", marginTop: "var(--space-3)" }}>
              List your shop
            </Link>
          )}
        </div>
        <button type="button" className="button-ghost" onClick={handleSignOut} style={{ marginTop: "var(--space-4)" }}>
          Sign out
        </button>
      </div>
    );
  }

  const bookings = bookingsQuery.data?.bookings ?? [];
  const active = bookings.filter((booking) => !booking.isExpiredHold);
  const expired = bookings.filter((booking) => booking.isExpiredHold);

  return (
    <div className="page">
      <PageMasthead
        eyebrow="Provider panel"
        icon={<StorefrontIcon size={14} weight="bold" aria-hidden="true" />}
        title="Bookings"
        actions={
          <>
            <Link to="/panel/availability">Availability &amp; rules</Link>
            <Link to="/panel/cash-out">Cash out</Link>
            <button type="button" className="button-ghost" onClick={handleSignOut}>
              Sign out
            </button>
          </>
        }
      />

      {active.length === 0 && (
        <div className="banner" role="status">
          <p>No bookings yet.</p>
        </div>
      )}

      {active.length > 0 && (
        <>
          <div className="bookings-table-wrap">
            <table className="bookings-table">
              <thead>
                <tr>
                  <th>Appointment</th>
                  <th>Client id</th>
                  <th>Deposit</th>
                  <th>Balance</th>
                  <th>State</th>
                  <th>Free cancellation</th>
                  <th>Records</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {active.map((booking) => (
                  <tr key={booking.id}>
                    <td>
                      {booking.slotStartsAt !== null
                        ? `${formatSlotDay(booking.slotStartsAt)} · ${formatSlotTime(booking.slotStartsAt)}`
                        : "—"}
                    </td>
                    <td className="tabular-nums">{shortenStellarId(booking.clientWalletAddress)}</td>
                    <td className="tabular-nums">
                      <TryAmount amount={booking.deposit.amount} />
                      {booking.anchorTransactionId && (
                        <div style={{ overflowWrap: "anywhere", userSelect: "all" }} title="Bank transfer reference">
                          Ref: {booking.anchorTransactionId}
                        </div>
                      )}
                    </td>
                    <td className="tabular-nums">
                      <TryAmount amount={booking.balance.amount} /> · {BALANCE_STATE_LABEL[booking.balanceState]}
                      {/* Review follow-up: lives in this cell, not
                       * `BookingActions`'s own Actions column, which renders
                       * nothing once the booking leaves `locked` -- exactly
                       * the state a settled booking's own link must keep
                       * showing in. */}
                      {booking.balanceState === "paid_platform" && booking.balancePaymentTxHash && (
                        <>
                          {" · "}
                          <a href={stellarExplorerTransactionUrl(booking.balancePaymentTxHash)} target="_blank" rel="noreferrer">
                            View payment record
                          </a>
                        </>
                      )}
                    </td>
                    <td>
                      <StateLabel lifecycle={booking.lifecycle} viewer="provider" declined={booking.declinedAt !== null} />
                    </td>
                    <td>
                      <Countdown
                        cancelDeadline={booking.cancelDeadline}
                        serverTime={booking.serverTime}
                        depositLocked={booking.escrowState === "locked"}
                      />
                    </td>
                    <td>
                      {booking.contractId && (
                        <>
                          <a href={stellarExplorerContractUrl(booking.contractId)} target="_blank" rel="noreferrer">
                            View escrow record
                          </a>
                          {" · "}
                          <a href={trustlessWorkViewerUrl(booking.contractId)} target="_blank" rel="noreferrer">
                            Escrow Viewer
                          </a>
                        </>
                      )}
                    </td>
                    <td>
                      <BookingActions
                        viewer="provider"
                        id={booking.id}
                        escrowState={booking.escrowState}
                        lifecycle={booking.lifecycle}
                        pendingAction={booking.pendingAction}
                        deposit={booking.deposit}
                        balance={booking.balance}
                        balanceState={booking.balanceState}
                        slotStartsAt={booking.slotStartsAt}
                        disputeDeadline={booking.disputeDeadline}
                        cancelDeadline={booking.cancelDeadline}
                        serverTime={booking.serverTime}
                        session={session}
                        receivingAddress={booking.receivingAddress}
                        onActionSubmitted={() => bookingsQuery.refetch()}
                        onUnauthorized={handleSignOut}
                      />
                      {canDeclineHold(booking) && (
                        <DeclineHoldButton
                          id={booking.id}
                          session={session}
                          onDeclined={() => bookingsQuery.refetch()}
                          onUnauthorized={handleSignOut}
                        />
                      )}
                      <ReleaseMailtoLink
                        escrowState={booking.escrowState}
                        clientEmail={booking.clientEmail}
                        shopName={shopName}
                        slotStartsAt={booking.slotStartsAt}
                        bookingId={booking.id}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="booking-list bookings-cards">
            {active.map((booking) => (
              <BookingCard
                key={booking.id}
                viewer="provider"
                id={booking.id}
                heading="Client id"
                subheading={shortenStellarId(booking.clientWalletAddress)}
                slotStartsAt={booking.slotStartsAt}
                disputeDeadline={booking.disputeDeadline}
                deposit={booking.deposit}
                balance={booking.balance}
                escrowState={booking.escrowState}
                lifecycle={booking.lifecycle}
                pendingAction={booking.pendingAction}
                balanceState={booking.balanceState}
                cancelDeadline={booking.cancelDeadline}
                serverTime={booking.serverTime}
                contractId={booking.contractId}
                balancePaymentTxHash={booking.balancePaymentTxHash}
                anchorTransactionId={booking.anchorTransactionId}
                session={session}
                onActionSubmitted={() => bookingsQuery.refetch()}
                onUnauthorized={handleSignOut}
                clientEmail={booking.clientEmail}
                shopName={shopName}
                declinedAt={booking.declinedAt}
                canDecline={canDeclineHold(booking)}
              />
            ))}
          </div>
        </>
      )}

      {expired.length > 0 && (
        <details className="expired-holds">
          <summary>Expired holds ({expired.length})</summary>
          <div className="booking-list">
            {expired.map((booking) => (
              <BookingCard
                key={booking.id}
                viewer="provider"
                id={booking.id}
                heading="Client id"
                subheading={shortenStellarId(booking.clientWalletAddress)}
                slotStartsAt={booking.slotStartsAt}
                disputeDeadline={booking.disputeDeadline}
                deposit={booking.deposit}
                balance={booking.balance}
                escrowState={booking.escrowState}
                lifecycle={booking.lifecycle}
                pendingAction={booking.pendingAction}
                balanceState={booking.balanceState}
                cancelDeadline={booking.cancelDeadline}
                serverTime={booking.serverTime}
                contractId={booking.contractId}
                balancePaymentTxHash={booking.balancePaymentTxHash}
                anchorTransactionId={booking.anchorTransactionId}
                session={session}
                onActionSubmitted={() => bookingsQuery.refetch()}
                onUnauthorized={handleSignOut}
                clientEmail={booking.clientEmail}
                shopName={shopName}
                declinedAt={booking.declinedAt}
              />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
