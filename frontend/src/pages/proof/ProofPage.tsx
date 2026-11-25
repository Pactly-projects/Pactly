import { useParams } from "react-router";

import { ApiError } from "../../api/client";
import { useProof } from "../../api/hooks";
import { EscrowProof } from "../../components/EscrowProof";
import { TryAmount } from "../../components/TryAmount";
import { shortenStellarId } from "../../lib/stellar";
import { formatSlotDay, formatSlotTime } from "../../lib/time";

const STATUS_LABEL: Record<"locked" | "released" | "cancelled", string> = {
  locked: "Deposit locked in escrow",
  released: "Released",
  cancelled: "Cancelled",
};

function statusTone(status: "locked" | "released" | "cancelled"): "neutral" | "positive" | "alert" {
  if (status === "released") return "positive";
  if (status === "cancelled") return "alert";
  return "neutral";
}

/**
 * Public, shareable proof for a booking whose escrow contract has been
 * deployed. No sign-in required; shows only shop, time, amount, contract id,
 * and the explorer/viewer links.
 */
export function ProofPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useProof(id);

  if (isLoading) {
    return (
      <div className="page">
        <p>Loading proof…</p>
      </div>
    );
  }

  if (error || !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="page">
        <div className="banner banner--alert">
          <p>{notFound ? "No proof is available for this booking." : "Connection dropped. Try again."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <article className="booking-card" aria-label="Booking proof">
        <header className="booking-card__header">
          <div>
            <p className="booking-card__heading">{data.shop.displayName || "Booking proof"}</p>
            {data.shop.title && <p className="booking-card__subheading">{data.shop.title}</p>}
            {data.shop.location && <p className="booking-card__subheading">{data.shop.location}</p>}
          </div>
          <span className={`state-label state-label--${statusTone(data.status)}`}>{STATUS_LABEL[data.status]}</span>
        </header>

        <p className="booking-card__appointment">
          {data.slotStartsAt !== null
            ? `${formatSlotDay(data.slotStartsAt)} · ${formatSlotTime(data.slotStartsAt)}`
            : "No appointment time on record"}
        </p>

        <dl className="booking-card__amounts">
          <div className="booking-card__amount-row">
            <dt>Deposit</dt>
            <dd className="tabular-nums">
              <TryAmount amount={data.deposit.amount} />
            </dd>
          </div>
          <div className="booking-card__amount-row">
            <dt>Contract</dt>
            <dd className="tabular-nums" title={data.contractId}>
              {shortenStellarId(data.contractId)}
            </dd>
          </div>
        </dl>

        <EscrowProof
          contractId={data.contractId}
          released={data.status === "released"}
          releaseTxHash={data.releaseTxHash}
        />
      </article>
    </div>
  );
}
