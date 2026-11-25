/**
 * Issues #146, #147 and #148 at the HTTP boundary.
 *
 * - #146: `GET /me/provider/bookings` (the shop), `GET /bookings/:id` (the
 *   client) and `GET /admin/disputes` (an admin) carry the answers; the
 *   public proof page and discovery never do.
 * - #147: `PUT /bookings/:id/intake` edits a hold and refuses a locked one.
 * - #148: `POST /bookings/:id/lock` refuses `409 INTAKE_INCOMPLETE` naming
 *   the question, and the hold is still there afterwards.
 */
import "./testConfigEnvAdmin.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@stellar/stellar-sdk";

import { createApp } from "../src/app.js";
import { issuePactlyJwt } from "../src/auth/challenge.js";
import { config } from "../src/config.js";
import { replaceFutureSlots } from "../src/db/availabilitySlots.js";
import { getBookingById, updateEscrowContractId, updateEscrowStateSync } from "../src/db/bookings.js";
import { insertEscrowProcessedEventIfNew } from "../src/db/escrowProcessedEvents.js";
import { setProviderProfileIntakeQuestions } from "../src/db/providerProfiles.js";
import { holdSlot } from "../src/services/booking.js";
import { closeDatabase, openTestDatabase, seedProviderProfile } from "./helpers.js";

const FAKE_USDC_DEPS = {
  resolveUsdcAsset: async () => ({ contractId: "CUSDCFAKE00000000000000000000000000000000000000000" }),
};
const CONTRACT_ID = "CFAKECONTRACT0000000000000000000000000000000000000";
const SECRET_ANSWER = "Severe peanut allergy";

async function authHeader(walletAddress: string): Promise<Record<string, string>> {
  const token = await issuePactlyJwt(walletAddress);
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function seedHold(
  result: ReturnType<typeof openTestDatabase>,
  intakeAnswers: Record<string, string> | undefined = { "q-allergies": SECRET_ANSWER },
) {
  const providerWalletAddress = Keypair.random().publicKey();
  const clientWalletAddress = Keypair.random().publicKey();
  const providerProfileId = await seedProviderProfile(result, { isApproved: true, walletAddress: providerWalletAddress });
  await setProviderProfileIntakeQuestions(
    result.db,
    providerProfileId,
    JSON.stringify([
      { id: "q-allergies", label: "Any allergies?", required: true },
      { id: "q-name", label: "Preferred name", required: false },
    ]),
  );
  const slotStartsAt = Math.floor(Date.now() / 1000) + 3 * 24 * 3600;
  await replaceFutureSlots(result.db, providerProfileId, [slotStartsAt, slotStartsAt + 3600]);
  const hold = await holdSlot(
    result.db,
    { providerProfileId, clientWalletAddress, slotStartsAt, intakeAnswers },
    FAKE_USDC_DEPS,
  );
  return { bookingId: hold.bookingId, providerProfileId, providerWalletAddress, clientWalletAddress };
}

// ---------------------------------------------------------------------------
// #146
// ---------------------------------------------------------------------------

test("#146: the shop's bookings list includes the answers, with a blank answer still naming its question", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, providerWalletAddress } = await seedHold(result);
    const app = createApp(result.db);
    const response = await app.request("/me/provider/bookings", { headers: await authHeader(providerWalletAddress) });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { bookings: { id: string; intakeAnswers: { label: string; answer: string }[] }[] };
    const item = body.bookings.find((booking) => booking.id === bookingId);
    assert.deepEqual(
      item?.intakeAnswers.map(({ label, answer }) => ({ label, answer })),
      [
        { label: "Any allergies?", answer: SECRET_ANSWER },
        { label: "Preferred name", answer: "" },
      ],
    );
  } finally {
    closeDatabase(result);
  }
});

test("#146: the client reads their own answers on GET /bookings/:id; another client gets 404", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedHold(result);
    const app = createApp(result.db);

    const own = await app.request(`/bookings/${bookingId}`, { headers: await authHeader(clientWalletAddress) });
    assert.equal(own.status, 200);
    const body = (await own.json()) as { intakeAnswers: { answer: string }[] };
    assert.equal(body.intakeAnswers[0]?.answer, SECRET_ANSWER);

    const other = await app.request(`/bookings/${bookingId}`, { headers: await authHeader(Keypair.random().publicKey()) });
    assert.equal(other.status, 404);
    assert.ok(!(await other.text()).includes(SECRET_ANSWER));
  } finally {
    closeDatabase(result);
  }
});

test("#146: the public proof page omits the answers", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId } = await seedHold(result);
    await updateEscrowContractId(result.db, bookingId, CONTRACT_ID);
    updateEscrowStateSync(result.db, bookingId, "locked");
    const app = createApp(result.db);

    const response = await app.request(`/proof/${bookingId}`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.ok(!text.includes(SECRET_ANSWER), "the answer text never reaches the proof page");
    assert.ok(!text.includes("intakeAnswers"));
    assert.ok(!text.includes("Any allergies?"), "nor does the question");
  } finally {
    closeDatabase(result);
  }
});

test("#146: discovery and the public profile omit the answers", async () => {
  const result = openTestDatabase();
  try {
    const { providerProfileId } = await seedHold(result);
    const app = createApp(result.db);

    for (const path of ["/providers", `/providers/${providerProfileId}`]) {
      const response = await app.request(path);
      assert.equal(response.status, 200, path);
      const text = await response.text();
      assert.ok(!text.includes(SECRET_ANSWER), `${path} carries no answer`);
      assert.ok(!text.includes("intakeAnswers"), `${path} carries no answers field`);
    }
  } finally {
    closeDatabase(result);
  }
});

test("#146: an admin resolving a dispute can read the answers", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId } = await seedHold(result);
    await updateEscrowContractId(result.db, bookingId, CONTRACT_ID);
    updateEscrowStateSync(result.db, bookingId, "locked");
    await insertEscrowProcessedEventIfNew(result.db, {
      bookingId,
      contractId: CONTRACT_ID,
      lifecycleAction: "disputed",
      amount: "1000000",
      ledgerSeq: "2",
      isAnomaly: false,
      processedAt: Date.now(),
    });
    const app = createApp(result.db);
    const adminWallet = config.adminWallets[0]!;

    const response = await app.request("/admin/disputes", { headers: await authHeader(adminWallet) });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { disputes: { bookingId: string; intakeAnswers: { answer: string }[] }[] };
    const dispute = body.disputes.find((entry) => entry.bookingId === bookingId);
    assert.equal(dispute?.intakeAnswers[0]?.answer, SECRET_ANSWER);
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// #147
// ---------------------------------------------------------------------------

test("#147: PUT /bookings/:id/intake edits a hold and the shop sees the edit", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress, providerWalletAddress } = await seedHold(result);
    const app = createApp(result.db);

    const response = await app.request(`/bookings/${bookingId}/intake`, {
      method: "PUT",
      headers: await authHeader(clientWalletAddress),
      body: JSON.stringify({ answers: { "q-allergies": "None", "q-name": "Sam" } }),
    });
    assert.equal(response.status, 200);

    const list = await app.request("/me/provider/bookings", { headers: await authHeader(providerWalletAddress) });
    const body = (await list.json()) as { bookings: { id: string; intakeAnswers: { answer: string }[] }[] };
    const item = body.bookings.find((booking) => booking.id === bookingId);
    assert.deepEqual(item?.intakeAnswers.map((entry) => entry.answer), ["None", "Sam"]);
  } finally {
    closeDatabase(result);
  }
});

test("#147: PUT /bookings/:id/intake is refused 409 INTAKE_LOCKED on a locked booking", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedHold(result);
    await updateEscrowContractId(result.db, bookingId, CONTRACT_ID);
    updateEscrowStateSync(result.db, bookingId, "locked");
    const app = createApp(result.db);

    const response = await app.request(`/bookings/${bookingId}/intake`, {
      method: "PUT",
      headers: await authHeader(clientWalletAddress),
      body: JSON.stringify({ answers: { "q-allergies": "None" } }),
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, "INTAKE_LOCKED");
    assert.match((await getBookingById(result.db, bookingId))!.intakeAnswers, new RegExp(SECRET_ANSWER));
  } finally {
    closeDatabase(result);
  }
});

test("#147: PUT /bookings/:id/intake refuses a blank required answer (400) and another client (404)", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedHold(result);
    const app = createApp(result.db);

    const blank = await app.request(`/bookings/${bookingId}/intake`, {
      method: "PUT",
      headers: await authHeader(clientWalletAddress),
      body: JSON.stringify({ answers: { "q-allergies": "" } }),
    });
    assert.equal(blank.status, 400);
    const blankBody = (await blank.json()) as { code: string; details: Record<string, string> };
    assert.equal(blankBody.code, "INVALID_INTAKE_ANSWERS");
    assert.ok(blankBody.details["q-allergies"]);

    const other = await app.request(`/bookings/${bookingId}/intake`, {
      method: "PUT",
      headers: await authHeader(Keypair.random().publicKey()),
      body: JSON.stringify({ answers: { "q-allergies": "None" } }),
    });
    assert.equal(other.status, 404);
    assert.match((await getBookingById(result.db, bookingId))!.intakeAnswers, new RegExp(SECRET_ANSWER));
  } finally {
    closeDatabase(result);
  }
});

// ---------------------------------------------------------------------------
// #148
// ---------------------------------------------------------------------------

test("#148: POST /bookings/:id/lock refuses 409 INTAKE_INCOMPLETE naming the question, and the hold stays", async () => {
  const result = openTestDatabase();
  try {
    const { bookingId, clientWalletAddress } = await seedHold(result, { "q-name": "Sam" });
    const before = await getBookingById(result.db, bookingId);
    const app = createApp(result.db);

    const response = await app.request(`/bookings/${bookingId}/lock`, {
      method: "POST",
      headers: await authHeader(clientWalletAddress),
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code: string; message: string; details: { questions: { label: string }[] } };
    assert.equal(body.code, "INTAKE_INCOMPLETE");
    assert.match(body.message, /Any allergies\?/);
    assert.deepEqual(body.details.questions.map((question) => question.label), ["Any allergies?"]);

    assert.deepEqual(await getBookingById(result.db, bookingId), before, "the hold is left exactly as it was");

    // The hold is still the client's: it reads back and can still be answered.
    const view = await app.request(`/bookings/${bookingId}`, { headers: await authHeader(clientWalletAddress) });
    assert.equal(view.status, 200);
  } finally {
    closeDatabase(result);
  }
});
