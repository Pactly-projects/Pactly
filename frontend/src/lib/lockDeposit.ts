import type { Money } from "../api/types";
import { formatMoney } from "./money";

/** The only asset a deposit is ever locked in. */
const LOCK_ASSET = "USDC";

interface DepositSource {
  deposit?: Money | null;
}

/**
 * Issue #178: the deposit the lock button shows, and the figure the client
 * agrees to when they tap it. It only ever comes from the server's own
 * booking response (`GET /bookings/:id`, or the hold that created the
 * booking) -- never from the profile's advertised deposit or anything
 * computed in the browser, because that is the amount the server will
 * lock.
 *
 * `undefined` means the button must stay disabled: the booking load
 * failed, no booking response has arrived yet, or its deposit is not a
 * whole number of USDC smallest units. A deposit of zero is valid and is
 * returned as zero.
 */
export function serverLockDeposit(
  booking: DepositSource | undefined,
  hold: DepositSource | undefined,
  bookingLoadFailed: boolean,
): Money | undefined {
  if (bookingLoadFailed) return undefined;
  const deposit = booking?.deposit ?? hold?.deposit ?? undefined;
  if (!deposit) return undefined;
  if (deposit.asset !== LOCK_ASSET) return undefined;
  if (typeof deposit.amount !== "string" || !/^\d+$/.test(deposit.amount)) return undefined;
  return { amount: deposit.amount, asset: deposit.asset };
}

/** "Lock 12.50 USDC with Pactly", or the plain label while there is no
 * server amount to show (the button is disabled then). */
export function lockButtonLabel(deposit: Money | undefined): string {
  return deposit ? `Lock ${formatMoney(deposit.amount, deposit.asset)} with Pactly` : "Lock with Pactly";
}

/**
 * Checked just before the fund transaction is built: the figure the client
 * saw on the button when they tapped it must still be the server's
 * deposit. Returns a message to show when it is not (nothing is signed
 * then), or `undefined` when the two match exactly.
 */
export function depositMismatchMessage(shown: Money | undefined, current: Money | undefined): string | undefined {
  if (!shown || !current) {
    return "The deposit amount could not be confirmed, so nothing was signed. Reload the page and try again.";
  }
  if (shown.amount === current.amount && shown.asset === current.asset) return undefined;
  return (
    `The deposit is now ${formatMoney(current.amount, current.asset)}, not the ` +
    `${formatMoney(shown.amount, shown.asset)} on the button. Nothing was signed. Check the amount and tap Lock again.`
  );
}
