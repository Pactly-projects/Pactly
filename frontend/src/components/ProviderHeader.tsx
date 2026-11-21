import { MapPinIcon } from "@phosphor-icons/react";

export interface ProviderHeaderProps {
  displayName: string;
  title: string;
  location: string;
  categoryName: string;
  isApproved: boolean;
  verifiedSessionCount: number;
  /** Issue #2: the provider's own cancellation count, beside the verified
   * lines. Shown even at zero -- an honest zero, never a hidden field. */
  providerCancellationCount: number;
  /** Demo venue photo when one exists for this provider. */
  photoSrc?: string;
  /** The booking lane's own copy of this header sits next to a lot of
   * other content -- a smaller name there keeps the lane from being
   * crowded out (`base.css`'s own `.provider-header--compact`). */
  compact?: boolean;
}

/** DESIGN.md: the provider's identity block, never interactive -- no
 * second brand colour carries it (Boundaries & Constraints); the serif
 * name and the quiet, gold-ink "approved" mark carry it instead. */
export function ProviderHeader({
  displayName,
  title,
  location,
  categoryName,
  isApproved,
  verifiedSessionCount,
  providerCancellationCount,
  photoSrc,
  compact,
}: ProviderHeaderProps) {
  return (
    <header className={`provider-header${compact ? " provider-header--compact" : ""}${photoSrc ? " provider-header--with-photo" : ""}`}>
      {photoSrc ? <img src={photoSrc} alt="" className="provider-header__photo" /> : null}
      <div className="provider-header__copy">
        <p className={`approved-mark${isApproved ? "" : " approved-mark--muted"}`}>
          {isApproved && <span className="approved-mark__dot" aria-hidden="true" />}
          {isApproved && "Approved provider · "}
          {verifiedSessionCount} verified {verifiedSessionCount === 1 ? "session" : "sessions"} · {" "}
          {providerCancellationCount} {providerCancellationCount === 1 ? "cancellation" : "cancellations"}
        </p>
        <h1 className="provider-header__name">{displayName}</h1>
        <p className="provider-header__title">
          {title} · {categoryName}
        </p>
        <p className="provider-header__location">
          <MapPinIcon size={14} weight="fill" aria-hidden="true" />
          {location}
        </p>
      </div>
    </header>
  );
}
