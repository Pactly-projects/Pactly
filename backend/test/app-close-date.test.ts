/**
 * Closing a whole date (this issue's hold-release slice): one active unpaid
 * hold on the date ends, a funded booking on the same date is left exactly
 * as it was, and a hold on the following week is untouched. Driven through
 * `app.request(...)` at the HTTP boundary like the other route tests; the
 * timezone/date maths is also exercised directly.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { getSlotByProviderAndStart, replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { getBookingById, insertBooking, updateEscrowState } from "../src/db/bookings.js";
import { localDateRange } from "../src/services/availability.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, randomBookingId, seedProviderProfile } from "./helpers.js";

const DAY_SECONDS = 24 * 60 * 60;
const PROVIDER_WALLET = "GPROVIDERWALLETFORDATECLOSURETSTS";
const CLIENT_HOLD = "GCLIENTWITHHOLDONDATETOCLOSE0001";
const CLIENT_FUNDED = "GCLIENTWITHFUNDEDBOOKINGTOCLOS01";
const CLIENT_NEXT_WEEK = "GCLIENTWITHHOLDNEXTWEEK00000001";

const FAKE_USDC_DEPS = {
  resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000" }),
};

async function bearer(walletAddress: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await issuePactlyJwt(walletAddress)}`, "content-type": "application/json" };
}

test("closing a date releases its unpaid hold but not a funded booking or next week's hold", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    // A real future UTC day, five days out, so every slot is in the future.
    const target = new Date((now + 5 * DAY_SECONDS) * 1000);
    target.setUTCHours(0, 0, 0, 0);
    const dayStart = Math.floor(target.getTime() / 1000);
    const date = target.toISOString().slice(0, 10);
    const slotHeld = dayStart + 10 * 3600;
    const slotFunded = dayStart + 12 * 3600;
    const slotNextWeek = dayStart + 7 * DAY_SECONDS + 10 * 3600;

    const providerProfileId = await seedProviderProfile(result, {
      walletAddress: PROVIDER_WALLET,
      displayName: "Closing Salon",
      sessionLengthMinutes: 30,
      isApproved: true,
    });

    await replaceFutureSlots(result.db, providerProfileId, [slotHeld, slotFunded, slotNextWeek]);

    // One active unpaid hold on the date being closed.
    const held = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: CLIENT_HOLD, slotStartsAt: slotHeld },
      FAKE_USDC_DEPS,
    );

    // One booking on the same date whose escrow is already funded.
    const fundedSlot = await getSlotByProviderAndStart(result.db, providerProfileId, slotFunded);
    assert.ok(fundedSlot);
    const fundedId = randomBookingId();
    await insertBooking(result.db, {
      id: fundedId,
      providerProfileId,
      clientWalletAddress: CLIENT_FUNDED,
      tokenAddress: "CTOKENFORTEST0000000000000000000000000000000000",
      depositAmount: "2000000",
      balanceAmount: "8000000",
      cancelDeadline: slotFunded - 3600,
      slotId: fundedSlot.id,
      holdExpiresAt: now + 600,
      createdAt: Date.now(),
    });
    await updateEscrowState(result.db, fundedId, "locked");
    const fundedBefore = (await getBookingById(result.db, fundedId))!;

    // A hold on the same time but the following week.
    const nextWeek = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: CLIENT_NEXT_WEEK, slotStartsAt: slotNextWeek },
      FAKE_USDC_DEPS,
    );

    const app = createApp(result.db);
    const provider = await bearer(PROVIDER_WALLET);
    const response = await app.request("/me/provider/availability/close-date", {
      method: "POST",
      headers: provider,
      body: JSON.stringify({ date, tzOffsetMinutes: 0 }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      date: string;
      releasedHoldCount: number;
      releasedBookingIds: string[];
      closedSlotCount: number;
      needsResolution: Array<{ bookingId: string; slotStartsAt: number }>;
    };
    assert.equal(body.date, date);
    assert.equal(body.releasedHoldCount, 1);
    assert.deepEqual(body.releasedBookingIds, [held.bookingId]);
    assert.equal(body.closedSlotCount, 1, "only the released date's open slot is removed");
    assert.deepEqual(body.needsResolution, [{ bookingId: fundedId, slotStartsAt: slotFunded }]);

    // The hold ended, and says why -- no deposit was taken (`escrowState` null).
    const heldAfter = (await getBookingById(result.db, held.bookingId))!;
    assert.equal(heldAfter.escrowState, null);
    assert.equal(heldAfter.holdReleaseReason, "shop-closed-date");
    assert.ok(heldAfter.holdReleasedAt !== null);
    assert.ok(heldAfter.holdExpiresAt !== null && heldAfter.holdExpiresAt <= Math.floor(Date.now() / 1000));

    // The funded booking is byte-for-byte untouched by this action.
    const fundedAfter = (await getBookingById(result.db, fundedId))!;
    assert.equal(fundedAfter.escrowState, "locked");
    assert.equal(fundedAfter.holdReleaseReason, null);
    assert.equal(fundedAfter.holdExpiresAt, fundedBefore.holdExpiresAt);

    // Next week's hold is not released.
    const nextWeekAfter = (await getBookingById(result.db, nextWeek.bookingId))!;
    assert.equal(nextWeekAfter.escrowState, null);
    assert.equal(nextWeekAfter.holdReleaseReason, null);
    assert.ok(nextWeekAfter.holdExpiresAt !== null && nextWeekAfter.holdExpiresAt > now);

    // Each affected client sees the reason on their own booking view and list.
    const heldView = await app.request(`/bookings/${held.bookingId}`, { headers: await bearer(CLIENT_HOLD) });
    assert.equal(heldView.status, 200);
    const heldViewBody = (await heldView.json()) as { escrowState: string | null; holdReleasedReason: string | null };
    assert.equal(heldViewBody.escrowState, null);
    assert.equal(heldViewBody.holdReleasedReason, "shop-closed-date");

    const myBookings = await app.request("/me/bookings", { headers: await bearer(CLIENT_HOLD) });
    const myBookingsBody = (await myBookings.json()) as { bookings: Array<{ id: string; holdReleasedReason: string | null }> };
    const heldListItem = myBookingsBody.bookings.find((booking) => booking.id === held.bookingId);
    assert.equal(heldListItem?.holdReleasedReason, "shop-closed-date");

    // The funded client's booking still loads with its escrow state intact.
    const fundedView = await app.request(`/bookings/${fundedId}`, { headers: await bearer(CLIENT_FUNDED) });
    assert.equal(fundedView.status, 200);
    assert.equal(((await fundedView.json()) as { escrowState: string | null }).escrowState, "locked");

    // The closed date's slot is gone from the shop's own grid; next week's
    // slot is still there (it is merely held, so the public view hides it).
    const ownProfile = await app.request("/me/provider", { headers: provider });
    const ownSlots = ((await ownProfile.json()) as { slots: number[] }).slots;
    assert.equal(ownSlots.includes(slotHeld), false);
    assert.equal(ownSlots.includes(slotNextWeek), true);

    // Re-closing, or closing a date with no holds at all, succeeds.
    const again = await app.request("/me/provider/availability/close-date", {
      method: "POST",
      headers: provider,
      body: JSON.stringify({ date, tzOffsetMinutes: 0 }),
    });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { releasedHoldCount: number }).releasedHoldCount, 0);

    const emptyDate = new Date((dayStart + 2 * DAY_SECONDS) * 1000).toISOString().slice(0, 10);
    const empty = await app.request("/me/provider/availability/close-date", {
      method: "POST",
      headers: provider,
      body: JSON.stringify({ date: emptyDate, tzOffsetMinutes: 0 }),
    });
    assert.equal(empty.status, 200);
    const emptyBody = (await empty.json()) as { releasedHoldCount: number; closedSlotCount: number };
    assert.equal(emptyBody.releasedHoldCount, 0);
    assert.equal(emptyBody.closedSlotCount, 0);
  } finally {
    closeDatabase(result);
  }
});

test("a local calendar date becomes the right UTC window, and bad dates are refused", async () => {
  // UTC+3 (Istanbul): local midnight is 21:00 UTC the previous day.
  const utcPlus3 = localDateRange("2026-11-21", -180);
  assert.equal(utcPlus3.rangeStart, Date.UTC(2026, 10, 20, 21, 0, 0) / 1000);
  assert.equal(utcPlus3.rangeEnd - utcPlus3.rangeStart, DAY_SECONDS);
  assert.equal(localDateRange("2026-11-21").rangeStart, Date.UTC(2026, 10, 21) / 1000);

  for (const date of ["21-11-2026", "2026-02-30", "2026-13-01", ""]) {
    assert.throws(() => localDateRange(date), /valid date|does not exist/i, `expected ${date} to be refused`);
  }

  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { walletAddress: PROVIDER_WALLET, isApproved: true });
    const app = createApp(result.db);
    const provider = await bearer(PROVIDER_WALLET);
    const invalid = await app.request("/me/provider/availability/close-date", {
      method: "POST",
      headers: provider,
      body: JSON.stringify({ date: "2026-02-30", tzOffsetMinutes: 0 }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { code: string }).code, "INVALID_DATE");

    const notProvider = await app.request("/me/provider/availability/close-date", {
      method: "POST",
      headers: await bearer("GNOTAPROVIDERWALLETFORDATECLOSE00001"),
      body: JSON.stringify({ date: "2026-11-21", tzOffsetMinutes: 0 }),
    });
    assert.equal(notProvider.status, 404);
    assert.equal(((await notProvider.json()) as { code: string }).code, "NOT_A_PROVIDER");
    assert.ok(providerProfileId);
  } finally {
    closeDatabase(result);
  }
});
