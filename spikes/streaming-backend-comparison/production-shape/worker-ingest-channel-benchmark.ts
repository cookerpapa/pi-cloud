import { AgentEventIngestGateway } from "../../../packages/control-plane/src/agent-event-ingest-gateway.ts";
import { createDatabase } from "@pi-cloud/database";
import {
  createExecutionGrant,
  parseSupervisorToControlMessage,
  type EventPublishMessage,
} from "@pi-cloud/protocol";
import {
  HttpAgentEventIngestor,
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
      executionGrant: createExecutionGrant(row.grantId, row.attemptId, 1),
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
let authorityTransactions = 0;
let activeAuthorityBatchSizes: number[] | undefined;
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

  const authority = new PostgresAgentEventAuthority({ database });
  const publisher = new JetStreamAcceptedAgentEventPublisher(runtime);
  const ingestor = new JetStreamAgentEventIngestor({
    authority: {
      commitAcceptedMany: async (messages, durableCommit) => {
        authorityTransactions += 1;
        activeAuthorityBatchSizes?.push(messages.length);
        return authority.commitAcceptedMany(messages, durableCommit);
      },
    },
    publisher,
  });
  new AgentEventIngestGateway({ ingestor, serviceToken }).install(fastify);
  await fastify.listen({ host: "127.0.0.1", port: 0 });
  const address = fastify.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Worker ingest HTTP Gateway did not bind a TCP port");
  }
  const worker = new HttpAgentEventIngestor({
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    serviceToken,
    allowInsecureHttp: true,
  });
  await worker.checkHealth();

  const runCase = async (configuration: BenchmarkCase) => {
    const rows = Array.from({ length: configuration.sessions }, () => seed(nextSeedIndex++));
    await seedAuthority(database, rows);
    const first = publication(rows[0]!, 1, configuration.payloadBytes);
    const averageRequestBytes = Buffer.byteLength(JSON.stringify(first), "utf8");
    const beforeTransactions = authorityTransactions;
    const authorityBatchSizes: number[] = [];
    activeAuthorityBatchSizes = authorityBatchSizes;
    const startedAt = performance.now();
    const perSessionLatency = await mapConcurrent(rows, configuration.concurrency, async (row) => {
      const values: number[] = [];
      for (let sequence = 1; sequence <= configuration.eventsPerSession; sequence += 1) {
        const eventStartedAt = performance.now();
        const acknowledgement = await worker.ingest(
          publication(row, sequence, configuration.payloadBytes),
        );
        if (acknowledgement.payload.acknowledgedThroughSeq !== sequence) {
          throw new Error("Worker ingest ACK did not match the published sequence");
        }
        values.push(performance.now() - eventStartedAt);
      }
      return values;
    });
    const elapsedMs = performance.now() - startedAt;
    activeAuthorityBatchSizes = undefined;
    const eventLatencies = perSessionLatency.flat();
    const events = configuration.sessions * configuration.eventsPerSession;
    const transactions = authorityTransactions - beforeTransactions;
    return {
      ...configuration,
      events,
      averageRequestBytes,
      totalRequestMiB: Number(((averageRequestBytes * events) / 1_024 ** 2).toFixed(3)),
      elapsedMs: Number(elapsedMs.toFixed(3)),
      eventsPerSecond: Number(((events * 1_000) / elapsedMs).toFixed(2)),
      requestMiBPerSecond: Number(
        ((averageRequestBytes * events * 1_000) / elapsedMs / 1_024 ** 2).toFixed(2),
      ),
      acknowledgementLatencyMs: latency(eventLatencies),
      authorityTransactions: transactions,
      authorityStatements: transactions * 2,
      eventsPerAuthorityTransaction: Number((events / transactions).toFixed(2)),
      batches: authorityBatchSizes.length,
      maximumBatchSize: Math.max(...authorityBatchSizes),
    };
  };

  process.stdout.write("stage: warm current Worker ingest channel\n");
  await runCase({
    name: "warmup",
    sessions: 512,
    eventsPerSession: 1,
    concurrency: 64,
    payloadBytes: 1_024,
  });

  const cases: Awaited<ReturnType<typeof runCase>>[] = [];
  for (const configuration of [
    {
      name: "concurrency-1",
      sessions: 2_048,
      eventsPerSession: 1,
      concurrency: 1,
      payloadBytes: 1_024,
    },
    {
      name: "concurrency-16",
      sessions: 8_192,
      eventsPerSession: 1,
      concurrency: 16,
      payloadBytes: 1_024,
    },
    {
      name: "concurrency-64",
      sessions: 8_192,
      eventsPerSession: 1,
      concurrency: 64,
      payloadBytes: 1_024,
    },
    {
      name: "concurrency-128",
      sessions: 8_192,
      eventsPerSession: 1,
      concurrency: 128,
      payloadBytes: 1_024,
    },
    {
      name: "payload-256b",
      sessions: 8_192,
      eventsPerSession: 1,
      concurrency: 64,
      payloadBytes: 256,
    },
    {
      name: "payload-4kib",
      sessions: 8_192,
      eventsPerSession: 1,
      concurrency: 64,
      payloadBytes: 4_096,
    },
    {
      name: "256-active-sessions",
      sessions: 256,
      eventsPerSession: 32,
      concurrency: 64,
      payloadBytes: 1_024,
    },
    {
      name: "sustained-32k",
      sessions: 32_768,
      eventsPerSession: 1,
      concurrency: 128,
      payloadBytes: 1_024,
    },
  ] satisfies BenchmarkCase[]) {
    process.stdout.write(`stage: ${configuration.name}\n`);
    cases.push(await runCase(configuration));
  }

  process.stdout.write("stage: Stream Leader loss through current Worker HTTP client\n");
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
    sessions: 2_048,
    eventsPerSession: 1,
    concurrency: 64,
    payloadBytes: 1_024,
  });
  const replacementLeader = (await runtime.manager.streams.info(AGENT_EVENT_STREAM_NAME)).cluster
    ?.leader;
  compose(["up", "--detach", "--wait", leaderService]);
  killedLeaderService = undefined;

  const report = {
    format: "pi-cloud.worker-http-to-jetstream-r3-benchmark.v1",
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
      workerClient: "HttpAgentEventIngestor",
      gateway: "AgentEventIngestGateway/Fastify",
      authority: "PostgreSQL execution_grants SELECT FOR UPDATE + watermark UPDATE",
      batching: "maximum 256 events or 2 ms",
      durabilityBoundary: "JetStream file storage R=3 synchronous PubAck",
      excluded: ["LLM", "Cube", "SSE", "SessionStorage projector"],
    },
    stream: {
      replicas: stream.config.num_replicas,
      storage: stream.config.storage,
      maximumEventsPerSession: stream.config.max_msgs_per_subject,
    },
    cases,
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
  await ingestor.close();
} finally {
  if (killedLeaderService !== undefined) {
    compose(["up", "--detach", "--wait", killedLeaderService]);
  }
  await fastify.close().catch(() => undefined);
  await runtime.connection.close().catch(() => undefined);
  await database.destroy().catch(() => undefined);
}
