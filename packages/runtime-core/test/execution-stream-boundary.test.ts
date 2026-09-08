import { expect, it } from "vitest";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { ExecutionStreamBoundary } from "../src/execution-stream-projection.ts";
import type { AcceptedAgentEventFact } from "../src/accepted-fact.ts";

it("does not turn interleaved closed execution replay into a metadata query per delta", async () => {
  let reads = 0;
  const query = {
    innerJoin() {
      return this;
    },
    select() {
      return this;
    },
    where() {
      return this;
    },
    async executeTakeFirst() {
      reads++;
      return {
        native_writer_id: "writer",
        claimed_at: new Date(),
        output_sealed_at: new Date(),
        output_seal_offset: "10",
      };
    },
  };
  const db = { selectFrom: () => query } as unknown as Kysely<Database>;
  const boundary = new ExecutionStreamBoundary(db);
  const ids = Array.from({ length: 5000 }, () => crypto.randomUUID());
  const sessionId = crypto.randomUUID(),
    turnId = crypto.randomUUID();
  const fact: AcceptedAgentEventFact = {
    kind: "agent_event",
    factId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    scope: {
      tenantId: crypto.randomUUID(),
      sessionId,
      turnId,
      runId: crypto.randomUUID(),
      attemptId: ids[0]!,
      fencingToken: 1,
      piSessionId: sessionId,
      writerId: "writer",
    },
    event: {
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      sessionId,
      turnId,
      agentId: "root",
      seq: 1,
      occurredAt: new Date().toISOString(),
      type: "assistant.text.delta",
      payload: { text: "late" },
    },
  };
  for (let round = 0; round < 2; round++)
    for (const attemptId of ids) {
      expect(
        await boundary.isOpen(
          {
            fact: { ...fact, scope: { ...fact.scope, attemptId } },
            topic: "cache",
            partition: 0,
            offset: 11n,
          },
          false,
        ),
      ).toBe(false);
    }
  expect(reads).toBe(5000);
});
