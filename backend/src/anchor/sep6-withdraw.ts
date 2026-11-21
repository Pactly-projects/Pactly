/**
 * Issue #1 (Story 2.3): the anchor's SEP-6 withdraw client. It opens a
 * `bank_account` withdrawal for the anchor's USDC and returns the anchor's
 * own treasury account and memo -- the two facts the service layer needs to
 * build the provider's payment. Polling reuses Story 2.4's
 * `fetchSep6Transaction`, since both directions share the same
 * `/transaction` endpoint and response shape; only limits and `open` differ.
 *
 * Every network access sits behind the injectable `fetch` seam the rest of
 * `anchor/` already uses, so tests never reach the live anchor.
 */
import { config } from "../config.js";
import { AnchorDepositError, AnchorUnavailableError } from "./errors.js";
import {
  anchorReasonFromResponse,
  defaultAnchorFetch,
  tryReadJson,
  type AnchorFetchLike,
} from "./http.js";
import { discoverAnchorSepEndpoints } from "./stellar-toml.js";
import { resolveUsdcAsset } from "./usdc.js";

export type AnchorFetch = AnchorFetchLike;

export interface Sep6WithdrawLimits {
  /** Advertised min in the anchor's own (fiat) units, if any. */
  minAmount?: string;
  maxAmount?: string;
  assetCode: string;
}

export interface OpenSep6WithdrawParams {
  token: string;
  account: string;
  /** Decimal string in the anchor's USDC (7 decimal places). */
  amount: string;
  type?: string;
}

export interface OpenSep6WithdrawResult {
  id: string;
  /** The anchor's treasury account the USDC must be paid to. */
  accountId: string;
  memo: string;
  memoType: string;
  status: string;
  moreInfoUrl?: string;
}

export interface Sep6WithdrawOptions {
  fetchImpl?: AnchorFetchLike;
}

async function resolveTransferServer(
  fetchImpl: AnchorFetchLike,
): Promise<{ transferServer: string; assetCode: string }> {
  let endpoints;
  let usdc;
  try {
    [endpoints, usdc] = await Promise.all([
      discoverAnchorSepEndpoints(config.anchorHomeDomain, fetchImpl),
      resolveUsdcAsset({ fetchImpl }),
    ]);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnavailableError(`Could not resolve ${config.anchorHomeDomain}'s SEP-6 support: ${reason}`);
  }
  if (!endpoints.transferServer) {
    throw new AnchorUnavailableError(`${config.anchorHomeDomain}'s stellar.toml does not declare TRANSFER_SERVER`);
  }
  return { transferServer: endpoints.transferServer.replace(/\/$/, ""), assetCode: usdc.code };
}

function readAmount(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Reads the advertised withdraw min/max for the anchor's USDC from
 * `/sep6/info`. Missing limits mean the anchor advertises none -- the
 * service then skips the range check rather than inventing one. */
export async function fetchSep6WithdrawLimits(options: Sep6WithdrawOptions = {}): Promise<Sep6WithdrawLimits> {
  const fetchImpl = options.fetchImpl ?? defaultAnchorFetch;
  const { transferServer, assetCode } = await resolveTransferServer(fetchImpl);
  let response: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    response = await fetchImpl(`${transferServer}/info`, { method: "GET" });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnavailableError(`Could not reach ${config.anchorHomeDomain}'s SEP-6 info endpoint: ${reason}`);
  }
  if (!response.ok) {
    const reason = await anchorReasonFromResponse(response);
    throw new AnchorUnavailableError(
      `${config.anchorHomeDomain} refused SEP-6 info (HTTP ${response.status})${reason ? `: ${reason}` : ""}`,
    );
  }
  const body = await tryReadJson(response);
  const withdraw =
    typeof body === "object" && body !== null
      ? (body as { withdraw?: Record<string, Record<string, unknown>> }).withdraw
      : undefined;
  const assetInfo = withdraw?.[assetCode];
  return {
    minAmount: readAmount(assetInfo?.min_amount),
    maxAmount: readAmount(assetInfo?.max_amount),
    assetCode,
  };
}

export async function openSep6Withdraw(
  params: OpenSep6WithdrawParams,
  options: Sep6WithdrawOptions = {},
): Promise<OpenSep6WithdrawResult> {
  const fetchImpl = options.fetchImpl ?? defaultAnchorFetch;
  const { transferServer, assetCode } = await resolveTransferServer(fetchImpl);
  const url = new URL(`${transferServer}/withdraw`);
  url.searchParams.set("asset_code", assetCode);
  url.searchParams.set("account", params.account);
  url.searchParams.set("amount", params.amount);
  url.searchParams.set("type", params.type ?? "bank_account");

  let response: Pick<Response, "ok" | "status" | "json" | "text">;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${params.token}` },
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new AnchorUnavailableError(`Could not reach ${config.anchorHomeDomain}'s SEP-6 withdraw endpoint: ${reason}`);
  }
  if (!response.ok) {
    const reason = await anchorReasonFromResponse(response);
    throw new AnchorDepositError(
      `${config.anchorHomeDomain} refused the withdrawal (HTTP ${response.status})${reason ? `: ${reason}` : ""}`,
    );
  }
  const body = await tryReadJson(response);
  const root = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const id = typeof root.id === "string" ? root.id.trim() : "";
  const accountId = typeof root.account_id === "string" ? root.account_id.trim() : "";
  if (!id) {
    throw new AnchorDepositError(`${config.anchorHomeDomain}'s SEP-6 withdraw response did not include an id`);
  }
  if (!accountId) {
    throw new AnchorDepositError(
      `${config.anchorHomeDomain}'s SEP-6 withdraw response did not include a treasury account`,
    );
  }
  const memo = typeof root.memo === "string" ? root.memo.trim() : "";
  const memoType = typeof root.memo_type === "string" && root.memo_type.trim() !== "" ? root.memo_type.trim() : "id";
  const status =
    typeof root.status === "string" && root.status.trim() !== "" ? root.status.trim() : "pending_user_transfer_start";
  const moreInfoUrl =
    typeof root.more_info_url === "string" && root.more_info_url.trim() !== ""
      ? root.more_info_url.trim()
      : `${transferServer}/tx/${encodeURIComponent(id)}`;
  return { id, accountId, memo, memoType, status, moreInfoUrl };
}
