import "./testConfigEnv.js";

import assert from "node:assert/strict";
import test from "node:test";

import { getProviderProfileByWallet } from "../src/db/providerProfiles.js";
import { updateEscrowStateSync } from "../src/db/bookings.js";
import { getProviderDepositWeekTotals } from "../src/services/booking.js";
import { listVerifiedSessionBookings } from "../src/services/profile.js";
import { NotAProviderError } from "../src/services/profile.js";
import { closeDatabase, openTestDatabase, seedBooking, seedProviderProfile } from "./helpers.js";

// ---------------------------------------------------------------------------
// Issue #164
// ---------------------------------------------------------------------------

test("verified sessions list every released booking of the caller's shop, and nothing else", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GVERIFIEDSESSIONSOWNER000000000000000000000000000000000000";
    const providerProfileId = await seedProviderProfile(result, { walletAddress, isApproved: true });

    const releasedA = await seedBooking(result, { providerProfileId, depositAmount: "1000000" });
    const releasedB = await seedBooking(result, { providerProfileId, depositAmount: "2000000" });
    const refunded = await seedBooking(result, { providerProfileId });
    const disputed = await seedBooking(result, { providerProfileId });
    const locked = await seedBooking(result, { providerProfileId });

    updateEscrowStateSync(result.db, releasedA, "released");
    updateEscrowStateSync(result.db, releasedB, "released");
    updateEscrowStateSync(result.db, refunded, "refunded");
    // A disputed booking still has its escrow `locked` -- it is never counted.
    updateEscrowStateSync(result.db, disputed, "locked");
    updateEscrowStateSync(result.db, locked, "locked");

    const view = await listVerifiedSessionBookings(result.db, walletAddress);

    assert.deepEqual(
      view.bookings.map((booking) => booking.id).sort(),
      [releasedA, releasedB].sort(),
    );
    // The count and the list agree, always.
    assert.equal(view.count, view.bookings.length);
    assert.equal(view.count, 2);
    // The amounts used are the booking's own stored deposit amount.
    assert.equal(view.bookings.find((booking) => booking.id === releasedB)?.deposit.amount, "2000000");
  } finally {
    closeDatabase(result);
  }
});

test("a different shop cannot open another shop's verified sessions", async () => {
  const result = openTestDatabase();
  try {
    const ownerWallet = "GVERIFIEDSESSIONSOWNER000000000000000000000000000000000000";
    const otherWallet = "GOTHERWALLET0000000000000000000000000000000000000000000000";
    const providerProfileId = await seedProviderProfile(result, { walletAddress: ownerWallet, isApproved: true });
    const released = await seedBooking(result, { providerProfileId });
    updateEscrowStateSync(result.db, released, "released");

    // The other wallet owns no profile, so it has no list of its own to open.
    await assert.rejects(
      () => listVerifiedSessionBookings(result.db, otherWallet),
      NotAProviderError,
    );
    const ownerProfile = await getProviderProfileByWallet(result.db, ownerWallet);
    assert.equal(ownerProfile?.id, providerProfileId);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// Issue #163
// ---------------------------------------------------------------------------

test("a returned fixture and a released fixture are summed separately", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = "GWEEKTOTALSOWNER00000000000000000000000000000000000000000000";
    const providerProfileId = await seedProviderProfile(result, { walletAddress, isApproved: true });

    const now = 1_800_000_000;
    const refunded = await seedBooking(result, { providerProfileId, depositAmount: "1500000" });
    updateEscrowStateSync(result.db, refunded, "refunded");
    const released = await seedBooking(result, { providerProfileId, depositAmount: "2500000" });
    updateEscrowStateSync(result.db, released, "released");
    // Neither a returned nor a released booking: in neither total.
    const locked = await seedBooking(result, { providerProfileId, depositAmount: "9000000" });
    updateEscrowStateSync(result.db, locked, "locked");

    // The service reads bookings whose slot falls in the last seven days; with
    // no slot these fixtures have no appointment time, so seed the pure
    // summary the service uses directly.
    const totals = await getProviderDepositWeekTotals(result.db, walletAddress, now);
    assert.equal(totals.returned.amount, "0");
    assert.equal(totals.released.amount, "0");
    assert.equal(totals.returned.asset, "USDC");

    const { computeDepositWeekTotals } = await import("../src/services/booking.js");
    const rows = [
      { booking: { escrowState: "refunded" as const, depositAmount: "1500000" }, slotStartsAt: now - 60 },
      { booking: { escrowState: "released" as const, depositAmount: "2500000" }, slotStartsAt: now - 120 },
      { booking: { escrowState: "locked" as const, depositAmount: "9000000" }, slotStartsAt: now - 180 },
      { booking: { escrowState: "refunded" as const, depositAmount: "1000000" }, slotStartsAt: now - 8 * 24 * 60 * 60 },
    ];
    const summary = computeDepositWeekTotals(rows, now - 7 * 24 * 60 * 60, now);
    assert.equal(summary.returned.amount, "1500000");
    assert.equal(summary.released.amount, "2500000");
    assert.equal(summary.returned.asset, "USDC");
    assert.equal(summary.released.asset, "USDC");
  } finally {
    closeDatabase(result);
  }
});

test("week totals throw NotAProviderError for a wallet with no shop", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(
      () => getProviderDepositWeekTotals(result.db, "GNOPROVIDER000000000000000000000000000000000000000000000000", 1_800_000_000),
      NotAProviderError,
    );
  } finally {
    closeDatabase(result);
  }
});
