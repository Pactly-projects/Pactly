/**
 * Issue #48: lockDeposit refuses a short anchor transfer.
 * Tests that `lockDeposit` validates the anchor deposit amount against
 * the booking's required deposit, refusing a short amount and allowing
 * an exact or greater amount to proceed to lock.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

import { lockDeposit, ShortDepositError } from "../src/services/booking.js";
import { setAnchorDeposit } from "../src/db/bookings.js";
import type { EscrowAdapter, UnsignedTransaction } from "../src/escrow/interface.js";
import { closeDatabase, openTestDatabase, seedBooking, seedProviderProfile, USDC_READY_WALLET_DEPS } from "./helpers.js";

const LOCK_DEPS = { usdcTrustline: USDC_READY_WALLET_DEPS };

function fakeContractId(): string {
  return "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
}

function fakeTxHash(): string {
  return "a".repeat(64);
}

/** A minimal fake adapter that builds unsigned XDR without network calls. */
function fakeEscrowAdapter(): EscrowAdapter {
  return {
    deploy: async (): Promise<UnsignedTransaction & { contractId: string }> => ({
      contractId: fakeContractId(),
      unsignedXdr: "fake-unsigned-xdr",
      txHash: fakeTxHash(),
    }),
    fund: async () => {
      throw new Error("fund should not be called in these tests");
    },
    complete: async () => {
      throw new Error("complete should not be called");
    },
    approve: async () => {
      throw new Error("approve should not be called");
    },
    release: async () => {
      throw new Error("release should not be called");
    },
    startDispute: async () => {
      throw new Error("startDispute should not be called");
    },
    resolveDispute: async () => {
      throw new Error("resolveDispute should not be called");
    },
    submit: async () => {
      throw new Error("submit should not be called");
    },
  };
}

test("lockDeposit refuses a short anchor deposit amount", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const professionalWallet = Keypair.random().publicKey();
    const depositAmount = "5000000"; // 5 USDC in smallest units
    const shortAmount = "4000000"; // 4 USDC - less than required

    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, {
      providerProfileId,
      clientWalletAddress: clientAddress,
      depositAmount,
    });

    // Simulate an anchor transfer that credited less than required
    await setAnchorDeposit(result.db, bookingId, {
      id: "anchor-tx-123",
      status: "completed",
      amountIn: shortAmount,
      updatedAt: Math.floor(Date.now() / 1000),
    });

    await assert.rejects(
      async () => lockDeposit(result.db, bookingId, fakeEscrowAdapter()),
      (error: unknown) => {
        assert.ok(error instanceof ShortDepositError);
        assert.equal(error.receivedAmount, shortAmount);
        assert.equal(error.requiredAmount, depositAmount);
        assert.equal(error.asset, "USDC");
        return true;
      },
    );
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit allows an exact anchor deposit amount", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const professionalWallet = Keypair.random().publicKey();
    const depositAmount = "5000000"; // 5 USDC
    const exactAmount = "5000000"; // Exactly the required amount

    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, {
      providerProfileId,
      clientWalletAddress: clientAddress,
      depositAmount,
    });

    // Simulate an anchor transfer that credited exactly the required amount
    await setAnchorDeposit(result.db, bookingId, {
      id: "anchor-tx-456",
      status: "completed",
      amountIn: exactAmount,
      updatedAt: Math.floor(Date.now() / 1000),
    });

    const lockResult = await lockDeposit(result.db, bookingId, fakeEscrowAdapter(), LOCK_DEPS);
    
    assert.ok(lockResult);
    assert.equal(lockResult.contractId, fakeContractId());
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit allows a greater anchor deposit amount", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const professionalWallet = Keypair.random().publicKey();
    const depositAmount = "5000000"; // 5 USDC
    const greaterAmount = "6000000"; // 6 USDC - more than required

    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, {
      providerProfileId,
      clientWalletAddress: clientAddress,
      depositAmount,
    });

    // Simulate an anchor transfer that credited more than required
    await setAnchorDeposit(result.db, bookingId, {
      id: "anchor-tx-789",
      status: "completed",
      amountIn: greaterAmount,
      updatedAt: Math.floor(Date.now() / 1000),
    });

    const lockResult = await lockDeposit(result.db, bookingId, fakeEscrowAdapter(), LOCK_DEPS);
    
    assert.ok(lockResult);
    assert.equal(lockResult.contractId, fakeContractId());
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit refuses when anchor deposit ID exists but amountIn is null", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const professionalWallet = Keypair.random().publicKey();
    const depositAmount = "5000000";

    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, {
      providerProfileId,
      clientWalletAddress: clientAddress,
      depositAmount,
    });

    // Simulate an anchor deposit that was opened but never credited
    await setAnchorDeposit(result.db, bookingId, {
      id: "anchor-tx-999",
      status: "pending_user_transfer_start",
      amountIn: null, // No amount received yet
      updatedAt: Math.floor(Date.now() / 1000),
    });

    await assert.rejects(
      async () => lockDeposit(result.db, bookingId, fakeEscrowAdapter()),
      (error: unknown) => {
        assert.ok(error instanceof ShortDepositError);
        assert.equal(error.receivedAmount, "0");
        assert.equal(error.requiredAmount, depositAmount);
        assert.equal(error.asset, "USDC");
        return true;
      },
    );
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit refuses when no anchor deposit exists at all", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const professionalWallet = Keypair.random().publicKey();
    const depositAmount = "5000000";

    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, {
      providerProfileId,
      clientWalletAddress: clientAddress,
      depositAmount,
      anchorDeposit: "none",
    });

    // No anchor deposit set - must be refused as missing transfer
    await assert.rejects(
      async () => lockDeposit(result.db, bookingId, fakeEscrowAdapter()),
      (error: unknown) => {
        assert.ok(error instanceof ShortDepositError);
        assert.equal(error.receivedAmount, "0");
        assert.equal(error.requiredAmount, depositAmount);
        assert.equal(error.asset, "USDC");
        assert.ok(error.message.includes("No anchor transfer was found"));
        return true;
      },
    );
  } finally {
    closeDatabase(result);
  }
});
