/**
 * Builds the Hono app: route registration plus the one identity-extraction
 * middleware this story adds. Kept separate from `index.ts`'s `serve(...)`
 * call (the only thing `index.ts` still does) purely for testability --
 * `serve` opens a real TCP listener as an import-time side effect, which a
 * unit test exercising a route or `requirePactlyAuth` must never trigger;
 * `app.test.ts` drives this app directly via Hono's own `app.request(...)`,
 * with every network seam beneath it (the anchor's `fetch`, this process's
 * clock) injected, never reaching `tr-mock-anchor.fly.dev`. `index.ts`'s own
 * black-box startup test (`db.test.ts`) is unaffected: it still spawns the
 * real process and hits `/health` over the real port.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context, Next } from "hono";

import {
  beginMoneyAssertion,
  finishMoneyAssertion,
  requireFreshAssertion,
  PasskeyNotRegisteredError,
} from "./auth/assertion.js";
import {
  buildPactlyChallenge,
  issuePactlyJwt,
  verifyPactlyChallenge,
  verifyPactlyJwt,
} from "./auth/challenge.js";
import {
  PactlyChallengeExpiredError,
  PactlyChallengeInvalidError,
  PactlyChallengeReplayedError,
  PactlyInvalidAccountError,
  PactlyJwtError,
  PasskeyChallengeExpiredError,
  PasskeyInvalidError,
  PasskeyUnknownError,
} from "./auth/errors.js";
import {
  beginPasskeyLogin,
  beginPasskeyRegistration,
  finishPasskeyLogin,
  finishPasskeyRegistration,
  type PasskeyDeps,
} from "./auth/passkey.js";
import {
  PasskeyKitAccountError,
  PasskeyKitSubmitError,
  sessionForPasskeyKitWallet,
  submitPasskeyKitXdr,
} from "./auth/passkeyKit.js";
import { AccountFundingError, InvalidXdrError, NoCustodialAccountError } from "./custodial/errors.js";
import { ensureAccountReady, ensureAccountReadyInBackground, type EnsureAccountReadyDeps } from "./custodial/funding.js";
import { signXdrForWallet } from "./custodial/keys.js";
import { getUserByWalletAddress } from "./db/users.js";
import { getCategoryById, getCategoryBySlug, insertCategory, updateCategoryVisibility } from "./db/categories.js";
import { RateUnavailableError, getTryRate } from "./services/rate.js";
import type { Db } from "./db/client.js";
import {
  InvalidAvailabilitySlotsError,
  InvalidProviderProfileError,
  InvalidProviderRulesError,
  InvalidTimezoneError,
  NotAProviderError,
  ProviderNotApprovedError,
  ProviderNotFoundError,
  updateProviderProfile,
  getOwnProviderProfile,
  getPublicProviderProfile,
  setProviderBookingsPaused,
  listCategoriesWithProviderCounts,
  listDiscoverProviders,
  suggestDiscoverQueries,
  setProviderBreaks,
  updateProviderAvailability,
  updateProviderRules,
  updateProviderTimezone,
  type DiscoverFilters,
} from "./services/profile.js";
import {
  AlreadyAProviderError,
  InvalidProviderApplicationError,
  NoProviderApplicationError,
  ProviderApplicationDecidedError,
  ProviderApplicationNotFoundError,
  ProviderApplicationPendingError,
  applyAsProvider,
  decideApplication,
  getOwnProviderApplication,
  listPendingApplications,
  updateOwnProviderApplication,
} from "./services/providerApplications.js";
import {
  BookingActionPendingError,
  BalanceAlreadySettledError,
  BookingDeployInFlightError,
  BookingEscrowStateError,
  BookingHoldExpiredError,
  BookingNotFoundError,
  DisputeWindowClosedError,
  BookingsPausedError,
  InvalidDisputeReasonError,
  NothingToPayError,
  ShortDepositError,
  SlotTakenError,
  SlotUnavailableError,
  TooManyHoldsError,
  ProviderSelfBookingError,
  XdrMismatchError,
  approveAppointment,
  buildBalancePayment,
  cancelHold,
  completeAppointment,
  declineHold,
  fundDeposit,
  getBookingForClient,
  getBookingForClientOrProvider,
  getBookingView,
  holdSlot,
  listBookingsForClient,
  listBookingsForProvider,
  listOpenDisputes,
  lockDeposit,
  markArrived,
  markBalancePaidCash,
  openDispute,
  releaseDeposit,
  resolveBookingDispute,
  resolveSubmitRole,
  submitBalancePayment,
  submitSignedTransaction,
  type BuildBalancePaymentDeps,
} from "./services/booking.js";
import {
  BookingOutsideCancellationWindowError,
  InvalidCloseDateError,
  closeProviderDate,
  rescheduleLockedBooking,
} from "./services/availability.js";
import { EscrowApiError, EscrowConfigError, EscrowRequestError } from "./escrow/trustless-work/errors.js";
import { defaultEscrowAdapter } from "./escrow/trustless-work/client.js";
import { TransactionStatusUnavailableError } from "./escrow/transaction-status.js";
import type { EscrowAdapter } from "./escrow/interface.js";
import { PaymentFailedError, PaymentUnavailableError } from "./payments/errors.js";
import type { SubmitPaymentDeps } from "./payments/stellar.js";
import { InvalidBreaksError } from "./services/availability.js";
import {
  InvalidExportRangeError,
  exportProviderBookings,
  parseExportRange,
} from "./services/bookingsExport.js";
import { config } from "./config.js";
import { DISPUTE_OUTCOMES, type DisputeOutcome, type DisputeReason } from "./db/schema.js";
import { getBookingById, setBookingNote, clearBookingNote } from "./db/bookings.js";
import {
  AmountOutOfRangeError,
  AnchorAuthError,
  AnchorAuthRequiredError,
  AnchorDepositError,
  AnchorDiscoveryError,
  AnchorKycError,
  AnchorQuoteUnavailableError,
  AnchorQuoteUnsupportedError,
  AnchorUnavailableError,
  QuoteMismatchError,
  QuoteStaleError,
} from "./anchor/errors.js";
import { fetchIndicativePrice, type Sep38FetchLike } from "./anchor/sep38.js";
import {
  ClosedDateBookingError,
  InvalidClosedDateError,
  closeDate,
  listClosedDatesForWallet,
  reopenDate,
} from "./services/availability.js";
import type { AnchorFetchLike } from "./anchor/http.js";
import type { UsdcTrustlineDeps } from "./anchor/trustline.js";
import {
  CashOutNotFoundError,
  InsufficientBalanceError,
  beginCashOutAnchorAuth,
  completeCashOutAnchorAuth,
  InvalidCashOutAmountError,
  getCashOut,
  getCashOutBalance,
  listCashOuts,
  pollCashOut,
  startCashOut,
  submitCashOut,
  type CashOutDeps,
} from "./services/cashOut.js";
import {
  SandboxOnlyError,
  beginBookingAnchorAuth,
  completeBookingAnchorAuth,
  openLocalDeposit,
  pollLocalDeposit,
  simulateLocalDeposit,
  submitLocalDepositTrustline,
  type ConfirmedQuote,
  type LocalDepositDeps,
} from "./services/localDeposit.js";
import { retryFailedDeposit } from "./services/localDeposit.js";
import {
  ShopNotFoundError as SavedShopNotFoundError,
  ShopNotApprovedError,
  saveShop,
  unsaveShop,
  isShopSaved,
  getSavedShopsForClient,
} from "./services/savedShops.js";
import {
  InvalidReportReasonError,
  ReportRateLimitError,
  ShopNotFoundError,
  getShopReportsForAdmin,
  submitShopReport,
} from "./services/shopReports.js";

export interface Variables {
  /** Set by `requirePactlyAuth` once a request's Pactly JWT verifies --
   * "which wallet is this," never "is this wallet allowed to." AD-12's
   * role-based authorization (admin/provider) is a later story's job, not
   * this one's -- see this story's own Design Notes. */
  walletAddress: string;
}

export type App = Hono<{ Variables: Variables }>;

/** Extracts *which wallet* is calling from a verified Pactly JWT. A
 * missing, expired or tampered token is rejected the same way, with a
 * meaningful JSON error, never a stack trace (this story's own Acceptance
 * Criteria). */
const BEARER_PREFIX = /^bearer\s+/i;

export async function requirePactlyAuth(c: Context<{ Variables: Variables }>, next: Next) {
  const header = c.req.header("Authorization");
  // Case-insensitive per RFC 7235's auth-scheme grammar -- "bearer <token>"
  // is just as valid as "Bearer <token>".
  const token = header && BEARER_PREFIX.test(header) ? header.replace(BEARER_PREFIX, "") : undefined;
  if (!token) {
    return c.json({ code: "unauthorized", message: "Sign in required." }, 401);
  }
  try {
    const result = await verifyPactlyJwt(token);
    c.set("walletAddress", result.walletAddress);
  } catch (error) {
    if (error instanceof PactlyJwtError) {
      // Check if this was specifically an expired token
      const cause = (error as Error).cause as Error | undefined;
      const isExpired = cause && (cause.name === "JWTExpired" || cause.code === "ERR_JWT_EXPIRED");
      
      if (isExpired) {
        return c.json({ code: "session_expired", message: "Session expired. Confirm again to continue." }, 401);
      }
      return c.json({ code: "unauthorized", message: "Sign in required." }, 401);
    }
    throw error;
  }
  await next();
}

/**
 * Story 3.6: gates every `/admin/...` route to a wallet in
 * `config.adminWallets` (AD-12) -- a non-admin caller gets the same
 * `404 NOT_ADMIN` every other "you don't own this" check in this file gives
 * (never a `403`, so an admin-only route's very existence is not
 * distinguishable from an unknown one). Runs after {@link requirePactlyAuth}
 * (which is what sets `walletAddress`), never before. Being *an* admin is
 * distinct from being *the* dispute resolver (`config
 * .trustlessWorkPlatformAddress`) -- the resolve route's own extra check,
 * not this middleware's.
 */
async function requireAdmin(c: Context<{ Variables: Variables }>, next: Next) {
  if (!config.adminWallets.includes(c.get("walletAddress"))) {
    return c.json({ code: "NOT_ADMIN", message: "This wallet is not a Pactly admin." }, 404);
  }
  await next();
}

/** Non-negative integer string -- Story 3.3's own `minPrice`/`maxPrice`
 * shape (AD-7's smallest-unit integer strings, with `"0"` also allowed
 * since a free session is a valid lower bound). */
const NON_NEGATIVE_INTEGER_STRING = /^(0|[1-9]\d*)$/;
/** Story 2.2: `GET /quote`'s own `amount` -- a positive (never zero)
 * integer string, refused before any anchor call (the spec's own "Refused
 * before any anchor call" row). */
const POSITIVE_INTEGER_STRING = /^[1-9]\d*$/;
const MIN_DEPOSIT_RATE_BPS_FILTER = 1;
const MAX_DEPOSIT_RATE_BPS_FILTER = 10000;
const AVAILABILITY_FILTER_VALUES = new Set(["24h", "week"]);

/** Story 3.3: turns `GET /providers`'s query string into a
 * {@link DiscoverFilters}, dropping every invalid or unknown value rather
 * than erroring (the spec's own "Always" rule: "Unknown or invalid params
 * are ignored, never an error" -- and the I/O matrix's own per-row
 * behaviour for each of these). `category` is parsed by the caller, not
 * here, since it is resolved against the category table, not validated by
 * shape. */
function parseDiscoverFilters(c: Context<{ Variables: Variables }>): DiscoverFilters {
  const filters: DiscoverFilters = {};

  const q = c.req.query("q");
  if (q !== undefined && q.trim().length > 0) {
    filters.query = q.trim();
  }

  const formats = c.req.queries("format");
  if (formats && formats.length > 0) {
    filters.formats = formats;
  }

  const minPrice = c.req.query("minPrice");
  if (minPrice !== undefined && NON_NEGATIVE_INTEGER_STRING.test(minPrice)) {
    filters.minPriceAmount = minPrice;
  }
  const maxPrice = c.req.query("maxPrice");
  if (maxPrice !== undefined && NON_NEGATIVE_INTEGER_STRING.test(maxPrice)) {
    filters.maxPriceAmount = maxPrice;
  }

  const maxDepositBps = c.req.query("maxDepositBps");
  if (maxDepositBps !== undefined && /^\d+$/.test(maxDepositBps)) {
    const parsed = Number(maxDepositBps);
    if (parsed >= MIN_DEPOSIT_RATE_BPS_FILTER && parsed <= MAX_DEPOSIT_RATE_BPS_FILTER) {
      filters.maxDepositRateBps = parsed;
    }
  }

  const when = c.req.query("when");
  if (when !== undefined && AVAILABILITY_FILTER_VALUES.has(when)) {
    filters.availability = when as "24h" | "week";
  }

  const sort = c.req.query("sort");
  if (sort !== undefined && sort.trim().length > 0) {
    filters.sort = sort.trim();
  }

  return filters;
}

export interface CreateAppOptions {
  /** Overrides the escrow adapter every booking route uses -- defaults to
   * the real Trustless-Work-backed one. A test can inject a fake adapter
   * to exercise `502 ESCROW_REJECTED`/accepted-deploy paths without a real
   * Trustless Work API key. */
  escrowAdapter?: EscrowAdapter;
  /** Story 3.7: overrides `POST /bookings/:id/balance/pay`'s own network
   * seams (how the client's account is loaded, how the USDC asset is
   * resolved) -- same "inject the network access" discipline as
   * `escrowAdapter` above, so a test never needs a real Soroban RPC
   * endpoint or a real anchor `stellar.toml` to exercise this route. */
  buildBalancePaymentDeps?: BuildBalancePaymentDeps;
  /** Story 3.7: overrides `POST /bookings/:id/balance/submit`'s own
   * send/poll seam -- lets a test exercise `502 PAYMENT_FAILED`/
   * `503 PAYMENT_UNAVAILABLE` without a real RPC endpoint. */
  submitBalancePaymentDeps?: SubmitPaymentDeps;
  /** Story 2.2: overrides `GET /quote`'s own anchor `fetch` seam (toml
   * discovery, USDC resolution, and the SEP-38 calls) -- lets a test
   * exercise the quote route's success/unavailable/unsupported paths
   * without a real anchor. */
  quoteFetchImpl?: Sep38FetchLike;
  /** Story 2.4: overrides every network call the local-currency deposit
   * path makes (toml, SEP-10/12/6, SEP-38 limits, Horizon trustline check,
   * change-trust build/submit) -- a test never reaches the live anchor. */
  localDepositDeps?: LocalDepositDeps;
  /** Issue #1: overrides every network call the cash-out path makes (anchor
   * SEP-6/12/38, Horizon balance, payment build/submit) -- a test never
   * reaches the live anchor or RPC. */
  cashOutDeps?: CashOutDeps;
  /** Passkey pivot: overrides the ceremony clock (`now`) so a test can
   * expire a challenge without waiting. */
  passkeyDeps?: PasskeyDeps;
  /** Passkey pivot: overrides every network seam `ensureAccountReady`
   * touches (friendbot, anchor toml, RPC build/submit). Defaults to the
   * real network. A test that leaves this unset but never registers a
   * user never triggers it either. */
  accountReadyDeps?: EnsureAccountReadyDeps;
  /** Passkey pivot: overrides `GET /rate`'s anchor `fetch` seam --
   * defaults to `quoteFetchImpl`, since it is the same SEP-38 call. */
  rateFetchImpl?: Sep38FetchLike;
  /** Issue #4: overrides the network seams behind "can this wallet hold
   * USDC at all?" (Horizon account load, USDC discovery, trustline read)
   * -- the same inject-the-network discipline as `localDepositDeps` above,
   * so a test exercising the lock and provider-approval routes never
   * reaches a real Horizon endpoint. */
  usdcTrustlineDeps?: UsdcTrustlineDeps;
}

export function createApp(db: Db, options: CreateAppOptions = {}): App {
  const app: App = new Hono<{ Variables: Variables }>();
  const escrowAdapter = options.escrowAdapter ?? defaultEscrowAdapter;
  const buildBalancePaymentDeps = options.buildBalancePaymentDeps ?? {};
  const submitBalancePaymentDeps = options.submitBalancePaymentDeps ?? {};
  const quoteFetchImpl = options.quoteFetchImpl;
  const passkeyDeps = options.passkeyDeps ?? {};
  const accountReadyDeps = options.accountReadyDeps ?? {};
  const rateFetchImpl = options.rateFetchImpl ?? quoteFetchImpl;
  const localDepositDeps: LocalDepositDeps = {
    ...options.localDepositDeps,
    fetchImpl: options.localDepositDeps?.fetchImpl ?? (quoteFetchImpl as AnchorFetchLike | undefined),
  };
  const usdcTrustlineDeps = options.usdcTrustlineDeps ?? {};

  // Security headers middleware -- sets three API headers (AC1) and ensures
  // no wildcard CORS origin (AC3). Runs before every route.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
  });

  // CORS middleware -- allows same-origin requests and never sets a wildcard
  // origin (AC3). In development, allows localhost; in production, only the
  // request's own origin if it matches the deployed app pattern (Vercel).
  app.use("*", cors({
    origin: (origin) => {
      // Allow localhost for development, or any origin that looks like a
      // Vercel deployment. Never return "*" (AC3).
      if (!origin) return "http://localhost:5173";
      if (origin.includes("localhost") || origin.includes("127.0.0.1")) return origin;
      if (origin.includes("vercel.app") || origin.match(/https?:\/\/[^/]+\.vercel\.app$/)) return origin;
      // For any other origin, echo it back (same-origin) -- never "*"
      return origin;
    },
    credentials: true,
  }));

  // Every route above handles its own typed failures and returns the
  // `{code, message}` envelope itself; this is only the backstop for a
  // failure none of them anticipated -- still the same envelope, never
  // Hono's own default plain-text 500.
  app.onError((error, c) => {
    console.error("[app] unhandled error", error);
    return c.json({ code: "internal_error", message: "Something went wrong. Please try again." }, 500);
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  /** Pactly's own login, step one: a wallet asks for a challenge to sign. */
  app.post("/auth/challenge", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const publicKey = typeof body?.publicKey === "string" ? body.publicKey : undefined;
    if (!publicKey) {
      return c.json({ code: "invalid_request", message: "publicKey is required." }, 400);
    }
    try {
      const transaction = buildPactlyChallenge(publicKey);
      return c.json({ transaction });
    } catch (error) {
      if (error instanceof PactlyInvalidAccountError) {
        return c.json({ code: "invalid_account", message: error.message }, 400);
      }
      throw error;
    }
  });

  /** Pactly's own login, step two: the wallet's signed challenge comes back
   * and, if it checks out, a Pactly JWT is issued -- the platform's whole
   * login mechanism, no passwords, ever (FR10). The anchor's JWT never
   * enters this handler at all, let alone this response (AD-5). */
  app.post("/auth/verify", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const transaction = typeof body?.transaction === "string" ? body.transaction : undefined;
    if (!transaction) {
      return c.json({ code: "invalid_request", message: "transaction is required." }, 400);
    }
    try {
      const { walletAddress } = await verifyPactlyChallenge(db, transaction);
      const token = await issuePactlyJwt(walletAddress);
      return c.json({ token, walletAddress });
    } catch (error) {
      if (error instanceof PactlyChallengeExpiredError) {
        return c.json({ code: "challenge_expired", message: error.message }, 401);
      }
      if (error instanceof PactlyChallengeReplayedError) {
        return c.json({ code: "challenge_replayed", message: error.message }, 401);
      }
      if (error instanceof PactlyChallengeInvalidError) {
        return c.json({ code: "challenge_invalid", message: error.message }, 401);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Passkey pivot: sign-up/sign-in with a passkey, the embedded custodial
  // account behind it, and the TRY rate the frontend prices everything in.
  // The JWT these issue is the same Pactly JWT `/auth/verify` issues, with
  // the custodial account's public key as `sub` -- every route below this
  // block is unchanged.
  // ---------------------------------------------------------------------

  app.post("/auth/passkey/register/options", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const result = await beginPasskeyRegistration(db, { displayName: body?.displayName }, passkeyDeps);
    return c.json(result);
  });

  app.post("/auth/passkey/register/verify", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const registrationId = typeof body?.registrationId === "string" ? body.registrationId : undefined;
    const response: unknown = body?.response;
    if (!registrationId || typeof response !== "object" || response === null) {
      return c.json({ code: "invalid_request", message: "registrationId and response are required." }, 400);
    }
    try {
      const session = await finishPasskeyRegistration(db, { registrationId, response }, passkeyDeps);
      // Fund and open the trustline off the response path -- the user is
      // signed in either way, and `GET /me/account` retries lazily.
      ensureAccountReadyInBackground(db, session.walletAddress, accountReadyDeps);
      return c.json(session, 201);
    } catch (error) {
      if (error instanceof PasskeyChallengeExpiredError) {
        return c.json({ code: "CHALLENGE_EXPIRED", message: error.message }, 410);
      }
      if (error instanceof PasskeyInvalidError) {
        return c.json({ code: "PASSKEY_INVALID", message: error.message }, 401);
      }
      throw error;
    }
  });

  app.post("/auth/passkey/login/options", async (c) => {
    const result = await beginPasskeyLogin(db, passkeyDeps);
    return c.json(result);
  });

  app.post("/auth/passkey/login/verify", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const loginId = typeof body?.loginId === "string" ? body.loginId : undefined;
    const response: unknown = body?.response;
    if (!loginId || typeof response !== "object" || response === null) {
      return c.json({ code: "invalid_request", message: "loginId and response are required." }, 400);
    }
    try {
      const session = await finishPasskeyLogin(db, { loginId, response }, passkeyDeps);
      return c.json(session);
    } catch (error) {
      if (error instanceof PasskeyUnknownError) {
        return c.json({ code: "PASSKEY_UNKNOWN", message: error.message }, 404);
      }
      if (error instanceof PasskeyInvalidError) {
        return c.json({ code: "PASSKEY_INVALID", message: error.message }, 401);
      }
      throw error;
    }
  });

  // Stellar Passkey Kit: browser creates/connects a C… smart wallet; this
  // backend fee-sponsors the deploy and issues a JWT for the G… rail.
  app.post("/auth/passkey-kit/submit", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const xdr = typeof body?.xdr === "string" ? body.xdr : undefined;
    if (!xdr) {
      return c.json({ code: "invalid_request", message: "xdr is required." }, 400);
    }
    try {
      const result = await submitPasskeyKitXdr(xdr);
      return c.json(result);
    } catch (error) {
      if (error instanceof PasskeyKitSubmitError) {
        return c.json({ code: "PASSKEY_KIT_SUBMIT", message: error.message }, 502);
      }
      throw error;
    }
  });

  app.post("/auth/passkey-kit/session", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const contractId = typeof body?.contractId === "string" ? body.contractId : undefined;
    if (!contractId) {
      return c.json({ code: "invalid_request", message: "contractId is required." }, 400);
    }
    // Issue #13: the browser's own Passkey Kit record is the only place the
    // smart wallet's passkey public key exists, so it is recorded here, at
    // session time, for the step-up assertion every money action requires.
    const rawCredential: unknown = body?.credential;
    const credential =
      typeof rawCredential === "object" && rawCredential !== null &&
      typeof (rawCredential as { id?: unknown }).id === "string" &&
      typeof (rawCredential as { publicKey?: unknown }).publicKey === "string"
        ? {
            id: (rawCredential as { id: string }).id,
            publicKey: (rawCredential as { publicKey: string }).publicKey,
            transports: Array.isArray((rawCredential as { transports?: unknown }).transports)
              ? ((rawCredential as { transports: unknown[] }).transports.filter((t): t is string => typeof t === "string"))
              : undefined,
          }
        : undefined;
    try {
      const session = await sessionForPasskeyKitWallet(db, contractId, credential);
      return c.json(session, 201);
    } catch (error) {
      if (error instanceof PasskeyKitAccountError) {
        return c.json({ code: "PASSKEY_KIT_ACCOUNT", message: error.message }, 400);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Issue #13: a fresh passkey assertion before every money action. The
  // options/verify pair is a normal WebAuthn ceremony against the caller's
  // own credential; its result is a five-minute token the build routes
  // below require (`requireFreshAssertion`). Browsing, discovery and
  // opening the panel never touch these routes.
  // ---------------------------------------------------------------------

  app.post("/auth/assertion/options", requirePactlyAuth, async (c) => {
    try {
      const result = await beginMoneyAssertion(db, c.get("walletAddress"), passkeyDeps);
      return c.json(result);
    } catch (error) {
      if (error instanceof PasskeyNotRegisteredError) {
        return c.json({ code: "PASSKEY_NOT_REGISTERED", message: error.message }, 404);
      }
      throw error;
    }
  });

  app.post("/auth/assertion/verify", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const assertionId = typeof body?.assertionId === "string" ? body.assertionId : undefined;
    const response: unknown = body?.response;
    if (!assertionId || typeof response !== "object" || response === null) {
      return c.json({ code: "invalid_request", message: "assertionId and response are required." }, 400);
    }
    try {
      const result = await finishMoneyAssertion(
        db,
        c.get("walletAddress"),
        { assertionId, response },
        passkeyDeps,
      );
      return c.json(result);
    } catch (error) {
      if (error instanceof PasskeyUnknownError) {
        // The credential row is gone (or was never recorded): the frontend
        // reconnects its wallet once, which re-registers it, then retries.
        return c.json(
          { code: "PASSKEY_NOT_REGISTERED", message: "This account has no passkey on file yet. Sign in again to register one." },
          404,
        );
      }
      if (error instanceof PasskeyInvalidError) {
        return c.json({ code: "PASSKEY_INVALID", message: error.message }, 400);
      }
      throw error;
    }
  });

  /** The caller's own account: name, custodial wallet, and whether it is
   * ready to hold USDC. A wallet-login JWT (no `users` row) gets the same
   * `404 NO_CUSTODIAL_ACCOUNT` `/me/sign` gives. Either flag still false
   * kicks the readiness job off again in the background -- the response
   * itself never waits on friendbot or the network. */
  app.get("/me/account", requirePactlyAuth, async (c) => {
    const walletAddress = c.get("walletAddress");
    const user = await getUserByWalletAddress(db, walletAddress);
    if (!user) {
      return c.json({ code: "NO_CUSTODIAL_ACCOUNT", message: "No Pactly account holds this wallet." }, 404);
    }
    if (!user.funded || !user.usdcTrustline) {
      ensureAccountReadyInBackground(db, walletAddress, accountReadyDeps);
    }
    return c.json({
      walletAddress: user.walletAddress,
      displayName: user.displayName,
      funded: user.funded,
      usdcTrustline: user.usdcTrustline,
    });
  });

  /** Signs an unsigned envelope with the caller's own custodial key -- the
   * one place a user's secret is ever used, and only for the wallet the
   * JWT names (there is no wallet field in the body to substitute). */
  app.post("/me/sign", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const unsignedXdr = typeof body?.unsignedXdr === "string" ? body.unsignedXdr : undefined;
    const passkeyContractId = typeof body?.passkeyContractId === "string" ? body.passkeyContractId : undefined;
    if (!unsignedXdr) {
      return c.json({ code: "invalid_request", message: "unsignedXdr is required." }, 400);
    }
    try {
      const signedXdr = await signXdrForWallet(db, c.get("walletAddress"), unsignedXdr, { passkeyContractId });
      return c.json({ signedXdr });
    } catch (error) {
      if (error instanceof NoCustodialAccountError) {
        return c.json({ code: "NO_CUSTODIAL_ACCOUNT", message: error.message }, 404);
      }
      if (error instanceof InvalidXdrError) {
        return c.json({ code: "invalid_request", message: error.message }, 400);
      }
      throw error;
    }
  });

  /** TRY per 1 USDC, from the anchor's own SEP-38 price. Public, cached a
   * minute, and served stale rather than failing when the anchor is down
   * -- only a cold cache plus a down anchor is a `503`. */
  app.get("/rate", async (c) => {
    try {
      const rate = await getTryRate({ fetchImpl: rateFetchImpl });
      return c.json(rate);
    } catch (error) {
      if (error instanceof RateUnavailableError) {
        return c.json({ code: "RATE_UNAVAILABLE", message: "We couldn't reach the currency exchange just now." }, 503);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Story 3.1: provider profile and availability. Public reads need no
  // auth (`/categories`, `/providers/:id`); provider writes go through
  // `requirePactlyAuth` and resolve "which profile" from the caller's
  // wallet, never from a body/query id -- there is nothing for a caller to
  // lie about (same shape as `auth/challenge.ts`'s own comment on this).
  // ---------------------------------------------------------------------

  /** Story 3.2: `providerCount` per category, approved providers only
   * (AC1). */
  app.get("/categories", async (c) => {
    const categories = await listCategoriesWithProviderCounts(db);
    return c.json({ categories });
  });

  /**
   * Public, shareable proof for a booking whose escrow contract has been
   * deployed. Shows the shop, the appointment time, the deposit amount, the
   * contract id, and the explorer/viewer links' raw inputs -- never the
   * client's identity, any booking note, or another booking. A booking with
   * no deployed contract (so no proof to show) is the same 404 as an
   * unknown id.
   */
  app.get("/proof/:id", async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "NOT_FOUND", message: "No proof was found for this booking." }, 404);
    }
    const booking = await getBookingById(db, bookingId);
    const hasDeployedContract = Boolean(
      booking?.escrowContractId && (booking.escrowState !== null || booking.deploySubmittedAt !== null),
    );
    if (!booking || !hasDeployedContract) {
      return c.json({ code: "NOT_FOUND", message: "No proof was found for this booking." }, 404);
    }

    const [profile, slot] = await Promise.all([
      getProviderProfileById(db, booking.providerProfileId),
      booking.slotId ? getSlotById(db, booking.slotId) : Promise.resolve(undefined),
    ]);

    const status = booking.escrowState === "released" ? "released" : booking.escrowState === "refunded" ? "cancelled" : "locked";

    return c.json({
      id: booking.id,
      status,
      shop: {
        displayName: profile?.displayName ?? "",
        title: profile?.title ?? "",
        location: profile?.location ?? "",
      },
      slotStartsAt: slot?.startsAt ?? null,
      deposit: { amount: booking.depositAmount, asset: "USDC" },
      contractId: booking.escrowContractId,
      // Issue #157: the release's own transaction (once the chain has moved
      // the deposit) -- never the anchor cash-out id, which is a different
      // fact entirely.
      releaseTxHash: booking.escrowReleaseTxHash,
    });
  });

  /** Story 3.2/3.3: the Discover list. Approved providers only (enforced
   * in `listApprovedProviderProfilesForDiscover`, never by filtering
   * here) as card objects, soonest-open-slot first. `?category=<slug>`
   * filters to that category; an unknown slug is a `200` with an empty
   * list, never an error (the spec's own "Unknown slug" row) -- there is
   * nothing here for the route to catch. Story 3.3 adds `q`, `format`,
   * `minPrice`/`maxPrice`, `maxDepositBps` and `when`, every one of them
   * optional and silently dropped when invalid (`parseDiscoverFilters`). */
  app.get("/providers", async (c) => {
    const category = c.req.query("category");
    const filters = parseDiscoverFilters(c);
    filters.bookableOnly = true;
    const providers = await listDiscoverProviders(db, category, filters);
    // Issue #30: a search that matches nothing names the query already (the
    // frontend echoes it) and points at the nearest category that does have
    // approved shops, with up to three of them. Only a text search gets
    // this -- a filter-only empty result keeps its existing empty state.
    const suggestions =
      providers.length === 0 && filters.query
        ? await suggestProvidersForEmptySearch(db, filters, category)
        : undefined;
    return c.json(suggestions ? { providers, suggestions } : { providers });
  });

  /** Story 3.3: search suggestions. Registered before `/providers/:id` so
   * `suggest` is never captured as an `:id` (the spec's own Code Map
   * note). `q` shorter than two characters is an empty list, never an
   * error. */
  app.get("/providers/suggest", async (c) => {
    const q = c.req.query("q") ?? "";
    const suggestions = await suggestDiscoverQueries(db, q);
    return c.json({ suggestions });
  });

  /** Approved profiles only; an unapproved or unknown id gives the same
   * 404 either way so nothing about an unapproved profile leaks. */
  app.get("/providers/:id", async (c) => {
    let callerWalletAddress: string | undefined;
    const authHeader = c.req.header("authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const { walletAddress } = await verifyPactlyJwt(authHeader.slice(7));
        callerWalletAddress = walletAddress;
      } catch {
        // Optional auth: malformed or invalid token is simply ignored
      }
    }
    try {
      const profile = await getPublicProviderProfile(db, c.req.param("id"), undefined, callerWalletAddress);
      return c.json(profile);
    } catch (error) {
      if (error instanceof ProviderNotFoundError) {
        return c.json({ code: "PROVIDER_NOT_FOUND", message: error.message }, 404);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Story 2.2: the anchor's SEP-38 indicative price, so the client sees a
  // local-currency equivalent beside every USDC amount before paying. No
  // auth required (the same indicative price for anyone, like `/providers`)
  // and no escrow/booking state touched. A quote failure never blocks the
  // flow -- see `escrowErrorResponse`-style mapping below.
  // ---------------------------------------------------------------------

  app.get("/quote", async (c) => {
    const amount = c.req.query("amount");
    if (!amount || !POSITIVE_INTEGER_STRING.test(amount)) {
      return c.json({ code: "INVALID_AMOUNT", message: "amount must be a positive integer string." }, 400);
    }
    try {
      // `refresh=1` is the screen's "the quote I am showing has aged out"
      // call: bypass the backend's own short cache so the amount the client
      // confirms is genuinely the anchor's current one. It is still a plain
      // read -- no hold, no booking, no escrow state is touched.
      const refresh = c.req.query("refresh") === "1";
      const quote = await fetchIndicativePrice({ amount }, { fetchImpl: quoteFetchImpl, forceRefresh: refresh });
      return c.json(quote);
    } catch (error) {
      if (error instanceof AnchorQuoteUnsupportedError) {
        return c.json(
          { code: "QUOTE_UNSUPPORTED", message: "The anchor doesn't offer a local-currency price for this right now." },
          409,
        );
      }
      if (error instanceof AnchorQuoteUnavailableError) {
        return c.json({ code: "QUOTE_UNAVAILABLE", message: "We couldn't reach the currency exchange just now." }, 503);
      }
      throw error;
    }
  });

  app.get("/me/provider", requirePactlyAuth, async (c) => {
    try {
      const profile = await getOwnProviderProfile(db, c.get("walletAddress"));
      return c.json(profile);
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      throw error;
    }
  });

  app.put("/me/provider/rules", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    try {
      const profile = await updateProviderRules(db, c.get("walletAddress"), {
        priceAmount: typeof body?.priceAmount === "string" ? body.priceAmount : "",
        depositRateBps: typeof body?.depositRateBps === "number" ? body.depositRateBps : Number.NaN,
        cancellationWindowHours:
          typeof body?.cancellationWindowHours === "number" ? body.cancellationWindowHours : Number.NaN,
        minimumNoticeMinutes: typeof body?.minimumNoticeMinutes === "number" ? body.minimumNoticeMinutes : undefined,
        maxBookingDaysAhead:
          body?.maxBookingDaysAhead === null
            ? null
            : typeof body?.maxBookingDaysAhead === "number"
              ? body.maxBookingDaysAhead
              : undefined,
        bufferMinutes: typeof body?.bufferMinutes === "number" ? body.bufferMinutes : 0,
      });
      return c.json(profile);
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      if (error instanceof InvalidProviderRulesError) {
        return c.json({ code: "INVALID_RULES", message: error.message, details: error.details }, 400);
      }
      throw error;
    }
  });

  /** Issue #62: the shop's own pause/resume of new bookings -- never an
   * admin moderation action, and never a way to clear a suspension. */
  app.put("/me/provider/pause", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (typeof body?.paused !== "boolean") {
      return c.json(
        { code: "INVALID_PAUSE", message: "paused must be true or false.", details: { paused: "required" } },
        400,
      );
    }
    try {
      const profile = await setProviderBookingsPaused(db, c.get("walletAddress"), body.paused);
      return c.json(profile);
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      throw error;
    }
  });

  /** Issue #65: the shop's own weekly breaks -- a window cut out of one
   * weekday's hours. Open slots inside a saved break stop being offered; a
   * booking already inside it is listed and never cancelled. */
  app.put("/me/provider/breaks", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    try {
      const profile = await setProviderBreaks(db, c.get("walletAddress"), body?.breaks);
      return c.json(profile);
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      if (error instanceof InvalidBreaksError) {
        return c.json({ code: "INVALID_BREAKS", message: error.message, details: error.details }, 400);
      }
      throw error;
    }
  });

  /** Issue #64: the shop's IANA timezone. Slots stay UTC instants; only
   * their labels follow this zone. */
  app.put("/me/provider/timezone", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const timezone = typeof body?.timezone === "string" ? body.timezone : "";
    try {
      const profile = await updateProviderTimezone(db, c.get("walletAddress"), timezone);
      return c.json(profile);
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      if (error instanceof InvalidTimezoneError) {
        return c.json({ code: "INVALID_TIMEZONE", message: error.message, details: error.details }, 400);
      }
      throw error;
    }
  });

  app.put("/me/provider/availability", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const slots: unknown = body?.slots;
    if (!Array.isArray(slots)) {
      return c.json(
        { code: "INVALID_SLOTS", message: "slots must be an array of epoch seconds.", details: { slots: "required" } },
        400,
      );
    }
    try {
      const profile = await updateProviderAvailability(db, c.get("walletAddress"), slots);
      return c.json(profile);
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      if (error instanceof InvalidAvailabilitySlotsError) {
        return c.json({ code: "INVALID_SLOTS", message: error.message, details: error.details }, 400);
      }
      throw error;
    }
  });

  /** Closing a whole date: releases that date's still-active unpaid holds
   * (they get `shop-closed-date`, so their clients see why) and removes its
   * future open slots. A funded booking is never released; it comes back in
   * `needsResolution` for the provider panel to point at. Other dates are
   * untouched. */
  app.post("/me/provider/availability/close-date", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    try {
      const result = await closeProviderDate(db, c.get("walletAddress"), {
        date: typeof body?.date === "string" ? body.date : "",
        ...(typeof body?.endDate === "string" ? { endDate: body.endDate } : {}),
        ...(typeof body?.tzOffsetMinutes === "number" ? { tzOffsetMinutes: body.tzOffsetMinutes } : {}),
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof InvalidCloseDateError) {
        return c.json({ code: "INVALID_DATE", message: error.message, details: error.details }, 400);
      }
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      throw error;
    }
  });

  const closedDateErrorResponse = (error: unknown, c: Context) => {
    if (error instanceof NotAProviderError) {
      return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
    }
    if (error instanceof InvalidClosedDateError) {
      return c.json({ code: "INVALID_CLOSED_DATE", message: error.message, details: error.details }, 400);
    }
    if (error instanceof ClosedDateBookingError) {
      return c.json(
        {
          code: "DATE_HAS_BOOKING",
          message: error.message,
          details: { bookingId: error.bookingId, slotStartsAt: error.slotStartsAt, escrowState: error.escrowState },
        },
        409,
      );
    }
    return undefined;
  };

  app.get("/me/provider/closed-dates", requirePactlyAuth, async (c) => {
    try {
      return c.json({ closedDates: await listClosedDatesForWallet(db, c.get("walletAddress")) });
    } catch (error) {
      const mapped = closedDateErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post("/me/provider/closed-dates", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    try {
      return c.json({ closedDates: await closeDate(db, c.get("walletAddress"), body?.date) });
    } catch (error) {
      const mapped = closedDateErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.put("/me/provider/closed-dates/:date", requirePactlyAuth, async (c) => {
    try {
      return c.json({ closedDates: await closeDate(db, c.get("walletAddress"), c.req.param("date")) });
    } catch (error) {
      const mapped = closedDateErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.delete("/me/provider/closed-dates/:date", requirePactlyAuth, async (c) => {
    try {
      return c.json({ closedDates: await reopenDate(db, c.get("walletAddress"), c.req.param("date")) });
    } catch (error) {
      const mapped = closedDateErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get("/me/provider/availability/closed", requirePactlyAuth, async (c) => {
    try {
      return c.json({ closedDates: await listClosedDatesForWallet(db, c.get("walletAddress")) });
    } catch (error) {
      const mapped = closedDateErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.put("/me/provider/availability/closed/:date", requirePactlyAuth, async (c) => {
    try {
      return c.json({ closedDates: await closeDate(db, c.get("walletAddress"), c.req.param("date")) });
    } catch (error) {
      const mapped = closedDateErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.delete("/me/provider/availability/closed/:date", requirePactlyAuth, async (c) => {
    try {
      return c.json({ closedDates: await reopenDate(db, c.get("walletAddress"), c.req.param("date")) });
    } catch (error) {
      const mapped = closedDateErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Story 4.1: "List your shop" -- a wallet applies, then reads its own
  // application back. The unapproved profile the application creates is
  // what `/me/provider` above then returns (with `isApproved: false`).
  // ---------------------------------------------------------------------

  app.get("/me/provider/application", requirePactlyAuth, async (c) => {
    try {
      return c.json({ application: await getOwnProviderApplication(db, c.get("walletAddress")) });
    } catch (error) {
      if (error instanceof NoProviderApplicationError) {
        return c.json({ code: "NO_APPLICATION", message: error.message }, 404);
      }
      throw error;
    }
  });

  /** Live deposit the apply form shows -- price + rate in, escrow-asset
   * amount out. A client-supplied `deposit` field is ignored; the server
   * always recomputes. Out-of-range rate (or bad price) is 400 with no
   * preview body. */
  app.post("/me/provider/application/deposit-preview", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const int = (value: unknown) => (typeof value === "number" ? value : Number.NaN);
    try {
      const deposit = previewApplicationDeposit({
        priceAmount: text(body?.priceAmount),
        depositRateBps: int(body?.depositRateBps),
      });
      return c.json({ deposit });
    } catch (error) {
      if (error instanceof InvalidProviderApplicationError) {
        return c.json({ code: "INVALID_APPLICATION", message: error.message, details: error.details }, 400);
      }
      throw error;
    }
  });

  app.post("/me/provider/application", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const int = (value: unknown) => (typeof value === "number" ? value : Number.NaN);
    try {
      // Price + rate only; any client-supplied deposit is ignored -- the
      // service recomputes via computeDepositAmount on read.
      const application = await applyAsProvider(db, c.get("walletAddress"), {
        name: text(body?.name),
        title: text(body?.title),
        categoryId: text(body?.categoryId),
        location: text(body?.location),
        serviceDescription: text(body?.serviceDescription),
        sessionFormat: text(body?.sessionFormat),
        sessionLengthMinutes: int(body?.sessionLengthMinutes),
        priceAmount: text(body?.priceAmount),
        depositRateBps: int(body?.depositRateBps),
        cancellationWindowHours: int(body?.cancellationWindowHours),
      });
      return c.json({ application }, 201);
    } catch (error) {
      if (error instanceof InvalidProviderApplicationError) {
        return c.json({ code: "INVALID_APPLICATION", message: error.message, details: error.details }, 400);
      }
      if (error instanceof ProviderApplicationPendingError) {
        return c.json({ code: "APPLICATION_PENDING", message: error.message }, 409);
      }
      if (error instanceof AlreadyAProviderError) {
        return c.json({ code: "ALREADY_A_PROVIDER", message: error.message }, 409);
      }
      throw error;
    }
  });

  /** Correcting a pending application in place. The target is always the
   *  caller's own newest application, so no id in the body can reach
   *  someone else's; a decided one gets the same `409 APPLICATION_DECIDED`
   *  `decide` already gives. */
  app.put("/me/provider/application", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const int = (value: unknown) => (typeof value === "number" ? value : Number.NaN);
    try {
      const application = await updateOwnProviderApplication(db, c.get("walletAddress"), {
        name: text(body?.name),
        title: text(body?.title),
        categoryId: text(body?.categoryId),
        location: text(body?.location),
        serviceDescription: text(body?.serviceDescription),
        sessionFormat: text(body?.sessionFormat),
        sessionLengthMinutes: int(body?.sessionLengthMinutes),
        priceAmount: text(body?.priceAmount),
        depositRateBps: int(body?.depositRateBps),
        cancellationWindowHours: int(body?.cancellationWindowHours),
      });
      return c.json({ application });
    } catch (error) {
      if (error instanceof NoProviderApplicationError) {
        return c.json({ code: "NO_APPLICATION", message: error.message }, 404);
      }
      if (error instanceof ProviderApplicationDecidedError) {
        return c.json({ code: "APPLICATION_DECIDED", message: error.message }, 409);
      }
      if (error instanceof InvalidProviderApplicationError) {
        return c.json({ code: "INVALID_APPLICATION", message: error.message, details: error.details }, 400);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Story 3.4: the client booking flow ("Lock with Pactly"). Every route
  // below requires a Pactly JWT; `lock`/`fund`/`submit`/`GET` all resolve
  // ownership from the caller's own wallet, never from a body/query field
  // (same discipline as the Story 3.1 routes above) -- an unknown booking
  // and someone else's booking give the identical `404 BOOKING_NOT_FOUND`,
  // so bookings are never enumerable.
  // ---------------------------------------------------------------------

  /** A Trustless Work failure translated into the route's own envelope --
   * shared by lock/fund/submit, the three routes that can reach the
   * adapter. Never a raw body or stack trace (AC5, carried through from
   * Story 2.6). */
  function escrowErrorResponse(error: EscrowApiError | EscrowRequestError | EscrowConfigError) {
    if (error instanceof EscrowApiError) {
      return { code: "ESCROW_REJECTED", message: "Trustless Work could not process this request.", status: 502 as const };
    }
    return { code: "ESCROW_UNAVAILABLE", message: "Trustless Work is unavailable right now. Your deposit is untouched.", status: 503 as const };
  }

  /** Issue #4: "this wallet can't hold the deposit yet" translated into the
   * route's own envelope -- shared by the two routes that gate on it (the
   * client's lock, the admin's approval). The caller supplies its own plain
   * sentence, since the two audiences need different ones. Neither ever
   * names the mechanism behind the check (Edge cases: "the sentence on
   * screen does not say trustline, SEP, or issuer"). */
  function walletReadinessErrorResponse(
    error: UsdcTrustlineMissingError | PaymentUnavailableError,
    missingMessage: string,
  ) {
    if (error instanceof UsdcTrustlineMissingError) {
      return { code: "WALLET_CANNOT_HOLD_DEPOSIT", message: missingMessage, status: 409 as const };
    }
    // Edge cases: "a missing Horizon answer is a retryable error, not an
    // approval" -- and, same rule as every other network read here, never
    // a raw upstream message on screen.
    return {
      code: "WALLET_CHECK_UNAVAILABLE",
      message: "We could not check whether this wallet is ready to hold the deposit. Try again in a moment.",
      status: 503 as const,
    };
  }

  app.post("/bookings/hold", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const providerId = typeof body?.providerId === "string" ? body.providerId : undefined;
    const slotStartsAt = typeof body?.slotStartsAt === "number" ? body.slotStartsAt : undefined;
    const tzOffsetMinutes = typeof body?.tzOffsetMinutes === "number" ? body.tzOffsetMinutes : undefined;
    const clientEmail = typeof body?.clientEmail === "string" ? body.clientEmail : undefined;
    const renewExpired = body?.renewExpired === true;
    if (!providerId || slotStartsAt === undefined) {
      return c.json(
        { code: "invalid_request", message: "providerId and slotStartsAt are required." },
        400,
      );
    }
    if (!Number.isInteger(slotStartsAt)) {
      return c.json({ code: "invalid_request", message: "slotStartsAt must be an integer number of epoch seconds." }, 400);
    }
    try {
      const result = await holdSlot(db, {
        providerProfileId: providerId,
        clientWalletAddress: c.get("walletAddress"),
        slotStartsAt,
        tzOffsetMinutes,
        clientEmail,
        renewExpired,
      });
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof ProviderNotFoundError) {
        return c.json({ code: "PROVIDER_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingsPausedError) {
        return c.json({ code: "BOOKINGS_PAUSED", message: error.message }, 409);
      }
      if (error instanceof SlotUnavailableError) {
        return c.json({ code: "SLOT_UNAVAILABLE", message: error.message }, 409);
      }
      if (error instanceof TooManyHoldsError) {
        return c.json({ code: "TOO_MANY_HOLDS", message: error.message }, 429);
      }
      if (error instanceof SlotTakenError) {
        return c.json(
          { code: "SLOT_TAKEN", message: error.message, details: { sameDaySlots: error.sameDaySlots } },
          409,
        );
      }
      if (error instanceof ProviderSelfBookingError) {
        return c.json({ code: "PROVIDER_SELF_BOOKING", message: error.message }, 409);
      }
      throw error;
    }
  });

  /** Rescheduling a locked booking: the client's own booking, still inside
   * its free-cancellation window, moves to another open slot of the same
   * shop. Only the slot and cancellation deadline change -- the escrow
   * contract id, amount and parties stay put, so there is no second escrow. */
  app.post("/bookings/:id/reschedule", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    const body = await c.req.json().catch(() => undefined);
    const slotStartsAt = typeof body?.slotStartsAt === "number" ? body.slotStartsAt : undefined;
    if (slotStartsAt === undefined || !Number.isInteger(slotStartsAt)) {
      return c.json({ code: "invalid_request", message: "slotStartsAt must be an integer number of epoch seconds." }, 400);
    }
    try {
      const view = await rescheduleLockedBooking(db, bookingId, c.get("walletAddress"), slotStartsAt);
      return c.json(view);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingOutsideCancellationWindowError) {
        return c.json({ code: "CANCELLATION_WINDOW_CLOSED", message: error.message }, 409);
      }
      if (error instanceof SlotUnavailableError) {
        return c.json({ code: "SLOT_UNAVAILABLE", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      throw error;
    }
  });

  app.post("/bookings/:id/lock", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      await getBookingForClient(db, bookingId, c.get("walletAddress"));
      const body = await c.req.json().catch(() => undefined);
      const rebuild = body?.rebuild === true;
      const result = await lockDeposit(db, bookingId, escrowAdapter, { rebuild, usdcTrustline: usdcTrustlineDeps });
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingHoldExpiredError) {
        return c.json({ code: "HOLD_EXPIRED", message: error.message }, 409);
      }
      // Issue #4: the client's own wallet cannot hold the deposit asset, so
      // no contract was deployed and no money was promised -- say what is
      // missing, in plain words.
      if (error instanceof UsdcTrustlineMissingError || error instanceof PaymentUnavailableError) {
        const response = walletReadinessErrorResponse(
          error,
          "Your wallet isn't ready to hold the deposit yet. Add the deposit asset to your wallet, then try again.",
        );
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      // Issue #6: this booking's first deploy is already running on another
      // request. Same booking, no second contract, plain words -- the client
      // waits rather than clicking into a third attempt.
      if (error instanceof BookingDeployInFlightError) {
        return c.json({ code: "DEPLOY_IN_FLIGHT", message: error.message, details: { bookingId: error.bookingId } }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof ShortDepositError) {
        return c.json(
          {
            code: "SHORT_DEPOSIT",
            message: error.message,
            details: { receivedAmount: error.receivedAmount, requiredAmount: error.requiredAmount, asset: error.asset },
          },
          409,
        );
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  app.post("/bookings/:id/fund", requirePactlyAuth, requireFreshAssertion, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      await getBookingForClient(db, bookingId, c.get("walletAddress"));
      const result = await fundDeposit(db, bookingId, escrowAdapter);
      return c.json({ unsignedXdr: result.unsignedXdr });
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingHoldExpiredError) {
        return c.json({ code: "HOLD_EXPIRED", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      // Issue #5: the fund transaction Pactly already built for this booking
      // has settled on chain -- the deposit is in, so a second one is never
      // built. Nothing here says "funded" (AD-1): the reconciler's own chain
      // evidence still has to land before the booking's poll shows `locked`.
      if (error instanceof DepositAlreadyLandedError) {
        return c.json({ code: "DEPOSIT_LANDED", message: error.message, details: { bookingId: error.bookingId } }, 409);
      }
      // Issue #5: the network could not be asked whether that transaction
      // landed. Nothing has moved and the deposit is untouched, so this is
      // retryable -- and it is deliberately not read as permission to
      // re-fund, the same rule the status read itself follows.
      if (error instanceof TransactionStatusUnavailableError) {
        return c.json({ code: "DEPOSIT_STATUS_UNAVAILABLE", message: error.message }, 503);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** Story 3.6 (review round): role-aware -- a client, a provider, or
   * Pactly's own resolver wallet may all submit here, each only ever
   * relaying the transaction kind {@link resolveSubmitRole}'s own role
   * grants it (`services/booking.ts`'s `isKindAllowedForRole`). A wallet
   * holding none of the three roles on this booking gets the same
   * `404 BOOKING_NOT_FOUND` every other route gives (bookings are never
   * enumerable). Submit is allowed after the hold expires (the spec's own
   * "Never" rule) -- role resolution only ever checks existence and
   * ownership, never the hold's own clock. */
  app.post("/bookings/:id/submit", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      // Review follow-up: role resolution now runs *before* the body is
      // even parsed for its own shape -- a stranger's request gets the
      // identical 404 BOOKING_NOT_FOUND every other route gives them,
      // never a 400 that would first confirm the booking exists.
      const { role } = await resolveSubmitRole(db, bookingId, c.get("walletAddress"));
      const body = await c.req.json().catch(() => undefined);
      const signedXdr = typeof body?.signedXdr === "string" ? body.signedXdr : undefined;
      if (!signedXdr) {
        return c.json({ code: "invalid_request", message: "signedXdr is required." }, 400);
      }
      const result = await submitSignedTransaction(db, bookingId, signedXdr, role, escrowAdapter);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof XdrMismatchError) {
        return c.json({ code: "XDR_MISMATCH", message: error.message }, 409);
      }
      if (error instanceof DisputeWindowClosedError) {
        return c.json({ code: "DISPUTE_WINDOW_CLOSED", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** Booking detail for the owning client. Includes `serverTime` (UTC epoch
   * seconds) alongside `cancelDeadline` so the free-cancellation countdown
   * can follow the server clock and resync on every poll/refetch. */
  app.get("/bookings/:id", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const view = await getBookingView(db, bookingId, c.get("walletAddress"));
      return c.json(view);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      throw error;
    }
  });

/** Issue #26: an ICS calendar file for a locked booking. Only the booking's
 * own client or provider may download it, and only once the booking is
 * locked (a hold that is not yet locked does not offer the file). The file
 * carries the start, the duration, the shop name and the booking URL -- and
 * nothing from the escrow (no deposit transaction, no wallet secret). */
function escapeIcsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function formatIcsTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

app.get("/bookings/:id/ics", requirePactlyAuth, async (c) => {
  const bookingId = c.req.param("id");
  if (!bookingId) {
    return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
  }
  try {
    const { booking } = await getBookingForClientOrProvider(db, bookingId, c.get("walletAddress"));
    if (booking.escrowState !== "locked") {
      return c.json({ code: "BOOKING_STATE", message: "An ICS download is only offered for a locked booking." }, 409);
    }
    const profile = await getProviderProfileById(db, booking.providerProfileId);
    if (!profile) {
      return c.json({ code: "BOOKING_NOT_FOUND", message: "No booking was found with that id." }, 404);
    }
    const slot = booking.slotId ? await getSlotById(db, booking.slotId) : undefined;
    const startsAt = slot?.startsAt ?? null;
    if (startsAt === null) {
      return c.json({ code: "BOOKING_STATE", message: "This booking has no appointment time on record." }, 409);
    }
    const endsAt = startsAt + profile.sessionLengthMinutes * 60;
    const nowIcs = formatIcsTime(Math.floor(Date.now() / 1000));
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Pactly//Booking//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:${bookingId}@pactly`,
      `DTSTAMP:${nowIcs}`,
      `DTSTART:${formatIcsTime(startsAt)}`,
      `DTEND:${formatIcsTime(endsAt)}`,
      `SUMMARY:Pactly appointment — ${escapeIcsText(profile.displayName || profile.id)}`,
      `DESCRIPTION:Pactly booking ${escapeIcsText(bookingId)}. Deposit held in escrow by Trustless Work.`,
      `URL:https://${config.pactlyHomeDomain}/book/${booking.providerProfileId}?slot=${startsAt}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    return new Response(ics, {
      headers: {
        "content-type": "text/calendar; charset=utf-8",
        "content-disposition": `attachment; filename="pactly-${bookingId}.ics"`,
      },
    });
  } catch (error) {
    if (error instanceof BookingNotFoundError) {
      return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
    }
    throw error;
  }
});

  // ---------------------------------------------------------------------
  // Story 2.4: SEP-6 local-currency deposit. The client signs the anchor's
  // own challenge in their wallet; the JWT never leaves this backend.
  // ---------------------------------------------------------------------

  function localDepositErrorResponse(error: unknown, c: Context<{ Variables: Variables }>) {
    if (error instanceof BookingNotFoundError) {
      return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
    }
    if (error instanceof BookingHoldExpiredError) {
      return c.json({ code: "HOLD_EXPIRED", message: error.message }, 409);
    }
    if (error instanceof BookingEscrowStateError) {
      return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
    }
    if (error instanceof XdrMismatchError) {
      return c.json({ code: "XDR_MISMATCH", message: error.message }, 409);
    }
    if (error instanceof QuoteStaleError) {
      return c.json({ code: "QUOTE_STALE", message: error.message, details: error.details }, 409);
    }
    if (error instanceof QuoteMismatchError) {
      return c.json({ code: "QUOTE_MISMATCH", message: error.message }, 409);
    }
    if (error instanceof AnchorQuoteUnsupportedError) {
      return c.json(
        { code: "QUOTE_UNSUPPORTED", message: "The anchor doesn't offer a local-currency price for this right now." },
        409,
      );
    }
    if (error instanceof AnchorQuoteUnavailableError) {
      return c.json({ code: "QUOTE_UNAVAILABLE", message: "We couldn't reach the currency exchange just now." }, 503);
    }
    if (error instanceof AmountOutOfRangeError) {
      return c.json(
        {
          code: "AMOUNT_OUT_OF_RANGE",
          message: error.message,
          details: { min: error.min, max: error.max, currency: error.currency },
        },
        409,
      );
    }
    if (error instanceof AnchorAuthRequiredError) {
      return c.json({ code: "ANCHOR_AUTH_REQUIRED", message: "Sign in with the anchor to continue." }, 401);
    }
    if (error instanceof AnchorAuthError) {
      return c.json({ code: "ANCHOR_AUTH_FAILED", message: "The wallet signature did not match. Try again." }, 401);
    }
    if (error instanceof AnchorKycError) {
      return c.json({ code: "ANCHOR_KYC_FAILED", message: error.message }, 502);
    }
    if (error instanceof AnchorDepositError) {
      console.error("[app] SEP-6 deposit refused", error.message);
      return c.json(
        {
          code: "ANCHOR_DEPOSIT_FAILED",
          message: error.simulate
            ? "The simulated bank transfer did not go through."
            : "The local-currency transfer could not be started.",
        },
        502,
      );
    }
    if (error instanceof AnchorUnavailableError || error instanceof AnchorDiscoveryError) {
      return c.json({ code: "ANCHOR_UNAVAILABLE", message: "We couldn't reach the local-currency rail just now." }, 503);
    }
    if (error instanceof SandboxOnlyError) {
      return c.json({ code: "NOT_FOUND", message: error.message }, 404);
    }
    if (error instanceof AccountFundingError) {
      return c.json(
        { code: "ACCOUNT_FUNDING", message: "Your account is still being set up on testnet. Try again in a moment." },
        503,
      );
    }
    if (error instanceof PaymentFailedError) {
      return c.json({ code: "PAYMENT_FAILED", message: "Getting your wallet ready did not go through." }, 502);
    }
    if (error instanceof PaymentUnavailableError) {
      console.error("[app] Stellar payment unavailable", error.message);
      return c.json({ code: "PAYMENT_UNAVAILABLE", message: "We couldn't reach the network just now." }, 503);
    }
    return undefined;
  }

  /** Reads the client's confirmed SEP-38 quote from a request body. Only a
   * complete, typed quote counts as a confirmation; anything else falls back
   * to the backend's own fresh quote rather than trusting an arbitrary fiat
   * amount from the client. */
  function parseConfirmedQuote(body: unknown): ConfirmedQuote | undefined {
    const raw = (body as { quote?: unknown } | undefined)?.quote;
    if (typeof raw !== "object" || raw === null) return undefined;
    const quote = raw as Record<string, unknown>;
    const fiat = quote.fiat;
    if (
      typeof quote.amount !== "string" ||
      typeof quote.quotedAt !== "number" ||
      typeof fiat !== "object" ||
      fiat === null ||
      typeof (fiat as Record<string, unknown>).amount !== "string"
    ) {
      return undefined;
    }
    return {
      amount: quote.amount,
      quotedAt: quote.quotedAt,
      maxAgeSeconds: typeof quote.maxAgeSeconds === "number" ? quote.maxAgeSeconds : undefined,
      fiat: fiat as ConfirmedQuote["fiat"],
    };
  }

  /** Friendbot + USDC trustline for a custodial / passkey-rail G… — coalesces
   * with the fire-and-forget job kicked off at sign-in. Wallet-login JWTs
   * have no users row; skip those. */
  async function ensureCustodialReady(walletAddress: string): Promise<void> {
    try {
      await ensureAccountReady(db, walletAddress, accountReadyDeps);
    } catch (error) {
      if (error instanceof NoCustodialAccountError) return;
      throw error;
    }
  }

  app.post("/bookings/:id/anchor/challenge", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      await ensureCustodialReady(c.get("walletAddress"));
      const result = await beginBookingAnchorAuth(db, bookingId, c.get("walletAddress"), localDepositDeps);
      return c.json(result);
    } catch (error) {
      const mapped = localDepositErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post("/bookings/:id/anchor/verify", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    const body = await c.req.json().catch(() => undefined);
    const signedXdr = typeof body?.signedXdr === "string" ? body.signedXdr : undefined;
    if (!signedXdr) {
      return c.json({ code: "invalid_request", message: "signedXdr is required." }, 400);
    }
    try {
      await completeBookingAnchorAuth(db, bookingId, c.get("walletAddress"), signedXdr, localDepositDeps);
      return c.json({ ok: true });
    } catch (error) {
      const mapped = localDepositErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post("/bookings/:id/deposit/local", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    const body = await c.req.json().catch(() => undefined);
    const confirmedQuote = parseConfirmedQuote(body);
    try {
      await ensureCustodialReady(c.get("walletAddress"));
      const result = await openLocalDeposit(db, bookingId, c.get("walletAddress"), {
        ...localDepositDeps,
        confirmedQuote,
      });
      return c.json(result);
    } catch (error) {
      const mapped = localDepositErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  // Story #19: retry a failed anchor deposit without starting a new hold
  app.post("/bookings/:id/deposit/local/retry", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      await ensureCustodialReady(c.get("walletAddress"));
      const booking = await getBookingForClient(db, bookingId, c.get("walletAddress"));
      const result = await retryFailedDeposit(db, booking, c.get("walletAddress"), localDepositDeps);
      return c.json(result);
    } catch (error) {
      const mapped = localDepositErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post("/bookings/:id/deposit/local/trustline", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    const body = await c.req.json().catch(() => undefined);
    const signedXdr = typeof body?.signedXdr === "string" ? body.signedXdr : undefined;
    if (!signedXdr) {
      return c.json({ code: "invalid_request", message: "signedXdr is required." }, 400);
    }
    const confirmedQuote = parseConfirmedQuote(body);
    try {
      const result = await submitLocalDepositTrustline(db, bookingId, c.get("walletAddress"), signedXdr, {
        ...localDepositDeps,
        confirmedQuote,
      });
      return c.json(result);
    } catch (error) {
      const mapped = localDepositErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get("/bookings/:id/deposit/local", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const result = await pollLocalDeposit(db, bookingId, c.get("walletAddress"), localDepositDeps);
      return c.json(result);
    } catch (error) {
      const mapped = localDepositErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post("/bookings/:id/deposit/local/simulate", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const result = await simulateLocalDeposit(db, bookingId, c.get("walletAddress"), localDepositDeps);
      return c.json(result);
    } catch (error) {
      const mapped = localDepositErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Story 3.5: the two-sided status panel. Both routes resolve "whose
  // bookings" from the caller's own wallet alone (same discipline as every
  // other `/me/...` route in this file) -- there is no id in either URL for
  // a caller to substitute someone else's for.
  // ---------------------------------------------------------------------

  /** "My bookings": every booking the caller's own wallet is the client on,
   * across every provider, ordered by appointment date (AC2). An empty
   * list is a plain `200` with `bookings: []` -- the "No bookings yet."
   * empty state is the frontend's own job, not an error case here. */
  app.get("/me/bookings", requirePactlyAuth, async (c) => {
    const bookingsList = await listBookingsForClient(db, c.get("walletAddress"));
    return c.json({ bookings: bookingsList });
  });

  /** Issue #67: the signed-in shop downloads its own bookings as CSV for a
   * from/to range. An inverted range is a `400 INVALID_RANGE`; another
   * shop's bookings are never read. */
  app.get("/me/provider/bookings/export", requirePactlyAuth, async (c) => {
    let range;
    try {
      range = parseExportRange(c.req.query("from"), c.req.query("to"));
    } catch (error) {
      if (error instanceof InvalidExportRangeError) {
        return c.json({ code: "INVALID_RANGE", message: error.message }, 400);
      }
      throw error;
    }
    try {
      const { csv, fileName } = await exportProviderBookings(db, c.get("walletAddress"), range);
      return c.body(csv, 200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${fileName}"`,
      });
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      throw error;
    }
  });

  /** The provider panel's "Bookings" view: every booking against the
   * caller's own provider profile, ordered by appointment date. A wallet
   * with no provider profile gets the same `404 NOT_A_PROVIDER` every other
   * `/me/provider` route already gives. */
  app.get("/me/provider/bookings", requirePactlyAuth, async (c) => {
    try {
      const bookingsList = await listBookingsForProvider(db, c.get("walletAddress"));
      return c.json({ bookings: bookingsList });
    } catch (error) {
      if (error instanceof NotAProviderError) {
        return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Issue #1 (Story 2.3): provider cash-out. Every route resolves the
  // provider and the cash-out from the caller's own wallet alone, so
  // another provider's id is indistinguishable from a missing one.
  // ---------------------------------------------------------------------

  function cashOutErrorResponse(error: unknown, c: Context<{ Variables: Variables }>) {
    if (error instanceof NotAProviderError) {
      return c.json({ code: "NOT_A_PROVIDER", message: error.message }, 404);
    }
    if (error instanceof CashOutNotFoundError) {
      return c.json({ code: "CASH_OUT_NOT_FOUND", message: "That cash-out could not be found." }, 404);
    }
    if (error instanceof InvalidCashOutAmountError) {
      return c.json({ code: "INVALID_AMOUNT", message: error.message }, 400);
    }
    if (error instanceof AmountOutOfRangeError) {
      return c.json(
        {
          code: "AMOUNT_OUT_OF_RANGE",
          message: error.message,
          details: { min: error.min, max: error.max, currency: error.currency },
        },
        409,
      );
    }
    if (error instanceof InsufficientBalanceError) {
      return c.json({ code: "INSUFFICIENT_BALANCE", message: error.message }, 409);
    }
    if (error instanceof AnchorAuthRequiredError) {
      return c.json({ code: "ANCHOR_AUTH_REQUIRED", message: "Sign in with the anchor to continue." }, 401);
    }
    if (error instanceof AnchorAuthError) {
      return c.json({ code: "ANCHOR_AUTH_FAILED", message: "The wallet signature did not match. Try again." }, 401);
    }
    if (error instanceof XdrMismatchError) {
      return c.json({ code: "XDR_MISMATCH", message: error.message }, 409);
    }
    if (error instanceof AnchorKycError) {
      return c.json({ code: "ANCHOR_KYC_FAILED", message: "The anchor could not verify this wallet just now." }, 502);
    }
    if (error instanceof AnchorDepositError) {
      console.error("[app] SEP-6 withdraw refused", error.message);
      return c.json({ code: "ANCHOR_WITHDRAW_FAILED", message: "The cash-out could not be started." }, 502);
    }
    if (error instanceof AnchorUnavailableError || error instanceof AnchorDiscoveryError) {
      return c.json({ code: "ANCHOR_UNAVAILABLE", message: "We couldn't reach the cash-out rail just now." }, 503);
    }
    if (error instanceof AnchorQuoteUnavailableError || error instanceof AnchorQuoteUnsupportedError) {
      return c.json({ code: "QUOTE_UNAVAILABLE", message: "We couldn't check the cash-out limits just now." }, 503);
    }
    if (error instanceof PaymentFailedError) {
      return c.json({ code: "PAYMENT_FAILED", message: "The cash-out payment was not accepted." }, 502);
    }
    if (error instanceof PaymentUnavailableError) {
      console.error("[app] cash-out payment unavailable", error.message);
      return c.json({ code: "PAYMENT_UNAVAILABLE", message: "We couldn't reach the network just now." }, 503);
    }
    return undefined;
  }

  app.post("/me/provider/anchor/challenge", requirePactlyAuth, async (c) => {
    try {
      return c.json(await beginCashOutAnchorAuth(db, c.get("walletAddress"), cashOutDeps));
    } catch (error) {
      const mapped = cashOutErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post("/me/provider/anchor/verify", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const signedXdr = typeof body?.signedXdr === "string" ? body.signedXdr : "";
    if (!signedXdr) {
      return c.json({ code: "invalid_request", message: "signedXdr is required." }, 400);
    }
    try {
      await completeCashOutAnchorAuth(db, c.get("walletAddress"), signedXdr, cashOutDeps);
      return c.json({ ok: true });
    } catch (error) {
      const mapped = cashOutErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get("/me/provider/cash-out/balance", requirePactlyAuth, async (c) => {
    try {
      return c.json(await getCashOutBalance(db, c.get("walletAddress"), cashOutDeps));
    } catch (error) {
      const mapped = cashOutErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get("/me/provider/cash-outs", requirePactlyAuth, async (c) => {
    try {
      return c.json({ cashOuts: await listCashOuts(db, c.get("walletAddress")) });
    } catch (error) {
      const mapped = cashOutErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post("/me/provider/cash-out", requirePactlyAuth, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const amount = typeof body?.amount === "string" ? body.amount.trim() : "";
    if (!amount) {
      return c.json({ code: "invalid_request", message: "amount is required." }, 400);
    }
    try {
      return c.json(await startCashOut(db, c.get("walletAddress"), amount, cashOutDeps));
    } catch (error) {
      const mapped = cashOutErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.post("/me/provider/cash-out/:id/submit", requirePactlyAuth, async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => undefined);
    const signedXdr = typeof body?.signedXdr === "string" ? body.signedXdr : "";
    if (!id) {
      return c.json({ code: "invalid_request", message: "cash-out id is required." }, 400);
    }
    if (!signedXdr) {
      return c.json({ code: "invalid_request", message: "signedXdr is required." }, 400);
    }
    try {
      return c.json(await submitCashOut(db, c.get("walletAddress"), id, signedXdr, cashOutDeps));
    } catch (error) {
      const mapped = cashOutErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  app.get("/me/provider/cash-out/:id", requirePactlyAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ code: "invalid_request", message: "cash-out id is required." }, 400);
    }
    try {
      return c.json(await getCashOut(db, c.get("walletAddress"), id, cashOutDeps));
    } catch (error) {
      const mapped = cashOutErrorResponse(error, c);
      if (mapped) return mapped;
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Story 3.6: appointment completion, release and resolution. Every
  // action route shares the deploy/fund routes' own discipline: ownership
  // (or, for `/admin/...`, admin-wallet membership) resolves to a
  // `404`/`NOT_ADMIN` before anything else, a wrong lifecycle state is a
  // `409 BOOKING_STATE`, and a Trustless Work failure maps through the same
  // `escrowErrorResponse` helper Story 3.4 already defined above.
  // ---------------------------------------------------------------------

  app.post("/bookings/:id/complete", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const result = await completeAppointment(db, bookingId, c.get("walletAddress"), escrowAdapter);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingActionPendingError) {
        return c.json({ code: "ACTION_PENDING", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** A shop declines an unlocked hold on its own slot. The slot is free
   * again and the client's views report the hold as declined. */
  app.post("/bookings/:id/decline", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      await declineHold(db, bookingId, c.get("walletAddress"));
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      throw error;
    }
  });

  app.post("/bookings/:id/approve", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const result = await approveAppointment(db, bookingId, c.get("walletAddress"), escrowAdapter);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingActionPendingError) {
        return c.json({ code: "ACTION_PENDING", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  app.post("/bookings/:id/release", requirePactlyAuth, requireFreshAssertion, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const result = await releaseDeposit(db, bookingId, c.get("walletAddress"), escrowAdapter);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingActionPendingError) {
        return c.json({ code: "ACTION_PENDING", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** Either side (client or provider) may open a dispute -- `reason` is
   * validated here, against the schema's own {@link DISPUTE_REASONS}, so an
   * unknown value never reaches the service layer at all (the spec's own
   * "unknown reason: 400" row). */
  /** Either side (client or provider) may open a dispute -- `reason` is
   * validated inside `openDispute` against the caller's own role-scoped
   * whitelist (Story 3.6 review round), so an unknown reason *or* one that
   * belongs to the other role never reaches the adapter, both surfacing as
   * the identical `400 INVALID_REASON`. */
  app.post("/bookings/:id/dispute", requirePactlyAuth, requireFreshAssertion, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    const body = await c.req.json().catch(() => undefined);
    const reason = typeof body?.reason === "string" ? body.reason : undefined;
    if (!reason) {
      return c.json({ code: "invalid_request", message: "reason is required." }, 400);
    }
    // Issue #22: the dispute opener may attach a free-text note and a
    // SHA-256 hex evidence hash (64 lowercase hex characters) to the
    // dispute -- the file itself is never stored, only the hash.
    const note = typeof body?.note === "string" ? body.note : "";
    const evidenceHash = typeof body?.evidenceHash === "string" ? body.evidenceHash : "";
    try {
      const result = await openDispute(
        db,
        bookingId,
        c.get("walletAddress"),
        reason as DisputeReason,
        escrowAdapter,
        undefined,
        note,
        evidenceHash,
      );
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof InvalidDisputeReasonError) {
        return c.json({ code: "INVALID_REASON", message: error.message }, 400);
      }
      if (error instanceof DisputeWindowClosedError) {
        return c.json({ code: "DISPUTE_WINDOW_CLOSED", message: error.message }, 409);
      }
      if (error instanceof BookingActionPendingError) {
        return c.json({ code: "ACTION_PENDING", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** Pactly's own dispute-resolver signature: gated to an admin wallet
   * ({@link requireAdmin}, `404` otherwise) that is *also*
   * `config.trustlessWorkPlatformAddress` -- an admin who is not the
   * dispute resolver gets `403 NOT_DISPUTE_RESOLVER`, never a silent
   * success building an XDR nobody can actually sign as the resolver. */
  app.post(
    "/admin/bookings/:id/resolve",
    requirePactlyAuth,
    requireAdmin,
    requireFreshAssertion,
    async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    if (c.get("walletAddress") !== config.trustlessWorkPlatformAddress) {
      return c.json(
        { code: "NOT_DISPUTE_RESOLVER", message: "This admin wallet is not Pactly's dispute resolver." },
        403,
      );
    }
    const body = await c.req.json().catch(() => undefined);
    const outcome = typeof body?.outcome === "string" ? body.outcome : undefined;
    if (!outcome || !(DISPUTE_OUTCOMES as readonly string[]).includes(outcome)) {
      return c.json(
        { code: "invalid_request", message: `outcome must be one of ${DISPUTE_OUTCOMES.join(", ")}.` },
        400,
      );
    }
    const reason = typeof body?.reason === "string" ? body.reason : undefined;
    const existing = await getBookingById(db, bookingId);
    if (!existing) {
      return c.json({ code: "BOOKING_NOT_FOUND", message: "No booking was found with that id." }, 404);
    }
    try {
      const result = await resolveBookingDispute(db, bookingId, outcome as DisputeOutcome, escrowAdapter, {
        adminWallet: c.get("walletAddress"),
        reason,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingActionPendingError) {
        return c.json({ code: "ACTION_PENDING", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof EscrowApiError || error instanceof EscrowRequestError || error instanceof EscrowConfigError) {
        const response = escrowErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** The admin "Resolutions" list: every dispute the chain still shows as
   * open, plus who opened it, why, and the policy's own suggested outcome
   * -- guidance only, never applied automatically (Story 3.6's own
   * Boundaries: "The admin may pick either outcome"). Any admin wallet may
   * view this, whether or not it is also the dispute resolver -- only
   * `/admin/bookings/:id/resolve` itself needs that stricter check. */
  app.get("/admin/disputes", requirePactlyAuth, requireAdmin, async (c) => {
    const disputes = await listOpenDisputes(db);
    return c.json({ disputes });
  });

  // ---------------------------------------------------------------------
  // Story 4.2: the admin approval queue. Same gate as the dispute list --
  // any admin wallet may decide an application.
  // ---------------------------------------------------------------------

  app.get("/admin/applications", requirePactlyAuth, requireAdmin, async (c) => {
    return c.json({ applications: await listPendingApplications(db) });
  });

  app.get("/admin/audit", requirePactlyAuth, requireAdmin, async (c) => {
    const rows = await listAdminDecisionAudit(db);
    return c.json({ audit: rows });
  });

  app.post("/admin/applications/:id/decide", requirePactlyAuth, requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ code: "invalid_request", message: "application id is required." }, 400);
    }
    const body = await c.req.json().catch(() => undefined);
    const outcome = typeof body?.outcome === "string" ? body.outcome : undefined;
    if (outcome !== "approve" && outcome !== "reject") {
      return c.json({ code: "invalid_request", message: "outcome must be approve or reject." }, 400);
    }
    try {
      const application = await decideApplication(
        db,
        id,
        outcome,
        c.get("walletAddress"),
        typeof body?.reason === "string" ? body.reason : undefined,
        { usdcTrustline: usdcTrustlineDeps },
      );
      return c.json({ application });
    } catch (error) {
      if (error instanceof ProviderApplicationNotFoundError) {
        return c.json({ code: "APPLICATION_NOT_FOUND", message: error.message }, 404);
      }
      // Issue #4: the shop's wallet could not hold a deposit, so nothing was
      // approved -- the application is still pending, and the admin is told
      // what to ask for, in plain words.
      if (error instanceof UsdcTrustlineMissingError || error instanceof PaymentUnavailableError) {
        const response = walletReadinessErrorResponse(
          error,
          "This shop's wallet isn't ready to receive deposits yet. Ask them to get it ready, then approve again.",
        );
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      if (error instanceof ProviderApplicationDecidedError) {
        return c.json({ code: "APPLICATION_DECIDED", message: error.message }, 409);
      }
      if (error instanceof InvalidProviderApplicationError) {
        return c.json({ code: "INVALID_APPLICATION", message: error.message, details: error.details }, 400);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Admin suspension: an approved shop can be taken out of discovery with
  // a reason and put back again. A pending application cannot be suspended
  // (it is rejected instead); existing bookings are never touched. There is
  // no audit log in this codebase, so nothing beyond the profile row itself
  // is written here.
  // ---------------------------------------------------------------------

  app.post("/admin/providers/:id/suspend", requirePactlyAuth, requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ code: "invalid_request", message: "provider id is required." }, 400);
    }
    const body = await c.req.json().catch(() => undefined);
    try {
      const profile = await suspendProviderProfile(db, id, typeof body?.reason === "string" ? body.reason : "");
      return c.json({ profile });
    } catch (error) {
      if (error instanceof ProviderNotFoundError) {
        return c.json({ code: "PROVIDER_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof ProviderNotApprovedError) {
        return c.json({ code: "PROVIDER_NOT_APPROVED", message: error.message }, 409);
      }
      if (error instanceof InvalidSuspensionReasonError) {
        return c.json({ code: "INVALID_SUSPENSION_REASON", message: error.message, details: error.details }, 400);
      }
      throw error;
    }
  });

  app.post("/admin/providers/:id/unsuspend", requirePactlyAuth, requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ code: "invalid_request", message: "provider id is required." }, 400);
    }
    try {
      const profile = await unsuspendProviderProfile(db, id);
      return c.json({ profile });
    } catch (error) {
      if (error instanceof ProviderNotFoundError) {
        return c.json({ code: "PROVIDER_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof ProviderNotApprovedError) {
        return c.json({ code: "PROVIDER_NOT_APPROVED", message: error.message }, 409);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Story 3.7: paying the balance before the session. Two independent
  // paths (AD-3: neither ever touches `escrow_state` or the Trustless Work
  // adapter) -- through Pactly (a plain Stellar payment this backend
  // builds, the client signs, this backend submits and polls to a
  // confirmed ledger result), or in person (the provider's own record).
  // ---------------------------------------------------------------------

  /** A Stellar payment failure translated into the route's own envelope --
   * shared by `balance/submit`, mirroring `escrowErrorResponse` above.
   * Never a raw body or stack trace. */
  function paymentErrorResponse(error: PaymentFailedError | PaymentUnavailableError) {
    if (error instanceof PaymentFailedError) {
      return { code: "PAYMENT_FAILED", message: "The payment could not be completed. Your balance is still unpaid.", status: 502 as const };
    }
    return {
      code: "PAYMENT_UNAVAILABLE",
      message: "The Stellar network is unavailable right now. Your balance is still unpaid.",
      status: 503 as const,
    };
  }

  app.post("/bookings/:id/balance/pay", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const result = await buildBalancePayment(db, bookingId, c.get("walletAddress"), buildBalancePaymentDeps);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof NothingToPayError) {
        return c.json({ code: "NOTHING_TO_PAY", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof PaymentFailedError || error instanceof PaymentUnavailableError) {
        const response = paymentErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  app.post("/bookings/:id/balance/submit", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      // Same discipline as the escrow submit route: ownership resolves
      // before the body is even parsed for its own shape.
      await getBookingForClient(db, bookingId, c.get("walletAddress"));
      const body = await c.req.json().catch(() => undefined);
      const signedXdr = typeof body?.signedXdr === "string" ? body.signedXdr : undefined;
      if (!signedXdr) {
        return c.json({ code: "invalid_request", message: "signedXdr is required." }, 400);
      }
      const result = await submitBalancePayment(db, bookingId, c.get("walletAddress"), signedXdr, submitBalancePaymentDeps);
      return c.json(result);
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof XdrMismatchError) {
        return c.json({ code: "XDR_MISMATCH", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      if (error instanceof BalanceAlreadySettledError) {
        return c.json({ code: "BALANCE_ALREADY_SETTLED", message: error.message }, 409);
      }
      if (error instanceof PaymentFailedError || error instanceof PaymentUnavailableError) {
        const response = paymentErrorResponse(error);
        return c.json({ code: response.code, message: response.message }, response.status);
      }
      throw error;
    }
  });

  /** The provider's own "I received this in person" record -- resolved
   * from the caller's own wallet, so a client (or anyone else's provider
   * profile) calling this on someone else's booking gets the same
   * `404 BOOKING_NOT_FOUND` every other ownership check in this file
   * gives. */
  app.post("/bookings/:id/balance/mark-cash", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      await markBalancePaidCash(db, bookingId, c.get("walletAddress"));
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof NothingToPayError) {
        return c.json({ code: "NOTHING_TO_PAY", message: error.message }, 409);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      throw error;
    }
  });

  /** The provider marks when a client walks in -- once per booking, at or
   * after the appointment start. A client (or anyone else with no provider
   * profile) calling this on someone else's booking gets the same
   * `404 BOOKING_NOT_FOUND` every other ownership check in this file gives. */
  app.post("/bookings/:id/arrived", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    try {
      const now = Math.floor(Date.now() / 1000);
      await markArrived(db, bookingId, c.get("walletAddress"), now);
      return c.json({ ok: true });
    } catch (error) {
      if (error instanceof BookingNotFoundError) {
        return c.json({ code: "BOOKING_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof BookingEscrowStateError) {
        return c.json({ code: "BOOKING_STATE", message: error.message }, 409);
      }
      throw error;
    }
  });

  // Story 5.8: admin category management. Any admin wallet may create a
  // category or hide/show an existing one.
  // ---------------------------------------------------------------------

  app.post("/admin/categories", requirePactlyAuth, requireAdmin, async (c) => {
    const body = await c.req.json().catch(() => undefined);
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
    
    if (!name || !slug) {
      return c.json({ code: "invalid_request", message: "name and slug are required." }, 400);
    }
    
    // Check if slug already exists
    const existing = await getCategoryBySlug(db, slug);
    if (existing) {
      return c.json({ code: "DUPLICATE_SLUG", message: "A category with this slug already exists." }, 409);
    }
    
    const { randomUUID } = await import("node:crypto");
    const id = randomUUID();
    await insertCategory(db, { id, name, slug });
    // Return the category we just created
    return c.json({ category: { id, name, slug, visible: true, parentCategoryId: null } }, 201);
  });

  app.patch("/admin/categories/:id/visibility", requirePactlyAuth, requireAdmin, async (c) => {
    const id = c.req.param("id");
    if (!id) {
      return c.json({ code: "invalid_request", message: "category id is required." }, 400);
    }
    
    const body = await c.req.json().catch(() => undefined);
    const visible = body?.visible;
    if (typeof visible !== "boolean") {
      return c.json({ code: "invalid_request", message: "visible must be a boolean." }, 400);
    }
    
    const category = await getCategoryById(db, id);
    if (!category) {
      return c.json({ code: "CATEGORY_NOT_FOUND", message: "No category was found with that id." }, 404);
    }
    
    await updateCategoryVisibility(db, id, visible);
    const updated = await getCategoryById(db, id);
    return c.json({ category: updated });
  });

  // ---------------------------------------------------------------------
  // Shop reports: clients can report a shop listing to admins.
  // ---------------------------------------------------------------------

  /** A signed-in client submits a report against an approved shop. Rate
   * limited to once per day per shop. */
  app.post("/providers/:id/report", requirePactlyAuth, async (c) => {
    const providerProfileId = c.req.param("id");
    if (!providerProfileId) {
      return c.json({ code: "invalid_request", message: "provider id is required." }, 400);
    }

    const body = await c.req.json().catch(() => undefined);
    const reason = typeof body?.reason === "string" ? body.reason : "";
    
    try {
      const now = Math.floor(Date.now() / 1000);
      const result = await submitShopReport(
        db,
        {
          providerProfileId,
          reportedByWallet: c.get("walletAddress"),
          reason,
        },
        now,
      );
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof ShopNotFoundError) {
        return c.json({ code: "SHOP_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof InvalidReportReasonError) {
        return c.json({ code: "INVALID_REASON", message: error.message }, 400);
      }
      if (error instanceof ReportRateLimitError) {
        return c.json({ code: "RATE_LIMIT", message: error.message }, 429);
      }
      throw error;
    }
  });

  // ---------------------------------------------------------------------
  // Saved shops: a client's personal list of shops they want to book again.
  // ---------------------------------------------------------------------

  /** A signed-in client saves an approved shop. Idempotent. */
  app.post("/providers/:id/save", requirePactlyAuth, async (c) => {
    const providerProfileId = c.req.param("id");
    if (!providerProfileId) {
      return c.json({ code: "invalid_request", message: "provider id is required." }, 400);
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      const result = await saveShop(db, c.get("walletAddress"), providerProfileId, now);
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof SavedShopNotFoundError) {
        return c.json({ code: "SHOP_NOT_FOUND", message: error.message }, 404);
      }
      if (error instanceof ShopNotApprovedError) {
        return c.json({ code: "SHOP_NOT_APPROVED", message: error.message }, 409);
      }
      throw error;
    }
  });

  /** A signed-in client unsaves a shop. */
  app.delete("/providers/:id/save", requirePactlyAuth, async (c) => {
    const providerProfileId = c.req.param("id");
    if (!providerProfileId) {
      return c.json({ code: "invalid_request", message: "provider id is required." }, 400);
    }

    const result = await unsaveShop(db, c.get("walletAddress"), providerProfileId);
    return c.json(result);
  });

  /** Check if a shop is saved by the signed-in client. */
  app.get("/providers/:id/saved", requirePactlyAuth, async (c) => {
    const providerProfileId = c.req.param("id");
    if (!providerProfileId) {
      return c.json({ code: "invalid_request", message: "provider id is required." }, 400);
    }

    const result = await isShopSaved(db, c.get("walletAddress"), providerProfileId);
    return c.json(result);
  });

  /** List all saved shops for the signed-in client. */
  app.get("/me/saved-shops", requirePactlyAuth, async (c) => {
    const shops = await getSavedShopsForClient(db, c.get("walletAddress"));
    return c.json({ shops });
  });
  /** Admins list all shop reports, newest first. */
  app.get("/admin/shop-reports", requirePactlyAuth, requireAdmin, async (c) => {
    const reports = await getShopReportsForAdmin(db);
    return c.json({ reports });
  });

  /** Story 3.8: get the private note on a booking. Visible only to the
   * booking's owner and the shop. */
  app.get("/bookings/:id/note", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    const booking = await getBookingById(db, bookingId);
    if (!booking) {
      return c.json({ code: "BOOKING_NOT_FOUND", message: "Booking not found." }, 404);
    }
    // Note is only visible on non-terminal bookings (not released or refunded)
    if (booking.escrowState === "released" || booking.escrowState === "refunded") {
      return c.json({ note: null });
    }
    return c.json({ note: booking.note });
  });

  /** Story 3.8: set/update the private note on a booking (up to 500 chars).
   * An empty note clears the previous note. Only the booking's client
   * can set the note. */
  app.post("/bookings/:id/note", requirePactlyAuth, async (c) => {
    const bookingId = c.req.param("id");
    if (!bookingId) {
      return c.json({ code: "invalid_request", message: "booking id is required." }, 400);
    }
    const booking = await getBookingById(db, bookingId);
    if (!booking) {
      return c.json({ code: "BOOKING_NOT_FOUND", message: "Booking not found." }, 404);
    }
    // Only the booking's client can set the note
    if (booking.clientWalletAddress !== c.get("walletAddress")) {
      return c.json({ code: "forbidden", message: "Only the booking client can set the note." }, 403);
    }
    // Get note from body, enforce 500-character limit
    const body = await c.req.json().catch(() => ({}));
    const note = typeof body?.note === "string" ? body.note : undefined;
    if (note !== undefined && note.length > 500) {
      return c.json({ code: "invalid_request", message: "Note must be 500 characters or fewer." }, 400);
    }
    // Note can only be set on non-terminal bookings (not released or refunded)
    if (booking.escrowState === "released" || booking.escrowState === "refunded") {
      return c.json({ code: "forbidden", message: "Cannot set note on a booking that is released or refunded." }, 403);
    }
    await setBookingNote(db, bookingId, note ?? "");
    return c.json({ success: true });
  });

  return app;
}
