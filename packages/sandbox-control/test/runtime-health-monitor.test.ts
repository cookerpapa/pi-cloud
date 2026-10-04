import { expect, it, vi } from "vitest";
import { RuntimeHealthMonitor, type RuntimeHealthTarget } from "../src/runtime-health-monitor.ts";
import type { SandboxRuntimeObservation } from "../src/sandbox-provider.ts";

const running: SandboxRuntimeObservation = {
  runtimeName: "vm",
  nodeId: "node",
  presence: "present",
  state: "running",
};
function target(id: string): RuntimeHealthTarget {
  return {
    id,
    observe: vi.fn(async () => running),
    probe: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
  };
}
it("contains timer enumeration failures and retries without fabricating physical loss", async () => {
  vi.useFakeTimers();
  const vm = target("survivor"),
    onError = vi.fn();
  const targets = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error("missing local handle");
    })
    .mockReturnValue([vm]);
  const monitor = new RuntimeHealthMonitor({ targets, inventory: async () => new Map(), onError });
  try {
    await vi.advanceTimersByTimeAsync(1000);
    expect(onError).toHaveBeenCalledOnce();
    expect(vm.fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await monitor.settle();
    expect(vm.probe).toHaveBeenCalledOnce();
    expect(vm.fail).not.toHaveBeenCalled();
  } finally {
    await monitor.close();
    vi.useRealTimers();
  }
});
it("covers 160 due VMs without a batch truncation and bounds concurrent execution", async () => {
  let release!: () => void,
    active = 0,
    maximum = 0;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const targets = Array.from({ length: 160 }, (_, i) => target(String(i)));
  for (const vm of targets)
    vm.probe = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await gate;
      active--;
    });
  const monitor = new RuntimeHealthMonitor({
    targets: () => targets,
    inventory: async () => new Map(targets.map((t) => [t.id, running])),
    onError: vi.fn(),
    concurrency: 8,
  });
  try {
    monitor.refresh();
    await vi.waitFor(() => expect(active).toBe(8));
    release();
    await monitor.settle();
    expect(maximum).toBe(8);
    expect(targets.every((t) => vi.mocked(t.probe).mock.calls.length === 1)).toBe(true);
    expect(targets.every((t) => vi.mocked(t.observe).mock.calls.length === 0)).toBe(true);
  } finally {
    release();
    await monitor.close();
  }
});
it("shares fresh guest evidence, skips paused VMs and never creates an inactive target", async () => {
  let now = 100_000;
  const vm = target("one"),
    paused = target("paused"),
    inventory = vi.fn(
      async () =>
        new Map([
          [vm.id, running],
          [paused.id, { ...running, state: "paused" as const }],
        ]),
    );
  let targets: RuntimeHealthTarget[] = [];
  const monitor = new RuntimeHealthMonitor({
    targets: () => targets,
    inventory,
    onError: vi.fn(),
    clock: () => now,
  });
  try {
    monitor.refresh();
    expect(inventory).not.toHaveBeenCalled();
    targets = [vm, paused];
    monitor.refresh();
    expect(monitor.evidence(vm.id, now)).toBe(true);
    await monitor.settle();
    expect(vm.probe).not.toHaveBeenCalled();
    expect(paused.probe).not.toHaveBeenCalled();
    now += 15_000;
    monitor.refresh();
    await monitor.settle();
    expect(vm.probe).toHaveBeenCalledOnce();
    expect(monitor.evidence(vm.id, now - 46_000)).toBe(false);
  } finally {
    await monitor.close();
  }
});
it("missing inventory and failed execution need exact evidence, not inferred absence", async () => {
  const vm = target("one"),
    onError = vi.fn();
  vm.probe = vi.fn(async () => {
    throw new Error("reply lost");
  });
  const monitor = new RuntimeHealthMonitor({
    targets: () => [vm],
    inventory: async () => new Map(),
    onError,
  });
  try {
    monitor.refresh();
    await monitor.settle();
    expect(vm.observe).toHaveBeenCalledTimes(2);
    expect(vm.fail).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  } finally {
    await monitor.close();
  }
});
it("confirmed physical loss quarantines, while a removed target's late reply is ignored", async () => {
  const dead = target("dead");
  dead.observe = vi.fn(async () => ({ ...running, state: "stopped" as const }));
  let targets = [dead];
  const monitor = new RuntimeHealthMonitor({
    targets: () => targets,
    inventory: async () => new Map(),
    onError: vi.fn(),
  });
  try {
    monitor.refresh();
    await monitor.settle();
    expect(dead.fail).toHaveBeenCalledOnce();
    expect(dead.probe).not.toHaveBeenCalled();
    targets = [];
    monitor.refresh();
    expect(monitor.evidence(dead.id, Date.now())).toBe(false);
  } finally {
    await monitor.close();
  }
});
