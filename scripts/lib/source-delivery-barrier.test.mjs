import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  parseComputeDeliveryMetrics,
  waitForOwnedReceiptDelivery,
} from "./source-delivery-barrier.mjs";

function snapshot(cycles, change = {}) {
  return {
    compute: [
      {
        sourceId: "owned-node",
        bootId: "compute-boot",
        podId: "compute-pod",
        completedCycles: cycles,
        deliveredCycles: cycles,
        captureFailures: 0,
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
    ...change,
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

it("requires two completed post-disposal sweeps and coherent receipt acknowledgement", async () => {
  const f = fixture([snapshot(10), snapshot(11), snapshot(12)]);
  expect(await f.run()).toMatchObject({
    verified: true,
    tenantId: f.tenantId,
    compute: [{ sourceId: "owned-node", bootId: "compute-boot", deliveredCycles: 12 }],
  });
  expect(f.reads()).toBe(3);
});

it("does not combine a newer cycle counter with an older empty-outbox observation", async () => {
  const mixed = snapshot(12);
  mixed.compute[0].deliveredCycles = 11;
  const f = fixture([snapshot(10), snapshot(11), mixed, snapshot(12)]);
  await f.run();
  expect(f.reads()).toBe(4);
});

it("waits for pending closures and two zero quota snapshots", async () => {
  const pendingClosure = snapshot(11),
    pendingReceipt = snapshot(12);
  pendingClosure.quota.pendingClosures = 1;
  pendingReceipt.quota.pending = 1;
  const f = fixture([snapshot(10), pendingClosure, pendingReceipt, snapshot(13), snapshot(14)]);
  await f.run();
  expect(f.reads()).toBe(5);
});

it("waits for active model requests and durable provider delivery", async () => {
  const active = snapshot(12),
    pending = snapshot(13);
  active.provider.active = 1;
  pending.provider.pending = 2;
  const f = fixture([snapshot(10), snapshot(11), active, pending, snapshot(14)]);
  await f.run();
  expect(f.reads()).toBe(5);
});

it.each(["bootId", "podId", "sourceId"])("rejects a changed compute %s", async (field) => {
  const changed = snapshot(12);
  changed.compute[0][field] = "replacement";
  const f = fixture([snapshot(10), changed]);
  await expect(f.run()).rejects.toThrow("restarted or changed");
});

it("rejects source disappearance and capture loss", async () => {
  const first = snapshot(10);
  first.compute.push({ ...first.compute[0], sourceId: "second", podId: "second-pod" });
  await expect(fixture([first, snapshot(12)]).run()).rejects.toThrow("inventory changed");
  const failed = snapshot(12);
  failed.compute[0].captureFailures = 1;
  await expect(fixture([snapshot(10), failed]).run()).rejects.toThrow("capture failed");
  const modelFailed = snapshot(12);
  modelFailed.provider.captureFailures = 1;
  await expect(fixture([snapshot(10), modelFailed]).run()).rejects.toThrow("lost capture");
});

it("times out without treating unavailable observation as successful delivery", async () => {
  const busy = snapshot(10);
  busy.compute[0].deliveredCycles = null;
  await expect(fixture([busy]).run()).rejects.toThrow("ledger retained");
  await expect(
    fixture([snapshot(10)]).run({
      readSources: async () => {
        throw new Error("source offline");
      },
    }),
  ).rejects.toThrow("ledger retained");
});

it("does not require a fabricated terminal PG row for a never-metered short lifetime", async () => {
  // The port has only source delivery observations. No ledger row lookup or
  // synthetic terminal receipt is needed to prove the post-disposal sweeps.
  const f = fixture([snapshot(0), snapshot(1), snapshot(2)]);
  expect((await f.run()).verified).toBe(true);
});

it("uses an immutable baseline even if an injected reader reuses its object", async () => {
  const value = snapshot(10);
  let reads = 0;
  const f = fixture([]);
  await f.run({
    readSources: async () => {
      value.compute[0].completedCycles = value.compute[0].deliveredCycles = 10 + reads++;
      return value;
    },
  });
  expect(reads).toBe(3);
});

it("honors cancellation before receipt purge can be authorized", async () => {
  const f = fixture([snapshot(10)]),
    abort = new AbortController();
  abort.abort(new Error("owned cancellation"));
  await expect(f.run({ signal: abort.signal })).rejects.toThrow("owned cancellation");
  expect(f.reads()).toBe(0);
});

it("parses bounded boot-scoped metrics and preserves an unavailable barrier", () => {
  const text = [
    'picloud_resource_metering_collection_cycles_total{boot_id="boot-1",source_id="node-1"} 12',
    'picloud_resource_metering_delivery_barrier{boot_id="boot-1",source_id="node-1"} NaN',
    "picloud_resource_metering_capture_failures_total 0",
  ].join("\n");
  expect(parseComputeDeliveryMetrics(text, "pod-1")).toEqual({
    sourceId: "node-1",
    bootId: "boot-1",
    podId: "pod-1",
    completedCycles: 12,
    deliveredCycles: null,
    captureFailures: 0,
  });
  expect(parseComputeDeliveryMetrics(text.replace(" NaN", " 12"), "pod-1").deliveredCycles).toBe(
    12,
  );
  expect(() =>
    parseComputeDeliveryMetrics(
      text + "\npicloud_resource_metering_collection_cycles_total 13",
      "pod-1",
    ),
  ).toThrow("ambiguous");
  expect(() => parseComputeDeliveryMetrics("", "pod-1")).toThrow("Missing");
});
