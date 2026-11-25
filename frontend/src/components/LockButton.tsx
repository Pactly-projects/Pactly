import { useEffect, useState } from "react";

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
  /** Issue #178: the deposit amount the server returned for this booking,
   * in USDC (integer string, smallest unit). Shown on the button so the
   * client sees the exact figure the server will lock, not a number
   * computed in the browser. When missing, the button disables itself and
   * the wallet never opens. */
  depositAmount?: string;
  disabled?: boolean;
  onClick: () => void;
  /** Fires when the user taps "Try again" after the 60s timeout --
   * re-runs the same signature request. Kept under its historical name so
   * every caller keeps compiling. */
  onOpenWalletAgain?: () => void;
}

const RETRY_AFTER_MS = 60_000;

/** Formats an integer-string USDC amount (smallest unit, 7 decimals) into
 * a human-readable label like "2.00 USDC". */
export function isUsableDepositAmount(amount: string | undefined): amount is string {
  return typeof amount === "string" && /^\d+$/.test(amount);
}

export function formatUsdc(amount: string): string {
  if (!isUsableDepositAmount(amount)) throw new TypeError("Invalid USDC amount");
  const raw = BigInt(amount);
  const whole = raw / 10_000_000n;
  const frac = raw % 10_000_000n;
  const fracStr = frac.toString().padStart(7, "0").replace(/0+$/, "") || "0";
  // Show at most 2 decimal places for a clean label, unless trailing
  // precision matters (e.g. "1.5000001").
  const shortFrac = fracStr.length <= 2 ? fracStr.padEnd(2, "0") : fracStr;
  return `${whole}.${shortFrac} USDC`;
}

/**
 * DESIGN.md's `button-escrow`: the only black button in the product, used
 * solely to lock a deposit. While the deposit is being signed and sent it
 * reads "Locking…" (never a generic "Loading…") with the human action name
 * beneath it, and after 60 seconds a "Try again" option appears
 * (EXPERIENCE.md's waiting-state pattern) in case the request was lost on
 * the way. Signing happens server-side now -- there is no prompt for the
 * user to find and approve.
 *
 * Issue #178: the button now shows the server deposit amount ("Lock 2.00
 * USDC with Pactly") and disables itself when that amount is missing.
 */
export function LockButton({ waitingOn, actionLabel, depositAmount, disabled, onClick, onOpenWalletAgain }: LockButtonProps) {
  const [showTryAgain, setShowTryAgain] = useState(false);

  useEffect(() => {
    if (!waitingOn) {
      setShowTryAgain(false);
      return;
    }
    const timer = setTimeout(() => setShowTryAgain(true), RETRY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waitingOn]);

  const hasUsableDeposit = isUsableDepositAmount(depositAmount);
  const depositLabel = hasUsableDeposit ? formatUsdc(depositAmount) : undefined;
  const idleLabel = depositLabel
    ? `Lock ${depositLabel} with Pactly`
    : "Lock with Pactly";
  const buttonLabel = actionLabel ?? idleLabel;
  // Issue #178: the wallet must not open when the server deposit is missing.
  const isDisabled = disabled || Boolean(waitingOn) || !hasUsableDeposit;
  const handleClick = () => {
    if (!isDisabled) onClick();
  };
  const handleRetry = () => {
    if (!isDisabled && onOpenWalletAgain) onOpenWalletAgain();
  };

  return (
    <div className="lock-button-group">
      <button type="button" className="button-escrow" disabled={isDisabled} onClick={handleClick} aria-live="polite" aria-label={buttonLabel}>
        {waitingOn ? "Locking…" : buttonLabel}
      </button>
      {waitingOn && <p className="lock-button-group__hint">{waitingOn}</p>}
      {waitingOn && showTryAgain && (
        <button type="button" className="button-ghost lock-button-group__retry" onClick={handleRetry} disabled={isDisabled} aria-label="Try again">
          Try again
        </button>
      )}
    </div>
  );
}
