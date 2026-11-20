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

test("bookingProofUrl joins origin and booking id", () => {
  assert.equal(bookingProofUrl("abc123", "https://pactly.example/"), "https://pactly.example/proof/abc123");
  assert.equal(bookingProofUrl("abc123", "https://pactly.example"), "https://pactly.example/proof/abc123");
});
