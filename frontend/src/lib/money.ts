/**
 * BigInt smallest-unit arithmetic -- the one place on the frontend that
 * turns an AD-7 integer string (USDC, 7 decimals) into human text. Never
 * parses the USDC side to a JS `number` (would lose precision for a large
 * amount), and never invents a currency symbol (DESIGN.md: "no screen
 * writes a currency symbol into a string").
 *
 * Product rule (2026-09 pivot): end users never see the escrow asset. Every
 * user-visible amount is shown in the local currency the anchor advertises
 * at the backend's `GET /api/rate`; its code and decimals both come from
 * that response. There is no hard-coded currency or fallback rate.
 */

/** The one copy of the balance-payment note shared by
 * `components/BookingActions.tsx`'s "Pay balance" step -- names the two
 * paths the UI actually offers for the balance (through Pactly before the
 * session, or in person to the provider), so any second surface must say
 * it identically rather than drift into a different wording. */
export const LOCAL_CURRENCY_UNAVAILABLE_NOTE = "Pay the balance through Pactly before the session, or settle it in person with the provider.";

/** Shown wherever an amount needs the anchor's currency configuration and
 * it could not be loaded. Deliberately a plain sentence, never a guessed
 * currency code or rate. */
export const LOCAL_CURRENCY_UNAVAILABLE = "We couldn't load the local currency right now. Try again in a moment.";

/** USDC on Stellar: 7 decimal places, matching `backend/src/services/
 * profile.ts`'s `computeDepositAmount`. */
const SMALLEST_UNIT_DECIMALS = 7;
/** Digits actually shown for USDC in internal/debug text (`14.35 USDC`) --
 * the smallest-unit precision is kept end to end in the amount string
 * itself, only the display is rounded. */
const DISPLAY_DECIMALS = 2;

/** Formats an integer smallest-unit string as `"1,234.50 USDC"`. Truncates
 * (never rounds up) to {@link DISPLAY_DECIMALS} places, so the displayed
 * figure never overstates what the amount string actually holds. */
export function formatMoney(amount: string, asset: string): string {
  const value = BigInt(amount);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const divisor = 10n ** BigInt(SMALLEST_UNIT_DECIMALS);
  const whole = magnitude / divisor;
  const fractionDigits = (magnitude % divisor).toString().padStart(SMALLEST_UNIT_DECIMALS, "0");
  const fraction = fractionDigits.slice(0, DISPLAY_DECIMALS);
  const wholeWithCommas = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${wholeWithCommas}.${fraction} ${asset}`;
}

/** `depositRateBps` as a plain percentage string, e.g. `2000` -> `"20%"`. */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/** The rules form's own two directions of conversion between a human
 * decimal string (what someone types, e.g. `"90"` or `"90.5"`) and the
 * integer smallest-unit string the API takes and returns (AD-7). Kept next
 * to {@link formatMoney} since both are "smallest-unit string" arithmetic,
 * not a second money module (the spec's own "one BigInt formatter stays
 * small" design note). */
export function parseDecimalToSmallestUnit(input: string): string | undefined {
  const trimmed = input.trim();
  if (!/^\d+(\.\d{1,7})?$/.test(trimmed)) {
    return undefined;
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const paddedFraction = fraction.padEnd(SMALLEST_UNIT_DECIMALS, "0");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
  const combined = `${normalizedWhole}${paddedFraction}`.replace(/^0+(?=\d)/, "");
  return combined.length === 0 ? "0" : combined;
}

export function smallestUnitToDecimalInput(amount: string): string {
  const value = BigInt(amount);
  const divisor = 10n ** BigInt(SMALLEST_UNIT_DECIMALS);
  const whole = value / divisor;
  const fraction = (value % divisor).toString().padStart(SMALLEST_UNIT_DECIMALS, "0").replace(/0+$/, "");
  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

// ---------------------------------------------------------------------------
// Local-currency display. The rate (`GET /api/rate`'s `rate`, local currency
// per 1 USDC) is a decimal string such as "48.5410"; it is parsed once into
// an integer numerator plus a power-of-ten scale so every conversion below
// stays in BigInt -- no float ever touches the USDC side. The currency code
// and display decimals are always parameters from the anchor's own config,
// never constants here.
// ---------------------------------------------------------------------------

interface ScaledRate {
  /** `rate * 10^decimals`, as an integer. */
  numerator: bigint;
  decimals: number;
}

function isValidDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0;
}

function parseRate(rate: string): ScaledRate | undefined {
  const trimmed = rate.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    return undefined;
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  const numerator = BigInt(`${whole}${fraction}`);
  if (numerator === 0n) {
    return undefined;
  }
  return { numerator, decimals: fraction.length };
}

/** Integer division rounded half-up (both operands non-negative). */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Converts a USDC smallest-unit integer string to the local currency at
 * `rate`, as a plain decimal string with exactly the anchor's `decimals`
 * places. Computed entirely in the local currency's minor unit, rounded
 * half-up. An unparseable rate or decimals yields `""` rather than throwing
 * -- a display helper must never take a screen down, and the caller shows
 * the plain unavailable sentence instead.
 */
export function usdcToLocalCurrency(amountSmallestUnit: string, rate: string, decimals: number): string {
  if (!isValidDecimals(decimals)) {
    return "";
  }
  const parsed = parseRate(rate);
  if (!parsed) {
    return "";
  }
  let value: bigint;
  try {
    value = BigInt(amountSmallestUnit);
  } catch {
    return "";
  }
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  // minor = amount * rate * 10^decimals / 10^7, with rate = numerator / 10^decimals.
  const minor = divideRounded(
    magnitude * parsed.numerator * scale,
    10n ** BigInt(SMALLEST_UNIT_DECIMALS + parsed.decimals),
  );
  const whole = minor / scale;
  if (decimals === 0) {
    return `${negative ? "-" : ""}${whole}`;
  }
  const fraction = (minor % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** `"2,912.46 USD"` -- English digit grouping, ISO code rather than a
 * symbol (the app's copy rule). The one formatter every user-visible
 * amount goes through (via `LocalAmount`). Returns `""` when the anchor's
 * configuration is unusable, so callers can show a plain error instead. */
export function formatLocalAmount(
  amountSmallestUnit: string,
  rate: string,
  currency: string,
  decimals: number,
): string {
  if (!currency || !isValidDecimals(decimals)) {
    return "";
  }
  const decimal = usdcToLocalCurrency(amountSmallestUnit, rate, decimals);
  if (!decimal) {
    return "";
  }
  const negative = decimal.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? decimal.slice(1) : decimal).split(".");
  const fractionText = decimals > 0 ? `.${fraction}` : "";
  return `${negative ? "-" : ""}${groupThousands(whole)}${fractionText} ${currency}`;
}

/**
 * The inverse for inputs: a local-currency amount someone typed (`"2400"`,
 * `"2,400.50"`; at most the anchor's `decimals` places, thousands commas
 * tolerated, the anchor's currency code or any currency symbol stripped) to
 * the USDC smallest-unit integer string the API takes, at `rate`. Rounded
 * half-up to the smallest unit. `undefined` for anything that is not a
 * non-negative decimal, or for an unusable rate/currency configuration.
 */
export function normaliseLocalCurrencyInput(input: string, currency: string, decimals: number): string | undefined {
  if (!isValidDecimals(decimals)) {
    return undefined;
  }
  let text = input;
  if (currency) {
    const escapedCurrency = currency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(escapedCurrency, "gi"), "");
  }
  text = text.replace(/[\p{Sc}\s]/gu, "");
  if (!/^\d[\d.,]*$/.test(text)) {
    return undefined;
  }
  const lastDot = text.lastIndexOf(".");
  const lastComma = text.lastIndexOf(",");
  let decimalSeparator: "." | "," | undefined;
  if (lastDot !== -1 && lastComma !== -1) {
    decimalSeparator = lastDot > lastComma ? "." : ",";
  } else if (lastDot !== -1 || lastComma !== -1) {
    const separator = lastDot !== -1 ? "." : ",";
    const digitsAfter = text.length - Math.max(lastDot, lastComma) - 1;
    const occurrences = text.split(separator).length - 1;
    // A lone separator with at most `decimals` digits after it is a decimal
    // point; three digits after it is grouping unless the currency itself
    // has three decimal places.
    decimalSeparator = occurrences === 1 && digitsAfter <= decimals ? separator : undefined;
  }
  let whole = text;
  let fraction = "";
  if (decimalSeparator) {
    const at = text.lastIndexOf(decimalSeparator);
    whole = text.slice(0, at);
    fraction = text.slice(at + 1);
  }
  whole = whole.replace(/[.,]/g, "");
  if (!/^\d+$/.test(whole) || !new RegExp(`^\\d{0,${decimals}}$`).test(fraction)) {
    return undefined;
  }
  text = fraction ? `${whole}.${fraction}` : whole;
  return text;
}

export function localCurrencyToUsdcSmallestUnit(
  input: string,
  rate: string,
  currency: string,
  decimals: number,
): string | undefined {
  if (!isValidDecimals(decimals)) {
    return undefined;
  }
  const parsed = parseRate(rate);
  if (!parsed) {
    return undefined;
  }
  const normalised = normaliseLocalCurrencyInput(input, currency, decimals);
  if (normalised === undefined) {
    return undefined;
  }
  const [whole = "0", fraction = ""] = normalised.split(".");
  if (fraction.length > decimals) {
    return undefined;
  }
  const minor = BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
  // smallest = minor * 10^7 * 10^rateDecimals / (10^decimals * numerator)
  const smallest = divideRounded(
    minor * 10n ** BigInt(SMALLEST_UNIT_DECIMALS + parsed.decimals),
    10n ** BigInt(decimals) * parsed.numerator,
  );
  return smallest.toString();
}
