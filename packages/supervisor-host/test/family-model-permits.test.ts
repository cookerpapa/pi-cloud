import { describe, it, expect, vi } from "vitest";
import { FamilyModelPermits } from "../src/family-model-permits.ts";

describe("physical-Session model permits", () => {
  it("round-robins families rather than exhausting one family's backlog", async () => {
    const gate = new FamilyModelPermits({ maximum: 1, perFamily: 1 });
    const release = await gate.acquire("a");
    const order: string[] = [];
    const run = (key: string) =>
      gate.acquire(key).then((done) => {
        order.push(key);
        done();
      });
    const work = [run("a"), run("a"), run("a"), run("b"), run("c")];
    release();
    await Promise.all(work);
    expect(order.indexOf("b")).toBeLessThan(order.lastIndexOf("a"));
    expect(order.indexOf("c")).toBeLessThan(order.lastIndexOf("a"));
    gate.close();
  });
  it("keeps global and family limits without occupying a global permit while waiting", async () => {
    const samples: { active: number; waiting: number }[] = [];
    const gate = new FamilyModelPermits({
      maximum: 2,
      perFamily: 1,
      onChange: (s) => samples.push(s),
    });
    const a = await gate.acquire("a");
    const pendingA = gate.acquire("a");
    const b = await gate.acquire("b");
    expect(samples.at(-1)).toEqual({ active: 2, waiting: 1 });
    b();
    a();
    (await pendingA)();
    expect(samples.at(-1)).toEqual({ active: 0, waiting: 0 });
    gate.close();
  });
  it("removes cancelled waiters and rejects the remaining queue on shutdown", async () => {
    const gate = new FamilyModelPermits({ maximum: 1, perFamily: 1 });
    const release = await gate.acquire("a");
    const controller = new AbortController();
    const pending = gate.acquire("b", controller.signal);
    const rejected = expect(pending).rejects.toThrow();
    controller.abort();
    await rejected;
    const closing = gate.acquire("c");
    const stopped = expect(closing).rejects.toThrow("closed");
    gate.close();
    await stopped;
    release();
    release();
    await expect(gate.acquire("d")).rejects.toThrow("closed");
  });
  it("allows a child request after its parent's model response releases the only permit", async () => {
    const gate = new FamilyModelPermits({ maximum: 1, perFamily: 1 });
    const parent = await gate.acquire("same-family");
    parent();
    const child = await gate.acquire("same-family");
    child();
    const nextParent = await gate.acquire("same-family");
    nextParent();
    gate.close();
  });
  it("does not grant an aborted request", async () => {
    const gate = new FamilyModelPermits({ maximum: 1, perFamily: 1, onWait: vi.fn() });
    const controller = new AbortController();
    controller.abort();
    expect(() => gate.acquire("a", controller.signal)).toThrow();
    gate.close();
  });
});

it("admits more than the former model/family limits when both policies are unlimited", async () => {
  const gate = new FamilyModelPermits({ maximum: null, perFamily: null });
  const releases = await Promise.all(Array.from({ length: 40 }, () => gate.acquire("same-family")));
  expect(releases).toHaveLength(40);
  for (const release of releases) release();
  gate.close();
  await expect(gate.acquire("next")).rejects.toThrow("closed");
});

it("keeps an explicit global limit when the family policy is unlimited", async () => {
  const gate = new FamilyModelPermits({ maximum: 1, perFamily: null });
  const first = await gate.acquire("one");
  let entered = false;
  const next = gate.acquire("one").then((release) => {
    entered = true;
    return release;
  });
  await Promise.resolve();
  expect(entered).toBe(false);
  first();
  (await next)();
  gate.close();
});
