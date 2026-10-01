import { beforeEach, expect, it, vi } from "vitest";
import { PublicationNotSentError } from "@pi-cloud/protocol/native-session";
import type { KafkaPartitionReader } from "../src/kafka-partition-reader.ts";

const f = vi.hoisted(() => ({
  producers: [] as Array<{ values: string[]; disconnected: boolean }>,
  initializations: 0,
  failInitialization: new Set<number>(),
  gate: undefined as Promise<void> | undefined,
}));
vi.mock("@confluentinc/kafka-javascript", () => ({
  default: {
    Producer: class {
      values: string[] = [];
      disconnected = false;
      constructor() {
        f.producers.push(this);
      }
      on() {}
      setPollInterval() {}
      connect(_options: unknown, done: (error?: Error) => void) {
        done();
      }
      initTransactions(_timeout: number, done: (error?: Error) => void) {
        const n = ++f.initializations;
        void (f.gate ?? Promise.resolve()).then(() =>
          done(f.failInitialization.has(n) ? new Error("coordinator unavailable") : undefined),
        );
      }
      beginTransaction(done: (error?: Error) => void) {
        done();
      }
      produce(_topic: string, _partition: number, value: Buffer) {
        this.values.push(value.toString());
      }
      abortTransaction(_timeout: number, done: () => void) {
        done();
      }
      disconnect(done: () => void) {
        this.disconnected = true;
        done();
      }
    },
  },
}));
import { KafkaPublicationWriter } from "../src/kafka-publication-writer.ts";

beforeEach(() => {
  f.producers.length = 0;
  f.initializations = 0;
  f.failInitialization.clear();
  f.gate = undefined;
});
function fixture() {
  let current = true;
  const commit = vi.fn(async (_p: number, _producer: unknown, send: () => Promise<void>) => {
    await send();
  });
  const writer = new KafkaPublicationWriter({
    brokers: ["test"],
    clientId: "test",
    topic: "test",
    partition: 0,
    reader: { commitPublication: commit } as unknown as KafkaPartitionReader,
    current: () => current,
  });
  const append = (id: string) => writer.append({ factId: id, sessionId: "session", value: id });
  return {
    writer,
    append,
    commit,
    retire: () => {
      current = false;
    },
  };
}

it("recovers for later control work after both an uncertain commit and failed reinitialization without replaying the record", async () => {
  const t = fixture();
  f.failInitialization.add(2);
  t.commit.mockImplementationOnce(async (_p, _producer, send) => {
    await send();
    throw new Error("commit ACK lost");
  });
  try {
    await t.writer.start();
    await expect(t.append("uncertain")).rejects.toThrow("commit ACK lost");
    await vi.waitFor(() => expect(f.producers[1]?.disconnected).toBe(true));
    await expect(t.append("not-sent")).rejects.toBeInstanceOf(PublicationNotSentError);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await expect(t.append("seal")).resolves.toEqual({ factId: "seal", durable: true });
    expect(f.producers.flatMap((p) => p.values)).toEqual(["uncertain", "seal"]);
  } finally {
    await t.writer.close();
  }
  expect(f.producers.every((p) => p.disconnected)).toBe(true);
});

it("cannot install a producer whose ownership expired during transaction initialization", async () => {
  const t = fixture(),
    gate = Promise.withResolvers<void>();
  f.gate = gate.promise;
  const starting = t.writer.start();
  const result = expect(starting).rejects.toThrow("owner changed");
  await vi.waitFor(() => expect(f.initializations).toBe(1));
  t.retire();
  gate.resolve();
  await result;
  await expect(t.append("late")).rejects.toBeInstanceOf(PublicationNotSentError);
  await t.writer.close();
  expect(f.producers[0]?.disconnected).toBe(true);
  expect(f.producers[0]?.values).toEqual([]);
});

it("rejects buffered work on close without manufacturing a Kafka receipt", async () => {
  const t = fixture();
  await t.writer.start();
  const pending = expect(t.append("buffered")).rejects.toBeInstanceOf(PublicationNotSentError);
  await t.writer.close();
  await pending;
  expect(f.producers[0]?.values).toEqual([]);
});
