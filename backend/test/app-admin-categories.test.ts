/**
 * Story 5.8: admin category management. Tests the two admin routes:
 * creating a category and toggling its visibility.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

import { createApp } from "../src/app.js";
import { closeDatabase, openTestDatabase, seedCategory } from "./helpers.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { getCategoryById } from "../src/db/categories.js";

// Test admin wallet from testConfigEnv.ts
const TEST_ADMIN_WALLET = "GADMIN1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";

test("POST /admin/categories creates a new category with name and slug", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const token = await issuePactlyJwt(TEST_ADMIN_WALLET);

    const response = await app.request("/admin/categories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "Test Category", slug: "test-category" }),
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { category: { id: string; name: string; slug: string; visible: boolean } };
    assert.equal(body.category.name, "Test Category");
    assert.equal(body.category.slug, "test-category");
    assert.equal(body.category.visible, true);
  } finally {
    closeDatabase(result);
  }
});

test("POST /admin/categories rejects duplicate slug with 409", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const token = await issuePactlyJwt(TEST_ADMIN_WALLET);

    // First category
    await app.request("/admin/categories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "Test Category", slug: "test-category" }),
    });

    // Attempt duplicate
    const response = await app.request("/admin/categories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "Another Category", slug: "test-category" }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "DUPLICATE_SLUG");
  } finally {
    closeDatabase(result);
  }
});

test("POST /admin/categories requires admin wallet", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const nonAdminWallet = Keypair.random();
    const token = await issuePactlyJwt(nonAdminWallet.publicKey());

    const response = await app.request("/admin/categories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "Test Category", slug: "test-category" }),
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "NOT_ADMIN");
  } finally {
    closeDatabase(result);
  }
});

test("PATCH /admin/categories/:id/visibility hides a category", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const token = await issuePactlyJwt(TEST_ADMIN_WALLET);

    // Create a category
    const createResponse = await app.request("/admin/categories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "Test Category", slug: "test-category" }),
    });
    const created = (await createResponse.json()) as { category: { id: string } };

    // Hide it
    const hideResponse = await app.request(`/admin/categories/${created.category.id}/visibility`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ visible: false }),
    });
    assert.equal(hideResponse.status, 200);
    const hidden = (await hideResponse.json()) as { category: { visible: boolean } };
    assert.equal(hidden.category.visible, false);

    // Verify it's hidden in the database
    const category = await getCategoryById(result.db, created.category.id);
    assert.equal(category?.visible, false);
  } finally {
    closeDatabase(result);
  }
});

test("PATCH /admin/categories/:id/visibility shows a hidden category", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const token = await issuePactlyJwt(TEST_ADMIN_WALLET);

    // Create and hide a category
    const createResponse = await app.request("/admin/categories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "Test Category", slug: "test-category" }),
    });
    const created = (await createResponse.json()) as { category: { id: string } };
    await app.request(`/admin/categories/${created.category.id}/visibility`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ visible: false }),
    });

    // Show it again
    const showResponse = await app.request(`/admin/categories/${created.category.id}/visibility`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ visible: true }),
    });
    assert.equal(showResponse.status, 200);
    const shown = (await showResponse.json()) as { category: { visible: boolean } };
    assert.equal(shown.category.visible, true);
  } finally {
    closeDatabase(result);
  }
});

test("GET /categories excludes hidden categories", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const token = await issuePactlyJwt(TEST_ADMIN_WALLET);

    // Create a category and hide it
    const createResponse = await app.request("/admin/categories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: "Test Category", slug: "test-category" }),
    });
    const created = (await createResponse.json()) as { category: { id: string; slug: string } };
    await app.request(`/admin/categories/${created.category.id}/visibility`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ visible: false }),
    });

    // Get categories
    const categoriesResponse = await app.request("/categories");
    const categories = (await categoriesResponse.json()) as { categories: { slug: string }[] };
    const slugs = categories.categories.map((c) => c.slug);
    assert.ok(!slugs.includes(created.category.slug), "Hidden category should not appear in /categories");
  } finally {
    closeDatabase(result);
  }
});

test("POST /me/provider/application rejects hidden category", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const adminToken = await issuePactlyJwt(TEST_ADMIN_WALLET);

    // Create and hide a category
    const createResponse = await app.request("/admin/categories", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ name: "Test Category", slug: "test-category" }),
    });
    const created = (await createResponse.json()) as { category: { id: string } };
    const hideResponse = await app.request(`/admin/categories/${created.category.id}/visibility`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ visible: false }),
    });
    assert.equal(hideResponse.status, 200, "Hide request should succeed");
    
    // Verify the category is actually hidden in the database
    const hiddenCategory = await getCategoryById(result.db, created.category.id);
    assert.equal(hiddenCategory?.visible, false, "Category should be hidden in database");

    // Try to apply with hidden category
    const applicant = Keypair.random();
    const applicantToken = await issuePactlyJwt(applicant.publicKey());
    const applyResponse = await app.request("/me/provider/application", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${applicantToken}`,
      },
      body: JSON.stringify({
        name: "Test Provider",
        title: "Test Title",
        categoryId: created.category.id,
        location: "Test Location",
        serviceDescription: "Test Description",
        sessionFormat: "video",
        sessionLengthMinutes: 60,
        priceAmount: "5000000",
        depositRateBps: 2000,
        cancellationWindowHours: 24,
      }),
    });
    const body = (await applyResponse.json()) as { code?: string; details?: { categoryId?: string } };
    // Log the actual response for debugging
    if (applyResponse.status !== 400 || body.details?.categoryId !== "This category is not available.") {
      console.log("Apply response:", { status: applyResponse.status, body: JSON.stringify(body) });
    }
    assert.equal(applyResponse.status, 400, `Expected 400 but got ${applyResponse.status}`);
    assert.ok(body.details, `Expected details object but got: ${JSON.stringify(body)}`);
    assert.equal(body.details?.categoryId, "This category is not available.");
  } finally {
    closeDatabase(result);
  }
});
