import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

import {
  buildReleaseMailto,
  getBookingView,
  holdSlot,
  isBookingCancelled,
  listBookingsForClient,
  listBookingsForProvider,
  silenceClientReminder,
} from "../src/services/booking.js";
import { updateProviderRules } from "../src/services/profile.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import {
  getBookingById,
  markClientReminderShown,
  markProviderReminderShown,
  updateEscrowStateSync,
  declineBookingHold,
} from "../src/db/bookings.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC_DEPS = { resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }) };
const NOW = 1_700_000_000;

test("Issue #153: do not remind anyone about a booking that was cancelled", async () => {
  const result = openTestDatabase();
  try {
    const providerWallet = Keypair.random().publicKey();
    const clientWallet = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWallet });
    const slotStartsAt = NOW + 3600; // 1 hour out (within 24h)
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], NOW);

    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: clientWallet, slotStartsAt, clientEmail: "client@example.com" },
      { now: NOW, resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset },
    );
    // Lock deposit
    updateEscrowStateSync(result.db, hold.bookingId, "locked");

    // Decline / cancel hold
    await declineBookingHold(result.db, hold.bookingId, NOW + 10);

    const bookingRow = await getBookingById(result.db, hold.bookingId);
    assert.ok(bookingRow);
    assert.equal(isBookingCancelled(bookingRow), true);

    // Client view shows noFurtherReminder is true, and reminderShown is false
    const view = await getBookingView(result.db, hold.bookingId, clientWallet, NOW + 20);
    assert.equal(view.noFurtherReminder, true);
    assert.equal(view.reminderShown, false);

    // List bookings for client: reminder is not shown
    const clientBookings = await listBookingsForClient(result.db, clientWallet, NOW + 20);
    assert.equal(clientBookings.length, 1);
    assert.equal(clientBookings[0]!.noFurtherReminder, true);

    // List bookings for provider: reminder is not shown
    const providerBookings = await listBookingsForProvider(result.db, providerWallet, NOW + 20);
    assert.equal(providerBookings.length, 1);
    assert.equal(providerBookings[0]!.noFurtherReminder, true);

    const bookingAfter = await getBookingById(result.db, hold.bookingId);
    assert.equal(bookingAfter?.clientReminderShownAt, null);
    assert.equal(bookingAfter?.providerReminderShownAt, null);
  } finally {
    closeDatabase(result);
  }
});

test("Issue #153: returned deposit is treated as cancelled and reminder already sent stays sent", async () => {
  const result = openTestDatabase();
  try {
    const providerWallet = Keypair.random().publicKey();
    const clientWallet = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWallet });
    const slotStartsAt = NOW + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], NOW);

    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: clientWallet, slotStartsAt },
      { now: NOW, resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset },
    );
    updateEscrowStateSync(result.db, hold.bookingId, "locked");

    // Client reminder previously sent
    await markClientReminderShown(result.db, hold.bookingId, NOW - 100);

    // Refunded escrow (returned deposit)
    updateEscrowStateSync(result.db, hold.bookingId, "refunded");

    const view = await getBookingView(result.db, hold.bookingId, clientWallet, NOW);
    assert.equal(view.noFurtherReminder, true);
    assert.equal(view.reminderShown, false);

    const booking = await getBookingById(result.db, hold.bookingId);
    assert.equal(booking?.clientReminderShownAt, NOW - 100, "reminder already sent stays sent");
  } finally {
    closeDatabase(result);
  }
});

test("Issue #152: client can silence reminder on one booking", async () => {
  const result = openTestDatabase();
  try {
    const providerWallet = Keypair.random().publicKey();
    const clientWallet = Keypair.random().publicKey();
    const otherClientWallet = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWallet });
    const slotStartsAt = NOW + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], NOW);

    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: clientWallet, slotStartsAt },
      { now: NOW, resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset },
    );
    updateEscrowStateSync(result.db, hold.bookingId, "locked");

    // Other client cannot silence it
    await assert.rejects(
      () => silenceClientReminder(result.db, hold.bookingId, otherClientWallet, true),
      /No booking was found/,
    );

    // Client silences reminder
    await silenceClientReminder(result.db, hold.bookingId, clientWallet, true);
    const booking = await getBookingById(result.db, hold.bookingId);
    assert.equal(Boolean(booking?.clientReminderSilenced), true);

    // Client view does not show reminder
    const view = await getBookingView(result.db, hold.bookingId, clientWallet, NOW + 10);
    assert.equal(view.reminderShown, false);
    assert.equal(view.clientReminderSilenced, true);

    // List bookings for client does not mark client reminder
    await listBookingsForClient(result.db, clientWallet, NOW + 10);
    const bookingAfterClient = await getBookingById(result.db, hold.bookingId);
    assert.equal(bookingAfterClient?.clientReminderShownAt, null);

    // Shop reminder is UNCHANGED and still sends
    await listBookingsForProvider(result.db, providerWallet, NOW + 10);
    const bookingAfterShop = await getBookingById(result.db, hold.bookingId);
    assert.equal(bookingAfterShop?.providerReminderShownAt, NOW + 10);
  } finally {
    closeDatabase(result);
  }
});

test("Issue #151: shop can use same-morning reminder instead of day-before", async () => {
  const result = openTestDatabase();
  try {
    const providerWallet = Keypair.random().publicKey();
    const clientWallet = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWallet });

    // Switch shop rule to same-morning
    await updateProviderRules(result.db, providerWallet, {
      priceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
      reminderTiming: "same-morning",
    });

    // Slot is tomorrow at 10:00 UTC
    // Let's set slotStartsAt to 2026-06-15T10:00:00Z (epoch 1781517600)
    const slotStartsAt = 1781517600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], slotStartsAt - 86400);

    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: clientWallet, slotStartsAt },
      { now: slotStartsAt - 86400, resolveUsdcAsset: FAKE_USDC_DEPS.resolveUsdcAsset },
    );
    updateEscrowStateSync(result.db, hold.bookingId, "locked");

    // 1. Day before (2026-06-14T10:00:00Z, 24h before): same-morning reminder should NOT trigger
    const dayBeforeNow = slotStartsAt - 24 * 3600;
    await listBookingsForProvider(result.db, providerWallet, dayBeforeNow);
    let row = await getBookingById(result.db, hold.bookingId);
    assert.equal(row?.providerReminderShownAt, null, "day before does not trigger same-morning reminder");

    // 2. Morning of appointment (2026-06-15T08:00:00Z, 2h before slot): same-morning reminder DOES trigger
    const morningNow = slotStartsAt - 2 * 3600;
    await listBookingsForProvider(result.db, providerWallet, morningNow);
    row = await getBookingById(result.db, hold.bookingId);
    assert.equal(row?.providerReminderShownAt, morningNow, "morning of appointment triggers reminder");

    // 3. Choice changed or re-run: booking that already had reminder sent is not sent a second one
    await listBookingsForProvider(result.db, providerWallet, morningNow + 300);
    row = await getBookingById(result.db, hold.bookingId);
    assert.equal(row?.providerReminderShownAt, morningNow, "reminder stays at original sent timestamp");
  } finally {
    closeDatabase(result);
  }
});

test("Issue #150: buildReleaseMailto with one-off recipient uses typed address without altering client email", () => {
  const result = buildReleaseMailto({
    escrowState: "released",
    clientEmail: "stored@example.com",
    oneOffRecipient: "typed@example.com",
    shopName: "Demo Shop",
    slotStartsAt: NOW,
    proofUrl: "https://pactly.example/proof/123",
  });

  assert.ok(result);
  assert.ok(result.startsWith("mailto:typed@example.com"));
  assert.ok(!result.includes("stored@example.com"));

  // Blank one-off falls back to stored clientEmail
  const fallback = buildReleaseMailto({
    escrowState: "released",
    clientEmail: "stored@example.com",
    oneOffRecipient: "   ",
    shopName: "Demo Shop",
    slotStartsAt: NOW,
    proofUrl: "https://pactly.example/proof/123",
  });
  assert.ok(fallback?.startsWith("mailto:stored@example.com"));

  // Invalid email is refused
  const invalid = buildReleaseMailto({
    escrowState: "released",
    clientEmail: "stored@example.com",
    oneOffRecipient: "not-an-email",
    shopName: "Demo Shop",
    slotStartsAt: NOW,
    proofUrl: "https://pactly.example/proof/123",
  });
  assert.equal(invalid, undefined);
});
