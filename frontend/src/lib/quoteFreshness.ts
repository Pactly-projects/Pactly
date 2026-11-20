/**
 * The one staleness rule the booking screen uses for a SEP-38 quote. The
 * quote carries its own age (60 seconds when the anchor did not state one)
 * and the screen records *when it fetched the quote*, not merely when it
 * rendered it -- a tab left open must not keep presenting an amount the
 * anchor would no longer honour as current.
 */
import type { QuoteResponse } from "../api/types";

export const DEFAULT_QUOTE_AGE_SECONDS = 60;

export interface DisplayedQuote {
  quote: QuoteResponse;
  /** Epoch milliseconds at which this quote was fetched by the screen. */
  fetchedAtMs: number;
}

export function rememberQuote(quote: QuoteResponse, fetchedAtMs: number = Date.now()): DisplayedQuote {
  return { quote, fetchedAtMs };
}

/** A quote is stale once either its own age has passed or the anchor's own
 * `expiresAt` has passed, whichever comes first. */
export function displayedQuoteIsStale(displayed: DisplayedQuote, nowMs: number = Date.now()): boolean {
  const ageSeconds = displayed.quote.maxAgeSeconds ?? DEFAULT_QUOTE_AGE_SECONDS;
  const ageDeadline = displayed.fetchedAtMs + ageSeconds * 1000;
  const anchorDeadline = displayed.quote.expiresAt ? displayed.quote.expiresAt * 1000 : Number.POSITIVE_INFINITY;
  return nowMs >= Math.min(ageDeadline, anchorDeadline);
}

export interface FreshQuoteResult {
  quote: QuoteResponse;
  refreshed: boolean;
}

/**
 * Returns a quote the client can safely confirm. When the displayed one has
 * aged out, `refresh` fetches a new one; if that refresh fails, the caller
 * gets `undefined` and must block the deposit while keeping the previous
 * figure on screen labelled as old.
 */
export async function freshQuote(
  displayed: DisplayedQuote | undefined,
  fetchQuote: (refresh: boolean) => Promise<QuoteResponse>,
  nowMs: number = Date.now(),
): Promise<FreshQuoteResult | undefined> {
  if (!displayed) {
    try {
      return { quote: await fetchQuote(false), refreshed: false };
    } catch {
      return undefined;
    }
  }
  if (!displayedQuoteIsStale(displayed, nowMs)) {
    return { quote: displayed.quote, refreshed: false };
  }
  try {
    return { quote: await fetchQuote(true), refreshed: true };
  } catch {
    return undefined;
  }
}
