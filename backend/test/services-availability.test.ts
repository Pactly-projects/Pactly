/**
 * Issue #52: Tests for weekly availability range overlap validation.
 * Appointment buffer: after a locked booking ends, slots that start inside
 * the configured buffer are not offered. Weekly hours and locked bookings
 * themselves are never rewritten by this filter.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateWeeklyRanges,
  formatOverlapErrors,
  WeeklyRangeOverlapError,
  type WeeklyTimeRange,
  type OverlapError,
} from "../src/services/availability.js";

test("validateWeeklyRanges rejects overlapping ranges on the same weekday", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 1, startMinutes: 660, endMinutes: 780 }, // Monday 11:00-13:00
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.weekday, 1);
  assert.equal(errors[0]!.range1.start, "09:00");
  assert.equal(errors[0]!.range1.end, "12:00");
  assert.equal(errors[0]!.range2.start, "11:00");
  assert.equal(errors[0]!.range2.end, "13:00");
});

test("validateWeeklyRanges accepts non-overlapping ranges on the same weekday", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 1, startMinutes: 780, endMinutes: 1020 }, // Monday 13:00-17:00
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 0);
});

test("validateWeeklyRanges treats touching ranges as overlaps", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 1, startMinutes: 720, endMinutes: 780 }, // Monday 12:00-13:00 (starts exactly when first ends)
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.weekday, 1);
});

test("validateWeeklyRanges allows same clock times on different weekdays", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 2, startMinutes: 540, endMinutes: 720 }, // Tuesday 09:00-12:00
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 0);
});

test("validateWeeklyRanges detects multiple overlaps", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 1, startMinutes: 660, endMinutes: 780 }, // Monday 11:00-13:00
    { weekday: 1, startMinutes: 700, endMinutes: 800 }, // Monday 11:40-13:20
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  // Should find 3 overlaps: (1,2), (1,3), (2,3)
  assert.equal(errors.length, 3);
});

test("validateWeeklyRanges handles ranges that fully contain another", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 780 }, // Monday 09:00-13:00
    { weekday: 1, startMinutes: 600, endMinutes: 720 }, // Monday 10:00-12:00 (fully inside first)
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 1);
});

test("validateWeeklyRanges returns empty array for valid ranges", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 0, startMinutes: 480, endMinutes: 600 }, // Sunday 08:00-10:00
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 1, startMinutes: 780, endMinutes: 900 }, // Monday 13:00-15:00
    { weekday: 2, startMinutes: 600, endMinutes: 720 }, // Tuesday 10:00-12:00
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 0);
});

test("validateWeeklyRanges returns empty array for empty input", () => {
  const errors = validateWeeklyRanges([]);
  assert.equal(errors.length, 0);
});

test("validateWeeklyRanges returns empty array for single range", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 },
  ];
  
  const errors = validateWeeklyRanges(ranges);
  assert.equal(errors.length, 0);
});

test("formatOverlapErrors creates readable error message", () => {
  const errors: OverlapError[] = [
    {
      weekday: 1,
      range1: { start: "09:00", end: "12:00" },
      range2: { start: "11:00", end: "13:00" },
    },
  ];
  
  const message = formatOverlapErrors(errors);
  
  assert.ok(message.includes("Monday"));
  assert.ok(message.includes("09:00–12:00"));
  assert.ok(message.includes("11:00–13:00"));
  assert.ok(message.includes("overlaps"));
});

test("formatOverlapErrors handles multiple errors", () => {
  const errors: OverlapError[] = [
    {
      weekday: 1,
      range1: { start: "09:00", end: "12:00" },
      range2: { start: "11:00", end: "13:00" },
    },
    {
      weekday: 3,
      range1: { start: "14:00", end: "16:00" },
      range2: { start: "15:00", end: "17:00" },
    },
  ];
  
  const message = formatOverlapErrors(errors);
  
  assert.ok(message.includes("Monday"));
  assert.ok(message.includes("Wednesday"));
  assert.ok(message.includes(";"));
});

test("formatOverlapErrors returns empty string for no errors", () => {
  const message = formatOverlapErrors([]);
  assert.equal(message, "");
});

test("WeeklyRangeOverlapError carries overlap details", () => {
  const overlaps: OverlapError[] = [
    {
      weekday: 1,
      range1: { start: "09:00", end: "12:00" },
      range2: { start: "11:00", end: "13:00" },
    },
  ];
  
  const error = new WeeklyRangeOverlapError(overlaps);
  
  assert.equal(error.overlaps.length, 1);
  assert.ok(error.message.includes("Monday"));
  assert.equal(error.name, "WeeklyRangeOverlapError");
});

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
