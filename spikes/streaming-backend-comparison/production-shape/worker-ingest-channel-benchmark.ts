import fastifyWebsocket from "@fastify/websocket";
import { createDatabase } from "@pi-cloud/database";
import {
  createExecutionGrant,
  parseSupervisorToControlMessage,
  type EventPublishMessage,
} from "@pi-cloud/protocol";
import { AcceptedFactIngestGateway } from "../../../packages/control-plane/src/accepted-fact-ingest-gateway.ts";
import {
  FactChannelService,
  WebSocketAcceptedFactIngestor,
} from "../../../packages/runtime-core/src/jetstream-agent-event-log.ts";
import { PostgresExecutionGrantAuthorityGate } from "../../../packages/runtime-core/src/execution-grant-authority-gate.ts";
import { JetStreamAcceptedFactBus } from "../../../packages/runtime-core/src/jetstream-accepted-fact-bus.ts";
import { PostgresAcceptedFactProgressStore } from "../../../packages/runtime-core/src/postgres-accepted-fact-progress.ts";
import {
  AGENT_EVENT_STREAM_NAME,
  PI_SESSION_MUTATION_STREAM_NAME,
  connectPiCloudJetStream,
  ensurePiCloudStreams,
} from "../../../packages/runtime-core/src/jetstream-runtime.ts";
import { execFileSync } from "node:child_process";
import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { sql } from "kysely";
import { DATABASE_URL, NATS_SERVERS } from "./common.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const composeFile = fileURLToPath(new URL("compose.yaml", import.meta.url));
const serviceToken = "production-shape-worker-ingest-token-v1";

type AuthoritySeed = Readonly<{
  tenantId: string;
  commandId: string;
  runId: string;
  attemptId: string;
  grantId: string;
  sessionId: string;
  turnId: string;
}>;

type BenchmarkCase = Readonly<{
  name: string;
  sessions: number;
  eventsPerSession: number;
  concurrency: number;
  payloadBytes: number;
}>;

function uuid(index: number, suffix: number): string {
  return `${index.toString(16).padStart(8, "0")}-0000-4000-8000-${suffix
    .toString(16)
    .padStart(12, "0")}`;
}

function seed(index: number): AuthoritySeed {
  return {
    tenantId: uuid(index, 1),
    commandId: uuid(index, 2),
    runId: uuid(index, 3),
    attemptId: uuid(index, 4),
    grantId: uuid(index, 5),
    sessionId: uuid(index, 6),
    turnId: uuid(index, 7),
  };
}

function grant(row: AuthoritySeed): string {
  return createExecutionGrant(row.grantId, row.attemptId, 1);
}

function publication(
  row: AuthoritySeed,
  sequence: number,
  payloadBytes: number,
): EventPublishMessage {
  const message = parseSupervisorToControlMessage({
    protocolVersion: 1,
    messageId: uuid(Number.parseInt(row.runId.slice(0, 8), 16), 1_000 + sequence),
    sentAt: "2026-08-26T00:00:00.000Z",
    type: "event.publish",
    payload: {
      executionGrant: grant(row),
      event: {
        schemaVersion: 1,
        eventId: uuid(Number.parseInt(row.runId.slice(0, 8), 16), 10_000 + sequence),
        sessionId: row.sessionId,
        turnId: row.turnId,
        agentId: "root",
        seq: sequence,
        occurredAt: "2026-08-26T00:00:00.000Z",
        type: "assistant.text.delta",
        payload: { text: "x".repeat(payloadBytes) },
      },
    },
  });
  if (message.type !== "event.publish") throw new Error("Benchmark publication is invalid");
  return message;
}

function compose(argumentsList: readonly string[]): string {
  return execFileSync("docker", ["compose", "-f", composeFile, ...argumentsList], {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

function latency(values: readonly number[]) {
  return {
    p50: Number(percentile(values, 0.5).toFixed(3)),
    p95: Number(percentile(values, 0.95).toFixed(3)),
    p99: Number(percentile(values, 0.99).toFixed(3)),
    maximum: Number(Math.max(...values, 0).toFixed(3)),
  };
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
      fact_channel_connection_id uuid,
      fact_channel_instance_id uuid,
      fact_channel_valid_until timestamptz,
      acquired_at timestamptz not null default now(),
      renewed_at timestamptz not null default now()
    );
  `.execute(database);
}

async function seedAuthority(
  database: ReturnType<typeof createDatabase>,
  rows: readonly AuthoritySeed[],
): Promise<void> {
  await sql`truncate execution_grants`.execute(database);
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

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        output[index] = await operation(values[index]!, index);
      }
    }),
  );
  return output;
}

const database = createDatabase({ connectionString: DATABASE_URL, maxConnections: 48 });
const runtime = await connectPiCloudJetStream({
  servers: NATS_SERVERS,
  clientName: "pi-cloud-worker-ingest-channel-benchmark",
});
const fastify = Fastify({ logger: false, bodyLimit: 64 * 1_024 });
let nextSeedIndex = 100_000;
let killedLeaderService: string | undefined;

try {
  await initialize(database);
  await runtime.manager.streams.delete(AGENT_EVENT_STREAM_NAME).catch(() => undefined);
  await runtime.manager.streams.delete(PI_SESSION_MUTATION_STREAM_NAME).catch(() => undefined);
  await ensurePiCloudStreams(runtime, {
    replicas: 3,
    eventRetentionMs: 60 * 60_000,
    maximumEventsPerSession: 8_192,
  });
  const stream = await runtime.manager.streams.info(AGENT_EVENT_STREAM_NAME);
  if (stream.config.num_replicas !== 3 || stream.config.storage !== "file") {
    throw new Error("Worker ingest benchmark requires an R=3 file-backed Stream");
  }

  const service = new FactChannelService({
    authority: new PostgresExecutionGrantAuthorityGate({ database, leaseDurationMs: 30_000 }),
    bus: new JetStreamAcceptedFactBus(runtime),
    progress: new PostgresAcceptedFactProgressStore(database),
    instanceId: uuid(90_000, 1),
    leaseDurationMs: 30_000,
    maximumActiveChannels: 128,
  });
  await fastify.register(fastifyWebsocket, { options: { perMessageDeflate: false } });
  new AcceptedFactIngestGateway({ channels: service, serviceToken }).install(fastify);
  await fastify.listen({ host: "127.0.0.1", port: 0 });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Worker ingest WebSocket Gateway did not bind a TCP port");
  }
  const worker = new WebSocketAcceptedFactIngestor({
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    serviceToken,
    allowInsecureHttp: true,
  });
  await worker.checkHealth();

  const runCase = async (configuration: BenchmarkCase) => {
    const rows = Array.from({ length: configuration.sessions }, () => seed(nextSeedIndex++));
    await seedAuthority(database, rows);
    const first = publication(rows[0]!, 1, configuration.payloadBytes);
    const averageFrameBytes = Buffer.byteLength(JSON.stringify(first), "utf8");
    const startedAt = performance.now();
    const sessionResults = await mapConcurrent(rows, configuration.concurrency, async (row) => {
      const openStartedAt = performance.now();
      const channel = await worker.open({
        executionGrant: grant(row),
        sessionId: row.sessionId,
        turnId: row.turnId,
        nextEventSeq: 1,
      });
      const openMs = performance.now() - openStartedAt;
      const eventLatencies: number[] = [];
      try {
        for (let sequence = 1; sequence <= configuration.eventsPerSession; sequence += 1) {
          const eventStartedAt = performance.now();
          const acknowledgement = await channel.ingest(
            publication(row, sequence, configuration.payloadBytes),
          );
          if (acknowledgement.payload.acknowledgedThroughSeq !== sequence) {
            throw new Error("FactChannel ACK did not match the published sequence");
          }
          eventLatencies.push(performance.now() - eventStartedAt);
        }
      } finally {
        await channel.close();
      }
      return { openMs, eventLatencies };
    });
    const elapsedMs = performance.now() - startedAt;
    const eventLatencies = sessionResults.flatMap((result) => result.eventLatencies);
    const events = configuration.sessions * configuration.eventsPerSession;
    return {
      ...configuration,
      events,
      averageFrameBytes,
      totalFrameMiB: Number(((averageFrameBytes * events) / 1_024 ** 2).toFixed(3)),
      elapsedMs: Number(elapsedMs.toFixed(3)),
      eventsPerSecond: Number(((events * 1_000) / elapsedMs).toFixed(2)),
      frameMiBPerSecond: Number(
        ((averageFrameBytes * events * 1_000) / elapsedMs / 1_024 ** 2).toFixed(2),
      ),
      channelOpenLatencyMs: latency(sessionResults.map((result) => result.openMs)),
      acknowledgementLatencyMs: latency(eventLatencies),
      factChannels: configuration.sessions,
      intentionalBatchDelayMs: 0,
    };
  };

  const leaderOnly = process.env.PI_CLOUD_WRITER_BENCHMARK_LEADER_ONLY === "1";
  if (!leaderOnly) {
    process.stdout.write("stage: warm current FactChannel\n");
    await runCase({
      name: "warmup",
      sessions: 16,
      eventsPerSession: 32,
      concurrency: 16,
      payloadBytes: 1_024,
    });
  }

  const cases: Awaited<ReturnType<typeof runCase>>[] = [];
  for (const configuration of leaderOnly
    ? []
    : ([
        {
          name: "concurrency-1",
          sessions: 1,
          eventsPerSession: 8_192,
          concurrency: 1,
          payloadBytes: 1_024,
        },
        {
          name: "concurrency-16",
          sessions: 16,
          eventsPerSession: 512,
          concurrency: 16,
          payloadBytes: 1_024,
        },
        {
          name: "concurrency-64",
          sessions: 64,
          eventsPerSession: 128,
          concurrency: 64,
          payloadBytes: 1_024,
        },
        {
          name: "concurrency-128",
          sessions: 128,
          eventsPerSession: 64,
          concurrency: 128,
          payloadBytes: 1_024,
        },
        {
          name: "payload-256b",
          sessions: 64,
          eventsPerSession: 128,
          concurrency: 64,
          payloadBytes: 256,
        },
        {
          name: "payload-4kib",
          sessions: 64,
          eventsPerSession: 128,
          concurrency: 64,
          payloadBytes: 4_096,
        },
        {
          name: "256-sessions-128-active",
          sessions: 256,
          eventsPerSession: 32,
          concurrency: 128,
          payloadBytes: 1_024,
        },
        {
          name: "sustained-32k",
          sessions: 256,
          eventsPerSession: 128,
          concurrency: 128,
          payloadBytes: 1_024,
        },
      ] satisfies BenchmarkCase[])) {
    process.stdout.write(`stage: ${configuration.name}\n`);
    cases.push(await runCase(configuration));
  }

  process.stdout.write("stage: Stream Leader loss through current FactChannel\n");
  const leaderBefore = (await runtime.manager.streams.info(AGENT_EVENT_STREAM_NAME)).cluster
    ?.leader;
  const leaderService =
    leaderBefore === undefined
      ? undefined
      : ({ n1: "nats-1", n2: "nats-2", n3: "nats-3" } as const)[leaderBefore as "n1" | "n2" | "n3"];
  if (leaderService === undefined) throw new Error("JetStream leader identity is unavailable");
  compose(["kill", "--signal", "SIGKILL", leaderService]);
  killedLeaderService = leaderService;
  const failoverStartedAt = performance.now();
  const failoverCase = await runCase({
    name: "leader-loss",
    sessions: 64,
    eventsPerSession: 32,
    concurrency: 64,
    payloadBytes: 1_024,
  });
  const replacementLeader = (await runtime.manager.streams.info(AGENT_EVENT_STREAM_NAME)).cluster
    ?.leader;
  compose(["up", "--detach", "--wait", leaderService]);
  killedLeaderService = undefined;

  const report = {
    format: "pi-cloud.worker-websocket-to-jetstream-r3-benchmark.v2",
    generatedAt: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    host: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      logicalCpuCount: cpus().length,
      totalMemoryGiB: Number((totalmem() / 1_024 ** 3).toFixed(2)),
    },
    channel: {
      workerClient: "WebSocketAcceptedFactIngestor",
      gateway: "AcceptedFactIngestGateway/Fastify WebSocket",
      authority: "one short PostgreSQL FactChannel lease per ExecutionGrant",
      batching: "none; one ordered event in flight per Grant",
      durabilityBoundary: "one JetStream file-storage R=3 PubAck per event",
      excluded: ["LLM", "Cube", "SSE", "SessionStorage projector"],
    },
    stream: {
      replicas: stream.config.num_replicas,
      storage: stream.config.storage,
      maximumEventsPerSession: stream.config.max_msgs_per_subject,
    },
    cases,
    service: service.statistics(),
    leaderRecovery: {
      killedLeader: leaderBefore,
      replacementLeader,
      elapsedMs: Number((performance.now() - failoverStartedAt).toFixed(3)),
      delivered: failoverCase.events === 2_048,
      case: failoverCase,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.send?.(report);
  await worker.close();
} finally {
  if (killedLeaderService !== undefined) {
    compose(["up", "--detach", "--wait", killedLeaderService]);
  }
  await fastify.close().catch(() => undefined);
  await runtime.connection.close().catch(() => undefined);
  await database.destroy().catch(() => undefined);
}
