import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import {
  cancelHold,
  fundDepositWithRetry,
  getBooking,
  getLocalDeposit,
  getQuote,
  lockDeposit,
  openLocalDeposit,
  requestAnchorChallenge,
  rescheduleBooking,
  simulateLocalDeposit,
  submitLocalDepositTrustline,
  submitSignedTransaction,
  useBooking,
  useHoldSlot,
  usePublicProviderProfile,
  verifyAnchorChallenge,
  useTryRate,
} from "../../api/hooks";
import { ApiError } from "../../api/client";
import type { HoldSlotResponse, LocalDepositView, QuoteResponse } from "../../api/types";
import { DepositPill } from "../../components/DepositPill";
import { EscrowConfirmation } from "../../components/EscrowConfirmation";
import { EscrowLane } from "../../components/EscrowLane";
import { LocalCurrencyPanel, localDepositErrorMessage } from "../../components/LocalCurrencyPanel";
import { LockButton } from "../../components/LockButton";
import { ProviderHeader } from "../../components/ProviderHeader";
import { Seal } from "../../components/Seal";
import { TryAmount, useFormatTry } from "../../components/TryAmount";
import { ESCROW_UNAVAILABLE_CODE } from "../../lib/escrowConfirmation";
import { formatFiatAmount } from "../../lib/money";
import { providerPhotoSrc } from "../../lib/providerPhotos";
import { formatSlotDay, formatSlotTime } from "../../lib/time";
import { displayedQuoteIsStale, freshQuote, rememberQuote, type DisplayedQuote } from "../../lib/quoteFreshness";
import { signInErrorMessage } from "../../components/SignInPanel";
import {
  SignInCancelledError,
  assertMoneyAction,
  getSession,
  signIn,
  signOut,
  signXdr,
  type Session,
} from "../../wallet";

/** A human-readable display phase -- distinct from the ref-based "engine"
 * state below (review follow-up: the engine state -- which contractId is
 * in play, whether a deploy has been submitted -- lives in a ref so the
 * async flow functions always read the *current* value, never a value
 * captured by a stale closure from the render that started them). */
type DisplayPhase =
  | "idle"
  | "building-deploy"
  | "confirming-escrow"
  | "awaiting-deploy-signature"
  | "submitting-deploy"
  | "deploy-failed"
  | "deployed"
  | "building-fund"
  | "awaiting-fund-signature"
  | "submitting-fund"
  | "reconciling"
  | "reconciling-slow"
  | "locked";

interface PendingSignature {
  xdr: string;
  kind: "deploy" | "fund";
}

/** The escrow the client is asked to confirm before anything is signed.
 * `unsignedXdr` is absent when the deploy was already submitted earlier. */
interface EscrowConfirmationState {
  contractId: string;
  unsignedXdr?: string;
}

interface FlowEngineState {
  contractId?: string;
  /** `undefined` until a signed deploy matching this contract has actually
   * been relayed and accepted. */
  deploySubmittedAtMs?: number;
}

const SESSION_FORMAT_LABEL: Record<string, string> = {
  video: "Video call",
  in_person: "In person",
};

const RECONCILE_SLOW_AFTER_MS = 3 * 60 * 1000;

function formatDeadline(epochSeconds: number): string {
  return `${formatSlotDay(epochSeconds)} · ${formatSlotTime(epochSeconds)}`;
}

function parseIntegerSlot(raw: string | null): number | undefined {
  if (!raw || !/^-?\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * `/book/:providerId?slot=<epochSeconds>` -- the Story 3.4 booking screen.
 * Steps (Tasks & Acceptance): review summary; sign in (passkey) and hold;
 * Lock with Pactly (lock -> sign -> submit -> fund -> sign -> submit, the
 * signatures made server-side); poll `GET /bookings/:id` until `locked`;
 * seal. Sign-in is requested only once the client actually commits to
 * holding the slot (EXPERIENCE.md: "sign-in requested only at payment").
 */
export function BookingPage() {
  const { providerId } = useParams<{ providerId: string }>();
  const [searchParams] = useSearchParams();
  const slotStartsAt = parseIntegerSlot(searchParams.get("slot"));

  const { data: profile, isLoading: profileLoading, error: profileError } = usePublicProviderProfile(providerId);

  const [session, setSession] = useState<Session | undefined>(() => getSession());
  const [connecting, setConnecting] = useState(false);
  const [holdError, setHoldError] = useState<{ message: string; sameDaySlots?: number[] } | undefined>();
  const [hold, setHold] = useState<HoldSlotResponse | undefined>();
  const [holdSecondsLeft, setHoldSecondsLeft] = useState<number | undefined>();
  const [holdEndedWhileIdle, setHoldEndedWhileIdle] = useState(false);
  const [rescheduleBusy, setRescheduleBusy] = useState(false);
  const [rescheduleError, setRescheduleError] = useState<string | undefined>();
  const [rescheduleNotice, setRescheduleNotice] = useState<string | undefined>();
  const navigate = useNavigate();

  const holdMutation = useHoldSlot();

  const [phase, setPhase] = useState<DisplayPhase>("idle");
  const [pendingSignature, setPendingSignature] = useState<PendingSignature | undefined>();
  const [flowNotice, setFlowNotice] = useState<string | undefined>();
  const [flowFatalError, setFlowFatalError] = useState<string | undefined>();
  const [escrowConfirmation, setEscrowConfirmation] = useState<EscrowConfirmationState | undefined>();
  const [escrowUnavailable, setEscrowUnavailable] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  // 2026-09 pivot: the anchor bank transfer is the only way to pay the
  // deposit -- there is no payment-method choice any more, so the local
  // transfer state below is always the live path once a hold exists.
  // Issue #145: intake answers for this booking
  const [intakeAnswers, setIntakeAnswers] = useState<Record<string, string>>({});
  const [intakeLoading, setIntakeLoading] = useState(false);
  const [localDeposit, setLocalDeposit] = useState<LocalDepositView | undefined>();
  const [clientEmail, setClientEmail] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [localNotice, setLocalNotice] = useState<string | undefined>();
  const [lockWalletConfirm, setLockWalletConfirm] = useState<
    | { kind: "flow"; address: string; rebuild: boolean }
    | { kind: "retry"; address: string }
    | undefined
  >();

  // Review follow-up: the flow's own "engine" state (which contractId is in
  // play, whether a deploy has actually been submitted) lives in a ref, not
  // in React state read through a closure -- `runLockFlow` and
  // `retryPendingSignature` are long-running async functions with several
  // `await` points, and only a ref is guaranteed to reflect the *current*
  // value at each one rather than whatever was true when that particular
  // invocation started.
  const engineRef = useRef<FlowEngineState>({});
  // Guards re-entry: a second tap of "Lock with Pactly" (or "Open wallet
  // again") while a flow is already in flight must never start a second,
  // concurrent one.
  const inFlightRef = useRef(false);
  const reconcileStartedAtRef = useRef<number | undefined>(undefined);

  const resumeAttemptedRef = useRef(false);
  const bookingFactsReadRef = useRef(false);
  const formatTryAmount = useFormatTry();
  const { currency: anchorCurrency, isFallback: currencyUnavailable } = useTryRate();

  useEffect(() => {
    if (flowFatalError) flowFatalErrorRef.current?.focus();
  }, [flowFatalError]);
  useEffect(() => {
    if (quoteError) quoteErrorRef.current?.focus();
  }, [quoteError]);

  const isLocked = phase === "locked";
  // Polled from the moment a hold exists, not only once the lock flow is
  // running: a shop can close this date while the client is still deciding,
  // and this is how the page learns the hold was released (no deposit was
  // taken) without waiting for its own countdown to run out.
  const booking = useBooking(hold?.bookingId, session, {
    enabled: Boolean(hold?.bookingId && session),
  });

  const prefersReducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // The amount the quote prices is always the authoritative deposit amount:
  // the hold's own once one exists, otherwise the profile's advertised one.
  const quoteAmount = hold?.deposit.amount ?? profile?.deposit.amount;

  useEffect(() => {
    if (!quoteAmount) return;
    let cancelled = false;
    void getQuote(quoteAmount)
      .then((quote) => {
        if (!cancelled) {
          setDepositQuote(rememberQuote(quote));
          setQuoteError(undefined);
        }
      })
      .catch(() => {
        if (!cancelled) setQuoteError("We couldn't load the local-currency price.");
      });
    return () => {
      cancelled = true;
    };
  }, [quoteAmount]);

  // The hold countdown, ticking every second while a hold exists and is
  // not yet locked -- `aria-live="polite"` per the Accessibility Floor.
  useEffect(() => {
    if (!hold || isLocked) return;
    function tick() {
      const remaining = Math.max(0, (hold?.holdExpiresAt ?? 0) - Math.floor(Date.now() / 1000));
      setHoldSecondsLeft(remaining);
    }
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [hold, isLocked]);

  // Review follow-up: if the hold's own countdown reaches zero while the
  // client has not even started the lock flow yet, the hold is cleared
  // client-side and the "hold this slot again" button comes back --
  // resuming a flow already in progress is a different, allowed case
  // (submit is permitted after expiry; this only covers the *idle* case).
  useEffect(() => {
    if (
      phase === "idle"
      && hold
      && !engineRef.current.contractId
      && hold.holdExpiresAt < Math.floor(Date.now() / 1000)
    ) {
      setHold(undefined);
      setHoldEndedWhileIdle(true);
      engineRef.current = {};
    }
  }, [phase, hold, holdSecondsLeft]);

  // The shop closed this whole date and the backend released this unpaid
  // hold. Drop the local hold so the payment steps disappear and say
  // plainly that no deposit was taken -- never leave the countdown implying
  // the slot can still be paid for.
  useEffect(() => {
    if (!hold || booking.data?.holdReleasedReason !== "shop-closed-date") return;
    setHold(undefined);
    setLocalDeposit(undefined);
    setLocalNotice(undefined);
    setHoldEndedWhileIdle(false);
    setHoldError({ message: "The shop closed this date. No deposit was taken." });
    engineRef.current = {};
    if (phase !== "locked") {
      setPhase("idle");
    }
  }, [hold, booking.data?.holdReleasedReason, phase]);

  // Once the reconciler confirms `locked`, the seal is allowed to stamp --
  // never on a submit response alone (the spec's own "Always" rule).
  useEffect(() => {
    if ((phase === "reconciling" || phase === "reconciling-slow") && booking.data?.escrowState === "locked") {
      setPhase("locked");
    }
  }, [phase, booking.data?.escrowState]);

  // Story 2.4: poll the local-currency transfer while it is waiting, so
  // a completed (or simulated) bank transfer surfaces as "Money received"
  // without a reload. 4s is coarse enough not to hammer the anchor.
  useEffect(() => {
    if (!hold || !session || !localDeposit) return;
    if (localDeposit.status !== "waiting" && localDeposit.status !== "paying" && localDeposit.status !== "needs_trustline") return;
    const interval = setInterval(() => {
      void getLocalDeposit(hold.bookingId, session)
        .then((next) => {
          setLocalDeposit(next);
          if (next.holdExpiresAt) {
            setHold((current) => (current ? { ...current, holdExpiresAt: next.holdExpiresAt ?? current.holdExpiresAt } : current));
          }
        })
        .catch(() => {
          /* last known status stays on screen */
        });
    }, 4000);
    return () => clearInterval(interval);
  }, [hold, session, localDeposit]);

  // Review follow-up: after 3 minutes without `locked`, stop implying an
  // endless spinner is normal -- the deposit is still safe (the reconciler
  // keeps trying independently of this tab), just say so plainly.
  useEffect(() => {
    if (phase === "reconciling") {
      reconcileStartedAtRef.current = Date.now();
      const timer = setTimeout(() => setPhase((current) => (current === "reconciling" ? "reconciling-slow" : current)), RECONCILE_SLOW_AFTER_MS);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  // A signed-in client who already holds this slot (refresh, My bookings
  // continue, or a second visit) gets that hold back without tapping Hold
  // again. The hold endpoint is idempotent for the same wallet + slot.
  useEffect(() => {
    if (resumeAttemptedRef.current) return;
    if (!session || !providerId || slotStartsAt === undefined || hold) return;
    resumeAttemptedRef.current = true;
    void holdMutation
      .mutateAsync({
        providerId,
        slotStartsAt,
        token: session.token,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
        ...(clientEmail.trim() ? { clientEmail: clientEmail.trim() } : {}),
      })
      .then((result) => {
        if (result.isExpiredHold) {
          setHold(undefined);
          setHoldEndedWhileIdle(true);
          return;
        }
        setHold(result);
        setHoldEndedWhileIdle(false);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          resumeAttemptedRef.current = false;
          handleUnauthorized();
          return;
        }
        if (error instanceof ApiError && error.code === "TOO_MANY_HOLDS") {
          setHoldError({
            message: "You already have other slots on hold. Continue one from My bookings.",
          });
          return;
        }
        resumeAttemptedRef.current = false;
      });
  }, [session, providerId, slotStartsAt, hold, holdMutation]);

  // Restore an in-flight local-currency transfer after hold resume.
  useEffect(() => {
    if (!hold || !session) return;
    let cancelled = false;
    void getLocalDeposit(hold.bookingId, session)
      .then((view) => {
        if (!cancelled) setLocalDeposit(view);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && (error.code === "BOOKING_STATE" || error.status === 409)) return;
      });
    return () => {
      cancelled = true;
    };
  }, [hold, session]);

  // Issue #5: a booking can come back with its escrow already created and
  // no deposit in it -- the fund signature was declined, the tab was closed
  // between the two steps, the client is continuing from My bookings. Read
  // that once when the hold returns so the screen knows before the client
  // taps anything, and the step it offers is funding the escrow that exists,
  // never a second deploy. A read that fails, or a booking with no contract
  // id, leaves the default in place: start at the deploy.
  useEffect(() => {
    if (!hold || !session || bookingFactsReadRef.current) return;
    bookingFactsReadRef.current = true;
    let cancelled = false;
    void getBooking(hold.bookingId, session)
      .then((view) => {
        if (cancelled) return;
        setBookingFacts(view);
        if (!view.deploySubmitted || view.escrowState !== null || !view.contractId) return;
        // Never overwrite a flow this tab already started.
        if (inFlightRef.current || engineRef.current.contractId) return;
        engineRef.current = { contractId: view.contractId, deploySubmittedAtMs: Date.now() };
        setPhase("deployed");
      })
      .catch(() => {
        /* No facts to seed -- the flow keeps its default start. */
      });
    return () => {
      cancelled = true;
    };
  }, [hold, session]);

  function handleUnauthorized(): void {
    signOut();
    setSession(undefined);
    setNeedsSignIn(true);
  }

  /** Issue #7: a deploy that replaced an earlier one has just changed this
   * booking's escrow history -- re-read it so the id the client lost track
   * of is on screen right away, not only once this tab goes on to submit a
   * fund and the confirmation poll starts. */
  function refreshBookingFacts(): void {
    if (!hold || !session) return;
    void getBooking(hold.bookingId, session)
      .then((view) => setBookingFacts(view))
      .catch(() => {
        /* the last known facts stay on screen */
      });
  }

  async function ensureSessionAndHold() {
    setHoldError(undefined);
    setHoldEndedWhileIdle(false);
    setHoldCancelled(false);
    setNeedsSignIn(false);
    let activeSession = session;
    if (!activeSession) {
      setConnecting(true);
      try {
        activeSession = await signIn();
        setSession(activeSession);
      } catch (error) {
        setConnecting(false);
        setHoldError({ message: signInErrorMessage(error) });
        return;
      }
      setConnecting(false);
    }
    if (!providerId || slotStartsAt === undefined) return;
    try {
      // Review follow-up: the fresh token is passed explicitly, rather than
      // relying on a `useHoldSlot(session)`-style hook whose closure would
      // still hold the *previous* (absent) session on this very first call
      // -- `setSession` above only takes effect on the next render.
      const result = await holdMutation.mutateAsync({
        providerId,
        slotStartsAt,
        token: activeSession.token,
        tzOffsetMinutes: new Date().getTimezoneOffset(),
        ...(clientEmail.trim() ? { clientEmail: clientEmail.trim() } : {}),
        renewExpired: holdEndedWhileIdle,
      });
      if (result.isExpiredHold) {
        setHold(undefined);
        setHoldEndedWhileIdle(true);
        return;
      }
      setHold(result);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) {
          handleUnauthorized();
          return;
        }
        if (error.code === "SLOT_TAKEN") {
          const details = error.details as { sameDaySlots?: number[] } | undefined;
          setHoldError({ message: "That slot just went.", sameDaySlots: details?.sameDaySlots ?? [] });
          return;
        }
        if (error.code === "SLOT_UNAVAILABLE" || error.code === "PROVIDER_NOT_FOUND") {
          setHoldError({ message: "That slot isn't available anymore." });
          return;
        }
        if (error.code === "SLOT_IN_PAST") {
          setHoldError({ message: "This slot has already started. Please pick a later slot." });
          return;
        }
        if (error.code === "TOO_MANY_HOLDS") {
          setHoldError({
            message: "You already have slots on hold. Open My bookings and continue one of those — don't hold a new slot.",
          });
          return;
        }
        setHoldError({ message: error.message || "Connection dropped. Your deposit is untouched." });
        return;
      }
      setHoldError({ message: "Connection dropped. Your deposit is untouched." });
    }
  }

  /** Gives the slot back: removes the client's own unlocked hold, then
   * returns the page to its "hold this slot" step. */
  async function handleCancelHold(): Promise<void> {
    if (!hold || !session || cancellingHold) return;
    setCancellingHold(true);
    setHoldError(undefined);
    try {
      await cancelHold(hold.bookingId, session);
      setHold(undefined);
      setLocalDeposit(undefined);
      setLocalNotice(undefined);
      setHoldEndedWhileIdle(false);
      setHoldCancelled(true);
      engineRef.current = {};
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized();
        return;
      }
      if (error instanceof ApiError && error.code === "HOLD_EXPIRED") {
        setHold(undefined);
        setLocalDeposit(undefined);
        setHoldEndedWhileIdle(true);
        engineRef.current = {};
        setHoldError({ message: "This hold has expired. The slot may already be taken again." });
        return;
      }
      setHoldError({
        message: error instanceof ApiError && error.message ? error.message : "Connection dropped. Your deposit is untouched.",
      });
    } finally {
      setCancellingHold(false);
    }
  }

  function describeError(error: unknown): { fatal: boolean; message: string } {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        return { fatal: true, message: "unauthorized" };
      }
      if (error.code === "HOLD_EXPIRED") {
        return { fatal: true, message: "This hold has expired. The slot may already be taken again." };
      }
      if (error.code === "SHORT_DEPOSIT") {
        const details = error.details as { receivedAmount?: string; requiredAmount?: string; asset?: string } | undefined;
        if (details?.receivedAmount && details?.requiredAmount && details?.asset) {
          const received = formatMoney(details.receivedAmount, details.asset);
          const required = formatMoney(details.requiredAmount, details.asset);
          return {
            fatal: true,
            message: `The anchor transfer credited ${received} but this booking requires ${required}. The hold remains — you can retry once you've topped up.`,
          };
        }
        return { fatal: true, message: error.message || "The anchor transfer did not credit enough." };
      }
      return { fatal: true, message: error.message || "Connection dropped. Your deposit is untouched." };
    }
    return { fatal: true, message: "Connection dropped. Your deposit is untouched." };
  }

  function handleFlowError(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) {
      handleUnauthorized();
      return;
    }
    // Issue #6: this booking's first deploy is already running on another
    // request -- that one wins, nothing was deployed here, and the client
    // waiting a moment is the whole answer. Not a failure to warn about.
    if (error instanceof ApiError && error.code === "DEPLOY_IN_FLIGHT") {
      setPhase("idle");
      setFlowNotice(error.message);
      return;
    }
    // Issue #5: the fund transaction built for this booking's stored
    // contract id has already settled, so the deposit is in and a second one
    // is never built. What is left is waiting for the confirmation -- the
    // same poll any other submit ends on, never a claim of `locked` here.
    if (error instanceof ApiError && error.code === "DEPOSIT_LANDED") {
      setPendingSignature(undefined);
      setPhase("reconciling");
      return;
    }
    const described = describeError(error);
    if (error instanceof ApiError && error.code === ESCROW_UNAVAILABLE_CODE) {
      setEscrowUnavailable(true);
    }
    setFlowFatalError(described.message);
    if (error instanceof ApiError && error.code === "HOLD_EXPIRED") {
      setHold(undefined);
      engineRef.current = {};
      setPhase("idle");
      return;
    }
    if (error instanceof ApiError && error.code === "SLOT_IN_PAST") {
      setHold(undefined);
      engineRef.current = {};
      setPhase("idle");
      return;
    }
    // Fall back to whatever step is still resumable: once a deploy is
    // confirmed submitted, stay there (fund can be retried); otherwise go
    // back to idle so "Lock with Pactly" starts clean.
    setPhase(engineRef.current.deploySubmittedAtMs ? "deployed" : "idle");
  }

  function confirmLockWallet(): void {
    if (!lockWalletConfirm || !session) return;
    const currentSession = getSession();
    if (
      signingAddressMismatch(lockWalletConfirm.address, session.walletAddress)
      || signingAddressMismatch(lockWalletConfirm.address, currentSession?.walletAddress)
    ) {
      setLockWalletConfirm(undefined);
      setFlowFatalError("The signing wallet changed. Refresh and try again.");
      return;
    }
    if (lockWalletConfirm.kind === "retry") {
      setLockWalletConfirm(undefined);
      void retryPendingSignature();
      return;
    }
    const rebuild = lockWalletConfirm.rebuild;
    setLockWalletConfirm(undefined);
    void runLockFlow({ rebuild });
  }

  /** The main flow: lock (build or reuse a deploy) -> sign -> submit ->
   * fund -> sign -> submit -> reconcile. `rebuild` is only ever passed
   * explicitly, from the "Try again" action after a failed deploy submit. */
  async function runLockFlow(options: { rebuild?: boolean } = {}): Promise<void> {
    if (!hold || !session) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setFlowNotice(undefined);
    setFlowFatalError(undefined);
    setEscrowUnavailable(false);
    try {
      if (!engineRef.current.deploySubmittedAtMs) {
        setPhase("building-deploy");
        const lockResult = await lockDeposit(hold.bookingId, session, options.rebuild ?? false);
        engineRef.current.contractId = lockResult.contractId;
        // Nothing is signed until the client has seen which escrow it is.
        setEscrowConfirmation(
          lockResult.deployed
            ? { contractId: lockResult.contractId }
            : { contractId: lockResult.contractId, unsignedXdr: lockResult.unsignedXdr },
        );
        setPhase("confirming-escrow");
        return;
      }

      await runFundStep();
    } catch (error) {
      handleFlowError(error);
    } finally {
      inFlightRef.current = false;
    }
  }

  /** The client confirmed the escrow shown: sign and submit its deploy (or,
   * when the deploy was already submitted earlier, go straight to funding). */
  async function confirmEscrow(): Promise<void> {
    const pending = escrowConfirmation;
    if (!pending || !hold || !session) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setEscrowConfirmation(undefined);
    try {
      if (!pending.unsignedXdr) {
        // A deploy was already confirmed submitted in an earlier session
        // (e.g. a reload) -- there is no local submission timestamp to
        // reuse, so treat "now" as the start of the fund-retry window.
        engineRef.current.deploySubmittedAtMs = Date.now();
      } else {
        setPendingSignature({ xdr: pending.unsignedXdr, kind: "deploy" });
        setPhase("awaiting-deploy-signature");
        let signedXdr: string;
        try {
          signedXdr = await signXdr(pending.unsignedXdr, session.walletAddress);
        } catch {
          setPendingSignature(undefined);
          setPhase("idle");
          setFlowNotice(`That didn't go through. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
          return;
        }
        setPhase("submitting-deploy");
        try {
          await submitSignedTransaction(hold.bookingId, signedXdr, session);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            handleUnauthorized();
            return;
          }
          setPendingSignature(undefined);
          setPhase("deploy-failed");
          setFlowFatalError(
            error instanceof ApiError && error.message
              ? error.message
              : "Connection dropped. Your deposit is untouched.",
          );
          return;
        }
        engineRef.current.deploySubmittedAtMs = Date.now();
        setPendingSignature(undefined);
      }
      await runFundStep();
    } catch (error) {
      handleFlowError(error);
    } finally {
      inFlightRef.current = false;
    }
  }

  /** The client backed out before signing. Nothing was deployed or signed,
   * and the stored escrow is reused on the next try -- never a second one. */
  function cancelEscrowConfirmation(): void {
    setEscrowConfirmation(undefined);
    setPhase("idle");
    setFlowNotice("Nothing was signed. The same escrow is kept for this slot.");
  }

  async function runFundStep(): Promise<void> {
    if (!hold || !session || !engineRef.current.deploySubmittedAtMs) return;
    setPhase("building-fund");
    // Funding moves the deposit too -- a fresh assertion, never the
    // morning's session alone.
    let assertionToken: string;
    try {
      assertionToken = await assertMoneyAction(session);
    } catch (error) {
      if (error instanceof SignInCancelledError) {
        setPhase("deployed");
        setFlowNotice(
          `You didn't sign. Nothing changed -- the slot is still yours for ${formatCountdown(holdSecondsLeft)}.`,
        );
        return;
      }
      throw error;
    }
    const fundResult = await fundDepositWithRetry(
      hold.bookingId,
      session,
      engineRef.current.deploySubmittedAtMs,
      assertionToken,
    );
    setPendingSignature({ xdr: fundResult.unsignedXdr, kind: "fund" });
    setPhase("awaiting-fund-signature");
    let signedFundXdr: string;
    try {
      signedFundXdr = await signXdr(fundResult.unsignedXdr, session.walletAddress);
    } catch {
      setPendingSignature(undefined);
      setPhase("deployed");
      setFlowNotice(`That didn't go through. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
      return;
    }
    setPhase("submitting-fund");
    await submitSignedTransaction(hold.bookingId, signedFundXdr, session);
    setPendingSignature(undefined);
    setPhase("reconciling");
  }

  /** The lock button's "Try again": re-issues *only* the currently pending
   * signature request -- never restarts the whole lock/fund sequence (review
   * follow-up: the previous version's retry called the same
   * top-level flow function again, which could re-enter earlier steps). */
  async function retryPendingSignature(): Promise<void> {
    if (!pendingSignature || !session || !hold) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      let signed: string;
      try {
        signed = await signXdr(pendingSignature.xdr, session.walletAddress);
      } catch {
        setFlowNotice(`That didn't go through. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
        return;
      }
      if (pendingSignature.kind === "deploy") {
        setPhase("submitting-deploy");
        try {
          await submitSignedTransaction(hold.bookingId, signed, session);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            handleUnauthorized();
            return;
          }
          setPendingSignature(undefined);
          setPhase("deploy-failed");
          setFlowFatalError("Connection dropped. Your deposit is untouched.");
          return;
        }
        engineRef.current.deploySubmittedAtMs = Date.now();
        setPendingSignature(undefined);
        refreshBookingFacts();
        // Kept guarded (the `finally` below releases it) through the fund
        // step too -- releasing early here would open a window for a
        // concurrent call to re-enter while it is still running.
        await runFundStep();
        return;
      }
      setPhase("submitting-fund");
      await submitSignedTransaction(hold.bookingId, signed, session);
      setPendingSignature(undefined);
      setPhase("reconciling");
    } catch (error) {
      handleFlowError(error);
    } finally {
      inFlightRef.current = false;
    }
  }

  function tryAgainAfterFailedDeploy(): void {
    engineRef.current = {};
    if (session) setLockWalletConfirm({ kind: "flow", address: session.walletAddress, rebuild: true });
  }

  async function ensureAnchorAuth(activeSession: Session, bookingId: string): Promise<boolean> {
    const challenge = await requestAnchorChallenge(bookingId, activeSession);
    if (challenge.authenticated || !challenge.unsignedXdr) {
      return true;
    }
    let signed: string;
    try {
      signed = await signXdr(challenge.unsignedXdr, activeSession.walletAddress);
    } catch {
      setLocalNotice(`That didn't go through. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
      return false;
    }
    await verifyAnchorChallenge(bookingId, signed, activeSession);
    return true;
  }

  async function applyLocalDepositResponse(
    activeSession: Session,
    bookingId: string,
    result: Awaited<ReturnType<typeof openLocalDeposit>>,
  ): Promise<void> {
    if ("needsTrustline" in result && result.needsTrustline) {
      setLocalNotice("Getting your account ready");
      let signed: string;
      try {
        signed = await signXdr(result.unsignedXdr, activeSession.walletAddress);
      } catch {
        setLocalNotice(`That didn't go through. The slot is still yours for ${formatCountdown(holdSecondsLeft)}.`);
        return;
      }
      const opened = await submitLocalDepositTrustline(bookingId, signed, activeSession, depositQuote?.quote);
      if ("needsTrustline" in opened && opened.needsTrustline) {
        setLocalNotice("Getting your account ready did not finish. Try again.");
        return;
      }
      setLocalDeposit(opened);
      if (opened.holdExpiresAt) {
        setHold((current) => (current ? { ...current, holdExpiresAt: opened.holdExpiresAt ?? current.holdExpiresAt } : current));
      }
      return;
    }
    setLocalDeposit(result);
    if (result.holdExpiresAt) {
      setHold((current) => (current ? { ...current, holdExpiresAt: result.holdExpiresAt ?? current.holdExpiresAt } : current));
    }
  }

  /**
   * Before the client can start a deposit, make sure the price on screen is
   * still one the anchor would honour. A refresh never calls the hold
   * endpoint -- it is a plain `/quote` read -- so it cannot create or extend
   * a hold as a side effect.
   */
  async function ensureFreshQuote(): Promise<QuoteResponse | undefined> {
    if (!quoteAmount) return undefined;
    setQuoteBusy(true);
    const result = await freshQuote(depositQuote, (refresh) => getQuote(quoteAmount, refresh));
    setQuoteBusy(false);
    if (!result) {
      setQuoteError("That price is out of date and we couldn't refresh it. Try again before continuing.");
      return undefined;
    }
    if (result.refreshed) {
      setDepositQuote(rememberQuote(result.quote));
      setQuoteError(undefined);
    }
    return result.quote;
  }

  async function startLocalCurrency(): Promise<void> {
    if (!hold || !session) return;
    setLocalBusy(true);
    setLocalNotice(undefined);
    setHoldError(undefined);
    try {
      // A failed refresh blocks the deposit entirely -- no anchor call is
      // made with a figure the client was told was old.
      const quote = await ensureFreshQuote();
      if (!quote) return;
      const authed = await ensureAnchorAuth(session, hold.bookingId);
      if (!authed) return;
      const result = await openLocalDeposit(hold.bookingId, session, quote);
      await applyLocalDepositResponse(session, hold.bookingId, result);
    } catch (error) {
      const message = localDepositErrorMessage(error);
      if (message === "unauthorized") {
        handleUnauthorized();
        return;
      }
      if (error instanceof ApiError && error.code === "HOLD_EXPIRED") {
        setHold(undefined);
        setHoldError({ message });
        setPhase("idle");
        return;
      }
      setLocalNotice(message);
    } finally {
      setLocalBusy(false);
    }
  }

  async function handleSimulate(): Promise<void> {
    if (!hold || !session) return;
    setLocalBusy(true);
    setLocalNotice(undefined);
    try {
      const result = await simulateLocalDeposit(hold.bookingId, session);
      setLocalDeposit(result);
      if (result.holdExpiresAt) {
        setHold((current) => (current ? { ...current, holdExpiresAt: result.holdExpiresAt ?? current.holdExpiresAt } : current));
      }
    } catch (error) {
      const message = localDepositErrorMessage(error);
      if (message === "unauthorized") {
        handleUnauthorized();
        return;
      }
      setLocalNotice(message);
    } finally {
      setLocalBusy(false);
    }
  }

  async function handleReschedule(newStartsAt: number): Promise<void> {
    if (!hold || !session) return;
    setRescheduleBusy(true);
    setRescheduleError(undefined);
    setRescheduleNotice(undefined);
    try {
      const moved = await rescheduleBooking(hold.bookingId, newStartsAt, session);
      const nowSeconds = Math.floor(Date.now() / 1000);
      // Keep the local hold in sync with the moved booking: same deposit and
      // contract, only the appointment and its cancellation deadline change.
      setHold((current) =>
        current
          ? {
              ...current,
              cancelDeadline: moved.cancelDeadline,
              holdExpiresAt: moved.holdExpiresAt ?? current.holdExpiresAt,
              deposit: moved.deposit,
              balance: moved.balance,
              price: moved.price,
              provider: moved.provider,
              freeCancellationEnded: moved.cancelDeadline <= nowSeconds ? true : undefined,
            }
          : current,
      );
      setRescheduleNotice(
        `Moved to ${formatDeadline(newStartsAt)}. Your deposit stayed in the same escrow — no new contract.`,
      );
      // The page reads its appointment time from the URL, so move it there;
      // the same booking (and its escrow) is then shown at the new slot.
      navigate(`/book/${providerId}?slot=${newStartsAt}`, { replace: true });
      void booking.refetch();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        handleUnauthorized();
        return;
      }
      setRescheduleError(error instanceof ApiError ? error.message : "Connection dropped. Nothing changed.");
    } finally {
      setRescheduleBusy(false);
    }
  }

  const localReceived = localDeposit?.status === "received";
  // "Lock with Pactly" only ever appears once the bank transfer is in.
  const showLock = Boolean(hold) && localReceived;
  const insideFreeWindow = booking.data !== undefined && Math.floor(Date.now() / 1000) < booking.data.cancelDeadline;
  const rescheduleOptions = profile?.slots.filter((startsAt) => startsAt !== slotStartsAt).slice(0, 6) ?? [];

  if (!providerId || slotStartsAt === undefined) {
    return (
      <div className="page">
        <div className="banner banner--alert">
          <p>No slot was selected. Go back and pick one.</p>
        </div>
      </div>
    );
  }

  if (profileLoading) {
    return (
      <div className="page">
        <p>Loading this booking…</p>
      </div>
    );
  }

  if (profileError) {
    const notFound = profileError instanceof ApiError && profileError.code === "PROVIDER_NOT_FOUND";
    return (
      <div className="page">
        <div className="banner banner--alert">
          <p>{notFound ? "This provider isn't available." : "Connection dropped. Try again."}</p>
        </div>
        <p>
          <Link to="/discover">Back to Discover</Link>
        </p>
      </div>
    );
  }

  if (!profile) {
    return null;
  }

  const cancelDeadline = hold?.cancelDeadline ?? slotStartsAt - profile.cancellationWindowHours * 3600;
  // Free-cancel openness follows the hold payload's serverTime +
  // cancelDeadline (and the server's own freeCancellationEnded flag),
  // never the browser clock alone.
  const freeCancellationEnded = hold
    ? hold.freeCancellationEnded === true || hold.cancelDeadline <= hold.serverTime
    : false;
  const depositAmount = hold?.deposit.amount ?? profile.deposit.amount;
  const balanceAmount = hold?.balance.amount;
  const waitingOn =
    phase === "awaiting-deploy-signature" ? "Create your escrow" : phase === "awaiting-fund-signature" ? "Lock your deposit" : undefined;
  const busy = phase !== "idle" && phase !== "deployed" && phase !== "deploy-failed";
  // Issue #6: "the button disables itself for the whole in-flight request"
  // -- every lock step's own button, including the two "Try again" buttons
  // that stand in for it, stays disabled from the tap until the request it
  // started has settled.
  const lockInFlight = busy || waitingOn !== undefined;
  // Issue #5: with a deploy already confirmed, the action left is funding
  // the escrow that exists -- say that on the button instead of offering a
  // second deploy.
  const actionLabel = phase === "deployed" ? "Continue funding" : undefined;
  const depositFacts = booking.data ?? bookingFacts;

  return (
    <div className="page booking-page">
      {lockWalletConfirm && (
        <WalletAddressConfirm
          address={lockWalletConfirm.address}
          confirmLabel={lockWalletConfirm.kind === "retry" ? "Confirm and continue signing" : "Confirm and lock"}
          busy={busy}
          onConfirm={confirmLockWallet}
          onCancel={() => setLockWalletConfirm(undefined)}
        />
      )}
      <div className={`booking-lanes${isLocked ? " booking-lanes--sealed" : ""}`}>
        <section className="booking-lane booking-lane--client">
          <h2 className="booking-lane__heading">YOUR SIDE</h2>
          <p className="booking-lane__appointment">
            {formatSlotWithZone(slotStartsAt, profile.timezone)}
          </p>
          <p className="booking-lane__meta">
            {SESSION_FORMAT_LABEL[profile.sessionFormat] ?? profile.sessionFormat} · {profile.sessionLengthMinutes} min
          </p>

          <div className="booking-summary">
            <div className="booking-summary__row">
              <span>Price</span>
              <strong>
                <TryAmount amount={hold?.price.amount ?? profile.price.amount} />
              </strong>
            </div>
            <div className="booking-summary__row">
              <span>Deposit, locked now</span>
              <strong>
                <TryAmount amount={depositAmount} />
              </strong>
            </div>
            {depositQuote && (
              <div className="booking-summary__row quote-equivalent">
                <span>Indicative equivalent</span>
                <strong>
                  {formatFiatAmount(depositQuote.quote.fiat.amount)} {depositQuote.quote.fiat.currency}
                  {displayedQuoteIsStale(depositQuote) ? " · price is old" : " · indicative"}
                </strong>
              </div>
            )}
            {quoteError && (
              <p ref={quoteErrorRef} className="banner banner--alert" role="alert" tabIndex={-1} style={{ marginTop: "var(--space-3)" }}>
                {quoteError}
              </p>
            )}
            {balanceAmount && (
              <div className="booking-summary__row">
                <span>Balance, due before the session</span>
                <strong>
                  <TryAmount amount={balanceAmount} />
                </strong>
              </div>
            )}
            <div className="booking-summary__row">
              <span>Free cancellation until</span>
              <strong>{freeCancellationEnded ? "already passed" : formatDeadline(cancelDeadline)}</strong>
            </div>
            {hold && !isLocked && (
              <div className="booking-summary__row">
                <span>Dispute note</span>
                <textarea
                  className="textarea"
                  placeholder="Add a note about this dispute (max 500 chars, spaces trimmed)"
                  value={disputeNote}
                  onChange={(e) => setDisputeNote(e.target.value)}
                  maxLength={500}
                  disabled={lockInFlight}
                />
                <span className="char-counter">{disputeNoteLength}/500</span>
              </div>
            )}
          </div>

          <div className="booking-summary-note">
            <b>YOUR PROTECTION</b>
            <p>
              {freeCancellationEnded
                ? "The free-cancellation window has ended for this appointment. A cancellation from here goes through resolution under the booking policy."
                : `Your booking policy says cancelling before ${formatDeadline(cancelDeadline)} returns all ${formatTryAmount(depositAmount)} through resolution.`}{" "}
              You (as approver) or the provider may sign the supported resolution; Pactly resolves a dispute only after one is opened on
              chain.
            </p>
          </div>

          {needsSignIn && (
            <div className="banner banner--alert" role="alert">
              <p>Your session ended. Sign in again to continue.</p>
            </div>
          )}

          {holdError && (
            <div className="banner banner--alert" role="alert">
              <p>{holdError.message}</p>
              {holdError.message.includes("My bookings") && (
                <p style={{ marginTop: "var(--space-3)" }}>
                  <Link to="/me/bookings">Open My bookings</Link>
                </p>
              )}
              {holdError.sameDaySlots && holdError.sameDaySlots.length > 0 && (
                <div className="slot-day__chips" style={{ marginTop: "var(--space-3)" }}>
                  {holdError.sameDaySlots.map((startsAt) => (
                    <Link key={startsAt} to={`/book/${providerId}?slot=${startsAt}`} className="slot-chip tabular-nums">
                      {formatSlotWithZone(startsAt, profile.timezone)}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}

          {!hold && (
            <div className="booking-pay">
              <p className="booking-step">Step 1 · Hold the slot</p>
              {holdEndedWhileIdle && (
                <div className="banner" role="status">
                  <p>Your hold ended. Hold this slot again.</p>
                </div>
              )}
              {holdCancelled && (
                <div className="banner" role="status">
                  <p>Hold cancelled. The slot is free again.</p>
                </div>
              )}
              <div className="field">
                <label htmlFor="booking-client-email">Email for the shop (optional)</label>
                <input
                  id="booking-client-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={clientEmail}
                  onChange={(event) => setClientEmail(event.target.value)}
                />
              </div>
              <div className="field" style={{ marginTop: "var(--space-4)" }}>
                <label htmlFor="booking-client-email">Client email (optional)</label>
                <input
                  id="booking-client-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={clientEmail}
                  onChange={(event) => setClientEmail(event.target.value)}
                />
              </div>
              <div className="field" style={{ marginTop: "var(--space-4)" }}>
                <label htmlFor="booking-intake-questions">Intake questions</label>
                {profile.intakeQuestions && profile.intakeQuestions.length > 0 ? (
                  <div>
                    {profile.intakeQuestions.map((question, i) => (
                      <div key={question.id} style={{ marginBottom: "var(--space-2)", display: "flex", alignItems: "center" }}>
                        <span style={{ width: "120px" }}>{question.text}</span>
                        <input
                          type="text"
                          value={intakeAnswers[question.id] || ""}
                          onChange={(event) => setIntakeAnswers({...intakeAnswers, [question.id]: event.target.value})}
                          disabled={question.isRequired}
                          style={{ marginLeft: "var(--space-2)", flex: 1 }}
                        />
                        {question.isRequired && !intakeAnswers[question.id] && (
                          <span style={{ color: "var(--error)", fontSize: "var(--text-12)" }}>* Required</span>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p>No intake questions for this provider.</p>
                )}
              </div>
              <button type="button" className="button-primary" onClick={ensureSessionAndHold} disabled={connecting || holdMutation.isPending} aria-label={session ? "Hold this slot" : "Sign in and hold this slot"}>
                {connecting ? "Signing you in…" : holdMutation.isPending ? "Holding your slot…" : session ? "Hold this slot" : "Sign in and hold this slot"}
              </button>
            </div>
            )}

          {hold && !isLocked && (
            <div className="booking-pay">
              <p className="booking-step">Step 1 · Slot held{holdSecondsLeft !== undefined ? ` · ${formatCountdown(holdSecondsLeft)} left` : ""}</p>
              <p className="booking-step">Step 2 · Pay the deposit by bank transfer</p>
              <p className="local-deposit__how">
                Send the deposit in {currencyUnavailable ? "your anchor currency" : anchorCurrency} to the bank details below. Trustless Work holds it in escrow — not Pactly, not the provider.
              </p>

              <div className="booking-pay__action">
                {!localDeposit && (
                  <button
                    type="button"
                    className="button-primary"
                    onClick={() => void startLocalCurrency()}
                    disabled={localBusy || quoteBusy}
                    aria-label="Get bank details"
                  >
                    {quoteBusy ? "Refreshing the price…" : localBusy ? "Opening the transfer…" : "Get bank details"}
                  </button>
                )}
                {localDeposit && (
                  <LocalCurrencyPanel
                    deposit={localDeposit}
                    amount={depositAmount}
                    busy={localBusy}
                    onSimulate={() => void handleSimulate()}
                    onRetry={() => void retryFailedDeposit()}
                  />
                )}
                {localReceived && (
                  <>
                    <p className="booking-step">Step 3 · Lock the deposit</p>
                    {phase === "deploy-failed" ? (
                      <button type="button" className="button-primary" onClick={tryAgainAfterFailedDeploy} aria-label="Try again">
                        Try again
                      </button>
                    ) : phase === "confirming-escrow" ? (
                      <p className="escrow-lane__notice">Check the escrow ID, then confirm to sign.</p>
                    ) : (
                      <LockButton
                        waitingOn={waitingOn}
                        actionLabel={actionLabel}
                        disabled={lockInFlight}
                        onClick={() => void runLockFlow()}
                        onOpenWalletAgain={() => void retryPendingSignature()}
                      />
                    )}
                  </>
                )}
                {localNotice && (
                  <p className="escrow-lane__notice" aria-live="polite">
                    {localNotice}
                  </p>
                )}
                {canCancelHold && (
                  <button type="button" className="button-ghost" onClick={() => void handleCancelHold()} disabled={cancellingHold}>
                    {cancellingHold ? "Cancelling the hold…" : "Cancel this hold"}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        {booking.data?.anchorTransactionId && (
          <p className="escrow-lane__notice" style={{ overflowWrap: "anywhere" }}>
            Bank transfer reference:{" "}
            <span className="tabular-nums" style={{ userSelect: "all" }}>{booking.data.anchorTransactionId}</span>
          </p>
        )}

        <EscrowLane
          depositAmount={depositAmount}
          holdCountdownLabel={hold && !isLocked ? formatCountdown(holdSecondsLeft) : undefined}
          contractId={engineRef.current.contractId}
          showProof={isLocked}
          stateLabel={!hold ? "Hold the slot to pay" : escrowStateLabel(phase)}
          stateDetail={escrowStateDetail(phase)}
          contractHistory={depositFacts?.contractHistory}
        >
          {showLock && !isLocked && phase === "confirming-escrow" && escrowConfirmation && (
            <EscrowConfirmation
              contractId={escrowConfirmation.contractId}
              onConfirm={() => void confirmEscrow()}
              onCancel={cancelEscrowConfirmation}
            />
          )}
          {showLock && !isLocked && phase !== "confirming-escrow" && (
            <>
              {phase === "deploy-failed" ? (
                <button type="button" className="button-escrow" onClick={tryAgainAfterFailedDeploy} aria-label="Try again">
                  Try again
                </button>
              ) : (
                <LockButton
                  waitingOn={waitingOn}
                  actionLabel={actionLabel}
                  disabled={lockInFlight}
                  onClick={() => void runLockFlow()}
                  onOpenWalletAgain={() => void retryPendingSignature()}
                />
              )}
              {phase === "reconciling-slow" && (
                <p className="escrow-lane__notice" aria-live="polite">
                  This is taking longer than usual. Your deposit is safe; check My bookings shortly.
                </p>
              )}
              {flowNotice && (
                <p className="escrow-lane__notice" aria-live="polite">
                  {flowNotice}
                </p>
              )}
              {escrowUnavailable && <EscrowConfirmation unavailableMessage={flowFatalError} />}
              {flowFatalError && !escrowUnavailable && (
                <p className="escrow-lane__notice escrow-lane__notice--alert" role="alert">
                  {flowFatalError}
                </p>
              )}
            </>
          )}
          {isLocked && (
            <div className={`seal-wrap${prefersReducedMotion ? "" : " seal-wrap--animated"}`}>
              <Seal />
              <p className="seal-wrap__title">You're set.</p>
              <p className="seal-wrap__subtitle">Your deposit is held in escrow by Trustless Work.</p>
              {insideFreeWindow && rescheduleOptions.length > 0 && (
                <div style={{ marginTop: "var(--space-4)" }}>
                  <p className="seal-wrap__subtitle">
                    Picked the wrong hour? Move this booking to another open time. Your deposit and contract stay exactly
                    where they are.
                  </p>
                  <div className="slot-day__chips">
                    {rescheduleOptions.map((startsAt) => (
                      <button
                        key={startsAt}
                        type="button"
                        className="slot-chip tabular-nums"
                        disabled={rescheduleBusy}
                        onClick={() => void handleReschedule(startsAt)}
                      >
                        {formatSlotDay(startsAt)} · {formatSlotTime(startsAt)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {rescheduleNotice && (
                <p className="escrow-lane__notice" role="status">
                  {rescheduleNotice}
                </p>
              )}
              {rescheduleError && (
                <p className="escrow-lane__notice escrow-lane__notice--alert" role="alert">
                  {rescheduleError}
                </p>
              )}
              <Link to="/discover" className="button-ghost" style={{ marginTop: "var(--space-2)", textDecoration: "none" }}>
                Back to Discover
              </Link>
            </div>
          )}
        </EscrowLane>

        <section className="booking-lane booking-lane--provider">
          <ProviderHeader
            displayName={hold?.provider.displayName ?? profile.displayName}
            title={hold?.provider.title ?? profile.title}
            location={profile.location}
            categoryName={profile.category.name}
            isApproved={profile.isApproved}
            verifiedSessionCount={profile.verifiedSessionCount}
            providerCancellationCount={profile.providerCancellationCount}
            photoSrc={providerPhotoSrc(profile.id)}
            compact
          />
          <div style={{ marginTop: "var(--space-4)" }}>
            <DepositPill
              amount={depositAmount}
              cancellationWindowHours={profile.cancellationWindowHours}
              freeCancellationEnded={freeCancellationEnded || undefined}
            />
          </div>
          <div className="booking-summary-note booking-summary-note--pro">
            <b>THE PROVIDER'S PROTECTION</b>
            <p>
              A late cancellation or no-show enters resolution under the same booking policy. Neither side can move the deposit
              alone -- the release signer, approver and, for a dispute, Pactly as resolver each sign their own role.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function formatCountdown(secondsLeft: number | undefined): string {
  if (secondsLeft === undefined) return "—";
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function escrowStateLabel(phase: DisplayPhase): string {
  switch (phase) {
    case "idle":
      return "Not locked yet";
    case "building-deploy":
      return "Creating your escrow…";
    case "confirming-escrow":
      return "Confirm your escrow";
    case "awaiting-deploy-signature":
      return "Waiting for your signature";
    case "submitting-deploy":
      return "Locking with Pactly…";
    case "deploy-failed":
      return "Your escrow could not be created";
    case "deployed":
      return "Escrow created";
    case "building-fund":
      return "Locking with Pactly…";
    case "awaiting-fund-signature":
      return "Waiting for your signature";
    case "submitting-fund":
      return "Locking with Pactly…";
    case "reconciling":
    case "reconciling-slow":
      return "Locking with Pactly…";
    case "locked":
      return "Locked";
  }
}

/** Issue #5: the other half of the `deployed` state gets its own line
 * rather than being folded into the label with a separator -- "an escrow
 * was created" and "your deposit is not in it yet" are two facts the
 * client reads separately, and only the second one is what the button
 * below is about. Every other phase has one fact, so it has no detail. */
function escrowStateDetail(phase: DisplayPhase): string | undefined {
  return phase === "deployed" ? "Your deposit is not in it yet." : undefined;
}

/** Issue #133: set the browser title to include the shop name and booking status */
useEffect(() => {
  const shopName = hold?.provider.displayName ?? profile.displayName ?? "Pactly";
  let statusWord = "";
  switch (phase) {
    case "idle":
      statusWord = "Hold the slot";
      break;
    case "building-deploy":
      statusWord = "Building deploy";
      break;
    case "confirming-escrow":
      statusWord = "Awaiting confirmation";
      break;
    case "awaiting-deploy-signature":
      statusWord = "Create your escrow";
      break;
    case "submitting-deploy":
      statusWord = "Deploying";
      break;
    case "deploy-failed":
      statusWord = "Deploy failed";
      break;
    case "deployed":
      statusWord = "Deployed";
      break;
    case "building-fund":
      statusWord = "Building fund";
      break;
    case "awaiting-fund-signature":
      statusWord = "Lock your deposit";
      break;
    case "submitting-fund":
      statusWord = "Funding";
      break;
    case "reconciling":
      statusWord = "Reconciling";
      break;
    default:
      statusWord = "Pactly";
  }
  if (hold) {
    document.title = `${shopName} - ${statusWord}`;
  } else {
    document.title = "Pactly";
  }
}, [hold, phase, shopName]);
