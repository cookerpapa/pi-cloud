import { expect, it, vi } from "vitest";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { ExecutionPublicationBoundary } from "../src/execution-publication.ts";
import type { AcceptedAgentEventFact, ExecutionPublication } from "../src/accepted-fact.ts";

function fixture() {
  const scope = {
    tenantId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    writerId: crypto.randomUUID(),
    piSessionId: crypto.randomUUID(),
    fencingToken: 1,
  };
  const permit: ExecutionPublication = {
    scope: { ...scope, leaseId: crypto.randomUUID(), piSessionLane: "main" },
  };
  const execute = vi.fn(async (): Promise<unknown> => ({
    output_publication: permit,
    output_first_topic: null,
    output_first_partition: null,
  }));
  const query = {
    select() {
      return this;
    },
    where() {
      return this;
    },
    executeTakeFirst: execute,
  };
  const boundary = new ExecutionPublicationBoundary({
    selectFrom: () => query,
  } as unknown as Kysely<Database>);
  const fact: AcceptedAgentEventFact = {
    kind: "agent_event",
    scope,
    factId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    event: {
      schemaVersion: 1,
      eventId: crypto.randomUUID(),
      sessionId: scope.sessionId,
      turnId: scope.turnId,
      agentId: "root",
      seq: 1,
      occurredAt: new Date().toISOString(),
      type: "assistant.text.delta",
      payload: { text: "visible" },
    },
  };
  const record = { fact, topic: "test", partition: 0, offset: 10n };
  return { execute, boundary, record, permit };
}

it("accepts the first real fact using committed attribution, without an opening write", async () => {
  const f = fixture();
  expect(await f.boundary.accept(f.record)).toBe(true);
  expect(await f.boundary.accept({ ...f.record, offset: 11n })).toBe(true);
  expect(f.execute).toHaveBeenCalledOnce();
});

it("retains tenant, writer, event identity and partition checks", async () => {
  const f = fixture();
  expect(await f.boundary.accept(f.record)).toBe(true);
  for (const key of ["tenantId", "writerId", "piSessionId", "turnId"] as const)
    expect(
      await f.boundary.accept({
        ...f.record,
        fact: { ...f.record.fact, scope: { ...f.record.fact.scope, [key]: crypto.randomUUID() } },
      }),
    ).toBe(false);
  expect(await f.boundary.accept({ ...f.record, partition: 1 })).toBe(false);
  expect(
    await f.boundary.accept({
      ...f.record,
      fact: { ...f.record.fact, event: { ...f.record.fact.event, sessionId: "other" } },
    }),
  ).toBe(false);
});

it("does not cache missing publication scope and reloads after reset", async () => {
  const f = fixture();
  f.execute.mockResolvedValueOnce(undefined);
  expect(await f.boundary.accept(f.record)).toBe(false);
  expect(await f.boundary.accept(f.record)).toBe(true);
  f.boundary.reset();
  expect(await f.boundary.accept(f.record)).toBe(true);
  expect(f.execute).toHaveBeenCalledTimes(3);
});
