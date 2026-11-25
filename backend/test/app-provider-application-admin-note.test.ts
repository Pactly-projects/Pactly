/**
 * Admin-only note on a provider application. An admin can save a note on a
 * pending application and every other admin can read it; the applicant's
 * own view and the public profile never carry it; a non-admin gets the
 * existing `404 NOT_ADMIN` with no note in the body. Capped at 1000
 * characters; an empty note clears it.
 */
import "./testConfigEnvAdmin.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { DISPUTE_RESOLVER_ADMIN_WALLET, NON_RESOLVER_ADMIN_WALLET } from "./testConfigEnvAdmin.js";
import { closeDatabase, openTestDatabase, seedCategory, USDC_READY_WALLET_DEPS } from "./helpers.js";

const APPLICANT = "GAPPLICANTWALLETFORADMINNOTETESTS";
const NOTE = "Called the shop: chair count does not match the photos. Check before approving.";

function validApplication(categoryId: string) {
  return {
    name: "Atelier Note",
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

async function bearer(walletAddress: string): Promise<{ authorization: string; "content-type": string }> {
  return { authorization: `Bearer ${await issuePactlyJwt(walletAddress)}`, "content-type": "application/json" };
}

async function applyAndGetId(app: ReturnType<typeof createApp>, categoryId: string): Promise<{ id: string; profileId: string }> {
  const created = await app.request("/me/provider/application", {
    method: "POST",
    headers: await bearer(APPLICANT),
    body: JSON.stringify(validApplication(categoryId)),
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { application: { id: string; profileId: string } };
  return body.application;
}

test("an admin's note is readable by other admins and absent from the applicant's payload and the public profile", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-admin-note");
    const app = createApp(result.db, { usdcTrustlineDeps: USDC_READY_WALLET_DEPS });
    const { id, profileId } = await applyAndGetId(app, categoryId);

    const saved = await app.request(`/admin/applications/${id}/note`, {
      method: "PUT",
      headers: await bearer(NON_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ note: `  ${NOTE}  ` }),
    });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as { application: { adminNote: string } }).application.adminNote, NOTE);

    // A different admin reads it from the queue.
    const queue = await app.request("/admin/applications", { headers: await bearer(DISPUTE_RESOLVER_ADMIN_WALLET) });
    assert.equal(queue.status, 200);
    const queued = ((await queue.json()) as { applications: Array<{ id: string; adminNote: string | null }> }).applications;
    assert.equal(queued.find((application) => application.id === id)?.adminNote, NOTE);

    // The applicant's own payload omits it -- not null, absent.
    const own = await app.request("/me/provider/application", { headers: await bearer(APPLICANT) });
    assert.equal(own.status, 200);
    const ownText = await own.text();
    const ownBody = JSON.parse(ownText) as { application: Record<string, unknown> };
    assert.equal("adminNote" in ownBody.application, false);
    assert.equal(ownText.includes(NOTE), false);

    // Approve, then the public profile must not carry it either.
    const approved = await app.request(`/admin/applications/${id}/decide`, {
      method: "POST",
      headers: await bearer(NON_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "approve" }),
    });
    assert.equal(approved.status, 200);
    const publicProfile = await app.request(`/providers/${profileId}`);
    assert.equal(publicProfile.status, 200);
    const publicText = await publicProfile.text();
    assert.equal(publicText.includes(NOTE), false);
    assert.equal("adminNote" in (JSON.parse(publicText) as Record<string, unknown>), false);

    const ownAfter = await app.request("/me/provider/application", { headers: await bearer(APPLICANT) });
    assert.equal((await ownAfter.text()).includes(NOTE), false);
  } finally {
    closeDatabase(result);
  }
});

test("a non-admin gets the existing NOT_ADMIN response with no note in the body, and cannot write one", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-admin-note-nonadmin");
    const app = createApp(result.db);
    const { id } = await applyAndGetId(app, categoryId);

    await app.request(`/admin/applications/${id}/note`, {
      method: "PUT",
      headers: await bearer(NON_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ note: NOTE }),
    });

    for (const wallet of [APPLICANT, "GSOMEOTHERWALLETNOTANADMIN"]) {
      const read = await app.request("/admin/applications", { headers: await bearer(wallet) });
      assert.equal(read.status, 404);
      const readText = await read.text();
      assert.deepEqual(JSON.parse(readText), { code: "NOT_ADMIN", message: "This wallet is not a Pactly admin." });
      assert.equal(readText.includes(NOTE), false);

      const write = await app.request(`/admin/applications/${id}/note`, {
        method: "PUT",
        headers: await bearer(wallet),
        body: JSON.stringify({ note: "overwritten" }),
      });
      assert.equal(write.status, 404);
      assert.equal(((await write.json()) as { code: string }).code, "NOT_ADMIN");
    }

    const queue = await app.request("/admin/applications", { headers: await bearer(NON_RESOLVER_ADMIN_WALLET) });
    const queued = ((await queue.json()) as { applications: Array<{ id: string; adminNote: string | null }> }).applications;
    assert.equal(queued.find((application) => application.id === id)?.adminNote, NOTE);

    const unauthenticated = await app.request(`/admin/applications/${id}/note`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "x" }),
    });
    assert.equal(unauthenticated.status, 401);
  } finally {
    closeDatabase(result);
  }
});

test("the note is capped at 1000 characters and an empty note clears it", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-admin-note-cap");
    const app = createApp(result.db);
    const { id } = await applyAndGetId(app, categoryId);
    const headers = await bearer(NON_RESOLVER_ADMIN_WALLET);
    const put = (note: unknown) => app.request(`/admin/applications/${id}/note`, { method: "PUT", headers, body: JSON.stringify({ note }) });

    const atCap = await put("a".repeat(1000));
    assert.equal(atCap.status, 200);

    const overCap = await put("b".repeat(1001));
    assert.equal(overCap.status, 400);
    assert.equal(((await overCap.json()) as { code: string }).code, "INVALID_NOTE");
    const afterOver = await app.request("/admin/applications", { headers });
    const kept = ((await afterOver.json()) as { applications: Array<{ id: string; adminNote: string | null }> }).applications;
    assert.equal(kept.find((application) => application.id === id)?.adminNote, "a".repeat(1000));

    for (const clearing of ["", "   ", null]) {
      await put("something");
      const cleared = await put(clearing);
      assert.equal(cleared.status, 200);
      assert.equal(((await cleared.json()) as { application: { adminNote: string | null } }).application.adminNote, null);
    }
  } finally {
    closeDatabase(result);
  }
});

test("a note cannot be written on a decided or unknown application", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-admin-note-decided");
    const app = createApp(result.db);
    const { id } = await applyAndGetId(app, categoryId);
    const headers = await bearer(NON_RESOLVER_ADMIN_WALLET);

    const rejected = await app.request(`/admin/applications/${id}/decide`, {
      method: "POST",
      headers,
      body: JSON.stringify({ outcome: "reject", reason: "Photos missing." }),
    });
    assert.equal(rejected.status, 200);

    const onDecided = await app.request(`/admin/applications/${id}/note`, { method: "PUT", headers, body: JSON.stringify({ note: "late" }) });
    assert.equal(onDecided.status, 409);
    assert.equal(((await onDecided.json()) as { code: string }).code, "APPLICATION_DECIDED");

    const unknown = await app.request("/admin/applications/does-not-exist/note", { method: "PUT", headers, body: JSON.stringify({ note: "x" }) });
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { code: string }).code, "APPLICATION_NOT_FOUND");

    const noField = await app.request(`/admin/applications/${id}/note`, { method: "PUT", headers, body: JSON.stringify({}) });
    assert.equal(noField.status, 400);
  } finally {
    closeDatabase(result);
  }
});
