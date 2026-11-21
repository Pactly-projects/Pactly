/**
 * Rescheduling a locked booking: inside the free-cancellation window the
 * same booking (and the same escrow) moves to another open slot of the same
 * shop. Outside the window, and for a slot another client has taken, the
 * move is refused and the booking is unchanged. Driven through
 * `app.request(...)` at the HTTP boundary like the other booking tests.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { getSlotByProviderAndStart, replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { getBookingById, updateEscrowContractId, updateEscrowState } from "../src/db/bookings.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const DAY_SECONDS = 24 * 60 * 60;
const PROVIDER_WALLET = "GPROVIDERWALLETFORSCHEDULERESTS01";
const OTHER_PROVIDER_WALLET = "GPROVIDERWALLETFORSCHEDULERESTS02";
const CLIENT_MOVING = "GCLIENTMOVINGWITHINFREEWINDOW00001";
const CLIENT_OUTSIDE = "GCLIENTOUTSIDEFREEWINDOW000000001";
const CLIENT_TAKER = "GCLIENTTHATTAKESTHENEWSLOT00001";
const STRANGER = "GSTRANGERWITHNOBOOKINGFORTESTS001";
const CONTRACT_ID = "CINSIDECONTRACTIDSTAYSTHESAME000000000000000000000000000000";

const FAKE_USDC_DEPS = {
  resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000" }),
};

async function bearer(walletAddress: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await issuePactlyJwt(walletAddress)}`, "content-type": "application/json" };
}

test("a locked booking moves inside the window, keeping its escrow, and is refused outside it", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const tomorrow = new Date((now + DAY_SECONDS) * 1000);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const dayStart = Math.floor(tomorrow.getTime() / 1000);

    const slotOld = dayStart + 3 * DAY_SECONDS + 10 * 3600;
    const slotNew = dayStart + 4 * DAY_SECONDS + 11 * 3600;
    const slotOutsideOld = dayStart + 10 * 3600; // ~1 day out; a 48h window has already closed
    const slotOutsideNew = dayStart + DAY_SECONDS + 10 * 3600;
    const slotTaken = dayStart + 5 * DAY_SECONDS + 10 * 3600;
    const slotOtherProvider = dayStart + 6 * DAY_SECONDS + 10 * 3600;

    const providerProfileId = await seedProviderProfile(result, {
      walletAddress: PROVIDER_WALLET,
      displayName: "Reschedule Salon",
      cancellationWindowHours: 48,
      sessionLengthMinutes: 60,
      isApproved: true,
    });
    await replaceFutureSlots(result.db, providerProfileId, [slotOld, slotNew, slotOutsideOld, slotOutsideNew, slotTaken]);

    const otherProviderProfileId = await seedProviderProfile(result, {
      walletAddress: OTHER_PROVIDER_WALLET,
      displayName: "Someone Else",
      cancellationWindowHours: 24,
      sessionLengthMinutes: 60,
      isApproved: true,
    });
    await replaceFutureSlots(result.db, otherProviderProfileId, [slotOtherProvider]);

    // The booking that will move, locked inside its window.
    const moving = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: CLIENT_MOVING, slotStartsAt: slotOld },
      FAKE_USDC_DEPS,
    );
    await updateEscrowContractId(result.db, moving.bookingId, CONTRACT_ID);
    await updateEscrowState(result.db, moving.bookingId, "locked");
    const before = (await getBookingById(result.db, moving.bookingId))!;

    // A second locked booking whose 48h window is already past.
    const outside = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: CLIENT_OUTSIDE, slotStartsAt: slotOutsideOld },
      FAKE_USDC_DEPS,
    );
    await updateEscrowContractId(result.db, outside.bookingId, "COUTSIDECONTRACTID0000000000000000000000000000000000000000");
    await updateEscrowState(result.db, outside.bookingId, "locked");
    const outsideBefore = (await getBookingById(result.db, outside.bookingId))!;

    // Another client is holding the slot the moving client will try second.
    const taken = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: CLIENT_TAKER, slotStartsAt: slotTaken },
      FAKE_USDC_DEPS,
    );

    const app = createApp(result.db);
    const movingHeaders = await bearer(CLIENT_MOVING);

    const moved = await app.request(`/bookings/${moving.bookingId}/reschedule`, {
      method: "POST",
      headers: movingHeaders,
      body: JSON.stringify({ slotStartsAt: slotNew }),
    });
    assert.equal(moved.status, 200);
    const movedBody = (await moved.json()) as {
      id: string;
      escrowState: string | null;
      slotStartsAt: number;
      cancelDeadline: number;
      contractId: string | null;
      deposit: { amount: string };
      balance: { amount: string };
      provider: { id: string };
    };
    assert.equal(movedBody.id, moving.bookingId);
    assert.equal(movedBody.escrowState, "locked");
    assert.equal(movedBody.slotStartsAt, slotNew);
    assert.equal(movedBody.cancelDeadline, slotNew - 48 * 3600);
    assert.equal(movedBody.contractId, CONTRACT_ID, "the escrow contract id is unchanged");
    assert.equal(movedBody.deposit.amount, before.depositAmount);
    assert.equal(movedBody.balance.amount, before.balanceAmount);
    assert.equal(movedBody.provider.id, providerProfileId, "same shop");

    const after = (await getBookingById(result.db, moving.bookingId))!;
    const newSlot = await getSlotByProviderAndStart(result.db, providerProfileId, slotNew);
    assert.ok(newSlot);
    assert.equal(after.slotId, newSlot.id, "the new slot is the booking's slot");
    assert.equal(after.escrowContractId, before.escrowContractId, "no second escrow was deployed");
    assert.equal(after.depositAmount, before.depositAmount);
    assert.equal(after.balanceAmount, before.balanceAmount);
    assert.equal(after.clientWalletAddress, before.clientWalletAddress);
    assert.equal(after.providerProfileId, before.providerProfileId);
    assert.equal(after.cancelDeadline, slotNew - 48 * 3600);

    // The old slot is available again; the new one is taken by this booking.
    const publicProfile = await app.request(`/providers/${providerProfileId}`);
    const openSlots = ((await publicProfile.json()) as { slots: number[] }).slots;
    assert.equal(openSlots.includes(slotOld), true, "the old slot became available");
    assert.equal(openSlots.includes(slotNew), false, "the new slot is now the booking's");

    // Outside the free-cancellation window: refused, nothing changes.
    const refused = await app.request(`/bookings/${outside.bookingId}/reschedule`, {
      method: "POST",
      headers: await bearer(CLIENT_OUTSIDE),
      body: JSON.stringify({ slotStartsAt: slotOutsideNew }),
    });
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code: string }).code, "CANCELLATION_WINDOW_CLOSED");
    const outsideAfter = (await getBookingById(result.db, outside.bookingId))!;
    assert.equal(outsideAfter.slotId, outsideBefore.slotId);
    assert.equal(outsideAfter.cancelDeadline, outsideBefore.cancelDeadline);

    // A slot another client took between the click and the write: refused, no overwrite.
    const takenRefusal = await app.request(`/bookings/${moving.bookingId}/reschedule`, {
      method: "POST",
      headers: movingHeaders,
      body: JSON.stringify({ slotStartsAt: slotTaken }),
    });
    assert.equal(takenRefusal.status, 409);
    assert.equal(((await takenRefusal.json()) as { code: string }).code, "SLOT_UNAVAILABLE");
    const stillOnNewSlot = (await getBookingById(result.db, moving.bookingId))!;
    assert.equal(stillOnNewSlot.slotId, newSlot.id);
    const takenStillHeld = (await getBookingById(result.db, taken.bookingId))!;
    assert.equal(takenStillHeld.slotId, (await getSlotByProviderAndStart(result.db, providerProfileId, slotTaken))!.id);

    // A slot of a different shop never matches.
    const otherShop = await app.request(`/bookings/${moving.bookingId}/reschedule`, {
      method: "POST",
      headers: movingHeaders,
      body: JSON.stringify({ slotStartsAt: slotOtherProvider }),
    });
    assert.equal(otherShop.status, 409);
    assert.equal(((await otherShop.json()) as { code: string }).code, "SLOT_UNAVAILABLE");

    // Only the booking's own client may move it.
    const stranger = await app.request(`/bookings/${moving.bookingId}/reschedule`, {
      method: "POST",
      headers: await bearer(STRANGER),
      body: JSON.stringify({ slotStartsAt: slotOld }),
    });
    assert.equal(stranger.status, 404);
    assert.equal(((await stranger.json()) as { code: string }).code, "BOOKING_NOT_FOUND");

    // Repeating the same move is an idempotent success (the slot is already its own).
    const again = await app.request(`/bookings/${moving.bookingId}/reschedule`, {
      method: "POST",
      headers: movingHeaders,
      body: JSON.stringify({ slotStartsAt: slotNew }),
    });
    assert.equal(again.status, 200);
  } finally {
    closeDatabase(result);
  }
});

test("a missing or non-integer slotStartsAt is a 400", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { walletAddress: PROVIDER_WALLET, isApproved: true });
    const now = Math.floor(Date.now() / 1000);
    const slotStartsAt = now + 2 * DAY_SECONDS;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const booking = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: CLIENT_MOVING, slotStartsAt },
      FAKE_USDC_DEPS,
    );

    const app = createApp(result.db);
    const headers = await bearer(CLIENT_MOVING);
    for (const body of [{}, { slotStartsAt: "tomorrow" }, { slotStartsAt: 1.5 }]) {
      const response = await app.request(`/bookings/${booking.bookingId}/reschedule`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
  } finally {
    closeDatabase(result);
  }
});
