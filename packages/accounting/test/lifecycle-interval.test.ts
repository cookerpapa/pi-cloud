import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { SandboxLifecycleEvent } from "@pi-cloud/protocol";
import { lifecycleInterval } from "../src/lifecycle-interval.ts";
const resource = {
  kind: "compute" as const,
  resourceId: randomUUID(),
  tenantId: randomUUID(),
  workspaceId: randomUUID(),
};
const epoch = randomUUID(),
  boot = randomUUID();
const event = (
  sequence: number,
  at: number,
  overrides: Partial<SandboxLifecycleEvent> = {},
): SandboxLifecycleEvent => ({
  eventId: randomUUID(),
  sequence: String(sequence),
  previousSequence: String(sequence - 1),
  resource,
  quantity: { kind: "compute", cpuMillis: 2000, memoryBytes: 2 * 1024 ** 3 },
  incarnation: "vm-start-1",
  sourceBootId: boot,
  state: "running",
  observedAt: new Date(1_000_000 + at).toISOString(),
  occurredAt: null,
  ...overrides,
});
it("starts at observed evidence and measures allocation time independent of Sessions and Tool activity", () => {
  const first = lifecycleInterval("node", epoch, event(1, 0));
  expect(first.receipt?.from).toBe(first.receipt?.to);
  const next = lifecycleInterval("node", epoch, event(2, 30_000), first.state);
  expect(next.receipt).toMatchObject({ quality: "confirmed", quantity: { cpuMillis: 2000 } });
  expect(Date.parse(next.receipt!.to) - Date.parse(next.receipt!.from)).toBe(30_000);
});
it.each([
  [{ sourceBootId: "replacement" }, "source_restarted"],
  [{ previousSequence: "0" }, "collection_unavailable"],
  [{ state: "unknown" }, "observation_unavailable"],
  [{ incarnation: "new-vm" }, "instance_changed"],
  [
    { quantity: { kind: "compute", cpuMillis: 4000, memoryBytes: 2 * 1024 ** 3 } },
    "observation_unavailable",
  ],
] as const)("never charges a discontinuous observation (%j)", (changes, reason) => {
  const previous = lifecycleInterval("node", epoch, event(1, 0)).state;
  expect(
    lifecycleInterval("node", epoch, event(2, 30_000, changes), previous).receipt,
  ).toMatchObject({ quality: "unconfirmed", reason });
});
it("does not charge until discovery when a VM stopped earlier, and accepts an explicit physical end time", () => {
  const previous = lifecycleInterval("node", epoch, event(1, 0)).state;
  const stopped = event(2, 600_000, { state: "absent" });
  expect(lifecycleInterval("node", epoch, stopped, previous).receipt?.quality).toBe("unconfirmed");
  const exact = lifecycleInterval(
    "node",
    epoch,
    { ...stopped, occurredAt: new Date(1_030_000).toISOString() },
    previous,
  );
  expect(exact.receipt).toMatchObject({
    quality: "confirmed",
    to: new Date(1_030_000).toISOString(),
  });
});
it("keeps paused checkpoints without invoice rows and never prices a wall-clock interval twice", () => {
  const paused = lifecycleInterval("node", epoch, event(1, 0, { state: "paused" }));
  expect(
    lifecycleInterval("node", epoch, event(2, 30_000, { state: "paused" }), paused.state).receipt,
  ).toBeUndefined();
  const a = lifecycleInterval("node", epoch, event(1, 30_000));
  const b = lifecycleInterval("node", epoch, event(2, 10_000), a.state);
  const c = lifecycleInterval("node", epoch, event(3, 20_000), b.state);
  expect(b.receipt).toMatchObject({ quality: "unconfirmed", reason: "clock_changed" });
  expect(c.receipt!.from).toBe(a.state.through);
  expect(c.receipt!.to).toBe(a.state.through);
});
