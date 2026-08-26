import type { AcceptedFact, AcceptedTerminalEventFact } from "../src/accepted-fact.ts";
import { kafkaProducerLane } from "../src/kafka-accepted-fact.ts";
import { KafkaLiveSessionTail } from "../src/kafka-live-session-tail.ts";
import { describe, expect, it } from "vitest";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const SESSION_ID = "10000000-0000-4000-8000-000000000002";
const RUN_ID = "10000000-0000-4000-8000-000000000003";
const TURN_ID = "10000000-0000-4000-8000-000000000004";

function delta(): AcceptedFact {
  return {
    kind: "agent_event",
    factId: "10000000-0000-4000-8000-000000000005",
    scope: {
      tenantId: TENANT_ID,
      sessionId: SESSION_ID,
      runId: RUN_ID,
      turnId: TURN_ID,
      executionId: "10000000-0000-4000-8000-000000000006",
      executionGeneration: 1,
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
  };
}

function terminal(): AcceptedTerminalEventFact {
  return {
    kind: "terminal_event",
    factId: "10000000-0000-4000-8000-000000000007",
    scope: { tenantId: TENANT_ID, sessionId: SESSION_ID, runId: RUN_ID, turnId: TURN_ID },
    event: {
      schemaVersion: 1,
      eventId: "10000000-0000-4000-8000-000000000007",
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      agentId: "root",
      seq: 2,
      occurredAt: "2026-08-26T00:00:01.000Z",
      type: "turn.completed",
      payload: { stopReason: "stop" },
    },
    occurredAt: "2026-08-26T00:00:01.000Z",
  };
}

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
    tail.project(completed);
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
});
