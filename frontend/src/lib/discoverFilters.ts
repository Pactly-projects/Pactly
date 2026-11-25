import type { DiscoverAvailability } from "../api/types";

/**
 * Issue #156: the Discover page's filters live in the URL, not only in the
 * page. This module is the one place that reads them back and writes them
 * down, so the back button, a shared link and a fixture URL all restore the
 * same state -- and so the round trip can be tested without a browser.
 *
 * Every reader here is deliberately forgiving: an unknown category slug, an
 * unknown sort or an out-of-range number is simply absent from the result,
 * never an error (the same "ignore, never error" rule the backend applies).
 */

export type DiscoverSort = "soonest" | "price-asc" | "price-desc";

export const DEFAULT_DISCOVER_SORT: DiscoverSort = "soonest";

export const DISCOVER_SORT_OPTIONS: ReadonlyArray<{ value: DiscoverSort; label: string }> = [
  { value: "soonest", label: "Soonest available" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
];

/** The session formats the seed and the card know about. */
export const DISCOVER_FORMAT_VALUES = ["in_person", "video"] as const;

const AVAILABILITY_VALUES: readonly DiscoverAvailability[] = ["24h", "week"];

/** Same shape the backend's own `parseDiscoverFilters` requires (AD-7's
 * smallest-unit integer strings, `"0"` allowed). */
const NON_NEGATIVE_INTEGER_STRING = /^(0|[1-9]\d*)$/;
const MIN_DEPOSIT_RATE_BPS_FILTER = 1;
const MAX_DEPOSIT_RATE_BPS_FILTER = 10000;

export interface DiscoverFilterState {
  /** Only ever a slug that is in the caller's known category list. */
  category?: string;
  /** Free-text neighbourhood, trimmed; `""` when unset. */
  neighborhood: string;
  /** The searched words, trimmed to `""` when only spaces. */
  q: string;
  formats: string[];
  minPrice?: string;
  maxPrice?: string;
  maxDepositBps?: number;
  when?: DiscoverAvailability;
  sort: DiscoverSort;
}

/**
 * `category` is resolved against `knownCategorySlugs` -- an unknown slug is
 * dropped, matching the page's own rule (it holds the providers query back
 * until the category list resolves, so a real slug is never mistaken for an
 * unknown one while loading).
 */
export function readDiscoverFilters(
  params: URLSearchParams,
  knownCategorySlugs: readonly string[],
): DiscoverFilterState {
  const requestedCategory = params.get("category");
  const category =
    requestedCategory !== null && knownCategorySlugs.includes(requestedCategory)
      ? requestedCategory
      : undefined;

  const qRaw = params.get("q") ?? "";
  const q = qRaw.trim() ? qRaw : "";
  const neighborhood = (params.get("neighborhood") ?? "").trim();

  const formats = params
    .getAll("format")
    .filter((format) => (DISCOVER_FORMAT_VALUES as readonly string[]).includes(format));

  const minPriceRaw = params.get("minPrice");
  const minPrice =
    minPriceRaw !== null && NON_NEGATIVE_INTEGER_STRING.test(minPriceRaw) ? minPriceRaw : undefined;
  const maxPriceRaw = params.get("maxPrice");
  const maxPrice =
    maxPriceRaw !== null && NON_NEGATIVE_INTEGER_STRING.test(maxPriceRaw) ? maxPriceRaw : undefined;

  const maxDepositBpsRaw = params.get("maxDepositBps");
  const parsedDepositBps =
    maxDepositBpsRaw !== null && /^\d+$/.test(maxDepositBpsRaw) ? Number(maxDepositBpsRaw) : undefined;
  const maxDepositBps =
    parsedDepositBps !== undefined &&
    parsedDepositBps >= MIN_DEPOSIT_RATE_BPS_FILTER &&
    parsedDepositBps <= MAX_DEPOSIT_RATE_BPS_FILTER
      ? parsedDepositBps
      : undefined;

  const whenRaw = params.get("when");
  const when =
    whenRaw !== null && (AVAILABILITY_VALUES as readonly string[]).includes(whenRaw)
      ? (whenRaw as DiscoverAvailability)
      : undefined;

  const sortRaw = params.get("sort");
  const sort = DISCOVER_SORT_OPTIONS.some((option) => option.value === sortRaw)
    ? (sortRaw as DiscoverSort)
    : DEFAULT_DISCOVER_SORT;

  return { category, neighborhood, q, formats, minPrice, maxPrice, maxDepositBps, when, sort };
}

/** The inverse of {@link readDiscoverFilters}: only set, non-default values
 * are written, so a cleared filter never lingers as an empty parameter. */
export function writeDiscoverFilters(filters: DiscoverFilterState): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.neighborhood.trim()) params.set("neighborhood", filters.neighborhood.trim());
  if (filters.q.trim()) params.set("q", filters.q);
  for (const format of filters.formats) params.append("format", format);
  if (filters.minPrice !== undefined) params.set("minPrice", filters.minPrice);
  if (filters.maxPrice !== undefined) params.set("maxPrice", filters.maxPrice);
  if (filters.maxDepositBps !== undefined) params.set("maxDepositBps", String(filters.maxDepositBps));
  if (filters.when) params.set("when", filters.when);
  if (filters.sort !== DEFAULT_DISCOVER_SORT) params.set("sort", filters.sort);
  return params;
}

export interface DiscoverViewableProvider {
  location: string;
  price: { amount: string };
}

function priceAmount(provider: DiscoverViewableProvider): bigint {
  try {
    return BigInt(provider.price.amount);
  } catch {
    return 0n;
  }
}

/**
 * The neighbourhood filter and the sort order, applied to the card list the
 * backend already returned (soonest-open-slot first). Neither changes what
 * the backend queries -- the URL parameters above are the state that makes
 * the view shareable, and this is the view itself.
 */
export function applyDiscoverView<T extends DiscoverViewableProvider>(
  providers: readonly T[],
  neighborhood: string,
  sort: DiscoverSort,
): T[] {
  const needle = neighborhood.trim().toLowerCase();
  const filtered = needle
    ? providers.filter((provider) => provider.location.toLowerCase().includes(needle))
    : [...providers];

  if (sort === "price-asc") {
    filtered.sort((a, b) => {
      const left = priceAmount(a);
      const right = priceAmount(b);
      if (left === right) return 0;
      return left < right ? -1 : 1;
    });
  } else if (sort === "price-desc") {
    filtered.sort((a, b) => {
      const left = priceAmount(a);
      const right = priceAmount(b);
      if (left === right) return 0;
      return left > right ? -1 : 1;
    });
  }

  return filtered;
}
