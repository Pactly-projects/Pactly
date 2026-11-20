/**
 * Free-cancellation countdown driven by serverTime + cancelDeadline.
 * Covers the issue's validation cases: a deadline 10 seconds ahead of
 * server time stays open; 10 seconds behind is closed; a skewed client
 * clock cannot keep cancel enabled; a missing deadline shows no countdown.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isFreeCancelOpen, remainingFreeCancelSeconds } from "../src/lib/serverCancel.ts";

test("remainingFreeCancelSeconds: deadline 10 seconds ahead of server time stays open", () => {
  const serverTime = 1_700_000_000;
  const syncedAtMs = 5_000_000_000_000;
  const remaining = remainingFreeCancelSeconds({
    cancelDeadline: serverTime + 10,
    serverTime,
    syncedAtMs,
    nowMs: syncedAtMs,
  });
  assert.equal(remaining, 10);
  assert.equal(
    isFreeCancelOpen({
      cancelDeadline: serverTime + 10,
      serverTime,
      syncedAtMs,
      nowMs: syncedAtMs,
    }),
    true,
  );
});

test("remainingFreeCancelSeconds: deadline 10 seconds behind server time is closed", () => {
  const serverTime = 1_700_000_000;
  const syncedAtMs = 5_000_000_000_000;
  const remaining = remainingFreeCancelSeconds({
    cancelDeadline: serverTime - 10,
    serverTime,
    syncedAtMs,
    nowMs: syncedAtMs,
  });
  assert.equal(remaining, -10);
  assert.equal(
    isFreeCancelOpen({
      cancelDeadline: serverTime - 10,
      serverTime,
      syncedAtMs,
      nowMs: syncedAtMs,
    }),
    false,
  );
});

test("a client clock set an hour ahead does not keep the free-cancel action enabled", () => {
  const serverTime = 1_700_000_000;
  const cancelDeadline = serverTime - 10;
  // Browser thinks it is an hour ahead of the sync instant, but openness
  // still follows serverTime + elapsed-since-sync — not absolute browser time.
  const syncedAtMs = 5_000_000_000_000;
  const clientNowMs = syncedAtMs + 3_600_000;
  assert.equal(
    isFreeCancelOpen({
      cancelDeadline,
      serverTime,
      syncedAtMs,
      nowMs: clientNowMs,
    }),
    false,
  );
  // Even right at sync, a past server deadline stays closed.
  assert.equal(
    isFreeCancelOpen({
      cancelDeadline,
      serverTime,
      syncedAtMs,
      nowMs: syncedAtMs,
    }),
    false,
  );
});

test("a booking with no deadline shows no countdown (null remaining)", () => {
  assert.equal(
    remainingFreeCancelSeconds({
      cancelDeadline: null,
      serverTime: 1_700_000_000,
      syncedAtMs: 5_000_000_000_000,
      nowMs: 5_000_000_000_000,
    }),
    null,
  );
  assert.equal(
    remainingFreeCancelSeconds({
      cancelDeadline: undefined,
      serverTime: 1_700_000_000,
      syncedAtMs: 5_000_000_000_000,
      nowMs: 5_000_000_000_000,
    }),
    null,
  );
  assert.equal(
    isFreeCancelOpen({
      cancelDeadline: null,
      serverTime: 1_700_000_000,
      syncedAtMs: 5_000_000_000_000,
      nowMs: 5_000_000_000_000,
    }),
    false,
  );
});

test("resync: a later serverTime moves the remaining seconds", () => {
  const cancelDeadline = 1_700_000_100;
  const first = remainingFreeCancelSeconds({
    cancelDeadline,
    serverTime: 1_700_000_000,
    syncedAtMs: 1_000,
    nowMs: 1_000,
  });
  assert.equal(first, 100);
  // Refetch reports a server clock 50s later — countdown resyncs.
  const afterRefetch = remainingFreeCancelSeconds({
    cancelDeadline,
    serverTime: 1_700_000_050,
    syncedAtMs: 2_000,
    nowMs: 2_000,
  });
  assert.equal(afterRefetch, 50);
});
