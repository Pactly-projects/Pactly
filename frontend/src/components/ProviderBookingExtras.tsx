import { useState } from "react";

import { ApiError } from "../api/client";
import { correctInPersonBalance } from "../api/hooks";
import type { InPersonBalance, IntakeAnswer } from "../api/types";
import { formatMoney, parseDecimalToSmallestUnit, smallestUnitToDecimalInput } from "../lib/money";
import type { Session } from "../wallet";
import { displayAnswer, isBlankAnswer } from "../lib/intakeAnswers";

export interface ProviderBookingExtrasProps {
  bookingId: string;
  escrowState: "locked" | "released" | "refunded" | null;
  intakeAnswers: IntakeAnswer[];
  inPersonBalance: InPersonBalance | null;
  session: Session;
  onChanged: () => void;
  onUnauthorized: () => void;
}

/**
 * The shop's private extras on one booking in its own panel:
 *
 * - Issue #146: the client's intake answers. A blank answer is shown as
 *   "Not answered" under its question, never left out.
 * - Issue #149: the in-person balance recorded on a cancelled booking. The
 *   shop may correct it once; the first figure then stays visible, struck
 *   through and marked as replaced, and no second correction is offered.
 */
export function ProviderBookingExtras({
  bookingId,
  escrowState,
  intakeAnswers,
  inPersonBalance,
  session,
  onChanged,
  onUnauthorized,
}: ProviderBookingExtrasProps) {
  if (intakeAnswers.length === 0 && !inPersonBalance) {
    return null;
  }
  return (
    <div className="provider-booking-extras">
      {intakeAnswers.length > 0 && (
        <dl className="intake-answers__list">
          {intakeAnswers.map((entry) => (
            <div key={entry.questionId}>
              <dt>{entry.label}</dt>
              <dd className={isBlankAnswer(entry.answer) ? "intake-answers__blank" : undefined}>{displayAnswer(entry.answer)}</dd>
            </div>
          ))}
        </dl>
      )}
      {inPersonBalance && (
        <InPersonBalanceRow
          bookingId={bookingId}
          canCorrect={escrowState === "refunded" && inPersonBalance.correctedAt === null}
          inPersonBalance={inPersonBalance}
          session={session}
          onChanged={onChanged}
          onUnauthorized={onUnauthorized}
        />
      )}
    </div>
  );
}

function InPersonBalanceRow({
  bookingId,
  canCorrect,
  inPersonBalance,
  session,
  onChanged,
  onUnauthorized,
}: {
  bookingId: string;
  canCorrect: boolean;
  inPersonBalance: InPersonBalance;
  session: Session;
  onChanged: () => void;
  onUnauthorized: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(() => smallestUnitToDecimalInput(inPersonBalance.amount.amount));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function handleSubmit(): Promise<void> {
    const amount = parseDecimalToSmallestUnit(value);
    if (amount === undefined) {
      setError("Enter the amount as a number, e.g. 12.50.");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await correctInPersonBalance(bookingId, amount, session);
      setEditing(false);
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        onUnauthorized();
        return;
      }
      if (caught instanceof ApiError && caught.code === "ALREADY_CORRECTED") {
        setEditing(false);
        onChanged();
      }
      setError(caught instanceof ApiError && caught.message ? caught.message : "Couldn't save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="in-person-balance">
      <p>
        <span>Balance settled in person: </span>
        <strong className="tabular-nums">{formatMoney(inPersonBalance.amount.amount, inPersonBalance.amount.asset)}</strong>
        {inPersonBalance.replaced && (
          <>
            {" "}
            <span className="in-person-balance__replaced">
              (replaced <s className="tabular-nums">{formatMoney(inPersonBalance.replaced.amount, inPersonBalance.replaced.asset)}</s>)
            </span>
          </>
        )}
      </p>
      {canCorrect && !editing && (
        <button type="button" className="button-ghost" onClick={() => setEditing(true)}>
          Correct this figure
        </button>
      )}
      {canCorrect && editing && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <label>
            <span>Corrected amount ({inPersonBalance.amount.asset})</span>
            <input type="text" inputMode="decimal" value={value} onChange={(event) => setValue(event.target.value)} disabled={saving} />
          </label>
          <p className="lock-button-group__hint">You can correct this once. The current figure will be kept as replaced.</p>
          <button type="submit" className="button-secondary" disabled={saving}>
            {saving ? "Saving…" : "Save correction"}
          </button>
          <button type="button" className="button-ghost" onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </button>
        </form>
      )}
      {error && (
        <p className="escrow-lane__notice escrow-lane__notice--alert" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
