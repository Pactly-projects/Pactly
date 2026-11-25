import { motion, useReducedMotion } from "motion/react";
import { ArrowRightIcon, ClockIcon, MapPinIcon, SealCheckIcon } from "@phosphor-icons/react";
import { Link } from "react-router";

import type { ProviderCard as ProviderCardData } from "../api/types";
import { providerPhotoSrc } from "../lib/providerPhotos";
import { formatSessionFormat } from "../lib/sessionFormat";
import { providerCardDetails } from "../lib/providerCardDetails";
import { DepositPill } from "./DepositPill";
import { TryAmount } from "./TryAmount";

export interface ProviderCardProps {
  provider: ProviderCardData;
  /** `"featured"` is the Discover page's own magazine-style hero for its
   * first result; every other result renders `"compact"` (the default). */
  variant?: "featured" | "compact";
  /** Stagger index for the compact grid's entrance animation (ui-ux-pro-max
   * `stagger-list`: 0.03-0.06s per item). Unused for `variant="featured"`. */
  index?: number;
}

/** Two-letter initials for the photo tile -- there is no photo field
 * (Story 3.2's own Design Notes: "badges cannot be invented", and neither
 * can a photo). Drops only a *leading* title-like word ("Dr.") so "Dr.
 * Elif Aydın" reads as "EA", not "DE" -- a trailing suffix ("Jr.") or an
 * abbreviation elsewhere in the name is never dropped, only ever used.
 * Falls back to the bare name's first letter if nothing else is left to
 * take initials from (e.g. an all-abbreviation name). */
function initialsFor(displayName: string): string {
  const trimmed = displayName.trim();
  const words = trimmed.split(/\s+/).filter((word) => word.length > 0);
  const nameWords = words.length > 1 && words[0]!.endsWith(".") ? words.slice(1) : words;
  let initials = "";
  if (nameWords.length === 1) {
    initials = nameWords[0]!.replace(/\./g, "").slice(0, 2).toUpperCase();
  } else if (nameWords.length > 1) {
    initials = `${nameWords[0]![0]}${nameWords[1]![0]}`.toUpperCase();
  }
  return initials || trimmed.slice(0, 1).toUpperCase();
}

/** "Editorial Warmth" provider card (adopted app-wide 2026-09-20, replacing
 * the original flat marketplace-row card): a magazine-style featured hero
 * for the Discover page's first result, compact cards for the rest. The
 * whole card links to `/providers/:id` through a "stretched link" -- an
 * absolutely-positioned, otherwise empty `<a>` painted first, so the real
 * buttons/links painted after it sit above it for hit-testing and never
 * also trigger the card's own navigation, without ever nesting a
 * `<button>` inside an `<a>`. */
export function ProviderCard({ provider, variant = "compact", index = 0 }: ProviderCardProps) {
  const reduceMotion = useReducedMotion();
  const initials = initialsFor(provider.displayName);
  const photoSrc = providerPhotoSrc(provider.id);
  const firstSlot = provider.earliestSlots[0];
  const lockHref = firstSlot ? `/book/${provider.id}?slot=${firstSlot}` : `/providers/${provider.id}`;
  const details = providerCardDetails({
    sessionLengthMinutes: provider.sessionLengthMinutes,
    serviceCount: provider.serviceCount,
    priceAmount: provider.price?.amount,
  });
  const price = details.hasPrice ? (
    <TryAmount amount={provider.price.amount} />
  ) : (
    <span>Price unset</span>
  );
  const weeklyHours = provider.publicHours ?? [];
  const hasPublicHours = weeklyHours.some((day) => day.hours !== "Closed");
  const publicHours = (
    <div className="editorial-card__hours">
      <strong>Public hours · {provider.timeZone ?? "UTC"}</strong>
      {hasPublicHours ? (
        <ul>
          {weeklyHours.map((day) => (
            <li key={day.weekday}>
              <span>{day.weekday}</span> <span>{day.hours}</span>
            </li>
          ))}
        </ul>
      ) : (
        <span>Hours unset</span>
      )}
    </div>
  );

  const tile = photoSrc ? (
    <img src={photoSrc} alt="" />
  ) : (
    <span className={variant === "featured" ? "editorial-featured__initials" : "editorial-card__initials"}>{initials}</span>
  );

  if (variant === "featured") {
    return (
      <motion.article
        className="editorial-featured"
        initial={reduceMotion ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
      >
        <Link to={`/providers/${provider.id}`} className="editorial-featured__link" aria-label={`View ${provider.displayName}`} />
        <div className="editorial-featured__tile" aria-hidden="true">
          {tile}
          <span className="editorial-featured__badge">Featured near you</span>
        </div>
        <div>
          <p className="editorial-featured__eyebrow">{provider.category.name}</p>
          <h3 className="editorial-featured__name">{provider.displayName}</h3>
          <p className="editorial-featured__role">{provider.title}</p>
          <p className="editorial-featured__quote">
            {provider.verifiedSessionCount > 0
              ? `“${provider.verifiedSessionCount} verified ${provider.verifiedSessionCount === 1 ? "session" : "sessions"} · ${provider.providerCancellationCount} ${provider.providerCancellationCount === 1 ? "cancellation" : "cancellations"}”`
              : "“Deposit held in escrow until the appointment is done — no blind prepay.”"}
          </p>
          <div className="editorial-featured__meta">
            <span>
              <MapPinIcon size={15} weight="fill" aria-hidden="true" />
              {provider.location}
            </span>
            <span>
              <ClockIcon size={15} weight="fill" aria-hidden="true" />
              {formatSessionFormat(provider.sessionFormat)} · {details.lengthLabel}
            </span>
            <span>
              <SealCheckIcon size={15} weight="fill" aria-hidden="true" />
              {provider.verifiedSessionCount} verified · {provider.providerCancellationCount} cancelled
            </span>
          </div>
          {publicHours}
        </div>
        <div className="editorial-featured__side">
          <span className="editorial-card__price" style={{ fontSize: "var(--text-18)" }}>
            {price}
          </span>
          <DepositPill variant="row" amount={provider.deposit.amount} cancellationWindowHours={provider.cancellationWindowHours} />
          {provider.bookingsPaused ? <p className="editorial-card__role">Not taking bookings right now</p> : null}
          <Link to={lockHref} className="editorial-cta">
            {firstSlot ? "Lock with Pactly" : "View calendar"}
            <ArrowRightIcon size={16} weight="bold" aria-hidden="true" />
          </Link>
        </div>
      </motion.article>
    );
  }

  return (
    <motion.article
      className="editorial-card"
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut", delay: reduceMotion ? 0 : Math.min(index, 10) * 0.04 }}
    >
      <Link to={`/providers/${provider.id}`} className="editorial-card__link" aria-label={`View ${provider.displayName}`} />
      <div className="editorial-card__top">
        <div className="editorial-card__tile" aria-hidden="true">
          {tile}
        </div>
        <div>
          <h3 className="editorial-card__name">
            {provider.displayName}
            {provider.verifiedSessionCount > 0 ? <SealCheckIcon size={14} weight="fill" aria-label="Verified provider" /> : null}
          </h3>
          <p className="editorial-card__role">{provider.title}</p>
          {provider.bookingsPaused ? <p className="editorial-card__role">Not taking bookings</p> : null}
        </div>
      </div>
      <div className="editorial-card__meta">
        <span>
          <MapPinIcon size={13} aria-hidden="true" />
          {provider.location}
        </span>
        <span>
          <ClockIcon size={13} aria-hidden="true" />
          {details.lengthLabel}
        </span>
        <span>
          {provider.verifiedSessionCount} verified · {provider.providerCancellationCount} cancelled
        </span>
      </div>
      {publicHours}
      <DepositPill variant="row" amount={provider.deposit.amount} cancellationWindowHours={provider.cancellationWindowHours} />
      <div className="editorial-card__foot">
        {details.hasPrice ? (
          <TryAmount amount={provider.price.amount} className="editorial-card__price" />
        ) : (
          <span className="editorial-card__price">Price unset</span>
        )}
        <Link to={lockHref} className="editorial-card__cta">
          {firstSlot ? "Lock" : "View"}
          <ArrowRightIcon size={14} weight="bold" aria-hidden="true" />
        </Link>
      </div>
    </motion.article>
  );
}
