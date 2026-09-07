import type {
  AcceptedFact,
  AcceptedExecutionSealFact,
  AcceptedExecutionCommitFact,
  AcceptedAgentEventFact,
} from "../src/accepted-fact.ts";
import { kafkaProducerLane } from "../src/kafka-accepted-fact.ts";
import { KafkaLiveSessionTail } from "../src/kafka-live-session-tail.ts";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { KafkaAcceptedFactConsumer } from "../src/kafka-accepted-fact-consumer.ts";
import { executionCommitId } from "../src/execution-stream-commit.ts";
const database = new Proxy(
  {},
  {
    get() {
      throw new Error("Gateway must not query PG for seal/commit");
    },
  },
) as Kysely<Database>;

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "10000000-0000-4000-8000-000000000002";
const RUN_ID = "10000000-0000-4000-8000-000000000003";
const TURN_ID = "10000000-0000-4000-8000-000000000004";

function delta() {
  return {
    kind: "agent_event",
    factId: "10000000-0000-4000-8000-000000000005",
    scope: {
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      turnId: TURN_ID,
      attemptId: "10000000-0000-4000-8000-000000000006",
      fencingToken: 1,
    },
    event: {
      schemaVersion: 1,
      eventId: "10000000-0000-4000-8000-000000000005",
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      agentId: "root",
      seq: 1,
      occurredAt: "2026-08-26T00:00:00.000Z",
      type: "assistant.text.delta",
      payload: { text: "durable prefix" },
    },
    occurredAt: "2026-08-26T00:00:00.000Z",
  } satisfies AcceptedAgentEventFact;
}

function terminal(): AcceptedExecutionSealFact {
  return {
    kind: "execution_seal",
    factId: "10000000-0000-4000-8000-000000000007",
    scope: delta().scope,
    baseSequence: 0,
    agentId: "root",
    terminal: { type: "turn.completed", payload: { stopReason: "stop" } },
    occurredAt: "2026-08-26T00:00:01.000Z",
  };
}

function committed(seal = terminal(), seq = 2, offset = "1"): AcceptedExecutionCommitFact {
  return {
    kind: "execution_committed",
    factId: executionCommitId(seal.factId),
    scope: seal.scope,
    seal: { factId: seal.factId, topic: "unused", partition: 0, offset },
    event: {
      schemaVersion: 1,
      eventId: seal.factId,
      sessionId: seal.scope.sessionId,
      turnId: seal.scope.turnId,
      agentId: seal.agentId,
      seq,
      occurredAt: seal.occurredAt,
      ...seal.terminal,
    },
    occurredAt: seal.occurredAt,
  };
}
const record = (fact: AcceptedFact, offset: bigint) => ({
  fact,
  topic: "unused",
  partition: 0,
  offset,
});
const createTail = () =>
  new KafkaLiveSessionTail({
    database,
    brokers: ["127.0.0.1:1"],
    topic: "unused",
    clientId: "test",
    instanceId: "test",
  });

describe("Kafka Gateway live Session tail", () => {
  it("pins one Session to one bounded producer lane", () => {
    const lane = kafkaProducerLane(SESSION_ID, 4);
    expect(lane).toBe(kafkaProducerLane(SESSION_ID, 4));
    expect(lane).toBeGreaterThanOrEqual(0);
    expect(lane).toBeLessThan(4);
    expect(() => kafkaProducerLane(SESSION_ID, 0)).toThrow(/invalid/u);
  });

  it("deduplicates, snapshots immutably and unloads only after terminal canonical state", async () => {
    const tail = new KafkaLiveSessionTail({
      database,
      brokers: ["127.0.0.1:1"],
      topic: "unused",
      clientId: "test",
      instanceId: "test",
    });
    const subscription = tail.eventHub.subscribe(TENANT_ID, SESSION_ID);
    const first = delta();
    tail.project(first);
    tail.project(first);
    const immutableSnapshot = tail.snapshot(TENANT_ID, SESSION_ID);
    expect(immutableSnapshot.events).toHaveLength(1);
    expect((await subscription.next())?.event?.eventId).toBe(first.factId);

    const completed = terminal();
    await tail.projectRecord({ fact: completed, topic: "unused", partition: 0, offset: 1n });
    expect(tail.statistics().pendingCommitSessions).toBe(1);
    expect(tail.snapshot(TENANT_ID, SESSION_ID).events).toHaveLength(1);
    await tail.projectRecord(record(committed(), 2n));
    expect((await subscription.next())?.event?.eventId).toBe(completed.factId);
    expect(tail.snapshot(TENANT_ID, SESSION_ID)).toMatchObject({
      canonicalThroughSequence: 2,
      events: [],
    });
    // Removing the shared index never mutates a snapshot already owned by an
    // in-flight HTTP response.
    expect(immutableSnapshot.events).toHaveLength(1);
    expect(tail.statistics()).toMatchObject({ duplicateEvents: 1, evictedEvents: 2 });
    subscription.close();
  });

  it("buffers successor output without blocking another Session or leaking late old results", async () => {
    const tail = createTail(),
      a = tail.eventHub.subscribe(TENANT_ID, SESSION_ID),
      a2 = tail.eventHub.subscribe(TENANT_ID, SESSION_ID);
    tail.project(delta());
    await a.next();
    await a2.next();
    await tail.projectRecord(record(terminal(), 1n));
    await tail.projectRecord(record(terminal(), 2n)); // duplicate before ACK
    const next = delta();
    if (next.kind !== "agent_event") throw new Error("fixture");
    const successor = {
      ...next,
      factId: crypto.randomUUID(),
      event: { ...next.event, eventId: crypto.randomUUID(), seq: 3 },
    };
    tail.project(successor);
    await tail.projectRecord(
      record({ ...next, event: { ...next.event, seq: 9, payload: { text: "late" } } }, 3n),
    );
    expect(tail.snapshot(TENANT_ID, SESSION_ID).events).toHaveLength(1);
    const bId = crypto.randomUUID(),
      b = tail.eventHub.subscribe(TENANT_ID, bId);
    tail.project({
      ...next,
      scope: { ...next.scope, sessionId: bId },
      event: { ...next.event, sessionId: bId },
    });
    expect((await b.next())?.event?.sessionId).toBe(bId);
    await tail.projectRecord(record(committed(), 5n));
    for (const sub of [a, a2]) {
      expect((await sub.next())?.event?.seq).toBe(2);
      expect((await sub.next())?.event?.seq).toBe(3);
      sub.close();
    }
    await tail.projectRecord(record(terminal(), 6n));
    await tail.projectRecord(record(committed(), 7n));
    expect(tail.statistics().pendingCommitSessions).toBe(0);
    expect(tail.snapshot(TENANT_ID, SESSION_ID).events.map((e) => e.seq)).toEqual([3]);
    b.close();
  });

  it("keeps two pending seals ordered even when acknowledgements arrive in reverse order", async () => {
    const tail = createTail(),
      sub = tail.eventHub.subscribe(TENANT_ID, SESSION_ID);
    tail.project(delta());
    await sub.next();
    const first = terminal(),
      second = {
        ...terminal(),
        factId: crypto.randomUUID(),
        baseSequence: 2,
        scope: { ...first.scope, attemptId: crypto.randomUUID(), turnId: crypto.randomUUID() },
      };
    await tail.projectRecord(record(first, 1n));
    const next = delta();
    if (next.kind !== "agent_event") throw new Error("fixture");
    tail.project({ ...next, event: { ...next.event, eventId: crypto.randomUUID(), seq: 3 } });
    await tail.projectRecord(record(second, 3n));
    await tail.projectRecord(record(committed(second, 4, "3"), 4n));
    expect(tail.snapshot(TENANT_ID, SESSION_ID).events.map((e) => e.seq)).toEqual([1]);
    await tail.projectRecord(record(committed(first), 5n));
    for (const seq of [2, 3, 4]) expect((await sub.next())?.event?.seq).toBe(seq);
    expect(tail.statistics()).toMatchObject({ pendingCommitSessions: 0, pendingCommitBytes: 0 });
    sub.close();
  });

  it("can consume a self-contained commit after recovery has skipped its original seal", async () => {
    const tail = createTail();
    await tail.projectRecord(record(committed(), 4n));
    expect(tail.snapshot(TENANT_ID, SESSION_ID)).toMatchObject({
      canonicalThroughSequence: 2,
      events: [],
    });
    await tail.projectRecord(record(terminal(), 5n));
    expect(tail.statistics().pendingCommitSessions).toBe(0);
  });

  it("resnapshots on bounded pending-display overflow instead of pausing before its ACK", async () => {
    const replay = vi.spyOn(KafkaAcceptedFactConsumer.prototype, "requestReplay");
    const tail = createTail(),
      sub = tail.eventHub.subscribe(TENANT_ID, SESSION_ID);
    await tail.projectRecord(record(terminal(), 1n));
    const next = delta();
    if (next.kind !== "agent_event") throw new Error("fixture");
    tail.project({
      kind: "pi_session_mutation",
      factId: crypto.randomUUID(),
      scope: next.scope,
      piSession: { id: SESSION_ID, lane: "main" },
      occurredAt: next.occurredAt,
      operation: { kind: "set_name", name: "overflow" },
      events: [
        { ...next.event, seq: 3, payload: { text: "x".repeat(8 * 1024 * 1024) } },
        { ...next.event, seq: 4, payload: { text: "must wait for replay too" } },
      ],
    });
    expect(replay).toHaveBeenCalledOnce();
    expect(tail.snapshot(TENANT_ID, SESSION_ID).events).toEqual([]);
    expect((await sub.next())?.throughSequence).toBeNull();
    expect(tail.statistics()).toMatchObject({
      pendingCommitSessions: 0,
      pendingCommitBytes: 0,
      pendingCommitReplays: 1,
    });
    sub.close();
    replay.mockRestore();
  });

  it("projects public events carried by one atomic Pi Session checkpoint Fact", async () => {
    const tail = new KafkaLiveSessionTail({
      database,
      brokers: ["127.0.0.1:1"],
      topic: "unused",
      clientId: "test",
      instanceId: "test",
    });
    const event = {
      schemaVersion: 1 as const,
      eventId: "10000000-0000-4000-8000-000000000008",
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      agentId: "root",
      seq: 2,
      occurredAt: "2026-08-26T00:00:01.000Z",
      type: "model.sampling.completed" as const,
      payload: {
        stepSequence: 1,
        stepSha256: "a".repeat(64),
        samplingAttempt: 1,
        outcome: "completed" as const,
        stopReason: "toolUse" as const,
      },
    };
    tail.project({
      kind: "pi_session_mutation",
      factId: "10000000-0000-4000-8000-000000000009",
      scope: {
        tenantId: TENANT_ID,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        turnId: TURN_ID,
        attemptId: "10000000-0000-4000-8000-000000000010",
        fencingToken: 1,
      },
      piSession: { id: SESSION_ID, lane: "main" },
      operation: { kind: "set_name", name: "test" },
      events: [event],
      occurredAt: event.occurredAt,
    });
    expect(tail.snapshot(TENANT_ID, SESSION_ID).events).toEqual([event]);
  });
});
