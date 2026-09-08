import { afterEach, expect, it, vi } from "vitest";
import { Writable } from "node:stream";

const transport = vi.hoisted(() => ({ streams: [] as ControlledStream[] }));
class ControlledStream extends Writable {
  writes: unknown[] = [];
  callbacks: Array<() => void> = [];
  constructor() {
    super({ objectMode: true, highWaterMark: 1 });
  }
  _write(value: unknown, _encoding: string, done: (error?: Error | null) => void) {
    this.writes.push(value);
    this.callbacks.push(() => {
      this.emit("delivery-report", { count: 1 });
      done();
    });
  }
  deliver() {
    this.callbacks.shift()!();
  }
  async close() {
    if (this.destroyed) return;
    await new Promise<void>((resolve, reject) =>
      this.end((error?: Error) => (error ? reject(error) : resolve())),
    );
  }
}
vi.mock("@platformatic/kafka", () => ({
  Admin: class {
    async listTopics() {
      return ["test"];
    }
    async metadata() {
      return { topics: new Map([["test", { partitionsCount: 4 }]]) };
    }
    async close() {}
  },
  Producer: class {
    asStream() {
      const stream = new ControlledStream();
      transport.streams.push(stream);
      return stream;
    }
    async close() {}
  },
  ProduceAcks: { ALL: -1 },
  ProducerStreamReportModes: { BATCH: "batch" },
  stringSerializers: {},
}));
import { KafkaAcceptedFactBus, kafkaProducerLane } from "../src/kafka-accepted-fact.ts";
import type { AcceptedFact } from "../src/accepted-fact.ts";
import { loadProducerCapacity } from "@pi-cloud/event-log";

const buses: KafkaAcceptedFactBus[] = [];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
afterEach(async () => {
  for (const stream of transport.streams) stream.destroy(new Error("test shutdown"));
  for (const bus of buses.splice(0)) await bus.close().catch(() => undefined);
  transport.streams.length = 0;
});
function fact(sessionId = "a", name = "test"): AcceptedFact {
  return {
    kind: "pi_session_append",
    factId: crypto.randomUUID(),
    scope: {
      tenantId: "tenant",
      sessionId,
      turnId: "turn",
      runId: "run",
      attemptId: "attempt",
      fencingToken: 1,
      piSessionId: sessionId,
      writerId: "attempt",
    },
    piSession: { id: sessionId, lane: "main", writerId: "00000000-0000-4000-8000-000000000001" },
    items: [{ kind: "fact", fact: "name", name, seq: 1 }],
    events: [],
    occurredAt: new Date().toISOString(),
  };
}
async function fixture(capacity = { maximumPendingBytes: 100000, maximumPendingFacts: 32 }) {
  const bus = new KafkaAcceptedFactBus({
    brokers: ["unused"],
    topic: "test",
    clientId: "test",
    partitions: 4,
    replicas: 3,
    retentionMs: 7200000,
    producerLanes: 2,
    capacity,
    closeTimeoutMs: 100,
  });
  buses.push(bus);
  await bus.start();
  return bus;
}

it("waits for drain per lane, not PubAck globally, and preserves duplicate identity", async () => {
  const bus = await fixture(),
    a = fact("a"),
    second = fact("a"),
    b = fact("b");
  expect(kafkaProducerLane("a", 2)).not.toBe(kafkaProducerLane("b", 2));
  const pa = bus.append(a),
    duplicate = bus.append(a),
    pa2 = bus.append(second),
    pb = bus.append(b);
  let acked = false;
  void pa.then(() => {
    acked = true;
  });
  await tick();
  const sa = transport.streams[kafkaProducerLane("a", 2)]!,
    sb = transport.streams[kafkaProducerLane("b", 2)]!;
  expect(sa.writes).toHaveLength(1);
  expect(sb.writes).toHaveLength(1);
  expect(acked).toBe(false);
  sb.deliver();
  await pb;
  expect(acked).toBe(false);
  sa.deliver();
  await Promise.all([pa, duplicate]);
  await tick();
  expect(sa.writes).toHaveLength(2);
  sa.deliver();
  await pa2;
  expect(bus.statistics()).toMatchObject({ pendingFacts: 0, pendingBytes: 0, drainWaits: 3 });
  await bus.close();
});

it("bounds queued and submitted bytes/count, rejects before enqueue and recovers after ACK", async () => {
  const first = fact(),
    bytes = Buffer.byteLength(JSON.stringify(first));
  const bus = await fixture({ maximumPendingBytes: bytes + 10, maximumPendingFacts: 8 });
  const p = bus.append(first);
  await tick();
  await expect(bus.append(fact())).rejects.toMatchObject({
    code: "event_capacity_exhausted",
  });
  expect(bus.statistics()).toMatchObject({ pendingFacts: 1, pendingBytes: bytes });
  transport.streams[kafkaProducerLane("a", 2)]!.deliver();
  await p;
  const next = bus.append(fact());
  await tick();
  transport.streams[kafkaProducerLane("a", 2)]!.deliver();
  await next;
  expect(bus.statistics().pendingBytes).toBe(0);
  const countBus = await fixture({ maximumPendingBytes: 100000, maximumPendingFacts: 1 });
  const held = countBus.append(fact()).catch((e) => e);
  await tick();
  await expect(countBus.append(fact())).rejects.toMatchObject({
    code: "event_capacity_exhausted",
  });
  transport.streams.at(-1)!.destroy(new Error("failure"));
  await held;
});

it("fails pending receipts on stream error or bounded close instead of fabricating delivery", async () => {
  const bus = await fixture();
  const first = bus.append(fact()).catch((e) => e),
    queued = bus.append(fact()).catch((e) => e);
  await tick();
  await expect(bus.close()).rejects.toThrow("close timed out");
  expect(await first).toBeInstanceOf(Error);
  expect(await queued).toBeInstanceOf(Error);
  expect(bus.statistics()).toMatchObject({ pendingFacts: 0, pendingBytes: 0 });
});

it("uses one producer capacity configuration contract", () => {
  expect(loadProducerCapacity({})).toEqual({
    maximumPendingBytes: 67108864,
    maximumPendingFacts: 4096,
  });
  expect(
    loadProducerCapacity({
      PI_CLOUD_KAFKA_PRODUCER_PENDING_BYTES: "1234",
      PI_CLOUD_KAFKA_PRODUCER_PENDING_FACTS: "12",
    }),
  ).toEqual({ maximumPendingBytes: 1234, maximumPendingFacts: 12 });
  expect(() => loadProducerCapacity({ PI_CLOUD_KAFKA_PRODUCER_PENDING_FACTS: "0" })).toThrow();
});
