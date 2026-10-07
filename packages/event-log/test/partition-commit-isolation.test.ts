// Actual reader with controlled callbacks; verifies repaired independent commit guards.
import { expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
vi.mock("@confluentinc/kafka-javascript", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: {
      KafkaConsumer: class extends EventEmitter {
        constructor(readonly options: any) {
          super();
        }
        setDefaultConsumeTimeout() {}
        assign() {}
        unassign() {}
        connect(_o: any, callback: any) {
          callback();
          this.options.rebalance_cb({ code: 1 }, [
            { topic: "log", partition: 0 },
            { topic: "log", partition: 1 },
          ]);
        }
        commit(offsets: any) {
          queueMicrotask(() => this.emit("offset.commit", null, offsets));
        }
        disconnect(callback: any) {
          callback();
        }
      },
    },
  };
});
import { KafkaPartitionReader } from "../src/kafka-partition-reader.ts";
async function sample(batchProgress: boolean) {
  const reader = new KafkaPartitionReader({
    brokers: ["fixture"],
    clientId: "fixture",
    groupId: "fixture",
    topic: "log",
    logger: { error() {} } as any,
    rebalance: async (_e, a, f) => f.assign(a),
    onPosition() {},
  });
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  await reader.connect();
  reader.seedCommitted(
    new Map([
      [0, 0n],
      [1, 0n],
    ]),
  );
  const producer = {
    sendOffsetsToTransaction(_o: any, _c: any, _t: any, done: any) {
      done();
    },
    commitTransaction(_t: any, done: any) {
      done();
    },
  } as any;
  const slow = reader.commitPublication(1, producer, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const batch = batchProgress
    ? Promise.all([
        reader.commitOffset({ topic: "log", partition: 0, offset: "1" }),
        reader.commitOffset({ topic: "log", partition: 1, offset: "1" }),
      ])
    : Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
  let completed = false;
  const began = performance.now();
  const other = reader
    .commitPublication(0, producer, async () => {})
    .then(() => {
      completed = true;
      return performance.now() - began;
    });
  await new Promise((r) => setTimeout(r, 120));
  const before = completed;
  release.resolve();
  await slow;
  await batch;
  const delay = await other;
  await reader.disconnect();
  return {
    batchProgress,
    healthyPublicationBeforeSlowRelease: before,
    healthyPublicationMs: delay,
  };
}
it("keeps unrelated publication independent during partition progress", async () => {
  const independent = await sample(false),
    coupled = await sample(true);
  expect(independent.healthyPublicationBeforeSlowRelease).toBe(true);
  expect(coupled.healthyPublicationBeforeSlowRelease).toBe(true);
  if (process.env.PI_CLOUD_REVIEW_OUTPUT)
    await writeFile(
      process.env.PI_CLOUD_REVIEW_OUTPUT,
      JSON.stringify(
        {
          scope:
            "Actual KafkaPartitionReader, controlled native callbacks; no broker/network latency claim",
          independent,
          coupled,
        },
        null,
        2,
      ),
    );
});
