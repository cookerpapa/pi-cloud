import { describe, expect, it, vi } from "vitest";
import { RuntimeRetention, type RuntimeRetentionTarget } from "../src/runtime-retention.ts";
import type { RuntimeKeepalive } from "@pi-cloud/protocol";

const scope = {
  tenantId: "tenant",
  piSessionId: "physical",
  sessionId: "conversation",
  turnId: "turn",
  runId: "run",
  writerId: "writer",
  fencingToken: 1,
};
const pulse = (at: number, writerId = "writer"): RuntimeKeepalive => ({
  kind: "runtime_keepalive",
  factId: "pulse",
  scope: { ...scope, writerId },
  occurredAt: new Date(at).toISOString(),
  resources: [{ workspaceId: "workspace" }],
});
const tick = async () => {
  for (let n = 0; n < 6; n++) await Promise.resolve();
};

describe("Cube retention delivery", () => {
  it("delivers an accepted final pulse after normal task settlement without extending its timestamp", async () => {
    const ready = Promise.withResolvers<RuntimeRetentionTarget | undefined>();
    const renew = vi.fn(async (_target: RuntimeRetentionTarget, _at: number) => {});
    const delivery = new RuntimeRetention({
      resolve: () => ready.promise,
      renew,
      clock: () => 100000,
    });
    try {
      delivery.consume(pulse(100000), () => true);
      delivery.forget("writer");
      ready.resolve({ id: "old-vm", capsule: "private" });
      await tick();
      expect(renew).toHaveBeenCalledWith({ id: "old-vm", capsule: "private" }, 100000);
    } finally {
      await delivery.close();
    }
  });
  it("bootstraps once, combines shared-VM sources and preserves original time", async () => {
    let now = 100000;
    const resolve = vi.fn(async () => ({ id: "vm", capsule: "private" }));
    const renew = vi.fn(async (_target: RuntimeRetentionTarget, _at: number) => {});
    const delivery = new RuntimeRetention({ resolve, renew, clock: () => now });
    try {
      delivery.consume(pulse(now), () => true);
      await tick();
      expect(renew.mock.calls).toEqual([[{ id: "vm", capsule: "private" }, 100000]]);
      now += 15000;
      delivery.consume(pulse(now), () => true);
      await tick();
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(renew).toHaveBeenCalledTimes(1);
      delivery.consume(pulse(now, "other-writer"), () => true);
      await tick();
      now += 15000;
      delivery.flush();
      await tick();
      expect(renew.mock.calls.at(-1)?.[1]).toBe(115000);
      expect(renew).toHaveBeenCalledTimes(2);
    } finally {
      await delivery.close();
    }
  });
  it("does not refresh from stale/future/revoked or replayed sources", async () => {
    let now = 100000,
      open = true;
    const renew = vi.fn(async () => {}),
      resolve = vi.fn(async () => ({ id: "vm", capsule: "private" }));
    const delivery = new RuntimeRetention({ resolve, renew, clock: () => now });
    try {
      delivery.consume(pulse(now - 46000), () => true);
      delivery.consume(pulse(now + 6000), () => true);
      expect(resolve).not.toHaveBeenCalled();
      delivery.consume(pulse(now), () => open);
      open = false;
      await tick();
      expect(renew).not.toHaveBeenCalled();
      delivery.reset();
      open = true;
      delivery.consume(pulse(now), () => open);
      delivery.reset();
      await tick();
      expect(renew).not.toHaveBeenCalled();
      now += 100000;
      delivery.flush();
      await tick();
      expect(renew).not.toHaveBeenCalled();
    } finally {
      await delivery.close();
    }
  });
  it("keeps empty Workspace lookups negative until a real binding change", async () => {
    let now = 100000,
      exists = false;
    const resolve = vi.fn(async () => (exists ? { id: "vm", capsule: "private" } : undefined)),
      renew = vi.fn(async () => {});
    const delivery = new RuntimeRetention({ resolve, renew, clock: () => now });
    try {
      delivery.consume(pulse(now), () => true);
      await tick();
      now += 15000;
      exists = true;
      delivery.consume(pulse(now), () => true);
      await tick();
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(renew).not.toHaveBeenCalled();
      delivery.invalidateSession("tenant", "physical");
      delivery.consume(pulse(now), () => true);
      await tick();
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(renew).toHaveBeenCalledTimes(1);
    } finally {
      await delivery.close();
    }
  });
  it("bounds unavailable Cube requests without blocking ingestion", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((r) => (finish = r));
    const renew = vi.fn(() => pending);
    const delivery = new RuntimeRetention({
      resolve: async (_scope, resource) => ({ id: resource.workspaceId, capsule: "private" }),
      renew,
      clock: () => 100000,
    });
    try {
      const fact = pulse(100000);
      fact.resources = Array.from({ length: 20 }, (_, i) => ({ workspaceId: `workspace-${i}` }));
      delivery.consume(fact, () => true);
      await tick();
      expect(renew).toHaveBeenCalledTimes(4);
    } finally {
      finish();
      await delivery.close();
    }
  });
});
