/**
 * The provider dashboard's own wallet-readiness read: "can this shop receive
 * the deposit asset at all?" A missing USDC trustline means a client cannot
 * lock a deposit with this shop, so the dashboard says so before a client
 * discovers it. Read-only by construction -- it calls the trustline reader
 * and nothing that builds or submits a change-trust transaction.
 *
 * `hasTrustline` is `null` when the check itself could not be answered
 * (Horizon or the anchor unreachable): the panel then shows no warning
 * rather than a false alarm, and every existing booking still renders.
 */
import { hasUsdcTrustline, type UsdcTrustlineDeps } from "../anchor/trustline.js";

export interface ProviderTrustlineStatus {
  hasTrustline: boolean | null;
}

export async function getProviderTrustlineStatus(
  walletAddress: string,
  deps: UsdcTrustlineDeps = {},
): Promise<ProviderTrustlineStatus> {
  try {
    return { hasTrustline: await hasUsdcTrustline(walletAddress, deps) };
  } catch (error) {
    console.error(
      "[provider-trustline] check unavailable",
      error instanceof Error ? error.message : String(error),
    );
    return { hasTrustline: null };
  }
}
