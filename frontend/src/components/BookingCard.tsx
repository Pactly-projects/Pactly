import { Link } from "react-router";

import { BookingActions } from "./BookingActions";
import { ReviewForm } from "./ReviewForm";
import { Countdown } from "./Countdown";
import { DeclineHoldButton } from "./DeclineHoldButton";
import { StateLabel } from "./StateLabel";
import { TryAmount } from "./TryAmount";
import { bookingProofUrl, buildReleaseMailto } from "../lib/releaseMailto";
import { stellarExplorerContractUrl, stellarExplorerTransactionUrl, trustlessWorkViewerUrl } from "../lib/stellar";
import { formatSlotDay, formatSlotTime } from "../lib/time";
import type { Session } from "../wallet";
import type { BalanceState, BookingLifecycle, Money, PendingActionKind, ProviderReview } from "../api/types";

export interface BookingCardProps {
  /** Which side is looking at this card -- picks the "Resolved" wording
   * (`StateLabel`), which actions this viewer may take, and nothing else;
   * the shape is otherwise identical for both. */
  viewer: "client" | "provider";
  /** Provider display name (My bookings) or a short "who booked" label
   * (the panel's Bookings view). */
  heading: string;
  /** Provider title (My bookings) or the shortened client wallet (the
   * panel's Bookings view). */
  subheading?: string;
  id: string;
  /** UTC epoch seconds -- `null` only for a pre-3.4 booking with no slot. */
  slotStartsAt: number | null;
  /** UTC epoch seconds -- dispute opening deadline calculated by the server. */
  disputeDeadline: number | null;
  /** UTC epoch seconds from the booking payload. */
  serverTime: number;
  deposit: Money;
  balance: Money;
  escrowState: "locked" | "released" | "refunded" | null;
  lifecycle: BookingLifecycle;
  /** Story 3.6 (review round): passed straight through to
   * {@link BookingActions} -- see its own doc comment. */
  pendingAction?: PendingActionKind;
  balanceState: BalanceState;
  /** UTC epoch seconds. */
  cancelDeadline: number;
  /** `"shop-closed-date"` when the shop closed this date and released this
   * unpaid hold -- shown as "no deposit was taken". */
  holdReleasedReason?: "shop-closed-date" | null;
  /** The explorer link (AC4) appears only when this exists. */
  contractId: string | null;
  /** Story 3.7: the on-chain transaction hash once the balance was paid
   * through Pactly -- drives the balance row's own "View payment record"
   * link. */
  balancePaymentTxHash: string | null;
  /** The anchor's transaction id for the local-currency deposit -- the
   * reference support needs to trace a failed or partial bank transfer.
   * Hidden when absent. */
  anchorTransactionId?: string | null;
  /** Story 3.6: the signed-in wallet's own session, passed through to
   * {@link BookingActions} -- both pages that render this card already
   * require sign-in to show anything, so this is always present whenever an
   * action could apply. `undefined` simply hides every action. */
  session?: Session;
  /** Called once an action's signed transaction has actually been relayed
   * -- the caller's own cue to refetch its list (the reconciler still needs
   * to confirm it on chain before the state label itself changes). */
  onActionSubmitted?: () => void;
  /** A 401 from any action -- the caller's own sign-out-and-prompt-again
   * flow (mirrors 3.4's `handleUnauthorized`). */
  onUnauthorized?: () => void;
  /** Held, not yet locked: resume the booking screen for this slot. */
  continueHref?: string;
  /** Optional client email — when set and the deposit is released, the
   * shop (provider) sees a mailto draft. Never required. */
  clientEmail?: string | null;
  /** Shop display name for the mailto draft body (provider view only). */
  shopName?: string;
  /** UTC epoch seconds when the shop declined this hold. */
  declinedAt?: number | null;
  /** Provider view only: shows "Decline hold" for a live, unlocked hold. */
  canDecline?: boolean;
  /** Issue #158: the shop's stored receiving address, passed through to
   * {@link BookingActions}. */
  receivingAddress?: string | null;
}

/** The balance row's own three-state wording (Epic 3 context: "Balance
 * 1,400.00 TRY · due before the session", three states) -- exported so
 * `BookingsPage.tsx`'s desktop table can render the identical wording in a
 * `<td>` instead of a card, without a second copy of this map. */
export const BALANCE_STATE_LABEL: Record<BalanceState, string> = {
  unpaid: "due before the session",
  paid_platform: "paid through Pactly",
  paid_cash: "paid in person",
};

/**
 * One booking's card (mobile-first "My bookings", and the panel's
 * `Bookings` view below 1024px). The deposit state (`StateLabel`, driven by
 * `lifecycle`) and the balance state are always two separate lines --
 * AD-3's "never merged" rule, enforced here by simply never combining them
 * into one sentence. Story 3.6's role-correct action buttons live in
 * {@link BookingActions}, shared with `BookingsPage.tsx`'s desktop table so
 * the sign-and-submit flow for every action exists in exactly one place.
 */
export function BookingCard({
  viewer,
  heading,
  subheading,
  id,
  slotStartsAt,
  disputeDeadline,
  serverTime,
  deposit,
  balance,
  escrowState,
  lifecycle,
  pendingAction,
  balanceState,
  cancelDeadline,
  holdReleasedReason,
  contractId,
  balancePaymentTxHash,
  anchorTransactionId,
  session,
  onActionSubmitted,
  onUnauthorized,
  continueHref,
  clientEmail,
  shopName,
  declinedAt,
  canDecline,
  receivingAddress,
}: BookingCardProps) {
  const declined = declinedAt != null;
  const releaseMailto =
    viewer === "provider"
      ? buildReleaseMailto({
          escrowState,
          clientEmail,
          shopName: shopName ?? "",
          slotStartsAt,
          proofUrl: bookingProofUrl(id),
        })
      : undefined;

  return (
    <article className="booking-card" id={`booking-${id}`}>
      <header className="booking-card__header">
        <div>
          <p className="booking-card__heading">{heading}</p>
          {subheading && <p className="booking-card__subheading">{subheading}</p>}
        </div>
        <StateLabel lifecycle={lifecycle} viewer={viewer} declined={declined} />
      </header>

      <p className="booking-card__appointment">
        {slotStartsAt !== null ? `${formatSlotDay(slotStartsAt)} · ${formatSlotTime(slotStartsAt)}` : "No appointment time on record"}
      </p>

      {holdReleasedReason === "shop-closed-date" && (
        <p className="booking-card__notice" role="status">
          The shop closed this date. No deposit was taken.
        </p>
      )}

      <dl className="booking-card__amounts">
        <div className="booking-card__amount-row">
          <dt>Deposit</dt>
          <dd className="tabular-nums">
            <TryAmount amount={deposit.amount} />
          </dd>
        </div>
        <div className="booking-card__amount-row">
          <dt>Balance</dt>
          <dd className="tabular-nums">
            <TryAmount amount={balance.amount} /> · {BALANCE_STATE_LABEL[balanceState]}
          </dd>
        </div>
        {anchorTransactionId && (
          <div className="booking-card__amount-row">
            <dt>Bank transfer reference</dt>
            <dd className="tabular-nums" style={{ overflowWrap: "anywhere", userSelect: "all" }}>
              {anchorTransactionId}
            </dd>
          </div>
        )}
      </dl>

      {/* Review follow-up: lives here, not in `BookingActions`, which
       * renders nothing once the booking leaves `locked` -- exactly the
       * state a settled (`released`/`refunded`) booking's own balance
       * payment needs this link to keep showing in. */}
      {balanceState === "paid_platform" && balancePaymentTxHash && (
        <a className="booking-card__explorer-link" href={stellarExplorerTransactionUrl(balancePaymentTxHash)} target="_blank" rel="noreferrer">
          View payment record
        </a>
      )}

      {!declined && <Countdown cancelDeadline={cancelDeadline} serverTime={serverTime} depositLocked={escrowState === "locked"} />}

      {continueHref && (
        <Link to={continueHref} className="button-primary" style={{ textDecoration: "none", display: "inline-flex", marginTop: "var(--space-3)" }}>
          Continue booking
        </Link>
      )}

      {contractId && (
        <a className="booking-card__explorer-link" href={stellarExplorerContractUrl(contractId)} target="_blank" rel="noreferrer">
          View escrow record
        </a>
      )}

      {contractId && (
        <a className="booking-card__explorer-link" href={trustlessWorkViewerUrl(contractId)} target="_blank" rel="noreferrer">
          View in Escrow Viewer
        </a>
      )}

      {viewer === "client" && review ? (
        <div className="booking-card__review">
          <p className="booking-card__review-heading">Your review</p>
          <p className="booking-card__review-rating">{review.rating} out of 5</p>
          {review.comment && <p className="booking-card__review-comment">{review.comment}</p>}
        </div>
      ) : null}

      {viewer === "client" && !review && escrowState === "released" && session && onReviewSubmitted ? (
        <ReviewForm bookingId={id} session={session} onReviewed={onReviewSubmitted} onUnauthorized={onUnauthorized} />
      ) : null}

      <BookingActions
        viewer={viewer}
        id={id}
        escrowState={escrowState}
        lifecycle={lifecycle}
        pendingAction={pendingAction}
        deposit={deposit}
        balance={balance}
        balanceState={balanceState}
        slotStartsAt={slotStartsAt}
        disputeDeadline={disputeDeadline}
        cancelDeadline={cancelDeadline}
        serverTime={serverTime}
        session={session}
        receivingAddress={receivingAddress}
        onActionSubmitted={onActionSubmitted}
        onUnauthorized={onUnauthorized}
      />

      {viewer === "provider" && canDecline && !declined && (
        <DeclineHoldButton id={id} session={session} onDeclined={onActionSubmitted} onUnauthorized={onUnauthorized} />
      )}

      {releaseMailto && (
        <a className="button-ghost" href={releaseMailto} style={{ marginTop: "var(--space-3)", textDecoration: "none", display: "inline-flex" }}>
          Email the client
        </a>
      )}
    </article>
  );
}
