import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { setEscrowActionTxHash, updateEscrowContractId, updateEscrowState } from "../src/db/bookings.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC_DEPS = {
  resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }),
};

const RELEASE_TX_HASH = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

test("GET /proof/:id exposes the release transaction only after release", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, {
      isApproved: true,
      displayName: "Marmara Hair Clinic",
      title: "Hair transplant consultation",
      location: "Istanbul",
    });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: "GCLIENTPROOF0000000000000000000000000000000000", slotStartsAt },
      FAKE_USDC_DEPS,
    );
    await updateEscrowContractId(
      result.db,
      hold.bookingId,
      "CFAKECONTRACTPROOF0000000000000000000000000000000",
      "AAAA",
      "hash",
    );
    await updateEscrowState(result.db, hold.bookingId, "locked");

    const app = createApp(result.db);

    const before = (await (await app.request(`/proof/${hold.bookingId}`)).json()) as {
      status: string;
      releaseTxHash: string | null;
    };
    assert.equal(before.status, "locked");
    assert.equal(before.releaseTxHash, null, "no release transaction exists before release");

    await setEscrowActionTxHash(result.db, hold.bookingId, "release", RELEASE_TX_HASH);
    await updateEscrowState(result.db, hold.bookingId, "released");

    const after = (await (await app.request(`/proof/${hold.bookingId}`)).json()) as {
      status: string;
      releaseTxHash: string | null;
    };
    assert.equal(after.status, "released");
    assert.equal(after.releaseTxHash, RELEASE_TX_HASH, "the stored release hash is exposed");
  } finally {
    closeDatabase(result);
  }
});

test("GET /proof/:id returns proof for a locked booking and 404 for a pending booking", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, {
      isApproved: true,
      displayName: "Marmara Hair Clinic",
      title: "Hair transplant consultation",
      location: "Istanbul",
    });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: "GCLIENTPROOF0000000000000000000000000000000000", slotStartsAt },
      FAKE_USDC_DEPS,
    );

    const app = createApp(result.db);

    const pending = await app.request(`/proof/${hold.bookingId}`);
    assert.equal(pending.status, 404);

    await updateEscrowContractId(
      result.db,
      hold.bookingId,
      "CFAKECONTRACTPROOF0000000000000000000000000000000",
      "AAAA",
      "hash",
    );
    await updateEscrowState(result.db, hold.bookingId, "locked");

    const response = await app.request(`/proof/${hold.bookingId}`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      id: string;
      status: string;
      shop: { displayName: string; title: string; location: string };
      slotStartsAt: number | null;
      deposit: { amount: string; asset: string };
      contractId: string;
    };

    assert.equal(body.id, hold.bookingId);
    assert.equal(body.status, "locked");
    assert.deepEqual(body.shop, {
      displayName: "Marmara Hair Clinic",
      title: "Hair transplant consultation",
      location: "Istanbul",
    });
    assert.equal(body.slotStartsAt, slotStartsAt);
    assert.deepEqual(body.deposit, { amount: hold.deposit.amount, asset: "USDC" });
    assert.equal(body.contractId, "CFAKECONTRACTPROOF0000000000000000000000000000000");

    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes("GCLIENTPROOF"), false);
    assert.equal(serialized.includes("clientWalletAddress"), false);
  } finally {
    closeDatabase(result);
  }
});
