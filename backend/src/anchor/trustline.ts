/**
 * Issue #4: "can this wallet hold Pactly's deposit asset at all?"
 *
 * A release, a refund, or the escrow fund itself all move USDC to or from a
 * wallet that has to be able to hold it; a wallet that cannot traps the
 * deposit. `services/localDeposit.ts` already needed this exact question for
 * its own `needs_trustline` step, so the read lives here, once, and that
 * story's flow calls it through the same seam it always did.
 *
 * Two rules this module keeps:
 *   - Only the anchor's own USDC counts (AD-10), discovered from its
 *     `stellar.toml` -- and the check compares the *issuer* too, so a USDC
 *     from someone else does not pass.
 *   - A wallet Horizon cannot be asked about is never treated as ready: an
 *     unreachable network refuses (retryable) rather than lets money move
 *     on an unverified assumption. The same rule `payments/stellar.ts`'s
 *     own reads follow.
 */
import { Horizon } from "@stellar/stellar-sdk";

import { config } from "../config.js";
import { PaymentUnavailableError } from "../payments/errors.js";
import { UsdcTrustlineMissingError } from "./errors.js";
import { resolveUsdcAsset, type ResolveUsdcAssetOptions, type UsdcAsset } from "./usdc.js";

/** The one thing a trustline read looks at on an account: the assets it
 * already holds. Horizon's own `AccountResponse` satisfies this shape --
 * `native` balances simply carry no `asset_code`/`asset_issuer`, which is
 * exactly how the read below treats them. */
export interface AccountHeldAssets {
  balances: { asset_type?: string; balance?: string; asset_code?: string; asset_issuer?: string }[];
}

/** Testnet vs mainnet Horizon, from the same passphrase every other
 * network-dependent URL in this backend derives (was
 * `services/localDeposit.ts`'s own private helper). */
export function defaultHorizonUrl(): string {
  return config.stellarNetworkPassphrase.startsWith("Public Global Stellar Network")
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
}

/** One account read, as "what does this wallet hold?". Defaults to a real
 * Horizon `loadAccount`; a test injects a canned answer and never opens a
 * socket. */
export interface TrustlineReadDeps {
  loadAccount?: (account: string) => Promise<AccountHeldAssets>;
}

export interface UsdcTrustlineDeps extends TrustlineReadDeps {
  /** Overrides how the USDC asset is resolved -- defaults to the real,
   * cached anchor lookup (`anchor/usdc.ts`), same seam
   * `buildBalancePaymentTransaction` already uses. */
  resolveUsdcAsset?: (options?: ResolveUsdcAssetOptions) => Promise<UsdcAsset>;
  /** Answers "does this account hold `assetCode` issued by
   * `assetIssuer`?" Defaults to {@link accountHasUsdcTrustline}'s own
   * Horizon read. */
  hasTrustline?: (account: string, assetCode: string, assetIssuer: string) => Promise<boolean>;
}

function defaultLoadAccount(account: string): Promise<AccountHeldAssets> {
  return new Horizon.Server(defaultHorizonUrl()).loadAccount(account);
}

/** `true` when `account` holds this exact code *and* issuer. An account
 * Horizon does not know has nothing to hold (`false`); a Horizon that
 * cannot be reached at all refuses ({@link PaymentUnavailableError}) rather
 * than guess. */
export async function accountHasUsdcTrustline(
  account: string,
  assetCode: string,
  assetIssuer: string,
  deps: TrustlineReadDeps = {},
): Promise<boolean> {
  const loadAccount = deps.loadAccount ?? defaultLoadAccount;
  try {
    const loaded = await loadAccount(account);
    return loaded.balances.some((balance) => balance.asset_code === assetCode && balance.asset_issuer === assetIssuer);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    const message = error instanceof Error ? error.message : String(error);
    if (name === "NotFoundError" || /not found|404/i.test(message)) {
      return false;
    }
    throw new PaymentUnavailableError(`Could not reach Horizon to check the USDC trustline: ${message}`);
  }
}

/** Read-only counterpart to {@link requireUsdcTrustline}: `true` when
 * `account` holds the anchor's own USDC, `false` when it does not. Nothing
 * is written and no transaction is built -- the dashboard's warning uses
 * this, never `requireUsdcTrustline`'s refusal. Discovery and Horizon
 * failures still throw, so a caller that must keep rendering can catch
 * them and treat the answer as unknown rather than "missing". */
export async function hasUsdcTrustline(account: string, deps: UsdcTrustlineDeps = {}): Promise<boolean> {
  const resolveUsdc = deps.resolveUsdcAsset ?? resolveUsdcAsset;
  const hasTrustline =
    deps.hasTrustline ?? ((address: string, code: string, issuer: string) => accountHasUsdcTrustline(address, code, issuer, deps));

  const usdc = await resolveUsdc();
  return hasTrustline(account, usdc.code, usdc.issuer);
}

/** Refuses (typed {@link UsdcTrustlineMissingError}) unless `account` can
 * hold the anchor's USDC. Nothing is written and no transaction is built by
 * this call -- it is a gate a caller runs *before* it touches money. */
export async function requireUsdcTrustline(account: string, deps: UsdcTrustlineDeps = {}): Promise<void> {
  const resolveUsdc = deps.resolveUsdcAsset ?? resolveUsdcAsset;
  const hasTrustline = deps.hasTrustline ?? ((address: string, code: string, issuer: string) => accountHasUsdcTrustline(address, code, issuer, deps));

  let usdc: UsdcAsset;
  try {
    usdc = await resolveUsdc();
  } catch (error) {
    // Discovery is as much a network read as the account lookup: no answer
    // means no approval, never a pass.
    throw new PaymentUnavailableError(
      `Could not resolve the anchor's USDC asset to check the wallet: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!(await hasTrustline(account, usdc.code, usdc.issuer))) {
    throw new UsdcTrustlineMissingError(account);
  }
}
