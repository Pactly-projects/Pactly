import { useState } from "react";

import { shortenStellarId } from "../lib/stellar";

export interface ReceivingAddressProps {
  /** Issue #158: the address stored for the shop, not a newly generated one.
   * `null`/`undefined` when no address is stored. */
  address?: string | null;
}

/**
 * The shop's escrow receiver, shown on the booking for both the client and
 * the shop. Long and copyable: the displayed value is shortened for the
 * line, the full value sits in `title` and on the clipboard. A missing
 * address says it is unset rather than showing a blank or inventing one.
 */
export function ReceivingAddress({ address }: ReceivingAddressProps) {
  const [copied, setCopied] = useState(false);

  if (!address) {
    return (
      <div className="receiving-address">
        <span className="receiving-address__label">Shop receiving address</span>
        <span className="receiving-address__unset">Not set yet</span>
      </div>
    );
  }

  async function copyAddress(): Promise<void> {
    try {
      await navigator.clipboard.writeText(address!);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied: the full address is still selectable from the
      // title, and nothing about the booking changes.
      setCopied(false);
    }
  }

  return (
    <div className="receiving-address">
      <span className="receiving-address__label">Shop receiving address</span>
      <code className="receiving-address__value" title={address}>
        {shortenStellarId(address)}
      </code>
      <button type="button" className="button-ghost" aria-label="Copy the shop receiving address" onClick={() => void copyAddress()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
