/**
 * Appointment buffer: after a locked booking ends, slots that start inside
 * the configured buffer are not offered. Weekly hours and locked bookings
 * themselves are never rewritten by this filter.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

import {
  filterSlotsOutsideAppointmentBuffer,
  isSlotInsideBufferAfterLocked,
} from "../src/services/availability.js";
import { getPublicProviderProfile, updateProviderRules } from "../src/services/profile.js";
import { holdSlot } from "../src/services/booking.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC_DEPS = {
  resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }),
};

test("filterSlotsOutsideAppointmentBuffer: 30 minute buffer removes the slot that starts 15 minutes after a locked booking", () => {
  const lockedStartsAt = 1_000_000;
  const sessionLengthMinutes = 60;
  // 15 minutes after the locked session ends.
  const afterFifteen = lockedStartsAt + sessionLengthMinutes * 60 + 15 * 60;
  const afterFortyFive = lockedStartsAt + sessionLengthMinutes * 60 + 45 * 60;

  const filtered = filterSlotsOutsideAppointmentBuffer(
    [afterFifteen, afterFortyFive],
    [lockedStartsAt],
    sessionLengthMinutes,
    30,
  );

  assert.deepEqual(filtered, [afterFortyFive]);
  assert.equal(isSlotInsideBufferAfterLocked(afterFifteen, lockedStartsAt, sessionLengthMinutes, 30), true);
  assert.equal(isSlotInsideBufferAfterLocked(afterFortyFive, lockedStartsAt, sessionLengthMinutes, 30), false);
});

test("filterSlotsOutsideAppointmentBuffer: buffer of zero keeps adjacent slots", () => {
  const lockedStartsAt = 1_000_000;
  const sessionLengthMinutes = 60;
  const adjacent = lockedStartsAt + sessionLengthMinutes * 60;

  assert.deepEqual(
    filterSlotsOutsideAppointmentBuffer([adjacent], [lockedStartsAt], sessionLengthMinutes, 0),
    [adjacent],
  );
});

test("getPublicProviderProfile omits a slot inside the buffer after a locked booking", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, {
      walletAddress,
      isApproved: true,
      sessionLengthMinutes: 60,
    });
    await updateProviderRules(result.db, walletAddress, {
      priceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
      bufferMinutes: 30,
    });

    const now = 1_000_000;
    const lockedStart = now + 3600;
    const insideBuffer = lockedStart + 60 * 60 + 15 * 60;
    const outsideBuffer = lockedStart + 60 * 60 + 45 * 60;
    await replaceFutureSlots(result.db, providerProfileId, [lockedStart, insideBuffer, outsideBuffer], now);

    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt: lockedStart },
      { now, resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset },
    );
    await updateEscrowContractId(result.db, hold.bookingId, "CFAKECONTRACT000000000000000000000000000000000000");
    updateEscrowStateSync(result.db, hold.bookingId, "locked");

    const profile = await getPublicProviderProfile(result.db, providerProfileId, now);
    assert.equal(profile.bufferMinutes, 30);
    assert.deepEqual(profile.slots, [outsideBuffer]);
  } finally {
    closeDatabase(result);
  }
});

test("appointment buffer does not apply across two different shops", async () => {
  const result = openTestDatabase();
  try {
    const shopAWallet = Keypair.random().publicKey();
    const shopBWallet = Keypair.random().publicKey();
    const shopA = await seedProviderProfile(result, {
      walletAddress: shopAWallet,
      isApproved: true,
      sessionLengthMinutes: 60,
      displayName: "Shop A",
    });
    const shopB = await seedProviderProfile(result, {
      walletAddress: shopBWallet,
      isApproved: true,
      sessionLengthMinutes: 60,
      displayName: "Shop B",
    });
    await updateProviderRules(result.db, shopBWallet, {
      priceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
      bufferMinutes: 30,
    });

    const now = 1_000_000;
    const lockedStart = now + 3600;
    const candidate = lockedStart + 60 * 60 + 15 * 60;
    await replaceFutureSlots(result.db, shopA, [lockedStart], now);
    await replaceFutureSlots(result.db, shopB, [candidate], now);

    const hold = await holdSlot(
      result.db,
      { providerProfileId: shopA, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt: lockedStart },
      { now, resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset },
    );
    await updateEscrowContractId(result.db, hold.bookingId, "CFAKECONTRACT000000000000000000000000000000000000");
    updateEscrowStateSync(result.db, hold.bookingId, "locked");

    const profileB = await getPublicProviderProfile(result.db, shopB, now);
    assert.deepEqual(profileB.slots, [candidate]);
  } finally {
    closeDatabase(result);
  }
});
