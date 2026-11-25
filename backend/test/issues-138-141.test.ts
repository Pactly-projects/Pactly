import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  getPublicProviderProfile,
  listDiscoverProviders,
  setProviderBookingsPaused,
  suspendProviderProfile,
} from "../src/services/profile.js";
import {
  getSlotUnbookableReason,
  holdSlot,
} from "../src/services/booking.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { insertClosedDate } from "../src/db/closedDates.js";
import { closeDatabase, openTestDatabase, seedCategory, seedProviderProfile, FAKE_USDC } from "./helpers.js";

test("Issue #138: orders three fixture shops by their soonest next open slot ascending, slotless last", async () => {
  const result = openTestDatabase();
  try {
    const now = 1_000_000;
    const cat = await seedCategory(result, "cat-138");
    const shopEarly = await seedProviderProfile(result, {
      categoryId: cat,
      displayName: "Early Shop",
      isApproved: true,
    });
    const shopMid = await seedProviderProfile(result, {
      categoryId: cat,
      displayName: "Mid Shop",
      isApproved: true,
    });
    const shopLate = await seedProviderProfile(result, {
      categoryId: cat,
      displayName: "Late Shop",
      isApproved: true,
    });
    const shopNoSlots = await seedProviderProfile(result, {
      categoryId: cat,
      displayName: "No Slots Shop",
      isApproved: true,
    });

    await replaceFutureSlots(result.db, shopEarly, [now + 1800, now + 3600], now);
    await replaceFutureSlots(result.db, shopMid, [now + 7200], now);
    await replaceFutureSlots(result.db, shopLate, [now + 14400], now);
    await replaceFutureSlots(result.db, shopNoSlots, [], now);

    const cards = await listDiscoverProviders(result.db, undefined, { sort: "soonest" }, now);
    const ids = cards.map((c) => c.id);

    assert.equal(ids[0], shopEarly);
    assert.equal(ids[1], shopMid);
    assert.equal(ids[2], shopLate);
    assert.equal(ids[3], shopNoSlots);
  } finally {
    closeDatabase(result);
  }
});

test("Issue #138: a paused shop is not pulled to top by an old slot", async () => {
  const result = openTestDatabase();
  try {
    const now = 1_000_000;
    const cat = await seedCategory(result, "cat-paused-sort");
    const shopOpen = await seedProviderProfile(result, {
      categoryId: cat,
      displayName: "Open Shop",
      isApproved: true,
    });
    const shopPaused = await seedProviderProfile(result, {
      categoryId: cat,
      displayName: "Paused Shop",
      isApproved: true,
      walletAddress: "GB_PAUSED_WALLET",
    });

    // Paused shop has earlier slot than open shop
    await replaceFutureSlots(result.db, shopPaused, [now + 1800], now);
    await replaceFutureSlots(result.db, shopOpen, [now + 7200], now);

    await setProviderBookingsPaused(result.db, "GB_PAUSED_WALLET", true, now);

    const cards = await listDiscoverProviders(result.db, undefined, { sort: "soonest" }, now);
    assert.equal(cards[0]?.id, shopOpen);
    assert.equal(cards[1]?.id, shopPaused);
    assert.equal(cards[1]?.earliestSlots.length, 0);
  } finally {
    closeDatabase(result);
  }
});

test("Issue #139: show a paused shop on its own URL as paused and refuses a hold", async () => {
  const result = openTestDatabase();
  try {
    const now = 1_000_000;
    const cat = await seedCategory(result, "cat-139");
    const shopId = await seedProviderProfile(result, {
      categoryId: cat,
      displayName: "Paused Shop",
      isApproved: true,
      walletAddress: "GB_PAUSED_139",
    });

    await replaceFutureSlots(result.db, shopId, [now + 3600], now);
    await setProviderBookingsPaused(result.db, "GB_PAUSED_139", true, now);

    // Profile still opens and says bookings are paused, but offers no slots
    const profile = await getPublicProviderProfile(result.db, shopId, now);
    assert.equal(profile.bookingsPaused, true);
    assert.equal(profile.slots.length, 0);

    // Refuses holdSlot
    await assert.rejects(
      () =>
        holdSlot(
          result.db,
          {
            providerProfileId: shopId,
            clientWalletAddress: "GB_CLIENT_HOLD",
            slotStartsAt: now + 3600,
          },
          { now },
        ),
      { name: "BookingsPausedError" },
    );
  } finally {
    closeDatabase(result);
  }
});

test("Issue #140: suspended shop shows explanation to owner and hides it from others", async () => {
  const result = openTestDatabase();
  try {
    const now = 1_000_000;
    const cat = await seedCategory(result, "cat-140");
    const ownerWallet = "GB_SUSPENDED_OWNER";
    const otherWallet = "GB_OTHER_CALLER";
    const shopId = await seedProviderProfile(result, {
      categoryId: cat,
      displayName: "Suspended Shop",
      isApproved: true,
      walletAddress: ownerWallet,
    });

    await suspendProviderProfile(result.db, shopId, "Policy violation investigation", now * 1000);

    // Other caller or unauthenticated gets ProviderNotFoundError
    await assert.rejects(
      () => getPublicProviderProfile(result.db, shopId, now, otherWallet),
      { name: "ProviderNotFoundError" },
    );
    await assert.rejects(
      () => getPublicProviderProfile(result.db, shopId, now, undefined),
      { name: "ProviderNotFoundError" },
    );

    // Owner caller sees explanation with reason and empty slots
    const ownerView = await getPublicProviderProfile(result.db, shopId, now, ownerWallet);
    assert.equal(ownerView.isSuspended, true);
    assert.equal(ownerView.suspensionReason, "Policy violation investigation");
    assert.equal(ownerView.slots.length, 0);
  } finally {
    closeDatabase(result);
  }
});

test("Issue #141: slot unbookable reason strictly follows order", async () => {
  const result = openTestDatabase();
  try {
    const now = 1_000_000;
    const cat = await seedCategory(result, "cat-141");
    const shopId = await seedProviderProfile(result, {
      categoryId: cat,
      displayName: "Reason Shop",
      isApproved: true,
      minimumNoticeMinutes: 60, // 1 hour notice
      walletAddress: "GB_REASON_OWNER",
    });

    const slotPast = now - 900;
    const slotTooSoon = now + 1800; // 30 min ahead < 60 min notice
    const slotBookable = now + 7200; // 2 hours ahead

    await replaceFutureSlots(result.db, shopId, [slotPast, slotTooSoon, slotBookable], now - 1000);

    // 1. past
    const reasonPast = await getSlotUnbookableReason(result.db, shopId, slotPast, now);
    assert.equal(reasonPast, "past");

    // 2. too soon
    const reasonTooSoon = await getSlotUnbookableReason(result.db, shopId, slotTooSoon, now);
    assert.equal(reasonTooSoon, "too soon");

    // Bookable before hold
    const reasonBookable = await getSlotUnbookableReason(result.db, shopId, slotBookable, now);
    assert.equal(reasonBookable, null);

    // 4. held
    await holdSlot(
      result.db,
      {
        providerProfileId: shopId,
        clientWalletAddress: "GB_CLIENT_141",
        slotStartsAt: slotBookable,
      },
      { now, resolveUsdcAsset: async () => FAKE_USDC },
    );
    const reasonHeld = await getSlotUnbookableReason(result.db, shopId, slotBookable, now);
    assert.equal(reasonHeld, "held");

    // 5. closed
    const slotClosedDate = now + 86400 * 2;
    await replaceFutureSlots(result.db, shopId, [slotClosedDate], now);
    await insertClosedDate(result.db, shopId, new Date(slotClosedDate * 1000).toISOString().slice(0, 10));
    const reasonClosed = await getSlotUnbookableReason(result.db, shopId, slotClosedDate, now);
    assert.equal(reasonClosed, "closed");

    // 6. paused
    const slotPaused = now + 86400 * 3;
    await replaceFutureSlots(result.db, shopId, [slotPaused], now);
    await setProviderBookingsPaused(result.db, "GB_REASON_OWNER", true, now);
    const reasonPaused = await getSlotUnbookableReason(result.db, shopId, slotPaused, now);
    assert.equal(reasonPaused, "paused");
  } finally {
    closeDatabase(result);
  }
});
