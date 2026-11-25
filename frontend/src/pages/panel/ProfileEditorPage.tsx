import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { ApiError } from "../../api/client";
import { useOwnProviderProfile, useUpdateProviderProfile } from "../../api/hooks";
import { PageMasthead } from "../../components/PageMasthead";
import { SignInPanel } from "../../components/SignInPanel";
import { TryAmount } from "../../components/TryAmount";
import {
  createProfileDraft,
  isProfileDirty,
  previewProfileFromDraft,
  type ProfileDraft,
} from "../../lib/providerProfileDraft";
import { formatSessionFormat } from "../../lib/sessionFormat";
import { getSession, signOut, type Session } from "../../wallet";

/**
 * `/panel/profile` -- the approved shop's own profile editor.
 *
 * Issue #166: a changed field marks the profile unsaved, leaving the page
 * warns, and only a successful save clears the marker.
 * Issue #165: the editor can preview the public page from the *unsaved*
 * draft, and closing that preview never saves.
 */
export function ProfileEditorPage() {
  const [session, setSession] = useState<Session | undefined>(() => getSession());
  const profileQuery = useOwnProviderProfile(session);
  const updateProfile = useUpdateProviderProfile(session);

  const saved = profileQuery.data;
  const [draft, setDraft] = useState<ProfileDraft | undefined>();
  const [showPreview, setShowPreview] = useState(false);

  // Seed only when the editor opens (or switches to another profile); a
  // save seeds it explicitly with the returned view, so a refetch can never
  // silently discard unsaved edits.
  const loadedProfileId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (saved && saved.id !== loadedProfileId.current) {
      loadedProfileId.current = saved.id;
      setDraft(createProfileDraft(saved));
    }
  }, [saved]);

  const dirty = useMemo(
    () => (saved && draft ? isProfileDirty(draft, saved) : false),
    [saved, draft],
  );

  // Issue #166: leaving the page warns while the edits are unsaved.
  useEffect(() => {
    if (!dirty) {
      return;
    }
    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty]);

  function handleSignOut(): void {
    signOut();
    setSession(undefined);
  }

  function updateField<Key extends keyof ProfileDraft>(key: Key, value: ProfileDraft[Key]): void {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  async function handleSave(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!draft) {
      return;
    }
    try {
      const updated = await updateProfile.mutateAsync(draft);
      // A successful save clears the marker: the draft is re-seeded from
      // exactly what the server stored.
      setDraft(createProfileDraft(updated));
    } catch {
      // A failed save keeps the marker (and the draft) untouched; the error
      // is rendered below.
    }
  }

  if (!session) {
    return (
      <div className="page">
        <PageMasthead title="Your profile" lede="Sign in to edit your shop." />
        <SignInPanel onSignedIn={setSession} />
      </div>
    );
  }

  if (profileQuery.isLoading || !draft) {
    return (
      <div className="page">
        <p>Loading your profile…</p>
      </div>
    );
  }

  if (profileQuery.error || !saved) {
    const notAProvider = profileQuery.error instanceof ApiError && profileQuery.error.code === "NOT_A_PROVIDER";
    return (
      <div className="page">
        <div className="banner" role="status">
          <p>{notAProvider ? "This account doesn't have a provider profile yet." : "Connection dropped. Try again."}</p>
        </div>
        <Link to="/providers/apply" className="button-primary" style={{ textDecoration: "none" }}>
          List your shop
        </Link>
      </div>
    );
  }

  const preview = previewProfileFromDraft(saved, draft);
  const serverDetails =
    updateProfile.error instanceof ApiError
      ? (updateProfile.error.details as Record<string, string> | undefined)
      : undefined;
  const previewHasErrors = Object.keys(preview.errors).length > 0;

  return (
    <div className="page">
      <PageMasthead
        eyebrow="Provider panel"
        title="Your profile"
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

      {dirty && (
        <p className="banner" role="status">
          You have unsaved changes.
        </p>
      )}

      {updateProfile.isError && !serverDetails && (
        <div className="banner banner--alert" role="alert">
          {updateProfile.error instanceof ApiError ? updateProfile.error.message : "Connection dropped. Try again."}
        </div>
      )}

      <div style={{ display: "flex", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
        <button type="button" className="button-secondary" onClick={() => setShowPreview(true)}>
          Preview the public profile
        </button>
        {previewHasErrors && (
          <span style={{ alignSelf: "center", fontSize: "var(--text-14)", color: "var(--color-text-secondary)" }}>
            The preview shows the same validation errors as the form.
          </span>
        )}
      </div>

      <form onSubmit={handleSave}>
        <div className="field">
          <label htmlFor="profile-title">Title</label>
          <input
            id="profile-title"
            value={draft.title}
            onChange={(event) => updateField("title", event.target.value)}
          />
          {(preview.errors.title ?? serverDetails?.title) && (
            <p className="banner banner--alert">{preview.errors.title ?? serverDetails?.title}</p>
          )}
        </div>
        <div className="field">
          <label htmlFor="profile-bio">Description</label>
          <textarea
            id="profile-bio"
            rows={4}
            value={draft.bio}
            onChange={(event) => updateField("bio", event.target.value)}
          />
          {(preview.errors.bio ?? serverDetails?.bio) && (
            <p className="banner banner--alert">{preview.errors.bio ?? serverDetails?.bio}</p>
          )}
        </div>
        <div className="field">
          <label htmlFor="profile-languages">Languages (comma separated)</label>
          <input
            id="profile-languages"
            value={draft.languages.join(", ")}
            onChange={(event) => updateField("languages", event.target.value.split(",").map((value) => value.trim()))}
          />
        </div>
        <div className="field">
          <label htmlFor="profile-location">How to find the shop</label>
          <input
            id="profile-location"
            value={draft.location}
            onChange={(event) => updateField("location", event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="profile-session-length">Session length (minutes)</label>
          <input
            id="profile-session-length"
            type="number"
            min={15}
            max={240}
            value={draft.sessionLengthMinutes}
            onChange={(event) => updateField("sessionLengthMinutes", Number(event.target.value))}
          />
        </div>
        <button type="submit" className="button-primary" disabled={updateProfile.isPending}>
          {updateProfile.isPending ? "Saving…" : "Save profile"}
        </button>
        {dirty && <span style={{ marginLeft: "var(--space-3)", fontSize: "var(--text-14)" }}>Unsaved</span>}
      </form>

      {showPreview && (
        <div className="modal-overlay" onClick={() => setShowPreview(false)}>
          <div className="modal-content" onClick={(event) => event.stopPropagation()}>
            <h2 style={{ marginTop: 0 }}>Public preview</h2>
            <p style={{ color: "var(--color-text-secondary)" }}>
              This is what a client sees, including your unsaved edits. Closing it saves nothing.
            </p>
            {previewHasErrors && (
              <div className="banner banner--alert" role="alert">
                <ul>
                  {Object.values(preview.errors).map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </div>
            )}
            <h3>{preview.displayName}</h3>
            <p>{preview.title}</p>
            <p>{preview.bio}</p>
            <p>Languages: {preview.languages.join(", ") || "—"}</p>
            <p>{preview.location}</p>
            <p>
              <TryAmount amount={preview.price.amount} /> · {formatSessionFormat(preview.sessionFormat)} ·{" "}
              {preview.sessionLengthMinutes} min
            </p>
            <p>
              Deposit: <TryAmount amount={preview.deposit.amount} />
            </p>
            <button type="button" className="button-secondary" onClick={() => setShowPreview(false)}>
              Close preview
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
