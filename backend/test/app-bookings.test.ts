/**
 * Story 3.4's five booking routes (`POST /bookings/hold`,
 * `POST /bookings/:id/lock`, `POST /bookings/:id/fund`,
 * `POST /bookings/:id/submit`, `GET /bookings/:id`), driven through Hono's
 * own `app.request(...)` like `app-providers.test.ts`. Covers the I/O
 * matrix's status codes and envelope shapes at the HTTP boundary; the
 * escrow-adapter-level behavior (deploy/fund/submit payload wiring, XDR
 * retry/rebuild) is `services-booking.test.ts`/`services-booking-hold.
 * test.ts`'s job. `TRUSTLESS_WORK_*` is empty in the test fixture env
 * (`testConfigEnv.ts`), so any route that would reach the adapter refuses
 * before any network access with a typed `EscrowConfigError` -- exercised
 * here as the route's own `503 ESCROW_UNAVAILABLE` mapping.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { StrKey } from "@stellar/stellar-sdk";

import { createApp } from "../src/app.js";
import { issueMoneyAssertionToken } from "../src/auth/assertion.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import {
  getBookingById,
  insertBooking,
  recordEscrowReconciledAtSync,
  updateEscrowContractId,
  updateEscrowState,
} from "../src/db/bookings.js";
import { insertProviderProfile } from "../src/db/providerProfiles.js";
import { availabilitySlots, categories } from "../src/db/schema.js";
import { holdSlot, TooManyHoldsError } from "../src/services/booking.js";
import { resetUsdcAssetCacheForTests, resolveUsdcAsset } from "../src/anchor/usdc.js";
import type { EscrowAdapter } from "../src/escrow/interface.js";
import {
  closeDatabase,
  openTestDatabase,
  seedBooking,
  seedProviderProfile,
  USDC_CHECK_UNAVAILABLE_WALLET_DEPS,
  USDC_MISSING_WALLET_DEPS,
  USDC_READY_WALLET_DEPS,
} from "./helpers.js";

const FAKE_USDC_DEPS = { resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }) };

/** Session token plus the fresh passkey assertion every money action's
 * build route requires (issue #13) -- the route-level gate is exercised on
 * its own in `app-money-assertion.test.ts`; the rest of this file is about
 * what happens *after* the gate. */
async function authHeader(walletAddress: string): Promise<Record<string, string>> {
  const token = await issuePactlyJwt(walletAddress);
  const assertionToken = await issueMoneyAssertionToken(walletAddress);
  return { authorization: `Bearer ${token}`, "x-pactly-assertion": assertionToken };
}

/** A minimal, valid stellar.toml body with a USDC currency entry -- used to
 * *prime* `anchor/usdc.ts`'s own module-level cache via an injected fetch,
 * so `POST /bookings/hold` (which the route always calls with the real,
 * cached `resolveUsdcAsset` -- there is no adapter-style seam for it at the
 * route level) never actually reaches the live anchor during this test
 * file's run. Review follow-up: this test previously hit the real anchor
 * over the network with no seam at all. */
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const FAKE_STELLAR_TOML = `
WEB_AUTH_ENDPOINT="https://anchor.example/auth"
SIGNING_KEY="GDKM7BQVFI7YFRKJZW7VP2QRTGGQBZIVIMSQ3EYKPXKN2ZFOZ6RA6OFY"

[[CURRENCIES]]
code="USDC"
issuer="${USDC_ISSUER}"
`;

async function primeUsdcAssetCache(): Promise<void> {
  resetUsdcAssetCacheForTests();
  await resolveUsdcAsset({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => FAKE_STELLAR_TOML }) });
}

test("POST /bookings/hold returns 201 with amounts derived from the provider, never from the caller, and the real (primed, never live) USDC tokenAddress", async () => {
  const result = openTestDatabase();
  try {
    await primeUsdcAssetCache();
    const providerProfileId = await seedProviderProfile(result, {
      isApproved: true,
      priceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
    });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const app = createApp(result.db);
    const headers = { ...(await authHeader("GCLIENTWALLET1")), "content-type": "application/json" };

    const response = await app.request("/bookings/hold", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: providerProfileId, slotStartsAt }),
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as { bookingId: string; deposit: { amount: string; asset: string } };
    assert.equal(body.deposit.amount, "2000000");
    assert.equal(body.deposit.asset, "USDC");
    assert.ok(body.bookingId);

    const booking = await getBookingById(result.db, body.bookingId);
    assert.ok(booking?.tokenAddress);
    assert.ok(StrKey.isValidContract(booking!.tokenAddress), "tokenAddress must be the USDC SAC contract id derived from the (fake, primed) anchor toml");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/hold rejects a non-integer slotStartsAt with 400, before ever reaching holdSlot", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const app = createApp(result.db);
    const headers = { ...(await authHeader("GCLIENTWALLETNONINT")), "content-type": "application/json" };
    const response = await app.request("/bookings/hold", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: providerProfileId, slotStartsAt: Math.floor(Date.now() / 1000) + 3600.5 }),
    });
    assert.equal(response.status, 400);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/hold gives 429 TOO_MANY_HOLDS once a wallet already has 3 pending holds", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = Math.floor(Date.now() / 1000);
    const slots = [now + 3600, now + 7200, now + 10800, now + 14400];
    await replaceFutureSlots(result.db, providerProfileId, slots);
    const clientWalletAddress = "GCLIENTTOOMANYHOLDS0";
    for (const slotStartsAt of slots.slice(0, 3)) {
      await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);
    }

    const app = createApp(result.db);
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };
    const response = await app.request("/bookings/hold", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: providerProfileId, slotStartsAt: slots[3] }),
    });
    assert.equal(response.status, 429);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "TOO_MANY_HOLDS");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/hold gives 404 PROVIDER_NOT_FOUND for an unapproved provider", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: false });
    const app = createApp(result.db);
    const headers = { ...(await authHeader("GCLIENTWALLET2")), "content-type": "application/json" };
    const response = await app.request("/bookings/hold", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: providerProfileId, slotStartsAt: Math.floor(Date.now() / 1000) + 3600 }),
    });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "PROVIDER_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/hold gives 409 SLOT_TAKEN with the day's other open slots once a slot is already held", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    // Review round: anchored to the *next* UTC calendar day (rather than
    // `Date.now() + 3600`/`+ 7200` directly) so `slotStartsAt` and
    // `otherSlot` always share one UTC day regardless of how close to
    // midnight UTC this suite happens to run -- the previous version failed
    // for about two hours a day when `+7200` crossed into the next day and
    // `sameDaySlots`' own UTC day window (no tzOffsetMinutes given here)
    // then excluded `otherSlot`.
    const now = Math.floor(Date.now() / 1000);
    const SECONDS_PER_DAY = 24 * 60 * 60;
    const nextUtcDayStart = (Math.floor(now / SECONDS_PER_DAY) + 1) * SECONDS_PER_DAY;
    const slotStartsAt = nextUtcDayStart + 3600;
    const otherSlot = nextUtcDayStart + 7200;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt, otherSlot]);
    await holdSlot(result.db, { providerProfileId, clientWalletAddress: "GFIRSTCLIENT", slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const headers = { ...(await authHeader("GSECONDCLIENT")), "content-type": "application/json" };
    const response = await app.request("/bookings/hold", {
      method: "POST",
      headers,
      body: JSON.stringify({ providerId: providerProfileId, slotStartsAt }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string; details: { sameDaySlots: number[] } };
    assert.equal(body.code, "SLOT_TAKEN");
    assert.deepEqual(body.details.sameDaySlots, [otherSlot]);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/hold gives 401 with no token", async () => {
  const result = openTestDatabase();
  try {
    const app = createApp(result.db);
    const response = await app.request("/bookings/hold", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "x", slotStartsAt: 1 }),
    });
    assert.equal(response.status, 401);
  } finally {
    closeDatabase(result);
  }
});

test("GET /bookings/:id returns the owner's own booking view", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true, priceAmount: "10000000", depositRateBps: 2000 });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GOWNERWALLET";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const headers = await authHeader(clientWalletAddress);
    const before = Math.floor(Date.now() / 1000);
    const response = await app.request(`/bookings/${hold.bookingId}`, { headers });
    const after = Math.floor(Date.now() / 1000);
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      id: string;
      escrowState: string | null;
      cancelDeadline: number;
      serverTime: number;
      lastReconciledAt: number | null;
    };
    assert.equal(body.id, hold.bookingId);
    assert.equal(body.escrowState, null);
    assert.equal(typeof body.cancelDeadline, "number");
    assert.ok(body.serverTime >= before && body.serverTime <= after);
    assert.equal(body.lastReconciledAt, null);
  } finally {
    closeDatabase(result);
  }
});

test("manual reconcile failure preserves the stale timestamp and escrow state, then rate-limits retries", async () => {
  const result = openTestDatabase();
  try {
    const clientWalletAddress = "GCLIENTRECONCILE";
    const providerProfileId = await seedProviderProfile(result);
    const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress });
    const contractId = "CCONTRACTRECONCILE";
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600;
    await updateEscrowContractId(result.db, bookingId, contractId);
    await updateEscrowState(result.db, bookingId, "locked");
    recordEscrowReconciledAtSync(result.db, bookingId, contractId, staleTimestamp);

    let chainCalls = 0;
    const app = createApp(result.db, {
      reconcilerListEscrows: async () => {
        chainCalls += 1;
        throw new Error("chain unavailable");
      },
    });
    const headers = await authHeader(clientWalletAddress);
    const initial = await app.request(`/bookings/${bookingId}`, { headers });
    assert.equal(initial.status, 200);
    const initialView = (await initial.json()) as { escrowState: string | null; lastReconciledAt: number | null };
    assert.equal(initialView.escrowState, "locked");
    assert.equal(initialView.lastReconciledAt, staleTimestamp);

    const failedRefresh = await app.request(`/bookings/${bookingId}/reconcile`, { method: "POST", headers });
    assert.equal(failedRefresh.status, 503);
    const failedBody = (await failedRefresh.json()) as { code: string; message: string };
    assert.equal(failedBody.code, "ESCROW_UNAVAILABLE");
    assert.match(failedBody.message, /last known booking status is unchanged/i);
    assert.equal(chainCalls, 1);

    const repeatedRefresh = await app.request(`/bookings/${bookingId}/reconcile`, { method: "POST", headers });
    assert.equal(repeatedRefresh.status, 429);
    assert.equal(chainCalls, 1);

    const booking = await getBookingById(result.db, bookingId);
    assert.equal(booking?.escrowState, "locked");
    assert.equal(booking?.escrowReconciledAt, staleTimestamp);
  } finally {
    closeDatabase(result);
  }
});

test("manual reconcile updates the successful timestamp and does not call the chain without a contract", async () => {
  const result = openTestDatabase();
  try {
    const clientWalletAddress = "GCLIENTRECONCILESUCCESS";
    const providerProfileId = await seedProviderProfile(result);
    const bookingId = await seedBooking(result, { providerProfileId, clientWalletAddress });
    const contractId = "CCONTRACTRECONCILESUCCESS";
    const staleTimestamp = Math.floor(Date.now() / 1000) - 600;
    await updateEscrowContractId(result.db, bookingId, contractId);
    await updateEscrowState(result.db, bookingId, "locked");
    recordEscrowReconciledAtSync(result.db, bookingId, contractId, staleTimestamp);

    let chainCalls = 0;
    const app = createApp(result.db, {
      reconcilerListEscrows: async () => {
        chainCalls += 1;
        return { data: [], hasMore: false, nextCursor: null };
      },
    });
    const headers = await authHeader(clientWalletAddress);
    const success = await app.request(`/bookings/${bookingId}/reconcile`, { method: "POST", headers });
    assert.equal(success.status, 200);
    const view = (await success.json()) as { escrowState: string | null; lastReconciledAt: number };
    assert.equal(view.escrowState, "locked");
    assert.ok(view.lastReconciledAt > staleTimestamp);
    assert.equal(chainCalls, 1);

    const noContractBookingId = await seedBooking(result, { providerProfileId, clientWalletAddress: "GCLIENTNOCONTRACT" });
    const noContract = await app.request(`/bookings/${noContractBookingId}/reconcile`, {
      method: "POST",
      headers: await authHeader("GCLIENTNOCONTRACT"),
    });
    assert.equal(noContract.status, 409);
    assert.equal(chainCalls, 1);
  } finally {
    closeDatabase(result);
  }
});

test("GET /bookings/:id gives 404 BOOKING_NOT_FOUND for someone else's booking, indistinguishable from an unknown id", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress: "GOWNERWALLET2", slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const strangerHeaders = await authHeader("GSTRANGERWALLET");
    const responseForOthersBooking = await app.request(`/bookings/${hold.bookingId}`, { headers: strangerHeaders });
    assert.equal(responseForOthersBooking.status, 404);
    const bodyForOthersBooking = (await responseForOthersBooking.json()) as { code: string };
    assert.equal(bodyForOthersBooking.code, "BOOKING_NOT_FOUND");

    const responseForUnknown = await app.request("/bookings/does-not-exist", { headers: strangerHeaders });
    assert.equal(responseForUnknown.status, 404);
    const bodyForUnknown = (await responseForUnknown.json()) as { code: string };
    assert.equal(bodyForUnknown.code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/lock gives 404 BOOKING_NOT_FOUND for someone else's booking, before ever reaching the adapter", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress: "GOWNERWALLET3", slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const strangerHeaders = { ...(await authHeader("GSTRANGERWALLET2")), "content-type": "application/json" };
    const response = await app.request(`/bookings/${hold.bookingId}/lock`, { method: "POST", headers: strangerHeaders });
    assert.equal(response.status, 404);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/lock gives 503 ESCROW_UNAVAILABLE when the owner calls it but Trustless Work is unconfigured", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GOWNERWALLET4";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db, { usdcTrustlineDeps: USDC_READY_WALLET_DEPS });
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };
    const response = await app.request(`/bookings/${hold.bookingId}/lock`, { method: "POST", headers });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code: string; contractId?: string };
    assert.equal(body.code, "ESCROW_UNAVAILABLE");
    assert.equal(body.contractId, undefined, "no escrow id is shown while the operator is unconfigured");
    assert.equal((await getBookingById(result.db, hold.bookingId))?.escrowContractId, null);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/fund gives 409 BOOKING_STATE when no contractId has been persisted yet", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GOWNERWALLET5";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };
    const response = await app.request(`/bookings/${hold.bookingId}/fund`, { method: "POST", headers });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "BOOKING_STATE");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/submit gives 400 for a missing signedXdr, and 404 for someone else's booking", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GOWNERWALLET6";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    const app = createApp(result.db);
    const ownerHeaders = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };
    const missingXdrResponse = await app.request(`/bookings/${hold.bookingId}/submit`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(missingXdrResponse.status, 400);

    const strangerHeaders = { ...(await authHeader("GSTRANGERWALLET3")), "content-type": "application/json" };
    const strangerResponse = await app.request(`/bookings/${hold.bookingId}/submit`, {
      method: "POST",
      headers: strangerHeaders,
      body: JSON.stringify({ signedXdr: "irrelevant" }),
    });
    assert.equal(strangerResponse.status, 404);
    const strangerBody = (await strangerResponse.json()) as { code: string };
    assert.equal(strangerBody.code, "BOOKING_NOT_FOUND");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/submit gives 409 XDR_MISMATCH for a well-formed but unrelated signed transaction", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GOWNERWALLET7";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);
    // No lock has ever run for this booking -- neither a stored deploy nor
    // a fund txHash exists, so any transaction mismatches.
    const { Account, Keypair, Networks, Operation, TransactionBuilder } = await import("@stellar/stellar-sdk");
    const account = new Account(Keypair.random().publicKey(), "0");
    const xdr = new TransactionBuilder(account, { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.bumpSequence({ bumpTo: "1" }))
      .setTimeout(30)
      .build()
      .toXDR();

    const app = createApp(result.db);
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };
    const response = await app.request(`/bookings/${hold.bookingId}/submit`, {
      method: "POST",
      headers,
      body: JSON.stringify({ signedXdr: xdr }),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "XDR_MISMATCH");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/lock gives 409 HOLD_EXPIRED once the hold's own clock has passed", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = Math.floor(Date.now() / 1000);
    const slotStartsAt = now + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);
    const clientWalletAddress = "GOWNERWALLETHOLDEXP";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, { ...FAKE_USDC_DEPS, now });

    const { bookings } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await result.db.update(bookings).set({ holdExpiresAt: now - 1 }).where(eq(bookings.id, hold.bookingId));

    const app = createApp(result.db);
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };

    const lockResponse = await app.request(`/bookings/${hold.bookingId}/lock`, { method: "POST", headers });
    assert.equal(lockResponse.status, 409);
    assert.equal(((await lockResponse.json()) as { code: string }).code, "HOLD_EXPIRED");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/fund does not expire when a deploy contract id is already persisted", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const now = Math.floor(Date.now() / 1000);
    const slotStartsAt = now + 7200;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt], now);
    const clientWalletAddress = "GOWNERWALLETHOLDEXP2";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, { ...FAKE_USDC_DEPS, now });

    const { updateEscrowContractId, recordDeploySubmission } = await import("../src/db/bookings.js");
    await updateEscrowContractId(result.db, hold.bookingId, "CFAKECONTRACT000000000000000000000000000000000000", "unsigned-xdr", "deploy-tx-hash");
    // A deploy was submitted, and the persisted contract id is the evidence
    // that this is no longer an uncommitted hold.
    await recordDeploySubmission(result.db, hold.bookingId, "CFAKECONTRACT000000000000000000000000000000000000", "deploy-tx-hash", now + 600, now);
    const { bookings } = await import("../src/db/schema.js");
    const { eq } = await import("drizzle-orm");
    await result.db.update(bookings).set({ holdExpiresAt: now - 1 }).where(eq(bookings.id, hold.bookingId));

    const app = createApp(result.db);
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };
    const fundResponse = await app.request(`/bookings/${hold.bookingId}/fund`, { method: "POST", headers });
    assert.equal(fundResponse.status, 503);
    assert.equal(((await fundResponse.json()) as { code: string }).code, "ESCROW_UNAVAILABLE");
  } finally {
    closeDatabase(result);
  }
});

/** An `EscrowAdapter` every method of which throws unless overridden --
 * `createApp`'s own injectable adapter seam lets a route test exercise a
 * real accepted deploy, or a real Trustless Work refusal, without a live
 * API key. */
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

test("POST /bookings/:id/lock gives 502 ESCROW_REJECTED when the injected adapter's deploy is refused by Trustless Work", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GOWNERWALLETREJECT0";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    const { EscrowApiError } = await import("../src/escrow/trustless-work/errors.js");
    const adapter = fakeEscrowAdapter({
      deploy: async () => {
        throw new EscrowApiError("ESCROW_PLATFORM_FEE_TOO_HIGH" as never, "platform fee too high");
      },
    });
    const app = createApp(result.db, { escrowAdapter: adapter, usdcTrustlineDeps: USDC_READY_WALLET_DEPS });
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };
    const response = await app.request(`/bookings/${hold.bookingId}/lock`, { method: "POST", headers });
    assert.equal(response.status, 502);
    const body = (await response.json()) as { code: string };
    assert.equal(body.code, "ESCROW_REJECTED");
  } finally {
    closeDatabase(result);
  }
});

/** Issue #4 helper: a booking held by a client whose wallet the test then
 * answers for -- the two route tests below only differ in that answer. */
async function holdForWalletReadinessTest(result: ReturnType<typeof openTestDatabase>, clientWalletAddress: string) {
  const providerProfileId = await seedProviderProfile(result, { isApproved: true });
  const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
  await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
  return holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);
}

test("POST /bookings/:id/lock gives 409 WALLET_CANNOT_HOLD_DEPOSIT, and deploys nothing, when the client's wallet cannot hold the deposit (issue #4)", async () => {
  const result = openTestDatabase();
  try {
    const clientWalletAddress = "GOWNERWALLETNOTREADY0";
    const hold = await holdForWalletReadinessTest(result, clientWalletAddress);

    let deployCalls = 0;
    const adapter = fakeEscrowAdapter({
      deploy: async () => {
        deployCalls += 1;
        return { contractId: "contract-should-not-exist", unsignedXdr: "xdr", txHash: "hash" };
      },
    });
    const app = createApp(result.db, { escrowAdapter: adapter, usdcTrustlineDeps: USDC_MISSING_WALLET_DEPS });
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };

    const response = await app.request(`/bookings/${hold.bookingId}/lock`, { method: "POST", headers });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string; message: string };
    assert.equal(body.code, "WALLET_CANNOT_HOLD_DEPOSIT");
    assert.equal(deployCalls, 0, "a wallet that cannot hold the deposit is never offered an escrow");

    const booking = await getBookingById(result.db, hold.bookingId);
    assert.equal(booking?.escrowContractId, null, "no contract id is persisted by the refused lock");
    assert.equal(booking?.escrowLockClaimToken, null, "and nothing is left claimed/in flight");

    // Edge case: what reaches the screen names no mechanism.
    assert.doesNotMatch(body.message, /trustline|issuer|SEP|XDR|Soroban/i, body.message);
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/lock gives 503 WALLET_CHECK_UNAVAILABLE -- retryable, and still no deploy -- when the wallet check cannot be reached (issue #4)", async () => {
  const result = openTestDatabase();
  try {
    const clientWalletAddress = "GOWNERWALLETCHECKDOWN0";
    const hold = await holdForWalletReadinessTest(result, clientWalletAddress);

    let deployCalls = 0;
    const adapter = fakeEscrowAdapter({
      deploy: async () => {
        deployCalls += 1;
        return { contractId: "contract-should-not-exist", unsignedXdr: "xdr", txHash: "hash" };
      },
    });
    const app = createApp(result.db, { escrowAdapter: adapter, usdcTrustlineDeps: USDC_CHECK_UNAVAILABLE_WALLET_DEPS });
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };

    const response = await app.request(`/bookings/${hold.bookingId}/lock`, { method: "POST", headers });
    assert.equal(response.status, 503);
    const body = (await response.json()) as { code: string; message: string };
    assert.equal(body.code, "WALLET_CHECK_UNAVAILABLE");
    assert.equal(deployCalls, 0, "an unanswered question is never read as permission to deploy");
    assert.doesNotMatch(body.message, /Horizon|trustline|issuer|ECONN|fetch failed/i, body.message);

    // The same call, once the wallet is ready, does deploy -- the refusal
    // left the booking exactly as it found it.
    const readyApp = createApp(result.db, {
      escrowAdapter: fakeEscrowAdapter({ deploy: async () => ({ contractId: "contract-after-retry", unsignedXdr: "xdr", txHash: "hash" }) }),
      usdcTrustlineDeps: USDC_READY_WALLET_DEPS,
    });
    const retried = await readyApp.request(`/bookings/${hold.bookingId}/lock`, { method: "POST", headers });
    assert.equal(retried.status, 200);
    assert.equal(((await retried.json()) as { contractId: string }).contractId, "contract-after-retry");
  } finally {
    closeDatabase(result);
  }
});

test("POST /bookings/:id/lock with an injected adapter that accepts the deploy returns {deployed: false, unsignedXdr, contractId, txHash}, and a retry with rebuild: true builds a fresh one", async () => {
  const result = openTestDatabase();
  try {
    const providerProfileId = await seedProviderProfile(result, { isApproved: true });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt]);
    const clientWalletAddress = "GOWNERWALLETACCEPT0";
    const hold = await holdSlot(result.db, { providerProfileId, clientWalletAddress, slotStartsAt }, FAKE_USDC_DEPS);

    let deployCalls = 0;
    const adapter = fakeEscrowAdapter({
      deploy: async () => {
        deployCalls += 1;
        return { contractId: `contract-${deployCalls}`, unsignedXdr: `xdr-${deployCalls}`, txHash: `hash-${deployCalls}` };
      },
    });
    const app = createApp(result.db, { escrowAdapter: adapter, usdcTrustlineDeps: USDC_READY_WALLET_DEPS });
    const headers = { ...(await authHeader(clientWalletAddress)), "content-type": "application/json" };

    const first = await app.request(`/bookings/${hold.bookingId}/lock`, { method: "POST", headers });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { deployed: boolean; contractId: string; unsignedXdr?: string };
    assert.equal(firstBody.deployed, false);
    assert.equal(firstBody.contractId, "contract-1");
    assert.equal(deployCalls, 1);

    // A plain retry returns the same stored XDR, no new deploy call.
    const retry = await app.request(`/bookings/${hold.bookingId}/lock`, { method: "POST", headers });
    const retryBody = (await retry.json()) as { contractId: string };
    assert.equal(retryBody.contractId, "contract-1");
    assert.equal(deployCalls, 1);

    // rebuild: true clears the unsubmitted deploy and builds a fresh one.
    const rebuilt = await app.request(`/bookings/${hold.bookingId}/lock`, {
      method: "POST",
      headers,
      body: JSON.stringify({ rebuild: true }),
    });
    const rebuiltBody = (await rebuilt.json()) as { contractId: string };
    assert.equal(rebuiltBody.contractId, "contract-2");
    assert.equal(deployCalls, 2);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// Issue #26: GET /bookings/:id/ics
// ---------------------------------------------------------------------------

test("GET /bookings/:id/ics: 200 returns an ICS file for a locked booking; 409 when not locked", async () => {
  const result = openTestDatabase();
  try {
    await result.db.insert(categories).values({ id: "cat-ics", name: "Consulting", slug: "consulting" });
    const providerProfileId = "prov-ics";
    await insertProviderProfile(result.db, {
      id: providerProfileId,
      walletAddress: "GPROV0000000000000000000000000000000000000000",
      categoryId: "cat-ics",
      displayName: "Test Clinic",
      title: "Therapist",
      location: "Istanbul",
      bio: "",
      languages: [],
      sessionFormat: "in_person",
      sessionLengthMinutes: 50,
      priceAmount: "10000000",
      depositRateBps: 2000,
      cancellationWindowHours: 24,
      isApproved: true,
      createdAt: Date.now(),
    });
    const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
    await result.db.insert(availabilitySlots).values({
      id: "slot-ics",
      providerProfileId,
      startsAt: slotStartsAt,
      createdAt: Date.now(),
    });
    const bookingId = "booking-ics";
    await insertBooking(result.db, {
      id: bookingId,
      providerProfileId,
      clientWalletAddress: "GCLIENT0000000000000000000000000000000000000000",
      tokenAddress: "CTOKEN0000000000000000000000000000000000000000",
      depositAmount: "2000000",
      balanceAmount: "8000000",
      cancelDeadline: slotStartsAt - 3600,
      slotId: "slot-ics",
      holdExpiresAt: slotStartsAt + 3600,
      createdAt: Date.now(),
    });
    await updateEscrowContractId(result.db, bookingId, "CESCOROW0000000000000000000000000000000000000000");
    await updateEscrowState(result.db, bookingId, "locked");

    const app = createApp(result.db);
    const locked = await app.request(`/bookings/${bookingId}/ics`, {
      headers: await authHeader("GCLIENT0000000000000000000000000000000000000000"),
    });
    assert.equal(locked.status, 200);
    assert.ok(locked.headers.get("content-type")?.startsWith("text/calendar"));
    const text = await locked.text();
    assert.ok(text.includes("BEGIN:VCALENDAR"));
    assert.ok(text.includes("DTSTART:"));
    assert.ok(text.includes("DTEND:"));
    assert.ok(text.includes("Test Clinic"));
    assert.ok(text.includes("booking-ics"));
    // Times are UTC with a Z suffix.
    assert.ok(/DTSTART:\d{8}T\d{6}Z/.test(text));
    assert.ok(/DTEND:\d{8}T\d{6}Z/.test(text));
    // No deposit transaction or wallet secret in the file.
    assert.ok(!text.includes("GCLIENT"));
    assert.ok(!text.includes("2000000"));

    // A hold that is not yet locked does not offer the file.
    const openBookingId = "booking-open";
    await insertBooking(result.db, {
      id: openBookingId,
      providerProfileId,
      clientWalletAddress: "GCLIENT0000000000000000000000000000000000000001",
      tokenAddress: "CTOKEN0000000000000000000000000000000000000001",
      depositAmount: "2000000",
      balanceAmount: "8000000",
      cancelDeadline: slotStartsAt - 3600,
      slotId: "slot-ics",
      holdExpiresAt: slotStartsAt + 3600,
      createdAt: Date.now(),
    });
    const notLocked = await app.request(`/bookings/${openBookingId}/ics`, {
      headers: await authHeader("GCLIENT0000000000000000000000000000000000000001"),
    });
    assert.equal(notLocked.status, 409);
  } finally {
    closeDatabase(result);
  }
});
