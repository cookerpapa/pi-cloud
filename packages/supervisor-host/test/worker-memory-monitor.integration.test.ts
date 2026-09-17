import { expect, it, vi } from "vitest";
import { WorkerMemoryMonitor } from "../src/worker-memory-monitor.ts";

it("samples on a real thread without calling the main-thread constrainedMemory API", async () => {
  const probe = vi.spyOn(process, "constrainedMemory").mockImplementation(() => {
    throw new Error("Blocking OS probe on Agent thread");
  });
  const failure = vi.fn(),
    monitor = new WorkerMemoryMonitor(failure);
  try {
    await monitor.start();
    for (let i = 0; i < 100; i++) expect(typeof monitor.hasHeadroom()).toBe("boolean");
    expect(probe).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  } finally {
    await monitor.close();
    probe.mockRestore();
  }
  expect(monitor.hasHeadroom()).toBe(false);
});
