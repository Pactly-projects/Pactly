/**
 * Issue #13: money actions ask for the passkey again, even while the
 * session is valid. These tests drive the two halves at the HTTP boundary:
 * the `x-pactly-assertion` gate on `POST /bookings/:id/release` (fresh
 * accepted, stale / future-skewed / another wallet's / missing refused), and
 * the real WebAuthn options -> assert -> verify ceremony that mints the
 * token. One assertion per wallet, five minutes, no exceptions.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import { createApp } from "../src/app.js";
import {
  MONEY_ASSERTION_TTL_SECONDS,
  issueMoneyAssertionToken,
} from "../src/auth/assertion.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import {
  getBookingById,
  updateEscrowContractId,
  updateEscrowStateSync,
} from "../src/db/bookings.js";
import { insertEscrowProcessedEventIfNew } from "../src/db/escrowProcessedEvents.js";
import { insertUser, upsertPasskeyCredential } from "../src/db/users.js";
import type { EscrowAdapter } from "../src/escrow/interface.js";
import { FakeAuthenticator } from "./fakeAuthenticator.js";
import { closeDatabase, openTestDatabase, seedBooking, seedProviderProfile } from "./helpers.js";

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

function fakeEscrowAdapter(overrides: Partial<EscrowAdapter> = {}): EscrowAdapter {
  const unimplemented = (name: string) => () => {
    throw new Error(`${name} should not have been called in this test`);
  };
  return {
    deploy: overrides.deploy ?? unimplemented("deploy"),
    fund: overrides.fund ?? unimplemented("fund"),
    complete: overrides.complete ?? unimplemented("complete"),
    approve: overrides.approve ?? unimplemented("approve"),
    release: overrides.release ?? unimplemented("release"),
    startDispute: overrides.startDispute ?? unimplemented("startDispute"),
    resolveDispute: overrides.resolveDispute ?? unimplemented("resolveDispute"),
    submit: overrides.submit ?? unimplemented("submit"),
  };
}

/** An `approved` booking (the state `release` builds from). */
async function seedApprovedBooking(result: Awaited<ReturnType<typeof openTestDatabase>>) {
  const clientWalletAddress = Keypair.random().publicKey();
  const providerWalletAddress = Keypair.random().publicKey();
  const providerProfileId = await seedProviderProfile(result, { walletAddress: providerWalletAddress });
  const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress });
  const contractId = fakeContractId();
  await updateEscrowContractId(result.db, bookingId, contractId);
  updateEscrowStateSync(result.db, bookingId, "locked");
  await insertEscrowProcessedEventIfNew(result.db, {
    bookingId,
    contractId,
    lifecycleAction: "approved",
    amount: "1000000",
    ledgerSeq: "1",
    isAnomaly: false,
    processedAt: Date.now(),
  });
  return { bookingId, clientWalletAddress, providerWalletAddress };
}

async function release(
  app: ReturnType<typeof createApp>,
  bookingId: string,
  walletAddress: string,
  assertionToken?: string,
) {
  const token = await issuePactlyJwt(walletAddress);
  return app.request(`/bookings/${bookingId}/release`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(assertionToken ? { "x-pactly-assertion": assertionToken } : {}),
    },
  });
}

test("release refuses a missing, stale, future-skewed, or other-wallet assertion and accepts a fresh one", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedApprovedBooking(result);
    const app = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({ release: async () => ({ unsignedXdr: "x", txHash: "release-tx-hash" }) }),
    });

    const missing = await release(app, seed.bookingId, seed.providerWalletAddress);
    assert.equal(missing.status, 403);
    assert.equal(((await missing.json()) as { code: string }).code, "ASSERTION_REQUIRED");

    const staleToken = await issueMoneyAssertionToken(seed.providerWalletAddress, {
      now: new Date(Date.now() - (MONEY_ASSERTION_TTL_SECONDS + 60) * 1000),
    });
    const stale = await release(app, seed.bookingId, seed.providerWalletAddress, staleToken);
    assert.equal(stale.status, 403);
    assert.equal(((await stale.json()) as { code: string }).code, "ASSERTION_STALE");

    // A clock more than five minutes ahead is a rejection too, not a
    // longer-lived confirmation.
    const futureToken = await issueMoneyAssertionToken(seed.providerWalletAddress, {
      now: new Date(Date.now() + (MONEY_ASSERTION_TTL_SECONDS + 60) * 1000),
    });
    const future = await release(app, seed.bookingId, seed.providerWalletAddress, futureToken);
    assert.equal(future.status, 403);
    assert.equal(((await future.json()) as { code: string }).code, "ASSERTION_STALE");

    // The assertion is for the wallet that owns the action, never just any
    // wallet with a session.
    const otherWalletToken = await issueMoneyAssertionToken(seed.clientWalletAddress);
    const wrongWallet = await release(app, seed.bookingId, seed.providerWalletAddress, otherWalletToken);
    assert.equal(wrongWallet.status, 403);
    assert.equal(((await wrongWallet.json()) as { code: string }).code, "ASSERTION_STALE");

    const freshToken = await issueMoneyAssertionToken(seed.providerWalletAddress);
    const accepted = await release(app, seed.bookingId, seed.providerWalletAddress, freshToken);
    assert.equal(accepted.status, 200);
    assert.equal(((await accepted.json()) as { txHash: string }).txHash, "release-tx-hash");

    const booking = await getBookingById(result.db, seed.bookingId);
    assert.equal(booking?.escrowReleaseTxHash, "release-tx-hash");
  } finally {
    closeDatabase(result);
  }
});

test("a real WebAuthn assertion minted through /auth/assertion/options + /verify releases the deposit; a replayed ceremony does not", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedApprovedBooking(result);
    const authenticator = new FakeAuthenticator();
    const userId = randomUUID();
    await insertUser(result.db, {
      id: userId,
      displayName: "",
      walletAddress: seed.providerWalletAddress,
      encryptedSecret: "test-secret",
      createdAt: Date.now(),
    });
    await upsertPasskeyCredential(result.db, {
      id: authenticator.credentialIdBase64Url,
      userId,
      publicKey: authenticator.cosePublicKeyBase64Url,
      counter: 0,
      transports: ["internal"],
      createdAt: Date.now(),
    });

    const app = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({ release: async () => ({ unsignedXdr: "x", txHash: "release-tx-hash" }) }),
    });
    const sessionToken = await issuePactlyJwt(seed.providerWalletAddress);
    const authHeaders = { authorization: `Bearer ${sessionToken}`, "content-type": "application/json" };

    const optionsResponse = await app.request("/auth/assertion/options", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(optionsResponse.status, 200);
    const options = (await optionsResponse.json()) as {
      assertionId: string;
      options: { challenge: string; allowCredentials?: Array<{ id: string }> };
    };
    assert.deepEqual(
      options.options.allowCredentials?.map((entry) => entry.id),
      [authenticator.credentialIdBase64Url],
    );

    const assertion = authenticator.createAuthenticationResponse(options.options.challenge);
    const verifyResponse = await app.request("/auth/assertion/verify", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ assertionId: options.assertionId, response: assertion }),
    });
    assert.equal(verifyResponse.status, 200);
    const { assertionToken } = (await verifyResponse.json()) as { assertionToken: string };
    assert.ok(assertionToken);

    const accepted = await release(app, seed.bookingId, seed.providerWalletAddress, assertionToken);
    assert.equal(accepted.status, 200);

    // The ceremony's challenge is consume-once -- the same signed response
    // cannot mint a second token.
    const replayed = await app.request("/auth/assertion/verify", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ assertionId: options.assertionId, response: assertion }),
    });
    assert.equal(replayed.status, 400);
    assert.equal(((await replayed.json()) as { code: string }).code, "PASSKEY_INVALID");
  } finally {
    closeDatabase(result);
  }
});

test("/auth/assertion/options is 404 PASSKEY_NOT_REGISTERED for a wallet with no passkey on file", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const walletAddress = Keypair.random().publicKey();
    const token = await issuePactlyJwt(walletAddress);
    const response = await app.request("/auth/assertion/options", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, "PASSKEY_NOT_REGISTERED");
  } finally {
    closeDatabase(result);
  }
});
