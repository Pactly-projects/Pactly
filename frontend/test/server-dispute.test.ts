import assert from "node:assert/strict";
import { test } from "node:test";

import { isDisputeWindowOpen } from "../src/lib/serverDispute.ts";

const DAY_SECONDS = 24 * 60 * 60;

test("dispute window includes the appointment start and the end of day seven", () => {
  const slotStartsAt = 1_700_000_000;
  const syncedAtMs = 5_000_000_000_000;
  const disputeDeadline = slotStartsAt + 7 * DAY_SECONDS;

  assert.equal(
    isDisputeWindowOpen({ slotStartsAt, disputeDeadline, serverTime: slotStartsAt, syncedAtMs, nowMs: syncedAtMs }),
    true,
  );
  assert.equal(
    isDisputeWindowOpen({
      slotStartsAt,
      disputeDeadline,
      serverTime: disputeDeadline,
      syncedAtMs,
      nowMs: syncedAtMs,
    }),
    true,
  );
});

test("dispute window is closed before the appointment and after day seven", () => {
  const slotStartsAt = 1_700_000_000;
  const syncedAtMs = 5_000_000_000_000;
  const disputeDeadline = slotStartsAt + 7 * DAY_SECONDS;

  assert.equal(
    isDisputeWindowOpen({
      slotStartsAt,
      disputeDeadline,
      serverTime: slotStartsAt - 1,
      syncedAtMs,
      nowMs: syncedAtMs,
    }),
    false,
  );
  assert.equal(
    isDisputeWindowOpen({
      slotStartsAt,
      disputeDeadline,
      serverTime: disputeDeadline + 1,
      syncedAtMs,
      nowMs: syncedAtMs,
    }),
    false,
  );
});

test("dispute window advances using elapsed time since the server sync", () => {
  const slotStartsAt = 1_700_000_000;
  const syncedAtMs = 5_000_000_000_000;
  const disputeDeadline = slotStartsAt + 7 * DAY_SECONDS;

  assert.equal(
    isDisputeWindowOpen({
      slotStartsAt,
      disputeDeadline,
      serverTime: slotStartsAt - 1,
      syncedAtMs,
      nowMs: syncedAtMs + 1_000,
    }),
    true,
  );
  assert.equal(
    isDisputeWindowOpen({
      slotStartsAt,
      disputeDeadline,
      serverTime: disputeDeadline - 1,
      syncedAtMs,
      nowMs: syncedAtMs + 2_000,
    }),
    false,
  );
});

test("dispute window fails closed when the booking time or server clock is missing", () => {
  const syncedAtMs = 5_000_000_000_000;
  const slotStartsAt = 1_700_000_000;
  const disputeDeadline = slotStartsAt + 7 * DAY_SECONDS;
  assert.equal(isDisputeWindowOpen({ slotStartsAt: null, disputeDeadline: null, serverTime: slotStartsAt, syncedAtMs }), false);
  assert.equal(isDisputeWindowOpen({ slotStartsAt, disputeDeadline, serverTime: undefined, syncedAtMs }), false);
  assert.equal(isDisputeWindowOpen({ slotStartsAt, disputeDeadline: null, serverTime: slotStartsAt, syncedAtMs }), false);
});
