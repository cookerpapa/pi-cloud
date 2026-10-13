import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  producers: [] as Array<Record<string, any>>,
  commitFailure: undefined as Error | undefined,
}));
vi.mock("@confluentinc/kafka-javascript", () => ({
  default: {
    Producer: class {
      constructor(readonly config: unknown) {
        state.producers.push(this);
      }
      on() {}
      setPollInterval() {}
      connect = vi.fn((_o, cb) => cb());
      initTransactions = vi.fn((_ms, cb) => cb());
      beginTransaction = vi.fn((cb) => cb());
      produce = vi.fn();
      commitTransaction = vi.fn((_ms, cb) => cb(state.commitFailure));
      abortTransaction = vi.fn((_ms, cb) => cb());
      disconnect = vi.fn((cb) => cb());
    },
  },
}));
import { KafkaSessionWriter, sessionTransactionalId } from "../src/kafka-session-writer.ts";
const writers: KafkaSessionWriter[] = [];
afterEach(async () => {
  await Promise.allSettled(writers.splice(0).map((w) => w.close()));
  state.producers.length = 0;
  state.commitFailure = undefined;
});
function fixture(
  authorize: (phase: "before_init" | "after_init") => Promise<void> = async () => {},
) {
  const writer = new KafkaSessionWriter({
    brokers: ["unused"],
    clientId: "worker",
    topic: "log",
    partition: 0,
    tenantId: "tenant",
    sessionId: "physical",
    authorize,
    current: () => true,
  });
  writers.push(writer);
  return writer;
}
const record = () => ({ factId: crypto.randomUUID(), sessionId: "physical", value: "{}" });
it("uses a stable physical-Session identity independently of the Worker incarnation", () => {
  expect(sessionTransactionalId("log", "tenant", "session")).toBe(
    sessionTransactionalId("log", "tenant", "session"),
  );
  for (const args of [
    ["other", "tenant", "session"],
    ["log", "other", "session"],
    ["log", "tenant", "other"],
  ])
    expect(sessionTransactionalId(...(args as [string, string, string]))).not.toBe(
      sessionTransactionalId("log", "tenant", "session"),
    );
});
it("checks PG both before and after producer initialization and never adopts a stale grant", async () => {
  const phases: string[] = [];
  const writer = fixture(async (phase) => {
    phases.push(phase);
    if (phase === "after_init") throw Error("revoked while Kafka initialized");
  });
  await expect(writer.start()).rejects.toThrow("revoked");
  await expect(writer.start()).rejects.toThrow("revoked");
  expect(phases).toEqual(["before_init", "after_init"]);
  expect(state.producers).toHaveLength(1);
  await expect(writer.append(record())).rejects.toThrow("not admitted");
  expect(state.producers[0]!.produce).not.toHaveBeenCalled();
  expect(state.producers[0]!.disconnect).toHaveBeenCalledOnce();
});
it("freezes the writer after an uncertain commit without retrying its batch or initializing again", async () => {
  const writer = fixture();
  await writer.start();
  state.commitFailure = Error("commit reply lost");
  await expect(writer.append(record())).rejects.toThrow("reply lost");
  state.commitFailure = undefined;
  await expect(writer.append(record())).rejects.toThrow("not admitted");
  await writer.start(); // same resolved initialization, never initTransactions again
  expect(state.producers[0]!.produce).toHaveBeenCalledOnce();
  expect(state.producers[0]!.initTransactions).toHaveBeenCalledOnce();
});
it("closing during initialization waits for disposal and never admits queued writes", async () => {
  const gate = Promise.withResolvers<void>();
  const writer = fixture(async (phase) => {
    if (phase === "after_init") await gate.promise;
  });
  const opening = writer.start();
  void opening.catch(() => {});
  await vi.waitFor(() => expect(state.producers).toHaveLength(1));
  const closing = writer.close();
  gate.resolve();
  await closing;
  await expect(opening).rejects.toThrow("changed during initialization");
  await expect(writer.append(record())).rejects.toThrow("not admitted");
  expect(state.producers[0]!.disconnect).toHaveBeenCalledOnce();
});
