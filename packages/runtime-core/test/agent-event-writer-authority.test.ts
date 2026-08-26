import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase } from "@pi-cloud/database";
import {
  createExecutionGrant,
  parseSupervisorToControlMessage,
  type EventWriterOpenMessage,
} from "@pi-cloud/protocol";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentEventWriterAuthorityError,
  PostgresAgentEventWriterAuthority,
} from "../src/agent-event-authority.ts";

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

function openMessage(): EventWriterOpenMessage {
  const parsed = parseSupervisorToControlMessage({
    protocolVersion: 1,
    messageId: "10000000-0000-4000-8000-000000000007",
    sentAt: "2026-08-26T00:00:00.000Z",
    type: "event.writer.open",
    payload: {
      executionGrant: createExecutionGrant(GRANT_ID, EXECUTION_ID, 1),
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      nextEventSeq: 1,
    },
  });
  if (parsed.type !== "event.writer.open") throw new Error("Invalid writer open fixture");
  return parsed;
}

describe("PostgresAgentEventWriterAuthority", () => {
  it("admits one short writer, renews its watermark and closes it idempotently", async () => {
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
      create table execution_grants (
        session_id uuid primary key,
        grant_id uuid unique not null,
        sandbox_id uuid not null,
        generation bigint not null,
        tenant_id uuid not null,
        project_id uuid not null,
        workspace_id uuid not null,
        run_id uuid not null,
        turn_id uuid not null,
        command_id uuid not null,
        execution_id uuid unique not null,
        last_event_seq bigint not null default 0,
        event_writer_connection_id uuid,
        event_writer_instance_id uuid,
        event_writer_valid_until timestamptz,
        valid_until timestamptz not null,
        acquired_at timestamptz not null,
        renewed_at timestamptz not null
      )
    `.execute(database);
    await sql`
      insert into execution_grants(
        session_id, grant_id, sandbox_id, generation, tenant_id, project_id, workspace_id,
        run_id, turn_id, command_id, execution_id, valid_until, acquired_at, renewed_at
      ) values (
        ${SESSION_ID}, ${GRANT_ID}, ${SESSION_ID}, 1, ${SESSION_ID}, ${SESSION_ID},
        ${SESSION_ID}, ${SESSION_ID}, ${TURN_ID}, ${TURN_ID}, ${EXECUTION_ID},
        '2026-08-26T00:01:00.000Z', '2026-08-26T00:00:00.000Z',
        '2026-08-26T00:00:00.000Z'
      )
    `.execute(database);

    let now = new Date("2026-08-26T00:00:00.000Z");
    const authority = new PostgresAgentEventWriterAuthority({
      database,
      leaseDurationMs: 3_000,
      clock: () => now,
    });
    const scope = await authority.open(openMessage(), {
      connectionId: CONNECTION_ID,
      instanceId: INSTANCE_ID,
    });
    expect(scope).toMatchObject({ acknowledgedThroughSeq: 0, leaseDurationMs: 3_000 });
    await expect(
      authority.open(openMessage(), {
        connectionId: "10000000-0000-4000-8000-000000000008",
        instanceId: INSTANCE_ID,
      }),
    ).rejects.toBeInstanceOf(AgentEventWriterAuthorityError);

    now = new Date("2026-08-26T00:00:01.000Z");
    const renewed = await authority.renewMany([{ scope, acknowledgedThroughSeq: 2 }]);
    expect(renewed.get(CONNECTION_ID)).toBe(3_000);
    await authority.close(scope, 2);
    await authority.close(scope, 2);
    await expect(
      database
        .selectFrom("execution_grants")
        .select([
          "last_event_seq",
          "event_writer_connection_id",
          "event_writer_instance_id",
          "event_writer_valid_until",
        ])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      last_event_seq: "2",
      event_writer_connection_id: null,
      event_writer_instance_id: null,
      event_writer_valid_until: null,
    });
  });
});
