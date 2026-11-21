/**
 * Issue #50: Tests that price changes only affect new bookings.
 * Existing bookings keep the amounts they were created with.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

import { holdSlot } from "../src/services/booking.js";
import { updateProviderRules, computeDepositAmount } from "../src/services/profile.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { getBookingById } from "../src/db/bookings.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

function resolveUsdc() {
  return Promise.resolve({ code: "USDC", issuer: "FAKE", contractId: "CFAKEUSDC" });
}

test("Issue #50: Price change does not affect existing booking", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, {
      walletAddress,
      isApproved: true,
      priceAmount: "10000000", // 10 USDC
      depositRateBps: 2000,      // 20%
    });

    const now = 1_000_000;
    const slot = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slot], now);
    
    const clientWalletAddress = Keypair.random().publicKey();

    // Create booking with old price
    const oldDeposit = computeDepositAmount("10000000", 2000);
    const oldBalance = (BigInt("10000000") - BigInt(oldDeposit)).toString();
    
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress, slotStartsAt: slot },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    // Verify booking has old values
    assert.equal(hold.deposit.amount, oldDeposit);
    assert.equal(hold.balance.amount, oldBalance);
    assert.equal(hold.price.amount, "10000000");

    // Change the price and deposit rate
    await updateProviderRules(result.db, walletAddress, {
      priceAmount: "15000000", // 15 USDC (new price)
      depositRateBps: 3000,     // 30% (new rate)
      cancellationWindowHours: 24,
    });

    // Verify old booking still has old values
    const booking = await getBookingById(result.db, hold.bookingId);
    assert.ok(booking);
    assert.equal(booking.depositAmount, oldDeposit);
    assert.equal(booking.balanceAmount, oldBalance);
    
    // Verify total price is still old price
    const totalPrice = BigInt(booking.depositAmount) + BigInt(booking.balanceAmount);
    assert.equal(totalPrice.toString(), "10000000");
  } finally {
    closeDatabase(result);
  }
});

test("Issue #50: New booking after price change uses new price", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, {
      walletAddress,
      isApproved: true,
      priceAmount: "10000000", // 10 USDC
      depositRateBps: 2000,      // 20%
    });

    const now = 1_000_000;
    const slot1 = now + 3600;
    const slot2 = now + 7200;
    await replaceFutureSlots(result.db, providerProfileId, [slot1, slot2], now);
    
    const client1 = Keypair.random().publicKey();
    const client2 = Keypair.random().publicKey();

    // Create first booking with old price
    const oldDeposit = computeDepositAmount("10000000", 2000);
    const hold1 = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: client1, slotStartsAt: slot1 },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    // Change the price
    await updateProviderRules(result.db, walletAddress, {
      priceAmount: "15000000", // 15 USDC
      depositRateBps: 3000,     // 30%
      cancellationWindowHours: 24,
    });

    // Create second booking with new price
    const newDeposit = computeDepositAmount("15000000", 3000);
    const newBalance = (BigInt("15000000") - BigInt(newDeposit)).toString();
    
    const hold2 = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: client2, slotStartsAt: slot2 },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    // Verify first booking has old values
    const booking1 = await getBookingById(result.db, hold1.bookingId);
    assert.ok(booking1);
    assert.equal(booking1.depositAmount, oldDeposit);
    assert.equal((BigInt(booking1.depositAmount) + BigInt(booking1.balanceAmount)).toString(), "10000000");

    // Verify second booking has new values
    assert.equal(hold2.deposit.amount, newDeposit);
    assert.equal(hold2.balance.amount, newBalance);
    assert.equal(hold2.price.amount, "15000000");
    
    const booking2 = await getBookingById(result.db, hold2.bookingId);
    assert.ok(booking2);
    assert.equal(booking2.depositAmount, newDeposit);
    assert.equal((BigInt(booking2.depositAmount) + BigInt(booking2.balanceAmount)).toString(), "15000000");
  } finally {
    closeDatabase(result);
  }
});

test("Issue #50: Deposit rate change does not affect existing booking", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, {
      walletAddress,
      isApproved: true,
      priceAmount: "10000000", // 10 USDC
      depositRateBps: 2000,      // 20%
    });

    const now = 1_000_000;
    const slot = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slot], now);
    
    const clientWalletAddress = Keypair.random().publicKey();

    // Create booking with 20% deposit rate
    const oldDeposit = computeDepositAmount("10000000", 2000); // 2000000
    
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress, slotStartsAt: slot },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    assert.equal(hold.deposit.amount, "2000000"); // 20%

    // Change only the deposit rate (keep same price)
    await updateProviderRules(result.db, walletAddress, {
      priceAmount: "10000000", // Same price
      depositRateBps: 5000,     // 50% (new rate)
      cancellationWindowHours: 24,
    });

    // Verify old booking still has 20% deposit
    const booking = await getBookingById(result.db, hold.bookingId);
    assert.ok(booking);
    assert.equal(booking.depositAmount, "2000000"); // Still 20%, not 50%
  } finally {
    closeDatabase(result);
  }
});

test("Issue #50: Multiple price changes don't affect any existing bookings", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, {
      walletAddress,
      isApproved: true,
      priceAmount: "10000000",
      depositRateBps: 2000,
    });

    const now = 1_000_000;
    const slots = [now + 3600, now + 7200, now + 10800, now + 14400];
    await replaceFutureSlots(result.db, providerProfileId, slots, now);
    
    // Create bookings at different price points
    const clients = [
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
      Keypair.random().publicKey(),
    ];

    // Booking 1: 10 USDC, 20%
    const hold1 = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: clients[0]!, slotStartsAt: slots[0]! },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    // Change to 15 USDC, 30%
    await updateProviderRules(result.db, walletAddress, {
      priceAmount: "15000000",
      depositRateBps: 3000,
      cancellationWindowHours: 24,
    });

    // Booking 2: 15 USDC, 30%
    const hold2 = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: clients[1]!, slotStartsAt: slots[1]! },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    // Change to 20 USDC, 25%
    await updateProviderRules(result.db, walletAddress, {
      priceAmount: "20000000",
      depositRateBps: 2500,
      cancellationWindowHours: 24,
    });

    // Booking 3: 20 USDC, 25%
    const hold3 = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: clients[2]!, slotStartsAt: slots[2]! },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    // Verify all bookings retained their original values
    const booking1 = await getBookingById(result.db, hold1.bookingId);
    const booking2 = await getBookingById(result.db, hold2.bookingId);
    const booking3 = await getBookingById(result.db, hold3.bookingId);

    assert.ok(booking1 && booking2 && booking3);
    
    // Booking 1: Still 10 USDC, 20%
    assert.equal((BigInt(booking1.depositAmount) + BigInt(booking1.balanceAmount)).toString(), "10000000");
    assert.equal(booking1.depositAmount, computeDepositAmount("10000000", 2000));
    
    // Booking 2: Still 15 USDC, 30%
    assert.equal((BigInt(booking2.depositAmount) + BigInt(booking2.balanceAmount)).toString(), "15000000");
    assert.equal(booking2.depositAmount, computeDepositAmount("15000000", 3000));
    
    // Booking 3: Still 20 USDC, 25%
    assert.equal((BigInt(booking3.depositAmount) + BigInt(booking3.balanceAmount)).toString(), "20000000");
    assert.equal(booking3.depositAmount, computeDepositAmount("20000000", 2500));
  } finally {
    closeDatabase(result);
  }
});

test("Issue #50: Open hold keeps its quote when price changes", async () => {
  const result = openTestDatabase();
  try {
    const walletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, {
      walletAddress,
      isApproved: true,
      priceAmount: "10000000",
      depositRateBps: 2000,
    });

    const now = 1_000_000;
    const slot = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slot], now);
    
    const clientWalletAddress = Keypair.random().publicKey();

    // Create an open hold (not locked/paid yet)
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress, slotStartsAt: slot },
      { now, resolveUsdcAsset: resolveUsdc },
    );

    const originalDeposit = hold.deposit.amount;
    const originalPrice = hold.price.amount;

    // Change the price while hold is still open
    await updateProviderRules(result.db, walletAddress, {
      priceAmount: "20000000", // Double the price
      depositRateBps: 2000,
      cancellationWindowHours: 24,
    });

    // Verify the open hold still has original quote
    const booking = await getBookingById(result.db, hold.bookingId);
    assert.ok(booking);
    assert.equal(booking.depositAmount, originalDeposit);
    assert.equal((BigInt(booking.depositAmount) + BigInt(booking.balanceAmount)).toString(), originalPrice);
    
    // Not the new price
    assert.notEqual((BigInt(booking.depositAmount) + BigInt(booking.balanceAmount)).toString(), "20000000");
  } finally {
    closeDatabase(result);
  }
});
