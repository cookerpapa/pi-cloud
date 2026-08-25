import { createDatabase } from "@pi-cloud/database";
import {
  createExecutionGrant,
  parseSupervisorToControlMessage,
  type EventPublishMessage,
} from "@pi-cloud/protocol";
import {
  JetStreamAcceptedAgentEventPublisher,
  JetStreamAgentEventIngestor,
} from "../../../packages/runtime-core/src/jetstream-agent-event-log.ts";
import { PostgresAgentEventAuthority } from "../../../packages/runtime-core/src/agent-event-authority.ts";
import {
  AGENT_EVENT_STREAM_NAME,
  PI_SESSION_MUTATION_STREAM_NAME,
  connectPiCloudJetStream,
  ensurePiCloudStreams,
} from "../../../packages/runtime-core/src/jetstream-runtime.ts";
import { sql } from "kysely";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { DATABASE_URL, NATS_SERVERS } from "./common.mjs";

const baselineEvents = Number(process.env.PI_CLOUD_JETSTREAM_BASELINE_EVENTS ?? "2048");
const batchedEvents = Number(process.env.PI_CLOUD_JETSTREAM_BATCHED_EVENTS ?? "8192");
for (const [name, value] of [
  ["PI_CLOUD_JETSTREAM_BASELINE_EVENTS", baselineEvents],
  ["PI_CLOUD_JETSTREAM_BATCHED_EVENTS", batchedEvents],
] as const) {
  if (!Number.isSafeInteger(value) || value < 256 || value > 65_536) {
    throw new TypeError(`${name} is invalid`);
  }
}

function id(index: number, suffix: number): string {
  return `${String(index).padStart(8, "0")}-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

type AuthoritySeed = Readonly<{
  tenantId: string;
  commandId: string;
  runId: string;
  attemptId: string;
  grantId: string;
  sessionId: string;
  turnId: string;
}>;

function seed(index: number): AuthoritySeed {
  return {
    tenantId: id(index, 1),
    commandId: id(index, 2),
    runId: id(index, 3),
    attemptId: id(index, 4),
    grantId: id(index, 5),
    sessionId: id(index, 6),
    turnId: id(index, 7),
  };
}

function publication(row: AuthoritySeed, round: number): EventPublishMessage {
  const message = parseSupervisorToControlMessage({
    protocolVersion: 1,
    messageId: id(Number(row.runId.slice(0, 8)), 100 + round),
    sentAt: "2026-08-25T00:00:00.000Z",
    type: "event.publish",
    payload: {
      executionGrant: createExecutionGrant(row.grantId, row.attemptId, 1),
      event: {
        schemaVersion: 1,
        eventId: id(Number(row.runId.slice(0, 8)), 200 + round),
        sessionId: row.sessionId,
        turnId: row.turnId,
        agentId: "root",
        seq: 1,
        occurredAt: "2026-08-25T00:00:00.000Z",
        type: "assistant.text.delta",
        payload: { text: "authority-batch-throughput" },
      },
    },
  });
  if (message.type !== "event.publish") throw new Error("Benchmark publication is invalid");
  return message;
}

async function initialize(database: ReturnType<typeof createDatabase>): Promise<void> {
  await sql`
    drop table if exists execution_grants cascade;
    create table execution_grants (
      grant_id uuid primary key,
      execution_id uuid unique not null,
      generation bigint not null,
      tenant_id uuid not null,
      project_id uuid not null,
      workspace_id uuid not null,
      run_id uuid not null,
      session_id uuid unique not null,
      turn_id uuid not null,
      command_id uuid not null,
      sandbox_id uuid not null,
      valid_until timestamptz not null,
      last_event_seq bigint not null default 0,
      acquired_at timestamptz not null default now(),
      renewed_at timestamptz not null default now()
    );
  `.execute(database);
}

async function seedAuthority(
  database: ReturnType<typeof createDatabase>,
  rows: readonly AuthoritySeed[],
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 2_048) {
    const values = JSON.stringify(rows.slice(offset, offset + 2_048));
    await sql`
      with input as (
        select * from jsonb_to_recordset(${values}::jsonb) as item(
          "tenantId" uuid, "commandId" uuid, "runId" uuid, "attemptId" uuid,
          "grantId" uuid, "sessionId" uuid, "turnId" uuid
        )
      )
      insert into execution_grants(
        grant_id, execution_id, generation, tenant_id, project_id, workspace_id,
        run_id, session_id, turn_id, command_id, sandbox_id, valid_until, last_event_seq
      )
      select "grantId", "attemptId", 1, "tenantId", "tenantId", "tenantId",
             "runId", "sessionId", "turnId", "commandId", "tenantId",
             now() + interval '1 hour', 0
        from input;
    `.execute(database);
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        await operation(values[index]!);
      }
    }),
  );
}

const database = createDatabase({ connectionString: DATABASE_URL, maxConnections: 32 });
const runtime = await connectPiCloudJetStream({
  servers: NATS_SERVERS,
  clientName: "pi-cloud-authority-batch-benchmark",
});

try {
  await initialize(database);
  const rows = Array.from({ length: Math.max(baselineEvents, batchedEvents) }, (_, index) =>
    seed(index + 1),
  );
  await seedAuthority(database, rows);
  await runtime.manager.streams.delete(AGENT_EVENT_STREAM_NAME).catch(() => undefined);
  await runtime.manager.streams.delete(PI_SESSION_MUTATION_STREAM_NAME).catch(() => undefined);
  await ensurePiCloudStreams(runtime, {
    replicas: 3,
    eventRetentionMs: 60 * 60_000,
    maximumEventsPerSession: 8_192,
  });
  const publisher = new JetStreamAcceptedAgentEventPublisher(runtime);

  const baselineAuthority = new PostgresAgentEventAuthority({ database });
  let baselineAuthorityTransactions = 0;
  const baselineStartedAt = performance.now();
  await mapConcurrent(
    rows.slice(0, baselineEvents),
    Math.min(128, cpus().length * 8),
    async (row) => {
      const message = publication(row, 1);
      baselineAuthorityTransactions += 1;
      const decision = await baselineAuthority.commitAcceptedMany([message], (accepted) =>
        publisher.appendGroup(accepted),
      );
      if (decision.accepted.length !== 1)
        throw new Error("Per-event authority rejected benchmark data");
    },
  );
  const baselineElapsedMs = performance.now() - baselineStartedAt;

  await sql`update execution_grants set last_event_seq = 0`.execute(database);
  let batchedAuthorityTransactions = 0;
  const batchedAuthority = new PostgresAgentEventAuthority({ database });
  const ingestor = new JetStreamAgentEventIngestor({
    authority: {
      commitAcceptedMany: async (messages, durableCommit) => {
        batchedAuthorityTransactions += 1;
        return batchedAuthority.commitAcceptedMany(messages, durableCommit);
      },
    },
    publisher,
  });
  const batchedStartedAt = performance.now();
  await Promise.all(
    rows.slice(0, batchedEvents).map((row) => ingestor.ingest(publication(row, 2))),
  );
  const batchedElapsedMs = performance.now() - batchedStartedAt;
  const statistics = ingestor.statistics();
  await ingestor.close();

  const report = {
    format: "pi-cloud.jetstream-authority-batch-throughput.v1",
    streamReplicas: 3,
    pubAck: "synchronous-per-event-r3",
    baseline: {
      events: baselineEvents,
      elapsedMs: Number(baselineElapsedMs.toFixed(3)),
      eventsPerSecond: Number(((baselineEvents * 1_000) / baselineElapsedMs).toFixed(2)),
      authorityTransactions: baselineAuthorityTransactions,
      authorityStatements: baselineAuthorityTransactions * 2,
    },
    batched: {
      events: batchedEvents,
      elapsedMs: Number(batchedElapsedMs.toFixed(3)),
      eventsPerSecond: Number(((batchedEvents * 1_000) / batchedElapsedMs).toFixed(2)),
      authorityTransactions: batchedAuthorityTransactions,
      authorityStatements: batchedAuthorityTransactions * 2,
      batches: statistics.batches,
      maximumBatchSize: statistics.maximumBatchSize,
    },
    speedup: Number(
      (
        (batchedEvents * 1_000) /
        batchedElapsedMs /
        ((baselineEvents * 1_000) / baselineElapsedMs)
      ).toFixed(2),
    ),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.send?.(report);
} finally {
  await runtime.connection.close().catch(() => undefined);
  await database.destroy().catch(() => undefined);
}
