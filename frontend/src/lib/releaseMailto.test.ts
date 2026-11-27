import assert from "node:assert/strict";
import { test } from "node:test";

import { bookingProofUrl, buildReleaseMailto } from "./releaseMailto.js";

const SLOT = 1_789_574_400; // a fixed UTC epoch for stable formatting checks
const PROOF = "https://app.example/proof/booking-1";

test("buildReleaseMailto builds an encoded mailto for a released booking with email", () => {
  const href = buildReleaseMailto({
    escrowState: "released",
    clientEmail: "client@example.com",
    shopName: "North Barber",
    slotStartsAt: SLOT,
    proofUrl: PROOF,
  });

  assert.ok(href, "mailto must be present after release when email is set");
  assert.ok(href.startsWith("mailto:"), "must be a mailto URL");
  assert.ok(href.includes("client@example.com"));
  assert.ok(href.includes("subject="), "subject must be encoded as a query param");
  assert.ok(href.includes("body="), "body must be encoded as a query param");
  assert.ok(href.includes(encodeURIComponent("North Barber")), "draft names the shop");
  assert.ok(href.includes(encodeURIComponent(PROOF)), "draft includes the proof URL");
  // Spaces and newlines in the body must be percent-encoded, not raw.
  assert.equal(href.includes("\n"), false, "mailto body must be encoded");
  assert.ok(href.includes("%0A") || href.includes("%20"), "body encoding present");
});

test("buildReleaseMailto is absent before release even when email is present", () => {
  for (const escrowState of ["locked", "refunded", null] as const) {
    const href = buildReleaseMailto({
      escrowState,
      clientEmail: "client@example.com",
      shopName: "North Barber",
      slotStartsAt: SLOT,
      proofUrl: PROOF,
    });
    assert.equal(href, undefined, `mailto must be absent when escrowState is ${String(escrowState)}`);
  }
});

test("buildReleaseMailto is absent when released but client email is missing", () => {
  for (const clientEmail of [null, undefined, "", "   "] as const) {
    const href = buildReleaseMailto({
      escrowState: "released",
      clientEmail,
      shopName: "North Barber",
      slotStartsAt: SLOT,
      proofUrl: PROOF,
    });
    assert.equal(href, undefined, "mailto must be absent without a client email");
  }
});

test("buildReleaseMailto uses valid one-off recipient when provided", () => {
  const href = buildReleaseMailto({
    escrowState: "released",
    clientEmail: "stored@example.com",
    oneOffRecipient: "oneoff@example.com",
    shopName: "North Barber",
    slotStartsAt: SLOT,
    proofUrl: PROOF,
  });
  assert.ok(href?.includes("mailto:oneoff@example.com"), "must use one-off email");
  assert.ok(!href?.includes("stored@example.com"), "must not use stored email when one-off provided");
});

test("buildReleaseMailto falls back to stored email when one-off recipient is blank", () => {
  for (const oneOffRecipient of [undefined, null, "", "   "] as const) {
    const href = buildReleaseMailto({
      escrowState: "released",
      clientEmail: "stored@example.com",
      oneOffRecipient,
      shopName: "North Barber",
      slotStartsAt: SLOT,
      proofUrl: PROOF,
    });
    assert.ok(href?.includes("mailto:stored@example.com"), "must fall back to stored email");
  }
});

test("buildReleaseMailto refuses invalid email as one-off recipient", () => {
  for (const oneOffRecipient of ["notanemail", "invalid@", "@invalid.com", "foo@bar"] as const) {
    const href = buildReleaseMailto({
      escrowState: "released",
      clientEmail: "stored@example.com",
      oneOffRecipient,
      shopName: "North Barber",
      slotStartsAt: SLOT,
      proofUrl: PROOF,
    });
    assert.equal(href, undefined, `invalid email "${oneOffRecipient}" must be refused`);
  }
});

test("bookingProofUrl joins origin and booking id", () => {
  assert.equal(bookingProofUrl("abc123", "https://pactly.example/"), "https://pactly.example/proof/abc123");
  assert.equal(bookingProofUrl("abc123", "https://pactly.example"), "https://pactly.example/proof/abc123");
});
