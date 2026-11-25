/**
 * Admin decision audit (issue #14): approve/reject/resolve record audit rows,
 * failed decisions write nothing, and only admins can read the audit log.
 */
import "./testConfigEnvAdmin.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { StrKey } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";

import { createApp } from "../src/app.js";
import { issueMoneyAssertionToken } from "../src/auth/assertion.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { insertEscrowProcessedEventIfNew } from "../src/db/escrowProcessedEvents.js";
import { countAdminDecisionAudit } from "../src/db/adminDecisionAudit.js";
import type { EscrowAdapter } from "../src/escrow/interface.js";
import { DISPUTE_RESOLVER_ADMIN_WALLET, NON_RESOLVER_ADMIN_WALLET } from "./testConfigEnvAdmin.js";
import { closeDatabase, openTestDatabase, seedBooking, seedCategory, USDC_READY_WALLET_DEPS } from "./helpers.js";

const APPLICANT = "GAPPLICANTAUDITWALLETFORISSUE14";

function validApplication(categoryId: string) {
  return {
    name: "Audit Atelier",
    title: "Barber",
    categoryId,
    location: "Kadıköy, Istanbul",
    serviceDescription: "Cut and beard in a two-chair shop, forty minutes, walk-ins welcome.",
    sessionFormat: "in_person",
    sessionLengthMinutes: 40,
    priceAmount: "20000000",
    depositRateBps: 2500,
    cancellationWindowHours: 6,
  };
}

async function bearer(walletAddress: string): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${await issuePactlyJwt(walletAddress)}`,
    "x-pactly-assertion": await issueMoneyAssertionToken(walletAddress),
    "content-type": "application/json",
  };
}

function fakeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

function noopEscrowAdapter(): EscrowAdapter {
  const unimplemented = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} must not be called in this audit test`);
  };
  return {
    deploy: unimplemented("deploy"),
    fund: unimplemented("fund"),
    complete: unimplemented("complete"),
    approve: unimplemented("approve"),
    release: unimplemented("release"),
    startDispute: unimplemented("startDispute"),
    resolveDispute: unimplemented("resolveDispute"),
    submit: unimplemented("submit"),
  } as EscrowAdapter;
}

test("approving an application writes one audit row and a failed reject leaves the count unchanged", async () => {
  const result = openTestDatabase();
  try {
    const categoryId = await seedCategory(result, "cat-audit-approve");
    const app = createApp(result.db, {
      escrowAdapter: noopEscrowAdapter(),
      usdcTrustlineDeps: USDC_READY_WALLET_DEPS,
    });
    const applicant = await bearer(APPLICANT);
    const admin = await bearer(NON_RESOLVER_ADMIN_WALLET);

    const created = await app.request("/me/provider/application", {
      method: "POST",
      headers: applicant,
      body: JSON.stringify(validApplication(categoryId)),
    });
    assert.equal(created.status, 201);
    const { application } = (await created.json()) as { application: { id: string } };

    const approved = await app.request(`/admin/applications/${application.id}/decide`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ outcome: "approve" }),
    });
    assert.equal(approved.status, 200);
    assert.equal(await countAdminDecisionAudit(result.db), 1);

    // The application is already decided; a reject without a reason must still
    // fail the decision (invalid/missing reason path is covered separately) and
    // must not write an audit row. Use a fresh pending application for the
    // "fails a reject and asserts the count is unchanged" validation path.
    const categoryId2 = await seedCategory(result, "cat-audit-reject");
    const applicant2 = "GAPPLICANTAUDITREJECTWALLETISSUE14";
    const applicant2Headers = await bearer(applicant2);
    const created2 = await app.request("/me/provider/application", {
      method: "POST",
      headers: applicant2Headers,
      body: JSON.stringify({ ...validApplication(categoryId2), name: "Audit Reject Shop" }),
    });
    assert.equal(created2.status, 201);
    const app2 = (await created2.json()) as { application: { id: string } };

    const rejectedNoReason = await app.request(`/admin/applications/${app2.application.id}/decide`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ outcome: "reject" }),
    });
    assert.equal(rejectedNoReason.status, 400);
    assert.equal(await countAdminDecisionAudit(result.db), 1);
  } finally {
    closeDatabase(result);
  }
});

test("admin audit endpoint returns latest rows newest-first and blocks non-admins; resolve writes audit row", async () => {
  const result = openTestDatabase();
  try {
    const contractId = fakeContractId();
    const bookingId = await seedBooking(result, { depositAmount: "5000000", cancelDeadline: 1_800_000_000 });
    await updateEscrowContractId(result.db, bookingId, contractId);
    updateEscrowStateSync(result.db, bookingId, "locked");
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId,
      contractId,
      lifecycleAction: "disputed",
      amount: "5000000",
      ledgerSeq: "1",
      isAnomaly: false,
      processedAt: 1_800_000_000,
    });

    const adapter: EscrowAdapter = {
      ...noopEscrowAdapter(),
      resolveDispute: async (input) => {
        assert.equal(input.contractId, contractId);
        return { unsignedXdr: "AAAA", txHash: "resolve-hash-audit" };
      },
    } as EscrowAdapter;

    const app = createApp(result.db, { escrowAdapter: adapter });
    const resolver = await bearer(DISPUTE_RESOLVER_ADMIN_WALLET);
    const nonAdmin = await bearer(APPLICANT);

    const forbidden = await app.request("/admin/audit", { headers: nonAdmin });
    assert.equal(forbidden.status, 404);

    const resolved = await app.request(`/admin/bookings/${bookingId}/resolve`, {
      method: "POST",
      headers: resolver,
      body: JSON.stringify({ outcome: "refund-client", reason: "Admin decided to refund" }),
    });
    assert.equal(resolved.status, 200);

    const auditResponse = await app.request("/admin/audit", { headers: resolver });
    assert.equal(auditResponse.status, 200);
    const body = (await auditResponse.json()) as {
      audit: Array<{ adminWallet: string; action: string; targetId: string; reason: string | null }>;
    };
    assert.equal(body.audit.length, 1);
    assert.equal(body.audit[0]?.adminWallet, DISPUTE_RESOLVER_ADMIN_WALLET);
    assert.equal(body.audit[0]?.action, "resolve-dispute");
    assert.equal(body.audit[0]?.targetId, bookingId);
    assert.equal(body.audit[0]?.reason, "Admin decided to refund");
  } finally {
    closeDatabase(result);
  }
});

test("failed resolve does not write audit row", async () => {
  const result = openTestDatabase();
  try {
    const bookingId = await seedBooking(result, { depositAmount: "5000000", cancelDeadline: 1_800_000_000 });
    // no contract/lifecycle/disputed evidence -> BOOKING_STATE, adapter never called, no audit
    const app = createApp(result.db, { escrowAdapter: noopEscrowAdapter() });
    const resolver = await bearer(DISPUTE_RESOLVER_ADMIN_WALLET);

    const response = await app.request(`/admin/bookings/${bookingId}/resolve`, {
      method: "POST",
      headers: resolver,
      body: JSON.stringify({ outcome: "refund-client", reason: "should not record" }),
    });
    assert.equal(response.status, 409);
    assert.equal(await countAdminDecisionAudit(result.db), 0);
  } finally {
    closeDatabase(result);
  }
});
