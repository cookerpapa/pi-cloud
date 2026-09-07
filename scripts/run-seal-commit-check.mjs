import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

if (process.env.PI_CLOUD_LIVE_SEAL_COMMIT_CHECK !== "1")
  throw new Error("Set PI_CLOUD_LIVE_SEAL_COMMIT_CHECK=1 for isolated PG/Kafka acceptance");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.argv[2] !== "inside") {
  const exec = promisify(execFile),
    id = randomUUID(),
    pg = `pi-cloud-commit-pg-${id}`,
    runner = `pi-cloud-commit-${id}`;
  const password = randomBytes(24).toString("hex");
  const docker = async (args) =>
    (await exec("docker", args, { timeout: 240000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  let created = false;
  try {
    await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      pg,
      "--network",
      "pi-cloud-production_event-log",
      "--memory",
      "768m",
      "--cpus",
      "2",
      "-e",
      `POSTGRES_PASSWORD=${password}`,
      "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
    ]);
    created = true;
    for (let n = 0; ; n++) {
      try {
        await docker(["exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
        break;
      } catch {
        if (n === 100) throw new Error("PG startup failed");
        await sleep(100);
      }
    }
    const env = {
      ...process.env,
      COMMIT_CHECK_DATABASE_URL: `postgresql://postgres:${password}@${pg}:5432/postgres`,
    };
    const result = await exec(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        runner,
        "--network",
        "pi-cloud-production_event-log",
        "--memory",
        "2g",
        "--cpus",
        "3",
        "-v",
        `${process.cwd()}:/app:ro`,
        "-w",
        "/app",
        "-e",
        "PI_CLOUD_LIVE_SEAL_COMMIT_CHECK",
        "-e",
        "COMMIT_CHECK_DATABASE_URL",
        "-e",
        "TSX_TSCONFIG_PATH=/app/packages/control-plane/tsconfig.json",
        "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
        "node",
        "--import",
        "tsx",
        "scripts/run-seal-commit-check.mjs",
        "inside",
      ],
      { env, timeout: 240000, maxBuffer: 4 * 1024 * 1024 },
    );
    const line = result.stdout
      .trim()
      .split("\n")
      .findLast((line) => line.startsWith('{"format"'));
    if (!line)
      throw new Error(
        `Missing report: ${result.stdout.slice(-2000)} ${result.stderr.slice(-1000)}`,
      );
    const report = JSON.parse(line);
    report.revision = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim();
    report.workingTreeDirty = true;
    await writeFile(
      "docs/reports/seal-commit-acceptance-latest.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  } finally {
    await docker(["rm", "-f", runner]).catch(() => {});
    if (created) await docker(["rm", "-f", pg]);
  }
} else {
  const { createDatabase, runMigrations } = await import("@pi-cloud/database");
  const { ControlPlaneStore, createPrivateTenant } =
    await import("../packages/control-plane/src/index.ts");
  const { RunExecutor, TurnExecutionBackendError } =
    await import("../packages/runtime-core/src/run-executor.ts");
  const { ExecutionStreamProjector } =
    await import("../packages/runtime-core/src/execution-stream-projection.ts");
  const { KafkaLiveSessionTail } =
    await import("../packages/runtime-core/src/kafka-live-session-tail.ts");
  const { KafkaAcceptedFactBus } =
    await import("../packages/runtime-core/src/kafka-accepted-fact.ts");
  const { KafkaAcceptedFactConsumer } =
    await import("../packages/runtime-core/src/kafka-accepted-fact-consumer.ts");
  const { AcceptedFactTerminalOutboxRelay } =
    await import("../packages/runtime-core/src/accepted-fact-terminal-outbox-relay.ts");
  const { loadFactReplayOffsets } =
    await import("../packages/runtime-core/src/accepted-fact-recovery.ts");
  const { Admin } = await import("@platformatic/kafka");
  const { sql } = await import("kysely");
  const brokers = ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"],
    topic = `pi-cloud.commit-check.${randomUUID()}`;
  const groupId = `commit-check-${randomUUID()}`,
    liveId = randomUUID();
  const db = createDatabase({
    connectionString: process.env.COMMIT_CHECK_DATABASE_URL,
    maxConnections: 12,
  });
  const bus = new KafkaAcceptedFactBus({
    brokers,
    topic,
    partitions: 4,
    replicas: 3,
    retentionMs: 3600000,
    clientId: randomUUID(),
  });
  const admin = new Admin({ bootstrapBrokers: brokers, clientId: randomUUID() });
  let gatewayQueries = 0,
    boundaryQueries = 0,
    consumer,
    tail,
    relay;
  const measured = db.withPlugin({
    transformQuery({ node }) {
      gatewayQueries++;
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const stats = new Map(),
    polls = [],
    failures = [],
    sealSeen = new Set(),
    commitSeen = new Map();
  let lastSession;
  const wait = async (predicate, label) => {
    const deadline = Date.now() + 45000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
      await sleep(10);
    }
  };
  // Conservative former-Gateway baseline: same SELECT/backoff, without charging
  // native consumer pause/seek overhead. It observes the very same PG commits.
  const pollBaseline = async (fact, row) => {
    for (let n = 0; ; n++) {
      row.baselineQueries++;
      const result = await sql`select attempt.output_sealed_at, event.seq
        from run_attempts attempt left join session_terminal_events event on event.event_id=attempt.output_seal_id
        where attempt.id=${fact.scope.attemptId}`.execute(db);
      if (result.rows[0]?.output_sealed_at) {
        row.pollTerminalMs = performance.now() - row.sealSeen;
        return;
      }
      if (n > 60) throw new Error("Baseline projection did not complete");
      await sleep(Math.min(1000, 25 * 2 ** Math.min(n, 6)));
    }
  };
  try {
    await runMigrations(db, "up");
    const tenant = await createPrivateTenant(db, {
      slug: "commit-check",
      ownerDisplayName: "Commit check",
    });
    const store = new ControlPlaneStore({
      database: db,
      tenantId: tenant.tenantId,
      defaultModelProfileId: tenant.defaultModelProfileId,
    });
    await bus.start();
    const projector = new ExecutionStreamProjector(db);
    consumer = new KafkaAcceptedFactConsumer({
      brokers,
      topic,
      groupId,
      clientId: randomUUID(),
      onReset: () => projector.reset(),
      replayOffsets: (bounds, count) =>
        loadFactReplayOffsets(db, topic, bounds, { partitionCount: count, retentionMs: 3600000 }),
      handler: async (record) => {
        if (record.fact.kind === "execution_seal")
          await sleep(stats.get(record.fact.scope.runId)?.delayMs ?? 0);
        await projector.project(record);
      },
    });
    await consumer.start();
    tail = new KafkaLiveSessionTail({
      database: measured,
      brokers,
      topic,
      clientId: randomUUID(),
      instanceId: liveId,
    });
    const project = tail.projectRecord.bind(tail);
    tail.projectRecord = async (record) => {
      const fact = record.fact,
        row = stats.get(fact.scope.runId);
      if (fact.kind === "execution_seal") sealSeen.add(fact.factId);
      if (fact.kind === "execution_committed")
        commitSeen.set(fact.factId, (commitSeen.get(fact.factId) ?? 0) + 1);
      if (fact.kind === "execution_seal" && row && row.sealSeen === undefined) {
        row.sealSeen = performance.now();
        polls.push(pollBaseline(fact, row).catch((e) => failures.push(e.message)));
      }
      const before = gatewayQueries;
      await project(record);
      if (fact.kind === "execution_seal" || fact.kind === "execution_committed")
        boundaryQueries += gatewayQueries - before;
      if (fact.kind === "execution_committed" && row && row.commitTerminalMs === undefined)
        row.commitTerminalMs = performance.now() - row.sealSeen;
    };
    await tail.start();
    relay = new AcceptedFactTerminalOutboxRelay({ database: db, bus });
    relay.start();
    const scenarios = [];
    for (const delayMs of [0, 100, 500]) {
      const start = performance.now();
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          const project = await store.createProject({
            name: `commit-${randomUUID()}`,
            source: { kind: "empty" },
          });
          await db
            .updateTable("environment_versions")
            .set({ state: "validated", validated_at: new Date() })
            .where("id", "=", project.environment.environmentVersionId)
            .execute();
          const session = await store.createSession(
            project.projectId,
            project.workspaceId,
            "Commit",
            "elastic",
          );
          lastSession = session;
          const release = await tail.retainSession(tenant.tenantId, session.sessionId);
          const sub = tail.eventHub.subscribe(tenant.tenantId, session.sessionId);
          try {
            for (let round = 0; round < 2; round++) {
              const run = await store.acceptTurn(session.sessionId, randomUUID(), {
                prompt: "acceptance only",
              });
              stats.set(run.runId, { delayMs, baselineQueries: 0 });
              const executor = new RunExecutor({
                database: db,
                claimOwnerId: "commit-check",
                backend: {
                  async execute(request, lifecycle) {
                    await lifecycle.started();
                    const id = randomUUID(),
                      now = new Date().toISOString();
                    await bus.append({
                      kind: "agent_event",
                      factId: id,
                      scope: {
                        tenantId: tenant.tenantId,
                        sessionId: session.sessionId,
                        turnId: run.turnId,
                        runId: run.runId,
                        attemptId: request.attemptId,
                        fencingToken: request.fencingToken ?? 0,
                      },
                      occurredAt: now,
                      event: {
                        schemaVersion: 1,
                        eventId: id,
                        sessionId: session.sessionId,
                        turnId: run.turnId,
                        agentId: "root",
                        seq: Number(request.nextEventSeq),
                        occurredAt: now,
                        type: "assistant.text.delta",
                        payload: { text: "durable prefix" },
                      },
                    });
                    throw new TurnExecutionBackendError(
                      "worker_lost",
                      "Acceptance interruption",
                      false,
                    );
                  },
                },
              });
              assert.equal((await executor.dispatchRun(run.runId)).status, "failed");
              await wait(
                () => stats.get(run.runId)?.commitTerminalMs !== undefined,
                "commit notification",
              );
              const events = [];
              while (events.at(-1)?.type !== "turn.failed") {
                const wake = await sub.next();
                assert(wake?.event, "Unexpected SSE resnapshot");
                events.push(wake.event);
              }
              assert.deepEqual(
                events.map((e) => e.type),
                ["assistant.text.delta", "turn.failed"],
              );
              assert.equal(events[1].seq, events[0].seq + 1);
            }
          } finally {
            sub.close();
            release();
          }
        }),
      );
      scenarios.push({ delayMs, elapsedMs: Math.round(performance.now() - start) });
    }
    await Promise.all(polls);
    assert.deepEqual(failures, []);
    assert.equal(boundaryQueries, 0);
    // Commit survived an absent publisher; discard the canonical fold as well.
    await relay.close();
    const session = lastSession,
      release = await tail.retainSession(tenant.tenantId, session.sessionId);
    const sub = tail.eventHub.subscribe(tenant.tenantId, session.sessionId);
    const faultRun = await store.acceptTurn(session.sessionId, randomUUID(), {
      prompt: "commit recovery",
    });
    const executor = new RunExecutor({
      database: db,
      claimOwnerId: "commit-check",
      backend: {
        async execute(_request, lifecycle) {
          await lifecycle.started();
          throw new TurnExecutionBackendError("worker_lost", "Acceptance interruption", false);
        },
      },
    });
    await executor.dispatchRun(faultRun.runId);
    const sealRow = await db
      .selectFrom("outbox")
      .select("payload")
      .where(sql`payload #>> '{scope,runId}'`, "=", faultRun.runId)
      .executeTakeFirstOrThrow();
    await bus.append(sealRow.payload);
    let ackRow;
    await wait(async () => {
      ackRow = await db
        .selectFrom("outbox")
        .selectAll()
        .where(sql`payload #>> '{scope,runId}'`, "=", faultRun.runId)
        .where(sql`payload ->> 'kind'`, "=", "execution_committed")
        .executeTakeFirst();
      return ackRow && sealSeen.has(sealRow.payload.factId);
    }, "committed notification without publisher");
    assert.equal(ackRow.published_at, null);
    assert.equal(commitSeen.has(ackRow.id), false);
    assert(tail.statistics().pendingCommitSessions > 0);
    await consumer.close();
    const restored = new ExecutionStreamProjector(db);
    consumer = new KafkaAcceptedFactConsumer({
      brokers,
      topic,
      groupId,
      clientId: randomUUID(),
      onReset: () => restored.reset(),
      replayOffsets: (bounds, count) =>
        loadFactReplayOffsets(db, topic, bounds, { partitionCount: count, retentionMs: 3600000 }),
      handler: (record) => restored.project(record),
    });
    await consumer.start();
    let ackLost = false,
      deliveries = 0;
    relay = new AcceptedFactTerminalOutboxRelay({
      database: db,
      bus: {
        checkHealth: () => bus.checkHealth(),
        async append(fact) {
          const receipt = await bus.append(fact);
          if (fact.factId === ackRow.id) {
            deliveries++;
            if (!ackLost) {
              ackLost = true;
              throw new Error("injected lost Kafka delivery ACK");
            }
          }
          return receipt;
        },
      },
    });
    relay.start();
    await wait(
      async () =>
        deliveries >= 2 &&
        (commitSeen.get(ackRow.id) ?? 0) >= 2 &&
        (
          await db
            .selectFrom("outbox")
            .select("published_at")
            .where("id", "=", ackRow.id)
            .executeTakeFirst()
        )?.published_at,
      "recovered publisher / duplicate ACK",
    );
    assert.equal((await sub.next())?.event?.type, "turn.failed");
    assert.equal(tail.statistics().pendingCommitSessions, 0);
    assert.equal(
      Number(
        (
          await sql`select count(*) as n from session_terminal_events where turn_id=${faultRun.turnId}`.execute(
            db,
          )
        ).rows[0].n,
      ),
      1,
    );
    sub.close();
    release();
    const quantiles = (values) => {
      const sorted = values.toSorted((a, b) => a - b);
      return {
        p50: +sorted[Math.floor((sorted.length - 1) * 0.5)].toFixed(2),
        p95: +sorted[Math.ceil((sorted.length - 1) * 0.95)].toFixed(2),
      };
    };
    const samples = [...stats.values()];
    console.log(
      JSON.stringify({
        format: "pi-cloud.seal-commit-acceptance.v1",
        checkedAt: new Date().toISOString(),
        topology: "isolated PostgreSQL 2CPU/768MiB; existing R=3 Kafka; 3CPU/2GiB runner; no LLM",
        runs: samples.length,
        gatewaySealCommitQueries: boundaryQueries,
        gatewayMetadataAndRecoveryQueries: gatewayQueries,
        scenarios: scenarios.map((s) => ({
          ...s,
          runs: samples.filter((x) => x.delayMs === s.delayMs).length,
          baselineQueries: samples
            .filter((x) => x.delayMs === s.delayMs)
            .reduce((sum, x) => sum + x.baselineQueries, 0),
          pollTerminalMs: quantiles(
            samples.filter((x) => x.delayMs === s.delayMs).map((x) => x.pollTerminalMs),
          ),
          commitTerminalMs: quantiles(
            samples.filter((x) => x.delayMs === s.delayMs).map((x) => x.commitTerminalMs),
          ),
        })),
        recovery: {
          commitSurvivedPublisherAbsence: true,
          canonicalConsumerRestarted: true,
          kafkaAckLost: ackLost,
          commitDeliveryAttempts: deliveries,
          publicTerminalRows: 1,
        },
        pendingCommitBytes: tail.statistics().pendingCommitBytes,
        failures,
      }),
    );
  } finally {
    await relay?.close();
    await tail?.close();
    await consumer?.close();
    await bus.close();
    await admin.deleteGroups({ groups: [groupId, `pi-cloud-live-tail-${liveId}`] }).catch(() => {});
    await admin.deleteTopics({ topics: [topic] }).catch(() => {});
    await admin.close();
    await db.destroy();
  }
}
