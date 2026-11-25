/**
 * Issues #146, #147 and #148: intake answers on a booking.
 *
 * - #146: the answers reach the booking's client, its shop and an admin
 *   resolving a dispute, and a blank answer still names its question.
 * - #147: the client can change the answers while the booking is a hold,
 *   never once the deposit is locked, and never to a blank required answer.
 * - #148: the lock refuses a blank required answer, names the question and
 *   leaves the hold in place; a blank optional answer does not block it.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

import {
  BookingNotFoundError,
  IntakeAnswersIncompleteError,
  IntakeAnswersLockedError,
  ShortDepositError,
  getBookingView,
  holdSlot,
  listBookingsForProvider,
  lockDeposit,
  updateIntakeAnswers,
} from "../src/services/booking.js";
import { InvalidIntakeAnswersError } from "../src/services/intake.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { getBookingById, recordDeploySubmission, updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { setProviderProfileIntakeQuestions } from "../src/db/providerProfiles.js";
import type { EscrowAdapter } from "../src/escrow/interface.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC_DEPS = {
  resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }),
};

const QUESTIONS = [
  { id: "q-allergies", label: "Any allergies?", required: true },
  { id: "q-name", label: "Preferred name", required: false },
];

function unreachableEscrowAdapter(): EscrowAdapter {
  const fail = async (): Promise<never> => {
    throw new Error("the escrow adapter must not be called");
  };
  return { deploy: fail, fund: fail, complete: fail, approve: fail, release: fail, dispute: fail, resolve: fail } as unknown as EscrowAdapter;
}

async function seedShopWithQuestions(result: ReturnType<typeof openTestDatabase>) {
  const providerWalletAddress = Keypair.random().publicKey();
  const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWalletAddress });
  await setProviderProfileIntakeQuestions(result.db, providerProfileId, JSON.stringify(QUESTIONS));
  const slotStartsAt = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
  await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
  return { providerProfileId, providerWalletAddress, slotStartsAt };
}

async function holdWith(
  result: ReturnType<typeof openTestDatabase>,
  intakeAnswers: Record<string, string> | undefined,
) {
  const shop = await seedShopWithQuestions(result);
  const clientWalletAddress = Keypair.random().publicKey();
  const hold = await holdSlot(
    result.db,
    { providerProfileId: shop.providerProfileId, clientWalletAddress, slotStartsAt: shop.slotStartsAt, intakeAnswers },
    FAKE_USDC_DEPS,
  );
  return { ...shop, clientWalletAddress, bookingId: hold.bookingId, hold };
}

// ---------------------------------------------------------------------------
// #146: who can read the answers
// ---------------------------------------------------------------------------

test("#146: the hold stores every question; an unanswered one is kept blank rather than dropped", async () => {
  const result = openTestDatabase();
  try {
    const { hold } = await holdWith(result, { "q-allergies": "  Peanuts  " });
    assert.deepEqual(hold.intakeAnswers, [
      { questionId: "q-allergies", label: "Any allergies?", required: true, answer: "Peanuts" },
      { questionId: "q-name", label: "Preferred name", required: false, answer: "" },
    ]);
  } finally {
    closeDatabase(result);
  }
});

test("#146: the shop reads the answers on its own booking list, and the client reads them on the booking", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress, providerWalletAddress } = await holdWith(result, { "q-allergies": "Peanuts" });

    const shopList = await listBookingsForProvider(result.db, providerWalletAddress);
    const shopItem = shopList.find((item) => item.id === bookingId);
    assert.ok(shopItem, "the shop sees its booking");
    assert.equal(shopItem.intakeAnswers[0]!.answer, "Peanuts");
    assert.equal(shopItem.intakeAnswers[1]!.label, "Preferred name");
    assert.equal(shopItem.intakeAnswers[1]!.answer, "");

    const clientView = await getBookingView(result.db, bookingId, clientWalletAddress);
    assert.equal(clientView.intakeAnswers[0]!.answer, "Peanuts");
  } finally {
    closeDatabase(result);
  }
});

test("#146: another client cannot read the answers", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId } = await holdWith(result, { "q-allergies": "Peanuts" });
    await assert.rejects(() => getBookingView(result.db, bookingId, Keypair.random().publicKey()), BookingNotFoundError);
  } finally {
    closeDatabase(result);
  }
});

test("#146: a later change to the shop's questions never rewrites a booking's answers", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, providerProfileId, clientWalletAddress } = await holdWith(result, { "q-allergies": "Peanuts" });
    await setProviderProfileIntakeQuestions(
      result.db,
      providerProfileId,
      JSON.stringify([{ id: "q-other", label: "Something new", required: true }]),
    );
    const view = await getBookingView(result.db, bookingId, clientWalletAddress);
    assert.deepEqual(
      view.intakeAnswers.map((entry) => entry.questionId),
      ["q-allergies", "q-name"],
    );
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// #147: editing while a hold
// ---------------------------------------------------------------------------

test("#147: the client can edit answers on a hold, and the shop sees the edit", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress, providerWalletAddress } = await holdWith(result, { "q-allergies": "Peanuts" });

    const saved = await updateIntakeAnswers(result.db, bookingId, clientWalletAddress, {
      "q-allergies": "Peanuts and shellfish",
      "q-name": "Sam",
    });
    assert.equal(saved[0]!.answer, "Peanuts and shellfish");
    assert.equal(saved[1]!.answer, "Sam");

    const shopItem = (await listBookingsForProvider(result.db, providerWalletAddress)).find((item) => item.id === bookingId);
    assert.equal(shopItem!.intakeAnswers[0]!.answer, "Peanuts and shellfish");
    assert.equal(shopItem!.intakeAnswers[1]!.answer, "Sam");
  } finally {
    closeDatabase(result);
  }
});

test("#147: an edit is refused once the deposit is locked, and the stored answers stay put", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await holdWith(result, { "q-allergies": "Peanuts" });
    await updateEscrowContractId(result.db, bookingId, "CFAKECONTRACT0000000000000000000000000000000000000");
    updateEscrowStateSync(result.db, bookingId, "locked");

    await assert.rejects(
      () => updateIntakeAnswers(result.db, bookingId, clientWalletAddress, { "q-allergies": "Nothing" }),
      IntakeAnswersLockedError,
    );
    const stored = await getBookingById(result.db, bookingId);
    assert.match(stored!.intakeAnswers, /Peanuts/);
  } finally {
    closeDatabase(result);
  }
});

test("#147: an edit is refused once a lock is in flight (the deploy was relayed)", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await holdWith(result, { "q-allergies": "Peanuts" });
    const contractId = "CFAKECONTRACT0000000000000000000000000000000000000";
    const now = Math.floor(Date.now() / 1000);
    await updateEscrowContractId(result.db, bookingId, contractId, "unsigned-xdr", "deploy-tx-hash");
    await recordDeploySubmission(result.db, bookingId, contractId, "deploy-tx-hash", now + 600, now);

    await assert.rejects(
      () => updateIntakeAnswers(result.db, bookingId, clientWalletAddress, { "q-allergies": "Nothing" }),
      IntakeAnswersLockedError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("#147: a required answer cannot be edited to blank; an optional one can", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await holdWith(result, { "q-allergies": "Peanuts", "q-name": "Sam" });

    await assert.rejects(
      () => updateIntakeAnswers(result.db, bookingId, clientWalletAddress, { "q-allergies": "   " }),
      (error: unknown) => error instanceof InvalidIntakeAnswersError && "q-allergies" in error.details,
    );
    const stored = await getBookingById(result.db, bookingId);
    assert.match(stored!.intakeAnswers, /Peanuts/, "nothing is saved on a refused edit");

    const saved = await updateIntakeAnswers(result.db, bookingId, clientWalletAddress, { "q-name": "" });
    assert.equal(saved[1]!.answer, "");
  } finally {
    closeDatabase(result);
  }
});

test("#147: an answer to a question the booking never asked is refused", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await holdWith(result, { "q-allergies": "Peanuts" });
    await assert.rejects(
      () => updateIntakeAnswers(result.db, bookingId, clientWalletAddress, { "q-unknown": "hi" }),
      InvalidIntakeAnswersError,
    );
  } finally {
    closeDatabase(result);
  }
});

test("#147: another client cannot edit the answers", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId } = await holdWith(result, { "q-allergies": "Peanuts" });
    await assert.rejects(
      () => updateIntakeAnswers(result.db, bookingId, Keypair.random().publicKey(), { "q-allergies": "Nothing" }),
      BookingNotFoundError,
    );
    const stored = await getBookingById(result.db, bookingId);
    assert.match(stored!.intakeAnswers, /Peanuts/);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// #148: the lock checks required answers
// ---------------------------------------------------------------------------

test("#148: the lock is refused for a blank required answer, names the question, and keeps the hold", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId } = await holdWith(result, { "q-name": "Sam" });
    const before = await getBookingById(result.db, bookingId);

    await assert.rejects(
      () => lockDeposit(result.db, bookingId, unreachableEscrowAdapter()),
      (error: unknown) => {
        assert.ok(error instanceof IntakeAnswersIncompleteError);
        assert.deepEqual(error.questions, [{ questionId: "q-allergies", label: "Any allergies?" }]);
        assert.match(error.message, /Any allergies\?/);
        return true;
      },
    );

    const after = await getBookingById(result.db, bookingId);
    assert.deepEqual(after, before, "the refused lock leaves the hold row untouched");
    assert.equal(after!.escrowState, null);
    assert.equal(after!.escrowContractId, null);
    assert.equal(after!.escrowLockClaimToken, null);
  } finally {
    closeDatabase(result);
  }
});

test("#148: a blank optional answer does not block the lock", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId } = await holdWith(result, { "q-allergies": "Peanuts" });
    // Past the intake check, this test fixture has no anchor deposit, so the
    // lock's very next rule refuses it -- proving the intake check passed.
    await assert.rejects(() => lockDeposit(result.db, bookingId, unreachableEscrowAdapter()), ShortDepositError);
  } finally {
    closeDatabase(result);
  }
});

test("#148: an answer the client fills in after the hold lets the lock past the intake check", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await holdWith(result, undefined);
    await assert.rejects(() => lockDeposit(result.db, bookingId, unreachableEscrowAdapter()), IntakeAnswersIncompleteError);
    await updateIntakeAnswers(result.db, bookingId, clientWalletAddress, { "q-allergies": "None" });
    await assert.rejects(() => lockDeposit(result.db, bookingId, unreachableEscrowAdapter()), ShortDepositError);
  } finally {
    closeDatabase(result);
  }
});

test("#148: a shop with no intake questions locks exactly as before", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: Keypair.random().publicKey(), slotStartsAt },
      FAKE_USDC_DEPS,
    );
    assert.deepEqual(hold.intakeAnswers, []);
    await assert.rejects(() => lockDeposit(result.db, hold.bookingId, unreachableEscrowAdapter()), ShortDepositError);
  } finally {
    closeDatabase(result);
  }
});
