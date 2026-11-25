import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { CalendarBlankIcon } from "@phosphor-icons/react";

import { ApiError, apiDownload } from "../../api/client";
import { PageMasthead } from "../../components/PageMasthead";
import { SignInPanel } from "../../components/SignInPanel";
import {
  closeProviderDate,
  useOwnProviderProfile,
  useTryRate,
  useUpdateProviderAvailability,
  useUpdateProviderRules,
} from "../../api/hooks";
import { TryAmount } from "../../components/TryAmount";
import { currencyToUsdcSmallestUnit, usdcToCurrency } from "../../lib/money";
import { getSession, signOut, type Session } from "../../wallet";

const GRID_DAYS = 14;
const GRID_START_HOUR = 8;
const GRID_END_HOUR = 20;
const GRID_STEP_MINUTES = 15;

interface GridDay {
  dayLabel: string;
  cells: number[];
}

/**
 * Candidate start times for the grid: every 15-minute mark from 08:00 to
 * 20:00 local time, for the next 14 days -- the backend's own boundary
 * rule (`startsAt % 900 seconds === 0`, checked against the epoch) holds
 * for these as long as the viewer's UTC offset is itself a multiple of 15
 * minutes, true for the large majority of real time zones (including the
 * demo's Istanbul, UTC+3) and an accepted simplification for this story's
 * grid (no frontend test runner; manual verification only).
 */
function buildGridDays(now: number, timeZone?: string, bufferMinutes = 0): GridDay[] {
  const days: GridDay[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let day = 0; day < GRID_DAYS; day += 1) {
    const dayDate = new Date(today);
    dayDate.setDate(dayDate.getDate() + day);
    const cells: number[] = [];
    for (let minutes = GRID_START_HOUR * 60; minutes < GRID_END_HOUR * 60; minutes += GRID_STEP_MINUTES) {
      const cellDate = new Date(dayDate);
      cellDate.setMinutes(minutes);
      const startsAt = Math.floor(cellDate.getTime() / 1000);
      if (startsAt > now) {
        cells.push(startsAt);
      }
    }
    // Add buffer gap cells at the end of the day's available slots.
    // When bufferMinutes is 0, no gap cells are added.
    const gapCells: number[] = [];
    if (bufferMinutes > 0) {
      const gapCount = Math.ceil(bufferMinutes / GRID_STEP_MINUTES);
      // Gap cells are the last `gapCount` cells before 20:00.
      const startIndex = Math.max(0, cells.length - gapCount);
      for (let i = startIndex; i < cells.length; i += 1) {
        gapCells.push(cells[i]);
      }
    }
    if (cells.length > 0 || gapCells.length > 0) {
      days.push({
                        dayLabel: dayDate.toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  ...(timeZone ? { timeZone } : {}),
                }),
        cells,
        gapCells,
      });
    }
  }
  return days;
}

/** A voice-guide banner for a save failure that carries no field-level
 * `details` to show instead -- a network failure, or a session that
 * expired mid-edit (401 from `requirePactlyAuth`, which never sends
 * `details`). Without this, such a failure showed nothing at all. */
function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return "Your session ended. Sign in again.";
  }
  return "Connection dropped. Nothing was saved.";
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** `"13:00"` -> `780`; `undefined` for anything that is not a wall-clock
 * time a break can name. */
function timeTextToMinutes(value: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) {
    return undefined;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return undefined;
  }
  return hours * 60 + minutes;
}

function minutesToTimeText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` for a `<input type="date">`, in the browser's own local
 * day (the range is inclusive of both ends). */
function toDateInput(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayStartEpochSeconds(dateText: string): number {
  return Math.floor(new Date(`${dateText}T00:00:00`).getTime() / 1000);
}

function dayEndEpochSeconds(dateText: string): number {
  return Math.floor(new Date(`${dateText}T23:59:59`).getTime() / 1000);
}

function isBlocked(cell: number, selected: ReadonlySet<number>, sessionSeconds: number): boolean {
  if (selected.has(cell)) {
    return false;
  }
  for (const startsAt of selected) {
    if (Math.abs(cell - startsAt) < sessionSeconds) {
      return true;
    }
  }
  return false;
}

/** A local, preview-only mirror of `services/profile.ts`'s
 * `computeDepositAmount` -- shown as the rules form fills in, but never
 * treated as the saved truth. The server recomputes and returns the
 * authoritative deposit on save; this component only ever renders *that*
 * value once the mutation resolves. */
function previewDeposit(priceSmallestUnit: string | undefined, depositRateBps: number): string | undefined {
  if (!priceSmallestUnit || !Number.isInteger(depositRateBps)) {
    return undefined;
  }
  try {
    return ((BigInt(priceSmallestUnit) * BigInt(depositRateBps)) / 10000n).toString();
  } catch {
    return undefined;
  }
}

/** `/panel/availability` -- the provider's own rules and availability
 * panel (EXPERIENCE.md "Availability & rules"). Desktop-first per Epic 3
 * context; the grid still respects the 44px touch target floor. */
export function AvailabilityPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());

  const profileQuery = useOwnProviderProfile(session);
  const updateRules = useUpdateProviderRules(session);
  const updateAvailability = useUpdateProviderAvailability(session);
  const updateProfile = useUpdateProviderProfile(session);
  const closedDatesQuery = useClosedDates(session);
  const { rate } = useTryRate();

  // The price is stored in USDC smallest units (AD-7) but typed in TRY.
  // Until the provider actually edits the field, what it shows is *derived*
  // from the stored amount at the current rate (so a rate that arrives
  // after the first paint still updates it), and saving resubmits the
  // stored string untouched -- an unedited price must never drift by a
  // rounding or a rate move between display and save.
  const [priceInput, setPriceInput] = useState("");
  const [priceEdited, setPriceEdited] = useState(false);
  const [depositRatePercentInput, setDepositRatePercentInput] = useState("");
  const [cancellationWindowInput, setCancellationWindowInput] = useState("");
  const [bufferMinutesInput, setBufferMinutesInput] = useState("");
  const [maxBookingDaysInput, setMaxBookingDaysInput] = useState("");
  const [selectedSlots, setSelectedSlots] = useState<Set<number>>(new Set());
  const [closeDate, setCloseDate] = useState("");
  const [closeEndDate, setCloseEndDate] = useState("");
  const [closeBusy, setCloseBusy] = useState(false);
  const [closeResult, setCloseResult] = useState<Awaited<ReturnType<typeof closeProviderDate>> | undefined>();
  const [closeError, setCloseError] = useState<string | undefined>();
  const [editWeekday, setEditWeekday] = useState<number | undefined>(undefined);

  // Seeds local form state only the first time a profile loads, or when it
  // switches to a *different* profile (a new sign-in) -- never on every
  // refetch. Both mutations already re-fetch/re-cache `profileQuery.data`
  // on success (see `api/hooks.ts`), and re-seeding both forms from that
  // response here would silently discard whichever form's edits were not
  // just saved (e.g. saving rules would blow away unsaved slot picks).
  // Each save path updates only its own form's state instead, from the
  // mutation's own response (see `handleSaveRules`/`handleSaveAvailability`).
  const loadedProfileId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (profileQuery.data && profileQuery.data.id !== loadedProfileId.current) {
      loadedProfileId.current = profileQuery.data.id;
      setPriceEdited(false);
      setDepositRatePercentInput(String(profileQuery.data.depositRateBps / 100));
      setCancellationWindowInput(String(profileQuery.data.cancellationWindowHours));
      setBufferMinutesInput(String(profileQuery.data.bufferMinutes));
      setMaxBookingDaysInput(
        profileQuery.data.maxBookingDaysAhead == null
          ? ""
          : String(profileQuery.data.maxBookingDaysAhead),
      );
      setSelectedSlots(new Set(profileQuery.data.slots));
      setEditTitle(profileQuery.data.title);
      setEditBio(profileQuery.data.bio ?? "");
      setEditLanguages((profileQuery.data.languages ?? []).join(", "));
      setEditSessionLength(String(profileQuery.data.sessionLengthMinutes));
      setEditLocation(profileQuery.data.location);
    }
  }, [profileQuery.data]);

  const now = useMemo(() => Math.floor(Date.now() / 1000), []);
  const gridDays = useMemo(() => buildGridDays(now, profile.timezone, bufferMinutes), [now, bufferMinutes]);
  const sessionSeconds = (profileQuery.data?.sessionLengthMinutes ?? 30) * 60;

  function handleSignOut(): void {
    signOut();
    setSession(undefined);
  }

  const storedPrice = profileQuery.data?.price.amount;
  const priceText = priceEdited
    ? priceInput
    : storedPrice !== undefined && !isFallback
      ? usdcToCurrency(storedPrice, rate, decimals)
      : "";
  const priceSmallestUnit = priceEdited
    ? currencyToUsdcSmallestUnit(priceInput, rate, decimals)
    : storedPrice;
  // Basis points on the wire (`depositRateBps`), a percentage on screen.
  const depositRatePercent = Number(depositRatePercentInput);
  const depositRateBps = Number.isFinite(depositRatePercent) ? Math.round(depositRatePercent * 100) : Number.NaN;
  const cancellationWindowHours = Number(cancellationWindowInput);
  const bufferMinutes = Number(bufferMinutesInput);
  const maxBookingDaysAhead = maxBookingDaysInput.trim() === ""
    ? null
    : Number(maxBookingDaysInput);
  const visibleGridDays = maxBookingDaysAhead == null || !Number.isFinite(maxBookingDaysAhead)
    ? gridDays
    : gridDays
        .map((day) => ({
          ...day,
          cells: day.cells.filter(
            (cell) => cell <= now + maxBookingDaysAhead * 24 * 60 * 60,
          ),
        }))
        .filter((day) => day.cells.length > 0);
  const deposit = previewDeposit(priceSmallestUnit, depositRateBps);

  const rulesErrorDetails =
    updateRules.error instanceof ApiError ? (updateRules.error.details as Record<string, string> | undefined) : undefined;
  const rulesHasFieldError = Boolean(rulesErrorDetails && Object.keys(rulesErrorDetails).length > 0);
  const rulesGenericError = updateRules.error && !rulesHasFieldError ? saveErrorMessage(updateRules.error) : undefined;

  async function handleSaveRules(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!priceSmallestUnit) {
      return;
    }
    try {
      const saved = await updateRules.mutateAsync({
        priceAmount: priceSmallestUnit,
        depositRateBps,
        cancellationWindowHours,
        maxBookingDaysAhead,
        bufferMinutes,
      });
      // Only the rules form's own fields -- an unsaved slot selection in
      // the availability grid below must survive this save untouched. The
      // price field goes back to deriving from the saved amount.
      setPriceEdited(false);
      setPriceInput("");
      setDepositRatePercentInput(String(saved.depositRateBps / 100));
      setCancellationWindowInput(String(saved.cancellationWindowHours));
      setBufferMinutesInput(String(saved.bufferMinutes));
      setMaxBookingDaysInput(
        saved.maxBookingDaysAhead == null ? "" : String(saved.maxBookingDaysAhead),
      );
    } catch {
      // Surfaced through `updateRules.error`/`rulesErrorDetails`/
      // `rulesGenericError` below -- nothing further to do here.
    }
  }

  function toggleCell(cell: number): void {
    setSelectedSlots((current) => {
      const next = new Set(current);
      if (next.has(cell)) {
        next.delete(cell);
      } else if (!isBlocked(cell, current, sessionSeconds)) {
        next.add(cell);
      }
      return next;
    });
  }

  const availabilityErrorDetails =
    updateAvailability.error instanceof ApiError
      ? (updateAvailability.error.details as { invalid?: number[]; overlapping?: number[]; count?: string } | undefined)
      : undefined;
  const availabilityHasFieldError = Boolean(availabilityErrorDetails && Object.keys(availabilityErrorDetails).length > 0);
  const availabilityGenericError =
    updateAvailability.error && !availabilityHasFieldError ? saveErrorMessage(updateAvailability.error) : undefined;

  const timezoneErrorDetails =
    updateTimezone.error instanceof ApiError
      ? (updateTimezone.error.details as Record<string, string> | undefined)
      : undefined;
  const timezoneGenericError =
    updateTimezone.error && !timezoneErrorDetails?.timezone ? saveErrorMessage(updateTimezone.error) : undefined;

  async function handleSaveTimezone(): Promise<void> {
    try {
      await updateTimezone.mutateAsync(timezoneInput.trim());
    } catch {
      // Surfaced through `timezoneErrorDetails`/`timezoneGenericError` below.
    }
  }

  const breaksError =
    updateBreaks.error instanceof ApiError
      ? (updateBreaks.error.details as Record<string, unknown> | undefined)
      : undefined;
  const breaksErrorText = breaksError
    ? typeof breaksError.range === "string"
      ? breaksError.range
      : typeof breaksError.overlapping !== "undefined"
        ? "Two breaks overlap. Merge them or move one."
        : "That break isn't valid."
    : updateBreaks.error
      ? saveErrorMessage(updateBreaks.error)
      : undefined;

  function handleAddBreak(): void {
    const startMinute = timeTextToMinutes(breakStart);
    const endMinute = timeTextToMinutes(breakEnd);
    if (startMinute === undefined || endMinute === undefined || endMinute <= startMinute) {
      return;
    }
    setBreaks((current) =>
      [...current, { weekday: breakWeekday, startMinute, endMinute }].sort(
        (a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute,
      ),
    );
  }

  async function handleSaveBreaks(): Promise<void> {
    try {
      const saved = await updateBreaks.mutateAsync(breaks);
      // A saved break prunes any open slot inside it -- mirror that here so
      // the grid does not keep showing a slot the server just stopped
      // offering.
      setBreaks(saved.breaks ?? []);
      setSelectedSlots(new Set(saved.slots));
    } catch {
      // Surfaced through `breaksErrorText` below.
    }
  }

  async function handleExport(): Promise<void> {
    if (!session) {
      return;
    }
    setExportError(undefined);
    setExporting(true);
    try {
      const query = new URLSearchParams({
        from: String(dayStartEpochSeconds(exportFrom)),
        to: String(dayEndEpochSeconds(exportTo)),
      });
      const { blob, filename } = await apiDownload(`/me/provider/bookings/export?${query.toString()}`, session.token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename ?? "pactly-bookings.csv";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setExportError(error instanceof ApiError ? error.message : "The export could not be built.");
    } finally {
      setExporting(false);
    }
  }

  async function handleSaveAvailability(): Promise<void> {
    try {
      const saved = await updateAvailability.mutateAsync({
        slots: [...selectedSlots].sort((a, b) => a - b),
        weekday: editWeekday,
      });
      // Only the slot selection -- an unsaved edit in the rules form above
      // must survive this save untouched.
      setSelectedSlots(new Set(saved.slots));
    } catch {
      // Surfaced through `updateAvailability.error`/`availabilityErrorDetails`/
      // `availabilityGenericError` below -- nothing further to do here.
    }
  }

  async function handleCloseDate(): Promise<void> {
    if (!session || !closeDate) return;
    const endDate = closeEndDate || closeDate;
    if (endDate < closeDate) {
      setCloseResult(undefined);
      setCloseError("The end date cannot be before the start date.");
      return;
    }
    setCloseBusy(true);
    setCloseError(undefined);
    setCloseResult(undefined);
    try {
      const result = await closeProviderDate(closeDate, session, endDate);
      setCloseResult(result);
      // The closed date's slots are gone server-side -- refresh the grid so
      // the panel stops showing them as selected.
      const refreshed = await profileQuery.refetch();
      if (refreshed.data) {
        setSelectedSlots(new Set(refreshed.data.slots));
      }
    } catch (error) {
      setCloseError(error instanceof ApiError ? error.message : "Connection dropped. Nothing changed.");
    } finally {
      setCloseBusy(false);
    }
  }

  if (!session) {
    return (
      <div className="page">
        <PageMasthead
          eyebrow="Provider panel"
          icon={<CalendarBlankIcon size={14} weight="bold" aria-hidden="true" />}
          title="Availability & rules"
          lede="Sign in to manage your price, deposit rate, cancellation window and open slots."
        />
        <SignInPanel onSignedIn={setSession} onRateLimited={(waitMs) => setError(`Too many failed sign-in attempts. Please wait ${Math.ceil(waitMs / 1000)} second${Math.ceil(waitMs / 1000) !== 1 ? "s" : ""} before trying again.`)} />
      </div>
    );
  }

  if (profileQuery.isLoading) {
    return (
      <div className="page">
        <p>Loading your panel…</p>
      </div>
    );
  }

  if (profileQuery.error) {
    const notAProvider = profileQuery.error instanceof ApiError && profileQuery.error.code === "NOT_A_PROVIDER";
    return (
      <div className="page">
        <div className="banner">
          <p>{notAProvider ? "This account doesn't have a provider profile yet." : "Connection dropped. Try again."}</p>
          {notAProvider && (
            <Link to="/providers/apply" className="button-primary" style={{ textDecoration: "none", marginTop: "var(--space-3)" }}>
              List your shop
            </Link>
          )}
        </div>
        <button type="button" className="button-ghost" onClick={handleSignOut} style={{ marginTop: "var(--space-4)" }}>
          Sign out
        </button>
      </div>
    );
  }

  const profile = profileQuery.data;
  if (!profile) {
    return null;
  }

  return (
    <div className="page">
      <PageMasthead
        eyebrow="Provider panel"
        icon={<CalendarBlankIcon size={14} weight="bold" aria-hidden="true" />}
        title="Availability & rules"
        actions={
          <>
            <Link to="/panel/bookings">Bookings</Link>
            <Link to={`/providers/${profile.id}`}>View public profile</Link>
            <button type="button" className="button-ghost" onClick={handleSignOut}>
              Sign out
            </button>
          </>
        }
      />

      {profile.isSuspended && (
        <div className="banner banner--alert" role="status" style={{ marginBottom: "var(--space-6)" }}>
          <p>
            <strong>Your shop is suspended.</strong> It is hidden from discovery and search and cannot take new
            bookings until Pactly lifts the suspension. Existing bookings are unaffected.
          </p>
          {profile.suspensionReason && (
            <p>
              <strong>Reason:</strong> {profile.suspensionReason}
            </p>
          )}
        </div>
      )}

      {!profile.isApproved && (
        <div className="banner" role="status" style={{ marginBottom: "var(--space-6)" }}>
          Your profile is pending approval. You can still set your rules and availability now -- clients will see them
          once you're approved.
        </div>
      )}

      <section className="card" style={{ marginBottom: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-18)", marginTop: 0 }}>Your shop's copy</h2>
        <p>
          Title, description, languages, session length and location are yours to edit. Price, deposit rate and category
          stay as they were approved.
        </p>
        {profileNotApproved && (
          <div className="banner banner--alert" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            An approved shop can edit its public profile. Your application is still pending.
          </div>
        )}
        {profileErrorDetails && Object.keys(profileErrorDetails).length > 0 && (
          <div className="banner banner--alert" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            {Object.values(profileErrorDetails).join(" ")}
          </div>
        )}
        <form onSubmit={handleSaveProfile}>
          <div className="field">
            <label htmlFor="profile-title">Title</label>
            <input id="profile-title" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="profile-bio">Description</label>
            <textarea id="profile-bio" rows={4} value={editBio} onChange={(event) => setEditBio(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="profile-languages">Languages (comma separated)</label>
            <input
              id="profile-languages"
              value={editLanguages}
              onChange={(event) => setEditLanguages(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="profile-session-length">Session length (minutes)</label>
            <input
              id="profile-session-length"
              inputMode="numeric"
              value={editSessionLength}
              onChange={(event) => setEditSessionLength(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="profile-location">How to find the shop</label>
            <input id="profile-location" value={editLocation} onChange={(event) => setEditLocation(event.target.value)} />
          </div>
          <button type="submit" className="button-primary" disabled={updateProfile.isPending}>
            {updateProfile.isPending ? "Saving…" : "Save profile"}
          </button>
        </form>
      </section>

      <section className="card" style={{ marginBottom: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-18)", marginTop: 0 }}>Price and deposit</h2>
        {rulesGenericError && (
          <div className="banner banner--alert" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            {rulesGenericError}
          </div>
        )}
        <form onSubmit={handleSaveRules}>
          <div className="field">
            <label htmlFor="price">Session price ({currency || "Currency unavailable"})</label>
            <input
              id="price"
              inputMode="decimal"
              value={priceText}
              onChange={(event) => {
                setPriceEdited(true);
                setPriceInput(event.target.value);
              }}
            />
            {priceEdited && priceInput.trim() !== "" && !priceSmallestUnit && (
              <span className="field__error">Enter an amount, using up to {decimals} decimals.</span>
            )}
            {rulesErrorDetails?.priceAmount && <span className="field__error">{rulesErrorDetails.priceAmount}</span>}
          </div>
          <div className="field">
            <label htmlFor="depositRatePercent">Deposit rate (%)</label>
            <input
              id="depositRatePercent"
              inputMode="decimal"
              value={depositRatePercentInput}
              onChange={(event) => setDepositRatePercentInput(event.target.value)}
            />
            {rulesErrorDetails?.depositRateBps && (
              <span className="field__error">{rulesErrorDetails.depositRateBps}</span>
            )}
          </div>
          <div className="field">
            <label htmlFor="cancellationWindowHours">Free-cancellation window (hours)</label>
            <input
              id="cancellationWindowHours"
              inputMode="numeric"
              value={cancellationWindowInput}
              onChange={(event) => setCancellationWindowInput(event.target.value)}
            />
            {rulesErrorDetails?.cancellationWindowHours && (
              <span className="field__error">{rulesErrorDetails.cancellationWindowHours}</span>
            )}
          </div>
          <div className="field">
            <label htmlFor="bufferMinutes">Buffer between appointments (minutes)</label>
            <input
              id="bufferMinutes"
              inputMode="numeric"
              min={0}
              max={120}
              value={bufferMinutesInput}
              onChange={(event) => setBufferMinutesInput(event.target.value)}
            />
            {rulesErrorDetails?.bufferMinutes && <span className="field__error">{rulesErrorDetails.bufferMinutes}</span>}
          </div>
          <div className="field">
            <label htmlFor="maxBookingDaysAhead">Maximum days clients may book ahead</label>
            <input
              id="maxBookingDaysAhead"
              inputMode="numeric"
              type="number"
              min={1}
              value={maxBookingDaysInput}
              placeholder="No limit"
              onChange={(event) => setMaxBookingDaysInput(event.target.value)}
            />
            <span>Leave blank for no limit.</span>
            {rulesErrorDetails?.maxBookingDaysAhead && (
              <span className="field__error">{rulesErrorDetails.maxBookingDaysAhead}</span>
            )}
          </div>

          <p className="tabular-nums">
            Deposit preview: {deposit ? <TryAmount amount={deposit} /> : "--"} (the saved amount comes back from the server once you
            save)
          </p>

          <button type="submit" className="button-primary" disabled={updateRules.isPending}>
            {updateRules.isPending ? "Saving…" : "Save rules"}
          </button>
        </form>
      </section>

      <section className="card" style={{ marginBottom: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-18)", marginTop: 0 }}>Shop timezone</h2>
        <p>Every slot is shown in this timezone, whatever zone the client is in. Your stored times never move.</p>
        {timezoneGenericError && (
          <div className="banner banner--alert" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            {timezoneGenericError}
          </div>
        )}
        <div className="field">
          <label htmlFor="timezone">IANA timezone</label>
          <input
            id="timezone"
            value={timezoneInput}
            placeholder="Europe/Istanbul"
            onChange={(event) => setTimezoneInput(event.target.value)}
          />
          {timezoneErrorDetails?.timezone && <span className="field__error">{timezoneErrorDetails.timezone}</span>}
        </div>
        <button type="button" className="button-primary" onClick={handleSaveTimezone} disabled={updateTimezone.isPending}>
          {updateTimezone.isPending ? "Saving…" : "Save timezone"}
        </button>
      </section>

      <section className="card" style={{ marginBottom: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-18)", marginTop: 0 }}>Daily breaks</h2>
        <p>
          A break cuts a window out of one weekday&rsquo;s hours. Slots before and after it stay bookable; a slot inside
          it stops being offered (a booking already there is kept and never cancelled).
        </p>
        {breaks.length === 0 ? (
          <p>No breaks yet.</p>
        ) : (
          <ul>
            {breaks.map((providerBreak, index) => (
              <li key={`${providerBreak.weekday}-${providerBreak.startMinute}`}>
                {WEEKDAY_LABELS[providerBreak.weekday]} {minutesToTimeText(providerBreak.startMinute)}–
                {minutesToTimeText(providerBreak.endMinute)}{" "}
                <button
                  type="button"
                  className="button-ghost"
                  onClick={() => setBreaks((current) => current.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {breaksErrorText && (
          <div className="banner banner--alert" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            {breaksErrorText}
          </div>
        )}
        <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field">
            <label htmlFor="breakWeekday">Day</label>
            <select id="breakWeekday" value={breakWeekday} onChange={(event) => setBreakWeekday(Number(event.target.value))}>
              {WEEKDAY_LABELS.map((label, value) => (
                <option key={label} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="breakStart">Break starts</label>
            <input id="breakStart" type="time" value={breakStart} onChange={(event) => setBreakStart(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="breakEnd">Break ends</label>
            <input id="breakEnd" type="time" value={breakEnd} onChange={(event) => setBreakEnd(event.target.value)} />
          </div>
          <button type="button" className="button-ghost" onClick={handleAddBreak}>
            Add break
          </button>
        </div>
        <button
          type="button"
          className="button-primary"
          style={{ marginTop: "var(--space-4)" }}
          onClick={handleSaveBreaks}
          disabled={updateBreaks.isPending}
        >
          {updateBreaks.isPending ? "Saving…" : "Save breaks"}
        </button>
      </section>

      <section className="card" style={{ marginBottom: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-18)", marginTop: 0 }}>Export bookings</h2>
        <p>Download your own bookings as a CSV for a date range. No client emails or intake answers are included.</p>
        {exportError && (
          <div className="banner banner--alert" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            {exportError}
          </div>
        )}
        <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field">
            <label htmlFor="exportFrom">From</label>
            <input id="exportFrom" type="date" value={exportFrom} onChange={(event) => setExportFrom(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="exportTo">To</label>
            <input id="exportTo" type="date" value={exportTo} onChange={(event) => setExportTo(event.target.value)} />
          </div>
          <button type="button" className="button-primary" onClick={handleExport} disabled={exporting}>
            {exporting ? "Preparing…" : "Download CSV"}
          </button>
        </div>
      </section>

      <section className="card">
        <h2 style={{ fontSize: "var(--text-18)", marginTop: 0 }}>
          Open slots -- next 14 days, 08:00-20:00 ({profile.timezone})
        </h2>
        {availabilityErrorDetails && (
          <div className="banner banner--alert" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            {availabilityErrorDetails.count && <p>{availabilityErrorDetails.count}</p>}
            {availabilityErrorDetails.invalid && <p>Some times can no longer be saved: they're in the past or too far out.</p>}
            {availabilityErrorDetails.overlapping && <p>Some times overlap another selected slot and were not saved.</p>}
          </div>
        )}
        {availabilityGenericError && (
          <div className="banner banner--alert" role="alert" style={{ marginBottom: "var(--space-4)" }}>
            {availabilityGenericError}
          </div>
        )}
        <div className="availability-grid">
          {visibleGridDays.map((day) => (
            <div className="availability-grid__day" key={day.dayLabel}>
              <span className="availability-grid__day-label">{day.dayLabel}</span>
              <div className="availability-grid__cells">
                {day.cells.map((cell) => {
                  const selected = selectedSlots.has(cell);
                  const blocked = !selected && isBlocked(cell, selectedSlots, sessionSeconds);
                  return (
                    <button
                      key={cell}
                      type="button"
                      className={`availability-cell tabular-nums${selected ? " availability-cell--selected" : ""}${
                        blocked ? " availability-cell--disabled" : ""
                      }`}
                      aria-pressed={selected}
                      aria-disabled={blocked}
                      onClick={() => toggleCell(cell)}
                    >
                      {formatSlotTime(cell, profile.timezone)}
                    </button>
                  );
                })}
                {day.gapCells.map((cell) => {
                  // Gap cells are non-selectable display elements only.
                  return (
                    <span
                      key={cell}
                      className="availability-cell tabular-nums availability-cell--gap"
                    >
                      {formatSlotTime(cell, profile.timezone)}
                    </span>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
          <div className="field" style={{ minWidth: "120px" }}>
            <label htmlFor="edit-weekday">Edit weekday</label>
            <select id="edit-weekday" value={editWeekday !== undefined ? WEEKDAY_LABELS[editWeekday] : ""} onChange={(event) => setEditWeekday(event.target.value === "" ? undefined : WEEKDAY_LABELS.indexOf(event.target.value))}>
              <option value="">All weekdays</option>
              {WEEKDAY_LABELS.map((label, value) => (
                <option key={label} value={value}>{label}</option>
              ))}
            </select>
          </div>
          <button
            type="button"
            className="button-ghost"
            style={{ minWidth: "120px" }}
            onClick={() => setEditWeekday(undefined)}
          >
            Clear selection
          </button>
        </div>
        <button
          type="button"
          className="button-primary"
          style={{ marginTop: "var(--space-4)" }}
          onClick={handleSaveAvailability}
          disabled={updateAvailability.isPending}
        >
          {updateAvailability.isPending ? "Saving…" : "Save availability"}
        </button>
      </section>

      <section className="card" style={{ marginTop: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-18)", marginTop: 0 }}>Close dates</h2>
        <p>
          Close one date or a run of dates (up to 31, start and end included). Closing removes those dates' open slots
          and releases any unpaid holds on them; your weekly pattern after the end date stays as it is. Those clients see that you
          closed the date, and no deposit is taken from them. A booking whose deposit is already locked is never released
          — resolve it from Bookings.
        </p>
        <div className="field">
          <label htmlFor="close-date">Start date</label>
          <input id="close-date" type="date" value={closeDate} onChange={(event) => setCloseDate(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="close-end-date">End date (optional, inclusive)</label>
          <input
            id="close-end-date"
            type="date"
            value={closeEndDate}
            min={closeDate || undefined}
            onChange={(event) => setCloseEndDate(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="button-primary"
          onClick={() => void handleCloseDate()}
          disabled={closeBusy || closeDate === ""}
        >
          {closeBusy ? "Closing…" : closeEndDate && closeEndDate !== closeDate ? "Close these dates" : "Close this date"}
        </button>

        {closeError && (
          <div className="banner banner--alert" role="alert" style={{ marginTop: "var(--space-4)" }}>
            {closeError}
          </div>
        )}
        {closeResult && (
          <div className="banner" role="status" style={{ marginTop: "var(--space-4)" }}>
            <p>
              Closed {closeResult.dayCount > 1 ? `${closeResult.date} to ${closeResult.endDate}` : closeResult.date}.{" "}{closeResult.releasedHoldCount} unpaid{" "}
              {closeResult.releasedHoldCount === 1 ? "hold was" : "holds were"} released — no deposit was taken.{" "}
              {closeResult.closedSlotCount} open {closeResult.closedSlotCount === 1 ? "slot was" : "slots were"} removed.
            </p>
            {closeResult.needsResolution.length > 0 && (
              <p>
                {closeResult.needsResolution.length === 1
                  ? "1 booking already has a deposit locked and was not released."
                  : `${closeResult.needsResolution.length} bookings already have a deposit locked and were not released.`}{" "}
                <Link to="/panel/bookings">Resolve from Bookings.</Link>
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
