import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { BankIcon, StorefrontIcon } from "@phosphor-icons/react";

import { ApiError } from "../../api/client";
import {
  getCashOut,
  requestCashOutAnchorChallenge,
  startCashOut,
  submitCashOut,
  useCashOutBalance,
  useCashOuts,
  verifyCashOutAnchorChallenge,
} from "../../api/hooks";
import type { CashOutView } from "../../api/types";
import { PageMasthead } from "../../components/PageMasthead";
import { SignInPanel } from "../../components/SignInPanel";
import { formatMoney, parseDecimalToSmallestUnit } from "../../lib/money";
import { formatSlotDay, formatSlotTime } from "../../lib/time";
import { getSession, signOut, signXdr, type Session } from "../../wallet";

/** Plain words only -- never SEP vocabulary, "trustline", XDR or a raw
 * anchor body (issue #1). */
function cashOutErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "AMOUNT_OUT_OF_RANGE") {
      const details = error.details as { min?: string; max?: string; currency?: string } | undefined;
      const currency = details?.currency ?? "TRY";
      if (details?.min && details?.max) {
        return `The bank can take between ${details.min} and ${details.max} ${currency} at a time.`;
      }
      return `That amount is outside what the bank can take at a time (${currency}).`;
    }
    if (error.code === "INSUFFICIENT_BALANCE") {
      return "That's more than your wallet holds right now.";
    }
    if (error.code === "NOT_A_PROVIDER") {
      return "This account doesn't have a provider profile yet.";
    }
    if (error.code === "ANCHOR_UNAVAILABLE" || error.code === "QUOTE_UNAVAILABLE" || error.code === "PAYMENT_UNAVAILABLE") {
      return "We couldn't reach the bank just now. Nothing has moved. Try again in a moment.";
    }
    if (error.code === "PAYMENT_FAILED") {
      return "The payment wasn't accepted. Nothing has left your wallet.";
    }
    if (error.code === "CASH_OUT_NOT_FOUND") {
      return "That cash-out could not be found.";
    }
    return error.message;
  }
  return error instanceof Error ? error.message : "Connection dropped. Nothing has moved.";
}

export function CashOutPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; alert?: boolean } | undefined>();

  const balanceQuery = useCashOutBalance(session);
  const cashOutsQuery = useCashOuts(session);

  function handleSignOut(): void {
    signOut();
    setSession(undefined);
  }

  const cashOuts = cashOutsQuery.data?.cashOuts ?? [];
  const pendingKey = cashOuts
    .filter((cashOut) => cashOut.status === "sent" || cashOut.status === "waiting")
    .map((cashOut) => cashOut.id)
    .join(",");

  // "Sent" is not the end: the bank still has to pay out. Poll only the
  // cash-outs that can still move, and stop as soon as they are settled.
  useEffect(() => {
    if (!session || !pendingKey) return;
    const ids = pendingKey.split(",");
    const interval = setInterval(() => {
      void Promise.all(ids.map((id) => getCashOut(id, session).catch(() => undefined))).then(() => {
        void cashOutsQuery.refetch();
      });
    }, 4000);
    return () => clearInterval(interval);
    // `pendingKey` is the stable summary; the query object itself changes
    // identity every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingKey, session]);

  const balance = balanceQuery.data;
  const balanceUnits = useMemo(() => BigInt(balance?.balance ?? "0"), [balance?.balance]);
  const limits = balance?.limits;

  async function ensureAnchorAuth(activeSession: Session): Promise<boolean> {
    const challenge = await requestCashOutAnchorChallenge(activeSession);
    if (challenge.authenticated || !challenge.unsignedXdr) {
      return true;
    }
    let signed: string;
    try {
      signed = await signXdr(challenge.unsignedXdr, activeSession.walletAddress);
    } catch {
      setNotice({ text: "Signing was cancelled. Nothing has moved.", alert: true });
      return false;
    }
    await verifyCashOutAnchorChallenge(signed, activeSession);
    return true;
  }

  async function handleStart(): Promise<void> {
    if (!session || busy) return;
    const smallest = parseDecimalToSmallestUnit(amount);
    if (!smallest || BigInt(smallest) <= 0n) {
      setNotice({ text: "Enter the amount you'd like to cash out.", alert: true });
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const authenticated = await ensureAnchorAuth(session);
      if (!authenticated) return;
      const started = await startCashOut(smallest, session);
      let signed: string;
      try {
        signed = await signXdr(started.unsignedXdr, session.walletAddress);
      } catch {
        setNotice({
          text: "Signing was cancelled. Your cash-out is saved -- you can finish it from the list below.",
          alert: true,
        });
        await cashOutsQuery.refetch();
        return;
      }
      const view = await submitCashOut(started.cashOutId, signed, session);
      setNotice({ text: "Sent. Waiting for the bank to finish your payout.", alert: false });
      setAmount("");
      await Promise.all([cashOutsQuery.refetch(), balanceQuery.refetch()]);
      if (view.status === "paid_out") {
        setNotice({ text: "Paid out.", alert: false });
      }
    } catch (error) {
      setNotice({ text: cashOutErrorMessage(error), alert: true });
    } finally {
      setBusy(false);
    }
  }

  if (!session) {
    return (
      <div className="page">
        <PageMasthead
          eyebrow="Provider panel"
          icon={<StorefrontIcon size={14} weight="bold" aria-hidden="true" />}
          title="Cash out"
          lede="Sign in to move your released money to your bank."
        />
        <SignInPanel onSignedIn={setSession} onRateLimited={(waitMs) => setError(`Too many failed sign-in attempts. Please wait ${Math.ceil(waitMs / 1000)} second${Math.ceil(waitMs / 1000) !== 1 ? "s" : ""} before trying again.`)} />
      </div>
    );
  }

  const notAProvider = balanceQuery.error instanceof ApiError && balanceQuery.error.code === "NOT_A_PROVIDER";

  return (
    <div className="page">
      <PageMasthead
        eyebrow="Provider panel"
        icon={<BankIcon size={14} weight="bold" aria-hidden="true" />}
        title="Cash out"
        actions={
          <>
            <Link to="/panel/bookings">Bookings</Link>
            <Link to="/panel/availability">Availability &amp; rules</Link>
            <button type="button" className="button-ghost" onClick={handleSignOut}>
              Sign out
            </button>
          </>
        }
      />

      {balanceQuery.isLoading && <p>Loading your balance…</p>}

      {notAProvider && (
        <div className="banner" role="status">
          <p>This account doesn't have a provider profile yet.</p>
          <Link to="/providers/apply" className="button-primary" style={{ textDecoration: "none" }}>
            List your shop
          </Link>
        </div>
      )}

      {balanceQuery.isError && !notAProvider && (
        <div className="banner banner--alert">
          <p>Connection dropped. Your money is untouched.</p>
          <button type="button" className="button-ghost" onClick={() => balanceQuery.refetch()}>
            Try again
          </button>
        </div>
      )}

      {balance && (
        <section className="card">
          <h2 style={{ fontSize: "var(--text-18)" }}>Available to cash out</h2>
          <p style={{ fontSize: "var(--text-24)", fontWeight: 600 }}>{formatMoney(balance.balance, balance.asset)}</p>
          {!balance.hasTrustline ? (
            <p className="banner">
              Your wallet isn't ready to receive USDC from the bank yet. Once it is, your cash-out will appear here.
            </p>
          ) : balanceUnits === 0n ? (
            <p className="banner">Nothing to cash out yet.</p>
          ) : (
            <>
              {limits && (limits.min || limits.max) && (
                <p>
                  You can cash out
                  {limits.min ? ` from ${limits.min}` : ""}
                  {limits.max ? ` up to ${limits.max}` : ""} {limits.currency ?? "TRY"} at a time.
                </p>
              )}
              <label className="field">
                <span>Amount in USDC</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  placeholder="e.g. 25"
                  onChange={(event) => setAmount(event.target.value)}
                  disabled={busy}
                />
              </label>
              <button type="button" className="button-primary" onClick={() => void handleStart()} disabled={busy}>
                {busy ? "Sending…" : "Cash out to your bank"}
              </button>
            </>
          )}

          {notice && (
            <p className={`banner${notice.alert ? " banner--alert" : ""}`} role="status" aria-live="polite">
              {notice.text}
            </p>
          )}
        </section>
      )}

      <section className="card" style={{ marginTop: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-18)" }}>Your cash-outs</h2>
        {cashOutsQuery.isError ? (
          <div className="banner banner--alert">
            <p>Connection dropped. Your money is untouched.</p>
            <button type="button" className="button-ghost" onClick={() => cashOutsQuery.refetch()}>
              Try again
            </button>
          </div>
        ) : cashOuts.length === 0 ? (
          <p className="banner">No cash-outs yet.</p>
        ) : (
          <ul className="cash-out-list">
            {cashOuts.map((cashOut) => (
              <CashOutRow key={cashOut.id} cashOut={cashOut} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CashOutRow({ cashOut }: { cashOut: CashOutView }) {
  const when = `${formatSlotDay(cashOut.createdAt)} · ${formatSlotTime(cashOut.createdAt)}`;
  return (
    <li className="cash-out-list__item">
      <div>
        <p className="cash-out-list__amount">{formatMoney(cashOut.amount.amount, cashOut.amount.asset)}</p>
        <p className="cash-out-list__meta">
          {when} · {cashOut.fiat.amount} {cashOut.fiat.currency}
        </p>
      </div>
      <div>
        <p className="cash-out-list__status">{cashOut.statusLabel}</p>
        {cashOut.status === "failed" && cashOut.reason && (
          <p className="cash-out-list__reason">{cashOut.reason}</p>
        )}
        {cashOut.stale && <p className="cash-out-list__meta">Last known status -- we couldn't reach the bank just now.</p>}
        <p className="cash-out-list__meta">
          Reference: <span className="tabular-nums">{cashOut.anchorTransactionId}</span>
        </p>
        {cashOut.moreInfoUrl && (
          <a href={cashOut.moreInfoUrl} target="_blank" rel="noreferrer">
            More about this transfer
          </a>
        )}
      </div>
    </li>
  );
}
