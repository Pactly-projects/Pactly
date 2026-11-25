/**
 * Story: Let a client save shops they want to book again (#73)
 *
 * A signed-in client can save and unsave an approved shop. A saved-shops
 * page lists them and links to the profile. A suspended or self-paused shop
 * stays on the list and is marked not taking bookings. Another client does
 * not see the list. Saving twice is a no-op. A shop the client has a booking
 * with is not saved automatically.
 */
import "./testConfigEnv.js";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { issuePactlyJwt } from "../src/auth/challenge.js";
import { createApp } from "../src/app.js";
import { providerProfiles, savedShops } from "../src/db/schema.js";
import { closeDatabase, openTestDatabase, seedCategory, seedProviderProfile, type OpenDatabaseResult } from "./helpers.js";

const PROVIDER_WALLET = "GPROVIDERWALLETFORSAVEDSHOPS001";
const CLIENT_WALLET = "GCLIENTWALLETFORSAVEDSHOPS001";
const OTHER_WALLET = "GCLIENTWALLETFORSAVEDSHOPS002";
const THIRD_WALLET = "GCLIENTWALLETFORSAVEDSHOPS003";

async function seedShop(
  result: OpenDatabaseResult,
  walletAddress: string,
  displayName: string,
  isApproved = true,
): Promise<string> {
  const categoryId = await seedCategory(result, randomUUID(), "Test Category");
  return seedProviderProfile(result, {
    walletAddress,
    categoryId,
    displayName,
    title: "Test Service",
    location: "Test City",
    sessionFormat: "in_person",
    sessionLengthMinutes: 60,
    priceAmount: "10000000",
    depositRateBps: 1000,
    cancellationWindowHours: 24,
    isApproved,
  });
}

async function save(app: ReturnType<typeof createApp>, id: string, token: string) {
  return app.request(`/providers/${id}/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  });
}

describe("Saved shops", () => {
  test("Save shop successfully", async () => {
    const result = openTestDatabase();
    try {
      const app = createApp(result.db);
      const providerId = await seedShop(result, PROVIDER_WALLET, "Test Shop");
      const clientToken = await issuePactlyJwt(CLIENT_WALLET);

      const saveRes = await save(app, providerId, clientToken);
      assert.equal(saveRes.status, 201);
      const saveData = await saveRes.json();
      assert.equal(typeof saveData.savedShopId, "string");

      const checkRes = await app.request(`/providers/${providerId}/saved`, {
        method: "GET",
        headers: { Authorization: `Bearer ${clientToken}` },
      });
      assert.equal(checkRes.status, 200);
      assert.equal((await checkRes.json()).isSaved, true);

      const listRes = await app.request("/me/saved-shops", {
        method: "GET",
        headers: { Authorization: `Bearer ${clientToken}` },
      });
      assert.equal(listRes.status, 200);
      const listData = await listRes.json();
      assert.ok(Array.isArray(listData.shops));
      assert.equal(listData.shops.length, 1);
      assert.equal(listData.shops[0].provider.id, providerId);
      assert.equal(listData.shops[0].provider.displayName, "Test Shop");
    } finally {
      closeDatabase(result);
    }
  });

  test("Saving twice is a no-op", async () => {
    const result = openTestDatabase();
    try {
      const app = createApp(result.db);
      const providerId = await seedShop(result, PROVIDER_WALLET, "Test Shop");
      const clientToken = await issuePactlyJwt(CLIENT_WALLET);

      assert.equal((await save(app, providerId, clientToken)).status, 201);
      assert.equal((await save(app, providerId, clientToken)).status, 201);

      const listRes = await app.request("/me/saved-shops", {
        method: "GET",
        headers: { Authorization: `Bearer ${clientToken}` },
      });
      assert.equal((await listRes.json()).shops.length, 1);
    } finally {
      closeDatabase(result);
    }
  });

  test("Unsave shop successfully", async () => {
    const result = openTestDatabase();
    try {
      const app = createApp(result.db);
      const providerId = await seedShop(result, PROVIDER_WALLET, "Test Shop");
      const clientToken = await issuePactlyJwt(CLIENT_WALLET);
      await save(app, providerId, clientToken);

      const unsaveRes = await app.request(`/providers/${providerId}/save`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${clientToken}` },
      });
      assert.equal(unsaveRes.status, 200);
      assert.equal((await unsaveRes.json()).unsaved, true);

      const checkRes = await app.request(`/providers/${providerId}/saved`, {
        method: "GET",
        headers: { Authorization: `Bearer ${clientToken}` },
      });
      assert.equal((await checkRes.json()).isSaved, false);

      const listRes = await app.request("/me/saved-shops", {
        method: "GET",
        headers: { Authorization: `Bearer ${clientToken}` },
      });
      assert.equal((await listRes.json()).shops.length, 0);
    } finally {
      closeDatabase(result);
    }
  });

  test("Cannot save unapproved shop", async () => {
    const result = openTestDatabase();
    try {
      const app = createApp(result.db);
      const providerId = await seedShop(result, PROVIDER_WALLET, "Unapproved Shop", false);
      const clientToken = await issuePactlyJwt(CLIENT_WALLET);

      const res = await save(app, providerId, clientToken);
      assert.equal(res.status, 409);
      assert.equal((await res.json()).code, "SHOP_NOT_APPROVED");
    } finally {
      closeDatabase(result);
    }
  });

  test("Cannot save nonexistent shop", async () => {
    const result = openTestDatabase();
    try {
      const app = createApp(result.db);
      const clientToken = await issuePactlyJwt(CLIENT_WALLET);

      const res = await save(app, "nonexistent-shop-id", clientToken);
      assert.equal(res.status, 404);
      assert.equal((await res.json()).code, "SHOP_NOT_FOUND");
    } finally {
      closeDatabase(result);
    }
  });

  test("Another client does not see the list", async () => {
    const result = openTestDatabase();
    try {
      const app = createApp(result.db);
      const providerId = await seedShop(result, PROVIDER_WALLET, "Test Shop");
      await save(app, providerId, await issuePactlyJwt(CLIENT_WALLET));

      const listRes = await app.request("/me/saved-shops", {
        method: "GET",
        headers: { Authorization: `Bearer ${await issuePactlyJwt(OTHER_WALLET)}` },
      });
      assert.equal(listRes.status, 200);
      assert.equal((await listRes.json()).shops.length, 0);
    } finally {
      closeDatabase(result);
    }
  });

  test("Suspended shop stays on the list and is marked not taking bookings", async () => {
    const result = openTestDatabase();
    try {
      const app = createApp(result.db);
      const providerId = await seedShop(result, PROVIDER_WALLET, "Test Shop");
      const clientToken = await issuePactlyJwt(CLIENT_WALLET);
      await save(app, providerId, clientToken);

      // Suspend the shop (set isApproved to false)
      await result.db.update(providerProfiles).set({ isApproved: false }).where(eq(providerProfiles.id, providerId));

      const listRes = await app.request("/me/saved-shops", {
        method: "GET",
        headers: { Authorization: `Bearer ${clientToken}` },
      });
      assert.equal(listRes.status, 200);
      const listData = await listRes.json();
      assert.equal(listData.shops.length, 1);
      assert.equal(listData.shops[0].provider.isApproved, false);
    } finally {
      closeDatabase(result);
    }
  });

  test("List saved shops newest first", async () => {
    const result = openTestDatabase();
    try {
      const app = createApp(result.db);
      const provider1Id = await seedShop(result, PROVIDER_WALLET, "Shop One");
      const provider2Id = await seedShop(result, OTHER_WALLET, "Shop Two");
      const clientToken = await issuePactlyJwt(THIRD_WALLET);

      await save(app, provider1Id, clientToken);
      await save(app, provider2Id, clientToken);
      // `createdAt` is epoch *seconds*, so a 10ms sleep would usually fall
      // inside the same second. Give the second save an unambiguously later
      // timestamp instead of relying on wall-clock luck.
      const savedSecond = await result.db
        .select()
        .from(savedShops)
        .where(eq(savedShops.providerProfileId, provider2Id))
        .get();
      assert.ok(savedSecond);
      await result.db
        .update(savedShops)
        .set({ createdAt: savedSecond.createdAt + 10 })
        .where(eq(savedShops.id, savedSecond.id));

      const listRes = await app.request("/me/saved-shops", {
        method: "GET",
        headers: { Authorization: `Bearer ${clientToken}` },
      });
      const listData = await listRes.json();
      assert.equal(listData.shops.length, 2);
      assert.equal(listData.shops[0].provider.displayName, "Shop Two");
      assert.equal(listData.shops[1].provider.displayName, "Shop One");
    } finally {
      closeDatabase(result);
    }
  });

  test("Unauthenticated user cannot save shop", async () => {
    const result = openTestDatabase();
    try {
      const app = createApp(result.db);
      const providerId = await seedShop(result, PROVIDER_WALLET, "Test Shop");

      const res = await app.request(`/providers/${providerId}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, "unauthorized");
    } finally {
      closeDatabase(result);
    }
  });

  test("Unauthenticated user cannot list saved shops", async () => {
    const result = openTestDatabase();
    try {
      const app = createApp(result.db);
      const res = await app.request("/me/saved-shops", { method: "GET" });
      assert.equal(res.status, 401);
      assert.equal((await res.json()).code, "unauthorized");
    } finally {
      closeDatabase(result);
    }
  });
});
