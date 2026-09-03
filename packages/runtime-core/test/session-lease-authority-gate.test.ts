import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase } from "@pi-cloud/database";
import {
  createExecutionLease,
  parseSupervisorToControlMessage,
  type FactChannelOpenMessage,
} from "@pi-cloud/protocol";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExecutionLeaseAuthorityGateError,
  PostgresExecutionLeaseAuthorityGate,
} from "../src/session-lease-authority-gate.ts";
import { PostgresAcceptedFactProgressStore } from "../src/postgres-accepted-fact-progress.ts";

const resources: Array<() => Promise<void>> = [];
const GRANT_ID = "10000000-0000-4000-8000-000000000001";
const EXECUTION_ID = "10000000-0000-4000-8000-000000000002";
const SESSION_ID = "10000000-0000-4000-8000-000000000003";
const TURN_ID = "10000000-0000-4000-8000-000000000004";
const INSTANCE_ID = "10000000-0000-4000-8000-000000000005";
const CONNECTION_ID = "10000000-0000-4000-8000-000000000006";

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

function openMessage(): FactChannelOpenMessage {
  const parsed = parseSupervisorToControlMessage({
    protocolVersion: 1,
    messageId: "10000000-0000-4000-8000-000000000007",
    sentAt: "2026-08-26T00:00:00.000Z",
    type: "fact.channel.open",
    payload: {
      executionLease: createExecutionLease(GRANT_ID, EXECUTION_ID, 1),
      sessionId: SESSION_ID,
      piSession: { id: SESSION_ID, lane: "main" },
      turnId: TURN_ID,
      nextEventSeq: 1,
    },
  });
  if (parsed.type !== "fact.channel.open") throw new Error("Invalid writer open fixture");
  return parsed;
}

describe("PostgresExecutionLeaseAuthorityGate", () => {
  it("admits one FactChannel, accepts both Fact kinds, renews and closes idempotently", async () => {
    const pglite = await PGlite.create();
    const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
    await socket.start();
    const database = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 4,
    });
    resources.push(async () => pglite.close());
    resources.push(async () => socket.stop());
    resources.push(async () => database.destroy());
    await sql`
      create table sessions (
        tenant_id uuid not null,
        id uuid not null,
        pi_session_id text not null,
        pi_session_lane text not null,
        primary key (tenant_id, id)
      )
    `.execute(database);
    await sql`
      create table session_leases (
        session_id uuid primary key,
        lease_id uuid unique not null,
        sandbox_id uuid not null,
        fencing_token bigint not null,
        tenant_id uuid not null,
        project_id uuid not null,
        workspace_id uuid not null,
        run_id uuid not null,
        turn_id uuid not null,
        attempt_id uuid unique not null,
        last_event_seq bigint not null default 0,
        fact_channel_connection_id uuid,
        fact_channel_instance_id uuid,
        fact_channel_valid_until timestamptz,
        valid_until timestamptz not null,
        acquired_at timestamptz not null,
        renewed_at timestamptz not null
      )
    `.execute(database);
    await sql`
      insert into session_leases(
        session_id, lease_id, sandbox_id, fencing_token, tenant_id, project_id, workspace_id,
        run_id, turn_id, attempt_id, valid_until, acquired_at, renewed_at
      ) values (
        ${SESSION_ID}, ${GRANT_ID}, ${SESSION_ID}, 1, ${SESSION_ID}, ${SESSION_ID},
        ${SESSION_ID}, ${SESSION_ID}, ${TURN_ID}, ${EXECUTION_ID},
        '2026-08-26T00:01:00.000Z', '2026-08-26T00:00:00.000Z',
        '2026-08-26T00:00:00.000Z'
      )
    `.execute(database);
    await sql`
      insert into sessions(tenant_id, id, pi_session_id, pi_session_lane)
      values (${SESSION_ID}, ${SESSION_ID}, ${SESSION_ID}, 'main')
    `.execute(database);

    let now = new Date("2026-08-26T00:00:00.000Z");
    const authority = new PostgresExecutionLeaseAuthorityGate({
      database,
      leaseDurationMs: 3_000,
      clock: () => now,
    });
    const scope = await authority.open(openMessage().payload, {
      connectionId: CONNECTION_ID,
      instanceId: INSTANCE_ID,
    });
    expect(scope).toMatchObject({ leaseDurationMs: 3_000 });
    const event = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: "10000000-0000-4000-8000-000000000009",
      sentAt: "2026-08-26T00:00:00.000Z",
      type: "event.publish",
      payload: {
        executionLease: openMessage().payload.executionLease,
        event: {
          schemaVersion: 1,
          eventId: "10000000-0000-4000-8000-000000000010",
          sessionId: SESSION_ID,
          turnId: TURN_ID,
          agentId: "root",
          seq: 1,
          occurredAt: "2026-08-26T00:00:00.000Z",
          type: "assistant.text.delta",
          payload: { text: "hello" },
        },
      },
    });
    if (event.type !== "event.publish") throw new Error("Invalid event fixture");
    const acceptedEvent = authority.accept(scope, { kind: "agent_event", publication: event });
    const acceptedMutation = authority.accept(scope, {
      kind: "pi_session_mutation",
      mutation: {
        schemaVersion: 1,
        mutationId: "10000000-0000-4000-8000-000000000011",
        scope: {
          tenantId: SESSION_ID,
          sessionId: SESSION_ID,
          piSessionId: SESSION_ID,
          piSessionLane: "main",
          turnId: TURN_ID,
          runId: SESSION_ID,
          executionLease: openMessage().payload.executionLease,
        },
        operation: { kind: "projection_barrier" },
        occurredAt: "2026-08-26T00:00:00.000Z",
      },
    });
    expect(acceptedEvent).toMatchObject({
      kind: "agent_event",
      factId: "10000000-0000-4000-8000-000000000010",
    });
    expect(acceptedMutation).toMatchObject({
      kind: "pi_session_mutation",
      factId: "10000000-0000-4000-8000-000000000011",
      piSession: { id: SESSION_ID, lane: "main" },
    });
    expect(() =>
      authority.accept(scope, {
        kind: "pi_session_mutation",
        mutation: {
          schemaVersion: 1,
          mutationId: "10000000-0000-4000-8000-000000000012",
          scope: {
            tenantId: SESSION_ID,
            sessionId: SESSION_ID,
            piSessionId: SESSION_ID,
            piSessionLane: "main",
            turnId: TURN_ID,
            runId: SESSION_ID,
            executionLease: openMessage().payload.executionLease,
          },
          operation: { kind: "move_lane", lane: "sibling", to: null },
          occurredAt: "2026-08-26T00:00:00.000Z",
        },
      }),
    ).toThrow(ExecutionLeaseAuthorityGateError);
    expect(JSON.stringify([acceptedEvent, acceptedMutation])).not.toContain("pcel1_");
    const recorded = await new PostgresAcceptedFactProgressStore(database).recordMany([
      {
        leaseId: scope.leaseId,
        attemptId: scope.attemptId,
        fencingToken: scope.fencingToken,
        channelConnectionId: scope.connectionId,
        channelInstanceId: scope.instanceId,
        acknowledgedThroughSeq: event.payload.event.seq,
      },
    ]);
    expect(recorded.has(CONNECTION_ID)).toBe(true);
    await expect(
      authority.open(openMessage().payload, {
        connectionId: "10000000-0000-4000-8000-000000000008",
        instanceId: INSTANCE_ID,
      }),
    ).rejects.toBeInstanceOf(ExecutionLeaseAuthorityGateError);

    now = new Date("2026-08-26T00:00:01.000Z");
    const renewed = await authority.renewMany([scope]);
    expect(renewed.get(CONNECTION_ID)).toBe(3_000);
    await authority.close(scope);
    await authority.close(scope);
    await expect(
      database
        .selectFrom("session_leases")
        .select([
          "last_event_seq",
          "fact_channel_connection_id",
          "fact_channel_instance_id",
          "fact_channel_valid_until",
        ])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      last_event_seq: "1",
      fact_channel_connection_id: null,
      fact_channel_instance_id: null,
      fact_channel_valid_until: null,
    });
  });
});
