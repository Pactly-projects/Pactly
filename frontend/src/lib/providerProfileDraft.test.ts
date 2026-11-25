import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createProfileDraft,
  isProfileDirty,
  previewProfileFromDraft,
  validateProfileDraft,
  type ProfileDraftSource,
} from "./providerProfileDraft.js";

const FIXTURE: ProfileDraftSource = {
  displayName: "Ada's Studio",
  title: "Portrait sessions",
  bio: "Natural-light portraits.",
  languages: ["English", "Turkish"],
  location: "Kadıköy, Istanbul",
  sessionFormat: "in_person",
  sessionLengthMinutes: 60,
  price: { amount: "50000000", asset: "USDC" },
  deposit: { amount: "10000000", asset: "USDC" },
};

// ---------------------------------------------------------------------------
// Issue #166: the unsaved marker
// ---------------------------------------------------------------------------

test("opening the editor does not mark the profile unsaved", () => {
  const draft = createProfileDraft(FIXTURE);
  assert.equal(isProfileDirty(draft, FIXTURE), false);
});

test("changing the fixture name's title marks the profile unsaved", () => {
  const draft = { ...createProfileDraft(FIXTURE), title: "Portrait sessions, edited" };
  assert.equal(isProfileDirty(draft, FIXTURE), true);
});

test("a successful save clears the marker", () => {
  const draft = { ...createProfileDraft(FIXTURE), bio: "A new description." };
  assert.equal(isProfileDirty(draft, FIXTURE), true);
  // The save returns the saved profile; the draft is re-seeded from it.
  const saved = { ...FIXTURE, bio: draft.bio };
  assert.equal(isProfileDirty(createProfileDraft(saved), saved), false);
});

test("a failed save keeps the marker (the saved profile is unchanged)", () => {
  const draft = { ...createProfileDraft(FIXTURE), location: "Beşiktaş, Istanbul" };
  // No successful response means `saved` still holds the original values.
  assert.equal(isProfileDirty(draft, FIXTURE), true);
});

// ---------------------------------------------------------------------------
// Issue #165: the preview
// ---------------------------------------------------------------------------

test("the preview renders the unsaved values and never saves", () => {
  const draft = { ...createProfileDraft(FIXTURE), title: "Unsaved title", location: "Unsaved place" };
  const preview = previewProfileFromDraft(FIXTURE, draft);

  assert.equal(preview.title, "Unsaved title");
  assert.equal(preview.location, "Unsaved place");
  assert.deepEqual(preview.errors, {});
  // The preview is a pure value; nothing here can have called a save.
  assert.equal("intakeAnswers" in preview, false);
  assert.equal("privateContact" in preview, false);
});

test("the preview shows a validation error as well as the form", () => {
  const draft = { ...createProfileDraft(FIXTURE), title: "   " };
  const preview = previewProfileFromDraft(FIXTURE, draft);

  assert.equal(preview.errors.title, "Title is required.");
  assert.equal(
    validateProfileDraft(draft).title,
    "Title is required.",
  );
});
