/**
 * Story 3.6's own routes (`POST /bookings/:id/{complete,approve,release,
 * dispute}`, `POST /admin/bookings/:id/resolve`, `GET /admin/disputes`),
 * driven through Hono's own `app.request(...)` like `app-bookings.test.ts`.
 * Covers the I/O matrix's status codes and envelope shapes at the HTTP
 * boundary -- the service-level behavior (role/state guards, the
 * suggested-outcome policy, the hash-matching submit rule) is
 * `services-booking-actions.test.ts`'s job.
 */
import "./testConfigEnvAdmin.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Account, Keypair, Networks, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";

import { createApp } from "../src/app.js";
import { issueMoneyAssertionToken } from "../src/auth/assertion.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { getBookingById, setPendingDispute, updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { insertEscrowProcessedEventIfNew } from "../src/db/escrowProcessedEvents.js";
import type { EscrowAdapter } from "../src/escrow/interface.js";
import { closeDatabase, openTestDatabase, seedBooking, seedProviderProfile } from "./helpers.js";
import { DISPUTE_RESOLVER_ADMIN_WALLET, NON_RESOLVER_ADMIN_WALLET } from "./testConfigEnvAdmin.js";

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

/** A real, decodable (never actually submitted) transaction envelope and
 * its own hash -- mirrors `services-booking-actions.test.ts`'s own helper;
 * needed here whenever a test must round-trip a dispute/resolve XDR through
 * the real `POST /bookings/:id/submit` route, since that route decodes a
 * genuine XDR to compute its own matching hash. */
function buildFakeTransactionXdr(): { xdr: string; hash: string } {
  const account = new Account(Keypair.random().publicKey(), "0");
  const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.bumpSequence({ bumpTo: "1" }))
    .setTimeout(30)
    .build();
  return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString("hex") };
}

/** Session token plus a fresh passkey assertion for the money-action build
 * routes (issue #13). The gate itself -- missing/stale/other-wallet -- is
 * `app-money-assertion.test.ts`'s own job; complete/approve simply ignore
 * the extra header. */
async function authHeader(walletAddress: string): Promise<Record<string, string>> {
  const token = await issuePactlyJwt(walletAddress);
  const assertionToken = await issueMoneyAssertionToken(walletAddress);
  return { authorization: `Bearer ${token}`, "x-pactly-assertion": assertionToken, "content-type": "application/json" };
}

/** An `EscrowAdapter` every method of which throws unless overridden --
 * mirrors `app-bookings.test.ts`'s own `fakeEscrowAdapter`. */
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

/** Seeds a locked booking with a persisted contractId at a given point in
 * its recorded lifecycle -- the HTTP-layer sibling of
 * `services-booking-actions.test.ts`'s own `seedLockedBooking`, built
 * directly against the db layer rather than through the hold/lock/fund
 * routes (same discipline `app-bookings.test.ts` already uses for its own
 * hold-expiry tests). */
async function seedLockedBooking(
  result: Awaited<ReturnType<typeof openTestDatabase>>,
  options: {
    clientWalletAddress?: string;
    providerWalletAddress?: string;
    slotStartsAt?: number;
    cancelDeadline?: number;
    lifecycleAction?: "funded" | "completed" | "approved" | "disputed";
  } = {},
): Promise<{ bookingId: string; contractId: string; clientWalletAddress: string; providerWalletAddress: string }> {
  const clientWalletAddress = options.clientWalletAddress ?? Keypair.random().publicKey();
  const providerWalletAddress = options.providerWalletAddress ?? Keypair.random().publicKey();
  const providerProfileId = await seedProviderProfile(result, { walletAddress: providerWalletAddress });
  const slotStartsAt = options.slotStartsAt ?? Math.floor(Date.now() / 1000) - 3600;
  const bookingId = await seedBooking(result, {
    providerProfileId,
    clientWalletAddress,
    slotStartsAt,
    cancelDeadline: options.cancelDeadline ?? slotStartsAt - 24 * 3600,
  });
  const contractId = fakeContractId();
  await updateEscrowContractId(result.db, bookingId, contractId);
  updateEscrowStateSync(result.db, bookingId, "locked");
  const action = options.lifecycleAction ?? "funded";
  await insertEscrowProcessedEventIfNew(result.db, {
    bookingId,
    contractId,
    lifecycleAction: action,
    amount: "1000000",
    ledgerSeq: "1",
    isAnomaly: false,
    processedAt: Date.now(),
  });
  return { bookingId, contractId, clientWalletAddress, providerWalletAddress };
}

// ---------------------------------------------------------------------------
// POST /bookings/:id/complete
// ---------------------------------------------------------------------------

test("POST /bookings/:id/complete: 200 for the provider, 404 for the client", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const adapter = fakeEscrowAdapter({ complete: async () => ({ unsignedXdr: "x", txHash: "complete-tx-hash" }) });
    const app = createApp(result.db, { escrowAdapter: adapter });

    const providerResponse = await app.request(`/bookings/${seed.bookingId}/complete`, {
      method: "POST",
      headers: await authHeader(seed.providerWalletAddress),
    });
    assert.equal(providerResponse.status, 200);
    assert.equal(((await providerResponse.json()) as { txHash: string }).txHash, "complete-tx-hash");

    const clientResponse = await app.request(`/bookings/${seed.bookingId}/complete`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
    });
    assert.equal(clientResponse.status, 404);
    assert.equal(((await clientResponse.json()) as { code: string }).code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/complete: 409 BOOKING_STATE once already completed", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "completed" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/bookings/${seed.bookingId}/complete`, {
      method: "POST",
      headers: await authHeader(seed.providerWalletAddress),
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, "BOOKING_STATE");
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// POST /bookings/:id/approve
// ---------------------------------------------------------------------------

test("POST /bookings/:id/approve: 200 for the client, 404 for the provider", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "completed" });
    const adapter = fakeEscrowAdapter({ approve: async () => ({ unsignedXdr: "x", txHash: "approve-tx-hash" }) });
    const app = createApp(result.db, { escrowAdapter: adapter });

    const clientResponse = await app.request(`/bookings/${seed.bookingId}/approve`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
    });
    assert.equal(clientResponse.status, 200);

    const providerResponse = await app.request(`/bookings/${seed.bookingId}/approve`, {
      method: "POST",
      headers: await authHeader(seed.providerWalletAddress),
    });
    assert.equal(providerResponse.status, 404);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// POST /bookings/:id/release
// ---------------------------------------------------------------------------

test("POST /bookings/:id/release: 200 for the provider once approved; 409 before that", async () => {
  const result = openTestDatabase();
  try {
    const funded = await seedLockedBooking(result, { lifecycleAction: "funded" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const tooEarly = await app.request(`/bookings/${funded.bookingId}/release`, {
      method: "POST",
      headers: await authHeader(funded.providerWalletAddress),
    });
    assert.equal(tooEarly.status, 409);

    const approved = await seedLockedBooking(result, { lifecycleAction: "approved" });
    const adapter = fakeEscrowAdapter({ release: async () => ({ unsignedXdr: "x", txHash: "release-tx-hash" }) });
    const app2 = createApp(result.db, { escrowAdapter: adapter });
    const ok = await app2.request(`/bookings/${approved.bookingId}/release`, {
      method: "POST",
      headers: await authHeader(approved.providerWalletAddress),
    });
    assert.equal(ok.status, 200);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/release: a signed-unapplied release can be retried, and reports applied without a build once the chain shows it released", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "approved" });
    const first = buildFakeTransactionXdr();
    const second = buildFakeTransactionXdr();
    const envelopes = [first, second];
    let releaseCalls = 0;
    const headers = await authHeader(seed.providerWalletAddress);
    const app = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({
        release: async () => {
          const envelope = envelopes[releaseCalls];
          assert.ok(envelope);
          releaseCalls += 1;
          return { unsignedXdr: envelope.xdr, txHash: envelope.hash };
        },
        submit: async () => ({ txHash: "relayed" }),
      }),
    });

    const firstBuild = await app.request(`/bookings/${seed.bookingId}/release`, { method: "POST", headers });
    assert.equal(firstBuild.status, 200);
    assert.equal(((await firstBuild.json()) as { status: string }).status, "ready");

    const submit = await app.request(`/bookings/${seed.bookingId}/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ signedXdr: first.xdr }),
    });
    assert.equal(submit.status, 200);

    const retry = await app.request(`/bookings/${seed.bookingId}/release`, { method: "POST", headers });
    assert.equal(retry.status, 200);
    const retryBody = (await retry.json()) as { status: string; contractId: string };
    assert.equal(retryBody.status, "ready");
    assert.equal(retryBody.contractId, seed.contractId);
    assert.equal(releaseCalls, 2);

    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId: seed.bookingId,
      contractId: seed.contractId,
      lifecycleAction: "released",
      amount: "0",
      ledgerSeq: "2",
      isAnomaly: false,
      processedAt: Date.now(),
    });
    let afterSuccessReleaseCalls = 0;
    const appliedApp = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({
        release: async () => {
          afterSuccessReleaseCalls += 1;
          return { unsignedXdr: second.xdr, txHash: second.hash };
        },
      }),
    });
    const applied = await appliedApp.request(`/bookings/${seed.bookingId}/release`, { method: "POST", headers });
    assert.equal(applied.status, 200);
    assert.equal(((await applied.json()) as { status: string }).status, "applied");
    assert.equal(afterSuccessReleaseCalls, 0);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// POST /bookings/:id/dispute
// ---------------------------------------------------------------------------

test("POST /bookings/:id/dispute: 400 for an unknown reason, before ever reaching the service", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ reason: "not-a-real-reason" }),
    });
    assert.equal(response.status, 400);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/dispute: 200 for the client with a known reason, carrying the suggested outcome", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const adapter = fakeEscrowAdapter({ startDispute: async () => ({ unsignedXdr: "x", txHash: "dispute-tx-hash" }) });
    const app = createApp(result.db, { escrowAdapter: adapter });
    const response = await app.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ reason: "provider-no-show" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { txHash: string; reason: string; suggestedOutcome?: string };
    assert.equal(body.txHash, "dispute-tx-hash");
    assert.equal(body.reason, "provider-no-show");
    assert.equal(body.suggestedOutcome, "refund-client");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/dispute: 404 for a wallet that owns neither role on this booking", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(Keypair.random().publicKey()),
      body: JSON.stringify({ reason: "disagreement" }),
    });
    assert.equal(response.status, 404);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/dispute: 409 once a dispute is already open", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ reason: "disagreement" }),
    });
    assert.equal(response.status, 409);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// Issue #22: dispute note and evidence hash
// ---------------------------------------------------------------------------

test("POST /bookings/:id/dispute: 200 stores and returns the note and evidence hash", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const adapter = fakeEscrowAdapter({ startDispute: async () => ({ unsignedXdr: "x", txHash: "dispute-tx-hash" }) });
    const app = createApp(result.db, { escrowAdapter: adapter });
    const response = await app.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ reason: "provider-no-show", note: "See the attached photo.", evidenceHash: "aa".repeat(32) }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      txHash: string;
      reason: string;
      note?: string;
      evidenceHash?: string;
    };
    assert.equal(body.note, "See the attached photo.");
    assert.equal(body.evidenceHash, "aa".repeat(32));
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/dispute: 400 for an evidence hash that is not 64 hex characters", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result);
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ reason: "disagreement", evidenceHash: "not-a-hash" }),
    });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, "INVALID_REASON");
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// POST /admin/bookings/:id/resolve and GET /admin/disputes
// ---------------------------------------------------------------------------

test("POST /admin/bookings/:id/resolve: 404 for a wallet that is not an admin at all", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/admin/bookings/${seed.bookingId}/resolve`, {
      method: "POST",
      headers: await authHeader(Keypair.random().publicKey()),
      body: JSON.stringify({ outcome: "refund-client" }),
    });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, "NOT_ADMIN");
  } finally {
    closeDatabase(result);
  }
});

test("POST /admin/bookings/:id/resolve: 403 NOT_DISPUTE_RESOLVER for an admin wallet that is not Pactly's own resolver", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/admin/bookings/${seed.bookingId}/resolve`, {
      method: "POST",
      headers: await authHeader(NON_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "refund-client" }),
    });
    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { code: string }).code, "NOT_DISPUTE_RESOLVER");
  } finally {
    closeDatabase(result);
  }
});

test("POST /admin/bookings/:id/resolve: 400 for an invalid outcome, before the service is ever called", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/admin/bookings/${seed.bookingId}/resolve`, {
      method: "POST",
      headers: await authHeader(DISPUTE_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "give-it-to-nobody" }),
    });
    assert.equal(response.status, 400);
  } finally {
    closeDatabase(result);
  }
});

test("POST /admin/bookings/:id/resolve: 404 BOOKING_NOT_FOUND for an unknown booking id", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/admin/bookings/${randomBytes(16).toString("hex")}/resolve`, {
      method: "POST",
      headers: await authHeader(DISPUTE_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "refund-client" }),
    });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { code: string }).code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /admin/bookings/:id/resolve: 200 for the dispute-resolver admin wallet, given chain-confirmed disputed evidence", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const adapter = fakeEscrowAdapter({ resolveDispute: async () => ({ unsignedXdr: "x", txHash: "resolve-tx-hash" }) });
    const app = createApp(result.db, { escrowAdapter: adapter });
    const response = await app.request(`/admin/bookings/${seed.bookingId}/resolve`, {
      method: "POST",
      headers: await authHeader(DISPUTE_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "refund-client" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { txHash: string; outcome: string };
    assert.equal(body.txHash, "resolve-tx-hash");
    assert.equal(body.outcome, "refund-client");

    const booking = await getBookingById(result.db, seed.bookingId);
    assert.equal(booking?.escrowResolveTxHash, "resolve-tx-hash");
  } finally {
    closeDatabase(result);
  }
});

test("GET /admin/disputes: 404 for a non-admin wallet; 200 with the open dispute for an admin wallet", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "funded" });
    const disputeTx = buildFakeTransactionXdr();
    const disputeAdapter = fakeEscrowAdapter({
      startDispute: async () => ({ unsignedXdr: "x", txHash: disputeTx.hash }),
      submit: async () => ({ txHash: "relayed" }),
    });
    const disputeApp = createApp(result.db, { escrowAdapter: disputeAdapter });
    const openResponse = await disputeApp.request(`/bookings/${seed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ reason: "provider-no-show" }),
    });
    assert.equal(openResponse.status, 200);
    // Review round: the opening row is only ever written once a matching
    // signed transaction is actually relayed -- submit it here before the
    // reconciler's own chain confirmation is seeded below.
    const submitResponse = await disputeApp.request(`/bookings/${seed.bookingId}/submit`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ signedXdr: disputeTx.xdr }),
    });
    assert.equal(submitResponse.status, 200);
    // The reconciler's own later chain confirmation.
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId: seed.bookingId,
      contractId: seed.contractId,
      lifecycleAction: "disputed",
      amount: "1000000",
      ledgerSeq: "2",
      isAnomaly: false,
      processedAt: Date.now(),
    });

    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const nonAdmin = await app.request("/admin/disputes", { method: "GET", headers: await authHeader(Keypair.random().publicKey()) });
    assert.equal(nonAdmin.status, 404);

    // Any admin wallet may view the list -- not only the dispute resolver.
    const asAdmin = await app.request("/admin/disputes", { method: "GET", headers: await authHeader(NON_RESOLVER_ADMIN_WALLET) });
    assert.equal(asAdmin.status, 200);
    const body = (await asAdmin.json()) as {
      disputes: Array<{ bookingId: string; reason: string; suggestedOutcome?: string; openedByRole?: string }>;
    };
    assert.equal(body.disputes.length, 1);
    assert.equal(body.disputes[0]?.bookingId, seed.bookingId);
    assert.equal(body.disputes[0]?.reason, "provider-no-show");
    assert.equal(body.disputes[0]?.suggestedOutcome, "refund-client");
    assert.equal(body.disputes[0]?.openedByRole, "client");
  } finally {
    closeDatabase(result);
  }
});


// ---------------------------------------------------------------------------
// POST /bookings/:id/submit -- role-aware (review round): a client, a
// provider, or Pactly's own resolver wallet may all submit here, each only
// ever relaying the transaction kind their own resolved role grants them.
// ---------------------------------------------------------------------------

test("POST /bookings/:id/submit: the provider submits its own complete and release transactions (200 each)", async () => {
  const result = openTestDatabase();
  try {
    const funded = await seedLockedBooking(result, { lifecycleAction: "funded" });
    const completeTx = buildFakeTransactionXdr();
    const completeApp = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({
        complete: async () => ({ unsignedXdr: "x", txHash: completeTx.hash }),
        submit: async () => ({ txHash: "relayed-complete" }),
      }),
    });
    const completeBuild = await completeApp.request(`/bookings/${funded.bookingId}/complete`, {
      method: "POST",
      headers: await authHeader(funded.providerWalletAddress),
    });
    assert.equal(completeBuild.status, 200);
    const completeSubmit = await completeApp.request(`/bookings/${funded.bookingId}/submit`, {
      method: "POST",
      headers: await authHeader(funded.providerWalletAddress),
      body: JSON.stringify({ signedXdr: completeTx.xdr }),
    });
    assert.equal(completeSubmit.status, 200);

    const approved = await seedLockedBooking(result, { lifecycleAction: "approved" });
    const releaseTx = buildFakeTransactionXdr();
    const releaseApp = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({
        release: async () => ({ unsignedXdr: "x", txHash: releaseTx.hash }),
        submit: async () => ({ txHash: "relayed-release" }),
      }),
    });
    const releaseBuild = await releaseApp.request(`/bookings/${approved.bookingId}/release`, {
      method: "POST",
      headers: await authHeader(approved.providerWalletAddress),
    });
    assert.equal(releaseBuild.status, 200);
    const releaseSubmit = await releaseApp.request(`/bookings/${approved.bookingId}/submit`, {
      method: "POST",
      headers: await authHeader(approved.providerWalletAddress),
      body: JSON.stringify({ signedXdr: releaseTx.xdr }),
    });
    assert.equal(releaseSubmit.status, 200);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/submit: Pactly's own resolver wallet submits a resolve transaction (200)", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const resolveTx = buildFakeTransactionXdr();
    const app = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({
        resolveDispute: async () => ({ unsignedXdr: "x", txHash: resolveTx.hash }),
        submit: async () => ({ txHash: "relayed-resolve" }),
      }),
    });
    const build = await app.request(`/admin/bookings/${seed.bookingId}/resolve`, {
      method: "POST",
      headers: await authHeader(DISPUTE_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "refund-client" }),
    });
    assert.equal(build.status, 200);
    const submit = await app.request(`/bookings/${seed.bookingId}/submit`, {
      method: "POST",
      headers: await authHeader(DISPUTE_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ signedXdr: resolveTx.xdr }),
    });
    assert.equal(submit.status, 200);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/submit: the provider cannot relay a hash that belongs to the client's own role (409 XDR_MISMATCH)", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "funded" });
    const approveTx = buildFakeTransactionXdr();
    const app = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({ approve: async () => ({ unsignedXdr: "x", txHash: approveTx.hash }) }),
    });
    const build = await app.request(`/bookings/${seed.bookingId}/approve`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
    });
    assert.equal(build.status, 200);
    // The provider owns a real role on this booking, but not the one
    // "approve" was built for -- refused, never silently relayed.
    const submit = await app.request(`/bookings/${seed.bookingId}/submit`, {
      method: "POST",
      headers: await authHeader(seed.providerWalletAddress),
      body: JSON.stringify({ signedXdr: approveTx.xdr }),
    });
    assert.equal(submit.status, 409);
    assert.equal(((await submit.json()) as { code: string }).code, "XDR_MISMATCH");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/submit: the client cannot relay the resolver's own resolve hash (409 XDR_MISMATCH)", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "disputed" });
    const resolveTx = buildFakeTransactionXdr();
    const app = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({ resolveDispute: async () => ({ unsignedXdr: "x", txHash: resolveTx.hash }) }),
    });
    const build = await app.request(`/admin/bookings/${seed.bookingId}/resolve`, {
      method: "POST",
      headers: await authHeader(DISPUTE_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "refund-client" }),
    });
    assert.equal(build.status, 200);
    const submit = await app.request(`/bookings/${seed.bookingId}/submit`, {
      method: "POST",
      headers: await authHeader(seed.clientWalletAddress),
      body: JSON.stringify({ signedXdr: resolveTx.xdr }),
    });
    assert.equal(submit.status, 409);
    assert.equal(((await submit.json()) as { code: string }).code, "XDR_MISMATCH");
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// Review round: additional coverage the review explicitly asked for.
// ---------------------------------------------------------------------------

test("POST /admin/bookings/:id/resolve: 409 BOOKING_STATE when the booking is locked but not disputed", async () => {
  const result = openTestDatabase();
  try {
    const seed = await seedLockedBooking(result, { lifecycleAction: "funded" });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/admin/bookings/${seed.bookingId}/resolve`, {
      method: "POST",
      headers: await authHeader(DISPUTE_RESOLVER_ADMIN_WALLET),
      body: JSON.stringify({ outcome: "refund-client" }),
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, "BOOKING_STATE");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/dispute: 200 from 'completed' and from 'approved', not only 'funded'", async () => {
  const result = openTestDatabase();
  try {
    const completed = await seedLockedBooking(result, { lifecycleAction: "completed" });
    const app1 = createApp(result.db, { escrowAdapter: fakeEscrowAdapter({ startDispute: async () => ({ unsignedXdr: "x", txHash: "h1" }) }) });
    const fromCompleted = await app1.request(`/bookings/${completed.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(completed.clientWalletAddress),
      body: JSON.stringify({ reason: "disagreement" }),
    });
    assert.equal(fromCompleted.status, 200);

    const approved = await seedLockedBooking(result, { lifecycleAction: "approved" });
    const app2 = createApp(result.db, { escrowAdapter: fakeEscrowAdapter({ startDispute: async () => ({ unsignedXdr: "x", txHash: "h2" }) }) });
    const fromApproved = await app2.request(`/bookings/${approved.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(approved.providerWalletAddress),
      body: JSON.stringify({ reason: "disagreement" }),
    });
    assert.equal(fromApproved.status, 200);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/dispute: 409 after the appointment dispute window has closed", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const booking = await seedLockedBooking(result, { slotStartsAt: now - 8 * 24 * 3600 });
    let startDisputeCalled = false;
    const app = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({
        startDispute: async () => {
          startDisputeCalled = true;
          return { unsignedXdr: "x", txHash: "late-dispute" };
        },
      }),
    });
    const response = await app.request(`/bookings/${booking.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(booking.clientWalletAddress),
      body: JSON.stringify({ reason: "disagreement" }),
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, "DISPUTE_WINDOW_CLOSED");
    assert.equal(startDisputeCalled, false);
  } finally {
    closeDatabase(result);
  }
});

test("GET /bookings/:id: includes a server-computed dispute deadline", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const slotStartsAt = now - 6 * 24 * 3600;
    const booking = await seedLockedBooking(result, { slotStartsAt });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const response = await app.request(`/bookings/${booking.bookingId}`, {
      headers: await authHeader(booking.clientWalletAddress),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { slotStartsAt: number; disputeDeadline: number };
    assert.equal(body.slotStartsAt, slotStartsAt);
    assert.equal(body.disputeDeadline, slotStartsAt + 7 * 24 * 3600);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/dispute: 409 before the appointment and when no slot time is recorded", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });
    const beforeAppointment = await seedLockedBooking(result, { slotStartsAt: now + 60 });
    const early = await app.request(`/bookings/${beforeAppointment.bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(beforeAppointment.clientWalletAddress),
      body: JSON.stringify({ reason: "disagreement" }),
    });
    assert.equal(early.status, 409);
    assert.equal(((await early.json()) as { code: string }).code, "DISPUTE_WINDOW_CLOSED");

    const providerWalletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, { walletAddress: providerWalletAddress });
    const clientWalletAddress = Keypair.random().publicKey();
    const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress });
    const contractId = fakeContractId();
    await updateEscrowContractId(result.db, bookingId, contractId);
    updateEscrowStateSync(result.db, bookingId, "locked");
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId,
      contractId,
      lifecycleAction: "funded",
      amount: "1000000",
      ledgerSeq: "1",
      isAnomaly: false,
      processedAt: Date.now(),
    });
    const missingSlot = await app.request(`/bookings/${bookingId}/dispute`, {
      method: "POST",
      headers: await authHeader(clientWalletAddress),
      body: JSON.stringify({ reason: "disagreement" }),
    });
    assert.equal(missingSlot.status, 409);
    assert.equal(((await missingSlot.json()) as { code: string }).code, "DISPUTE_WINDOW_CLOSED");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/submit: refuses a late dispute before relaying it", async () => {
  const result = openTestDatabase();
  try {
    const now = Math.floor(Date.now() / 1000);
    const booking = await seedLockedBooking(result, { slotStartsAt: now - 8 * 24 * 3600 });
    const transaction = buildFakeTransactionXdr();
    await setPendingDispute(result.db, booking.bookingId, {
      txHash: transaction.hash,
      reason: "disagreement",
      openerWallet: booking.clientWalletAddress,
      openerRole: "client",
    });
    let submitCalled = false;
    const app = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({
        submit: async () => {
          submitCalled = true;
          return { txHash: "late-dispute-submit" };
        },
      }),
    });
    const response = await app.request(`/bookings/${booking.bookingId}/submit`, {
      method: "POST",
      headers: await authHeader(booking.clientWalletAddress),
      body: JSON.stringify({ signedXdr: transaction.xdr }),
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, "DISPUTE_WINDOW_CLOSED");
    assert.equal(submitCalled, false);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// POST /bookings/:id/decline
// ---------------------------------------------------------------------------

test("POST /bookings/:id/decline: 200 for the shop, 404 for another shop, 409 once locked", async () => {
  const result = openTestDatabase();
  try {
    const providerWalletAddress = Keypair.random().publicKey();
    const providerProfileId = await seedProviderProfile(result, { walletAddress: providerWalletAddress });
    const holdId = await seedBooking(result, { providerProfileId });
    const app = createApp(result.db, { escrowAdapter: fakeEscrowAdapter() });

    const otherShop = await app.request(`/bookings/${holdId}/decline`, {
      method: "POST",
      headers: await authHeader(Keypair.random().publicKey()),
    });
    assert.equal(otherShop.status, 404);
    assert.equal(((await otherShop.json()) as { code: string }).code, "BOOKING_NOT_FOUND");

    const declined = await app.request(`/bookings/${holdId}/decline`, {
      method: "POST",
      headers: await authHeader(providerWalletAddress),
    });
    assert.equal(declined.status, 200);
    assert.notEqual((await getBookingById(result.db, holdId))?.declinedAt, null);

    const locked = await seedLockedBooking(result);
    const lockedResponse = await app.request(`/bookings/${locked.bookingId}/decline`, {
      method: "POST",
      headers: await authHeader(locked.providerWalletAddress),
    });
    assert.equal(lockedResponse.status, 409);
    assert.equal(((await lockedResponse.json()) as { code: string }).code, "BOOKING_STATE");
  } finally {
    closeDatabase(result);
  }
});
