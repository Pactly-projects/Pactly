import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { usePublicProviderProfile } from "../../api/hooks";
import { ApiError } from "../../api/client";
import { DepositPill } from "../../components/DepositPill";
import { ProviderHeader } from "../../components/ProviderHeader";
import { SlotChip } from "../../components/SlotChip";
import { TryAmount } from "../../components/TryAmount";
import { providerPhotoSrc } from "../../lib/providerPhotos";
import { formatSessionFormat } from "../../lib/sessionFormat";
import { formatSlotDay, groupSlotsByDay } from "../../lib/time";

/** `/providers/:id` -- a public profile, no sign-in required
 * (EXPERIENCE.md: "Discovery, search, profile viewing ... need no
 * sign-in"). No booking action lives here yet (Story 3.4's job) -- picking
 * a slot only ever highlights it locally. */
export function ProviderProfilePage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: profile, isLoading, error } = usePublicProviderProfile(id);

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

  const dayGroups = groupSlotsByDay(profile.slots);

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

      <div className="card" style={{ marginTop: "var(--space-6)" }}>
        <div className="price-row">
          <TryAmount amount={profile.price.amount} className="price-row__amount" />
          <span className="price-row__meta">
            {formatSessionFormat(profile.sessionFormat)} · {profile.sessionLengthMinutes} min
          </span>
        </div>

        <div style={{ marginTop: "var(--space-4)" }}>
          <DepositPill amount={profile.deposit.amount} cancellationWindowHours={profile.cancellationWindowHours} />
        </div>

        <div style={{ marginTop: "var(--space-6)" }}>
          <h2 style={{ fontSize: "var(--text-18)" }}>Upcoming slots</h2>
          {dayGroups.length === 0 ? (
            <p className="banner">No open slots in the next 30 days. Check back soon.</p>
          ) : (
            dayGroups.map((group) => (
              <div className="slot-day" key={group.dayLabel}>
                <div className="slot-day__label">{group.dayLabel}</div>
                <div className="slot-day__chips">
                  {group.slots.map((startsAt) => (
                    <SlotChip key={startsAt} startsAt={startsAt} selected={startsAt === selectedSlot} onSelect={selectSlot} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {selectedSlot !== undefined && (
          <div style={{ marginTop: "var(--space-6)" }}>
            <Link to={`/book/${profile.id}?slot=${selectedSlot}`} className="button-primary" style={{ textDecoration: "none" }}>
              Continue
            </Link>
          </div>
        )}
      </div>

      {/* Issue #3: verified reviews, newest first (the backend already
       * orders them). An empty list stays empty -- there is no placeholder
       * rating and never a fabricated one. Each review links back to the
       * booking it came from, in the client's own bookings list. */}
      <section className="card" style={{ marginTop: "var(--space-6)" }}>
        <h2 style={{ fontSize: "var(--text-18)" }}>Reviews</h2>
        {profile.reviews.length === 0 ? (
          <p className="banner">No reviews yet.</p>
        ) : (
          <ul className="review-list">
            {profile.reviews.map((review) => (
              <li key={review.id} className="review-list__item">
                <p className="review-list__rating">{review.rating} out of 5</p>
                {review.comment && <p className="review-list__comment">{review.comment}</p>}
                <p className="review-list__meta">
                  {formatSlotDay(review.createdAt)} ·{" "}
                  <Link to={`/me/bookings#booking-${review.bookingId}`}>View the booking</Link>
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
