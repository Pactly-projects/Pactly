import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";

import type { Db, DbOrTx } from "./client.js";
import { adminDecisionAudit, type AdminDecisionAction } from "./schema.js";

export interface NewAdminDecisionAudit {
  adminWallet: string;
  action: AdminDecisionAction;
  targetId: string;
  reason: string | null;
  /** UTC epoch milliseconds. */
  decidedAt: number;
}

export type AdminDecisionAuditRow = typeof adminDecisionAudit.$inferSelect;

export function insertAdminDecisionAuditSync(db: DbOrTx, values: NewAdminDecisionAudit): string {
  const id = randomUUID();
  db.insert(adminDecisionAudit)
    .values({
      id,
      adminWallet: values.adminWallet,
      action: values.action,
      targetId: values.targetId,
      reason: values.reason,
      decidedAt: values.decidedAt,
    })
    .run();
  return id;
}

export async function listAdminDecisionAudit(db: Db, limit = 100): Promise<AdminDecisionAuditRow[]> {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
  return db
    .select()
    .from(adminDecisionAudit)
    .orderBy(desc(adminDecisionAudit.decidedAt), desc(adminDecisionAudit.id))
    .limit(safeLimit);
}

export async function countAdminDecisionAudit(db: Db): Promise<number> {
  const rows = await db.select().from(adminDecisionAudit);
  return rows.length;
}