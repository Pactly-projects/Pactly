import { useCallback } from "react";

import { useLocalCurrencyRate } from "../api/hooks";
import { formatLocalAmount, LOCAL_CURRENCY_UNAVAILABLE } from "../lib/money";

/** The one formatter for an amount that has to live inside a sentence
 * (a button label, a policy statement) rather than its own element --
 * same rate, currency and decimals as {@link LocalAmount}. When the
 * anchor's currency configuration cannot be loaded, returns the plain
 * unavailable sentence rather than guessing a currency or rate. */
export function useFormatLocalAmount(): (amountSmallestUnit: string) => string {
  const localCurrency = useLocalCurrencyRate();
  return useCallback(
    (amountSmallestUnit: string) => {
      if (!localCurrency) return LOCAL_CURRENCY_UNAVAILABLE;
      return (
        formatLocalAmount(
          amountSmallestUnit,
          localCurrency.rate,
          localCurrency.currency,
          localCurrency.decimals,
        ) || LOCAL_CURRENCY_UNAVAILABLE
      );
    },
    [localCurrency],
  );
}

export interface LocalAmountProps {
  /** Integer string, USDC smallest units (AD-7) -- the amount as the API
   * holds it. The conversion to the anchor's local currency happens here
   * and nowhere else. */
  amount: string;
  /** Appended to the element's own `tabular-nums`. */
  className?: string;
}

/**
 * THE way an amount reaches a screen: `"2,912.46 USD"` (or whatever code
 * and decimals the anchor reports) at the backend's current rate
 * (`useLocalCurrencyRate`). Renders a `<span>` so it can sit inside any
 * `<strong>`, `<dd>` or `<td>` the caller already styles. A missing
 * currency configuration renders a plain error sentence, never a lira
 * fallback.
 */
export function LocalAmount({ amount, className }: LocalAmountProps) {
  const format = useFormatLocalAmount();
  return <span className={className ? `tabular-nums ${className}` : "tabular-nums"}>{format(amount)}</span>;
}
