import { describe, expect, it, vi } from "vitest";
import { RunClaimReadinessMonitor } from "../src/run-claim-readiness.ts";

describe("RunClaimReadinessMonitor", () => {
  it("keeps Run admission synchronous while refreshing dependencies in the background", async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => undefined);
    const monitor = new RunClaimReadinessMonitor({ check, intervalMs: 100 });
    await monitor.start();

    expect(monitor.ready).toBe(true);
    expect(check).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(300);
    expect(check).toHaveBeenCalledTimes(4);
    expect(monitor.ready).toBe(true);

    monitor.close();
    await vi.advanceTimersByTimeAsync(300);
    expect(check).toHaveBeenCalledTimes(4);
    expect(monitor.ready).toBe(false);
    vi.useRealTimers();
  });

  it("fails closed after a background check and recovers on the next successful probe", async () => {
    vi.useFakeTimers();
    let healthy = true;
    const monitor = new RunClaimReadinessMonitor({
      intervalMs: 100,
      check: async () => {
        if (!healthy) throw new Error("dependency unavailable");
      },
    });
    await monitor.start();
    expect(monitor.ready).toBe(true);

    healthy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(monitor.ready).toBe(false);
    healthy = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(monitor.ready).toBe(true);

    monitor.close();
    vi.useRealTimers();
  });
});
