import assert from "node:assert/strict";
import { test } from "node:test";

import { formatUsdc, isUsableDepositAmount } from "../src/components/LockButton";

test("LockButton treats zero as a usable server deposit", () => {
  assert.equal(isUsableDepositAmount("0"), true);
  assert.equal(formatUsdc("0"), "0.00 USDC");
});

test("LockButton disables missing and invalid server deposits", () => {
  assert.equal(isUsableDepositAmount(undefined), false);
  assert.equal(isUsableDepositAmount(""), false);
  assert.equal(isUsableDepositAmount("-1"), false);
  assert.equal(isUsableDepositAmount("not-an-amount"), false);
});

test("LockButton formats the server deposit in USDC smallest units", () => {
  assert.equal(formatUsdc("2000000"), "0.20 USDC");
  assert.equal(formatUsdc("10000000"), "1.00 USDC");
});
