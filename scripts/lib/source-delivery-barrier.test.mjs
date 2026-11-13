import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { waitForOwnedReceiptDelivery } from "./source-delivery-barrier.mjs";
function snapshot(pending = 0) {
  return {
    compute: [
      {
        sourceId: "platform-service-v1",
        epoch: "service-minute-v1",
        podId: "metering-pod",
        checkedAt: 10000,
        healthy: true,
        resources: 1,
        pending,
      },
    ],
    quota: { podId: "quota-pod", pending: 0, pendingClosures: 0 },
    provider: {
      version: 1,
      podId: "provider-pod",
      bootId: "provider-boot",
      pending: 0,
      active: 0,
      captureFailures: 0,
    },
  };
}
function fixture(rows) {
  let elapsed = 0,
    reads = 0;
  const tenantId = randomUUID();
  const run = (extra = {}) =>
    waitForOwnedReceiptDelivery({
      tenantId,
      timeoutMs: 5000,
      readSources: async () => structuredClone(rows[Math.min(reads++, rows.length - 1)]),
      monotonicNow: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
      ...extra,
    });
  return { run, tenantId, reads: () => reads };
}
it("waits until owned service periods are closed and settled", async () => {
  const f = fixture([snapshot(1), snapshot(1), snapshot(0)]);
  expect(await f.run()).toMatchObject({ verified: true, tenantId: f.tenantId });
  expect(f.reads()).toBe(3);
});
it("does not require synthetic receipts for a fixture with no attributed compute", async () => {
  const empty = snapshot();
  empty.compute[0].resources = 0;
  const f = fixture([empty]);
  expect((await f.run()).verified).toBe(true);
  expect(f.reads()).toBe(2);
});
it("waits for two zero quota observations after pending closure and delivery", async () => {
  const closure = snapshot(),
    pending = snapshot();
  closure.quota.pendingClosures = 1;
  pending.quota.pending = 1;
  const f = fixture([closure, pending, snapshot(), snapshot()]);
  await f.run();
  expect(f.reads()).toBe(4);
});
it("waits for active model requests and durable provider delivery", async () => {
  const active = snapshot(),
    pending = snapshot();
  active.provider.active = 1;
  pending.provider.pending = 1;
  const f = fixture([active, pending, snapshot()]);
  await f.run();
  expect(f.reads()).toBe(3);
});
it.each(["epoch", "podId", "sourceId"])("refuses a changed compute %s", async (field) => {
  const changed = snapshot();
  changed.compute[0][field] = "replacement";
  await expect(fixture([snapshot(1), changed]).run()).rejects.toThrow("restarted or changed");
});
it("refuses disappearing sources and a reset checkpoint", async () => {
  const missing = snapshot();
  missing.compute = [];
  await expect(fixture([snapshot(1), missing]).run()).rejects.toThrow("ledger retained");
  const reset = snapshot();
  reset.compute[0].checkedAt = 1;
  await expect(fixture([snapshot(1), reset]).run()).rejects.toThrow("checkpoint reset");
});
it("does not purge on failed, stale, missing or unresolved observation", async () => {
  const failed = snapshot();
  failed.compute[0].healthy = false;
  await expect(fixture([failed]).run()).rejects.toThrow("ledger retained");
  await expect(fixture([snapshot(1)]).run()).rejects.toThrow("ledger retained");
  await expect(
    fixture([]).run({
      readSources: async () => {
        throw Error("source offline");
      },
    }),
  ).rejects.toThrow("ledger retained");
});
it("refuses provider capture loss and identity changes", async () => {
  for (const field of ["bootId", "podId", "captureFailures"]) {
    const changed = snapshot();
    changed.provider[field] = field === "captureFailures" ? 1 : "replacement";
    await expect(fixture([snapshot(1), changed]).run()).rejects.toThrow("lost capture");
  }
});
it("keeps its baseline immutable when a reader reuses an object", async () => {
  const value = snapshot(1),
    f = fixture([]);
  let count = 0;
  await expect(
    f.run({
      readSources: async () => {
        if (count++) value.compute[0].podId = "new";
        return value;
      },
    }),
  ).rejects.toThrow("restarted or changed");
});
it("honors cancellation before granting disposable ledger cleanup", async () => {
  const f = fixture([snapshot()]),
    abort = new AbortController();
  abort.abort(Error("owned cancellation"));
  await expect(f.run({ signal: abort.signal })).rejects.toThrow("owned cancellation");
  expect(f.reads()).toBe(0);
});
