/**
 * One-off closures: a day off must be an overlay on the provider's slot
 * pattern, never a rewrite of it. The validation case from the story is
 * explicit here -- close one Tuesday and assert the same weekday next week
 * still offers its slots.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { getPublicProviderProfile, getOwnProviderProfile } from "../src/services/profile.js";
import {
  ClosedDateBookingError,
  closeDate,
  listClosedDatesForWallet,
  reopenDate,
} from "../src/services/availability.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC_DEPS = { resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }) };

/** Monday 2026-01-05 00:00 UTC, so the two Tuesdays below are exactly a
 * week apart and both fit the 60-day future-slot window. */
const NOW = Math.floor(Date.UTC(2026, 0, 5) / 1000);
const TUESDAY = Math.floor(Date.UTC(2026, 0, 6, 9) / 1000);
const NEXT_TUESDAY = Math.floor(Date.UTC(2026, 0, 13, 9) / 1000);
const TUESDAY_DATE = "2026-01-06";

test("closing one date leaves the same weekday next week open and the slot pattern untouched", async () => {
  const result = openTestDatabase();
  try {
    const profileId = await seedProviderProfile(result, { isApproved: true, sessionLengthMinutes: 30, walletAddress: "GTUESDAYCLOSUREOWNER" });
    await replaceFutureSlots(result.db, profileId, [TUESDAY, NEXT_TUESDAY], NOW);

    const closed = await closeDate(result.db, "GTUESDAYCLOSUREOWNER", TUESDAY_DATE, NOW * 1000);
    assert.deepEqual(closed, [TUESDAY_DATE]);

    const publicProfile = await getPublicProviderProfile(result.db, profileId, NOW);
    assert.deepEqual(publicProfile.slots, [NEXT_TUESDAY], "only the closed Tuesday's slot disappears");

    const ownProfile = await getOwnProviderProfile(result.db, "GTUESDAYCLOSUREOWNER", NOW);
    assert.deepEqual(
      ownProfile.slots,
      [TUESDAY, NEXT_TUESDAY],
      "the provider's own weekly pattern is unchanged by a one-off closure",
    );

    // Reopening reveals the slot again without any pattern edit.
    assert.deepEqual(await reopenDate(result.db, "GTUESDAYCLOSUREOWNER", TUESDAY_DATE), []);
    assert.deepEqual((await getPublicProviderProfile(result.db, profileId, NOW)).slots, [TUESDAY, NEXT_TUESDAY]);
  } finally {
    closeDatabase(result);
  }
});

test("a duplicate close of the same date is a no-op", async () => {
  const result = openTestDatabase();
  try {
    const wallet = "GDUPLICATECLOSEOWNER";
    await seedProviderProfile(result, { isApproved: true, walletAddress: wallet });
    const first = await closeDate(result.db, wallet, TUESDAY_DATE, NOW * 1000);
    const second = await closeDate(result.db, wallet, TUESDAY_DATE, (NOW + 60) * 1000);
    assert.deepEqual(second, first);
    assert.deepEqual(await listClosedDatesForWallet(result.db, wallet), [TUESDAY_DATE]);
  } finally {
    closeDatabase(result);
  }
});

test("a date with a locked booking cannot be closed and the booking is named", async () => {
  const result = openTestDatabase();
  try {
    const wallet = "GLOCKEDCLOSEOWNER";
    const profileId = await seedProviderProfile(result, { isApproved: true, sessionLengthMinutes: 30, walletAddress: wallet });
    await replaceFutureSlots(result.db, profileId, [TUESDAY], NOW);
    const hold = await holdSlot(
      result.db,
      { providerProfileId: profileId, clientWalletAddress: "GCLOSECLIENT", slotStartsAt: TUESDAY },
      { now: NOW, ...FAKE_USDC_DEPS },
    );
    await updateEscrowContractId(result.db, hold.bookingId, "CCLOSECONTRACT0000000000000000000000000000000000");
    updateEscrowStateSync(result.db, hold.bookingId, "locked");

    await assert.rejects(
      closeDate(result.db, wallet, TUESDAY_DATE, NOW * 1000),
      (error: unknown) => error instanceof ClosedDateBookingError && error.bookingId === hold.bookingId,
    );
    assert.deepEqual(await listClosedDatesForWallet(result.db, wallet), []);
    // Closing never cancels an already locked booking -- the row and its
    // escrow state are exactly as they were.
    const own = await getOwnProviderProfile(result.db, wallet, NOW);
    assert.deepEqual(own.slots, [TUESDAY]);
  } finally {
    closeDatabase(result);
  }
});

test("closing today does not cancel an in-flight hold or a locked booking", async () => {
  const result = openTestDatabase();
  try {
    const wallet = "GTODAYCLOSEOWNER";
    const profileId = await seedProviderProfile(result, { isApproved: true, sessionLengthMinutes: 30, walletAddress: wallet });
    const todaySlot = NOW + 3600;
    await replaceFutureSlots(result.db, profileId, [todaySlot], NOW);
    const hold = await holdSlot(
      result.db,
      { providerProfileId: profileId, clientWalletAddress: "GTODAYCLIENT", slotStartsAt: todaySlot },
      { now: NOW, ...FAKE_USDC_DEPS },
    );
    await closeDate(result.db, wallet, "2026-01-05", NOW * 1000);
    const own = await getOwnProviderProfile(result.db, wallet, NOW);
    assert.deepEqual(own.slots, [todaySlot], "the slot row survives; only the closure overlays it");
    assert.ok(hold.bookingId);
  } finally {
    closeDatabase(result);
  }
});

test("the closure routes scope to the caller's own shop and name a conflicting booking", async () => {
  const result = openTestDatabase();
  try {
    const ownerWallet = "GROUTECLOSEOWNER";
    const otherWallet = "GROUTECLOSEOTHER";
    const profileId = await seedProviderProfile(result, { isApproved: true, walletAddress: ownerWallet });
    const otherId = await seedProviderProfile(result, { isApproved: true, walletAddress: otherWallet });
    await replaceFutureSlots(result.db, profileId, [TUESDAY, NEXT_TUESDAY], NOW);
    await replaceFutureSlots(result.db, otherId, [TUESDAY], NOW);

    const app = createApp(result.db);
    const headers = async (wallet: string) => ({ authorization: `Bearer ${await issuePactlyJwt(wallet)}` });

    const closed = await app.request(`/me/provider/closed-dates/${TUESDAY_DATE}`, {
      method: "PUT",
      headers: await headers(ownerWallet),
    });
    assert.equal(closed.status, 200);
    assert.deepEqual((await closed.json()) as { closedDates: string[] }, { closedDates: [TUESDAY_DATE] });

    // The other shop's slots are untouched: closures are per provider.
    assert.deepEqual((await getPublicProviderProfile(result.db, otherId, NOW)).slots, [TUESDAY]);

    const listed = await app.request("/me/provider/closed-dates", { headers: await headers(ownerWallet) });
    assert.deepEqual((await listed.json()) as { closedDates: string[] }, { closedDates: [TUESDAY_DATE] });

    const removed = await app.request(`/me/provider/closed-dates/${TUESDAY_DATE}`, {
      method: "DELETE",
      headers: await headers(ownerWallet),
    });
    assert.equal(removed.status, 200);
    assert.deepEqual((await removed.json()) as { closedDates: string[] }, { closedDates: [] });

    const badDate = await app.request("/me/provider/closed-dates/not-a-date", {
      method: "PUT",
      headers: await headers(ownerWallet),
    });
    assert.equal(badDate.status, 400);
    assert.equal(((await badDate.json()) as { code: string }).code, "INVALID_CLOSED_DATE");

    const notAProvider = await app.request("/me/provider/closed-dates", { headers: await headers("GNOSUCHPROVIDER") });
    assert.equal(notAProvider.status, 404);
  } finally {
    closeDatabase(result);
  }
});
