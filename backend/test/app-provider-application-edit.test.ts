/**
 * Editing a pending provider application in place: the applicant can correct
 * the fields the form collected, the admin queue reads the corrected values,
 * and a decided (approved or rejected) application refuses the edit. Driven
 * through `app.request(...)` like `app-provider-applications.test.ts`.
 */
import "./testConfigEnvAdmin.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { NON_RESOLVER_ADMIN_WALLET } from "./testConfigEnvAdmin.js";
import { closeDatabase, openTestDatabase, seedCategory, USDC_READY_WALLET_DEPS } from "./helpers.js";

const APPLICANT = "GAPPLICANTWALLETFORSUSPENSIONTST1";
const OTHER_WALLET = "GOTHERWALLETFORAPPLICATIONEDITS01";

function validApplication(categoryId: string) {
  return {
    name: "Atelier Test",
    title: "Barber · cut and beard",
    categoryId,
    location: "Kadıköy, Istanbul",
    serviceDescription: "Cut and beard in a two-chair shop, forty minutes, walk-ins welcome.",
    sessionFormat: "in_person",
    sessionLengthMinutes: 40,
    priceAmount: "20000000",
    depositRateBps: 2500,
    cancellationWindowHours: 6,
  };
}

function correctedApplication(categoryId: string) {
  return {
    name: "Atelier Test & Co",
    title: "Master barber · cut, beard and hot towel",
    categoryId,
    location: "Moda, Kadıköy, Istanbul",
    serviceDescription: "A sixty-minute cut, beard and hot-towel shave in a two-chair Moda shop.",
    sessionFormat: "in_person",
    sessionLengthMinutes: 60,
    priceAmount: "30000000",
    depositRateBps: 3000,
    cancellationWindowHours: 12,
  };
}

async function bearer(walletAddress: string): Promise<{ authorization: string; "content-type": string }> {
  return { authorization: `Bearer ${await issuePactlyJwt(walletAddress)}`, "content-type": "application/json" };
}

test("a pending application can be edited; the admin queue and panel see the new fields, and it stays unapproved", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-edit", "Barbershop");
    const app = createApp(result.db, { usdcTrustlineDeps: USDC_READY_WALLET_DEPS });
    const applicant = await bearer(APPLICANT);
    const admin = await bearer(NON_RESOLVER_ADMIN_WALLET);

    const created = await app.request("/me/provider/application", {
      method: "POST",
      headers: applicant,
      body: JSON.stringify(validApplication(categoryId)),
    });
    assert.equal(created.status, 201);
    const application = (await created.json()) as { application: { id: string; profileId: string } };

    const edited = await app.request("/me/provider/application", {
      method: "PUT",
      headers: applicant,
      body: JSON.stringify(correctedApplication(categoryId)),
    });
    assert.equal(edited.status, 200);
    const editedBody = (await edited.json()) as {
      application: {
        id: string;
        state: string;
        name: string;
        serviceDescription: string;
        sessionLengthMinutes: number;
        price: { amount: string };
        deposit: { amount: string };
        depositRateBps: number;
        cancellationWindowHours: number;
      };
    };
    assert.equal(editedBody.application.id, application.application.id, "the same application is edited, not replaced");
    assert.equal(editedBody.application.state, "pending");
    assert.equal(editedBody.application.name, "Atelier Test & Co");
    assert.equal(editedBody.application.serviceDescription, "A sixty-minute cut, beard and hot-towel shave in a two-chair Moda shop.");
    assert.equal(editedBody.application.sessionLengthMinutes, 60);
    assert.equal(editedBody.application.price.amount, "30000000");
    assert.equal(editedBody.application.deposit.amount, "9000000", "the deposit is recomputed from the new price and rate");
    assert.equal(editedBody.application.depositRateBps, 3000);
    assert.equal(editedBody.application.cancellationWindowHours, 12);

    const queue = await app.request("/admin/applications", { headers: admin });
    assert.equal(queue.status, 200);
    const queued = (await queue.json()) as {
      applications: Array<{ id: string; name: string; serviceDescription: string; price: { amount: string }; sessionLengthMinutes: number }>;
    };
    assert.equal(queued.applications.length, 1);
    assert.equal(queued.applications[0]?.id, application.application.id);
    assert.equal(queued.applications[0]?.name, "Atelier Test & Co");
    assert.equal(queued.applications[0]?.serviceDescription, "A sixty-minute cut, beard and hot-towel shave in a two-chair Moda shop.");
    assert.equal(queued.applications[0]?.price.amount, "30000000");
    assert.equal(queued.applications[0]?.sessionLengthMinutes, 60);

    // The unapproved profile (what goes live on approval) carries the edit,
    // including the location the application row itself does not store.
    const ownProfile = await app.request("/me/provider", { headers: applicant });
    const profile = (await ownProfile.json()) as {
      displayName: string;
      title: string;
      location: string;
      price: { amount: string };
      isApproved: boolean;
    };
    assert.equal(profile.displayName, "Atelier Test & Co");
    assert.equal(profile.title, "Master barber · cut, beard and hot towel");
    assert.equal(profile.location, "Moda, Kadıköy, Istanbul");
    assert.equal(profile.price.amount, "30000000");
    assert.equal(profile.isApproved, false, "editing must never approve the shop");

    const listed = await app.request("/providers");
    assert.deepEqual(((await listed.json()) as { providers: unknown[] }).providers, []);

    // Once approved, the same edit is refused and the decided row is untouched.
    const approved = await app.request(`/admin/applications/${application.application.id}/decide`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ outcome: "approve" }),
    });
    assert.equal(approved.status, 200);

    const afterApproval = await app.request("/me/provider/application", {
      method: "PUT",
      headers: applicant,
      body: JSON.stringify(validApplication(categoryId)),
    });
    assert.equal(afterApproval.status, 409);
    assert.equal(((await afterApproval.json()) as { code: string }).code, "APPLICATION_DECIDED");

    const own = await app.request("/me/provider/application", { headers: applicant });
    const ownBody = (await own.json()) as { application: { state: string; name: string } };
    assert.equal(ownBody.application.state, "approved");
    assert.equal(ownBody.application.name, "Atelier Test & Co", "the refused edit changed nothing");
  } finally {
    closeDatabase(result);
  }
});

test("an invalid edit changes nothing", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-edit-invalid", "Barbershop");
    const app = createApp(result.db);
    const applicant = await bearer(APPLICANT);

    const created = await app.request("/me/provider/application", {
      method: "POST",
      headers: applicant,
      body: JSON.stringify(validApplication(categoryId)),
    });
    assert.equal(created.status, 201);

    const invalid = await app.request("/me/provider/application", {
      method: "PUT",
      headers: applicant,
      body: JSON.stringify({ ...validApplication(categoryId), name: "A", priceAmount: "not-a-price", depositRateBps: 0 }),
    });
    assert.equal(invalid.status, 400);
    const invalidBody = (await invalid.json()) as { code: string; details: Record<string, string> };
    assert.equal(invalidBody.code, "INVALID_APPLICATION");
    assert.ok(invalidBody.details.name);
    assert.ok(invalidBody.details.priceAmount);
    assert.ok(invalidBody.details.depositRateBps);

    const own = await app.request("/me/provider/application", { headers: applicant });
    const ownBody = (await own.json()) as {
      application: { name: string; serviceDescription: string; price: { amount: string }; state: string };
    };
    assert.equal(ownBody.application.state, "pending");
    assert.equal(ownBody.application.name, "Atelier Test");
    assert.equal(ownBody.application.serviceDescription, "Cut and beard in a two-chair shop, forty minutes, walk-ins welcome.");
    assert.equal(ownBody.application.price.amount, "20000000");

    const profile = (await (await app.request("/me/provider", { headers: applicant })).json()) as {
      displayName: string;
      price: { amount: string };
    };
    assert.equal(profile.displayName, "Atelier Test");
    assert.equal(profile.price.amount, "20000000");
  } finally {
    closeDatabase(result);
  }
});

test("another wallet cannot edit the application", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-edit-wallet", "Barbershop");
    const app = createApp(result.db);
    const applicant = await bearer(APPLICANT);
    const other = await bearer(OTHER_WALLET);

    const created = await app.request("/me/provider/application", {
      method: "POST",
      headers: applicant,
      body: JSON.stringify(validApplication(categoryId)),
    });
    assert.equal(created.status, 201);

    const asOther = await app.request("/me/provider/application", {
      method: "PUT",
      headers: other,
      body: JSON.stringify(correctedApplication(categoryId)),
    });
    assert.equal(asOther.status, 404);
    assert.equal(((await asOther.json()) as { code: string }).code, "NO_APPLICATION");

    const own = await app.request("/me/provider/application", { headers: applicant });
    const ownBody = (await own.json()) as { application: { name: string; price: { amount: string } } };
    assert.equal(ownBody.application.name, "Atelier Test");
    assert.equal(ownBody.application.price.amount, "20000000");
  } finally {
    closeDatabase(result);
  }
});

test("a rejected application rejects the edit too", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-edit-rejected", "Barbershop");
    const app = createApp(result.db);
    const applicant = await bearer(APPLICANT);
    const admin = await bearer(NON_RESOLVER_ADMIN_WALLET);

    const created = await app.request("/me/provider/application", {
      method: "POST",
      headers: applicant,
      body: JSON.stringify(validApplication(categoryId)),
    });
    assert.equal(created.status, 201);
    const application = (await created.json()) as { application: { id: string } };

    const rejected = await app.request(`/admin/applications/${application.application.id}/decide`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ outcome: "reject", reason: "Add a real shop address and try again." }),
    });
    assert.equal(rejected.status, 200);

    const edit = await app.request("/me/provider/application", {
      method: "PUT",
      headers: applicant,
      body: JSON.stringify(correctedApplication(categoryId)),
    });
    assert.equal(edit.status, 409);
    assert.equal(((await edit.json()) as { code: string }).code, "APPLICATION_DECIDED");

    const own = await app.request("/me/provider/application", { headers: applicant });
    const ownBody = (await own.json()) as { application: { state: string; name: string } };
    assert.equal(ownBody.application.state, "rejected");
    assert.equal(ownBody.application.name, "Atelier Test");
  } finally {
    closeDatabase(result);
  }
});
