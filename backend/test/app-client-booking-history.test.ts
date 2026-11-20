/**
 * Client booking history: a signed-in client's bookings across every shop,
 * with a third wallet as the boundary. The validation case from the story is
 * explicit here -- two shops, one client, and another wallet whose booking
 * must never appear in the client's list.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC_DEPS = { resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }) };

interface ListItem {
  id: string;
  slotStartsAt: number | null;
  escrowState: string | null;
  deposit: { amount: string; asset: string };
  isExpiredHold: boolean;
  provider: { id: string; displayName: string; title: string; bio?: string; notes?: string };
}

async function headers(wallet: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await issuePactlyJwt(wallet)}` };
}

test("GET /me/bookings lists two shops' bookings for one client but never a third wallet's", async () => {
  const result = openTestDatabase();
  try {
    const shopA = await seedProviderProfile(result, { isApproved: true, displayName: "Shop A", bio: "private note A" });
    const shopB = await seedProviderProfile(result, { isApproved: true, displayName: "Shop B", bio: "private note B" });
    const now = Math.floor(Date.now() / 1000);
    const clientA = now + 3600;
    const clientB = now + 7200;
    const strangerSlot = now + 10_800;
    await replaceFutureSlots(result.db, shopA, [clientA, strangerSlot]);
    await replaceFutureSlots(result.db, shopB, [clientB]);

    const client = "GHISTORYCLIENT";
    const a = await holdSlot(result.db, { providerProfileId: shopA, clientWalletAddress: client, slotStartsAt: clientA }, FAKE_USDC_DEPS);
    const b = await holdSlot(result.db, { providerProfileId: shopB, clientWalletAddress: client, slotStartsAt: clientB }, FAKE_USDC_DEPS);
    const stranger = await holdSlot(
      result.db,
      { providerProfileId: shopA, clientWalletAddress: "GHISTORYSTRANGER", slotStartsAt: strangerSlot },
      FAKE_USDC_DEPS,
    );

    const app = createApp(result.db);
    const mine = await app.request("/me/bookings", { headers: await headers(client) });
    assert.equal(mine.status, 200);
    const { bookings } = (await mine.json()) as { bookings: ListItem[] };
    assert.deepEqual(bookings.map((item) => item.id), [a.bookingId, b.bookingId], "newest upcoming appointment first");
    assert.equal(bookings.some((item) => item.id === stranger.bookingId), false, "another wallet is out of scope");
    assert.deepEqual(
      bookings.map((item) => item.provider.displayName),
      ["Shop A", "Shop B"],
      "each row names the shop it belongs to",
    );
    assert.ok(bookings.every((item) => item.deposit.amount !== undefined && item.slotStartsAt !== null));
    assert.ok(
      bookings.every((item) => !("bio" in item.provider) && !("notes" in item.provider)),
      "the shop's private notes never reach the client's list",
    );

    // The third wallet sees only its own booking.
    const theirs = await app.request("/me/bookings", { headers: await headers("GHISTORYSTRANGER") });
    const strangerBody = (await theirs.json()) as { bookings: ListItem[] };
    assert.deepEqual(strangerBody.bookings.map((item) => item.id), [stranger.bookingId]);
  } finally {
    closeDatabase(result);
  }
});

test("an expired, never-funded hold is labelled expired rather than funded", async () => {
  const result = openTestDatabase();
  try {
    const shop = await seedProviderProfile(result, { isApproved: true });
    const pastNow = Math.floor(Date.now() / 1000) - 3600;
    const slot = pastNow + 1200;
    await replaceFutureSlots(result.db, shop, [slot], pastNow);
    const client = "GEXPIREDHISTORYCLIENT";
    const hold = await holdSlot(result.db, { providerProfileId: shop, clientWalletAddress: client, slotStartsAt: slot },
      { now: pastNow, ...FAKE_USDC_DEPS });
    assert.ok(hold.holdExpiresAt < Math.floor(Date.now() / 1000));

    const app = createApp(result.db);
    const { bookings } = (await (await app.request("/me/bookings", { headers: await headers(client) })).json()) as {
      bookings: ListItem[];
    };
    const item = bookings.find((booking) => booking.id === hold.bookingId);
    assert.ok(item, "the expired hold stays in the list for traceability");
    assert.equal(item?.isExpiredHold, true);
    assert.equal(item?.escrowState, null, "it is never reported as funded");
  } finally {
    closeDatabase(result);
  }
});
