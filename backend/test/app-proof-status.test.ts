import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { updateEscrowContractId, updateEscrowState } from "../src/db/bookings.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC_DEPS = {
  resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }),
};

async function seedDeployedBooking(result: ReturnType<typeof openTestDatabase>) {
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
    { providerProfileId, clientWalletAddress: "GCLIENTPROOFSTATUS000000000000000000000000000", slotStartsAt },
    FAKE_USDC_DEPS,
  );
  await updateEscrowContractId(
    result.db,
    hold.bookingId,
    "CFAKECONTRACTPROOFSTATUS0000000000000000000000000",
    "AAAA",
    "hash",
  );
  return hold.bookingId;
}

test("GET /proof/:id marks released bookings released and refunded bookings cancelled while keeping contract link", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);

    const releasedId = await seedDeployedBooking(result);
    await updateEscrowState(result.db, releasedId, "released");
    const released = await app.request(`/proof/${releasedId}`);
    assert.equal(released.status, 200);
    const releasedBody = (await released.json()) as { status: string; contractId: string };
    assert.equal(releasedBody.status, "released");
    assert.equal(releasedBody.contractId, "CFAKECONTRACTPROOFSTATUS0000000000000000000000000");

    const cancelledId = await seedDeployedBooking(result);
    await updateEscrowState(result.db, cancelledId, "refunded");
    const cancelled = await app.request(`/proof/${cancelledId}`);
    assert.equal(cancelled.status, 200);
    const cancelledBody = (await cancelled.json()) as { status: string; contractId: string };
    assert.equal(cancelledBody.status, "cancelled");
    assert.equal(cancelledBody.contractId, "CFAKECONTRACTPROOFSTATUS0000000000000000000000000");
  } finally {
    closeDatabase(result);
  }
});
