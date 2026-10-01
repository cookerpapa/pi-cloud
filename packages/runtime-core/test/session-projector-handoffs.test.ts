import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type { PiCloudEvent } from "@pi-cloud/protocol";
import type { ExecutionProjectionResult } from "../src/execution-stream-projection.ts";

const f = vi.hoisted(() => ({
  project: vi.fn(),
  applies: vi.fn(),
  observes: vi.fn(),
  parse: vi.fn(),
  start: vi.fn<(resource: string, partitions?: number) => void>(),
  close: vi.fn<(resource: string) => Promise<void>>(),
  decode: undefined as undefined | ((value: Buffer) => any),
  handler: undefined as
    | undefined
    | ((record: any, current?: () => boolean, commit?: () => Promise<boolean>) => Promise<void>),
}));
vi.mock("@pi-cloud/event-log", async (original) => ({
  ...(await original<typeof import("@pi-cloud/event-log")>()),
  KafkaLogConsumer: class {
    constructor(options: { handler: typeof f.handler; decode: typeof f.decode }) {
      f.handler = options.handler;
      f.decode = options.decode;
    }
    async start() {
      f.start("consumer");
    }
    async close() {
      await f.close("consumer");
    }
  },
}));
vi.mock("../src/kafka-accepted-fact.ts", () => ({
  ACCEPTED_FACT_TOPIC: "test",
  kafkaProducerLane: () => 0,
  parseKafkaAcceptedFact: f.parse,
}));
vi.mock("../src/execution-log-topic.ts", () => ({
  ExecutionLogTopic: class {
    async start() {
      f.start("producer");
    }
    async close() {
      await f.close("producer");
    }
  },
}));
vi.mock("../src/execution-stream-projection.ts", async (original) => ({
  ...(await original<typeof import("../src/execution-stream-projection.ts")>()),
  ExecutionStreamProjector: class {
    project = f.project;
    accepts = f.applies;
    observes = f.observes;
  },
}));
vi.mock("../src/accepted-fact-terminal-outbox-relay.ts", () => ({
  AcceptedFactTerminalOutboxRelay: class {
    start() {
      f.start("relay");
    }
    async close() {
      await f.close("relay");
    }
  },
}));
vi.mock("../src/kafka-safe-retention.ts", () => ({
  KafkaSafeRetention: class {
    start(partitions: number) {
      f.start("retention", partitions);
    }
    async close() {
      await f.close("retention");
    }
  },
}));
import { SessionProjector } from "../src/session-projector.ts";
import { toolInvocationFixture } from "./tool-invocation-fixture.ts";
import { toolCommandForFact } from "../src/tool-invocation-fact.ts";

let projector: SessionProjector;
type ToolDelivery = ConstructorParameters<typeof SessionProjector>[0]["toolCommands"]["consume"];
let route: Mock<ToolDelivery>;
let shutdownAsserted = false;
beforeEach(() => {
  shutdownAsserted = false;
  f.close.mockReset().mockResolvedValue(undefined);
  f.start.mockReset();
  f.project.mockReset().mockResolvedValue(undefined);
  f.applies.mockReset().mockResolvedValue(true);
  f.observes.mockReset().mockReturnValue(false);
  f.parse.mockReset().mockImplementation(JSON.parse);
  route = vi.fn<ToolDelivery>(async () => {});
  projector = new SessionProjector({
    database: {} as Kysely<Database>,
    notificationConnectionString: "postgresql://unused/test",
    brokers: ["unused"],
    clientId: "test",
    publicationToken: "test-publication-token",
    partitions: 2,
    replicas: 3,
    retentionMs: 7_200_000,
    advertisedBaseUrl: "http://projector",
    toolCommands: { consume: route, close: () => f.close("tools") },
    subagentCommands: { consume: async () => {}, close: () => f.close("subagents") },
  });
});
afterEach(async () => {
  if (!shutdownAsserted) await projector.close();
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
  it("handles probes on the same consumer without native projection, dispatch or public sequence", async () => {
    const { fact } = toolInvocationFixture();
    const original = { fact, topic: "test", partition: 0, offset: 12n };
    f.observes.mockReturnValue(true);
    await f.handler!(
      original,
      () => true,
      async () => true,
    );
    f.project.mockClear();
    route.mockClear();
    const display = vi.spyOn(projector.eventHub, "publish"),
      observe = vi.spyOn(projector.eventHub, "publishObservation"),
      commit = vi.fn();
    const probe = {
      ...original,
      offset: 13n,
      fact: {
        kind: "path_probe",
        factId: "probe",
        scope: fact.scope,
        occurredAt: new Date().toISOString(),
      },
    };
    await f.handler!(probe, () => true, commit);
    expect(f.project).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(display).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledOnce();
    await f.handler!(probe, () => true, commit);
    expect(observe).toHaveBeenCalledOnce();
    f.observes.mockReturnValue(false);
    await f.handler!({ ...probe, offset: 14n }, () => true, commit);
    expect(observe).toHaveBeenCalledOnce();
  });
  it("projects a combined invocation before dispatch commit and never reissues it on history replay", async () => {
    const { fact } = toolInvocationFixture();
    const r = { fact, topic: "test", partition: 0, offset: 12n };
    const projection = deferred<void>();
    const dispatch = deferred<boolean>();
    const commit = vi.fn(() => dispatch.promise);
    f.project.mockImplementationOnce(() => projection.promise);
    const pending = f.handler!(r, () => true, commit);
    await vi.waitFor(() => expect(f.project).toHaveBeenCalledOnce());
    expect(commit).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    projection.resolve();
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(route).not.toHaveBeenCalled();
    dispatch.resolve(true);
    await pending;
    expect(route).toHaveBeenCalledWith(
      { ...r, fact: toolCommandForFact(fact) },
      expect.any(Function),
    );
    await f.handler!(
      r,
      () => true,
      async () => false,
    );
    expect(f.project).toHaveBeenCalledTimes(2);
    expect(route).toHaveBeenCalledOnce();
  });

  it.each(["projection", "commit", "sealed", "rebalance"])(
    "does not dispatch the combined command across a %s failure",
    async (failure) => {
      const { fact } = toolInvocationFixture();
      const r = { fact, topic: "test", partition: 0, offset: 12n };
      let current = true;
      if (failure === "projection") f.project.mockRejectedValueOnce(new Error("PG unavailable"));
      if (failure === "sealed") f.applies.mockResolvedValueOnce(false);
      const commit = vi.fn(async () => {
        if (failure === "commit") throw new Error("commit unknown");
        if (failure === "rebalance") current = false;
        return true;
      });
      const pending = f.handler!(r, () => current, commit);
      if (failure === "projection" || failure === "commit") await expect(pending).rejects.toThrow();
      else await pending;
      expect(route).not.toHaveBeenCalled();
      if (failure === "projection" || failure === "sealed") expect(commit).not.toHaveBeenCalled();
    },
  );

  it("routes a Tool only after confirmed dispatch commit and skips replayed commands", async () => {
    const commit = deferred<boolean>();
    const r = record("session", "tool_command");
    const handling = f.handler!(
      r,
      () => true,
      () => commit.promise,
    );
    await vi.waitFor(() => expect(f.project).toHaveBeenCalledOnce());
    expect(route).not.toHaveBeenCalled();
    commit.resolve(true);
    await handling;
    expect(route).toHaveBeenCalledOnce();
    await f.handler!(
      r,
      () => true,
      async () => false,
    );
    expect(route).toHaveBeenCalledOnce();
  });

  it("does not route a Tool when its dispatch commit fails", async () => {
    await expect(
      f.handler!(
        record("session", "tool_command"),
        () => true,
        async () => {
          throw new Error("commit lost");
        },
      ),
    ).rejects.toThrow("commit lost");
    expect(route).not.toHaveBeenCalled();
  });
  it("uses the producer-verified partition count without a second offset query at startup", async () => {
    await projector.start();
    expect(f.start.mock.calls).toEqual([["producer"], ["consumer"], ["relay"], ["retention", 2]]);
  });
  it("closes every owner after a failed relay/consumer drain and shares concurrent shutdown", async () => {
    const relayFailure = new Error("Relay drain failed"),
      consumerFailure = new Error("Consumer close failed");
    f.close.mockImplementation(async (resource) => {
      if (resource === "relay") throw relayFailure;
      if (resource === "consumer") throw consumerFailure;
    });
    const viewClose = vi.spyOn(projector.eventStore, "close");
    const first = projector.close(),
      second = projector.close();
    const results = await Promise.allSettled([first, second]);
    shutdownAsserted = true;
    expect(first).toBe(second);
    expect(results[0]).toMatchObject({
      status: "rejected",
      reason: { errors: [relayFailure, consumerFailure] },
    });
    expect(f.close.mock.calls.map(([resource]) => resource)).toEqual([
      "relay",
      "consumer",
      "tools",
      "subagents",
      "retention",
      "producer",
    ]);
    expect(viewClose).toHaveBeenCalledOnce();
  });
  it("decodes once and passes the same decoded record to projections without JSON round trips", async () => {
    const r = record();
    r.fact = f.decode!(Buffer.from(JSON.stringify(r.fact)));
    expect(f.parse).toHaveBeenCalledOnce();
    Object.defineProperty(r.fact, "toJSON", {
      value: () => {
        throw new Error("Decoded facts must not be reserialized");
      },
    });
    await f.handler!(r);
    expect(f.parse).toHaveBeenCalledOnce();
    expect(f.project.mock.calls[0]![0]).toBe(r);
    expect(route.mock.calls[0]![0]).toBe(r);
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

  it("retries seal delivery after ACK loss without duplicating its live terminal", async () => {
    route.mockRejectedValueOnce(new Error("lost delivery ACK"));
    f.project.mockResolvedValue({
      terminal: event("session", "turn.completed"),
      canonicalThroughSequence: 1,
    });
    const r = record("session", "execution_seal"),
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
