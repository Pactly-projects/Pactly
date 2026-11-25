import { useEffect, useState } from "react";

import type { Money } from "../api/types";
import { lockButtonLabel } from "../lib/lockDeposit";

export interface LockButtonProps {
  /** `undefined` when idle (ready to tap); the human action name while
   * waiting on a signature -- "Create your escrow", "Lock your deposit"
   * (EXPERIENCE.md: "Each request explains the human action ... not the
   * transaction primitive"). */
  waitingOn?: string;
  /** Issue #5: once a deploy is confirmed there is no second deploy to
   * offer -- what waits on the client is funding the escrow that already
   * exists, so the button says that instead. Defaults to DESIGN.md's own
   * "Lock with Pactly". */
  actionLabel?: string;
  /** Issue #178: the deposit from the server's booking response, shown on
   * the button in USDC. While it is missing the button stays disabled, so
   * the wallet never opens without an amount the client has seen. */
  deposit?: Money;
  disabled?: boolean;
  onClick: () => void;
  /** Fires when the user taps "Try again" after the 60s timeout --
   * re-runs the same signature request. Kept under its historical name so
   * every caller keeps compiling. */
  onOpenWalletAgain?: () => void;
}

const RETRY_AFTER_MS = 60_000;

/**
 * DESIGN.md's `button-escrow`: the only black button in the product, used
 * solely to lock a deposit. While the deposit is being signed and sent it
 * reads "Locking…" (never a generic "Loading…") with the human action name
 * beneath it, and after 60 seconds a "Try again" option appears
 * (EXPERIENCE.md's waiting-state pattern) in case the request was lost on
 * the way. Signing happens server-side now -- there is no prompt for the
 * user to find and approve.
 */
export function LockButton({ waitingOn, actionLabel, deposit, disabled, onClick, onOpenWalletAgain }: LockButtonProps) {
  const [showTryAgain, setShowTryAgain] = useState(false);

  useEffect(() => {
    if (!waitingOn) {
      setShowTryAgain(false);
      return;
    }
    const timer = setTimeout(() => setShowTryAgain(true), RETRY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waitingOn]);

  const label = waitingOn ? "Locking…" : lockButtonLabel(deposit);

  return (
    <div className="lock-button-group">
      <button
        type="button"
        className="button-escrow"
        disabled={disabled || Boolean(waitingOn) || !deposit}
        onClick={onClick}
        aria-live="polite"
        aria-label={label}
      >
        {label}
      </button>
      {waitingOn && <p className="lock-button-group__hint">{waitingOn}</p>}
      {waitingOn && showTryAgain && (
        <button type="button" className="button-ghost lock-button-group__retry" onClick={onOpenWalletAgain} aria-label="Try again">
          Try again
        </button>
      )}
    </div>
  );
}
