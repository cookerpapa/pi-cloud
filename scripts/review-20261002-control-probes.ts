/** Review evidence, not a regression specification for the desired behavior.
 * Uses a caller-supplied isolated PG fixture; never production credentials. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase, runMigrations } from "../packages/database/src/index.ts";
import { sql } from "kysely";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { createTestWorker } from "../packages/control-plane/test/admit-test-execution.ts";
import { SessionOutboxRelay } from "../packages/runtime-core/src/session-outbox-relay.ts";
import { SESSION_CONTROL_OUTBOX_TOPIC } from "../packages/protocol/src/index.ts";
import { kafkaProducerLane } from "../packages/runtime-core/src/kafka-accepted-fact.ts";
import { QueuedInputService } from "../packages/control-plane/src/queued-input-service.ts";

const endpoint = process.env.PI_CLOUD_REVIEW_DATABASE_URL;
assert(endpoint, "Supply an isolated PI_CLOUD_REVIEW_DATABASE_URL");
const url = new URL(endpoint);
assert(["localhost", "127.0.0.1"].includes(url.hostname), "Review fixture must be loopback");
const name = `review_20261002_${randomUUID().replaceAll("-", "")}`;
const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
await sql`create database ${sql.id(name)}`.execute(admin);
url.pathname = `/${name}`;
const db = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
const evidence: Record<string, unknown> = {};
const until = async (check: () => boolean | Promise<boolean>) => {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert(Date.now() < deadline, "Fixture timed out");
    await delay(10);
  }
};
try {
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: name.replaceAll("_", "-"),
    ownerDisplayName: "Review fixture",
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const project = await store.createProject({ name: "Review", source: { kind: "empty" } });
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Review",
    "elastic",
  );
  const count = async (entity: string) =>
    Number(
      (
        await sql<{ n: string }>`select count(*)::text n from outbox
    where tenant_id=${tenant.tenantId}::uuid and payload->>'entity'=${entity}`.execute(db)
      ).rows[0]!.n,
    );
  const initial = await count("input_queue");
  const accepted = await store.acceptTurn(session.sessionId, randomUUID(), {
    prompt: "Reference-only review fixture",
  });
  const acceptedCount = await count("input_queue");
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const worker = await createTestWorker(db);
  const executing = worker
    .executor({
      execute: async () => {
        entered.resolve();
        await finish.promise;
        return { stopReason: "stop" };
      },
    })
    .dispatchRun(accepted.runId);
  void executing.catch(entered.reject);
  await entered.promise;
  const admittedCount = await count("input_queue");
  finish.resolve();
  await executing;
  const completedCount = await count("input_queue");
  evidence.queueReferences = {
    accept: acceptedCount - initial,
    admit: admittedCount - acceptedCount,
    complete: completedCount - admittedCount,
    total: completedCount - initial,
  };
  let emptySteerQueries = 0;
  const steerDb = db.withPlugin({
    transformQuery({ node }) {
      return node;
    },
    async transformResult({ result }) {
      emptySteerQueries++;
      return result;
    },
  });
  const queue = new QueuedInputService({
    autoStart: true,
    database: steerDb,
    steering: {
      deliverQueued: async () => {
        throw new Error("No Steer should be delivered");
      },
    },
  });
  queue.notifySession(tenant.tenantId, session.sessionId);
  await delay(100);
  await queue.onApplicationShutdown();
  assert.equal(emptySteerQueries, 0);
  evidence.emptySteerWake = { heldInputs: 0, sqlQueries: emptySteerQueries };

  const commandId = randomUUID();
  const values = {
    id: commandId,
    tenant_id: tenant.tenantId,
    run_id: accepted.runId,
    partition: 0,
    command: { scope: { piSessionId: session.sessionId }, request: { action: "wait" } },
    delivered_at: null,
    input_consumed_at: null,
  };
  const first = await db
    .insertInto("subagent_control_commands")
    .values(values)
    .returning("revision")
    .executeTakeFirstOrThrow();
  const before = await count("subagent_command");
  const replay = await db
    .insertInto("subagent_control_commands")
    .values(values)
    .onConflict((c) => c.column("id").doUpdateSet({ id: sql.ref("subagent_control_commands.id") }))
    .returning("revision")
    .executeTakeFirstOrThrow();
  const after = await count("subagent_command");
  assert.equal(replay.revision, first.revision);
  assert.equal(after - before, 0);
  evidence.noopReplay = { sourceRevisionUnchanged: true, newOutboxReferences: after - before };

  // Isolate relay references from the lifecycle fixture's already measured rows.
  await db.deleteFrom("outbox").execute();
  const ids = Array.from({ length: 20 }, () => randomUUID());
  const physicalSessions: string[] = [],
    partitions = new Set<number>();
  while (physicalSessions.length < 20) {
    const candidate = randomUUID(),
      partition = kafkaProducerLane(candidate, 32);
    if (!partitions.has(partition)) {
      partitions.add(partition);
      physicalSessions.push(candidate);
    }
  }
  for (const [i, id] of ids.entries()) {
    const entityId = randomUUID();
    await db
      .insertInto("outbox")
      .values({
        id,
        tenant_id: tenant.tenantId,
        aggregate_type: "session_control_change",
        aggregate_id: entityId,
        topic: SESSION_CONTROL_OUTBOX_TOPIC,
        payload: {
          kind: "control_change",
          factId: id,
          scope: { tenantId: tenant.tenantId, piSessionId: physicalSessions[i] },
          entity: "input_queue",
          entityId,
          version: String(i + 1),
          occurredAt: new Date().toISOString(),
        },
        created_at: new Date(Date.now() - 10000 + i),
        available_at: new Date(0),
        published_at: null,
        last_error: null,
      })
      .execute();
  }
  const blocked = Promise.withResolvers<void>(),
    attempted = new Set<string>();
  let queries = 0;
  const measured = db.withPlugin({
    transformQuery({ node }) {
      return node;
    },
    async transformResult({ result }) {
      queries++;
      return result;
    },
  });
  const relay = new SessionOutboxRelay({
    database: measured,
    notificationConnectionString: url.toString(),
    bus: {
      checkHealth: async () => {},
      append: async (fact) => {
        attempted.add(fact.factId);
        if (fact.factId === ids[0]) await blocked.promise;
        return { factId: fact.factId, durable: true };
      },
    },
  });
  try {
    relay.start();
    await until(() => attempted.size === 20);
    await delay(250);
    assert.equal(attempted.size, 20);
    evidence.relayBatchBlocking = {
      sessions: 20,
      distinctHashPartitions: partitions.size,
      publicationTransport: "simulated",
      onePublicationHeld: true,
      attemptedBeforeRelease: attempted.size,
      healthyNotAttempted: 0,
    };
    blocked.resolve();
    await until(() => attempted.size === 20);
    await until(
      async () =>
        Number(
          (
            await sql<{
              n: string;
            }>`select count(*)::text n from outbox where published_at is null`.execute(db)
          ).rows[0]!.n,
        ) === 0,
    );
    await delay(1100);
    queries = 0;
    await delay(1000);
    evidence.idleRelay = {
      observedWindowMs: 1000,
      sqlQueries: queries,
      defaultPollIntervalMs: 1000,
    };
  } finally {
    blocked.resolve();
    await relay.close();
  }
  process.stdout.write(JSON.stringify(evidence) + "\n");
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(evidence, null, 2) + "\n");
} finally {
  await db.destroy();
  await sql`drop database ${sql.id(name)}`.execute(admin);
  await admin.destroy();
}
