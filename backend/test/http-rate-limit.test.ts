/**
 * Per-IP rate limits (`src/http/rateLimit.ts`). Drives the same
 * `applyRateLimits` that `createApp` calls, mounted on a stub app whose
 * routes sit at the real paths, so the path coverage (what counts, what
 * doesn't) is exercised through Hono's real router. Each test gets its own
 * store and clock; nothing is shared and nothing sleeps.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

import { config } from "../src/config.js";
import { RateLimitStore, applyRateLimits, type RateLimitSettings } from "../src/http/rateLimit.js";

function stubApp(overrides: Partial<RateLimitSettings> = {}) {
  let nowMs = 1_000_000;
  const app = new Hono();
  applyRateLimits(app, {
    discovery: { max: 3, windowSeconds: 60 },
    booking: { max: 5, windowSeconds: 60 },
    trustProxy: true,
    store: new RateLimitStore(),
    now: () => nowMs,
    ...overrides,
  });
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/categories", (c) => c.json({ ok: true }));
  app.get("/providers", (c) => c.json({ ok: true }));
  app.get("/providers/suggest", (c) => c.json({ ok: true }));
  app.get("/providers/:id", (c) => c.json({ ok: true }));
  app.get("/providers/:id/saved", (c) => c.json({ ok: true }));
  app.post("/providers/:id/save", (c) => c.json({ ok: true }, 201));
  app.post("/bookings/hold", (c) => c.json({ ok: true }));
  app.get("/bookings/:id", (c) => c.json({ ok: true }));
  app.get("/me/bookings", (c) => c.json({ ok: true }));
  return { app, advance: (ms: number) => (nowMs += ms) };
}

function from(ip: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), "x-forwarded-for": ip } };
}

test("discovery: the call after the limit 429s with Retry-After and the error envelope; another IP still succeeds", async () => {
  const { app } = stubApp();
  for (let i = 0; i < 3; i++) {
    assert.equal((await app.request("/providers?q=cut", from("203.0.113.1"))).status, 200);
  }

  const limited = await app.request("/providers?q=cut", from("203.0.113.1"));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "60");
  assert.deepEqual(await limited.json(), {
    code: "RATE_LIMITED",
    message: "Too many requests. Please wait a moment and try again.",
  });

  assert.equal((await app.request("/providers?q=cut", from("203.0.113.2"))).status, 200);
});

test("discovery: search, suggest, categories and profile reads share one bucket per IP", async () => {
  const { app } = stubApp();
  const ip = "203.0.113.3";
  assert.equal((await app.request("/categories", from(ip))).status, 200);
  assert.equal((await app.request("/providers/suggest", from(ip))).status, 200);
  assert.equal((await app.request("/providers/shop-1", from(ip))).status, 200);
  // Fourth read: over a max of 3. Also proves /providers/suggest counted
  // once, not twice (it matches both `/providers/suggest` and `/providers/:id`).
  assert.equal((await app.request("/providers", from(ip))).status, 429);
});

test("/health is never limited, even once discovery is exhausted", async () => {
  const { app } = stubApp();
  const ip = "203.0.113.4";
  for (let i = 0; i < 4; i++) await app.request("/providers", from(ip));
  assert.equal((await app.request("/providers", from(ip))).status, 429);
  for (let i = 0; i < 10; i++) {
    assert.equal((await app.request("/health", from(ip))).status, 200);
  }
});

test("signed-in shop routes under /providers/:id/... are not discovery reads", async () => {
  const { app } = stubApp();
  const ip = "203.0.113.5";
  for (let i = 0; i < 5; i++) {
    assert.equal((await app.request("/providers/shop-1/saved", from(ip))).status, 200);
    assert.equal((await app.request("/providers/shop-1/save", from(ip, { method: "POST" }))).status, 201);
  }
  assert.equal((await app.request("/providers", from(ip))).status, 200);
});

test("booking routes have their own, higher limit, independent of discovery", async () => {
  const { app } = stubApp();
  const ip = "203.0.113.6";
  for (let i = 0; i < 4; i++) await app.request("/providers", from(ip));
  assert.equal((await app.request("/providers", from(ip))).status, 429);

  // Discovery exhausted; booking still has all 5 (> discovery's 3).
  assert.equal((await app.request("/bookings/hold", from(ip, { method: "POST" }))).status, 200);
  assert.equal((await app.request("/bookings/b-1", from(ip))).status, 200);
  assert.equal((await app.request("/me/bookings", from(ip))).status, 200);
  assert.equal((await app.request("/bookings/b-1", from(ip))).status, 200);
  assert.equal((await app.request("/bookings/b-1", from(ip))).status, 200);
  const limited = await app.request("/bookings/b-1", from(ip));
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { code: string }).code, "RATE_LIMITED");
});

test("the window resets: Retry-After counts down and the IP is let back in", async () => {
  const { app, advance } = stubApp();
  const ip = "203.0.113.7";
  for (let i = 0; i < 3; i++) await app.request("/providers", from(ip));
  advance(45_500);
  const limited = await app.request("/providers", from(ip));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "15");
  advance(15_000);
  assert.equal((await app.request("/providers", from(ip))).status, 200);
});

test("without trustProxy, X-Forwarded-For cannot be used to pick a fresh bucket", async () => {
  const { app } = stubApp({ trustProxy: false });
  for (let i = 0; i < 3; i++) {
    assert.equal((await app.request("/providers", from(`198.51.100.${i}`))).status, 200);
  }
  assert.equal((await app.request("/providers", from("198.51.100.99"))).status, 429);
});

test("config exposes documented defaults", () => {
  assert.equal(config.rateLimitWindowSeconds, 60);
  assert.equal(config.rateLimitDiscoveryMax, 120);
  assert.equal(config.rateLimitBookingMax, 300);
  assert.ok(config.rateLimitBookingMax > config.rateLimitDiscoveryMax);
});
