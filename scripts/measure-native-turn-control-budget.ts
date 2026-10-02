/** Isolated, deterministic no-Tool Pi Turn. No model-service or VM latency claim. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import kafkaNative from "@confluentinc/kafka-javascript";
import { Admin } from "@platformatic/kafka";
import Fastify from "fastify";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../packages/database/src/index.ts";
import { PostgresNativeSessionHost } from "../packages/pi-session-postgres/src/index.ts";
import { CloudAgentRuntime } from "../packages/sandbox-supervisor/src/cloud-agent-runtime.ts";
import {
  EventStream,
  type AssistantMessageEvent,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import { SessionProjector } from "../packages/runtime-core/src/session-projector.ts";
import { HttpPublicationClient } from "../packages/runtime-core/src/http-publication-client.ts";
import { WorkerExecutionLog } from "../packages/runtime-core/src/worker-execution-log.ts";
import { NativeSessionLogPublisher } from "../packages/runtime-core/src/native-session-log-publisher.ts";
import { SessionPublicationService } from "../packages/control-plane/src/session-publication-service.ts";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { createTestWorker } from "../packages/control-plane/test/admit-test-execution.ts";
import { InputQueueView } from "../packages/control-plane/src/input-queue-view.ts";
import { readInputQueue } from "../packages/control-plane/src/input-queue-snapshot.ts";
import { QueuedInputService } from "../packages/control-plane/src/queued-input-service.ts";
import { SubagentController } from "../packages/control-plane/src/subagent-controller.ts";
import { SandboxBindingView } from "../packages/sandbox-control/src/sandbox-binding-view.ts";
import { PostgresSandboxBindings } from "../packages/sandbox-control/src/sandbox-bindings.ts";

const endpoint = process.env.PI_CLOUD_REVIEW_DATABASE_URL!,
  brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",") ?? [];
assert(endpoint && ["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname));
assert(
  brokers.length === 3 && brokers.every((b) => /^127\.0\.0\.1:19\d{3}$/.test(b)),
  "Use the isolated RF3 fixture",
);
const samples = Number(process.env.PI_CLOUD_REVIEW_TURNS ?? 6);
assert(Number.isInteger(samples) && samples >= 2 && samples <= 32);
const name = `turn_budget_${randomUUID().replaceAll("-", "")}`,
  topic = `turn-budget-${randomUUID()}`;
const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
await sql`create database ${sql.id(name)}`.execute(admin);
const url = new URL(endpoint);
url.pathname = `/${name}`;
url.searchParams.set("application_name", "turn-budget-app");
const db = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
const observerUrl = new URL(url);
observerUrl.searchParams.set("application_name", "turn-budget-observer");
const observer = createDatabase({ connectionString: observerUrl.toString(), maxConnections: 1 });
const kafka = new Admin({ clientId: topic, bootstrapBrokers: brokers });
const server = Fastify({ logger: false }),
  token = randomUUID();
server.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer", bodyLimit: 4 * 1024 * 1024 },
  (_r, b, done) => done(null, b),
);
let projector: SessionProjector | undefined;
let closeRuntime: (() => Promise<void>) | undefined;
let counters:
  | {
      sql: number;
      transactions: number;
      nativeRows: number;
      kafkaRecords: number;
      kafkaBytes: number;
      kafkaTransactions: number;
      kinds: Record<string, number>;
      sqlVerbs: Record<string, number>;
    }
  | undefined;
const query = Client.prototype.query;
(Client.prototype as any).query = function (...args: any[]) {
  if (
    counters &&
    this.connectionParameters.database === name &&
    this.connectionParameters.application_name !== "turn-budget-observer"
  ) {
    counters.sql++;
    const verb = String(typeof args[0] === "string" ? args[0] : args[0]?.text)
      .trim()
      .split(/\s/)[0]!
      .toLowerCase();
    counters.sqlVerbs[verb] = (counters.sqlVerbs[verb] ?? 0) + 1;
    if (["begin", "start"].includes(verb)) counters.transactions++;
  }
  return Reflect.apply(query, this, args);
};
const produce = kafkaNative.Producer.prototype.produce,
  commit = kafkaNative.Producer.prototype.commitTransaction;
(kafkaNative.Producer.prototype as any).produce = function (...args: any[]) {
  if (counters && args[0] === topic) {
    counters.kafkaRecords++;
    counters.kafkaBytes += args[2].length;
    const kind = JSON.parse(args[2].toString()).kind;
    counters.kinds[kind] = (counters.kinds[kind] ?? 0) + 1;
  }
  return Reflect.apply(produce, this, args);
};
(kafkaNative.Producer.prototype as any).commitTransaction = function (...args: any[]) {
  if (counters) counters.kafkaTransactions++;
  return Reflect.apply(commit, this, args);
};
const until = async (check: () => Promise<boolean> | boolean) => {
  const deadline = Date.now() + 30000;
  while (!(await check())) {
    assert(Date.now() < deadline, "settlement timed out");
    await delay(10);
  }
};
const model: Model<"openai-responses"> = {
  id: "gpt-6-luna",
  name: "Deterministic fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "http://unused",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 65536,
  maxTokens: 8192,
};
const consumedControls = new Set<string>();
const report: any = {
  format: "pi-cloud.native-turn-budget.v1",
  revision: process.env.PI_CLOUD_REVIEW_REVISION ?? "worktree",
  scope:
    "complete no-Tool Pi Turns with deterministic provider, actual PG/HTTP/RF3/control projection; no VM or provider latency",
  samples: [],
};
try {
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: name.replaceAll("_", "-"),
    ownerDisplayName: "Turn budget",
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const project = await store.createProject({ name: "Budget", source: { kind: "empty" } });
  await db
    .updateTable("environment_versions")
    .set({ state: "validated", validated_at: new Date() })
    .where("id", "=", project.environment.environmentVersionId)
    .execute();
  const worker = await createTestWorker(db);
  let queues!: InputQueueView;
  const createProjector = (baseUrl: string) => {
    const bindings = new SandboxBindingView({
      source: new PostgresSandboxBindings(
        db,
        "sandbox-domain-0001",
        randomUUID(),
        baseUrl,
        async () => {},
      ),
      partitionFor: () => 0,
      partitionCount: 1,
    });
    const inputs = new QueuedInputService({
      database: db,
      steering: {
        deliverQueued: async () => {
          throw new Error("Unexpected Steer");
        },
      },
      autoStart: true,
    });
    inputs.onModuleInit();
    const subagents = new SubagentController({
      database: db,
      managementToken: token,
      allowInsecureHttp: true,
      ownsPartition: (p) => projector?.ownsPartition(p) === true,
    });
    queues = new InputQueueView({
      read: (t, s) => readInputQueue(db, t, s),
      watched: () => true,
      publish: () => {},
      unavailable: () => {},
    });
    const p = new SessionProjector({
      database: db,
      notificationConnectionString: url.toString(),
      brokers,
      clientId: topic,
      topic,
      partitions: 1,
      replicas: 3,
      retentionMs: 600000,
      advertisedBaseUrl: baseUrl,
      publicationToken: token,
      toolCommands: { consume: async () => {} },
      subagentCommands: {
        consume: async (record, current) => {
          await subagents.consume(record, current);
          if (record.fact.kind === "execution_seal" && current?.() !== false)
            inputs.notifySession(record.fact.scope.tenantId, record.fact.scope.sessionId);
        },
      },
      controlChanges: {
        load: async (parts, current) => {
          await bindings.load(parts, current);
          await subagents.recover(parts, current);
          await inputs.recoverPending({ partitions: parts, partitionCount: 1, current });
        },
        reset: () => {
          bindings.reset();
          queues.reset();
          subagents.reset();
        },
        prepare: (change, current) => bindings.prepare(change, current),
        consume: async (change, current) => {
          await bindings.consume(change, current);
          await subagents.changed(change, current);
          if (current() && change.entity === "input_queue")
            inputs.notifySession(
              change.scope.tenantId,
              change.entityId,
              change.steerPending === true,
            );
          await queues.consume(change, current);
          if (current()) consumedControls.add(change.factId);
        },
      },
    });
    closeRuntime = async () => {
      await p.close();
      await inputs.onApplicationShutdown();
      await subagents.close();
    };
    return p;
  };
  // Both revisions expose this service; forwarding preserves replacement ownership.
  new SessionPublicationService(
    token,
    new Proxy({} as SessionProjector, {
      get(_target, key) {
        const member = (projector as any)?.[key];
        return typeof member === "function" ? member.bind(projector) : member;
      },
    }),
  ).install(server);
  const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 });
  projector = createProjector(baseUrl);
  await projector.start();
  await until(() => projector!.ownsPartition(0));
  const client = new HttpPublicationClient({ baseUrl, token }),
    logs = new WorkerExecutionLog(db, client);
  const host = new PostgresNativeSessionHost({ database: db });
  const publisher = new NativeSessionLogPublisher({ channels: logs });
  try {
    const executor = worker.executor({
      execute: async (request, _lifecycle, grant) => {
        assert(grant);
        const scope = {
          tenantId: request.tenantId,
          sessionId: request.sessionId,
          piSessionId: request.piSessionId,
          piSessionLane: request.piSessionLane,
          turnId: request.turnId,
          runId: request.runId,
        };
        const writerId = grant.publication.scope.writerId;
        const channel = await logs.open({
          executionReference: grant.executionReference,
          sessionId: request.sessionId,
          turnId: request.turnId,
          nextEventSeq: Number(request.nextEventSeq),
          piSession: { id: request.piSessionId, lane: request.piSessionLane, writerId },
          publication: grant.publication,
        });
        const session = await host.open({
          scope,
          writerId,
          executionReference: grant.executionReference,
          publisher: publisher.scoped({
            ...scope,
            writerId,
            executionReference: grant.executionReference,
          }),
        });
        try {
          const runtime = new CloudAgentRuntime({
            session: session.session,
            lane: session.lane,
            authority: session.authority,
            idGenerator: () => session.session.idGenerator.next(),
            model,
            systemPrompt: "Deterministic budget fixture",
            compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
            commitCheckpoint: async (operation) => {
              await session.mutationPublisher.mutate(operation);
            },
            streamFn: () => {
              const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
                (e) => e.type === "done" || e.type === "error",
                (e) => {
                  if (e.type === "done") return e.message;
                  if (e.type === "error") return e.error;
                  throw new Error("event");
                },
              );
              const message: AssistantMessage = {
                role: "assistant",
                api: "openai-responses",
                provider: "openai",
                model: model.id,
                content: [{ type: "text", text: "A fixed answer for the complete Turn budget." }],
                stopReason: "stop",
                timestamp: Date.now(),
                usage: {
                  input: 1,
                  output: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                  totalTokens: 2,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                },
              };
              queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
              return stream;
            },
          });
          assert.equal((await runtime.run(request.input.prompt)).kind, "completed");
        } finally {
          await session.authority.close();
          await channel.close();
        }
        return { stopReason: "stop" };
      },
    });
    for (let i = 0; i < samples; i++) {
      const conversation = await store.createSession(
        project.projectId,
        project.workspaceId,
        "Budget",
        "elastic",
      );
      await delay(250);
      const walStart = (
        await sql<{ lsn: string }>`select pg_current_wal_insert_lsn()::text lsn`.execute(observer)
      ).rows[0]!.lsn;
      counters = {
        sql: 0,
        transactions: 0,
        nativeRows: 0,
        kafkaRecords: 0,
        kafkaBytes: 0,
        kafkaTransactions: 0,
        kinds: {},
        sqlVerbs: {},
      };
      const started = performance.now(),
        heap = process.memoryUsage().heapUsed;
      const accepted = await store.acceptTurn(conversation.sessionId, randomUUID(), {
        prompt: "Measure one complete native Turn.",
      });
      assert.equal((await executor.dispatchRun(accepted.runId)).status, "completed");
      await until(async () => {
        const { rows } = await sql<{ sealed: boolean; pending: string; version: string }>`select
          (select output_sealed_at is not null from runs where id=${accepted.runId}::uuid) sealed,
          (select count(*)::text from outbox where tenant_id=${tenant.tenantId}::uuid and published_at is null) pending,
          (select coalesce(max((payload->>'version')::bigint),0)::text from outbox where aggregate_id=${conversation.sessionId}::uuid and payload->>'entity'='input_queue') version`.execute(
          observer,
        );
        const controls = await observer
          .selectFrom("outbox")
          .select("id")
          .where("aggregate_id", "=", conversation.sessionId)
          .where("aggregate_type", "=", "session_control_change")
          .execute();
        return (
          rows[0]!.sealed &&
          rows[0]!.pending === "0" &&
          controls.every((c) => consumedControls.has(c.id)) &&
          BigInt(queues.current(tenant.tenantId, conversation.sessionId)?.viewVersion ?? "0") >=
            BigInt(rows[0]!.version)
        );
      });
      await delay(50); // Join already-triggered queue reconciliation, not observer SQL.
      const measured = counters;
      counters = undefined;
      const { rows } = await sql<{
        wal: string;
        native: string;
        outbox: string;
        references: string;
      }>`select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),${walStart}::pg_lsn)::text wal,
        (select count(*)::text from pi_session_log where tenant_id=${tenant.tenantId}::uuid and session_id=${conversation.sessionId}) native,
        (select count(*)::text from outbox where tenant_id=${tenant.tenantId}::uuid and (aggregate_id=${conversation.sessionId}::uuid or payload#>>'{scope,runId}'=${accepted.runId})) outbox,
        (select count(*)::text from outbox where aggregate_id=${conversation.sessionId}::uuid and payload->>'entity'='input_queue') references`.execute(
        observer,
      );
      assert(Number(rows[0]!.native) >= 4);
      assert(measured.kafkaRecords > 0);
      assert(measured.kafkaTransactions > 0);
      report.samples.push({
        ...measured,
        nativeRows: Number(rows[0]!.native),
        outboxRows: Number(rows[0]!.outbox),
        queueReferences: Number(rows[0]!.references),
        walBytes: Number(rows[0]!.wal),
        durationMs: performance.now() - started,
        heapDeltaBytes: process.memoryUsage().heapUsed - heap,
      });
    }
  } finally {
    await host.close();
    await logs.close();
    await client.close();
  }
  await closeRuntime();
  projector = undefined;
  const heap = process.memoryUsage().heapUsed,
    started = performance.now();
  projector = createProjector(baseUrl);
  await projector.start();
  await until(() => projector!.ownsPartition(0));
  report.ownerRecovery = {
    durationMs: performance.now() - started,
    heapDeltaBytes: process.memoryUsage().heapUsed - heap,
  };
  report.measurementLimits = [
    "No Tool/VM or live provider cost; actual Pi loop and durable native lifecycle are included.",
    "SQL counts pg Client requests including transaction commands; trigger-internal statements are represented in WAL, not separately counted.",
    "Kafka bytes are produced JSON payloads, not replication/network bytes; transactions count native producer commit calls.",
    "WAL is a cluster LSN delta; run in the otherwise idle isolated PG fixture. Heap deltas include GC noise.",
    "Recovery includes producer/group ownership and view bootstrap, not replay of arbitrary effects.",
  ];
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-native-turn-budget.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  process.stdout.write(JSON.stringify(report) + "\n");
} finally {
  counters = undefined;
  await closeRuntime?.();
  await server.close();
  await kafka.deleteTopics({ topics: [topic] }).catch(() => {});
  await kafka.close();
  await db.destroy();
  await observer.destroy();
  await sql`drop database if exists ${sql.id(name)}`.execute(admin);
  await admin.destroy();
  Client.prototype.query = query;
  kafkaNative.Producer.prototype.produce = produce;
  kafkaNative.Producer.prototype.commitTransaction = commit;
}
