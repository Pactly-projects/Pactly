import assert from "node:assert/strict";
import { test } from "node:test";

import type { Money } from "../api/types";
import { depositMismatchMessage, lockButtonLabel, serverLockDeposit } from "./lockDeposit.js";

// Fixture: a booking response's deposit, in USDC smallest units (7 decimals).
const BOOKING_RESPONSE = { deposit: { amount: "125000000", asset: "USDC" } satisfies Money };
const HOLD_RESPONSE = { deposit: { amount: "100000000", asset: "USDC" } satisfies Money };

test("the lock button shows the deposit from the booking response, in USDC", () => {
  const deposit = serverLockDeposit(BOOKING_RESPONSE, HOLD_RESPONSE, false);
  assert.deepEqual(deposit, { amount: "125000000", asset: "USDC" });
  assert.equal(lockButtonLabel(deposit), "Lock 12.50 USDC with Pactly");
});

test("before the booking read arrives, the hold response's own deposit is used", () => {
  assert.deepEqual(serverLockDeposit(undefined, HOLD_RESPONSE, false), { amount: "100000000", asset: "USDC" });
});

test("a deposit of zero is shown as zero and still comes from the server", () => {
  const deposit = serverLockDeposit({ deposit: { amount: "0", asset: "USDC" } }, undefined, false);
  assert.deepEqual(deposit, { amount: "0", asset: "USDC" });
  assert.equal(lockButtonLabel(deposit), "Lock 0.00 USDC with Pactly");
});

test("with no server amount there is nothing to show, so the button stays disabled", () => {
  assert.equal(serverLockDeposit(undefined, undefined, false), undefined);
  assert.equal(serverLockDeposit({ deposit: null }, undefined, false), undefined);
  assert.equal(lockButtonLabel(undefined), "Lock with Pactly");
});

test("a failed booking load leaves the button disabled, even with a hold amount", () => {
  assert.equal(serverLockDeposit(undefined, HOLD_RESPONSE, true), undefined);
  assert.equal(serverLockDeposit(BOOKING_RESPONSE, HOLD_RESPONSE, true), undefined);
});

test("an amount that is not whole USDC smallest units, or another asset, is refused", () => {
  for (const amount of ["12.5", "-1", "", "1e7", " 100"]) {
    assert.equal(serverLockDeposit({ deposit: { amount, asset: "USDC" } }, undefined, false), undefined, amount);
  }
  assert.equal(serverLockDeposit({ deposit: { amount: "100", asset: "XLM" } }, undefined, false), undefined);
});

test("the amount signed must be the same figure the button showed", () => {
  const shown = { amount: "125000000", asset: "USDC" };
  assert.equal(depositMismatchMessage(shown, { amount: "125000000", asset: "USDC" }), undefined);
  assert.match(
    depositMismatchMessage(shown, { amount: "150000000", asset: "USDC" }) ?? "",
    /now 15\.00 USDC, not the 12\.50 USDC on the button\. Nothing was signed/,
  );
  assert.match(depositMismatchMessage(shown, undefined) ?? "", /could not be confirmed, so nothing was signed/);
  assert.match(depositMismatchMessage(undefined, shown) ?? "", /could not be confirmed/);
});
