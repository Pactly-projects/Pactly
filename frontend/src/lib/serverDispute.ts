export interface ServerDisputeWindowClock {
  slotStartsAt: number | null;
  disputeDeadline: number | null;
  serverTime: number | undefined;
  syncedAtMs: number;
  nowMs?: number;
}

export function isDisputeWindowOpen(clock: ServerDisputeWindowClock): boolean {
  if (clock.slotStartsAt === null || clock.disputeDeadline === null || clock.serverTime === undefined) {
    return false;
  }

  const nowMs = clock.nowMs ?? Date.now();
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - clock.syncedAtMs) / 1000));
  const effectiveServerTime = clock.serverTime + elapsedSeconds;
  return effectiveServerTime >= clock.slotStartsAt && effectiveServerTime <= clock.disputeDeadline;
}
