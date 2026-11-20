import { formatSlotDay, formatSlotTime } from "./time";

export interface ReleaseMailtoInput {
  /** Escrow state from the booking payload. Mailto only when `"released"`. */
  escrowState: "locked" | "released" | "refunded" | null;
  /** Optional client email on the booking. Absent/empty → no mailto. */
  clientEmail: string | null | undefined;
  /** Shop / provider display name included in the draft. */
  shopName: string;
  /** UTC epoch seconds for the appointment, or null when unknown. */
  slotStartsAt: number | null;
  /** Absolute proof page URL for this booking. */
  proofUrl: string;
}

/**
 * Build a `mailto:` draft the shop can open after the deposit is released.
 * Pactly never sends mail — this only prepares a client-side mail draft.
 *
 * Returns `undefined` when the booking is not released or has no client email.
 */
export function buildReleaseMailto(input: ReleaseMailtoInput): string | undefined {
  if (input.escrowState !== "released") return undefined;
  const email = input.clientEmail?.trim();
  if (!email) return undefined;

  const shop = input.shopName.trim() || "the shop";
  const when =
    input.slotStartsAt !== null
      ? `${formatSlotDay(input.slotStartsAt)} · ${formatSlotTime(input.slotStartsAt)}`
      : "your appointment time";

  const subject = `Your appointment with ${shop}`;
  const body = [
    `Hi,`,
    ``,
    `This is ${shop}. Your appointment on ${when} is complete and the deposit has been released.`,
    ``,
    `Proof of the escrow: ${input.proofUrl}`,
  ].join("\n");

  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** Public proof page URL for a booking (shareable escrow proof). */
export function bookingProofUrl(bookingId: string, origin: string = typeof window !== "undefined" ? window.location.origin : ""): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/proof/${bookingId}`;
}
