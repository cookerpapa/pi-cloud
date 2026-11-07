import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  producers: [] as Array<Record<string, any>>,
  commitFailure: undefined as Error | undefined,
  initialize: undefined as ((producer: Record<string, any>, done: () => void) => void) | undefined,
  abort: undefined as ((done: () => void) => void) | undefined,
}));
vi.mock("@confluentinc/kafka-javascript", () => ({
  default: {
    Producer: class {
      constructor(readonly config: unknown) {
        state.producers.push(this);
      }
      readonly events = new Map<string, (error: Error & { isFatal?: boolean }) => void>();
      on(name: string, listener: (error: Error & { isFatal?: boolean }) => void) {
        this.events.set(name, listener);
      }
      setPollInterval() {}
      beginFailure: Error | undefined;
      connect = vi.fn((_o, cb) => cb());
      initTransactions = vi.fn((_ms, cb) => (state.initialize ? state.initialize(this, cb) : cb()));
      beginTransaction = vi.fn((cb) => cb(this.beginFailure));
      produce = vi.fn();
      commitTransaction = vi.fn((_ms, cb) => cb(state.commitFailure));
      abortTransaction = vi.fn((_ms, cb) => (state.abort ? state.abort(cb) : cb()));
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
  state.initialize = undefined;
  state.abort = undefined;
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
  expect(writer.failureSignal.aborted).toBe(true);
  state.commitFailure = undefined;
  await expect(writer.append(record())).rejects.toThrow("not admitted");
  await writer.start(); // same resolved initialization, never initTransactions again
  expect(state.producers[0]!.produce).toHaveBeenCalledOnce();
  expect(state.producers[0]!.initTransactions).toHaveBeenCalledOnce();
});

it("signals uncertain publication before waiting for Kafka abort cleanup", async () => {
  const writer = fixture();
  await writer.start();
  const abortEntered = Promise.withResolvers<void>();
  let finishAbort!: () => void;
  state.abort = (done) => {
    finishAbort = done;
    abortEntered.resolve();
  };
  state.commitFailure = Error("commit response lost");
  const publication = writer.append(record());
  const rejected = expect(publication).rejects.toThrow("response lost");
  await abortEntered.promise;
  try {
    expect(writer.failureSignal.aborted).toBe(true);
    expect(writer.failureSignal.reason).toBe(state.commitFailure);
    await expect(writer.append(record())).rejects.toThrow("not admitted");
  } finally {
    finishAbort();
    await rejected;
  }
});

it("distinguishes a broker observation from known transaction fencing during model silence", async () => {
  const writer = fixture();
  await writer.start();
  const producer = state.producers[0]!;
  producer.events.get("event.error")!(Error("temporary broker disconnect"));
  expect(writer.failureSignal.aborted).toBe(false);
  const fenced = Object.assign(Error("producer fenced"), { isFatal: true });
  producer.beginFailure = fenced;
  await expect(writer.append(record())).rejects.toThrow("producer fenced");
  expect(writer.failureSignal.reason).toBe(fenced);
  await expect(writer.append(record())).rejects.toThrow("not admitted");
  await writer.start();
  expect(producer.initTransactions).toHaveBeenCalledOnce();
  expect(producer.produce).not.toHaveBeenCalled();
});

it("rejects a delayed old initializer after it fences the newer producer and never starts a producer race", async () => {
  let finishOld!: () => void;
  state.initialize = (producer, done) => {
    if (state.producers.indexOf(producer) === 0) finishOld = done;
    else done();
  };
  let oldAuthorized = true;
  const phases: string[] = [];
  const old = fixture(async (phase) => {
    phases.push(`old:${phase}`);
    if (!oldAuthorized) throw new Error("PG old writer revoked");
  });
  const opening = old.start();
  const rejected = expect(opening).rejects.toThrow("old writer revoked");
  await vi.waitFor(() => expect(finishOld).toBeDefined());
  oldAuthorized = false;
  const current = fixture(async (phase) => {
    phases.push(`current:${phase}`);
  });
  await current.start();
  const latest = state.producers[1]!;
  // The delayed broker initialization takes the same transactional identity.
  // Simulate its documented fencing effect before the stale PG post-check.
  latest.beginFailure = Object.assign(Error("fenced by delayed init"), { isFatal: true });
  finishOld();
  await rejected;
  expect(phases).toEqual([
    "old:before_init",
    "current:before_init",
    "current:after_init",
    "old:after_init",
  ]);
  expect(current.failureSignal.aborted).toBe(false);
  await expect(old.append(record())).rejects.toThrow("not admitted");
  await expect(current.append(record())).rejects.toThrow("fenced by delayed init");
  expect(current.failureSignal.aborted).toBe(true);
  await expect(current.append(record())).rejects.toThrow("not admitted");
  await expect(old.start()).rejects.toThrow("old writer revoked");
  await current.start();
  for (const producer of state.producers) {
    expect(producer.initTransactions).toHaveBeenCalledOnce();
    expect(producer.produce).not.toHaveBeenCalled();
  }
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
