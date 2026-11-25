/**
 * Admin suspension: an approved shop can be suspended with a reason and
 * unsuspended again. A suspended shop is absent from discovery and search
 * and cannot receive a new hold, while every existing booking keeps
 * loading for both sides. Driven through `app.request(...)` like
 * `app-provider-applications.test.ts`; the admin env fixture supplies a
 * real admin wallet.
 */
import "./testConfigEnvAdmin.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import type { EscrowAdapter } from "../src/escrow/interface.js";
import { BookingEscrowStateError, holdSlot, lockDeposit, ProviderNotFoundError } from "../src/services/booking.js";
import { NON_RESOLVER_ADMIN_WALLET } from "./testConfigEnvAdmin.js";
import { closeDatabase, openTestDatabase, seedBooking, seedCategory, seedProviderProfile } from "./helpers.js";

const PROVIDER_WALLET = "GPROVIDERWALLETFORSUSPENSIONTESTS0";
const CLIENT_WALLET = "GCLIENTWALLETFORSUSPENSIONTESTS00";

const FAKE_USDC_DEPS = {
  resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000" }),
};

async function bearer(walletAddress: string): Promise<{ authorization: string; "content-type": string }> {
  return { authorization: `Bearer ${await issuePactlyJwt(walletAddress)}`, "content-type": "application/json" };
}

async function suspend(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  providerId: string,
  reason: string,
) {
  return app.request(`/admin/providers/${providerId}/suspend`, {
    method: "POST",
    headers,
    body: JSON.stringify({ reason }),
  });
}

test("a suspended shop is absent from discovery and search, and its open booking still loads", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-suspend", "Hair clinic");
    const providerProfileId = await seedProviderProfile(result, {
      categoryId,
      walletAddress: PROVIDER_WALLET,
      displayName: "Suspended Salon",
      title: "Haircuts and beard trims",
      isApproved: true,
    });
    const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress: CLIENT_WALLET });
    await replaceFutureSlots(result.db, providerProfileId, [Math.floor(Date.now() / 1000) + 3600]);

    const app = createApp(result.db);
    const admin = await bearer(NON_RESOLVER_ADMIN_WALLET);
    const provider = await bearer(PROVIDER_WALLET);
    const client = await bearer(CLIENT_WALLET);

    // Discoverable before the suspension.
    const listedBefore = await app.request("/providers");
    assert.equal(((await listedBefore.json()) as { providers: unknown[] }).providers.length, 1);

    const response = await suspend(app, admin, providerProfileId, "Two chargebacks under review");
    assert.equal(response.status, 200);
    const suspended = (await response.json()) as {
      profile: { isSuspended: boolean; suspensionReason: string | null; isApproved: boolean };
    };
    assert.equal(suspended.profile.isSuspended, true);
    assert.equal(suspended.profile.suspensionReason, "Two chargebacks under review");
    assert.equal(suspended.profile.isApproved, true, "suspension never un-approves the shop");

    // Gone from the list, the search and the suggestion counts.
    const listedAfter = await app.request("/providers");
    assert.deepEqual(((await listedAfter.json()) as { providers: unknown[] }).providers, []);

    const searched = await app.request("/providers?q=Suspended");
    assert.deepEqual(((await searched.json()) as { providers: unknown[] }).providers, []);

    const suggested = await app.request("/providers/suggest?q=Suspended");
    assert.deepEqual(((await suggested.json()) as { suggestions: unknown[] }).suggestions, []);

    const categories = (await (await app.request("/categories")).json()) as {
      categories: Array<{ id: string; providerCount: number }>;
    };
    assert.equal(categories.categories.find((category) => category.id === categoryId)?.providerCount, 0);

    // And the public profile is no longer reachable.
    const profile = await app.request(`/providers/${providerProfileId}`);
    assert.equal(profile.status, 404);
    assert.equal(((await profile.json()) as { code: string }).code, "PROVIDER_NOT_FOUND");

    // Existing bookings stay visible to both sides.
    const bookingForClient = await app.request(`/bookings/${bookingId}`, { headers: client });
    assert.equal(bookingForClient.status, 200);
    const bookingView = (await bookingForClient.json()) as { id: string; provider: { displayName: string } };
    assert.equal(bookingView.id, bookingId);
    assert.equal(bookingView.provider.displayName, "Suspended Salon");

    const myBookings = await app.request("/me/bookings", { headers: client });
    assert.equal(myBookings.status, 200);
    const clientBookings = (await myBookings.json()) as { bookings: Array<{ id: string }> };
    assert.deepEqual(
      clientBookings.bookings.map((booking) => booking.id),
      [bookingId],
    );

    const bookingsForProvider = await app.request("/me/provider/bookings", { headers: provider });
    assert.equal(bookingsForProvider.status, 200);
    const providerBookings = (await bookingsForProvider.json()) as { bookings: Array<{ id: string }> };
    assert.equal(providerBookings.bookings.length, 1);
    assert.equal(providerBookings.bookings[0]?.id, bookingId);

    // The shop's own panel still resolves and carries the reason to show.
    const own = await app.request("/me/provider", { headers: provider });
    assert.equal(own.status, 200);
    const ownProfile = (await own.json()) as { isSuspended: boolean; suspensionReason: string | null };
    assert.equal(ownProfile.isSuspended, true);
    assert.equal(ownProfile.suspensionReason, "Two chargebacks under review");
  } finally {
    closeDatabase(result);
  }
});

test("suspending twice keeps the latest reason, and unsuspending restores the listing", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, {
      walletAddress: PROVIDER_WALLET,
      displayName: "Restorable Salon",
      isApproved: true,
    });
    await replaceFutureSlots(result.db, providerProfileId, [Math.floor(Date.now() / 1000) + 3600]);
    const app = createApp(result.db);
    const admin = await bearer(NON_RESOLVER_ADMIN_WALLET);

    const first = await suspend(app, admin, providerProfileId, "First reason");
    assert.equal(first.status, 200);

    const second = await suspend(app, admin, providerProfileId, "Second, newer reason");
    assert.equal(second.status, 200);
    const body = (await second.json()) as { profile: { suspensionReason: string | null } };
    assert.equal(body.profile.suspensionReason, "Second, newer reason");

    const removed = await app.request("/providers");
    assert.deepEqual(((await removed.json()) as { providers: unknown[] }).providers, []);

    const unsuspended = await app.request(`/admin/providers/${providerProfileId}/unsuspend`, {
      method: "POST",
      headers: admin,
    });
    assert.equal(unsuspended.status, 200);
    const after = (await unsuspended.json()) as { profile: { isSuspended: boolean; suspensionReason: string | null } };
    assert.equal(after.profile.isSuspended, false);
    assert.equal(after.profile.suspensionReason, null);

    const relisted = await app.request("/providers");
    assert.equal(((await relisted.json()) as { providers: unknown[] }).providers.length, 1);
  } finally {
    closeDatabase(result);
  }
});

test("a suspended shop cannot receive a new hold until it is unsuspended", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, {
      walletAddress: PROVIDER_WALLET,
      isApproved: true,
    });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);

    const app = createApp(result.db);
    const admin = await bearer(NON_RESOLVER_ADMIN_WALLET);
    assert.equal((await suspend(app, admin, providerProfileId, "Paused while under review")).status, 200);

    await assert.rejects(
      holdSlot(
        result.db,
        { providerProfileId, clientWalletAddress: CLIENT_WALLET, slotStartsAt },
        FAKE_USDC_DEPS,
      ),
      ProviderNotFoundError,
    );

    const unsuspend = await app.request(`/admin/providers/${providerProfileId}/unsuspend`, {
      method: "POST",
      headers: admin,
    });
    assert.equal(unsuspend.status, 200);

    const hold = await holdSlot(
      result.db,
      { providerProfileId, clientWalletAddress: CLIENT_WALLET, slotStartsAt },
      FAKE_USDC_DEPS,
    );
    assert.ok(hold.bookingId);
  } finally {
    closeDatabase(result);
  }
});

test("a hold placed before a suspension cannot start a new lock", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, {
      walletAddress: PROVIDER_WALLET,
      isApproved: true,
    });
    const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress: CLIENT_WALLET });
    const app = createApp(result.db);
    const admin = await bearer(NON_RESOLVER_ADMIN_WALLET);
    assert.equal((await suspend(app, admin, providerProfileId, "Paused while under review")).status, 200);

    // The adapter is never reached: the suspension is refused first.
    const adapter = {} as EscrowAdapter;
    await assert.rejects(lockDeposit(result.db, bookingId, adapter), BookingEscrowStateError);
  } finally {
    closeDatabase(result);
  }
});

test("a pending application cannot be suspended -- it can be rejected instead", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-pending", "Barbershop");
    const app = createApp(result.db);
    const applicant = await bearer("GAPPLICANTWALLETFORSUSPENSIONTESTS");
    const admin = await bearer(NON_RESOLVER_ADMIN_WALLET);

    const created = await app.request("/me/provider/application", {
      method: "POST",
      headers: applicant,
      body: JSON.stringify({
        name: "Pending Barber",
        title: "Barber · cut and beard",
        categoryId,
        location: "Kadıköy, Istanbul",
        serviceDescription: "Cut and beard in a two-chair shop, forty minutes, walk-ins welcome.",
        sessionFormat: "in_person",
        sessionLengthMinutes: 40,
        priceAmount: "20000000",
        depositRateBps: 2500,
        cancellationWindowHours: 6,
      }),
    });
    assert.equal(created.status, 201);
    const application = (await created.json()) as { application: { id: string; profileId: string } };

    const refused = await suspend(app, admin, application.application.profileId, "Not listed yet");
    assert.equal(refused.status, 409);
    assert.equal(((await refused.json()) as { code: string }).code, "PROVIDER_NOT_APPROVED");

    const rejected = await app.request(`/admin/applications/${application.application.id}/decide`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ outcome: "reject", reason: "Not a fit for the marketplace yet." }),
    });
    assert.equal(rejected.status, 200);
    assert.equal(((await rejected.json()) as { application: { state: string } }).application.state, "rejected");
  } finally {
    closeDatabase(result);
  }
});

test("only an admin may suspend, and a suspension needs a reason", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, {
      walletAddress: PROVIDER_WALLET,
      isApproved: true,
    });
    const app = createApp(result.db);
    const provider = await bearer(PROVIDER_WALLET);
    const admin = await bearer(NON_RESOLVER_ADMIN_WALLET);

    const asProvider = await suspend(app, provider, providerProfileId, "Trying to suspend myself");
    assert.equal(asProvider.status, 404);
    assert.equal(((await asProvider.json()) as { code: string }).code, "NOT_ADMIN");

    const noReason = await suspend(app, admin, providerProfileId, "   ");
    assert.equal(noReason.status, 400);
    const invalid = (await noReason.json()) as { code: string; details: Record<string, string> };
    assert.equal(invalid.code, "INVALID_SUSPENSION_REASON");
    assert.ok(invalid.details.reason);

    const unknown = await suspend(app, admin, "no-such-provider", "Whatever");
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { code: string }).code, "PROVIDER_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});
