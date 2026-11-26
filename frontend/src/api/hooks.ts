/** TanStack Query hooks over `client.ts` -- the only place a page reaches
 * for provider/category data. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiGet, apiPost, apiPut, ApiError, apiDelete } from "./client";
import { apiDelete, apiGet, apiPost, apiPut, ApiError } from "./client";
import type {
  ActionResponse,
  AdminDisputesResponse,
  BalancePaymentBuildResponse,
  BalancePaymentSubmitResponse,
  BookingView,
  CategoriesResponse,
  CloseProviderDateResponse,
  DiscoverFiltersParams,
  DisputeOutcome,
  DisputeReason,
  FundResponse,
  HoldSlotResponse,
  LockResponse,
  MyBookingsResponse,
  MyEventsResponse,
  OpenDisputeResponse,
  ProofResponse,
  ProviderBookingsResponse,
  ProviderBreak,
  ProviderProfile,
  ProvidersResponse,
  QuoteResponse,
  ReleaseDepositResponse,
  ResolveDisputeResponse,
  SubmitResponse,
  SuggestResponse,
  AnchorChallengeResponse,
  LocalDepositView,
  OpenLocalDepositResponse,
  AdminApplicationsResponse,
  AdminProviderApplication,
  DepositPreviewInput,
  DepositPreviewResponse,
  OwnProviderApplicationResponse,
  ProviderApplicationInput,
  ProviderApplicationOutcome,
  ProviderReview,
  RateResponse,
  SaveShopResponse,
  UnsaveShopResponse,
  IsShopSavedResponse,
  SavedShopsResponse,
  ShopReportSubmitResponse,
  ShopReportsListResponse,
  ClosedDatesResponse,
  ProviderProfileEditInput,
} from "./types";
import type { Session } from "../wallet";

export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () => apiGet<CategoriesResponse>("/categories"),
  });
}

export interface UseDiscoverProvidersOptions {
  /** Defaults to `true`. `DiscoverPage` sets this `false` while a
   * `?category=` slug in the URL has not yet been checked against the
   * loaded category list -- firing this query too early would fetch (and
   * briefly show) the unfiltered list before the real filter is known. */
  enabled?: boolean;
}

/** Builds `GET /providers`'s query string from every Story 3.2/3.3 filter
 * -- the one place a `DiscoverFiltersParams` becomes a URL, so
 * `useDiscoverProviders`'s query key and its actual request can never
 * drift apart. `format` is repeated (`?format=a&format=b`), matching the
 * backend's own `c.req.queries("format")` read. */
function buildProvidersPath(filters: DiscoverFiltersParams): string {
  const params = new URLSearchParams();
  if (filters.category) params.set("category", filters.category);
  if (filters.q) params.set("q", filters.q);
  for (const format of filters.formats ?? []) {
    params.append("format", format);
  }
  if (filters.minPrice !== undefined) params.set("minPrice", filters.minPrice);
  if (filters.maxPrice !== undefined) params.set("maxPrice", filters.maxPrice);
  if (filters.maxDepositBps !== undefined) params.set("maxDepositBps", String(filters.maxDepositBps));
  if (filters.when) params.set("when", filters.when);
  if (filters.sort) params.set("sort", filters.sort);
  const query = params.toString();
  return query ? `/providers?${query}` : "/providers";
}

/** `GET /providers[?category=&q=&format=&minPrice=&maxPrice=&maxDepositBps=&when=]`
 * -- the Discover list, no auth, no retry (an unknown category will not
 * become known by retrying; a genuine network failure is handled by the
 * page's own error state, not a silent background retry that would delay
 * it). */
export function useDiscoverProviders(filters: DiscoverFiltersParams, options: UseDiscoverProvidersOptions = {}) {
  return useQuery({
    queryKey: ["providers", filters],
    queryFn: () => apiGet<ProvidersResponse>(buildProvidersPath(filters)),
    enabled: options.enabled ?? true,
    retry: false,
  });
}

/** `GET /providers/suggest?q=` -- Story 3.3's autocomplete. No auth, no
 * retry; disabled below the backend's own two-character minimum so a
 * one-character query never fires a request that would only come back
 * empty anyway. */
export function useProviderSuggestions(query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["providers", "suggest", trimmed],
    queryFn: () => apiGet<SuggestResponse>(`/providers/suggest?q=${encodeURIComponent(trimmed)}`),
    enabled: trimmed.length >= 2,
    retry: false,
  });
}

/** The public `GET /providers/:id` view -- optional auth, no retry on a 404
 * (an unapproved/unknown id will not become approved by retrying). */
export function usePublicProviderProfile(id: string | undefined, token?: string) {
  return useQuery({
    queryKey: ["providers", id, token],
    queryFn: () => apiGet<ProviderProfile>(`/providers/${id}`, token),
    enabled: Boolean(id),
    retry: false,
  });
}

/** Story 2.2: `GET /quote`'s indicative local-currency equivalent for a
 * USDC smallest-unit `amount` -- one query per distinct amount, so the
 * deposit, balance and total on the payment step each get their own quote.
 * A quote failure never blocks the flow (this story's own "Always" rule),
 * so this never retries past the backend's own 60s cache window and the
 * caller renders its own plain-sentence fallback on `isError`. */
export function useQuote(amount: string | undefined) {
  return useQuery({
    queryKey: ["quote", amount],
    queryFn: () => apiGet<QuoteResponse>(`/quote?amount=${amount}`),
    enabled: Boolean(amount),
    retry: false,
    staleTime: 60_000,
  });
}

/**
 * The imperative quote read the booking screen uses when the figure it is
 * showing has aged out. `refresh: true` sends `?refresh=1`, which bypasses
 * the backend's own short cache so the amount the client confirms really is
 * the anchor's current one. A pure read: it never creates a hold or booking.
 */
export function getQuote(amount: string, refresh = false): Promise<QuoteResponse> {
  return apiGet<QuoteResponse>(`/quote?amount=${amount}${refresh ? "&refresh=1" : ""}`);
}

const OWN_PROVIDER_KEY = (walletAddress: string | undefined) => ["me", "provider", walletAddress] as const;

/** `GET /me/provider` -- the signed-in provider's own view, including
 * while unapproved. */
export function useOwnProviderProfile(session: Session | undefined) {
  return useQuery({
    queryKey: OWN_PROVIDER_KEY(session?.walletAddress),
    queryFn: () => apiGet<ProviderProfile>("/me/provider", session?.token),
    enabled: Boolean(session),
    retry: false,
  });
}

export interface ProviderRulesInput {
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
  maxBookingDaysAhead: number | null;
  bufferMinutes: number;
}

export function useUpdateProviderRules(session: Session | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProviderRulesInput) => apiPut<ProviderProfile>("/me/provider/rules", input, session?.token),
    onSuccess: (profile) => {
      queryClient.setQueryData(OWN_PROVIDER_KEY(session?.walletAddress), profile);
    },
  });
}

/** Issue #62: `PUT /me/provider/pause` -- the shop's own pause/resume of
 * new bookings (idempotent on the server; the response seeds the cache). */
export function useSetProviderBookingsPaused(session: Session | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => apiPut<ProviderProfile>("/me/provider/pause", { paused }, session?.token),
    onSuccess: (profile) => {
      queryClient.setQueryData(OWN_PROVIDER_KEY(session?.walletAddress), profile);
    },
  });
}

/** Issue #64: `PUT /me/provider/timezone` -- the shop's own IANA zone for
 * slot labels. Stored instants are untouched. */
export function useUpdateProviderTimezone(session: Session | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (timezone: string) => apiPut<ProviderProfile>("/me/provider/timezone", { timezone }, session?.token),
    onSuccess: (profile) => {
      queryClient.setQueryData(OWN_PROVIDER_KEY(session?.walletAddress), profile);
    },
  });
}

/** Issue #65: `PUT /me/provider/breaks` -- replaces the shop's weekly
 * breaks; the response carries the pruned slot set too. */
export function useUpdateProviderBreaks(session: Session | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (breaks: ProviderBreak[]) => apiPut<ProviderProfile>("/me/provider/breaks", { breaks }, session?.token),
    onSuccess: (profile) => {
      queryClient.setQueryData(OWN_PROVIDER_KEY(session?.walletAddress), profile);
    },
  });
}

export function useUpdateProviderAvailability(session: Session | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (slots: number[]) => apiPut<ProviderProfile>("/me/provider/availability", { slots }, session?.token),
    onSuccess: (profile) => {
      queryClient.setQueryData(OWN_PROVIDER_KEY(session?.walletAddress), profile);
    },
  });
}

/** `POST /me/provider/availability/close-date` -- closes one local calendar
 * date: its unpaid holds are released (no deposit is taken from those
 * clients) and its open slots are removed. A funded booking is never
 * released; the response names it in `needsResolution`. */
export function closeProviderDate(
  date: string,
  session: Session,
  endDate: string = date,
  tzOffsetMinutes = new Date().getTimezoneOffset(),
): Promise<CloseProviderDateResponse> {
  return apiPost<CloseProviderDateResponse>(
    "/me/provider/availability/close-date",
    { date, endDate, tzOffsetMinutes },
    session.token,
  );
}

// ---------------------------------------------------------------------------
// Story 3.4: the client booking flow. `BookingPage.tsx` drives lock/fund/
// submit imperatively (each step waits on a wallet signature before the
// next call is even built), so those three are plain async functions, not
// mutations -- only the hold and the polling read need TanStack Query's own
// caching/retry behavior.
// ---------------------------------------------------------------------------

export interface HoldSlotInput {
  providerId: string;
  slotStartsAt: number;
  tzOffsetMinutes?: number;
  /** Optional client contact email for the shop's post-release mailto draft. */
  clientEmail?: string;
  renewExpired?: boolean;
}

/**
 * Review follow-up: `mutateAsync` takes the token as part of its own call
 * arguments now, rather than closing over whatever `session` this hook was
 * *rendered* with. `BookingPage.tsx`'s first-time sign-in flow calls
 * `signIn()`, then immediately holds the slot in the very same function --
 * `setSession(activeSession)` only takes effect on the *next* render, so a
 * `useHoldSlot(session)`-style hook would still capture the old (absent)
 * session in its `mutationFn` closure for that same call. Passing the
 * fresh token explicitly avoids relying on a render that has not happened
 * yet.
 */
export function useHoldSlot() {
  return useMutation({
    mutationFn: ({ token, ...input }: HoldSlotInput & { token: string }) => apiPost<HoldSlotResponse>("/bookings/hold", input, token),
  });
}

/** `POST /bookings/:id/reschedule` -- move a locked booking to another open
 * slot of the same shop while inside its free-cancellation window. The
 * escrow contract, amount and parties are untouched; no second escrow is
 * deployed. */
export function rescheduleBooking(bookingId: string, slotStartsAt: number, session: Session): Promise<BookingView> {
  return apiPost<BookingView>(`/bookings/${bookingId}/reschedule`, { slotStartsAt }, session.token);
}

export function lockDeposit(bookingId: string, session: Session, rebuild = false): Promise<LockResponse> {
  return apiPost<LockResponse>(`/bookings/${bookingId}/lock`, rebuild ? { rebuild: true } : {}, session.token);
}

export function fundDeposit(bookingId: string, session: Session, assertionToken?: string): Promise<FundResponse> {
  return apiPost<FundResponse>(`/bookings/${bookingId}/fund`, {}, session.token, { assertionToken });
}

/** `GET /bookings/:id` once, outside the poll -- what the booking screen
 * reads the moment a hold comes back, so a booking whose escrow was
 * already created (issue #5) or whose deploy history matters (issue #7) is
 * known before the client taps anything. */
export function getBooking(bookingId: string, session: Session): Promise<BookingView> {
  return apiGet<BookingView>(`/bookings/${bookingId}`, session.token);
}

/** Runs one chain reconcile for this booking and returns its updated view. */
export function reconcileBooking(bookingId: string, session: Session): Promise<BookingView> {
  return apiPost<BookingView>(`/bookings/${bookingId}/reconcile`, {}, session.token);
}

export function submitSignedTransaction(bookingId: string, signedXdr: string, session: Session): Promise<SubmitResponse> {
  return apiPost<SubmitResponse>(`/bookings/${bookingId}/submit`, { signedXdr }, session.token);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `fundDeposit`, retried a few times -- the Design Notes' own documented
 * alternative to polling for "the deploy is visible": Trustless Work's
 * build-fund step can only succeed once the just-submitted deploy
 * transaction has actually landed on Soroban (a few seconds after
 * submission, not instant), and nothing in the read API surfaces a
 * finer-grained "deployed but not yet funded" signal (the reconciler's own
 * lifecycle only ever starts at "funded").
 *
 * Review follow-up on the retry policy itself: `ESCROW_UNAVAILABLE` (a
 * transient Trustless Work outage) is always retried. `ESCROW_REJECTED`
 * (a real refusal) is only retried within the first 30 seconds after the
 * deploy was submitted -- the window where "the contract doesn't exist
 * yet" is the most likely explanation; past that, continuing to retry
 * would just mask a genuine, permanent refusal as a slow success. Any
 * other failure (`BOOKING_STATE`, a network drop, `401`) is rethrown
 * immediately, unretried.
 *
 * Issue #5 adds one more retryable code: `DEPOSIT_STATUS_UNAVAILABLE`, the
 * backend's own "the network could not be asked whether the fund you
 * already built has landed" -- nothing moved, so asking again is the whole
 * answer. `DEPOSIT_LANDED`, by contrast, is never retried: that one means
 * the money is already in, and the screen's job is to wait for the
 * confirmation, not to build a second fund.
 */
export async function fundDepositWithRetry(
  bookingId: string,
  session: Session,
  deploySubmittedAtMs: number,
  assertionToken?: string,
  attempts = 5,
  delayMs = 2500,
): Promise<FundResponse> {
  const REJECTED_RETRY_WINDOW_MS = 30_000;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fundDeposit(bookingId, session, assertionToken);
    } catch (error) {
      const withinRejectedWindow = Date.now() - deploySubmittedAtMs < REJECTED_RETRY_WINDOW_MS;
      const retryable =
        error instanceof ApiError &&
        (error.code === "ESCROW_UNAVAILABLE" ||
          error.code === "DEPOSIT_STATUS_UNAVAILABLE" ||
          (error.code === "ESCROW_REJECTED" && withinRejectedWindow));
      if (!retryable || attempt === attempts) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
  // Unreachable -- the loop above always returns or throws.
  throw new Error("fundDepositWithRetry: exhausted attempts without returning or throwing");
}

/** Public shareable proof for a deployed booking -- no auth. */
export function useProof(id: string | undefined) {
  return useQuery({
    queryKey: ["proof", id],
    queryFn: () => apiGet<ProofResponse>(`/proof/${id}`),
    enabled: Boolean(id),
    retry: false,
  });
}

/** `GET /bookings/:id`, polled while the booking hasn't reached a terminal
 * `escrowState` yet -- the one place the UI learns "locked" actually
 * happened (never from a submit response, per the spec's own "Always"
 * rule). `refetchInterval` stays a short constant rather than a prop:
 * every caller of this hook wants the same "poll until reconciled"
 * behavior. */
const BOOKING_POLL_INTERVAL_MS = 2000;

export function useBooking(bookingId: string | undefined, session: Session | undefined, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: ["bookings", bookingId],
    queryFn: () => apiGet<BookingView>(`/bookings/${bookingId}`, session?.token),
    enabled: Boolean(bookingId && session) && (options.enabled ?? true),
    retry: false,
    // Review follow-up: stop polling once a terminal `escrowState` is seen
    // (unchanged) *and* once the last attempt errored (a 401, a dropped
    // connection, ...) -- `retry: false` only skips retrying that one
    // failed fetch, it does not stop `refetchInterval` from trying again
    // on schedule regardless of the last outcome.
    refetchInterval: (query) => (query.state.data?.escrowState || query.state.error ? false : BOOKING_POLL_INTERVAL_MS),
  });
}

// ---------------------------------------------------------------------------
// Story 3.5: the two-sided status panel. No actions live here yet (Stories
// 3.6/3.7), so both lists are plain queries -- no mutation, no
// `queryClient.setQueryData` to keep in sync with anything.
// ---------------------------------------------------------------------------

/** `GET /me/bookings` -- "My bookings": every booking the signed-in wallet
 * is the client on, across every provider. */
export function useMyBookings(session: Session | undefined) {
  return useQuery({
    queryKey: ["me", "bookings", session?.walletAddress],
    queryFn: () => apiGet<MyBookingsResponse>("/me/bookings", session?.token),
    enabled: Boolean(session),
    retry: false,
  });
}

/** Issue #31: the signed-in wallet's own in-app event list (lock, release,
 * dispute, resolve) across every booking they are a party to, newest first. */
export function useMyEvents(session: Session | undefined) {
  return useQuery({
    queryKey: ["me", "events", session?.walletAddress],
    queryFn: () => apiGet<MyEventsResponse>("/me/events", session?.token),
    enabled: Boolean(session),
    retry: false,
  });
}

/** `GET /me/provider/bookings` -- the provider panel's "Bookings" view. */
export function useProviderBookings(session: Session | undefined) {
  return useQuery({
    queryKey: ["me", "provider", "bookings", session?.walletAddress],
    queryFn: () => apiGet<ProviderBookingsResponse>("/me/provider/bookings", session?.token),
    enabled: Boolean(session),
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Story 3.6: appointment completion, release and resolution. Each action
// builds an unsigned XDR the caller still has to sign and submit (3.4's own
// `signXdr` + `submitSignedTransaction` pair) -- these stay plain async
// functions, the same reasoning `lockDeposit`/`fundDeposit` above already
// follow: the caller drives a multi-step flow (build -> sign -> submit),
// which a single `useMutation` cannot express as cleanly as an imperative
// call `BookingCard.tsx` awaits step by step.
// ---------------------------------------------------------------------------

export function completeAppointment(bookingId: string, session: Session): Promise<ActionResponse> {
  return apiPost<ActionResponse>(`/bookings/${bookingId}/complete`, {}, session.token);
}

export function approveAppointment(bookingId: string, session: Session): Promise<ActionResponse> {
  return apiPost<ActionResponse>(`/bookings/${bookingId}/approve`, {}, session.token);
}

export function releaseDeposit(bookingId: string, session: Session, assertionToken: string): Promise<ActionResponse> {
  return apiPost<ActionResponse>(`/bookings/${bookingId}/release`, {}, session.token, { assertionToken });
}

/** Builds the unsigned start-dispute XDR and, in the same response, the
 * booking policy's own suggested outcome -- the caller shows that sentence
 * *before* ever asking for a signature (EXPERIENCE.md: "Cancelling and
 * resolution" -- policy guidance stated first, chain state kept separate).
 * Building this XDR has no on-chain effect by itself; nothing moves unless
 * the caller goes on to sign and submit it. */
export function openDispute(
  bookingId: string,
  reason: DisputeReason,
  session: Session,
  assertionToken: string,
): Promise<OpenDisputeResponse> {
  return apiPost<OpenDisputeResponse>(`/bookings/${bookingId}/dispute`, { reason }, session.token, { assertionToken });
}

/** Pactly's own dispute-resolver signature -- only ever callable by the
 * admin wallet that is also `TRUSTLESS_WORK_PLATFORM_ADDRESS` (the backend
 * enforces this; `ResolutionsPage.tsx` just calls it and shows whatever
 * comes back, including a `403 NOT_DISPUTE_RESOLVER`). */
export function resolveDispute(
  bookingId: string,
  outcome: DisputeOutcome,
  session: Session,
  assertionToken: string,
): Promise<ResolveDisputeResponse> {
  return apiPost<ResolveDisputeResponse>(
    `/admin/bookings/${bookingId}/resolve`,
    { outcome },
    session.token,
    { assertionToken },
  );
}

/** `GET /admin/disputes` -- the admin "Resolutions" list. No retry: a
 * `404 NOT_ADMIN` will not become true by retrying the same wallet. */
export function useAdminDisputes(session: Session | undefined) {
  return useQuery({
    queryKey: ["admin", "disputes", session?.walletAddress],
    queryFn: () => apiGet<AdminDisputesResponse>("/admin/disputes", session?.token),
    enabled: Boolean(session),
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Story 3.7: paying the balance before the session. Two independent paths
// (AD-3: neither ever touches escrow) -- `buildBalancePayment`/
// `submitBalancePayment` are the client's own build -> sign -> submit pair
// (same imperative-function shape as `lockDeposit`/`fundDeposit`/
// `submitSignedTransaction` above, for the same reason: the caller drives a
// multi-step flow no single `useMutation` expresses as cleanly);
// `markBalancePaidCash` is the provider's own one-step record.
// ---------------------------------------------------------------------------

export function buildBalancePayment(bookingId: string, session: Session): Promise<BalancePaymentBuildResponse> {
  return apiPost<BalancePaymentBuildResponse>(`/bookings/${bookingId}/balance/pay`, {}, session.token);
}

export function submitBalancePayment(bookingId: string, signedXdr: string, session: Session): Promise<BalancePaymentSubmitResponse> {
  return apiPost<BalancePaymentSubmitResponse>(`/bookings/${bookingId}/balance/submit`, { signedXdr }, session.token);
}

/** The shop declines an unlocked hold on its own slot. */
export function declineHold(bookingId: string, session: Session): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>(`/bookings/${bookingId}/decline`, {}, session.token);
}

export function markBalancePaidCash(bookingId: string, session: Session): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>(`/bookings/${bookingId}/balance/mark-cash`, {}, session.token);
}

export function markBookingArrived(bookingId: string, session: Session): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>(`/bookings/${bookingId}/arrived`, {}, session.token);
}

// ---------------------------------------------------------------------------
// Story 2.4: local-currency deposit. Imperative like lock/fund -- each
// step waits on a wallet signature, so these are plain async functions.
// ---------------------------------------------------------------------------

export function requestAnchorChallenge(bookingId: string, session: Session): Promise<AnchorChallengeResponse> {
  return apiPost<AnchorChallengeResponse>(`/bookings/${bookingId}/anchor/challenge`, {}, session.token);
}

export function verifyAnchorChallenge(bookingId: string, signedXdr: string, session: Session): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>(`/bookings/${bookingId}/anchor/verify`, { signedXdr }, session.token);
}

export function openLocalDeposit(
  bookingId: string,
  session: Session,
  quote?: QuoteResponse,
): Promise<OpenLocalDepositResponse> {
  return apiPost<OpenLocalDepositResponse>(`/bookings/${bookingId}/deposit/local`, quote ? { quote } : {}, session.token);
}

export function submitLocalDepositTrustline(
  bookingId: string,
  signedXdr: string,
  session: Session,
  quote?: QuoteResponse,
): Promise<OpenLocalDepositResponse> {
  return apiPost<OpenLocalDepositResponse>(`/bookings/${bookingId}/deposit/local/trustline`, { signedXdr, quote }, session.token);
}

export function getLocalDeposit(bookingId: string, session: Session): Promise<LocalDepositView> {
  return apiGet<LocalDepositView>(`/bookings/${bookingId}/deposit/local`, session.token);
}

export function simulateLocalDeposit(bookingId: string, session: Session): Promise<LocalDepositView> {
  return apiPost<LocalDepositView>(`/bookings/${bookingId}/deposit/local/simulate`, {}, session.token);
}

// ---------------------------------------------------------------------------
// Issue #1 (Story 2.3): provider cash-out. The balance and the list are
// cached queries; start/submit are imperative because each waits on a
// wallet signature.
// ---------------------------------------------------------------------------

const CASH_OUT_KEY = (walletAddress: string | undefined) => ["me", "provider", "cash-out", walletAddress] as const;

export function useCashOutBalance(session: Session | undefined) {
  return useQuery({
    queryKey: [...CASH_OUT_KEY(session?.walletAddress), "balance"],
    queryFn: () => apiGet<CashOutBalance>("/me/provider/cash-out/balance", session?.token),
    enabled: Boolean(session),
  });
}

export function useCashOuts(session: Session | undefined) {
  return useQuery({
    queryKey: [...CASH_OUT_KEY(session?.walletAddress), "list"],
    queryFn: () => apiGet<CashOutsResponse>("/me/provider/cash-outs", session?.token),
    enabled: Boolean(session),
  });
}

export function requestCashOutAnchorChallenge(session: Session): Promise<AnchorChallengeResponse> {
  return apiPost<AnchorChallengeResponse>("/me/provider/anchor/challenge", {}, session.token);
}

export function verifyCashOutAnchorChallenge(signedXdr: string, session: Session): Promise<{ ok: true }> {
  return apiPost<{ ok: true }>("/me/provider/anchor/verify", { signedXdr }, session.token);
}

export function startCashOut(amount: string, session: Session): Promise<StartCashOutResponse> {
  return apiPost<StartCashOutResponse>("/me/provider/cash-out", { amount }, session.token);
}

export function submitCashOut(cashOutId: string, signedXdr: string, session: Session): Promise<CashOutView> {
  return apiPost<CashOutView>(`/me/provider/cash-out/${encodeURIComponent(cashOutId)}/submit`, { signedXdr }, session.token);
}

export function getCashOut(cashOutId: string, session: Session): Promise<CashOutView> {
  return apiGet<CashOutView>(`/me/provider/cash-out/${encodeURIComponent(cashOutId)}`, session.token);
}

// ---------------------------------------------------------------------------
// Story 4.1/4.2: "List your shop" -- the wallet's own application, the
// submit, and the admin queue.
// ---------------------------------------------------------------------------

const OWN_APPLICATION_KEY = (walletAddress: string | undefined) => ["me", "provider", "application", walletAddress] as const;

/** `null` means "signed in, never applied" -- the form's own starting
 * state, not an error. */
export function useOwnProviderApplication(session: Session | undefined) {
  return useQuery({
    queryKey: OWN_APPLICATION_KEY(session?.walletAddress),
    queryFn: async () => {
      try {
        const response = await apiGet<OwnProviderApplicationResponse>("/me/provider/application", session?.token);
        return response.application;
      } catch (error) {
        if (error instanceof ApiError && error.code === "NO_APPLICATION") {
          return null;
        }
        throw error;
      }
    },
    enabled: Boolean(session),
    retry: false,
  });
}

export function useSubmitProviderApplication(session: Session | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProviderApplicationInput) =>
      apiPost<OwnProviderApplicationResponse>("/me/provider/application", input, session?.token),
    onSuccess: (response) => {
      queryClient.setQueryData(OWN_APPLICATION_KEY(session?.walletAddress), response.application);
      // Applying creates the (unapproved) profile -- the panel's own query
      // must not keep serving a cached NOT_A_PROVIDER.
      void queryClient.invalidateQueries({ queryKey: OWN_PROVIDER_KEY(session?.walletAddress) });
    },
  });
}

export function useUpdateProviderApplication(session: Session | undefined) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ProviderApplicationInput) =>
      apiPut<OwnProviderApplicationResponse>("/me/provider/application", input, session?.token),
    onSuccess: (response) => {
      queryClient.setQueryData(OWN_APPLICATION_KEY(session?.walletAddress), response.application);
      // The same fields live on the unapproved profile; its cached view must
      // reflect the correction (location included) without re-approving it.
      void queryClient.invalidateQueries({ queryKey: OWN_PROVIDER_KEY(session?.walletAddress) });
    },
  });
}

export function useAdminApplications(session: Session | undefined) {
  return useQuery({
    queryKey: ["admin", "applications", session?.walletAddress],
    queryFn: () => apiGet<AdminApplicationsResponse>("/admin/applications", session?.token),
    enabled: Boolean(session),
    retry: false,
  });
}

export function decideProviderApplication(
  id: string,
  outcome: ProviderApplicationOutcome,
  session: Session,
  reason?: string,
): Promise<{ application: AdminProviderApplication }> {
  return apiPost<{ application: AdminProviderApplication }>(`/admin/applications/${id}/decide`, { outcome, reason }, session.token);
}

// ---------------------------------------------------------------------------
// Anchor local-currency rate. End users never see the escrow asset.
// ---------------------------------------------------------------------------

export interface TryRate {
  /** Local currency units per 1 USDC, decimal string. */
  rate: string;
  /** `true` while `GET /rate` has not answered (or failed) and the built-in
   * constant is in use -- callers prefix such amounts with "≈". */
  isFallback: boolean;
  currency: string;
  decimals: number;
  /** UTC epoch seconds, absent on fallback. */
  quotedAt?: number;
}

const FALLBACK_TRY_RATE: TryRate = {
  rate: "",
  isFallback: true,
  currency: "",
  decimals: 0,
};

/** `GET /rate`, cached for a minute, one retry. Never throws to the
 * caller: a failure (or the endpoint not existing yet) falls back to
 * `FALLBACK_TRY_PER_USDC` with `isFallback: true`, so a rate outage can
 * never blank an amount. */
export function useTryRate(): TryRate {
  const query = useQuery({
    queryKey: ["rate"],
    queryFn: () => apiGet<RateResponse>("/rate"),
    staleTime: 60_000,
    retry: 1,
    select: (data): TryRate => {
      if (
        typeof data?.rate !== "string"
        || !/^\d+(\.\d+)?$/.test(data.rate)
        || Number(data.rate) <= 0
        || typeof data.currency !== "string"
        || data.currency.trim() === ""
        || !Number.isInteger(data.decimals)
        || data.decimals < 0
        || data.decimals > 7
      ) {
        return FALLBACK_TRY_RATE;
      }
      return {
        rate: data.rate,
        isFallback: false,
        currency: data.currency.trim(),
        decimals: data.decimals,
        quotedAt: data.quotedAt,
      };
    },
  });
  return query.data ?? FALLBACK_TRY_RATE;
}

// ---------------------------------------------------------------------------
// Saved shops: a client's personal list of shops they want to book again.
// ---------------------------------------------------------------------------

/** Save a shop for the signed-in client. */
export async function saveShop(providerProfileId: string, token: string): Promise<SaveShopResponse> {
  return apiPost<SaveShopResponse>(`/providers/${providerProfileId}/save`, {}, token);
}

/** Unsave a shop for the signed-in client. */
export async function unsaveShop(providerProfileId: string, token: string): Promise<UnsaveShopResponse> {
  return apiDelete<UnsaveShopResponse>(`/providers/${providerProfileId}/save`, token);
}

/** Check if a shop is saved by the signed-in client. */
export function useIsShopSaved(providerProfileId: string | undefined, session: Session | undefined) {
  return useQuery({
    queryKey: ["saved-shops", "check", providerProfileId, session?.walletAddress],
    queryFn: () => apiGet<IsShopSavedResponse>(`/providers/${providerProfileId}/saved`, session?.token),
    enabled: Boolean(providerProfileId && session),
    retry: false,
  });
}

/** List all saved shops for the signed-in client. */
export function useSavedShops(session: Session | undefined) {
  return useQuery({
    queryKey: ["saved-shops", session?.walletAddress],
    queryFn: () => apiGet<SavedShopsResponse>("/me/saved-shops", session?.token),
    enabled: Boolean(session),
    retry: false,
  });
}
// Shop reports: clients report a shop to admins.
// ---------------------------------------------------------------------------

export function submitShopReport(providerId: string, reason: string, session: Session): Promise<ShopReportSubmitResponse> {
  return apiPost<ShopReportSubmitResponse>(`/providers/${providerId}/report`, { reason }, session.token);
}

export function getShopReportsForAdmin(session: Session): Promise<ShopReportsListResponse> {
  return apiGet<ShopReportsListResponse>("/admin/shop-reports", session.token);
}
