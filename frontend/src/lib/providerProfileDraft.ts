/**
 * Issues #165/#166: the provider profile editor's own draft model.
 *
 * The editor never renders the saved profile directly -- it edits a draft,
 * shows the public preview from that draft, and only a successful save
 * replaces the saved profile (which is what clears the unsaved marker).
 * Everything here is pure so both behaviours are testable without a DOM.
 */
import type { Money } from "../api/types.js";

export interface EditableProfileFields {
  title: string;
  bio: string;
  languages: string[];
  sessionLengthMinutes: number;
  location: string;
}

/** The fields the approved-provider edit form owns. Price, deposit rate,
 * category and the approval flag are deliberately absent: editing the copy
 * can never change what a client pays. */
export interface ProfileDraft extends EditableProfileFields {}

export interface ProfileDraftSource extends EditableProfileFields {
  displayName: string;
  price: Money;
  deposit: Money;
  sessionFormat: string;
}

const MIN_SESSION_LENGTH_MINUTES = 15;
const MAX_SESSION_LENGTH_MINUTES = 240;

/** Opening the editor seeds the draft from the saved profile, so a freshly
 * opened page is never dirty. */
export function createProfileDraft(source: EditableProfileFields): ProfileDraft {
  return {
    title: source.title,
    bio: source.bio ?? "",
    languages: [...(source.languages ?? [])],
    sessionLengthMinutes: source.sessionLengthMinutes,
    location: source.location,
  };
}

function normaliseLanguages(languages: readonly string[]): string[] {
  return [...new Set(languages.map((language) => language.trim()).filter((language) => language !== ""))].sort();
}

/** A changed field marks the profile unsaved. Comparing normalised values
 * means typing a trailing space, or listing the same languages in another
 * order, is not an edit. */
export function isProfileDirty(draft: ProfileDraft, saved: EditableProfileFields): boolean {
  const savedLanguages = normaliseLanguages(saved.languages ?? []);
  const draftLanguages = normaliseLanguages(draft.languages);
  return (
    draft.title.trim() !== saved.title.trim() ||
    draft.bio.trim() !== (saved.bio ?? "").trim() ||
    draft.location.trim() !== saved.location.trim() ||
    draft.sessionLengthMinutes !== saved.sessionLengthMinutes ||
    draftLanguages.length !== savedLanguages.length ||
    draftLanguages.some((language, index) => language !== savedLanguages[index])
  );
}

/** The same bounds the backend enforces, so the preview can show a
 * validation error before the save is attempted. */
export function validateProfileDraft(draft: ProfileDraft): Record<string, string> {
  const details: Record<string, string> = {};
  if (draft.title.trim() === "") {
    details.title = "Title is required.";
  }
  if (draft.bio.trim() === "") {
    details.bio = "Description is required.";
  }
  if (draft.languages.some((language) => language.trim() === "")) {
    details.languages = "Languages must be a list of non-empty names.";
  }
  if (
    !Number.isInteger(draft.sessionLengthMinutes) ||
    draft.sessionLengthMinutes < MIN_SESSION_LENGTH_MINUTES ||
    draft.sessionLengthMinutes > MAX_SESSION_LENGTH_MINUTES
  ) {
    details.sessionLengthMinutes = `Session length must be a whole number of minutes between ${MIN_SESSION_LENGTH_MINUTES} and ${MAX_SESSION_LENGTH_MINUTES}.`;
  }
  if (draft.location.trim() === "") {
    details.location = "Location is required.";
  }
  return details;
}

export interface PublicProfilePreview {
  displayName: string;
  title: string;
  bio: string;
  languages: string[];
  location: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  price: Money;
  deposit: Money;
  /** Shown beside the form and in the preview; empty means the draft is
   * valid. */
  errors: Record<string, string>;
}

/** The public profile a client would open, built from the *draft* so unsaved
 * edits are visible. Only public fields are copied: intake answers and the
 * private contact are never part of this shape. */
export function previewProfileFromDraft(
  source: ProfileDraftSource,
  draft: ProfileDraft,
): PublicProfilePreview {
  return {
    displayName: source.displayName,
    title: draft.title,
    bio: draft.bio,
    languages: normaliseLanguages(draft.languages),
    location: draft.location,
    sessionFormat: source.sessionFormat,
    sessionLengthMinutes: draft.sessionLengthMinutes,
    price: source.price,
    deposit: source.deposit,
    errors: validateProfileDraft(draft),
  };
}
