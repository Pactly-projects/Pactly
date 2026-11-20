/**
 * Issue #51: Tests for the cap on open holds per client.
 * A client may have at most 3 open holds across all shops.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

import { holdSlot, TooManyHoldsError, lockDeposit } from "../src/services/booking.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { updateEscrowStateSync } from "../src/db/bookings.js";
import type { EscrowAdapter } from "../src/escrow/interface.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

function resolveUsdc() {
  return Promise.resolve({ code: "USDC", issuer: "FAKE", contractId: "CFAKEUSDC" });
}

function fakeEscrowAdapter(): EscrowAdapter {
  return {
    deploy: async () => ({
      contractId: "CFAKECONTRACT",
      unsignedXdr: "fake-xdr",
      txHash: "fake-hash",
    }),
    fund: async () => {
      throw new Error("fund not used in this test");
    },
    complete: async () => {
      throw new Error("complete not used");
    },
    approve: async () => {
      throw new Error("approve not used");
    },
    release: async () => {
      throw new Error("release not used");
    },
    startDispute: async () => {
      throw new Error("startDispute not used");
    },
    resolveDispute: async () => {
      throw new Error("resolveDispute not used");
    },
    submit: async () => {
      throw new Error("submit not used");
    },
  };
}

test("Issue #51: A client with 3 open holds cannot open a 4th", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slots = [now + 3600, now + 7200, now + 10800, now + 14400];
    await replaceFutureSlots(result.db, providerProfileId, slots, now);
    const clientWalletAddress = Keypair.random().publicKey();

    // Open 3 holds
    await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[0]! }, { now, resolveUsdcAsset: resolveUsdc });
    await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[1]! }, { now, resolveUsdcAsset: resolveUsdc });
    await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[2]! }, { now, resolveUsdcAsset: resolveUsdc });

    // 4th hold should be refused
    await assert.rejects(
      () => holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! }, { now, resolveUsdcAsset: resolveUsdc }),
      TooManyHoldsError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("Issue #51: Three holds at three different shops still block a fourth", async () => {
  const result = openTestDatabase();
  try {
    const provider1 = await seedProviderProfile(result, { isApproved: true, walletAddress: Keypair.random().publicKey() });
    const provider2 = await seedProviderProfile(result, { isApproved: true, walletAddress: Keypair.random().publicKey() });
    const provider3 = await seedProviderProfile(result, { isApproved: true, walletAddress: Keypair.random().publicKey() });
    const provider4 = await seedProviderProfile(result, { isApproved: true, walletAddress: Keypair.random().publicKey() });
    
    const now = 1_000_000;
    const slot1 = now + 3600;
    const slot2 = now + 7200;
    const slot3 = now + 10800;
    const slot4 = now + 14400;
    
    await replaceFutureSlots(result.db, provider1, [slot1], now);
    await replaceFutureSlots(result.db, provider2, [slot2], now);
    await replaceFutureSlots(result.db, provider3, [slot3], now);
    await replaceFutureSlots(result.db, provider4, [slot4], now);
    
    const clientWalletAddress = Keypair.random().publicKey();

    // Open 3 holds at 3 different shops
    await holdSlot(result.db, { providerProfileId: provider1, clientWalletAddress, slotStartsAt: slot1 }, { now, resolveUsdcAsset: resolveUsdc });
    await holdSlot(result.db, { providerProfileId: provider2, clientWalletAddress, slotStartsAt: slot2 }, { now, resolveUsdcAsset: resolveUsdc });
    await holdSlot(result.db, { providerProfileId: provider3, clientWalletAddress, slotStartsAt: slot3 }, { now, resolveUsdcAsset: resolveUsdc });

    // 4th hold at a different shop should still be refused
    await assert.rejects(
      () => holdSlot(result.db, { providerProfileId: provider4, clientWalletAddress, slotStartsAt: slot4 }, { now, resolveUsdcAsset: resolveUsdc }),
      TooManyHoldsError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("Issue #51: After one hold expires, a new hold is allowed", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slots = [now + 3600, now + 7200, now + 10800, now + 14400];
    await replaceFutureSlots(result.db, providerProfileId, slots, now);
    const clientWalletAddress = Keypair.random().publicKey();

    // Open 3 holds
    const hold1 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[0]! }, { now, resolveUsdcAsset: resolveUsdc });
    const hold2 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[1]! }, { now, resolveUsdcAsset: resolveUsdc });
    const hold3 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[2]! }, { now, resolveUsdcAsset: resolveUsdc });

    // 4th hold should be refused
    await assert.rejects(
      () => holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! }, { now, resolveUsdcAsset: resolveUsdc }),
      TooManyHoldsError,
    );

    // Advance time past first hold's expiry (holds expire after 10 minutes = 600 seconds)
    const afterExpiry = hold1.holdExpiresAt + 1;

    // Now the 4th hold should succeed
    const hold4 = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! },
      { now: afterExpiry, resolveUsdcAsset: resolveUsdc },
    );
    assert.ok(hold4.bookingId);
  } finally {
    closeDatabase(result);
  }
});

test("Issue #51: After one hold is locked, a new hold is allowed", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slots = [now + 3600, now + 7200, now + 10800, now + 14400];
    await replaceFutureSlots(result.db, providerProfileId, slots, now);
    const clientWalletAddress = Keypair.random().publicKey();

    // Open 3 holds
    const hold1 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[0]! }, { now, resolveUsdcAsset: resolveUsdc });
    const hold2 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[1]! }, { now, resolveUsdcAsset: resolveUsdc });
    const hold3 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[2]! }, { now, resolveUsdcAsset: resolveUsdc });

    // 4th hold should be refused
    await assert.rejects(
      () => holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! }, { now, resolveUsdcAsset: resolveUsdc }),
      TooManyHoldsError,
    );

    // Lock the first hold (set escrowState to "locked")
    await updateEscrowStateSync(result.db, hold1.bookingId, "locked");

    // Now the 4th hold should succeed because locked holds don't count
    const hold4 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! }, { now, resolveUsdcAsset: resolveUsdc });
    assert.ok(hold4.bookingId);
  } finally {
    closeDatabase(result);
  }
});

test("Issue #51: After one hold is released, a new hold is allowed", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slots = [now + 3600, now + 7200, now + 10800, now + 14400];
    await replaceFutureSlots(result.db, providerProfileId, slots, now);
    const clientWalletAddress = Keypair.random().publicKey();

    // Open 3 holds
    const hold1 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[0]! }, { now, resolveUsdcAsset: resolveUsdc });
    const hold2 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[1]! }, { now, resolveUsdcAsset: resolveUsdc });
    const hold3 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[2]! }, { now, resolveUsdcAsset: resolveUsdc });

    // 4th hold should be refused
    await assert.rejects(
      () => holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! }, { now, resolveUsdcAsset: resolveUsdc }),
      TooManyHoldsError,
    );

    // Release the first hold (set escrowState to "released")
    await updateEscrowStateSync(result.db, hold1.bookingId, "released");

    // Now the 4th hold should succeed because released holds don't count
    const hold4 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! }, { now, resolveUsdcAsset: resolveUsdc });
    assert.ok(hold4.bookingId);
  } finally {
    closeDatabase(result);
  }
});

test("Issue #51: After one hold is refunded, a new hold is allowed", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slots = [now + 3600, now + 7200, now + 10800, now + 14400];
    await replaceFutureSlots(result.db, providerProfileId, slots, now);
    const clientWalletAddress = Keypair.random().publicKey();

    // Open 3 holds
    const hold1 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[0]! }, { now, resolveUsdcAsset: resolveUsdc });
    const hold2 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[1]! }, { now, resolveUsdcAsset: resolveUsdc });
    const hold3 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[2]! }, { now, resolveUsdcAsset: resolveUsdc });

    // 4th hold should be refused
    await assert.rejects(
      () => holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! }, { now, resolveUsdcAsset: resolveUsdc }),
      TooManyHoldsError,
    );

    // Refund the first hold (set escrowState to "refunded")
    await updateEscrowStateSync(result.db, hold1.bookingId, "refunded");

    // Now the 4th hold should succeed because refunded holds don't count
    const hold4 = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! }, { now, resolveUsdcAsset: resolveUsdc });
    assert.ok(hold4.bookingId);
  } finally {
    closeDatabase(result);
  }
});

test("Issue #51: The limit is enforced server-side, not just disabled button", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = 1_000_000;
    const slots = [now + 3600, now + 7200, now + 10800, now + 14400];
    await replaceFutureSlots(result.db, providerProfileId, slots, now);
    const clientWalletAddress = Keypair.random().publicKey();

    // Open 3 holds
    await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[0]! }, { now, resolveUsdcAsset: resolveUsdc });
    await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[1]! }, { now, resolveUsdcAsset: resolveUsdc });
    await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[2]! }, { now, resolveUsdcAsset: resolveUsdc });

    // Multiple attempts at 4th hold should all be refused (simulating client bypassing disabled button)
    await assert.rejects(
      () => holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! }, { now, resolveUsdcAsset: resolveUsdc }),
      TooManyHoldsError,
    );
    
    await assert.rejects(
      () => holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt: slots[3]! }, { now, resolveUsdcAsset: resolveUsdc }),
      TooManyHoldsError,
    );
  } finally {
    closeDatabase(result);
  }
});
