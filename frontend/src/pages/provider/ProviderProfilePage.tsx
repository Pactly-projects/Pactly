import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import {
  joinWaitlist,
  saveShop,
  submitShopReport,
  unsaveShop,
  useIsShopSaved,
  usePublicProviderProfile,
} from "../../api/hooks";
import { ApiError } from "../../api/client";
import { DepositPill } from "../../components/DepositPill";
import { ProviderHeader } from "../../components/ProviderHeader";
import { SlotChip } from "../../components/SlotChip";
import { TryAmount } from "../../components/TryAmount";
import { providerPhotoSrc } from "../../lib/providerPhotos";
import { formatSessionFormat } from "../../lib/sessionFormat";
import { formatSlotDay, groupSlotsByDay } from "../../lib/time";
import { getSession, type Session } from "../../wallet";

/** `/providers/:id` -- a public profile, no sign-in required
 * (EXPERIENCE.md: "Discovery, search, profile viewing ... need no
 * sign-in"). No booking action lives here yet (Story 3.4's job) -- picking
 * a slot only ever highlights it locally. */
export function ProviderProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [session] = useState<Session | undefined>(() => getSession());
  const { data: profile, isLoading, error } = usePublicProviderProfile(id, session?.token);

  const { data: savedData, refetch: refetchSaved } = useIsShopSaved(id, session);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "unsaving">("idle");
  const [saveNotice, setSaveNotice] = useState<string | undefined>();
  const isSaved = savedData?.isSaved ?? false;

  const [showReportDialog, setShowReportDialog] = useState(false);
  const [reportReason, setReportReason] = useState("");
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportNotice, setReportNotice] = useState<{ text: string; isError: boolean } | undefined>();

  // Waitlist state
  const [showWaitlistDialog, setShowWaitlistDialog] = useState(false);
  const [waitlistDate, setWaitlistDate] = useState<string | undefined>();
  const [waitlistNote, setWaitlistNote] = useState("");
  const [waitlistSubmitting, setWaitlistSubmitting] = useState(false);
  const [waitlistNotice, setWaitlistNotice] = useState<{ text: string; isError: boolean } | undefined>();

  // `?slot=<epochSeconds>` pre-selects that slot when it matches an open
  // one; any other value (unknown, stale, malformed) is silently ignored
  // (the spec's own "Slot pre-selection" row).
  const requestedSlot = searchParams.get("slot");
  const selectedSlot = useMemo(() => {
    if (!requestedSlot || !profile) {
      return undefined;
    }
    const parsed = Number(requestedSlot);
    return profile.slots.includes(parsed) ? parsed : undefined;
  }, [requestedSlot, profile]);

  function selectSlot(startsAt: number): void {
    const next = new URLSearchParams(searchParams);
    next.set("slot", String(startsAt));
    setSearchParams(next, { replace: true });
  }

  async function handleSaveToggle(): Promise<void> {
    if (!session || !id) return;

    setSavingState(isSaved ? "unsaving" : "saving");
    setSaveNotice(undefined);

    try {
      if (isSaved) {
        await unsaveShop(id, session.token);
        setSaveNotice("Removed from saved shops");
      } else {
        await saveShop(id, session.token);
        setSaveNotice("Saved!");
      }
      await refetchSaved();
      setTimeout(() => setSaveNotice(undefined), 2000);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "SHOP_NOT_APPROVED") {
          setSaveNotice("This shop is not taking bookings");
        } else {
          setSaveNotice("Something went wrong");
        }
      } else {
        setSaveNotice("Connection dropped. Try again.");
      }
    } finally {
      setSavingState("idle");
    }
  }

  async function handleReportSubmit(): Promise<void> {
    if (!session || !id) return;
    
    setReportSubmitting(true);
    setReportNotice(undefined);
    
    try {
      await submitShopReport(id, reportReason, session);
      setReportNotice({ text: "Report submitted. Admins will review it.", isError: false });
      setReportReason("");
      setTimeout(() => {
        setShowReportDialog(false);
        setReportNotice(undefined);
      }, 2000);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "RATE_LIMIT") {
          setReportNotice({ text: "You've already reported this shop recently. Try again later.", isError: true });
        } else if (err.code === "INVALID_REASON") {
          setReportNotice({ text: "Report reason cannot be empty and must be 500 characters or less.", isError: true });
        } else if (err.code === "SHOP_NOT_FOUND") {
          setReportNotice({ text: "This shop is no longer available.", isError: true });
        } else {
          setReportNotice({ text: "Something went wrong. Try again.", isError: true });
        }
      } else {
        setReportNotice({ text: "Connection dropped. Try again.", isError: true });
      }
    } finally {
      setReportSubmitting(false);
    }
  }

  async function handleWaitlistSubmit(): Promise<void> {
    if (!session || !id || !waitlistDate) return;
    
    setWaitlistSubmitting(true);
    setWaitlistNotice(undefined);
    
    try {
      await joinWaitlist(id, waitlistDate, waitlistNote.trim() || undefined, session);
      setWaitlistNotice({ text: "You've been added to the waitlist. The shop will see your request.", isError: false });
      setWaitlistNote("");
      setTimeout(() => {
        setShowWaitlistDialog(false);
        setWaitlistNotice(undefined);
      }, 2000);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "ALREADY_WAITLISTED") {
          setWaitlistNotice({ text: "You're already on the waitlist for this date.", isError: true });
        } else if (err.code === "SLOTS_AVAILABLE") {
          setWaitlistNotice({ text: "This date now has open slots. Please book one instead.", isError: true });
        } else if (err.code === "INVALID_DATE") {
          setWaitlistNotice({ text: "Invalid date format.", isError: true });
        } else if (err.code === "INVALID_NOTE") {
          setWaitlistNotice({ text: "Note must be 300 characters or less.", isError: true });
        } else if (err.code === "PROVIDER_NOT_FOUND") {
          setWaitlistNotice({ text: "This shop is no longer available.", isError: true });
        } else {
          setWaitlistNotice({ text: "Something went wrong. Try again.", isError: true });
        }
      } else {
        setWaitlistNotice({ text: "Connection dropped. Try again.", isError: true });
      }
    } finally {
      setWaitlistSubmitting(false);
    }
  }

  function openWaitlistDialog(date: string): void {
    setWaitlistDate(date);
    setShowWaitlistDialog(true);
  }

  if (isLoading) {
    return (
      <div className="page">
        <p>Loading this provider…</p>
      </div>
    );
  }

  if (error) {
    const notFound = error instanceof ApiError && error.code === "PROVIDER_NOT_FOUND";
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

  // Issue #140: signed-in shop owner sees explanation page if suspended by admin
  if (profile.isSuspended) {
    return (
      <div className="page">
        <ProviderHeader
          displayName={profile.displayName}
          title={profile.title}
          location={profile.location}
          categoryName={profile.category.name}
          isApproved={profile.isApproved}
          verifiedSessionCount={profile.verifiedSessionCount}
          providerCancellationCount={profile.providerCancellationCount}
          photoSrc={providerPhotoSrc(profile.id)}
        />
        <div className="banner banner--alert" style={{ marginTop: "var(--space-6)" }}>
          <h2>This shop has been suspended by an administrator</h2>
          {profile.suspensionReason && (
            <p style={{ marginTop: "var(--space-2)" }}>Reason: {profile.suspensionReason}</p>
          )}
          <p style={{ marginTop: "var(--space-2)" }}>
            New bookings are disabled.
          </p>
          <p style={{ marginTop: "var(--space-4)" }}>
            <Link to="/me/provider">Manage your provider profile</Link>
          </p>
        </div>
      </div>
    );
  }

  const dayGroups = groupSlotsByDay(profile.slots);
  
  const canSave = session && profile.isApproved;
  const canReport = session && profile.isApproved;
  const canWaitlist = session && profile.isApproved && !profile.bookingsPaused;

  return (
    <div className="page">
      <ProviderHeader
        displayName={profile.displayName}
        title={profile.title}
        location={profile.location}
        categoryName={profile.category.name}
        isApproved={profile.isApproved}
        verifiedSessionCount={profile.verifiedSessionCount}
        providerCancellationCount={profile.providerCancellationCount}
        photoSrc={providerPhotoSrc(profile.id)}
      />

      {profile.bookingsPaused && (
        <div className="banner banner--notice" style={{ marginTop: "var(--space-4)" }}>
          <p>This shop has paused new bookings.</p>
        </div>
      )}

      {canSave && (
        <div style={{ marginTop: "var(--space-4)", display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <button
            type="button"
            className="button-secondary"
            onClick={handleSaveToggle}
            disabled={savingState !== "idle"}
            style={{ fontSize: "var(--text-14)" }}
          >
            {savingState === "saving" && "Saving..."}
            {savingState === "unsaving" && "Removing..."}
            {savingState === "idle" && (isSaved ? "★ Saved" : "☆ Save shop")}
          </button>
          {saveNotice && <span style={{ fontSize: "var(--text-14)", color: "var(--color-text-secondary)" }}>{saveNotice}</span>}
        </div>
      )}

      {canReport && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <button
            type="button"
            className="button-secondary"
            onClick={() => setShowReportDialog(true)}
            style={{ fontSize: "var(--text-14)" }}
          >
            Report this shop
          </button>
        </div>
      )}

      <div className="card" style={{ marginTop: "var(--space-6)" }}>
        {profile.bio && (
          <div style={{ marginBottom: "var(--space-5)" }}>
            <h2 style={{ fontSize: "var(--text-18)" }}>About this shop</h2>
            <p>{profile.bio}</p>
          </div>
        )}
        {profile.noticeText && (
          <div style={{ marginBottom: "var(--space-5)" }}>
            <p style={{ fontSize: "var(--text-14)", color: "var(--color-text-primary)" }}>{profile.noticeText}</p>
            {profile.noticeEndDate && (
              <p style={{ fontSize: "var(--text-12)", color: "var(--color-text-secondary)" }}>Expires: {new Date(profile.noticeEndDate * 1000).toLocaleDateString()}</p>
            )}
          </div>
        )}
        {profile.languages.length > 0 && (
          <p style={{ marginBottom: "var(--space-5)" }}>Languages: {profile.languages.join(", ")}</p>
        )}
        <div className="price-row">
          <TryAmount amount={profile.price.amount} className="price-row__amount" />
          <span className="price-row__meta">
            {formatSessionFormat(profile.sessionFormat)} · {profile.sessionLengthMinutes} min
          </span>
        </div>

        <div style={{ marginTop: "var(--space-4)" }}>
          <DepositPill
            amount={profile.deposit.amount}
            depositRateBps={profile.depositRateBps}
            cancellationWindowHours={profile.cancellationWindowHours}
          />
        </div>

        {!profile.bookingsPaused && (
          <div style={{ marginTop: "var(--space-6)" }}>
            <h2 style={{ fontSize: "var(--text-18)" }}>Upcoming slots · {profile.timezone}</h2>
            {dayGroups.length === 0 ? (
              <p className="banner">No open slots in the next 30 days. Check back soon.</p>
            ) : (
              dayGroups.map((group) => (
                <div className="slot-day" key={group.dayLabel}>
                  <div className="slot-day__label">{group.dayLabel}</div>
                  <div className="slot-day__chips">
                    {group.slots.map((startsAt) => (
                      <SlotChip
                        key={startsAt}
                        startsAt={startsAt}
                        selected={startsAt === selectedSlot}
                        onSelect={selectSlot}
                        timeZone={profile.timezone}
                      />
                    ))}
                    {group.slots.length === 0 && canWaitlist && (
                      <button
                        type="button"
                        className="button-secondary"
                        style={{ fontSize: "var(--text-14)" }}
                        onClick={() => openWaitlistDialog(group.dateISO)}
                      >
                        Join waitlist
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {!profile.bookingsPaused && selectedSlot !== undefined && (
          <div style={{ marginTop: "var(--space-6)" }}>
            <Link to={`/book/${profile.id}?slot=${selectedSlot}`} className="button-primary" style={{ textDecoration: "none" }}>
              Continue
            </Link>
          </div>
        )}
      </div>

      {showReportDialog && (
        <div className="modal-overlay" onClick={() => setShowReportDialog(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: "var(--space-4)" }}>Report this shop</h2>
            <p style={{ marginBottom: "var(--space-4)", color: "var(--color-text-secondary)" }}>
              Tell admins why this listing should be reviewed. This is not a dispute on a booking.
            </p>
            
            {reportNotice && (
              <div className={reportNotice.isError ? "banner banner--alert" : "banner"} style={{ marginBottom: "var(--space-4)" }}>
                <p>{reportNotice.text}</p>
              </div>
            )}
            
            <textarea
              value={reportReason}
              onChange={(e) => setReportReason(e.target.value)}
              placeholder="Describe the issue (max 500 characters)"
              maxLength={500}
              rows={5}
              style={{
                width: "100%",
                padding: "var(--space-3)",
                fontSize: "var(--text-16)",
                fontFamily: "inherit",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-2)",
                marginBottom: "var(--space-2)",
              }}
              disabled={reportSubmitting}
            />
            
            <p style={{ fontSize: "var(--text-14)", color: "var(--color-text-secondary)", marginBottom: "var(--space-4)" }}>
              {reportReason.length}/500 characters
            </p>
            
            <div style={{ display: "flex", gap: "var(--space-3)" }}>
              <button
                type="button"
                className="button-primary"
                onClick={handleReportSubmit}
                disabled={reportSubmitting || reportReason.trim().length === 0}
              >
                {reportSubmitting ? "Submitting…" : "Submit report"}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setShowReportDialog(false);
                  setReportNotice(undefined);
                }}
                disabled={reportSubmitting}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {showWaitlistDialog && waitlistDate && (
        <div className="modal-overlay" onClick={() => setShowWaitlistDialog(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h2 style={{ marginBottom: "var(--space-4)" }}>Join waitlist for {waitlistDate}</h2>
            <p style={{ marginBottom: "var(--space-4)", color: "var(--color-text-secondary)" }}>
              This date has no open slots. Add yourself to the waitlist and the shop will see your request.
            </p>
            
            {waitlistNotice && (
              <div className={waitlistNotice.isError ? "banner banner--alert" : "banner"} style={{ marginBottom: "var(--space-4)" }}>
                <p>{waitlistNotice.text}</p>
              </div>
            )}
            
            <textarea
              value={waitlistNote}
              onChange={(e) => setWaitlistNote(e.target.value)}
              placeholder="Optional note for the shop (max 300 characters)"
              maxLength={300}
              rows={4}
              style={{
                width: "100%",
                padding: "var(--space-3)",
                fontSize: "var(--text-16)",
                fontFamily: "inherit",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-2)",
                marginBottom: "var(--space-2)",
              }}
              disabled={waitlistSubmitting}
            />
            
            <p style={{ fontSize: "var(--text-14)", color: "var(--color-text-secondary)", marginBottom: "var(--space-4)" }}>
              {waitlistNote.length}/300 characters
            </p>
            
            <div style={{ display: "flex", gap: "var(--space-3)" }}>
              <button
                type="button"
                className="button-primary"
                onClick={handleWaitlistSubmit}
                disabled={waitlistSubmitting}
              >
                {waitlistSubmitting ? "Adding…" : "Join waitlist"}
              </button>
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setShowWaitlistDialog(false);
                  setWaitlistNotice(undefined);
                }}
                disabled={waitlistSubmitting}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
