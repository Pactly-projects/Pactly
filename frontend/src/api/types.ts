/** Mirrors `backend/src/services/profile.ts`'s response shapes exactly --
 * this file has no logic, only the types both provider screens render
 * against. */

export interface Money {
  /** Integer string, smallest unit (AD-7) -- never a float. */
  amount: string;
  asset: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
}

export interface CloseProviderDateResponse {
  date: string;
  endDate: string;
  dayCount: number;
  /** UTC epoch seconds of the local day's start/end. */
  rangeStart: number;
  rangeEnd: number;
  releasedHoldCount: number;
  releasedBookingIds: string[];
  closedSlotCount: number;
  /** Funded bookings left alone -- the shop resolves these from Bookings. */
  needsResolution: Array<{ bookingId: string; slotStartsAt: number }>;
}

/** `GET /categories`'s Story 3.2 shape -- every category plus
 * `providerCount` (approved providers only). */
export interface CategoryWithProviderCount extends Category {
  providerCount: number;
}

/** Issue #65: a break cut out of one weekday's hours, named in the shop's
 * own wall clock. `weekday` is 0 (Sunday) through 6 (Saturday). */
export interface ProviderBreak {
  weekday: number;
  startMinute: number;
  endMinute: number;
}

export interface ProviderProfile {
  id: string;
  displayName: string;
  title: string;
  /** The shop's description -- editable by an approved provider. */
  bio: string;
  /** Language names/codes, decoded from the backend's JSON column. */
  languages: string[];
  category: Category;
  location: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  price: Money;
  deposit: Money;
  depositRateBps: number;
  cancellationWindowHours: number;
  maxBookingDaysAhead: number | null;
  bufferMinutes: number;
  verifiedSessionCount: number;
  /** Issue #2: shown beside the verified-session line; zero is shown. */
  providerCancellationCount: number;
  isApproved: boolean;
  /** Issue #62: the shop has paused new bookings. `slots` is empty while
   * this is `true`; existing bookings are unaffected. */
  bookingsPaused: boolean;
  /** Issues #64/#65: the shop's IANA timezone for slot labels and breaks. */
  timezone: string;
  /** Issue #140: true when shop has been suspended by an administrator. */
  isSuspended?: boolean;
  /** Issue #140: admin's reason for the suspension, if suspended. */
  suspensionReason?: string | null;
  /** UTC epoch seconds, ascending. */
  slots: number[];
  /** Issue #65: present on the owner's own profile only. */
  breaks?: ProviderBreak[];
}

export interface CategoriesResponse {
  categories: CategoryWithProviderCount[];
}

/** `GET /providers[?category=<slug>]`'s Story 3.2 card shape -- mirrors
 * `backend/src/services/profile.ts`'s `ProviderCardView` exactly. Distinct
 * from {@link ProviderProfile}: no `depositRateBps`/`isApproved`/full
 * `slots`; adds `providerCancellationCount` and the capped
 * `earliestSlots`. */
export interface ProviderCard {
  id: string;
  displayName: string;
  title: string;
  category: Category;
  location: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  serviceCount: number;
  price: Money;
  deposit: Money;
  cancellationWindowHours: number;
  verifiedSessionCount: number;
  providerCancellationCount: number;
  /** Issue #62: discovery shows the shop as not taking bookings while this
   * is `true` (and `earliestSlots` is empty). */
  bookingsPaused: boolean;
  /** Issue #64: the shop's IANA timezone for its slot labels. */
  timezone: string;
  /** UTC epoch seconds, ascending, at most three. */
  earliestSlots: number[];
  timeZone?: string;
  publicHours?: Array<{ weekday: string; hours: string }>;
}

/** Issue #30: what an empty text search offers -- the nearest category
 * that has approved shops and up to three of them. Absent when no approved
 * shop exists at all (the empty state then stays empty). */
export interface EmptySearchSuggestions {
  category: Category;
  providers: ProviderCard[];
}

export interface ProvidersResponse {
  providers: ProviderCard[];
  suggestions?: EmptySearchSuggestions;
}

/** `GET /providers/suggest?q=`'s Story 3.3 shape -- mirrors
 * `backend/src/services/profile.ts`'s `DiscoverSuggestion` exactly. */
export interface DiscoverSuggestion {
  kind: "category" | "service" | "provider";
  label: string;
  value: string;
  count: number;
}

export interface SuggestResponse {
  suggestions: DiscoverSuggestion[];
}

/** Story 3.3's own availability window values (`?when=`) -- `undefined`
 * means "Any", the spec's own default (no filtering at all). */
export type DiscoverAvailability = "24h" | "week";

/** Every Story 3.3 filter `useDiscoverProviders` turns into `GET
 * /providers`'s query string, alongside 3.2's own `category`. Mirrors
 * `backend/src/services/profile.ts`'s `DiscoverFilters` (plus `category`,
 * which the backend takes as a separate positional argument). */
export interface DiscoverFiltersParams {
  category?: string;
  q?: string;
  formats?: string[];
  minPrice?: string;
  maxPrice?: string;
  maxDepositBps?: number;
  when?: DiscoverAvailability;
  /** Issue #138: sort order, e.g. "soonest" / "next-slot" vs "default" */
  sort?: string;
}

// ---------------------------------------------------------------------------
// Story 3.4: the client booking flow. Mirrors `backend/src/services/
// booking.ts`'s response shapes exactly, same discipline as the rest of
// this file.
// ---------------------------------------------------------------------------

export interface BookingProviderSummary {
  id: string;
  displayName: string;
  title: string;
}

export interface HoldSlotResponse {
  bookingId: string;
  /** UTC epoch seconds. */
  holdExpiresAt: number;
  deposit: Money;
  balance: Money;
  price: Money;
  /** UTC epoch seconds. */
  cancelDeadline: number;
  /** UTC epoch seconds -- server clock at response time. */
  serverTime: number;
  provider: BookingProviderSummary;
  /** `true` only when the free-cancellation window had already passed at
   * the moment of the hold -- omitted (never `false`) otherwise. */
  freeCancellationEnded?: boolean;
  /** `true` only when a resume read found an expired, never-deployed hold.
   * The UI clears the hold and offers an explicit re-hold action. */
  isExpiredHold?: true;
}

/** Review follow-up: `deployed: true` means a signed deploy was already
 * submitted and accepted for this booking -- there is no XDR to sign
 * again, skip straight to `fund`. `deployed: false` carries the unsigned
 * deploy XDR (and its own real `txHash`) still waiting for a signature. */
export type LockResponse = { deployed: true; contractId: string } | { deployed: false; contractId: string; unsignedXdr: string; txHash: string };

export interface FundResponse {
  unsignedXdr: string;
}

export interface SubmitResponse {
  txHash: string;
}

export type EscrowLifecycleAction = "funded" | "completed" | "approved" | "disputed" | "released" | "resolved";

/** Story 3.6 (review round): which action kind this booking has a signed
 * transaction already relayed for, but not yet chain-confirmed --
 * `null` when nothing is pending. Actions hide themselves while this is
 * set (`components/BookingActions.tsx`), showing "Waiting for the network
 * to confirm" instead of a button that would just build a second,
 * redundant transaction. */
export type PendingActionKind = "complete" | "approve" | "release" | "dispute" | "resolve" | null;

export interface BookingView {
  id: string;
  /** `null` until the reconciler confirms it -- the UI only ever shows
   * "locked" from here, never from a lock/fund/submit response. */
  escrowState: "locked" | "released" | "refunded" | null;
  lifecycle: { contractId?: string; action?: EscrowLifecycleAction; outcome?: "refund-client" | "pay-provider" };
  pendingAction: PendingActionKind;
  holdExpiresAt: number | null;
  /** `"shop-closed-date"` only when the shop closed this date and released
   * this unpaid hold early -- no deposit was taken. */
  holdReleasedReason: "shop-closed-date" | null;
  contractId: string | null;
  /** Issue #5: `true` once the deploy behind `contractId` is confirmed on
   * chain -- the booking then has a real escrow that simply has no deposit
   * in it yet, which is a different fact from "created" and a different
   * button from "Lock with Pactly". */
  deploySubmitted: boolean;
  /** Issue #7: every contract id a deploy ever returned for this booking,
   * oldest first, with the one the booking currently settles against marked
   * active. Empty for a booking that has never deployed. */
  contractHistory: { contractId: string; active: boolean }[];
  deposit: Money;
  balance: Money;
  price: Money;
  slotStartsAt: number | null;
  disputeDeadline: number | null;
  cancelDeadline: number;
  /** UTC epoch seconds -- server clock at response time. Resynced on every
   * refetch so the free-cancellation countdown stays aligned with the
   * clock that will accept or refuse a cancel. */
  serverTime: number;
  provider: BookingProviderSummary;
  /** Story 3.7: the on-chain transaction hash once the balance was paid
   * through Pactly (`null` for unpaid or paid-in-cash) -- drives the
   * balance row's own Stellar Expert link. */
  balancePaymentTxHash: string | null;
  /** The anchor's transaction id for the local-currency deposit, `null`
   * when none was started. Client and shop only. */
  anchorTransactionId: string | null;
  /** Story 3.8: the client's private note on this booking (visible to the
   * shop and the client on the booking detail page, never on the public
   * profile or discovery). */
  note: string | null;
  /** Issue #158: the address stored for this booking's shop -- the escrow's
   * receiver, shown (and copyable) for both sides. */
  receivingAddress: string | null;
}

// ---------------------------------------------------------------------------
// Story 3.5: the two-sided status panel. Mirrors `backend/src/services/
// booking.ts`'s `BookingListItemBase`/`ClientBookingListItem`/
// `ProviderBookingListItem` exactly, same discipline as the rest of this
// file.
// ---------------------------------------------------------------------------

export type BalanceState = "unpaid" | "paid_platform" | "paid_cash";

export interface BookingLifecycle {
  contractId?: string;
  action?: EscrowLifecycleAction;
  outcome?: "refund-client" | "pay-provider";
}

export interface BookingListItemBase {
  id: string;
  /** UTC epoch seconds -- `null` only for a pre-3.4 booking with no slot. */
  slotStartsAt: number | null;
  disputeDeadline: number | null;
  deposit: Money;
  balance: Money;
  price: Money;
  escrowState: "locked" | "released" | "refunded" | null;
  lifecycle: BookingLifecycle;
  pendingAction: PendingActionKind;
  balanceState: BalanceState;
  /** Story 3.7: the on-chain transaction hash once the balance was paid
   * through Pactly (`null` for unpaid or paid-in-cash). */
  balancePaymentTxHash: string | null;
  /** The anchor's transaction id for the local-currency deposit, `null`
   * when none was started. Client and shop only. */
  anchorTransactionId: string | null;
  /** UTC epoch seconds. */
  cancelDeadline: number;
  /** UTC epoch seconds -- server clock at response time. */
  serverTime: number;
  contractId: string | null;
  /** UTC epoch seconds. */
  holdExpiresAt: number | null;
  /** UTC epoch seconds when the shop declined this hold, `null` otherwise. */
  declinedAt: number | null;
  /** The AD-13 hold's own window has passed with no chain evidence at all --
   * shown under a separate, collapsed "Expired holds" group, never mixed
   * into the main list (the spec's own "Always" rule). */
  isExpiredHold: boolean;
  /** UTC epoch seconds -- when the provider marked the client as arrived,
   * `null` until marked. */
  arrivedAt: number | null;
  /** Issue #158: the address stored for this booking's shop (the escrow's
   * receiver), `null` only when the shop's profile is gone. */
  receivingAddress: string | null;
}

export interface ClientBookingListItem extends BookingListItemBase {
  provider: BookingProviderSummary;
}

export interface ProviderBookingListItem extends BookingListItemBase {
  /** Full wallet address -- shortened only at render time (`lib/stellar.ts`'s
   * `shortenStellarId`, the same helper `EscrowProof` already uses). */
  clientWalletAddress: string;
  /** Optional client contact email for the shop's post-release mailto draft. */
  clientEmail: string | null;
}

export interface MyBookingsResponse {
  bookings: ClientBookingListItem[];
}

export interface ProviderBookingsResponse {
  bookings: ProviderBookingListItem[];
}

// ---------------------------------------------------------------------------
// Issue #31: the in-app event list (lock, release, dispute, resolve).
// ---------------------------------------------------------------------------

export type EscrowEventType = "lock" | "release" | "dispute" | "resolve";

export interface EscrowEvent {
  id: string;
  bookingId: string;
  walletAddress: string;
  type: EscrowEventType;
  /** UTC epoch seconds. */
  createdAt: number;
}

export interface MyEventsResponse {
  events: EscrowEvent[];
}

// ---------------------------------------------------------------------------
// Story 3.6: appointment completion, release and resolution. Mirrors
// `backend/src/services/booking.ts` and `backend/src/app.ts`'s response
// shapes exactly, same discipline as the rest of this file.
// ---------------------------------------------------------------------------

/** `POST /bookings/:id/{complete,approve,release}`'s shared response shape
 * -- an unsigned XDR plus its Trustless Work `txHash`, same shape 3.4's
 * lock/fund steps already use. */
export interface ActionResponse {
  unsignedXdr: string;
  txHash: string;
}

/** `POST /bookings/:id/release`'s own response: `"ready"` carries the
 * rebuilt release XDR to sign (the first attempt, or a retry of a signed
 * but unapplied one, always against the same persisted contract id);
 * `"applied"` means the chain already shows the release applied, so there
 * is nothing to sign or submit again. */
export type ReleaseDepositResponse =
  | ({ status: "ready"; contractId: string } & ActionResponse)
  | { status: "applied"; contractId: string };

export type DisputeOutcome = "refund-client" | "pay-provider";
/** Story 3.6 (review round): bound to the opener's own role -- a client may
 * claim `client-cancel`, `provider-no-show` or `disagreement`; a provider
 * may claim `provider-cancel`, `client-no-show` or `disagreement`. */
export type DisputeReason = "client-cancel" | "provider-cancel" | "client-no-show" | "provider-no-show" | "disagreement";
export type DisputeOpenerRole = "client" | "provider";

/** `POST /bookings/:id/dispute`'s response -- the reason echoed back and the
 * booking policy's own suggested outcome (`undefined` only for
 * `"disagreement"`, which the policy has no automatic answer for). Stated to
 * the user before they ever sign, per EXPERIENCE.md's "Cancelling and
 * resolution". */
export interface OpenDisputeResponse extends ActionResponse {
  reason: DisputeReason;
  suggestedOutcome?: DisputeOutcome;
  /** Issue #22: the note the opener attached (free text, may be empty). */
  note?: string;
  /** Issue #22: the SHA-256 hex evidence hash the opener attached (or undefined). */
  evidenceHash?: string;
}

/** `POST /admin/bookings/:id/resolve`'s response. */
export interface ResolveDisputeResponse extends ActionResponse {
  outcome: DisputeOutcome;
}

/** `GET /admin/disputes`'s own list item -- who opened it, why, the policy's
 * own suggestion (guidance only), and the deposit amount. */
export interface AdminDisputeListItem {
  bookingId: string;
  contractId: string;
  /** `""` when no opening record exists for this booking's current
   * contract. */
  openedByWallet: string;
  openedByRole?: DisputeOpenerRole;
  reason: DisputeReason | "unknown";
  suggestedOutcome?: DisputeOutcome;
  amount: Money;
  provider: BookingProviderSummary;
  clientWalletAddress: string;
  /** UTC epoch seconds -- `null` only for a pre-3.4 booking with no slot. */
  slotStartsAt: number | null;
  /** Free-text note the opener attached (may be empty, max 500 chars,
   * leading/trailing spaces trimmed before count). */
  note?: string;
  /** SHA-256 hex evidence hash the opener attached (64 lowercase hex chars,
   * displayed as plain text, not a clickable link). */
  evidenceHash?: string;
  /** Story 3.6 (review round): `"resolve"` while an admin's resolve is
   * already awaiting chain confirmation for this booking -- the admin UI
   * hides/disables the row rather than let a second resolve be built. */
  pendingAction: PendingActionKind;
}

export interface AdminDisputesResponse {
  disputes: AdminDisputeListItem[];
}

// ---------------------------------------------------------------------------
// Story 3.7: paying the balance before the session. Mirrors
// `backend/src/services/booking.ts`/`backend/src/app.ts`'s response shapes
// exactly, same discipline as the rest of this file.
// ---------------------------------------------------------------------------

/** `POST /bookings/:id/balance/pay`'s response -- an unsigned XDR only (no
 * `txHash`, same shape 3.4's `fund` step already uses): the built
 * transaction's own hash is Pactly's own internal submit-binding record,
 * never something the client needs back. */
export interface BalancePaymentBuildResponse {
  unsignedXdr: string;
}

/** `POST /bookings/:id/balance/submit`'s response -- the confirmed,
 * on-chain transaction hash. */
export interface BalancePaymentSubmitResponse {
  txHash: string;
}

// ---------------------------------------------------------------------------
// Story 2.2: the anchor's SEP-38 indicative price. Mirrors
// `backend/src/anchor/sep38.ts`'s `IndicativePrice` exactly.
// ---------------------------------------------------------------------------

/** `GET /quote`'s response -- the USDC amount echoed back plus its
 * indicative local-currency equivalent. Display-only: never persisted on a
 * booking, never used to compute a deposit (AD-7). */
export interface QuoteResponse {
  amount: string;
  asset: string;
  fiat: {
    amount: string;
    currency: string;
    decimals: number;
  };
  /** UTC epoch seconds. */
  quotedAt: number;
  /** How long the anchor honours the quote, in seconds (60 when it did not
   * state an age). A screen older than this must refresh before confirming. */
  maxAgeSeconds: number;
  /** UTC epoch seconds at which the quote stops being honoured. */
  expiresAt: number;
  spreadApplied: true;
}

/** `GET /rate`'s response -- TRY per 1 USDC as a decimal string (e.g.
 * `"48.5410"`). Display-only, like `QuoteResponse`: never persisted on a
 * booking, never used to compute a deposit server-side (AD-7). */
export interface RateResponse {
  rate: string;
  currency: string;
  decimals: number;
  /** UTC epoch seconds. */
  quotedAt: number;
}

// ---------------------------------------------------------------------------
// Story 2.4: SEP-6 local-currency deposit. Mirrors
// `backend/src/services/localDeposit.ts`'s `LocalDepositView`.
// ---------------------------------------------------------------------------

export interface BankDetails {
  iban?: string;
  organization?: string;
  reference?: string;
  how?: string;
  extraMessage?: string;
}

export type LocalDepositStatus = "waiting" | "paying" | "received" | "failed" | "needs_trustline";

export interface LocalDepositView {
  status: LocalDepositStatus;
  statusLabel: string;
  bankDetails: BankDetails;
  moreInfoUrl?: string;
  expiresAt?: number;
  holdExpiresAt: number | null;
  sandbox: boolean;
  stale?: boolean;
  reason?: string;
}

export type OpenLocalDepositResponse = { needsTrustline: true; unsignedXdr: string } | (LocalDepositView & { needsTrustline?: false });

export interface AnchorChallengeResponse {
  authenticated: boolean;
  unsignedXdr?: string;
}

// ---------------------------------------------------------------------------
// Issue #1 (Story 2.3): provider cash-out. Mirrors
// `backend/src/services/cashOut.ts`'s view shapes.
// ---------------------------------------------------------------------------

export interface CashOutLimits {
  min?: string;
  max?: string;
  currency?: string;
}

export interface CashOutBalance {
  /** Integer string, USDC smallest units; `"0"` without a trustline. */
  balance: string;
  asset: string;
  /** Whether the wallet can hold the anchor's USDC at all. */
  hasTrustline: boolean;
  limits?: CashOutLimits;
}

export type CashOutStatus = "awaiting_signature" | "waiting" | "sent" | "paid_out" | "failed";

export interface CashOutView {
  id: string;
  status: CashOutStatus;
  statusLabel: string;
  amount: Money;
  fiat: { amount: string; currency: string };
  anchorTransactionId: string;
  moreInfoUrl?: string;
  /** UTC epoch seconds. */
  createdAt: number;
  sentAt?: number;
  reason?: string;
  stale?: boolean;
}

export interface CashOutsResponse {
  cashOuts: CashOutView[];
}

export interface StartCashOutResponse {
  cashOutId: string;
  unsignedXdr: string;
}

// ---------------------------------------------------------------------------
// Story 4.1/4.2: "List your shop". Mirrors `backend/src/services/
// providerApplications.ts`'s view shapes exactly.
// ---------------------------------------------------------------------------

export type ProviderApplicationState = "pending" | "approved" | "rejected";

export interface ProviderApplication {
  id: string;
  state: ProviderApplicationState;
  name: string;
  title: string;
  category: Category;
  serviceDescription: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  price: Money;
  deposit: Money;
  depositRateBps: number;
  cancellationWindowHours: number;
  rejectionReason: string | null;
  /** UTC epoch milliseconds. */
  createdAt: number;
  decisionAt: number | null;
  profileId: string | null;
}

export interface AdminProviderApplication extends ProviderApplication {
  walletAddress: string;
}

export interface ProviderApplicationInput {
  name: string;
  title: string;
  categoryId: string;
  location: string;
  serviceDescription: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  /** Integer string, smallest unit (AD-7). */
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
}

/** `POST /me/provider/application/deposit-preview` -- price + rate in,
 * escrow-asset deposit out (same shape the application stores). */
export interface DepositPreviewInput {
  priceAmount: string;
  depositRateBps: number;
}

export interface DepositPreviewResponse {
  deposit: Money;
}

export interface OwnProviderApplicationResponse {
  application: ProviderApplication;
}

export interface AdminApplicationsResponse {
  applications: AdminProviderApplication[];
}

export type ProviderApplicationOutcome = "approve" | "reject";

// ---------------------------------------------------------------------------
// Public booking proof (shareable, no sign-in)
// ---------------------------------------------------------------------------

export interface ProofShop {
  displayName: string;
  title: string;
  location: string;
}

export interface ProofResponse {
  id: string;
  status: "locked" | "released" | "cancelled";
  shop: ProofShop;
  slotStartsAt: number | null;
  deposit: Money;
  contractId: string;
}
