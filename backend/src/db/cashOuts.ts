/**
 * Issue #1 (Story 2.3): the only place SQL touches `cash_outs`. Every read
 * is scoped by the caller's own wallet where ownership matters, so a
 * provider can never address another provider's row -- the service turns a
 * missing row into the same `404 CASH_OUT_NOT_FOUND` either way.
 */
import { and, desc, eq } from "drizzle-orm";

import type { Db } from "./client.js";
import { cashOuts, type CashOutState } from "./schema.js";

export type CashOutRow = typeof cashOuts.$inferSelect;

export interface NewCashOut {
  id: string;
  providerWalletAddress: string;
  anchorTransactionId: string;
  treasuryAccount: string;
  memo: string;
  memoType: string;
  amount: string;
  fiatAmount: string;
  fiatCurrency: string;
  anchorStatus: string;
  status: CashOutState;
  moreInfoUrl?: string | null;
  paymentBuiltHash?: string | null;
  createdAt: number;
  updatedAt: number;
}

export async function insertCashOut(db: Db, values: NewCashOut): Promise<void> {
  await db.insert(cashOuts).values(values);
}

export async function getCashOutById(db: Db, id: string): Promise<CashOutRow | undefined> {
  const rows = await db.select().from(cashOuts).where(eq(cashOuts.id, id)).limit(1);
  return rows[0];
}

export async function getCashOutForProvider(
  db: Db,
  id: string,
  providerWalletAddress: string,
): Promise<CashOutRow | undefined> {
  const rows = await db
    .select()
    .from(cashOuts)
    .where(and(eq(cashOuts.id, id), eq(cashOuts.providerWalletAddress, providerWalletAddress)))
    .limit(1);
  return rows[0];
}

export interface CashOutPatch {
  anchorStatus?: string;
  status?: CashOutState;
  reason?: string | null;
  moreInfoUrl?: string | null;
  paymentBuiltHash?: string | null;
  paymentTxHash?: string | null;
  sentAt?: number | null;
  updatedAt: number;
}

export async function updateCashOut(db: Db, id: string, patch: CashOutPatch): Promise<void> {
  await db.update(cashOuts).set(patch).where(eq(cashOuts.id, id));
}

/** Newest first, by the panel's own `createdAt` ordering. */
export async function listCashOutsForProvider(db: Db, providerWalletAddress: string): Promise<CashOutRow[]> {
  return db
    .select()
    .from(cashOuts)
    .where(eq(cashOuts.providerWalletAddress, providerWalletAddress))
    .orderBy(desc(cashOuts.createdAt), desc(cashOuts.id));
}
