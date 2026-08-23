import type { Database } from "@pi-cloud/database";
import type { EventPublishMessage } from "@pi-cloud/protocol";
import type { KafkaAcceptedAgentEventEnvelope } from "../src/kafka-agent-event-log.ts";
import { KafkaLiveEventStore } from "../src/kafka-live-event-store.ts";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";

const IDS = {
  tenant: "10000000-0000-4000-8000-000000000001",
  session: "10000000-0000-4000-8000-000000000002",
  turn: "10000000-0000-4000-8000-000000000003",
  command: "10000000-0000-4000-8000-000000000004",
  run: "10000000-0000-4000-8000-000000000005",
  attempt: "10000000-0000-4000-8000-000000000006",
  lease: "10000000-0000-4000-8000-000000000007",
} as const;

function database(canonicalThrough = 0): Kysely<Database> {
  const query = {
    select() {
      return this;
    },
    where() {
      return this;
    },
    async executeTakeFirst() {
      return { next_event_seq: String(canonicalThrough + 1) };
    },
  };
  return { selectFrom: () => query } as unknown as Kysely<Database>;
}

function accepted(sequence: number, text = `chunk-${String(sequence)}`) {
  const publication: EventPublishMessage = {
    protocolVersion: 1,
    messageId: globalThis.crypto.randomUUID(),
    sentAt: new Date().toISOString(),
    type: "event.publish",
    payload: {
      commandId: IDS.command,
      runId: IDS.run,
      attemptId: IDS.attempt,
      leaseId: IDS.lease,
      fencingToken: 1,
      event: {
        schemaVersion: 1,
        eventId: globalThis.crypto.randomUUID(),
        sessionId: IDS.session,
        turnId: IDS.turn,
        agentId: "root",
        seq: sequence,
        occurredAt: new Date().toISOString(),
        type: "assistant.text.delta",
        payload: { text },
      },
    },
  };
  return {
    schemaVersion: 1,
    tenantId: IDS.tenant,
    publications: [publication],
  } satisfies KafkaAcceptedAgentEventEnvelope;
}

function terminal(sequence: number): KafkaAcceptedAgentEventEnvelope {
  const envelope = accepted(sequence);
  const publication = envelope.publications[0]! as EventPublishMessage;
  return {
    ...envelope,
    publications: [
      {
        ...publication,
        payload: {
          ...publication.payload,
          event: {
            ...publication.payload.event,
            type: "turn.completed",
            payload: { stopReason: "stop" },
          },
        },
      },
    ],
  } as KafkaAcceptedAgentEventEnvelope;
}

describe("KafkaLiveEventStore", () => {
  it("replays only the broker-accepted contiguous suffix", async () => {
    const store = new KafkaLiveEventStore({ database: database() });
    store.append(accepted(1));
    store.append(accepted(2));
    await expect(store.openReplayWindow(IDS.tenant, IDS.session, 0)).resolves.toMatchObject({
      highWaterMark: 2,
      events: [{ seq: 1 }, { seq: 2 }],
    });
    await expect(store.openReplayWindow(IDS.tenant, IDS.session, 1)).resolves.toMatchObject({
      highWaterMark: 2,
      events: [{ seq: 2 }],
    });
  });

  it("deduplicates exact accepted delivery and rejects a conflicting sequence", () => {
    const store = new KafkaLiveEventStore({ database: database() });
    const event = accepted(1);
    store.append(event);
    store.append(event);
    expect(() => store.append(accepted(1, "different"))).toThrow("different content");
  });

  it("expires a cursor evicted from the bounded Gateway projection", async () => {
    const store = new KafkaLiveEventStore({ database: database(), maximumEventsPerSession: 2 });
    store.append(accepted(1));
    store.append(accepted(2));
    store.append(accepted(3));
    await expect(store.openReplayWindow(IDS.tenant, IDS.session, 0)).rejects.toMatchObject({
      code: "cursor_expired",
    });
    await expect(store.openReplayWindow(IDS.tenant, IDS.session, 1)).resolves.toMatchObject({
      highWaterMark: 3,
      events: [{ seq: 2 }, { seq: 3 }],
    });
  });

  it("folds settled fragments into one terminal replay boundary", async () => {
    const store = new KafkaLiveEventStore({ database: database(3) });
    store.append(accepted(1));
    store.append(accepted(2));
    store.append(terminal(3));

    await expect(store.openReplayWindow(IDS.tenant, IDS.session, 1)).rejects.toMatchObject({
      code: "cursor_expired",
    });
    await expect(store.openReplayWindow(IDS.tenant, IDS.session, 2)).resolves.toMatchObject({
      highWaterMark: 3,
      events: [{ seq: 3, type: "turn.completed" }],
    });
  });

  it("ignores an at-least-once batch prefix below a folded terminal boundary", () => {
    const store = new KafkaLiveEventStore({ database: database(3) });
    const first = accepted(1);
    const second = accepted(2);
    const settled = terminal(3);
    store.append(first);
    store.append(second);
    store.append(settled);

    expect(() => {
      store.append(first);
      store.append(second);
      store.append(settled);
    }).not.toThrow();
  });

  it("does not rebuild settled token history into Gateway memory", () => {
    const store = new KafkaLiveEventStore({ database: database(2_000) });
    for (let sequence = 1; sequence <= 2_000; sequence += 2) {
      store.append(accepted(sequence));
      store.append(terminal(sequence + 1));
    }
    expect(store.projectionSize()).toEqual({ sessions: 1, events: 1 });
  });
});
