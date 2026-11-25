/**
 * Issue #149: a shop corrects a cancelled booking's recorded in-person
 * balance once, the first figure is kept as the replaced one, and a second
 * correction is refused -- at the service and at the HTTP boundary.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { getBookingById, recordInPersonBalance, updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import type { EscrowState } from "../src/db/schema.js";
import {
  BookingNotFoundError,
  InPersonBalanceCorrectionError,
  correctInPersonBalance,
  listBookingsForProvider,
} from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedBooking, seedProviderProfile } from "./helpers.js";

const CONTRACT_ID = "CFAKECONTRACT0000000000000000000000000000000000000";

async function seed(
  result: ReturnType<typeof openTestDatabase>,
  options: { escrowState?: EscrowState | null; figure?: string | null } = {},
) {
  const providerWalletAddress = Keypair.random().publicKey();
  const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWalletAddress });
  const bookingId = await seedBooking(result, { providerProfileId });
  const escrowState = options.escrowState === undefined ? "refunded" : options.escrowState;
  if (escrowState !== null) {
    await updateEscrowContractId(result.db, bookingId, CONTRACT_ID);
    updateEscrowStateSync(result.db, bookingId, escrowState);
  }
  const figure = options.figure === undefined ? "8000000" : options.figure;
  if (figure !== null) {
    assert.equal(await recordInPersonBalance(result.db, bookingId, figure), true);
  }
  return { bookingId, providerWalletAddress };
}

function refusedWith(reason: InPersonBalanceCorrectionError["reason"]) {
  return (error: unknown) => error instanceof InPersonBalanceCorrectionError && error.reason === reason;
}

test("#149: a correction keeps the old figure beside the new one, and a second correction is refused", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, providerWalletAddress } = await seed(result);

    const view = await correctInPersonBalance(result.db, bookingId, providerWalletAddress, "6000000", 1_700_000_000);
    assert.deepEqual(view, {
      amount: { amount: "6000000", asset: "USDC" },
      replaced: { amount: "8000000", asset: "USDC" },
      correctedAt: 1_700_000_000,
    });

    await assert.rejects(
      () => correctInPersonBalance(result.db, bookingId, providerWalletAddress, "5000000"),
      refusedWith("already_corrected"),
    );
    const stored = await getBookingById(result.db, bookingId);
    assert.equal(stored!.inPersonBalanceAmount, "6000000", "the refused second correction changed nothing");
    assert.equal(stored!.inPersonBalancePreviousAmount, "8000000", "the first figure is never lost");

    const listed = (await listBookingsForProvider(result.db, providerWalletAddress)).find((item) => item.id === bookingId);
    assert.deepEqual(listed!.inPersonBalance, view, "the shop's list shows the figure and the one it replaced");
  } finally {
    closeDatabase(result);
  }
});

test("#149: recording a figure never overwrites one already recorded", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId } = await seed(result);
    assert.equal(await recordInPersonBalance(result.db, bookingId, "1"), false);
    assert.equal((await getBookingById(result.db, bookingId))!.inPersonBalanceAmount, "8000000");
  } finally {
    closeDatabase(result);
  }
});

test("#149: only a cancelled booking can be corrected", async () => {
  const result = openTestDatabase();
  try {
    for (const escrowState of [null, "locked", "released"] as const) {
      const { bookingId, providerWalletAddress } = await seed(result, { escrowState });
      await assert.rejects(
        () => correctInPersonBalance(result.db, bookingId, providerWalletAddress, "6000000"),
        refusedWith("not_cancelled"),
        `escrowState ${escrowState}`,
      );
      assert.equal((await getBookingById(result.db, bookingId))!.inPersonBalanceAmount, "8000000");
    }
  } finally {
    closeDatabase(result);
  }
});

test("#149: a cancelled booking with no recorded figure has nothing to correct", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, providerWalletAddress } = await seed(result, { figure: null });
    await assert.rejects(
      () => correctInPersonBalance(result.db, bookingId, providerWalletAddress, "6000000"),
      refusedWith("no_figure"),
    );
    const listed = (await listBookingsForProvider(result.db, providerWalletAddress)).find((item) => item.id === bookingId);
    assert.equal(listed!.inPersonBalance, null);
  } finally {
    closeDatabase(result);
  }
});

test("#149: another shop cannot correct it", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId } = await seed(result);
    const otherShopWallet = Keypair.random().publicKey();
    await seedProviderProfile(result, { isApproved: true, walletAddress: otherShopWallet });
    await assert.rejects(
      () => correctInPersonBalance(result.db, bookingId, otherShopWallet, "6000000"),
      BookingNotFoundError,
    );
    const stored = await getBookingById(result.db, bookingId);
    assert.equal(stored!.inPersonBalanceAmount, "8000000");
    assert.equal(stored!.inPersonBalanceCorrectedAt, null);
  } finally {
    closeDatabase(result);
  }
});

test("#149: a malformed amount is refused before anything is read or written", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, providerWalletAddress } = await seed(result);
    for (const amount of ["-1", "1.5", "", "abc", 100, null, "007"]) {
      await assert.rejects(
        () => correctInPersonBalance(result.db, bookingId, providerWalletAddress, amount),
        refusedWith("invalid_amount"),
        String(amount),
      );
    }
    assert.equal((await getBookingById(result.db, bookingId))!.inPersonBalanceCorrectedAt, null);
  } finally {
    closeDatabase(result);
  }
});

test("#149: POST /bookings/:id/balance/in-person/correct corrects once, then 409 ALREADY_CORRECTED; another shop gets 404", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, providerWalletAddress } = await seed(result);
    const app = createApp(result.db);
    const post = async (wallet: string, amount: unknown) =>
      app.request(`/bookings/${bookingId}/balance/in-person/correct`, {
        method: "POST",
        headers: { authorization: `Bearer ${await issuePactlyJwt(wallet)}`, "content-type": "application/json" },
        body: JSON.stringify({ amount }),
      });

    const other = await post(Keypair.random().publicKey(), "6000000");
    assert.equal(other.status, 404);

    const bad = await post(providerWalletAddress, "1.5");
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { code: string }).code, "INVALID_AMOUNT");

    const first = await post(providerWalletAddress, "6000000");
    assert.equal(first.status, 200);
    const body = (await first.json()) as { inPersonBalance: { amount: { amount: string }; replaced: { amount: string } } };
    assert.equal(body.inPersonBalance.amount.amount, "6000000");
    assert.equal(body.inPersonBalance.replaced.amount, "8000000");

    const second = await post(providerWalletAddress, "5000000");
    assert.equal(second.status, 409);
    assert.equal(((await second.json()) as { code: string }).code, "ALREADY_CORRECTED");
  } finally {
    closeDatabase(result);
  }
});
