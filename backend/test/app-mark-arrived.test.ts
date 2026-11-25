/**
 * The shop's `POST /bookings/:id/arrived` route: only the provider of a
 * locked booking may mark the client arrived, and never before the
 * appointment's own start time. First write wins -- a second call does not
 * move the timestamp.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { getBookingById, updateEscrowStateSync } from "../src/db/bookings.js";
import { availabilitySlots, bookings } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import { closeDatabase, openTestDatabase, seedBooking, seedProviderProfile } from "./helpers.js";

async function bearer(walletAddress: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await issuePactlyJwt(walletAddress)}`, "content-type": "application/json" };
}

/** A booking with a concrete slot and the reconciler's own `locked` state,
 * without going through the escrow adapter (this route only reads state). */
async function seedLockedBooking(
  result: ReturnType<typeof openTestDatabase>,
  providerWallet: string,
  clientWallet: string,
  slotStartsAt: number,
): Promise<string> {
  const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWallet });
  const slotId = `slot-${providerWallet}`;
  await result.db.insert(availabilitySlots).values({
    id: slotId,
    providerProfileId,
    startsAt: slotStartsAt,
    createdAt: Date.now(),
  });
  const bookingId = await seedBooking(result, {
    providerProfileId,
    clientWalletAddress: clientWallet,
    cancelDeadline: slotStartsAt - 86400,
  });
  await result.db.update(bookings).set({ slotId }).where(eq(bookings.id, bookingId));
  updateEscrowStateSync(result.db, bookingId, "locked");
  return bookingId;
}

test("POST /bookings/:id/arrived refuses before appointment start", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const providerWallet = "GPROVIDERARRIVED";
    const bookingId = await seedLockedBooking(result, providerWallet, "GCLIENTARRIVED", now + 3600);

    const app = createApp(result.db);
    const response = await app.request(`/bookings/${bookingId}/arrived`, {
      method: "POST",
      headers: await bearer(providerWallet),
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, "BOOKING_STATE");
    assert.equal((await getBookingById(result.db, bookingId))?.arrivedAt, null);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/arrived accepts at or after appointment start", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const providerWallet = "GPROVIDERARRIVED2";
    const bookingId = await seedLockedBooking(result, providerWallet, "GCLIENTARRIVED2", now - 300);

    const app = createApp(result.db);
    const response = await app.request(`/bookings/${bookingId}/arrived`, {
      method: "POST",
      headers: await bearer(providerWallet),
    });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { ok: boolean }).ok, true);
    const arrivedAt = (await getBookingById(result.db, bookingId))?.arrivedAt;
    assert.ok(arrivedAt);
    assert.ok(arrivedAt <= now + 1);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/arrived keeps first timestamp on second call", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const providerWallet = "GPROVIDERARRIVED3";
    const bookingId = await seedLockedBooking(result, providerWallet, "GCLIENTARRIVED3", now - 300);

    const app = createApp(result.db);
    const headers = await bearer(providerWallet);
    const first = await app.request(`/bookings/${bookingId}/arrived`, { method: "POST", headers });
    assert.equal(first.status, 200);
    const firstTimestamp = (await getBookingById(result.db, bookingId))?.arrivedAt;
    assert.ok(firstTimestamp);

    const second = await app.request(`/bookings/${bookingId}/arrived`, { method: "POST", headers });
    assert.equal(second.status, 200);
    assert.equal((await getBookingById(result.db, bookingId))?.arrivedAt, firstTimestamp);
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
    const bookingId = await seedLockedBooking(result, providerWallet, clientWallet, now - 300);

    const app = createApp(result.db);
    const response = await app.request(`/bookings/${bookingId}/arrived`, {
      method: "POST",
      headers: await bearer(clientWallet),
    });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});
