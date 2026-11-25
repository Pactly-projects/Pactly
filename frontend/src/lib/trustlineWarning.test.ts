import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldShowTrustlineWarning } from "./trustlineWarning.js";

test("a fixture without a trustline shows the dashboard warning", () => {
  assert.equal(shouldShowTrustlineWarning({ hasTrustline: false }), true);
});

test("a fixture with a trustline hides the dashboard warning", () => {
  assert.equal(shouldShowTrustlineWarning({ hasTrustline: true }), false);
});

test("an unanswered check hides the warning rather than guessing", () => {
  assert.equal(shouldShowTrustlineWarning({ hasTrustline: null }), false);
  assert.equal(shouldShowTrustlineWarning(undefined), false);
});
