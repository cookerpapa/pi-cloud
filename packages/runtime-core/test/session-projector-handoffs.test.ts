import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type { PiCloudEvent } from "@pi-cloud/protocol";
import type { ExecutionProjectionResult } from "../src/execution-stream-projection.ts";

const f = vi.hoisted(() => ({
  accept: vi.fn(),
  project: vi.fn(),
  applies: vi.fn(),
  handler: undefined as undefined | ((record: any, current?: () => boolean) => Promise<void>),
}));
vi.mock("@pi-cloud/event-log", () => ({
  KafkaLogConsumer: class {
    constructor(options: { handler: typeof f.handler }) {
      f.handler = options.handler;
    }
    async close() {}
  },
}));
vi.mock("../src/kafka-accepted-fact.ts", () => ({
  ACCEPTED_FACT_TOPIC: "test",
  KafkaAcceptedFactBus: class {
    async close() {}
  },
  kafkaProducerLane: () => 0,
  parseKafkaAcceptedFact: JSON.parse,
}));
vi.mock("../src/execution-publication.ts", () => ({
  ExecutionPublicationBoundary: class {
    accept = f.accept;
  },
}));
vi.mock("../src/execution-stream-projection.ts", async (original) => ({
  ...(await original<typeof import("../src/execution-stream-projection.ts")>()),
  ExecutionStreamProjector: class {
    project = f.project;
    accepts = f.applies;
  },
}));
vi.mock("../src/accepted-fact-terminal-outbox-relay.ts", () => ({
  AcceptedFactTerminalOutboxRelay: class {
    async close() {}
  },
}));
vi.mock("../src/kafka-safe-retention.ts", () => ({
  KafkaSafeRetention: class {
    async close() {}
  },
}));
import { SessionProjector } from "../src/session-projector.ts";

let projector: SessionProjector;
let route: ReturnType<typeof vi.fn>;
beforeEach(() => {
  f.accept.mockReset().mockResolvedValue(true);
  f.project.mockReset().mockResolvedValue(undefined);
  f.applies.mockReset().mockResolvedValue(true);
  route = vi.fn(async () => {});
  projector = new SessionProjector({
    database: {} as Kysely<Database>,
    brokers: ["unused"],
    clientId: "test",
    partitions: 2,
    replicas: 3,
    retentionMs: 7_200_000,
    advertisedBaseUrl: "http://projector",
    toolCommands: { consume: route },
  });
});
afterEach(async () => {
  await projector.close();
});
function event(
  sessionId = "session",
  type: PiCloudEvent["type"] = "assistant.text.delta",
): PiCloudEvent {
  return {
    schemaVersion: 1,
    eventId: "e-" + sessionId,
    sessionId,
    turnId: "turn",
    agentId: "root",
    seq: 1,
    occurredAt: new Date().toISOString(),
    type,
    payload: { text: "visible" },
  } as PiCloudEvent;
}
function record(sessionId = "session", kind = "agent_event", partition = 0) {
  return {
    topic: "test",
    partition,
    offset: 10n,
    fact: { kind, scope: { tenantId: "tenant", sessionId }, event: event(sessionId) },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("Unified Projector handoff boundaries (transport/PG simulated)", () => {
  it("does not expose or route a rejected publication", async () => {
    const display = vi.spyOn(projector.eventHub, "publish");
    f.accept.mockResolvedValue(false);
    await f.handler!(record());
    expect(f.project).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it("waits for seal projection before displaying the terminal or retiring executor state", async () => {
    const commit = deferred<ExecutionProjectionResult>();
    f.project.mockReturnValue(commit.promise);
    const display = vi.spyOn(projector.eventHub, "publish");
    const handling = f.handler!(record("session", "execution_seal"));
    await vi.waitFor(() => expect(f.project).toHaveBeenCalledOnce());
    expect(display).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    commit.resolve({ terminal: event("session", "turn.completed"), canonicalThroughSequence: 1 });
    await handling;
    expect(display).toHaveBeenCalledOnce();
    expect(route).toHaveBeenCalledOnce();
    expect(projector.eventStore.statistics().cachedEvents).toBe(0);
  });

  it("stops a retired partition handler after a PG await, before UI or Tool delivery", async () => {
    const commit = deferred<ExecutionProjectionResult>();
    f.project.mockReturnValue(commit.promise);
    let current = true;
    const display = vi.spyOn(projector.eventHub, "publish");
    const handling = f.handler!(record(), () => current);
    await vi.waitFor(() => expect(f.project).toHaveBeenCalledOnce());
    current = false;
    commit.resolve({});
    await handling;
    expect(display).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
  });

  it("retries the same record after delivery ACK loss without duplicating its live event", async () => {
    route.mockRejectedValueOnce(new Error("lost delivery ACK"));
    const r = record(),
      display = vi.spyOn(projector.eventHub, "publish");
    await expect(f.handler!(r)).rejects.toThrow("lost delivery ACK");
    await f.handler!(r);
    expect(f.project).toHaveBeenCalledTimes(2); // PG idempotency is tested with real PG elsewhere.
    expect(route).toHaveBeenCalledTimes(2);
    expect(display).toHaveBeenCalledOnce();
    expect(route.mock.calls[0]![0]).toEqual(route.mock.calls[1]![0]);
  });

  it("does not put unrelated partition handlers behind a pending owner-delivery ACK", async () => {
    const delivery = deferred<void>();
    route.mockImplementationOnce(() => delivery.promise);
    const a = f.handler!(record("a", "agent_event", 0));
    await vi.waitFor(() => expect(route).toHaveBeenCalledOnce());
    await f.handler!(record("b", "agent_event", 1));
    expect(route).toHaveBeenCalledTimes(2);
    expect(projector.eventStore.snapshot("tenant", "b").events).toHaveLength(1);
    delivery.resolve();
    await a;
  });
});
