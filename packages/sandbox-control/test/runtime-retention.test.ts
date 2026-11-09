import { expect, it, vi } from "vitest";
import { RuntimeRetention } from "../src/runtime-retention.ts";
const target = { id: "vm", capsule: "owned" };
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
    expect(renew.mock.calls.at(-1)).toEqual([target, 130000]);
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
