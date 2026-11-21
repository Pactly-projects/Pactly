/**
 * Issue #1 (Story 2.3): a provider turns released USDC into local currency.
 *
 * The provider's key never leaves their own wallet: `start` opens a SEP-6
 * withdraw, builds an unsigned USDC payment to the anchor's treasury (with
 * the anchor's memo) and stores its hash; the panel has the provider sign
 * it; `submit` relays it only if the signed envelope's hash still matches;
 * `poll` follows the anchor until it reports `completed`.
 *
 * Plain words only at this boundary (`statusLabel`); SEP vocabulary and raw
 * anchor bodies never reach the panel.
 */
import { Horizon, TransactionBuilder } from "@stellar/stellar-sdk";

import { config } from "../config.js";
import { AmountOutOfRangeError, AnchorQuoteUnavailableError } from "../anchor/errors.js";
import type { AnchorFetchLike } from "../anchor/http.js";
import { ensureSep12Approved } from "../anchor/sep12.js";
import { fetchIndicativePrice } from "../anchor/sep38.js";
import { AnchorAuthRequiredError } from "../anchor/errors.js";
import { fetchSep6WithdrawLimits, openSep6Withdraw } from "../anchor/sep6-withdraw.js";
import { fetchSep6Transaction } from "../anchor/sep6-deposit.js";
import { resolveUsdcAsset } from "../anchor/usdc.js";
import type { Db } from "../db/client.js";
import {
  getCashOutById,
  getCashOutForProvider,
  insertCashOut,
  listCashOutsForProvider,
  updateCashOut,
  type CashOutRow,
} from "../db/cashOuts.js";
import { getProviderProfileByWallet } from "../db/providerProfiles.js";
import type { CashOutState } from "../db/schema.js";
import {
  buildBalancePaymentTransaction,
  smallestUnitToStellarAmount,
  submitBalancePaymentTransaction,
  type BuildPaymentDeps,
  type SubmitPaymentDeps,
} from "../payments/stellar.js";
import { PaymentUnavailableError } from "../payments/errors.js";
import {
  beginAnchorSep10,
  completeAnchorSep10,
  requireFreshAnchorJwt,
  type GetOrRefreshAnchorJwtDeps,
} from "./auth.js";
import { XdrMismatchError } from "./booking.js";
import { NotAProviderError } from "./profile.js";

export class CashOutNotFoundError extends Error {
  constructor(message = "That cash-out could not be found.") {
    super(message);
    this.name = "CashOutNotFoundError";
  }
}

export class InsufficientBalanceError extends Error {
  constructor(message = "That's more than your wallet holds right now.") {
    super(message);
    this.name = "InsufficientBalanceError";
  }
}

export class InvalidCashOutAmountError extends Error {
  constructor(message = "Enter an amount to cash out.") {
    super(message);
    this.name = "InvalidCashOutAmountError";
  }
}

export type CashOutStatusLabel =
  | "Waiting for your signature"
  | "Waiting for your transfer"
  | "Sent"
  | "Paid out"
  | "Not sent";

const STATUS_LABELS: Record<CashOutState, CashOutStatusLabel> = {
  awaiting_signature: "Waiting for your transfer",
  waiting: "Waiting for your transfer",
  sent: "Sent",
  paid_out: "Paid out",
  failed: "Not sent",
};

export interface CashOutLimitsView {
  min?: string;
  max?: string;
  currency?: string;
}

export interface CashOutBalanceView {
  /** Integer string, USDC smallest units (AD-7) -- `"0"` without a trustline. */
  balance: string;
  asset: string;
  hasTrustline: boolean;
  limits?: CashOutLimitsView;
}

export interface CashOutView {
  id: string;
  status: CashOutState;
  statusLabel: CashOutStatusLabel;
  /** The USDC the provider sends, smallest units. */
  amount: { amount: string; asset: string };
  fiat: { amount: string; currency: string };
  /** The anchor's own transaction id, kept for support. */
  anchorTransactionId: string;
  moreInfoUrl?: string;
  /** UTC epoch seconds. */
  createdAt: number;
  sentAt?: number;
  reason?: string;
  /** Anchor unreachable on the last poll: show the last known status. */
  stale?: boolean;
}

export interface CashOutDeps extends GetOrRefreshAnchorJwtDeps {
  fetchImpl?: AnchorFetchLike;
  now?: () => number;
  /** Overrides the Horizon balance/trustline read. */
  readBalance?: (account: string, assetCode: string, assetIssuer: string) => Promise<{ balance: string; hasTrustline: boolean }>;
  buildPayment?: BuildPaymentDeps;
  submitPayment?: SubmitPaymentDeps;
}

function horizonUrl(): string {
  return config.stellarNetworkPassphrase.startsWith("Public Global Stellar Network")
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
}

async function defaultReadBalance(
  account: string,
  assetCode: string,
  assetIssuer: string,
): Promise<{ balance: string; hasTrustline: boolean }> {
  try {
    const loaded = await new Horizon.Server(horizonUrl()).loadAccount(account);
    const line = loaded.balances.find(
      (balance) => "asset_code" in balance && balance.asset_code === assetCode && balance.asset_issuer === assetIssuer,
    );
    if (!line || !("balance" in line)) {
      return { balance: "0", hasTrustline: false };
    }
    const decimal = String(line.balance);
    const [whole = "0", fraction = ""] = decimal.split(".");
    const smallest = `${whole}${fraction.padEnd(7, "0").slice(0, 7)}`.replace(/^0+(?=\d)/, "");
    return { balance: smallest || "0", hasTrustline: true };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "NotFoundError" || /not found|404/i.test(message)) {
      return { balance: "0", hasTrustline: false };
    }
    throw new PaymentUnavailableError(`Could not reach Horizon to read the USDC balance: ${message}`);
  }
}

function fiatToMinor(decimal: string): bigint | undefined {
  if (!/^\d+(\.\d+)?$/.test(decimal.trim())) return undefined;
  const [whole = "0", fraction = ""] = decimal.trim().split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

function authDeps(deps: CashOutDeps): GetOrRefreshAnchorJwtDeps {
  return {
    now: deps.now,
    tomlFetch: deps.tomlFetch ?? deps.fetchImpl,
    sep10Fetch: deps.sep10Fetch ?? deps.fetchImpl,
  };
}

function toView(row: CashOutRow, extras: { stale?: boolean } = {}): CashOutView {
  const status = row.status as CashOutState;
  return {
    id: row.id,
    status,
    statusLabel: STATUS_LABELS[status] ?? "Waiting for your transfer",
    amount: { amount: row.amount, asset: "USDC" },
    fiat: { amount: row.fiatAmount, currency: row.fiatCurrency },
    anchorTransactionId: row.anchorTransactionId,
    moreInfoUrl: row.moreInfoUrl ?? undefined,
    createdAt: row.createdAt,
    sentAt: row.sentAt ?? undefined,
    reason: row.reason ?? undefined,
    stale: extras.stale,
  };
}

async function requireProvider(db: Db, walletAddress: string): Promise<void> {
  const profile = await getProviderProfileByWallet(db, walletAddress);
  if (!profile) {
    throw new NotAProviderError();
  }
}

function mapAnchorStatus(row: CashOutRow, anchorStatus: string): CashOutState {
  switch (anchorStatus) {
    case "completed":
      return "paid_out";
    case "error":
    case "expired":
    case "no_market":
    case "too_small":
    case "too_large":
    case "refunded":
      return "failed";
    default:
      // Any state past the transfer's start means the payment was relayed;
      // before that, the row's own signature/transfer state still stands.
      return row.paymentTxHash ? "sent" : "waiting";
  }
}

async function limitsView(fetchImpl: AnchorFetchLike | undefined): Promise<CashOutLimitsView | undefined> {
  try {
    const [limits, quote] = await Promise.all([
      fetchSep6WithdrawLimits({ fetchImpl }),
      fetchIndicativePrice({ amount: "10000000" }, { fetchImpl }),
    ]);
    if (!limits.minAmount && !limits.maxAmount) {
      return undefined;
    }
    return { min: limits.minAmount, max: limits.maxAmount, currency: quote.fiat.currency };
  } catch {
    // The panel's balance still matters even when the anchor's limit text
    // is unavailable; the range check on start still fails closed below.
    return undefined;
  }
}

export async function getCashOutBalance(
  db: Db,
  walletAddress: string,
  deps: CashOutDeps = {},
): Promise<CashOutBalanceView> {
  await requireProvider(db, walletAddress);
  const usdc = await resolveUsdcAsset({ fetchImpl: deps.fetchImpl });
  const readBalance = deps.readBalance ?? defaultReadBalance;
  const { balance, hasTrustline } = await readBalance(walletAddress, usdc.code, usdc.issuer);
  return {
    balance,
    asset: usdc.code,
    hasTrustline,
    limits: await limitsView(deps.fetchImpl),
  };
}

/** The provider panel's anchor sign-in, same SEP-10 challenge/verify pair
 * the booking deposit uses -- provider-only, and never mixed with Pactly's
 * own JWT cache. */
export async function beginCashOutAnchorAuth(db: Db, walletAddress: string, deps: CashOutDeps = {}) {
  await requireProvider(db, walletAddress);
  return beginAnchorSep10(db, walletAddress, authDeps(deps));
}

export async function completeCashOutAnchorAuth(
  db: Db,
  walletAddress: string,
  signedXdr: string,
  deps: CashOutDeps = {},
): Promise<void> {
  await requireProvider(db, walletAddress);
  await completeAnchorSep10(db, walletAddress, signedXdr, authDeps(deps));
}

export interface StartCashOutResult {
  cashOutId: string;
  unsignedXdr: string;
}

export async function startCashOut(
  db: Db,
  walletAddress: string,
  amount: string,
  deps: CashOutDeps = {},
): Promise<StartCashOutResult> {
  await requireProvider(db, walletAddress);
  if (!/^\d+$/.test(amount)) {
    throw new InvalidCashOutAmountError("Enter the amount as a whole number of USDC.");
  }
  const amountUnits = BigInt(amount);
  if (amountUnits <= 0n) {
    throw new InvalidCashOutAmountError("Enter an amount greater than zero.");
  }

  const token = await requireFreshAnchorJwt(db, walletAddress, authDeps(deps));
  const nowMs = deps.now?.() ?? Date.now();
  const nowSeconds = Math.floor(nowMs / 1000);

  const quote = await fetchIndicativePrice({ amount }, { fetchImpl: deps.fetchImpl });
  const limits = await fetchSep6WithdrawLimits({ fetchImpl: deps.fetchImpl });
  const fiatMinor = fiatToMinor(quote.fiat.amount);
  const minMinor = limits.minAmount ? fiatToMinor(limits.minAmount) : undefined;
  const maxMinor = limits.maxAmount ? fiatToMinor(limits.maxAmount) : undefined;
  if (
    fiatMinor !== undefined &&
    ((minMinor !== undefined && fiatMinor < minMinor) || (maxMinor !== undefined && fiatMinor > maxMinor))
  ) {
    throw new AmountOutOfRangeError(limits.minAmount ?? "0", limits.maxAmount ?? "—", quote.fiat.currency);
  }

  const usdc = await resolveUsdcAsset({ fetchImpl: deps.fetchImpl });
  const readBalance = deps.readBalance ?? defaultReadBalance;
  const wallet = await readBalance(walletAddress, usdc.code, usdc.issuer);
  if (!wallet.hasTrustline || BigInt(wallet.balance) < amountUnits) {
    throw new InsufficientBalanceError();
  }

  await ensureSep12Approved({ token, account: walletAddress }, { fetchImpl: deps.fetchImpl });
  const opened = await openSep6Withdraw(
    {
      token,
      account: walletAddress,
      amount: smallestUnitToStellarAmount(amount),
      type: "bank_account",
    },
    { fetchImpl: deps.fetchImpl },
  );

  const built = await buildBalancePaymentTransaction(
    {
      sourceAddress: walletAddress,
      destinationAddress: opened.accountId,
      assetCode: usdc.code,
      assetIssuer: usdc.issuer,
      amount,
      memo: opened.memo ? { type: opened.memoType === "text" ? "text" : "id", value: opened.memo } : undefined,
    },
    deps.buildPayment ?? {},
  );

  const id = crypto.randomUUID();
  await insertCashOut(db, {
    id,
    providerWalletAddress: walletAddress,
    anchorTransactionId: opened.id,
    treasuryAccount: opened.accountId,
    memo: opened.memo,
    memoType: opened.memoType,
    amount,
    fiatAmount: quote.fiat.amount,
    fiatCurrency: quote.fiat.currency,
    anchorStatus: opened.status,
    status: "awaiting_signature",
    moreInfoUrl: opened.moreInfoUrl,
    paymentBuiltHash: built.txHash,
    createdAt: nowSeconds,
    updatedAt: nowSeconds,
  });

  return { cashOutId: id, unsignedXdr: built.unsignedXdr };
}

/** Records the signed payment as sent only after the network confirms it. */
export async function submitCashOut(
  db: Db,
  walletAddress: string,
  id: string,
  signedXdr: string,
  deps: CashOutDeps = {},
): Promise<CashOutView> {
  await requireProvider(db, walletAddress);
  const row = await getCashOutForProvider(db, id, walletAddress);
  if (!row) {
    throw new CashOutNotFoundError();
  }
  if (!row.paymentBuiltHash) {
    throw new XdrMismatchError();
  }
  let hash: string;
  try {
    const tx = TransactionBuilder.fromXDR(signedXdr, config.stellarNetworkPassphrase);
    hash = Buffer.from(tx.hash()).toString("hex").toLowerCase();
  } catch {
    throw new XdrMismatchError();
  }
  if (hash !== row.paymentBuiltHash.toLowerCase()) {
    throw new XdrMismatchError();
  }

  const submitted = await submitBalancePaymentTransaction(signedXdr, deps.submitPayment ?? {});
  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  await updateCashOut(db, id, {
    status: "sent",
    paymentTxHash: submitted.txHash,
    sentAt: nowSeconds,
    updatedAt: nowSeconds,
  });
  const fresh = await getCashOutById(db, id);
  return toView(fresh ?? row);
}

/** Polls the anchor; an unreachable anchor leaves the last known status and
 * marks the view stale rather than losing the row's state. */
export async function pollCashOut(
  db: Db,
  walletAddress: string,
  id: string,
  deps: CashOutDeps = {},
): Promise<CashOutView> {
  await requireProvider(db, walletAddress);
  const row = await getCashOutForProvider(db, id, walletAddress);
  if (!row) {
    throw new CashOutNotFoundError();
  }
  if (row.status === "paid_out" || row.status === "awaiting_signature") {
    return toView(row);
  }

  const token = await requireFreshAnchorJwt(db, walletAddress, authDeps(deps));
  try {
    const tx = await fetchSep6Transaction(row.anchorTransactionId, token, { fetchImpl: deps.fetchImpl });
    const status = mapAnchorStatus(row, tx.status);
    const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    await updateCashOut(db, id, {
      anchorStatus: tx.status,
      status,
      reason: status === "failed" ? (tx.message ?? "The payout did not go through.") : null,
      moreInfoUrl: tx.moreInfoUrl ?? row.moreInfoUrl,
      updatedAt: nowSeconds,
    });
    const fresh = await getCashOutById(db, id);
    return toView(fresh ?? row);
  } catch (error) {
    if (error instanceof AnchorAuthRequiredError) {
      throw error;
    }
    return toView(row, { stale: true });
  }
}

export async function getCashOut(
  db: Db,
  walletAddress: string,
  id: string,
  deps: CashOutDeps = {},
): Promise<CashOutView> {
  await requireProvider(db, walletAddress);
  const row = await getCashOutForProvider(db, id, walletAddress);
  if (!row) {
    throw new CashOutNotFoundError();
  }
  return pollCashOut(db, walletAddress, id, deps);
}

export async function listCashOuts(db: Db, walletAddress: string): Promise<CashOutView[]> {
  await requireProvider(db, walletAddress);
  const rows = await listCashOutsForProvider(db, walletAddress);
  return rows.map((row) => toView(row));
}

