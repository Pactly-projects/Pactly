/**
 * Quote freshness: a screen that has been left open must not let a client
 * commit to a local-currency figure the anchor would no longer honour. The
 * validation case from the story is explicit here -- stub an expired quote,
 * refresh it, and assert the *second* price is the one submitted.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, WebAuth } from "@stellar/stellar-sdk";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import {
  DEFAULT_QUOTE_MAX_AGE_SECONDS,
  fetchIndicativePrice,
  isQuoteStale,
  resetSep38CacheForTests,
  type Sep38FetchLike,
} from "../src/anchor/sep38.js";
import { resetUsdcAssetCacheForTests } from "../src/anchor/usdc.js";
import type { AnchorFetchLike } from "../src/anchor/http.js";
import { upsertAnchorJwt } from "../src/db/anchorJwts.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const NETWORK = "Test SDF Network ; September 2015";
const HOME = "tr-mock-anchor.fly.dev";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SELL_ASSET = `stellar:USDC:${USDC_ISSUER}`;
const T0 = Math.floor(Date.UTC(2026, 0, 5) / 1000) * 1000;

function tomlFor(signingKey: string): string {
  return `
WEB_AUTH_ENDPOINT="https://${HOME}/auth"
SIGNING_KEY="${signingKey}"
TRANSFER_SERVER="https://${HOME}/sep6"
KYC_SERVER="https://${HOME}/sep12"
ANCHOR_QUOTE_SERVER="https://${HOME}/sep38"

[[CURRENCIES]]
code="USDC"
issuer="${USDC_ISSUER}"
`;
}

function resetCaches(): void {
  resetSep38CacheForTests();
  resetUsdcAssetCacheForTests();
}

function quoteFetch(priceBody: unknown): Sep38FetchLike {
  return async (url) => {
    if (url.endsWith("/.well-known/stellar.toml")) {
      return { ok: true, status: 200, text: async () => tomlFor(Keypair.random().publicKey()), json: async () => ({}) };
    }
    if (url.endsWith("/sep38/info")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ assets: [{ asset: SELL_ASSET }, { asset: "iso4217:TRY" }] }),
        text: async () => "",
      };
    }
    return { ok: true, status: 200, json: async () => priceBody, text: async () => JSON.stringify(priceBody) };
  };
}

test("a quote with no age is stale after 60 seconds, and a refresh returns the second price", async () => {
  resetCaches();
  let price = "21843.51";
  let currentMs = T0;
  const fetchImpl: Sep38FetchLike = async (url, init) => {
    if (url.includes("/sep38/price")) {
      return { ok: true, status: 200, json: async () => ({ buy_amount: price }), text: async () => "" };
    }
    return quoteFetch({ buy_amount: price })(url, init);
  };
  const quoteOptions = { fetchImpl, now: () => currentMs };

  const first = await fetchIndicativePrice({ amount: "10000000" }, quoteOptions);
  assert.equal(first.fiat.amount, "21843.51");
  assert.equal(first.maxAgeSeconds, DEFAULT_QUOTE_MAX_AGE_SECONDS);
  assert.equal(first.expiresAt, first.quotedAt + 60);
  assert.equal(isQuoteStale(first, first.quotedAt + 59), false);
  assert.equal(isQuoteStale(first, first.quotedAt + 60), true, "the 60-second boundary is stale");

  currentMs = T0 + 59_000;
  assert.equal((await fetchIndicativePrice({ amount: "10000000" }, quoteOptions)).fiat.amount, price, "still cached");

  // The anchor's price moved while the screen was left open.
  price = "25000.00";
  currentMs = T0 + 61_000;
  const second = await fetchIndicativePrice({ amount: "10000000" }, quoteOptions);
  assert.equal(second.fiat.amount, price, "the expired quote is replaced with the anchor's new price");
  assert.equal(isQuoteStale(second, second.quotedAt + 60), true);
});

test("an anchor-supplied age shorter than a minute wins over the 60-second default", async () => {
  resetCaches();
  let currentMs = T0;
  const quoteOptions = { fetchImpl: quoteFetch({ buy_amount: "100.00", age: 5 }), now: () => currentMs };
  const first = await fetchIndicativePrice({ amount: "10000000" }, quoteOptions);
  assert.equal(first.maxAgeSeconds, 5);
  assert.equal(isQuoteStale(first, first.quotedAt + 4), false);
  assert.equal(isQuoteStale(first, first.quotedAt + 5), true);
  assert.equal((await fetchIndicativePrice({ amount: "10000000" }, quoteOptions)).fiat.amount, "100.00");
});

test("GET /quote?refresh=1 bypasses the cache so the client can confirm a new price", async () => {
  resetCaches();
  const result = openTestDatabase();
  try {
    let price = "111.00";
    const app = createApp(result.db, { quoteFetchImpl: quoteFetch({ buy_amount: "111.00" }) as Sep38FetchLike });
    const fetchWithMutablePrice: Sep38FetchLike = async (url, init) => {
      if (url.includes("/sep38/price")) {
        return { ok: true, status: 200, json: async () => ({ buy_amount: price }), text: async () => "" };
      }
      return quoteFetch({ buy_amount: "111.00" })(url, init);
    };
    const liveApp = createApp(result.db, { quoteFetchImpl: fetchWithMutablePrice });

    const first = (await (await app.request("/quote?amount=10000000")).json()) as { fiat: { amount: string } };
    const cached = (await (await liveApp.request("/quote?amount=10000000")).json()) as { fiat: { amount: string } };
    assert.equal(cached.fiat.amount, first.fiat.amount);
    price = "999.00";
    const refreshed = (await (await liveApp.request("/quote?amount=10000000&refresh=1")).json()) as { fiat: { amount: string } };
    assert.equal(refreshed.fiat.amount, "999.00", "refresh returns the anchor's current price");
  } finally {
    closeDatabase(result);
  }
});

interface RouterState {
  depositCalls: number;
  lastDepositAmount?: string;
  price: string;
}

function anchorRouter(anchorServer: Keypair, state: RouterState): AnchorFetchLike {
  return async (url, init) => {
    const parsed = new URL(url);
    const json = (status: number, body: unknown) => ({
      ok: status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    });
    if (parsed.pathname.endsWith("/.well-known/stellar.toml")) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => tomlFor(anchorServer.publicKey()) };
    }
    if (parsed.pathname === "/sep38/info") {
      return json(200, { assets: [{ asset: SELL_ASSET }, { asset: "iso4217:TRY" }] });
    }
    if (parsed.pathname === "/sep38/price") {
      return json(200, { buy_amount: state.price });
    }
    if (parsed.pathname === "/sep6/info") {
      return json(200, { deposit: { USDC: { enabled: true, authentication_required: true } } });
    }
    if (parsed.pathname === "/sep12/customer") {
      return json(200, { status: "ACCEPTED" });
    }
    if (parsed.pathname === "/sep6/deposit") {
      state.depositCalls += 1;
      state.lastDepositAmount = parsed.searchParams.get("amount") ?? "";
      return json(200, {
        id: "dep-fresh",
        instructions: { organization: { value: "Mock Bank" }, iban: { value: "TR000000000000" } },
      });
    }
    if (parsed.pathname === "/auth" && (!init?.method || init.method === "GET")) {
      return json(200, {
        transaction: WebAuth.buildChallengeTx(anchorServer, parsed.searchParams.get("account") ?? "", HOME, 300, NETWORK, parsed.host),
        network_passphrase: NETWORK,
      });
    }
    if (parsed.pathname === "/auth" && init?.method === "POST") {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ sub: "posted", iat: now, exp: now + 86_400 })).toString("base64url");
      return json(200, { token: `${header}.${payload}.unsigned` });
    }
    throw new Error(`unexpected URL in test: ${url}`);
  };
}

function fakeJwt(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, iat: now, exp: now + 86_400 })).toString("base64url");
  return `${header}.${payload}.unsigned`;
}

async function headers(wallet: string): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await issuePactlyJwt(wallet)}`, "content-type": "application/json" };
}

async function seedHold(result: ReturnType<typeof openTestDatabase>, client: string) {
  const profileId = await seedProviderProfile(result, { isApproved: true, priceAmount: "10000000", depositRateBps: 2000 });
  const slotStartsAt = Math.floor(Date.now() / 1000) + 3600;
  await replaceFutureSlots(result.db, profileId, [slotStartsAt]);
  return holdSlot(result.db, { providerProfileId: profileId, clientWalletAddress: client, slotStartsAt },
    { resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }) });
}

test("a refreshed quote is the price submitted to the anchor; a stale one blocks the deposit", async () => {
  // Fresh case: the client refreshes, confirms the second price, submits it.
  resetCaches();
  const first = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHold(first, client);
    await upsertAnchorJwt(first.db, {
      walletAddress: client, jwt: fakeJwt(client), expiresAt: Date.now() + 60_000, updatedAt: Date.now(),
    });
    const state: RouterState = { depositCalls: 0, price: "21843.51" };
    const router = anchorRouter(Keypair.random(), state);
    const app = createApp(first.db, {
      quoteFetchImpl: router,
      localDepositDeps: { fetchImpl: router, hasTrustline: async () => true },
    });

    // The screen's first quote, then the refresh that supersedes it.
    const oldQuote = (await (await app.request("/quote?amount=2000000")).json()) as {
      amount: string; quotedAt: number; maxAgeSeconds: number; expiresAt: number; fiat: { amount: string; currency: string };
    };
    state.price = "25000.00";
    const freshQuote = (await (await app.request("/quote?amount=2000000&refresh=1")).json()) as typeof oldQuote;
    assert.equal(freshQuote.fiat.amount, "25000.00");
    assert.equal(isQuoteStale(freshQuote), false);

    const response = await app.request(`/bookings/${hold.bookingId}/deposit/local`, {
      method: "POST",
      headers: await headers(client),
      body: JSON.stringify({ quote: freshQuote }),
    });
    assert.equal(response.status, 200);
    assert.equal(state.depositCalls, 1);
    assert.equal(state.lastDepositAmount, "25000.00", "the second price is the one submitted");
  } finally {
    closeDatabase(first);
  }

  // Stale case: a quote whose age has passed is refused before any anchor
  // call, and the client keeps the old figure labelled as old.
  resetCaches();
  const second = openTestDatabase();
  try {
    const client = Keypair.random().publicKey();
    const hold = await seedHold(second, client);
    await upsertAnchorJwt(second.db, {
      walletAddress: client, jwt: fakeJwt(client), expiresAt: Date.now() + 60_000, updatedAt: Date.now(),
    });
    const state: RouterState = { depositCalls: 0, price: "21843.51" };
    const router = anchorRouter(Keypair.random(), state);
    const app = createApp(second.db, {
      quoteFetchImpl: router,
      localDepositDeps: { fetchImpl: router, hasTrustline: async () => true },
    });
    const staleQuote = {
      amount: "2000000",
      quotedAt: Math.floor(Date.now() / 1000) - 120,
      maxAgeSeconds: 60,
      expiresAt: Math.floor(Date.now() / 1000) - 60,
      fiat: { amount: "21843.51", currency: "TRY" },
    };
    const response = await app.request(`/bookings/${hold.bookingId}/deposit/local`, {
      method: "POST",
      headers: await headers(client),
      body: JSON.stringify({ quote: staleQuote }),
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, "QUOTE_STALE");
    assert.equal(state.depositCalls, 0, "a stale quote never reaches the anchor");
  } finally {
    closeDatabase(second);
  }
});
