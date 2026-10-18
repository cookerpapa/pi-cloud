// Review characterization: actual reader, fully substituted native callbacks.
// No broker, native transaction, network interruption or process fault is used.
import { expect, it, vi } from "vitest";
import type { Producer, KafkaJS } from "@confluentinc/kafka-javascript";

const state = vi.hoisted(() => ({ disconnected: false }));
vi.mock("@confluentinc/kafka-javascript", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: {
      KafkaConsumer: class extends EventEmitter {
        constructor(
          readonly options: {
            rebalance_cb(
              error: { code: number },
              assignments: Array<{ topic: string; partition: number }>,
            ): void;
          },
        ) {
          super();
        }
        setDefaultConsumeTimeout() {}
        assign() {}
        resume() {}
        unassign() {}
        connect(_options: unknown, callback: () => void) {
          state.disconnected = false;
          callback();
          this.options.rebalance_cb({ code: 1 }, [{ topic: "review", partition: 0 }]);
        }
        disconnect(callback: () => void) {
          state.disconnected = true;
          callback();
        }
      },
    },
  };
});
import { KafkaPartitionReader } from "../../../packages/event-log/src/kafka-partition-reader.ts";

async function reader() {
  const result = new KafkaPartitionReader({
    brokers: ["unused-review"],
    clientId: "review",
    groupId: "review",
    topic: "review",
    logger: { error() {} } as unknown as KafkaJS.Logger,
    rebalance: async (_error, assignments, methods) => methods.assign(assignments),
    onPosition() {},
  });
  await result.connect();
  result.seedCommitted(new Map([[0, 0n]]));
  return result;
}

it("guards a publication whose send is still pending at reader retirement", async () => {
  const r = await reader(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const producer = {
    sendOffsetsToTransaction: vi.fn<Producer["sendOffsetsToTransaction"]>(),
    commitTransaction: vi.fn<Producer["commitTransaction"]>(),
  };
  const pending = r.commitPublication(0, producer as unknown as Producer, async () => {
    entered.resolve();
    await release.promise;
  });
  void pending.catch(() => {});
  try {
    await entered.promise;
    await r.disconnect();
    release.resolve();
    await expect(pending).rejects.toThrow("Publication owner changed before transaction commit");
    expect(producer.sendOffsetsToTransaction).not.toHaveBeenCalled();
    expect(producer.commitTransaction).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await Promise.allSettled([pending, r.disconnect()]);
  }
});

it("disconnects before an outstanding group transaction callback and then requests commit", async () => {
  const r = await reader(),
    entered = Promise.withResolvers<void>();
  let releaseOffsets: (() => void) | undefined,
    settled = false,
    requestedCommitAfterDisconnect = false;
  const producer = {
    sendOffsetsToTransaction: vi.fn(
      (_offsets: unknown, _consumer: unknown, _timeout: number, done: () => void) => {
        releaseOffsets = done;
        entered.resolve();
      },
    ),
    commitTransaction: vi.fn((_timeout: number, done: () => void) => {
      requestedCommitAfterDisconnect = state.disconnected;
      done();
    }),
  };
  const pending = r
    .commitPublication(0, producer as unknown as Producer, async () => {})
    .finally(() => {
      settled = true;
    });
  void pending.catch(() => {});
  try {
    await entered.promise;
    await r.disconnect();
    expect(state.disconnected).toBe(true);
    expect(settled).toBe(false);
    releaseOffsets!();
    await pending;
    expect(requestedCommitAfterDisconnect).toBe(true);
    process.stdout.write(
      JSON.stringify({
        probe: "reader-transaction-lifetime",
        transport: "substituted-native-callbacks",
        disconnectedWithPublicationPending: true,
        requestedCommitAfterDisconnect: true,
        realBrokerCommitEstablished: false,
      }) + "\n",
    );
  } finally {
    releaseOffsets?.();
    await Promise.allSettled([pending, r.disconnect()]);
  }
});
