import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const identity = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;

function checked(value) {
  assert(
    value &&
      Array.isArray(value.compute) &&
      value.compute.length > 0 &&
      value.compute.length <= 256,
    "Compute source delivery inventory is incomplete",
  );
  const keys = new Set();
  for (const source of value.compute) {
    assert(
      identity(source.sourceId) &&
        identity(source.epoch) &&
        identity(source.podId) &&
        integer(source.checkedAt) &&
        typeof source.healthy === "boolean" &&
        integer(source.resources) &&
        integer(source.pending) &&
        source.pending <= source.resources,
      "Invalid compute delivery evidence",
    );
    assert(!keys.has(source.sourceId), "Duplicate compute source identity");
    keys.add(source.sourceId);
  }
  const quota = value.quota,
    provider = value.provider;
  assert(
    quota && identity(quota.podId) && integer(quota.pending) && integer(quota.pendingClosures),
    "Invalid Workspace delivery evidence",
  );
  assert(
    provider?.version === 1 &&
      identity(provider.bootId) &&
      identity(provider.podId) &&
      integer(provider.pending) &&
      integer(provider.active) &&
      integer(provider.captureFailures),
    "Invalid provider delivery evidence",
  );
  return value;
}

/** This barrier is only for disposable acceptance-ledger cleanup, after product
 * physical settlement. It proves delivery; it never grants VM/Volume deletion. */
export async function waitForOwnedReceiptDelivery({
  tenantId,
  database,
  signal,
  timeoutMs = 180_000,
  readSources,
  monotonicNow = () => performance.now(),
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
}) {
  assert(typeof tenantId === "string" && /^[0-9a-f-]{36}$/.test(tenantId), "Invalid receipt owner");
  assert(
    integer(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600_000,
    "Invalid receipt delivery wait",
  );
  if (!readSources) {
    const { createDeployedSourceDeliveryReader } =
      await import("./source-delivery-observation.mjs");
    readSources = await createDeployedSourceDeliveryReader({ database, tenantId });
  }
  const deadline = monotonicNow() + timeoutMs;
  let baseline,
    quotaReady = 0,
    lastFailure;
  for (;;) {
    signal?.throwIfAborted();
    let current;
    try {
      current = checked(await readSources(signal));
    } catch (error) {
      signal?.throwIfAborted();
      lastFailure = error;
    }
    if (current) {
      baseline ??= structuredClone(current);
      const previous = new Map(baseline.compute.map((row) => [row.sourceId, row]));
      assert.equal(
        current.compute.length,
        previous.size,
        "Compute source inventory changed during delivery drain",
      );
      for (const source of current.compute) {
        const first = previous.get(source.sourceId);
        assert(
          first && source.epoch === first.epoch && source.podId === first.podId,
          "Compute source restarted or changed during delivery drain",
        );
        assert(
          source.checkedAt >= first.checkedAt,
          "Compute observation checkpoint reset during delivery drain",
        );
      }
      assert(
        current.quota.podId === baseline.quota.podId,
        "Workspace source changed during delivery drain",
      );
      assert(
        current.provider.bootId === baseline.provider.bootId &&
          current.provider.podId === baseline.provider.podId &&
          current.provider.captureFailures === baseline.provider.captureFailures,
        "Provider source restarted or lost capture during delivery drain",
      );
      // The current quota endpoint uses separate read views. Two consecutive
      // zero snapshots after Release exclude its one terminal-publication race.
      quotaReady =
        current.quota.pending === 0 && current.quota.pendingClosures === 0 ? quotaReady + 1 : 0;
      const computeReady = current.compute.every(
        (source) => source.healthy && source.pending === 0,
      );
      if (
        computeReady &&
        quotaReady >= 2 &&
        current.provider.pending === 0 &&
        current.provider.active === 0
      ) {
        signal?.throwIfAborted();
        return {
          verified: true,
          tenantId,
          compute: current.compute.map(({ sourceId, epoch, checkedAt, resources }) => ({
            sourceId,
            epoch,
            checkedAt,
            resources,
          })),
          providerBootId: current.provider.bootId,
        };
      }
    } else {
      quotaReady = 0;
    }
    if (monotonicNow() >= deadline)
      throw new Error("Source receipt delivery remains unconfirmed; acceptance ledger retained", {
        cause: lastFailure,
      });
    await sleep(Math.min(1000, Math.max(1, deadline - monotonicNow())), signal);
  }
}
