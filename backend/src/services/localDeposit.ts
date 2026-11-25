/**
 * Story 2.4: the local-currency (SEP-6) deposit path for a held booking.
 * The client signs the anchor challenge in their wallet; this module never
 * holds a key. Statuses are mapped to plain words here; SEP vocabulary
 * never leaves the route layer's JSON.
 */
import { config } from "../config.js";
import {
  AmountOutOfRangeError,
  AnchorQuoteUnavailableError,
  AnchorQuoteUnsupportedError,
  QuoteMismatchError,
  QuoteStaleError,
} from "../anchor/errors.js";
import { type AnchorFetchLike } from "../anchor/http.js";
import {
  fetchSep6DepositLimits,
  fetchSep6Transaction,
  isSandboxAnchor,
  openSep6Deposit,
  simulateSep6BankTransfer,
  type BankDetails,
  type Sep6Transaction,
} from "../anchor/sep6-deposit.js";
import { ensureSep12Approved } from "../anchor/sep12.js";
import {
  DEFAULT_QUOTE_MAX_AGE_SECONDS,
  fetchIndicativePrice,
  isQuoteStale,
  type IndicativePrice,
} from "../anchor/sep38.js";
import { resolveUsdcAsset } from "../anchor/usdc.js";
import {
  extendHoldExpiresAt,
  setAnchorDeposit,
  setAnchorTrustlineTxHash,
  type BookingRow,
} from "../db/bookings.js";
import type { Db } from "../db/client.js";
import {
  buildChangeTrustTransaction,
  smallestUnitToStellarAmount,
  submitBalancePaymentTransaction,
  type BuildPaymentDeps,
  type SubmitPaymentDeps,
} from "../payments/stellar.js";
import {
  beginAnchorSep10,
  completeAnchorSep10,
  requireFreshAnchorJwt,
  type GetOrRefreshAnchorJwtDeps,
} from "./auth.js";
import {
  BookingEscrowStateError,
  BookingHoldExpiredError,
  HOLD_DURATION_SECONDS,
  XdrMismatchError,
  getBookingForClient,
} from "./booking.js";

export { BookingEscrowStateError, BookingHoldExpiredError, BookingNotFoundError, XdrMismatchError } from "./booking.js";

export class SandboxOnlyError extends Error {
  constructor(message = "Simulate is only available on the sandbox anchor.") {
    super(message);
    this.name = "SandboxOnlyError";
  }
}

function requireHoldNotExpired(booking: BookingRow, now: number): void {
  if (booking.declinedAt !== null) {
    throw new BookingEscrowStateError(`Booking "${booking.id}" was declined by the shop`);
  }
  if (
    booking.escrowState === null
    && booking.escrowContractId === null
    && booking.holdExpiresAt !== null
    && booking.holdExpiresAt < now
  ) {
    throw new BookingHoldExpiredError();
  }
}

export type LocalDepositUiStatus = "waiting" | "paying" | "received" | "failed" | "needs_trustline";

const STATUS_WORDS: Record<LocalDepositUiStatus, string> = {
  waiting: "Waiting for your transfer",
  paying: "Paying into your wallet",
  received: "Money received",
  failed: "The transfer did not go through",
  needs_trustline: "Getting your wallet ready",
};

function mapSep6Status(status: string): LocalDepositUiStatus {
  switch (status) {
    case "completed":
      return "received";
    case "pending_anchor":
    case "pending_stellar":
      return "paying";
    case "error":
    case "expired":
    case "no_market":
    case "too_small":
    case "too_large":
      return "failed";
    case "pending_trust":
      return "needs_trustline";
    default:
      return "waiting";
  }
}

function parseExpiresAt(isoOrUndefined: string | undefined, nowMs: number): number | undefined {
  if (!isoOrUndefined) return undefined;
  const ms = Date.parse(isoOrUndefined);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : Math.floor(nowMs / 1000) + HOLD_DURATION_SECONDS;
}

function fiatToMinor(decimal: string, decimals: number): bigint | undefined {
  if (!/^\d+(\.\d+)?$/.test(decimal.trim())) return undefined;
  const [whole = "0", fraction = ""] = decimal.trim().split(".");
  if (fraction.length > decimals) return undefined;
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fraction.padEnd(decimals, "0"));
}

function toConfiguredDecimalPlaces(decimal: string, decimals: number): string {
  const minor = fiatToMinor(decimal, decimals);
  if (minor === undefined) {
    throw new AnchorQuoteUnavailableError(`Could not format the local-currency amount "${decimal}"`);
  }
  const divisor = 10n ** BigInt(decimals);
  const whole = minor / divisor;
  const fraction = decimals > 0
    ? `.${(minor % divisor).toString().padStart(decimals, "0")}`
    : "";
  return `${whole}${fraction}`;
}

function defaultHorizonUrl(): string {
  return config.stellarNetworkPassphrase.startsWith("Public Global Stellar Network")
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
}

/** The quote a booking screen confirmed just before starting the deposit.
 * Its `fiat.amount` is the figure the client saw; the backend only accepts it
 * when it is still within its own age and still names this booking's deposit
 * amount. */
export interface ConfirmedQuote {
  amount: string;
  quotedAt: number;
  maxAgeSeconds?: number;
  fiat: { amount: string; currency: string };
}

export interface LocalDepositDeps extends GetOrRefreshAnchorJwtDeps {
  fetchImpl?: AnchorFetchLike;
  now?: () => number;
  hasTrustline?: (account: string, assetCode: string, assetIssuer: string) => Promise<boolean>;
  buildTrustline?: BuildPaymentDeps;
  submitTrustline?: SubmitPaymentDeps;
  /** Optional client-confirmed quote. Accepted only while fresh and for the
   * right amount; a stale one blocks the deposit rather than being silently
   * replaced with a server-side price the client never saw. */
  confirmedQuote?: ConfirmedQuote;
}

/** Validates the client's confirmed quote against this booking, returning
 * the exact fiat amount to submit to the anchor. The client's `fiat.amount`
 * is never trusted on its own: it must match a price the backend fetches
 * from the anchor for this booking's own deposit amount. If that refresh
 * fails the deposit stays blocked, rather than falling back to the
 * client-supplied figure. */
async function confirmedQuoteAmount(
  booking: BookingRow,
  quote: ConfirmedQuote,
  nowSeconds: number,
  deps: LocalDepositDeps,
): Promise<string> {
  if (quote.amount !== booking.depositAmount) {
    throw new QuoteMismatchError();
  }
  const maxAgeSeconds = quote.maxAgeSeconds ?? DEFAULT_QUOTE_MAX_AGE_SECONDS;
  if (!Number.isFinite(quote.quotedAt) || isQuoteStale({ quotedAt: quote.quotedAt, maxAgeSeconds }, nowSeconds)) {
    throw new QuoteStaleError(undefined, {
      quotedAt: quote.quotedAt,
      expiresAt: quote.quotedAt + maxAgeSeconds,
    });
  }
  if (typeof quote.fiat?.amount !== "string" || quote.fiat.amount.trim() === "") {
    throw new QuoteStaleError("The confirmed price has no amount. Refresh it before continuing.");
  }
  const confirmedAmount = toTwoDecimalPlaces(quote.fiat.amount);

  // Re-fetch rather than reading the short-lived price cache: the amount
  // submitted to the anchor must be checked against its current price, not
  // one this backend happened to cache earlier. Any failure here propagates
  // and blocks the deposit.
  let serverQuote: IndicativePrice;
  try {
    serverQuote = await fetchIndicativePrice(
      { amount: booking.depositAmount },
      { fetchImpl: deps.fetchImpl, now: deps.now, forceRefresh: true },
    );
  } catch (error) {
    if (error instanceof AnchorQuoteUnavailableError || error instanceof AnchorQuoteUnsupportedError) {
      throw error;
    }
    throw new AnchorQuoteUnavailableError(
      `Could not refresh the confirmed price before starting the deposit: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const serverAmount = toTwoDecimalPlaces(serverQuote.fiat.amount);
  if (confirmedAmount !== serverAmount) {
    throw new QuoteMismatchError(
      "The confirmed price no longer matches the anchor's current price. Refresh it before continuing.",
    );
  }
  return serverAmount;
}

function authDeps(deps: LocalDepositDeps): GetOrRefreshAnchorJwtDeps {
  return {
    now: deps.now,
    tomlFetch: deps.tomlFetch ?? deps.fetchImpl,
    sep10Fetch: deps.sep10Fetch ?? deps.fetchImpl,
  };
}

function snapshotBankDetails(details: BankDetails): string {
  return JSON.stringify(details);
}

function parseBankDetails(json: string | null): BankDetails {
  if (!json) return {};
  try {
    return JSON.parse(json) as BankDetails;
  } catch {
    return {};
  }
}

export interface LocalDepositView {
  status: LocalDepositUiStatus;
  statusLabel: string;
  bankDetails: BankDetails;
  moreInfoUrl?: string;
  expiresAt?: number;
  holdExpiresAt: number | null;
  sandbox: boolean;
  stale?: boolean;
  reason?: string;
}

function toView(booking: BookingRow, extras: { stale?: boolean; reason?: string } = {}): LocalDepositView {
  const raw = booking.anchorDepositStatus ?? "pending_user_transfer_start";
  const status = mapSep6Status(raw);
  return {
    status,
    statusLabel: STATUS_WORDS[status],
    bankDetails: parseBankDetails(booking.anchorDepositBankDetails),
    moreInfoUrl: booking.anchorDepositMoreInfoUrl ?? undefined,
    expiresAt: booking.anchorDepositExpiresAt ?? undefined,
    holdExpiresAt: booking.holdExpiresAt,
    sandbox: isSandboxAnchor(),
    stale: extras.stale,
    reason: extras.reason ?? (status === "failed" ? "The transfer did not go through. You can try again or pay with your wallet." : undefined),
  };
}

async function loadOwnedHold(db: Db, bookingId: string, walletAddress: string, nowSeconds: number): Promise<BookingRow> {
  const booking = await getBookingForClient(db, bookingId, walletAddress);
  requireHoldNotExpired(booking, nowSeconds);
  return booking;
}

export async function beginBookingAnchorAuth(
  db: Db,
  bookingId: string,
  walletAddress: string,
  deps: LocalDepositDeps = {},
) {
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  return beginAnchorSep10(db, walletAddress, authDeps(deps));
}

export async function completeBookingAnchorAuth(
  db: Db,
  bookingId: string,
  walletAddress: string,
  signedXdr: string,
  deps: LocalDepositDeps = {},
): Promise<void> {
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  await completeAnchorSep10(db, walletAddress, signedXdr, authDeps(deps));
}

export type OpenLocalDepositResult =
  | { needsTrustline: true; unsignedXdr: string }
  | ({ needsTrustline?: false } & LocalDepositView);

async function enforceLimits(
  depositAmount: string,
  fetchImpl: AnchorFetchLike | undefined,
  now?: () => number,
): Promise<void> {
  const limits = await fetchSep6DepositLimits({ fetchImpl });
  if (!limits.minAmount && !limits.maxAmount) {
    return;
  }
  let fiatAmount: string;
  let currency: string;
  let decimals: number;
  try {
    const quote = await fetchIndicativePrice({ amount: depositAmount }, { fetchImpl, now });
    fiatAmount = quote.fiat.amount;
    currency = quote.fiat.currency;
    decimals = quote.fiat.decimals;
  } catch (error) {
    if (error instanceof AnchorQuoteUnavailableError) {
      return;
    }
    throw error;
  }
  const amountMinor = fiatToMinor(fiatAmount, decimals);
  const minMinor = limits.minAmount ? fiatToMinor(limits.minAmount, decimals) : undefined;
  const maxMinor = limits.maxAmount ? fiatToMinor(limits.maxAmount, decimals) : undefined;
  if (amountMinor === undefined) return;
  if ((minMinor !== undefined && amountMinor < minMinor) || (maxMinor !== undefined && amountMinor > maxMinor)) {
    throw new AmountOutOfRangeError(limits.minAmount ?? "0", limits.maxAmount ?? "—", currency);
  }
}

async function persistOpened(
  db: Db,
  bookingId: string,
  opened: { id: string; bankDetails: BankDetails; moreInfoUrl?: string; expiresAt?: string; amountIn?: string },
  nowMs: number,
  extraStatus?: string,
): Promise<void> {
  const stored = await setAnchorDeposit(db, bookingId, {
    id: opened.id,
    status: extraStatus ?? "pending_user_transfer_start",
    moreInfoUrl: opened.moreInfoUrl,
    bankDetailsJson: snapshotBankDetails(opened.bankDetails),
    expiresAt: parseExpiresAt(opened.expiresAt, nowMs) ?? null,
    amountIn: opened.amountIn ?? null,
    updatedAt: Math.floor(nowMs / 1000),
  });
  if (!stored) {
    // The booking's previous anchor deposit completed while this one was
    // being opened: its id is kept, never replaced by this new attempt.
    throw new BookingEscrowStateError("This booking's local-currency transfer already completed.");
  }
}

async function openAgainstAnchor(
  db: Db,
  booking: BookingRow,
  walletAddress: string,
  deps: LocalDepositDeps,
  confirmedTryAmount?: string,
): Promise<LocalDepositView> {
  const nowMs = deps.now?.() ?? Date.now();
  const token = await requireFreshAnchorJwt(db, walletAddress, authDeps(deps));
  await ensureSep12Approved({ token, account: walletAddress }, { fetchImpl: deps.fetchImpl });
  const quote = await fetchIndicativePrice({ amount: booking.depositAmount }, { fetchImpl: deps.fetchImpl });
  const localAmount = toConfiguredDecimalPlaces(quote.fiat.amount, quote.fiat.decimals);
  const opened = await openSep6Deposit(
    { token, account: walletAddress, amount: localAmount, memo: booking.id.slice(0, 28) },
    { fetchImpl: deps.fetchImpl },
  );
  await persistOpened(db, booking.id, opened, nowMs);
  await extendHoldExpiresAt(db, booking.id, Math.floor(nowMs / 1000) + HOLD_DURATION_SECONDS);
  const fresh = await getBookingForClient(db, booking.id, walletAddress);
  return toView(fresh);
}

export async function openLocalDeposit(
  db: Db,
  bookingId: string,
  walletAddress: string,
  deps: LocalDepositDeps = {},
): Promise<OpenLocalDepositResult> {
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const booking = await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  if (booking.escrowState !== null) {
    throw new BookingEscrowStateError("This booking's deposit is already locked.");
  }

  if (booking.anchorDepositId && booking.anchorDepositStatus && mapSep6Status(booking.anchorDepositStatus) !== "failed") {
    return toView(booking);
  }

  // Story #19: retry a failed anchor deposit without starting a new hold
  if (booking.anchorDepositId && booking.anchorDepositStatus && mapSep6Status(booking.anchorDepositStatus) === "failed") {
    return retryFailedDeposit(db, booking, walletAddress, deps);
  }

  return startAnchorDeposit(db, booking, walletAddress, deps, nowSeconds);
}

/** Opens a new anchor deposit for a held booking (or asks for the USDC
 * trustline first). The new anchor transaction id replaces any previous,
 * not-completed one on the booking. */
async function startAnchorDeposit(
  db: Db,
  booking: BookingRow,
  walletAddress: string,
  deps: LocalDepositDeps,
  nowSeconds: number,
): Promise<OpenLocalDepositResult> {
  await requireFreshAnchorJwt(db, walletAddress, authDeps(deps));
  await enforceLimits(booking.depositAmount, deps.fetchImpl, deps.now);

  const usdc = await resolveUsdcAsset({ fetchImpl: deps.fetchImpl });
  const hasTrustline = deps.hasTrustline ?? accountHasUsdcTrustline;
  const ready = await hasTrustline(walletAddress, usdc.code, usdc.issuer);
  if (!ready) {
    const built = await buildChangeTrustTransaction(
      { sourceAddress: walletAddress, assetCode: usdc.code, assetIssuer: usdc.issuer },
      deps.buildTrustline ?? {},
    );
    await setAnchorTrustlineTxHash(db, booking.id, built.txHash);
    return { needsTrustline: true, unsignedXdr: built.unsignedXdr };
  }

  // A confirmed quote is checked exactly at the point of submitting money:
  // stale, for another amount or without a fiat figure -> the deposit is
  // blocked, never submitted at a price the client did not confirm.
  const confirmedTryAmount = deps.confirmedQuote
    ? await confirmedQuoteAmount(booking, deps.confirmedQuote, nowSeconds, deps)
    : undefined;
  return openAgainstAnchor(db, booking, walletAddress, deps, confirmedTryAmount);
}

/** Story #19: retry a failed anchor deposit without starting a new hold.
 * The failed deposit's id stays on the booking until the anchor hands back
 * a new one, so support can still trace the failed attempt meanwhile. */
export async function retryFailedDeposit(
  db: Db,
  booking: BookingRow,
  walletAddress: string,
  deps: LocalDepositDeps,
): Promise<OpenLocalDepositResult> {
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  requireHoldNotExpired(booking, nowSeconds);
  if (booking.escrowState !== null) {
    throw new BookingEscrowStateError("This booking's deposit is already locked.");
  }
  if (!booking.anchorDepositId) {
    throw new BookingEscrowStateError("No anchor deposit found for this booking.");
  }
  if (!booking.anchorDepositStatus || mapSep6Status(booking.anchorDepositStatus) !== "failed") {
    throw new BookingEscrowStateError("Deposit is not in a failed state and cannot be retried.");
  }
  return startAnchorDeposit(db, booking, walletAddress, deps, nowSeconds);
}

export async function submitLocalDepositTrustline(
  db: Db,
  bookingId: string,
  walletAddress: string,
  signedXdr: string,
  deps: LocalDepositDeps = {},
): Promise<OpenLocalDepositResult> {
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const booking = await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  if (!booking.anchorTrustlineTxHash) {
    throw new XdrMismatchError();
  }
  const { TransactionBuilder } = await import("@stellar/stellar-sdk");
  let hash: string;
  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, config.stellarNetworkPassphrase);
    hash = Buffer.from(tx.hash()).toString("hex").toLowerCase();
  } catch {
    throw new XdrMismatchError();
  }
  if (hash !== booking.anchorTrustlineTxHash) {
    throw new XdrMismatchError();
  }
  await submitBalancePaymentTransaction(signedXdr, deps.submitTrustline ?? {});
  const confirmedTryAmount = deps.confirmedQuote
    ? await confirmedQuoteAmount(booking, deps.confirmedQuote, nowSeconds, deps)
    : undefined;
  return openAgainstAnchor(db, booking, walletAddress, deps, confirmedTryAmount);
}

export async function pollLocalDeposit(
  db: Db,
  bookingId: string,
  walletAddress: string,
  deps: LocalDepositDeps = {},
): Promise<LocalDepositView> {
  const nowMs = deps.now?.() ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  const booking = await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  if (!booking.anchorDepositId) {
    throw new BookingEscrowStateError("No local-currency transfer is in progress for this booking.");
  }
  try {
    const token = await requireFreshAnchorJwt(db, walletAddress, authDeps(deps));
    const tx: Sep6Transaction = await fetchSep6Transaction(booking.anchorDepositId, token, { fetchImpl: deps.fetchImpl });
    const ui = mapSep6Status(tx.status);
    await setAnchorDeposit(db, bookingId, {
      id: tx.id,
      status: tx.status,
      moreInfoUrl: tx.moreInfoUrl ?? booking.anchorDepositMoreInfoUrl,
      bankDetailsJson: booking.anchorDepositBankDetails ?? snapshotBankDetails(tx.bankDetails),
      expiresAt: parseExpiresAt(tx.expiresAt, nowMs) ?? booking.anchorDepositExpiresAt,
      amountIn: tx.amountIn ?? booking.anchorDepositAmountIn,
      updatedAt: nowSeconds,
    });
    if (ui === "waiting" || ui === "paying" || ui === "needs_trustline") {
      await extendHoldExpiresAt(db, bookingId, nowSeconds + HOLD_DURATION_SECONDS);
    }
    const fresh = await getBookingForClient(db, bookingId, walletAddress);
    return toView(fresh, { reason: tx.message });
  } catch (error) {
    if (error instanceof BookingHoldExpiredError) throw error;
    return toView(booking, { stale: true });
  }
}

export async function simulateLocalDeposit(
  db: Db,
  bookingId: string,
  walletAddress: string,
  deps: LocalDepositDeps = {},
): Promise<LocalDepositView> {
  if (!isSandboxAnchor()) {
    throw new SandboxOnlyError();
  }
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const booking = await loadOwnedHold(db, bookingId, walletAddress, nowSeconds);
  if (!booking.anchorDepositId) {
    throw new BookingEscrowStateError("No local-currency transfer is in progress for this booking.");
  }
  const rawAmount = booking.anchorDepositAmountIn ?? smallestUnitToStellarAmount(booking.depositAmount);
  const quote = await fetchIndicativePrice({ amount: booking.depositAmount }, { fetchImpl: deps.fetchImpl });
  const amount = toConfiguredDecimalPlaces(rawAmount, quote.fiat.decimals);
  await simulateSep6BankTransfer(booking.anchorDepositId, amount, { fetchImpl: deps.fetchImpl });
  return pollLocalDeposit(db, bookingId, walletAddress, deps);
}
