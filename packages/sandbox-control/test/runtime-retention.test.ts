import { expect, it, vi } from "vitest";
import { RuntimeRetention } from "../src/runtime-retention.ts";
import type { PhysicalResourceUse } from "@pi-cloud/protocol";
const target = { id: "vm", tenantId: "tenant", kind: "workspace" as const };
const tick = async () => {
  for (let n = 0; n < 6; n++) await Promise.resolve();
};
it("combines shared targets and preserves the eligibility observation time", async () => {
  let now = 100000;
  const renew = vi.fn(async () => {}),
    delivery = new RuntimeRetention({ renew, clock: () => now });
  try {
    delivery.retain(target, { writerId: "a", observedAt: now, current: () => true });
    await tick();
    now += 30000;
    delivery.retain(target, { writerId: "a", observedAt: now, current: () => true });
    delivery.retain(target, { writerId: "b", observedAt: now, current: () => true });
    await tick();
    expect(renew).toHaveBeenCalledTimes(1);
    now += 30000;
    delivery.flush();
    await tick();
    expect(renew).toHaveBeenCalledTimes(2);
    expect(renew.mock.calls.at(-1)).toEqual([[{ ...target, observedAt: 130000 }]]);
  } finally {
    await delivery.close();
  }
});
it("drops expired lease evidence and withdraws pending retention at family settlement", async () => {
  let now = 100000,
    valid = true;
  const renew = vi.fn(async () => {}),
    delivery = new RuntimeRetention({ renew, clock: () => now });
  try {
    delivery.retain(target, { writerId: "a", observedAt: now - 46000, current: () => true });
    delivery.retain(target, { writerId: "a", observedAt: now + 6000, current: () => true });
    expect(renew).not.toHaveBeenCalled();
    delivery.retain(target, { writerId: "a", observedAt: now, current: () => valid });
    await tick();
    now += 30000;
    delivery.retain(target, { writerId: "a", observedAt: now, current: () => valid });
    delivery.forget("a");
    valid = false;
    now += 30000;
    delivery.flush();
    await tick();
    delivery.retain(target, { writerId: "a", observedAt: now, current: () => true });
    expect(renew).toHaveBeenCalledTimes(1);
    delivery.retain(target, { writerId: "b", observedAt: now, current: () => true });
    await tick();
    expect(renew).toHaveBeenCalledTimes(2);
  } finally {
    await delivery.close();
  }
});
it("does not use an old target after partition handoff", async () => {
  let now = 100000,
    current = true;
  const renew = vi.fn(async () => {}),
    delivery = new RuntimeRetention({ renew, clock: () => now });
  try {
    delivery.retain(target, { writerId: "a", observedAt: now, current: () => current });
    await tick();
    now += 30000;
    delivery.retain(target, { writerId: "a", observedAt: now, current: () => current });
    current = false;
    delivery.reset();
    now += 30000;
    delivery.flush();
    await tick();
    expect(renew).toHaveBeenCalledTimes(1);
  } finally {
    await delivery.close();
  }
});

it("batches distinct resources and retries a lost receipt with the original timestamps", async () => {
  let now = 100000;
  const renew = vi
    .fn(async (_uses: readonly PhysicalResourceUse[]) => {})
    .mockRejectedValueOnce(new Error("manager offline"));
  const delivery = new RuntimeRetention({ renew, clock: () => now });
  try {
    for (let n = 0; n < 20; n++)
      delivery.retain(
        { ...target, id: String(n) },
        { writerId: "writer", observedAt: now, current: () => true },
      );
    await tick();
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew.mock.calls[0]![0]).toHaveLength(20);
    now += 5000;
    delivery.flush();
    await tick();
    expect(renew).toHaveBeenCalledTimes(2);
    expect(renew.mock.calls[1]).toEqual(renew.mock.calls[0]);
  } finally {
    await delivery.close();
  }
});

it("coalesces shared interactive use and ends it only after the last connection closes", async () => {
  let now = 100000;
  const renew = vi.fn(async () => {}),
    delivery = new RuntimeRetention({ renew, clock: () => now });
  try {
    const first = delivery.hold(target),
      second = delivery.hold(target);
    await tick();
    expect(renew).toHaveBeenCalledTimes(1);
    first();
    now += 60000;
    delivery.flush();
    await tick();
    expect(renew).toHaveBeenCalledTimes(2);
    second();
    now += 60000;
    delivery.flush();
    await tick();
    expect(renew).toHaveBeenCalledTimes(2);
  } finally {
    await delivery.close();
  }
});

it("keeps already observed use after disconnect without generating future activity", async () => {
  let now = 100000;
  const renew = vi.fn(async (_uses: readonly PhysicalResourceUse[]) => {});
  const delivery = new RuntimeRetention({ renew, clock: () => now });
  try {
    const end = delivery.hold(target);
    await tick();
    now += 30000;
    delivery.flush();
    await tick();
    end();
    now += 30000;
    delivery.flush();
    await tick();
    expect(renew).toHaveBeenCalledTimes(2);
    expect(renew.mock.calls[1]![0]).toEqual([{ ...target, observedAt: 130000 }]);
    now += 60000;
    delivery.flush();
    await tick();
    expect(renew).toHaveBeenCalledTimes(2);
  } finally {
    await delivery.close();
  }
});
