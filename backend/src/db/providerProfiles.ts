import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { Db, DbOrTx } from "./client.js";
import { categories, providerProfiles } from "./schema.js";

export type ProviderProfileRow = typeof providerProfiles.$inferSelect;

export interface NewProviderProfile {
  id: string;
  walletAddress: string;
  categoryId: string;
  /** Story 3.1: defaults to `''` only for a caller that does not supply
   * one (existing tests) -- a real profile (application decision, demo
   * seed) always sets these three. */
  displayName?: string;
  title?: string;
  location?: string;
  timeZone?: string;
  bio?: string;
  languages?: string[];
  sessionFormat: string;
  sessionLengthMinutes: number;
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
  bufferMinutes?: number;
  minimumNoticeMinutes?: number;
  maxBookingDaysAhead?: number | null;
  isApproved?: boolean;
  /** Issue #2: seed-only. A real profile starts at 0 and only ever moves
   * through the reconciler's own once-only writes -- the demo seeder is the
   * one caller allowed to set an explicit starting value. */
  verifiedSessionCount?: number;
  providerCancellationCount?: number;
  createdAt: number;
}

export async function insertProviderProfile(db: Db, values: NewProviderProfile): Promise<void> {
  await db.insert(providerProfiles).values({
    id: values.id,
    walletAddress: values.walletAddress,
    categoryId: values.categoryId,
    displayName: values.displayName ?? "",
    title: values.title ?? "",
    location: values.location ?? "",
    timeZone: values.timeZone ?? "UTC",
    bio: values.bio ?? "",
    languages: JSON.stringify(values.languages ?? []),
    sessionFormat: values.sessionFormat,
    sessionLengthMinutes: values.sessionLengthMinutes,
    priceAmount: values.priceAmount,
    depositRateBps: values.depositRateBps,
    cancellationWindowHours: values.cancellationWindowHours,
    bufferMinutes: values.bufferMinutes ?? 0,
    minimumNoticeMinutes: values.minimumNoticeMinutes ?? 0,
    maxBookingDaysAhead: values.maxBookingDaysAhead ?? null,
    isApproved: values.isApproved ?? false,
    verifiedSessionCount: values.verifiedSessionCount ?? 0,
    providerCancellationCount: values.providerCancellationCount ?? 0,
    createdAt: values.createdAt,
  });
}

export async function getProviderProfileById(db: Db, id: string): Promise<ProviderProfileRow | undefined> {
  const rows = await db.select().from(providerProfiles).where(eq(providerProfiles.id, id)).limit(1);
  return rows[0];
}

export async function getProviderProfileByWallet(db: Db, walletAddress: string): Promise<ProviderProfileRow | undefined> {
  const rows = await db
    .select()
    .from(providerProfiles)
    .where(eq(providerProfiles.walletAddress, walletAddress))
    .limit(1);
  return rows[0];
}

/** Approved, non-suspended profiles only -- an unapproved profile must
 * appear in neither marketplace listings nor search (PRD Story 4.1 AC4),
 * and a suspended one disappears from both until an admin unsuspends it. */
export async function listApprovedProviderProfiles(db: Db, categoryId?: string): Promise<ProviderProfileRow[]> {
  const conditions = [eq(providerProfiles.isApproved, true), isNull(providerProfiles.suspendedAt)];
  if (categoryId) {
    conditions.push(eq(providerProfiles.categoryId, categoryId));
  }
  return db
    .select()
    .from(providerProfiles)
    .where(and(...conditions));
}

/** Story 3.2's `GET /categories` extension: `providerCount` per category,
 * counting only approved profiles (AC1). One grouped query rather than a
 * per-category count. A category with zero approved providers is simply
 * absent from the map -- callers read it with `?? 0`. */
export async function countApprovedProvidersByCategory(db: Db): Promise<Map<string, number>> {
  const rows = await db
    .select({ categoryId: providerProfiles.categoryId, providerCount: count() })
    .from(providerProfiles)
    .where(and(eq(providerProfiles.isApproved, true), isNull(providerProfiles.suspendedAt)))
    .groupBy(providerProfiles.categoryId);
  return new Map(rows.map((row) => [row.categoryId, row.providerCount]));
}

export interface DiscoverProfileFilters {
  categoryId?: string;
  /** Trimmed, non-empty search text -- matched case-insensitively against
   * display name, title, bio and the provider's own category name, all in
   * one query (Story 3.3 AC1). `%`/`_`/`\` in this text are escaped by
   * {@link likeNeedle} before it ever reaches SQL, so a client's own
   * `%`/`_` is always treated literally (the I/O matrix's "LIKE safety"
   * row), never as a SQL wildcard. */
  query?: string;
  /** Raw `sessionFormat` values straight from the query string -- an
   * unknown value simply matches no row (the I/O matrix's own "Format"
   * row); nothing here validates them against a known list. */
  formats?: string[];
}

/** Escapes `%`, `_` and the escape character itself, then wraps the result
 * in `%...%` -- paired with `ESCAPE '\'` on every LIKE clause built from
 * this, so a search term containing `%` or `_` is always matched literally
 * (the I/O matrix's "LIKE safety" row) rather than acting as a SQL
 * wildcard. */
function likeNeedle(query: string): string {
  const escaped = query.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`);
  return `%${escaped}%`;
}

/** Story 3.3: the Discover list's filtered read, approved profiles only
 * (AC1, same rule Story 3.2 enforced). Text search, category and session
 * format are pushed into one SQL query -- a LIKE-based match is enough at
 * this demo's scale, so no full-text index or search dependency is added
 * (the spec's own "Never" list). Price range and deposit-rate-cap
 * filtering are deliberately *not* done here: `services/profile.ts`
 * applies those on `BigInt`/plain-number comparisons over this function's
 * result, because a native SQL comparison over `price_amount`'s `TEXT`
 * column (an arbitrary-precision integer string, AD-7) cannot be trusted
 * not to misorder two amounts of different digit lengths, and a `CAST` to
 * SQLite's 64-bit `INTEGER` could silently misrepresent an i128-sized
 * value -- the same precision discipline `computeDepositAmount` already
 * follows. */
export async function listApprovedProviderProfilesForDiscover(
  db: Db,
  filters: DiscoverProfileFilters = {},
): Promise<ProviderProfileRow[]> {
  const conditions = [eq(providerProfiles.isApproved, true), isNull(providerProfiles.suspendedAt)];
  if (filters.categoryId) {
    conditions.push(eq(providerProfiles.categoryId, filters.categoryId));
  }
  if (filters.formats && filters.formats.length > 0) {
    conditions.push(inArray(providerProfiles.sessionFormat, filters.formats));
  }
  if (filters.query) {
    const needle = likeNeedle(filters.query);
    const textMatch = or(
      sql`lower(${providerProfiles.displayName}) LIKE ${needle} ESCAPE '\\'`,
      sql`lower(${providerProfiles.title}) LIKE ${needle} ESCAPE '\\'`,
      sql`lower(${providerProfiles.bio}) LIKE ${needle} ESCAPE '\\'`,
      sql`lower(${categories.name}) LIKE ${needle} ESCAPE '\\'`,
    );
    if (textMatch) {
      conditions.push(textMatch);
    }
  }

  // Explicit columns, not `select()`'s default -- a joined select's default
  // shape nests rows by table, and this function's contract is a flat
  // `ProviderProfileRow[]` identical to `listApprovedProviderProfiles`'s.
  const rows = await db
    .select({
      id: providerProfiles.id,
      walletAddress: providerProfiles.walletAddress,
      categoryId: providerProfiles.categoryId,
      displayName: providerProfiles.displayName,
      title: providerProfiles.title,
      location: providerProfiles.location,
      timeZone: providerProfiles.timeZone,
      bio: providerProfiles.bio,
      languages: providerProfiles.languages,
      sessionFormat: providerProfiles.sessionFormat,
      sessionLengthMinutes: providerProfiles.sessionLengthMinutes,
      priceAmount: providerProfiles.priceAmount,
      depositRateBps: providerProfiles.depositRateBps,
      cancellationWindowHours: providerProfiles.cancellationWindowHours,
      minimumNoticeMinutes: providerProfiles.minimumNoticeMinutes,
      maxBookingDaysAhead: providerProfiles.maxBookingDaysAhead,
      bufferMinutes: providerProfiles.bufferMinutes,
      isApproved: providerProfiles.isApproved,
      suspendedAt: providerProfiles.suspendedAt,
      suspensionReason: providerProfiles.suspensionReason,
      bookingsPaused: providerProfiles.bookingsPaused,
      suspendedAt: providerProfiles.suspendedAt,
      suspensionReason: providerProfiles.suspensionReason,
      timezone: providerProfiles.timezone,
      verifiedSessionCount: providerProfiles.verifiedSessionCount,
      providerCancellationCount: providerProfiles.providerCancellationCount,
      createdAt: providerProfiles.createdAt,
    })
    .from(providerProfiles)
    .leftJoin(categories, eq(providerProfiles.categoryId, categories.id))
    .where(and(...conditions));
  return rows;
}

export interface ProviderRulesValues {
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
  /** Issue #36: minimum notice in minutes (0-10080). */
  minimumNoticeMinutes?: number;
  maxBookingDaysAhead?: number | null;
  bufferMinutes: number;
}

/** `services/profile.ts`'s `updateProviderRules` write path -- the one
 * place a signed-in provider's own `priceAmount`/`depositRateBps`/
 * `cancellationWindowHours` are updated after their profile is created.
 * The only other writer of these columns is `seed/demo.ts`'s upsert, which
 * writes its own hardcoded dev-only demo data directly via Drizzle rather
 * than through this function; a real provider's rules only ever change
 * through this path. Throws if `id` matches no row, rather than silently
 * writing nothing (same discipline as `db/bookings.ts`'s state writers). */
export interface ProviderApplicationProfileValues {
  categoryId: string;
  displayName: string;
  title: string;
  location: string;
  bio: string;
  sessionFormat: string;
  sessionLengthMinutes: number;
  priceAmount: string;
  depositRateBps: number;
  cancellationWindowHours: number;
}

/** Story 4.1: a wallet re-applying after a rejection already owns an
 * (unapproved) profile row -- the new application overwrites what it
 * describes and keeps the row unapproved until an admin decides again. */
export async function updateProviderProfileFromApplication(
  db: Db,
  id: string,
  values: ProviderApplicationProfileValues,
): Promise<void> {
  const result = await db
    .update(providerProfiles)
    .set({ ...values, isApproved: false })
    .where(eq(providerProfiles.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No provider profile exists with id "${id}"`);
  }
}

/** Story 4.2: the one write that puts a profile on (or off) the
 * marketplace. */
export async function setProviderProfileApproved(db: Db, id: string, isApproved: boolean): Promise<void> {
  setProviderProfileApprovedSync(db, id, isApproved);
}

export function setProviderProfileApprovedSync(db: DbOrTx, id: string, isApproved: boolean): void {
  const result = db.update(providerProfiles).set({ isApproved }).where(eq(providerProfiles.id, id)).run();
  if (result.changes === 0) {
    throw new TypeError(`No provider profile exists with id "${id}"`);
  }
}

/** Issue #62: the shop's own pause/resume of new bookings. Idempotent --
 * pausing an already-paused shop simply writes `true` again. */
export async function setProviderProfileBookingsPaused(db: Db, id: string, bookingsPaused: boolean): Promise<void> {
  const result = await db.update(providerProfiles).set({ bookingsPaused }).where(eq(providerProfiles.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No provider profile exists with id "${id}"`);
  }
}

/** Issue #64: writes the shop's own IANA timezone. Only ever changes the
 * label a slot is rendered with -- the stored `starts_at` instants are not
 * touched. */
export async function updateProviderProfileTimezone(db: Db, id: string, timezone: string): Promise<void> {
  const result = await db.update(providerProfiles).set({ timezone }).where(eq(providerProfiles.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No provider profile exists with id "${id}"`);
  }
}

export interface ProviderProfileSuspension {
  /** UTC epoch milliseconds, like every `createdAt` in the schema. */
  suspendedAt: number;
  reason: string;
}

export async function setProviderProfileSuspension(
  db: Db,
  id: string,
  suspension: ProviderProfileSuspension | null,
): Promise<void> {
  const result = await db
    .update(providerProfiles)
    .set({
      suspendedAt: suspension?.suspendedAt ?? null,
      suspensionReason: suspension?.reason ?? null,
    })
    .where(eq(providerProfiles.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No provider profile exists with id "${id}"`);
  }
}

/**
 * The approved-provider text-edit write path. Only the fields a shop is
 * allowed to change after approval are in this shape; `price_amount`,
 * `deposit_rate_bps`, `category_id` and `is_approved` are deliberately not
 * accepted, so no caller of this function can change a commercial term by
 * editing its profile copy.
 */
export interface ProviderProfileTextValues {
  title: string;
  bio: string;
  languages: string;
  sessionLengthMinutes: number;
  location: string;
  noticeText: string;
  noticeEndDate: number;
}

export async function updateProviderProfileText(db: Db, id: string, values: ProviderProfileTextValues): Promise<void> {
  const result = await db
    .update(providerProfiles)
    .set({
      title: values.title,
      bio: values.bio,
      languages: values.languages,
      sessionLengthMinutes: values.sessionLengthMinutes,
      location: values.location,
      noticeText: values.noticeText,
      noticeEndDate: values.noticeEndDate,
    })
    .where(eq(providerProfiles.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No provider profile exists with id "${id}"`);
  }
}

export async function updateProviderProfileRules(db: Db, id: string, values: ProviderRulesValues): Promise<void> {
  const updateFields: Record<string, string | number | null> = {
    priceAmount: values.priceAmount,
    depositRateBps: values.depositRateBps,
    cancellationWindowHours: values.cancellationWindowHours,
  };
  // Issue #36: only update minimum notice if provided
  if (values.minimumNoticeMinutes !== undefined) {
    updateFields.minimumNoticeMinutes = values.minimumNoticeMinutes;
  }
  if (values.maxBookingDaysAhead !== undefined) {
    updateFields.maxBookingDaysAhead = values.maxBookingDaysAhead;
  }
  if (values.bufferMinutes !== undefined) {
    updateFields.bufferMinutes = values.bufferMinutes;
  }
  const result = await db
    .update(providerProfiles)
    .set(updateFields)
    .where(eq(providerProfiles.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No provider profile exists with id "${id}"`);
  }
}

/** Issue #62: the shop's own pause on new bookings. */
export async function setProviderProfileBookingsPaused(db: Db, id: string, bookingsPaused: boolean): Promise<void> {
  const result = await db.update(providerProfiles).set({ bookingsPaused }).where(eq(providerProfiles.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No provider profile exists with id "${id}"`);
  }
}

export interface ProviderProfileSuspension {
  /** UTC epoch seconds, like every timestamp column in the schema. */
  suspendedAt: number;
  reason: string;
}

/** Admin suspension's one write. Passing `null` clears both columns
 * (unsuspend); passing a suspension writes the latest reason over whatever
 * was there before, so suspending twice keeps only the newest reason. The
 * profile stays approved either way, so it comes back to discovery on
 * unsuspend without a second admin approval. */
export async function setProviderProfileSuspension(
  db: Db,
  id: string,
  suspension: ProviderProfileSuspension | null,
): Promise<void> {
  const result = await db
    .update(providerProfiles)
    .set({
      suspendedAt: suspension?.suspendedAt ?? null,
      suspensionReason: suspension?.reason ?? null,
    })
    .where(eq(providerProfiles.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No provider profile exists with id "${id}"`);
  }
}

/** Issue #64: writes the shop's own IANA timezone. Only ever changes the
 * label a slot is rendered with -- the stored `starts_at` instants are not
 * touched. */
export async function updateProviderProfileTimezone(db: Db, id: string, timezone: string): Promise<void> {
  const result = await db.update(providerProfiles).set({ timezone }).where(eq(providerProfiles.id, id));
  if (result.changes === 0) {
    throw new TypeError(`No provider profile exists with id "${id}"`);
  }
}
