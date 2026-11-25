/**
 * Test for marking a client as arrived.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { availabilitySlots, bookings } from "../src/db/schema.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";
import { createBookingHold } from "../src/services/booking.js";

/** Every route here is behind `requirePactlyAuth`, which wants a Pactly
 * token -- never the bare wallet address. */
async function authHeaders(walletAddress: string): Promise<{ Authorization: string }> {
  return { Authorization: `Bearer ${await issuePactlyJwt(walletAddress)}` };
}

function arrivedAt(sqlite: ReturnType<typeof openTestDatabase>["sqlite"], bookingId: string): number | null {
  const row = sqlite.prepare("SELECT arrived_at FROM bookings WHERE id = ?").get(bookingId) as
    | { arrived_at: number | null }
    | undefined;
  return row?.arrived_at ?? null;
}

async function lockBooking(result: ReturnType<typeof openTestDatabase>, bookingId: string): Promise<void> {
  await result.db.update(bookings).set({ escrowState: "locked" }).where(eq(bookings.id, bookingId));
}

async function addSlot(
  result: ReturnType<typeof openTestDatabase>,
  slotId: string,
  providerProfileId: string,
  startsAt: number,
): Promise<void> {
  await result.db.insert(availabilitySlots).values({
    id: slotId,
    providerProfileId,
    startsAt,
    createdAt: Date.now(),
  });
}

test("POST /bookings/:id/arrived refuses before appointment start", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const providerWallet = "GPROVIDERARRIVED";
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWallet });

    const futureSlot = now + 3600; // 1 hour in future
    const bookingId = await createBookingHold(result.db, {
      providerProfileId,
      clientWalletAddress: "GCLIENTARRIVED",
      tokenAddress: "CUSDC",
      depositAmount: "1000000",
      cancelDeadline: futureSlot - 86400,
      slotId: "slot-future",
      holdExpiresAt: now + 600,
    });

    // Force escrowState to locked (normally set by reconciler)
    await lockBooking(result, bookingId);

    // Create the slot
    await addSlot(result, "slot-future", providerProfileId, futureSlot);

    const app = createApp(result.db);
    const response = await app.request(`/bookings/${bookingId}/arrived`, {
      method: "POST",
      headers: await authHeaders(providerWallet),
    });

    assert.equal(response.status, 409);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "BOOKING_STATE");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/arrived accepts at or after appointment start", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const providerWallet = "GPROVIDERARRIVED2";
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWallet });

    const pastSlot = now - 300; // 5 minutes ago
    const bookingId = await createBookingHold(result.db, {
      providerProfileId,
      clientWalletAddress: "GCLIENTARRIVED2",
      tokenAddress: "CUSDC",
      depositAmount: "1000000",
      cancelDeadline: pastSlot - 86400,
      slotId: "slot-past",
      holdExpiresAt: now + 600,
    });

    // Force escrowState to locked
    await lockBooking(result, bookingId);

    // Create the slot
    await addSlot(result, "slot-past", providerProfileId, pastSlot);

    const app = createApp(result.db);
    const response = await app.request(`/bookings/${bookingId}/arrived`, {
      method: "POST",
      headers: await authHeaders(providerWallet),
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok?: boolean };
    assert.equal(body.ok, true);

    // Verify arrivedAt was set
    const arrived = arrivedAt(result.sqlite, bookingId);
    assert.ok(arrived);
    assert.ok(arrived <= now + 1); // Within 1 second of now
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/arrived keeps first timestamp on second call", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const providerWallet = "GPROVIDERARRIVED3";
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWallet });

    const pastSlot = now - 300;
    const bookingId = await createBookingHold(result.db, {
      providerProfileId,
      clientWalletAddress: "GCLIENTARRIVED3",
      tokenAddress: "CUSDC",
      depositAmount: "1000000",
      cancelDeadline: pastSlot - 86400,
      slotId: "slot-past2",
      holdExpiresAt: now + 600,
    });

    await lockBooking(result, bookingId);
    await addSlot(result, "slot-past2", providerProfileId, pastSlot);

    const app = createApp(result.db);
    const headers = await authHeaders(providerWallet);

    // First call
    const response1 = await app.request(`/bookings/${bookingId}/arrived`, {
      method: "POST",
      headers,
    });
    assert.equal(response1.status, 200);

    const firstTimestamp = arrivedAt(result.sqlite, bookingId);
    assert.ok(firstTimestamp);

    // Second call
    const response2 = await app.request(`/bookings/${bookingId}/arrived`, {
      method: "POST",
      headers,
    });
    assert.equal(response2.status, 200);

    assert.equal(arrivedAt(result.sqlite, bookingId), firstTimestamp, "Second call should keep first timestamp");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/arrived refuses for client", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const providerWallet = "GPROVIDERARRIVED4";
    const clientWallet = "GCLIENTARRIVED4";
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWallet });

    const pastSlot = now - 300;
    const bookingId = await createBookingHold(result.db, {
      providerProfileId,
      clientWalletAddress: clientWallet,
      tokenAddress: "CUSDC",
      depositAmount: "1000000",
      cancelDeadline: pastSlot - 86400,
      slotId: "slot-past3",
      holdExpiresAt: now + 600,
    });

    await lockBooking(result, bookingId);
    await addSlot(result, "slot-past3", providerProfileId, pastSlot);

    const app = createApp(result.db);

    // Client tries to mark arrived
    const response = await app.request(`/bookings/${bookingId}/arrived`, {
      method: "POST",
      headers: await authHeaders(clientWallet),
    });

    assert.equal(response.status, 404);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});
