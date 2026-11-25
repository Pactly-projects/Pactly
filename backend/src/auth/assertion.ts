/**
 * Fresh passkey assertions for money actions (issue #13).
 *
 * A Pactly session proves *who* is calling, not that the person is still
 * there: a token signed in the morning would otherwise still build, fund,
 * release or dispute an escrow in the evening. Every money-moving build
 * route therefore asks for a new WebAuthn assertion, even while the session
 * JWT is valid, and only accepts it for five minutes.
 *
 * Two layers, both required:
 *   1. the browser runs `navigator.credentials.get()` against the caller's
 *      own registered passkey (`beginMoneyAssertion` / `finishMoneyAssertion`
 *      store and consume the ceremony challenge exactly like sign-in's);
 *   2. `finishMoneyAssertion` mints a short-lived assertion token naming the
 *      wallet, and {@link requireFreshAssertion} refuses a build route
 *      without one. The token's `sub` is compared with the route's own
 *      authenticated wallet, so an assertion for one wallet can never
 *      authorize another wallet's action.
 *
 * The token is a separate JWT audience from the session token: possessing a
 * session JWT (or a stolen one) is not enough to mint it, and it is never
 * returned by `/auth/*` except from the verify step that follows a real
 * authenticator ceremony.
 */
import { randomUUID } from "node:crypto";
import { generateAuthenticationOptions, verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { SignJWT, jwtVerify } from "jose";
import type { Context, Next } from "hono";

import { config } from "../config.js";
import type { Db } from "../db/client.js";
import {
  consumeWebauthnChallenge,
  getPasskeyCredentialById,
  getUserById,
  getUserByWalletAddress,
  insertWebauthnChallenge,
  listPasskeyCredentialsByUserId,
  updatePasskeyCounter,
} from "../db/users.js";
import { PasskeyInvalidError, PasskeyUnknownError } from "./errors.js";
import type { PasskeyDeps } from "./passkey.js";
import type { Variables } from "../app.js";

/** How long a confirmed assertion authorizes a money action. Five minutes
 * is deliberately short: it covers one build -> sign -> submit sequence,
 * never an afternoon's browsing. */
export const MONEY_ASSERTION_TTL_SECONDS = 5 * 60;

/** The ceremony's own challenge lifetime -- the same generous window
 * sign-in uses between `/options` and `/verify`. */
const ASSERTION_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/** Where the browser puts the assertion token on a money-action request. */
export const ASSERTION_HEADER = "x-pactly-assertion";

/** A JWT audience no session token carries, so a Pactly session JWT can
 * never be replayed as a money-action assertion (or vice versa). */
const ASSERTION_AUDIENCE = "pactly-money-action";

/** The wallet has no passkey credential on file -- a session issued before
 * the credential was recorded, or a legacy wallet-login JWT. The frontend
 * reconnects once to register it, then asks again. */
export class PasskeyNotRegisteredError extends Error {
  constructor(message = "This account has no passkey on file yet. Sign in again to register one.") {
    super(message);
    this.name = "PasskeyNotRegisteredError";
  }
}

/** Missing, expired, tampered, or older than five minutes -- all the same
 * rejection so none of them is a validation oracle. */
export class MoneyAssertionError extends Error {
  constructor(message = "Your passkey confirmation has expired. Confirm again to continue.") {
    super(message);
    this.name = "MoneyAssertionError";
  }
}

function jwtSecret(): Uint8Array {
  return new TextEncoder().encode(config.pactlyAuthSigningSecret);
}

function nowMs(deps: PasskeyDeps): number {
  return deps.now ? deps.now() : Date.now();
}

function parseTransports(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export interface MoneyAssertionOptionsResult {
  assertionId: string;
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
}

/**
 * Step one of a money action's confirmation: options for
 * `navigator.credentials.get()`, restricted to the caller's own registered
 * credentials. The ceremony id is stored server-side, bound to this user.
 */
export async function beginMoneyAssertion(
  db: Db,
  walletAddress: string,
  deps: PasskeyDeps = {},
): Promise<MoneyAssertionOptionsResult> {
  const user = await getUserByWalletAddress(db, walletAddress);
  if (!user) {
    throw new PasskeyNotRegisteredError();
  }
  const credentials = await listPasskeyCredentialsByUserId(db, user.id);
  if (credentials.length === 0) {
    throw new PasskeyNotRegisteredError();
  }
  const options = await generateAuthenticationOptions({
    rpID: config.passkeyRpId,
    userVerification: "preferred",
    allowCredentials: credentials.map((credential) => ({
      id: credential.id,
      transports: parseTransports(credential.transports) as never,
    })),
  });
  const assertionId = randomUUID();
  await insertWebauthnChallenge(db, {
    id: assertionId,
    // A money confirmation is an authentication assertion: it reuses the
    // `login` challenge kind so the challenge stays scoped to a credential
    // the caller actually registered, without widening the schema's kind
    // enum. The random UUID id keeps it distinct from any login ceremony.
    kind: "login",
    challenge: options.challenge,
    userId: user.id,
    expiresAt: nowMs(deps) + ASSERTION_CHALLENGE_TTL_MS,
  });
  return { assertionId, options };
}

export interface FinishedMoneyAssertion {
  assertionToken: string;
}

/**
 * Step two: verifies the authenticator's assertion against the stored
 * challenge and the credential's own COSE public key, advances the counter,
 * and mints the five-minute token the money route will accept. The user is
 * resolved from the challenge (not from the request body), and the wallet
 * is re-checked against the caller's session -- an assertion can only ever
 * be for the wallet that owns the action.
 */
export async function finishMoneyAssertion(
  db: Db,
  walletAddress: string,
  input: { assertionId: string; response: unknown },
  deps: PasskeyDeps = {},
): Promise<FinishedMoneyAssertion> {
  const response = input.response as AuthenticationResponseJSON | undefined;
  const credentialId = typeof response?.id === "string" ? response.id : undefined;
  if (!credentialId) {
    throw new PasskeyInvalidError();
  }

  const challenge = await consumeWebauthnChallenge(db, input.assertionId, "login");
  if (!challenge || challenge.expiresAt <= nowMs(deps) || !challenge.userId) {
    throw new PasskeyInvalidError();
  }
  const user = await getUserById(db, challenge.userId);
  if (!user || user.walletAddress !== walletAddress) {
    throw new PasskeyInvalidError();
  }

  const credential = await getPasskeyCredentialById(db, credentialId);
  if (!credential) {
    throw new PasskeyUnknownError();
  }
  if (credential.userId !== user.id) {
    // A credential that exists but belongs to someone else is not an
    // "unknown passkey" -- it is a forgery attempt, refused as invalid.
    throw new PasskeyInvalidError();
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.passkeyRpOrigins,
      expectedRPID: config.passkeyRpId,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(Buffer.from(credential.publicKey, "base64url")),
        counter: credential.counter,
        transports: parseTransports(credential.transports),
      },
      requireUserVerification: false,
    });
  } catch {
    throw new PasskeyInvalidError();
  }
  if (!verification.verified) {
    throw new PasskeyInvalidError();
  }

  await updatePasskeyCounter(db, credential.id, verification.authenticationInfo.newCounter);
  return { assertionToken: await issueMoneyAssertionToken(walletAddress, { now: new Date(nowMs(deps)) }) };
}

export interface IssueMoneyAssertionOptions {
  /** Injectable clock, mirroring `issuePactlyJwt` -- tests mint a stale or
   * future-skewed assertion without waiting. */
  now?: Date;
}

/** Mints the short-lived token a money route accepts. `iat` is the moment
 * the authenticator confirmed; `exp` mirrors it plus the TTL. */
export async function issueMoneyAssertionToken(
  walletAddress: string,
  options: IssueMoneyAssertionOptions = {},
): Promise<string> {
  const issuedAt = options.now ?? new Date();
  const expiresAt = new Date(issuedAt.getTime() + MONEY_ASSERTION_TTL_SECONDS * 1000);
  return new SignJWT({ sub: walletAddress, aud: ASSERTION_AUDIENCE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
    .setExpirationTime(expiresAt)
    .sign(jwtSecret());
}

export interface VerifiedMoneyAssertion {
  walletAddress: string;
}

/**
 * Verifies an assertion token: correct audience, a wallet in `sub`, and an
 * issue time no more than five minutes from the server's clock in either
 * direction (a client clock more than five minutes ahead is rejected too,
 * rather than trusted for a later replay window).
 */
export async function verifyMoneyAssertionToken(
  token: string,
  options: IssueMoneyAssertionOptions = {},
): Promise<VerifiedMoneyAssertion> {
  if (!token) {
    throw new MoneyAssertionError();
  }
  const now = options.now ?? new Date();
  try {
    const { payload } = await jwtVerify(token, jwtSecret(), {
      algorithms: ["HS256"],
      audience: ASSERTION_AUDIENCE,
      currentDate: now,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0 || typeof payload.iat !== "number") {
      throw new MoneyAssertionError();
    }
    const skewMs = Math.abs(now.getTime() - payload.iat * 1000);
    if (skewMs > MONEY_ASSERTION_TTL_SECONDS * 1000) {
      throw new MoneyAssertionError();
    }
    return { walletAddress: payload.sub };
  } catch (error) {
    if (error instanceof MoneyAssertionError) {
      throw error;
    }
    throw new MoneyAssertionError();
  }
}

/**
 * Route middleware: requires an `x-pactly-assertion` token that names the
 * same wallet `requirePactlyAuth` already authenticated. Runs after that
 * middleware, never before. `403`, not `401`, on purpose -- a missing or
 * stale confirmation is not an expired session and must never sign the user
 * out; it asks them for their passkey again.
 */
export async function requireFreshAssertion(c: Context<{ Variables: Variables }>, next: Next) {
  const walletAddress = c.get("walletAddress");
  const token = c.req.header(ASSERTION_HEADER);
  if (!token) {
    return c.json({ code: "ASSERTION_REQUIRED", message: "Confirm this action with your passkey." }, 403);
  }
  try {
    const verified = await verifyMoneyAssertionToken(token);
    if (verified.walletAddress !== walletAddress) {
      throw new MoneyAssertionError();
    }
  } catch {
    return c.json(
      { code: "ASSERTION_STALE", message: "Your passkey confirmation has expired. Confirm again to continue." },
      403,
    );
  }
  await next();
}
