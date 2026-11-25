import type { Context, Env, Hono, MiddlewareHandler } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

/**
 * Per-IP request limits for the public discovery reads and the signed-in
 * booking routes.
 *
 * Fixed-window counters held in process memory. That is deliberate: there
 * is no shared cache in this deployment, and a per-instance limit is enough
 * to stop one client from pinning an instance. On Vercel each warm function
 * instance keeps its own counts (the store is module-level, so it outlives
 * the per-request `createApp`), which means the effective ceiling across a
 * fleet is `max x instances`, not `max`.
 */

export interface RateLimitRule {
  /** Requests allowed per window, per IP. */
  max: number;
  windowSeconds: number;
}

export interface RateLimitSettings {
  /** `GET /categories`, `GET /providers`, `GET /providers/suggest`,
   * `GET /providers/:id` (see {@link DISCOVERY_PATHS}). */
  discovery: RateLimitRule;
  /** Every `/bookings/...` route and `GET /me/bookings`. Its own bucket,
   * so browsing never eats into booking actions or the reverse. */
  booking: RateLimitRule;
  /** Read the client IP from `X-Forwarded-For` / `X-Real-IP`. Only safe
   * behind a proxy that overwrites those headers (Vercel does); otherwise
   * any client could pick a fresh IP per request. */
  trustProxy: boolean;
  /** Tests inject their own store and clock; production shares
   * {@link defaultRateLimitStore}. */
  store?: RateLimitStore;
  now?: () => number;
}

interface Window {
  count: number;
  resetAtMs: number;
}

/** Counts per `bucket:ip`. Expired windows are swept lazily once the map
 * grows, so a scraper rotating IPs cannot grow it without bound for long. */
export class RateLimitStore {
  private readonly windows = new Map<string, Window>();
  private static readonly SWEEP_THRESHOLD = 10_000;

  hit(key: string, windowMs: number, nowMs: number): Window {
    let window = this.windows.get(key);
    if (!window || window.resetAtMs <= nowMs) {
      if (this.windows.size >= RateLimitStore.SWEEP_THRESHOLD) {
        this.sweep(nowMs);
      }
      window = { count: 0, resetAtMs: nowMs + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    return window;
  }

  private sweep(nowMs: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAtMs <= nowMs) this.windows.delete(key);
    }
  }
}

export const defaultRateLimitStore = new RateLimitStore();

/** Paths each limit covers. Discovery is GET-only and uses exact Hono
 * patterns, so a signed-in `/providers/:id/save` or `/providers/:id/saved`
 * never counts against it. `/providers/:id` also matches
 * `/providers/suggest`; listing both would count that call twice.
 * `/health` is in neither. */
export const DISCOVERY_PATHS = ["/categories", "/providers", "/providers/:id"] as const;
export const BOOKING_PATHS = ["/bookings/*", "/me/bookings"] as const;

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
    const realIp = c.req.header("x-real-ip")?.trim();
    if (realIp) return realIp;
  }
  try {
    const address = getConnInfo(c).remote.address;
    if (address) return address;
  } catch {
    // No Node socket behind this request (e.g. `app.request()` in a test,
    // or a fetch-only adapter): fall through to the shared bucket.
  }
  return "unknown";
}

function rateLimit(
  bucket: string,
  rule: RateLimitRule,
  settings: RateLimitSettings,
): MiddlewareHandler {
  const store = settings.store ?? defaultRateLimitStore;
  const now = settings.now ?? Date.now;
  const windowMs = rule.windowSeconds * 1000;

  return async (c, next) => {
    const nowMs = now();
    const key = `${bucket}:${clientIp(c, settings.trustProxy)}`;
    const window = store.hit(key, windowMs, nowMs);
    if (window.count > rule.max) {
      const retryAfter = Math.max(1, Math.ceil((window.resetAtMs - nowMs) / 1000));
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { code: "RATE_LIMITED", message: "Too many requests. Please wait a moment and try again." },
        429,
      );
    }
    await next();
  };
}

/** Registers both limits on `app`. Must run before the routes are
 * registered: Hono runs matching handlers in registration order, and the
 * limit has to sit in front of `requirePactlyAuth` so unauthenticated
 * hammering of booking routes is counted too. */
export function applyRateLimits<E extends Env>(app: Hono<E>, settings: RateLimitSettings): void {
  const discovery = rateLimit("discovery", settings.discovery, settings);
  for (const path of DISCOVERY_PATHS) {
    app.on("GET", path, discovery);
  }
  const booking = rateLimit("booking", settings.booking, settings);
  for (const path of BOOKING_PATHS) {
    app.use(path, booking);
  }
}
