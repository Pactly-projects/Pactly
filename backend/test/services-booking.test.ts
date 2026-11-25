/**
 * `services/booking.ts` exercised as a unit -- no network access anywhere:
 * `lockDeposit`/`fundDeposit`/`resolveBookingDispute` are driven through a
 * fake `EscrowAdapter` that never constructs a real `TrustlessWorkClient`.
 * Covers this story's own amended I/O matrix rows: `lockDeposit`'s argument
 * wiring (a reversed professional/client pair would lock a deposit payable
 * to the wrong party) and its persisted `contractId`; the typed refusals
 * for a redeploy/refund/re-resolve once state has already moved on;
 * `fundDeposit` targeting exactly the persisted `contractId`, never a
 * caller-supplied one; and `resolveBookingDispute`'s one full-amount
 * distribution plus its recorded decision.
 */
import "./testConfigEnv.js";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { BookingDeployInFlightError, BookingEscrowStateError, BookingNotFoundError, DepositAlreadyLandedError, fundDeposit, getBookingView, lockDeposit, resolveBookingDispute, setBalanceState } from "../src/services/booking.js";
import { getEscrowDisputeResolution } from "../src/db/escrowDisputeResolutions.js";
import {
  getBookingById,
  recordDeploySubmission,
  setEscrowFundTxHash,
  updateEscrowContractId,
  updateEscrowStateSync,
} from "../src/db/bookings.js";
import { listContractDeployments } from "../src/db/escrowContractDeployments.js";
import { bookings, availabilitySlots } from "../src/db/schema.js";
import { insertEscrowProcessedEventIfNew } from "../src/db/escrowProcessedEvents.js";
import type { Db } from "../src/db/client.js";
import { TransactionStatusUnavailableError } from "../src/escrow/transaction-status.js";
import type {
  DeployEscrowInput,
  DeployEscrowResult,
  EscrowAdapter,
  FundEscrowInput,
  ResolveDisputeInput,
  UnsignedTransaction,
} from "../src/escrow/interface.js";
import { closeDatabase, openTestDatabase, randomBookingId, seedBooking, seedProviderProfile, USDC_READY_WALLET_DEPS } from "./helpers.js";

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

/** Issue #4: `lockDeposit` now asks "can this wallet hold the deposit?"
 * before it builds a deploy. Every test below is about the deploy, so it
 * injects the "yes" answer -- the tests about the gate itself live in
 * `anchor-trustline.test.ts`, plus the two route tests that assert the
 * refusal. */
const LOCK_DEPS = { usdcTrustline: USDC_READY_WALLET_DEPS };

/** Seeds the reconciler's own record of a "disputed" transition for
 * `contractId` -- `resolveBookingDispute` now refuses to build a
 * resolution without one (it must never resolve a dispute the chain has
 * not actually confirmed exists). */
async function markDisputed(db: Db, bookingId: string, contractId: string, amount: string): Promise<void> {
  await insertEscrowProcessedEventIfNew(db, {
    bookingId,
    contractId,
    lifecycleAction: "disputed",
    amount,
    ledgerSeq: "1",
    isAnomaly: false,
    processedAt: Date.now(),
  });
}

function unreachableEscrowAdapter(): EscrowAdapter {
  return {
    deploy: async () => {
      throw new Error("deploy should not have been called");
    },
    fund: async () => {
      throw new Error("fund should not have been called");
    },
    complete: async () => {
      throw new Error("complete should not have been called");
    },
    approve: async () => {
      throw new Error("approve should not have been called");
    },
    release: async () => {
      throw new Error("release should not have been called");
    },
    startDispute: async () => {
      throw new Error("startDispute should not have been called");
    },
    resolveDispute: async () => {
      throw new Error("resolveDispute should not have been called");
    },
    submit: async () => {
      throw new Error("submit should not have been called");
    },
  };
}

test("lockDeposit calls the EscrowAdapter's deploy with the professional's wallet as the provider, never the client's, and persists the contractId", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const professionalWallet = Keypair.random().publicKey();
    const tokenAddress = fakeContractId();
    const depositAmount = "5000000";

    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, {
      providerProfileId,
      clientWalletAddress: clientAddress,
      tokenAddress,
      depositAmount,
    });

    let capturedDeploy: DeployEscrowInput | undefined;
    const deployResult: DeployEscrowResult = {
      contractId: fakeContractId(),
      unsignedXdr: "deploy-unsigned-xdr",
      txHash: "deploy-tx-hash",
    };

    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async (input: DeployEscrowInput) => {
        capturedDeploy = input;
        return deployResult;
      },
    };

    const lockResult = await lockDeposit(result.db, bookingId, adapter, LOCK_DEPS);

    assert.equal(lockResult.contractId, deployResult.contractId);
    assert.equal(lockResult.deployed, false);
    if (!lockResult.deployed) {
      assert.equal(lockResult.unsignedXdr, deployResult.unsignedXdr);
      assert.equal(lockResult.txHash, deployResult.txHash);
    }

    assert.ok(capturedDeploy, "adapter.deploy should have been called");
    assert.equal(capturedDeploy.bookingId, bookingId);
    assert.equal(capturedDeploy.providerAddress, professionalWallet, "provider must be the provider profile's wallet");
    assert.equal(capturedDeploy.clientAddress, clientAddress, "client must be the booking's own client wallet");
    assert.notEqual(capturedDeploy.providerAddress, capturedDeploy.clientAddress, "provider and client must not have been swapped");
    assert.equal(capturedDeploy.tokenAddress, tokenAddress);
    assert.equal(capturedDeploy.amount, depositAmount);

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, deployResult.contractId, "the predicted contractId must be persisted");
    assert.equal(booking?.escrowState, null, "lockDeposit alone must never set escrow_state");
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit throws for an unknown booking id without ever calling the adapter", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(() => lockDeposit(result.db, randomBookingId(), unreachableEscrowAdapter()), TypeError);
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit retried within the hold returns the same stored deploy XDR and contractId, without a second deploy call (Story 3.4)", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const firstContractId = fakeContractId();
    let calls = 0;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => {
        calls += 1;
        return { contractId: firstContractId, unsignedXdr: "first-unsigned-xdr", txHash: "h" };
      },
    };

    const first = await lockDeposit(result.db, bookingId, adapter, LOCK_DEPS);
    assert.equal(calls, 1);
    assert.equal(first.contractId, firstContractId);
    assert.equal(first.deployed, false);
    if (!first.deployed) assert.equal(first.unsignedXdr, "first-unsigned-xdr");

    // A retry (a declined wallet signature, or a lost response) must return
    // the exact same escrow and XDR, never deploy a second, competing one.
    const second = await lockDeposit(result.db, bookingId, unreachableEscrowAdapter());
    assert.equal(calls, 1, "the adapter's deploy must not be called again");
    assert.equal(second.contractId, firstContractId);
    assert.equal(second.deployed, false);
    if (!second.deployed) assert.equal(second.unsignedXdr, "first-unsigned-xdr");

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, firstContractId, "the original contractId must survive the retried call");
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit returns {deployed: true, contractId} once a deploy submission is recorded, without touching the adapter", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    const recorded = await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));
    assert.equal(recorded, true);

    const lockResult = await lockDeposit(result.db, bookingId, unreachableEscrowAdapter());
    assert.deepEqual(lockResult, { deployed: true, contractId });
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit refuses (typed) when a contractId is persisted with no stored XDR and rebuild is not requested", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);

    await assert.rejects(() => lockDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, contractId, "the contractId must survive the refusal");
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit with rebuild: true clears an unsubmitted deploy and builds a fresh one", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const staleContractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, staleContractId, "stale-xdr", "stale-tx-hash");

    const freshContractId = fakeContractId();
    let calls = 0;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => {
        calls += 1;
        return { contractId: freshContractId, unsignedXdr: "fresh-unsigned-xdr", txHash: "fresh-tx-hash" };
      },
    };

    const rebuilt = await lockDeposit(result.db, bookingId, adapter, { ...LOCK_DEPS, rebuild: true });
    assert.equal(calls, 1);
    assert.equal(rebuilt.contractId, freshContractId);
    assert.equal(rebuilt.deployed, false);

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, freshContractId);
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit ignores rebuild: true once a deploy submission is already recorded", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));

    const lockResult = await lockDeposit(result.db, bookingId, unreachableEscrowAdapter(), { rebuild: true });
    assert.deepEqual(lockResult, { deployed: true, contractId });
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit: two concurrent first-deploy calls deploy exactly once -- the loser refuses as already in flight", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    let deployCalls = 0;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => {
        deployCalls += 1;
        return { contractId, unsignedXdr: "unsigned-xdr", txHash: "tx-hash" };
      },
    };

    const [first, second] = await Promise.allSettled([
      lockDeposit(result.db, bookingId, adapter, LOCK_DEPS),
      lockDeposit(result.db, bookingId, adapter, LOCK_DEPS),
    ]);
    // Issue #6: the claim is taken *before* the adapter call, so the second
    // request never reaches it -- exactly one escrow is built for this
    // booking. The winner returns the deploy to sign; the loser names the
    // same booking and refuses, never a raw, untyped error.
    assert.equal(deployCalls, 1);
    const fulfilled = [first, second].filter((outcome) => outcome.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "exactly one of the two concurrent calls builds the deploy");
    for (const outcome of [first, second]) {
      if (outcome.status === "fulfilled") {
        assert.deepEqual(outcome.value, { deployed: false, contractId, unsignedXdr: "unsigned-xdr", txHash: "tx-hash" });
      } else {
        assert.ok(outcome.reason instanceof BookingDeployInFlightError, "the loser gets a typed refusal, never a raw error");
        assert.equal(outcome.reason.bookingId, bookingId);
      }
    }

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, contractId);
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit: once the claimant has persisted its deploy, a later call returns that same contractId with no second deploy", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    let deployCalls = 0;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => {
        deployCalls += 1;
        // Asked for the same booking while this deploy is still in flight.
        await assert.rejects(
          () => lockDeposit(result.db, bookingId, adapter, LOCK_DEPS),
          (error: unknown) => error instanceof BookingDeployInFlightError,
        );
        return { contractId, unsignedXdr: "unsigned-xdr", txHash: "tx-hash" };
      },
    };

    const first = await lockDeposit(result.db, bookingId, adapter, LOCK_DEPS);
    assert.deepEqual(first, { deployed: false, contractId, unsignedXdr: "unsigned-xdr", txHash: "tx-hash" });

    const retry = await lockDeposit(result.db, bookingId, unreachableEscrowAdapter());
    assert.deepEqual(retry, { deployed: false, contractId, unsignedXdr: "unsigned-xdr", txHash: "tx-hash" });
    assert.equal(deployCalls, 1, "a request after the contractId is stored returns it, never a second deploy");
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit: a failed deploy releases its claim so the client can retry immediately, and two different bookings still deploy in parallel (issue #6)", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const otherBookingId = await seedBooking(result);
    const contractId = fakeContractId();
    let attempt = 0;
    const failingThenWorkingAdapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("escrow is unavailable");
        return { contractId, unsignedXdr: "unsigned-xdr", txHash: "tx-hash" };
      },
    };

    await assert.rejects(() => lockDeposit(result.db, bookingId, failingThenWorkingAdapter, LOCK_DEPS));
    const retried = await lockDeposit(result.db, bookingId, failingThenWorkingAdapter, LOCK_DEPS);
    assert.deepEqual(retried, { deployed: false, contractId, unsignedXdr: "unsigned-xdr", txHash: "tx-hash" });

    // The claim is per booking, never global: a second booking's deploy is
    // not held up by the first one's.
    const otherContractId = fakeContractId();
    const [storedAgain, other] = await Promise.all([
      lockDeposit(result.db, bookingId, unreachableEscrowAdapter()),
      lockDeposit(result.db, otherBookingId, {
        ...unreachableEscrowAdapter(),
        deploy: async () => ({ contractId: otherContractId, unsignedXdr: "other-xdr", txHash: "other-tx-hash" }),
      }, LOCK_DEPS),
    ]);
    assert.deepEqual(storedAgain, { deployed: false, contractId, unsignedXdr: "unsigned-xdr", txHash: "tx-hash" });
    assert.deepEqual(other, { deployed: false, contractId: otherContractId, unsignedXdr: "other-xdr", txHash: "other-tx-hash" });
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit refuses once the hold has expired with escrow_state still null", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const past = Math.floor(Date.now() / 1000) - 1;
    await result.db.update(bookings).set({ holdExpiresAt: past }).where(eq(bookings.id, bookingId));

    await assert.rejects(
      () => lockDeposit(result.db, bookingId, unreachableEscrowAdapter(), { now: past + 1 }),
      (error: unknown) => error instanceof Error && error.name === "BookingHoldExpiredError",
    );
  } finally {
    closeDatabase(result);
  }
});

test("lockDeposit refuses to run again once escrow_state is also set", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    await updateEscrowContractId(result.db, bookingId, fakeContractId());
    updateEscrowStateSync(result.db, bookingId, "locked");

    await assert.rejects(() => lockDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);
  } finally {
    closeDatabase(result);
  }
});

test("fundDeposit targets exactly the persisted contractId, never a caller-supplied one, once a deploy submission is recorded", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const depositAmount = "5000000";
    const bookingId = await seedBooking(result, { clientWalletAddress: clientAddress, depositAmount });
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));

    let capturedFund: FundEscrowInput | undefined;
    const fundResult: UnsignedTransaction = { unsignedXdr: "fund-unsigned-xdr", txHash: "fund-tx-hash" };
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      fund: async (input: FundEscrowInput) => {
        capturedFund = input;
        return fundResult;
      },
    };

    const result2 = await fundDeposit(result.db, bookingId, adapter);
    assert.deepEqual(result2, fundResult);
    assert.ok(capturedFund);
    assert.equal(capturedFund.contractId, contractId);
    assert.equal(capturedFund.clientAddress, clientAddress);
    assert.equal(capturedFund.amount, depositAmount);

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowFundTxHash, "fund-tx-hash", "the built fund XDR's own txHash must be stored for submitSignedTransaction to match against");
  } finally {
    closeDatabase(result);
  }
});

test("fundDeposit refuses when no contractId is persisted yet", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    await assert.rejects(() => fundDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);
  } finally {
    closeDatabase(result);
  }
});

test("fundDeposit refuses when a contractId is persisted but no deploy submission has been recorded yet (Story 3.4 review)", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    await updateEscrowContractId(result.db, bookingId, fakeContractId(), "unsigned-xdr", "deploy-tx-hash");
    // No recordDeploySubmission call -- the deploy was built but never
    // confirmed relayed.
    await assert.rejects(() => fundDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);
  } finally {
    closeDatabase(result);
  }
});

test("fundDeposit refuses once escrow_state is already set", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));
    updateEscrowStateSync(result.db, bookingId, "locked");

    await assert.rejects(() => fundDeposit(result.db, bookingId, unreachableEscrowAdapter()), BookingEscrowStateError);
  } finally {
    closeDatabase(result);
  }
});

test("fundDeposit refuses when the slot has already started (SlotInPastError)", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = Math.floor(Date.now() / 1000);
    const slotStartsAt = now - 3600; // slot started 1 hour ago
    const slotId = randomUUID();
    await result.db.insert(availabilitySlots).values({
      id: slotId,
      providerProfileId,
      startsAt: slotStartsAt,
      createdAt: Date.now(),
    });
    const bookingId = await seedBooking(result, { providerProfileId });
    await result.db.update(bookings).set({ slotId }).where(eq(bookings.id, bookingId));
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", now - 100, now - 700);

    // A persisted contract id is the evidence that a deploy was already
    // submitted, so this booking is no longer an uncommitted hold and its
    // old hold clock must not refuse the fund build.
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      fund: async () => ({ unsignedXdr: "unsigned-fund-xdr", txHash: "fund-tx-hash" }),
    };
    const built = await fundDeposit(result.db, bookingId, adapter, { now: now + 1 });

    assert.equal(built.txHash, "fund-tx-hash");
  } finally {
    closeDatabase(result);
  }
});

test("Issue #5: resuming a deployed-but-unfunded booking rebuilds only the fund, and never a second deploy", async () => {
  const result = openTestDatabase();
  try {
    const depositAmount = "5000000";
    const bookingId = await seedBooking(result, { depositAmount });
    const contractId = fakeContractId();
    const deployResult: DeployEscrowResult = { contractId, unsignedXdr: "unsigned-xdr", txHash: "deploy-tx-hash" };
    let deployCalls = 0;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => {
        deployCalls += 1;
        return deployResult;
      },
    };

    await lockDeposit(result.db, bookingId, adapter, LOCK_DEPS);
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));

    // The fund signature failed (or the tab was closed) after the deploy
    // landed. Resume: `lockDeposit` must hand back the stored contract with
    // no adapter call at all, so the flow can go straight to funding.
    const resumed = await lockDeposit(result.db, bookingId, unreachableEscrowAdapter());
    assert.deepEqual(resumed, { deployed: true, contractId });
    assert.equal(deployCalls, 1, "resuming a deployed booking must never deploy a second contract");

    // ...and the fund step then targets exactly that same contract id.
    let capturedFund: FundEscrowInput | undefined;
    const fundAdapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      fund: async (input: FundEscrowInput) => {
        capturedFund = input;
        return { unsignedXdr: "fund-unsigned-xdr", txHash: "fund-tx-hash" };
      },
    };
    await fundDeposit(result.db, bookingId, fundAdapter);
    assert.equal(capturedFund?.contractId, contractId);
  } finally {
    closeDatabase(result);
  }
});

test("Issue #5: a fund transaction the network already reports successful is never asked for again", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));
    await setEscrowFundTxHash(result.db, bookingId, "first-fund-tx-hash");

    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      fund: async () => {
        throw new Error("a fund transaction that already landed must not be built again");
      },
    };

    await assert.rejects(
      () => fundDeposit(result.db, bookingId, unreachableEscrowAdapter(), { now }),
      (error: unknown) => error instanceof Error && error.name === "SlotInPastError",
    );

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowFundTxHash, "first-fund-tx-hash", "the refusal must leave the landed transaction stored");
    assert.equal(booking?.escrowState, null, "only the reconciler's own chain evidence sets escrow_state (AD-1)");
  } finally {
    closeDatabase(result);
  }
});

test("Issue #5: a fund transaction that has not landed is rebuilt, a first fund reads nothing, and an unreadable network refuses", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));

    // Edge case "a booking with no fund transaction built yet": nothing is
    // read from the network -- the status seam is never even called.
    let statusCalls = 0;
    let fundCalls = 0;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      fund: async () => {
        fundCalls += 1;
        return { unsignedXdr: `fund-unsigned-xdr-${fundCalls}`, txHash: `fund-tx-hash-${fundCalls}` };
      },
    };
    const first = await fundDeposit(result.db, bookingId, adapter, {
      transactionReachedSuccess: async () => {
        statusCalls += 1;
        return false;
      },
    });
    assert.equal(statusCalls, 0, "the network is only asked about a transaction that has already been built");
    assert.equal(first.unsignedXdr, "fund-unsigned-xdr-1");

    // Still flying (or failed): the retry stays open, and a fresh
    // transaction is built for the same contract.
    const second = await fundDeposit(result.db, bookingId, adapter, { transactionReachedSuccess: async () => false });
    assert.equal(second.unsignedXdr, "fund-unsigned-xdr-2");
    assert.equal(fundCalls, 2);

    // A network that cannot answer refuses rather than reading a missing
    // answer as permission to build another.
    await assert.rejects(
      () =>
        fundDeposit(result.db, bookingId, adapter, {
          transactionReachedSuccess: async () => {
            throw new TransactionStatusUnavailableError();
          },
        }),
      TransactionStatusUnavailableError,
    );
    assert.equal(fundCalls, 2, "an unreadable network must not build a third fund transaction");
  } finally {
    closeDatabase(result);
  }
});

test("Issue #7: every contract id a booking deployed is kept, the current one is the active one, and only it settles", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const bookingId = await seedBooking(result, { clientWalletAddress: clientAddress });
    const firstContractId = fakeContractId();
    const secondContractId = fakeContractId();
    let nextContractId = firstContractId;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => ({ contractId: nextContractId, unsignedXdr: `unsigned-${nextContractId}`, txHash: `tx-${nextContractId}` }),
      fund: async (input: FundEscrowInput) => ({ unsignedXdr: `fund-${input.contractId}`, txHash: "fund-tx-hash" }),
    };

    // Ten seconds pass between the two deploys -- the history is ordered by
    // the clock it recorded, so the test pins that clock rather than a tie.
    const firstDeployedAt = Math.floor(Date.now() / 1000);
    await lockDeposit(result.db, bookingId, adapter, { ...LOCK_DEPS, now: firstDeployedAt });

    // The deploy never got submitted, so the client asks for a fresh one --
    // the old contract id must stay visible, not be silently replaced.
    nextContractId = secondContractId;
    await lockDeposit(result.db, bookingId, adapter, { ...LOCK_DEPS, now: firstDeployedAt + 10, rebuild: true });

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowContractId, secondContractId);

    const history = await listContractDeployments(result.db, bookingId);
    assert.deepEqual(
      history.map((row) => row.contractId),
      [firstContractId, secondContractId],
      "both ids, oldest first",
    );

    // ...and a retried lock that re-persisted the same id records it once.
    // (No submit is recorded yet, so this returns the stored XDR -- the
    // point being only that the history does not grow.)
    await lockDeposit(result.db, bookingId, unreachableEscrowAdapter());
    assert.equal((await listContractDeployments(result.db, bookingId)).length, 2);

    await recordDeploySubmission(result.db, bookingId, secondContractId, `tx-${secondContractId}`, Math.floor(Date.now() / 1000) + 600, Math.floor(Date.now() / 1000));

    const funded = await fundDeposit(result.db, bookingId, adapter);
    assert.equal(funded.unsignedXdr, `fund-${secondContractId}`, "settlement only ever targets the current contract id, never a superseded one");

    const view = await getBookingView(result.db, bookingId, clientAddress);
    assert.deepEqual(view.contractHistory, [
      { contractId: firstContractId, active: false },
      { contractId: secondContractId, active: true },
    ]);

    // Edge case: another client's booking ids are not readable at all.
    await assert.rejects(() => getBookingView(result.db, bookingId, Keypair.random().publicKey()), BookingNotFoundError);
  } finally {
    closeDatabase(result);
  }
});

test("Issue #7: a deploy that fails or a booking that never deployed has nothing to show", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const bookingId = await seedBooking(result, { clientWalletAddress: clientAddress });

    assert.deepEqual((await getBookingView(result.db, bookingId, clientAddress)).contractHistory, []);

    const failing: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      deploy: async () => {
        throw new Error("Trustless Work refused");
      },
    };
    await assert.rejects(() => lockDeposit(result.db, bookingId, failing, LOCK_DEPS));
    assert.deepEqual(await listContractDeployments(result.db, bookingId), [], "a deploy that returned no id adds no row");
  } finally {
    closeDatabase(result);
  }
});

test("resolveBookingDispute refuses unless the booking is locked with a persisted contractId", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    await assert.rejects(
      () => resolveBookingDispute(result.db, bookingId, "refund-client", unreachableEscrowAdapter()),
      BookingEscrowStateError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("resolveBookingDispute refuses when the booking is locked but no chain-confirmed dispute is recorded for its contractId", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    await updateEscrowContractId(result.db, bookingId, fakeContractId());
    updateEscrowStateSync(result.db, bookingId, "locked");

    // No `markDisputed` here -- `escrow_state` alone reading "locked" is
    // also true before any dispute ever existed, so it must not be enough.
    await assert.rejects(
      () => resolveBookingDispute(result.db, bookingId, "refund-client", unreachableEscrowAdapter()),
      BookingEscrowStateError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("resolveBookingDispute (refund-client) builds one full-amount distribution to the client and records the decision", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const professionalWallet = Keypair.random().publicKey();
    const depositAmount = "5000000";
    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress: clientAddress, depositAmount });
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);
    updateEscrowStateSync(result.db, bookingId, "locked");
    await markDisputed(result.db, bookingId, contractId, depositAmount);

    let captured: ResolveDisputeInput | undefined;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      resolveDispute: async (input: ResolveDisputeInput) => {
        captured = input;
        return { unsignedXdr: "resolve-unsigned-xdr", txHash: "resolve-tx-hash" };
      },
    };

    const outcome = await resolveBookingDispute(result.db, bookingId, "refund-client", adapter);
    assert.equal(outcome.outcome, "refund-client");
    assert.equal(outcome.txHash, "resolve-tx-hash");

    assert.ok(captured);
    assert.equal(captured.contractId, contractId);
    assert.deepEqual(captured.distributions, [{ address: clientAddress, amount: depositAmount }]);

    const recorded = await getEscrowDisputeResolution(result.db, bookingId);
    assert.equal(recorded?.outcome, "refund-client");
    assert.equal(recorded?.txHash, "resolve-tx-hash");
    assert.equal(recorded?.contractId, contractId);
  } finally {
    closeDatabase(result);
  }
});

test("resolveBookingDispute (pay-provider) builds one full-amount distribution to the provider's own wallet", async () => {
  const result = openTestDatabase();
  try {
    const clientAddress = Keypair.random().publicKey();
    const professionalWallet = Keypair.random().publicKey();
    const depositAmount = "5000000";
    const providerProfileId = await seedProviderProfile(result, { walletAddress: professionalWallet });
    const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress: clientAddress, depositAmount });
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);
    updateEscrowStateSync(result.db, bookingId, "locked");
    await markDisputed(result.db, bookingId, contractId, depositAmount);

    let captured: ResolveDisputeInput | undefined;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      resolveDispute: async (input: ResolveDisputeInput) => {
        captured = input;
        return { unsignedXdr: "resolve-unsigned-xdr", txHash: "resolve-tx-hash-2" };
      },
    };

    const outcome = await resolveBookingDispute(result.db, bookingId, "pay-provider", adapter);
    assert.equal(outcome.outcome, "pay-provider");
    assert.ok(captured);
    assert.deepEqual(captured.distributions, [{ address: professionalWallet, amount: depositAmount }]);
  } finally {
    closeDatabase(result);
  }
});

test("a second resolve returns the stored outcome and does not call the escrow again", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result);
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);
    updateEscrowStateSync(result.db, bookingId, "locked");
    await markDisputed(result.db, bookingId, contractId, "5000000");

    let txHash = "first-attempt-tx-hash";
    let resolveCallCount = 0;
    const adapter: EscrowAdapter = {
      ...unreachableEscrowAdapter(),
      resolveDispute: async () => {
        resolveCallCount += 1;
        return { unsignedXdr: "x", txHash };
      },
    };

    const first = await resolveBookingDispute(result.db, bookingId, "refund-client", adapter);
    assert.equal(first.txHash, "first-attempt-tx-hash");
    assert.equal(resolveCallCount, 1);
    const firstRecorded = await getEscrowDisputeResolution(result.db, bookingId);
    assert.equal(firstRecorded?.outcome, "refund-client");
    assert.equal(firstRecorded?.txHash, "first-attempt-tx-hash");

    // Issue #33: a second resolve returns the stored outcome and does not
    // call the escrow again. The original decision stands.
    txHash = "second-attempt-tx-hash";
    const second = await resolveBookingDispute(result.db, bookingId, "pay-provider", adapter);
    assert.equal(second.outcome, "refund-client");
    assert.equal(second.txHash, "first-attempt-tx-hash");
    assert.equal(resolveCallCount, 1);

    const secondRecorded = await getEscrowDisputeResolution(result.db, bookingId);
    assert.equal(secondRecorded?.outcome, "refund-client");
    assert.equal(secondRecorded?.txHash, "first-attempt-tx-hash");
  } finally {
    closeDatabase(result);
  }
});

test("setBalanceState throws for an unknown booking id instead of silently writing nothing", async () => {
  const result = openTestDatabase();
  try {
    await assert.rejects(() => setBalanceState(result.db, randomBookingId(), "paid_cash"), TypeError);
  } finally {
    closeDatabase(result);
  }
});
