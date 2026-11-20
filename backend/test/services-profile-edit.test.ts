/**
 * Approved-provider profile edits: the shop's copy is editable, its
 * commercial terms are not. The validation case from the story is explicit
 * here -- update the description and assert the price is unchanged.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { getProviderProfileByWallet } from "../src/db/providerProfiles.js";
import { getPublicProviderProfile, getOwnProviderProfile } from "../src/services/profile.js";
import {
  InvalidProviderProfileError,
  NotAProviderError,
  ProviderNotApprovedError,
  updateProviderProfile,
} from "../src/services/profile.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const EDIT = {
  title: "Clinical psychologist (evenings)",
  bio: "Updated description: I work with adults on sleep and anxiety.",
  languages: ["English", "Turkish"],
  sessionLengthMinutes: 45,
  location: "Kadıköy, Istanbul",
};

async function headers(wallet: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await issuePactlyJwt(wallet)}`, "content-type": "application/json" };
}

test("an approved provider edits description/title/languages/session length; the price is unchanged", async () => {
  const result = openTestDatabase();
  try {
    const wallet = "GAPPROVEDEDITWALLET";
    const profileId = await seedProviderProfile(result, {
      isApproved: true,
      walletAddress: wallet,
      priceAmount: "12345678",
      depositRateBps: 2000,
      displayName: "Shop One",
      bio: "Old description",
    });
    const before = await getProviderProfileByWallet(result.db, wallet);

    const view = await updateProviderProfile(result.db, wallet, EDIT);
    assert.equal(view.bio, EDIT.bio);
    assert.equal(view.title, EDIT.title);
    assert.deepEqual(view.languages, EDIT.languages);
    assert.equal(view.sessionLengthMinutes, EDIT.sessionLengthMinutes);
    assert.equal(view.location, EDIT.location);
    assert.equal(view.price.amount, "12345678", "price is frozen on this route");
    assert.equal(view.deposit.amount, "2469135", "deposit is recomputed from the frozen price and rate");

    const after = await getProviderProfileByWallet(result.db, wallet);
    assert.equal(after?.priceAmount, before?.priceAmount);
    assert.equal(after?.depositRateBps, before?.depositRateBps);
    assert.equal(after?.categoryId, before?.categoryId);
    assert.equal(after?.isApproved, true);

    // The public profile shows the new text on the next read.
    const publicProfile = await getPublicProviderProfile(result.db, profileId);
    assert.equal(publicProfile.bio, EDIT.bio);
    assert.deepEqual(publicProfile.languages, EDIT.languages);
  } finally {
    closeDatabase(result);
  }
});

test("an empty title is rejected and nothing is written", async () => {
  const result = openTestDatabase();
  try {
    const wallet = "GEMPTYTITLEWALLET";
    await seedProviderProfile(result, { isApproved: true, walletAddress: wallet, bio: "Keep this" });
    await assert.rejects(
      updateProviderProfile(result.db, wallet, { ...EDIT, title: "  " }),
      (error: unknown) => error instanceof InvalidProviderProfileError && Boolean(error.details.title),
    );
    const profile = await getProviderProfileByWallet(result.db, wallet);
    assert.equal(profile?.bio, "Keep this");
  } finally {
    closeDatabase(result);
  }
});

test("pending and rejected shops cannot use the edit route; another wallet is a 404", async () => {
  const result = openTestDatabase();
  try {
    const pending = "GPENDINGEDITWALLET";
    await seedProviderProfile(result, { isApproved: false, walletAddress: pending });
    await assert.rejects(updateProviderProfile(result.db, pending, EDIT), ProviderNotApprovedError);
    await assert.rejects(updateProviderProfile(result.db, "GNOEDITPROFILE", EDIT), NotAProviderError);

    const app = createApp(result.db);
    const pendingResponse = await app.request("/me/provider/profile", {
      method: "PUT",
      headers: await headers(pending),
      body: JSON.stringify(EDIT),
    });
    assert.equal(pendingResponse.status, 403);
    assert.equal(((await pendingResponse.json()) as { code: string }).code, "NOT_APPROVED");

    const strangerResponse = await app.request("/me/provider/profile", {
      method: "PUT",
      headers: await headers("GNOEDITPROFILE"),
      body: JSON.stringify(EDIT),
    });
    assert.equal(strangerResponse.status, 404);
  } finally {
    closeDatabase(result);
  }
});

test("PUT /me/provider/profile returns the updated view with the original price", async () => {
  const result = openTestDatabase();
  try {
    const wallet = "GROUTEEDITWALLET";
    const profileId = await seedProviderProfile(result, {
      isApproved: true,
      walletAddress: wallet,
      priceAmount: "9000000",
      depositRateBps: 2500,
    });
    const app = createApp(result.db);
    const response = await app.request("/me/provider/profile", {
      method: "PUT",
      headers: await headers(wallet),
      body: JSON.stringify({ ...EDIT, priceAmount: "1", depositRateBps: 1, categoryId: "cat-other" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { bio: string; price: { amount: string }; depositRateBps: number };
    assert.equal(body.bio, EDIT.bio);
    assert.equal(body.price.amount, "9000000");
    assert.equal(body.depositRateBps, 2500);

    const own = await getOwnProviderProfile(result.db, wallet);
    assert.equal(own.bio, EDIT.bio);
    assert.equal((await getPublicProviderProfile(result.db, profileId)).bio, EDIT.bio);
  } finally {
    closeDatabase(result);
  }
});
