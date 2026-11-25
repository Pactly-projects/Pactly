/**
 * The provider dashboard's USDC trustline readiness read, with every network
 * seam injected: a shop without the anchor's USDC gets `false` (the
 * dashboard warns), a shop holding it gets `true` (no warning), and an
 * unreachable read gets `null` (no false warning). The read is only a read
 * -- it goes through `hasTrustline` and nothing that builds or submits a
 * change-trust transaction.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import { getProviderTrustlineStatus } from "../src/services/providerTrustline.js";
import type { UsdcAsset } from "../src/anchor/usdc.js";

const WALLET = "GPROVIDERWALLETFORDASHBOARDWARNING000";

const FAKE_USDC: UsdcAsset = {
  code: "USDC",
  issuer: "GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H",
  contractId: "CUSDCFAKE00000000000000000000000000000000000000000",
};

const READY_DEPS = {
  resolveUsdcAsset: async () => FAKE_USDC,
  hasTrustline: async () => true,
};

const MISSING_DEPS = {
  resolveUsdcAsset: async () => FAKE_USDC,
  hasTrustline: async () => false,
};

test("a shop without a trustline gets the warning flag", async () => {
  const status = await getProviderTrustlineStatus(WALLET, MISSING_DEPS);
  assert.deepEqual(status, { hasTrustline: false });
});

test("a shop with a trustline gets no warning", async () => {
  const status = await getProviderTrustlineStatus(WALLET, READY_DEPS);
  assert.deepEqual(status, { hasTrustline: true });
});

test("the check only reads: it asks for exactly the anchor's USDC and writes nothing", async () => {
  const questions: Array<{ account: string; code: string; issuer: string }> = [];
  const status = await getProviderTrustlineStatus(WALLET, {
    resolveUsdcAsset: async () => FAKE_USDC,
    hasTrustline: async (account, code, issuer) => {
      questions.push({ account, code, issuer });
      return false;
    },
  });

  assert.deepEqual(status, { hasTrustline: false });
  assert.deepEqual(questions, [{ account: WALLET, code: "USDC", issuer: FAKE_USDC.issuer }]);
});

test("an unanswered check reports unknown rather than a false warning", async () => {
  const status = await getProviderTrustlineStatus(WALLET, {
    resolveUsdcAsset: async () => {
      throw new Error("anchor unreachable");
    },
  });
  assert.deepEqual(status, { hasTrustline: null });
});
