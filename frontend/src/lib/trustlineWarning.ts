/**
 * The provider dashboard's top warning is shown only for a confirmed
 * missing trustline. `null` means the check could not be answered (the
 * anchor or Horizon was unreachable) and must never raise a false alarm --
 * the same "read-only, no guess" rule the backend's own trustline read
 * follows.
 */
export function shouldShowTrustlineWarning(
  status: { hasTrustline: boolean | null } | null | undefined,
): boolean {
  return status?.hasTrustline === false;
}
