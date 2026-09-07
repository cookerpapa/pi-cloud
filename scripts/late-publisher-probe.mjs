import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Admin } from "@platformatic/kafka";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";
import { createExecutionLease } from "@pi-cloud/protocol";
import { FactChannelService } from "../packages/runtime-core/src/accepted-fact-channel.ts";
import { PostgresExecutionLeaseAuthorityGate } from "../packages/runtime-core/src/session-lease-authority-gate.ts";
import { PostgresAcceptedFactProgressStore } from "../packages/runtime-core/src/postgres-accepted-fact-progress.ts";
import { KafkaAcceptedFactBus } from "../packages/runtime-core/src/kafka-accepted-fact.ts";
import { KafkaAcceptedFactConsumer } from "../packages/runtime-core/src/kafka-accepted-fact-consumer.ts";
import { PostgresPiSessionMutationProjector } from "../packages/runtime-core/src/postgres-pi-session-mutation-projector.ts";

const database = createDatabase({
  connectionString: process.env.PROBE_DATABASE_URL,
  maxConnections: 4,
});
const brokers = ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const config = (topic) => ({
  brokers,
  topic,
  clientId: `probe-${randomUUID()}`,
  partitions: 3,
  replicas: 3,
  retentionMs: 3600000,
});
const message = (text) => ({
  kind: "append_entry",
  lane: "main",
  entry: {
    id: randomUUID(),
    type: "message",
    message: { role: "user", content: text, timestamp: Date.now() },
  },
});
const candidate = (identity, operation) => ({
  schemaVersion: 1,
  mutationId: randomUUID(),
  scope: identity,
  operation,
  events: [],
  occurredAt: new Date().toISOString(),
});
const open = (service, identity) =>
  service.open(
    {
      protocolVersion: 1,
      type: "fact.channel.open",
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      payload: {
        executionLease: identity.executionLease,
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        piSession: { id: identity.piSessionId, lane: "main" },
        nextEventSeq: 1,
      },
    },
    randomUUID(),
    () => {},
  );
const service = (bus, instanceId) =>
  new FactChannelService({
    authority: new PostgresExecutionLeaseAuthorityGate({ database, leaseDurationMs: 3000 }),
    bus,
    progress: new PostgresAcceptedFactProgressStore(database),
    instanceId,
    leaseDurationMs: 3000,
  });

if (process.argv[2] === "publisher") {
  const [input] = await once(process, "message");
  const bus = new KafkaAcceptedFactBus(config(input.topic));
  let channels;
  try {
    await bus.start();
    channels = service(
      {
        checkHealth: () => bus.checkHealth(),
        append: async (fact) => {
          // Fault hook only at the bus port; authority and production publication
          // code are unchanged. SIGSTOP suspends renewal as a long GC pause would.
          await new Promise((resolve) =>
            process.send({ type: "accepted-before-publish", factId: fact.factId }, resolve),
          );
          process.kill(process.pid, "SIGSTOP");
          return bus.append(fact);
        },
      },
      randomUUID(),
    );
    const channel = await open(channels, input.identity);
    try {
      await channel.mutate(input.mutation);
      process.send({ type: "publication-returned", accepted: true });
    } catch {
      process.send({ type: "publication-returned", accepted: false });
    }
  } finally {
    await channels?.close().catch(() => {});
    await bus.close();
    await database.destroy();
    process.disconnect();
  }
} else {
  const topic = `pi-cloud.late-publisher-probe.${randomUUID()}`;
  const groupId = topic;
  const bus = new KafkaAcceptedFactBus(config(topic));
  const admin = new Admin({ clientId: `cleanup-${randomUUID()}`, bootstrapBrokers: brokers });
  let child, consumer, channels;
  const report = {
    format: "pi-cloud.late-publisher-probe.v1",
    checkedAt: new Date().toISOString(),
    counterexample: false,
    records: [],
  };
  const waitFor = async (predicate, label, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await delay(50);
    }
  };
  try {
    await runMigrations(database, "up");
    const tenant = await createPrivateTenant(database, {
      slug: "late-publisher",
      ownerDisplayName: "Isolated fault probe",
    });
    const store = new ControlPlaneStore({
      database,
      tenantId: tenant.tenantId,
      defaultModelProfileId: tenant.defaultModelProfileId,
    });
    const project = await store.createProject({
      name: "Late publisher",
      source: { kind: "empty" },
    });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Late publisher",
      "elastic",
    );
    const oldRun = await store.acceptTurn(session.sessionId, "old", { prompt: "old" });
    const newRun = await store.acceptTurn(session.sessionId, "new", { prompt: "new" });
    const sandboxId = randomUUID();
    await database
      .insertInto("sandboxes")
      .values({
        id: sandboxId,
        supervisor_id: "isolated-probe",
        boot_id: randomUUID(),
        state: "leased",
        max_concurrent_sessions: 1,
        active_sessions: 1,
      })
      .execute();
    const oldLeaseId = randomUUID(),
      oldAttempt = randomUUID(),
      newLeaseId = randomUUID(),
      newAttempt = randomUUID();
    const identity = (run, leaseId, attemptId, fence) => ({
      tenantId: tenant.tenantId,
      sessionId: session.sessionId,
      piSessionId: session.sessionId,
      piSessionLane: "main",
      runId: run.runId,
      turnId: run.turnId,
      executionLease: createExecutionLease(leaseId, attemptId, fence),
    });
    const oldIdentity = identity(oldRun, oldLeaseId, oldAttempt, 1),
      nextIdentity = identity(newRun, newLeaseId, newAttempt, 2);
    await database
      .insertInto("session_leases")
      .values({
        session_id: session.sessionId,
        lease_id: oldLeaseId,
        sandbox_id: sandboxId,
        fencing_token: 1,
        tenant_id: tenant.tenantId,
        project_id: project.projectId,
        workspace_id: project.workspaceId,
        run_id: oldRun.runId,
        turn_id: oldRun.turnId,
        attempt_id: oldAttempt,
        valid_until: new Date(Date.now() + 12000),
      })
      .execute();
    await bus.start();
    const projector = new PostgresPiSessionMutationProjector(database);
    consumer = new KafkaAcceptedFactConsumer({
      brokers,
      topic,
      clientId: `consumer-${randomUUID()}`,
      groupId,
      mode: "earliest",
      handler: async (record) => {
        await projector.project(record.fact, true);
        report.records.push({
          factId: record.fact.factId,
          fence: record.fact.scope.fencingToken,
          kind: record.fact.operation.kind,
          partition: record.partition,
          offset: String(record.offset),
        });
      },
    });
    await consumer.start();
    const delayed = candidate(oldIdentity, message("OLD_WRITER_MESSAGE"));
    child = fork(new URL(import.meta.url), ["publisher"], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let paused = false;
    child.on("message", (value) => {
      if (value.type === "accepted-before-publish") paused = true;
      if (value.type === "publication-returned") report.oldPublicationAccepted = value.accepted;
    });
    child.send({ topic, identity: oldIdentity, mutation: delayed });
    await waitFor(() => paused, "publisher reached its fault hook");
    await waitFor(async () => {
      const row = await database
        .selectFrom("session_leases")
        .select(["fact_channel_valid_until", "valid_until"])
        .where("lease_id", "=", oldLeaseId)
        .executeTakeFirstOrThrow();
      return (
        row.fact_channel_valid_until &&
        new Date(row.fact_channel_valid_until).getTime() < Date.now() - 100 &&
        new Date(row.valid_until).getTime() < Date.now() - 100
      );
    }, "channel and execution leases expired");
    // Rotate the durable authority without testing the unrelated Run reaper.
    await database.transaction().execute(async (transaction) => {
      const rotated = await transaction
        .updateTable("session_leases")
        .set({
          lease_id: newLeaseId,
          attempt_id: newAttempt,
          fencing_token: 2,
          run_id: newRun.runId,
          turn_id: newRun.turnId,
          fact_channel_connection_id: null,
          fact_channel_instance_id: null,
          fact_channel_valid_until: null,
          valid_until: new Date(Date.now() + 60000),
        })
        .where("lease_id", "=", oldLeaseId)
        .where("valid_until", "<", new Date())
        .executeTakeFirst();
      assert.equal(rotated.numUpdatedRows, 1n);
      await transaction
        .updateTable("sessions")
        .set({ last_fencing_token: 2 })
        .where("id", "=", session.sessionId)
        .execute();
    });
    channels = service(bus, randomUUID());
    const next = await open(channels, nextIdentity);
    const barrier = candidate(nextIdentity, { kind: "projection_barrier" });
    await next.mutate(barrier);
    const receipt = async (id) =>
      !!(await database
        .selectFrom("pi_session_mutation_results")
        .select("mutation_id")
        .where("mutation_id", "=", id)
        .executeTakeFirst());
    await waitFor(() => receipt(barrier.mutationId), "recovery barrier projected");
    const current = candidate(nextIdentity, message("NEW_WRITER_MESSAGE"));
    await next.mutate(current);
    await waitFor(() => receipt(current.mutationId), "new writer message projected");
    const storage = new PostgresPiSessionStorage({
      database,
      tenantId: tenant.tenantId,
      sessionId: session.sessionId,
    });
    report.leafBeforeResume = (await storage.getLanes()).find(
      (lane) => lane.lane === "main",
    ).leafId;
    assert.equal(report.leafBeforeResume, current.operation.entry.id);
    child.kill("SIGCONT");
    await waitFor(() => report.oldPublicationAccepted !== undefined, "old publisher returned");
    const observationBarrier = candidate(nextIdentity, { kind: "projection_barrier" });
    await next.mutate(observationBarrier);
    await waitFor(
      () => receipt(observationBarrier.mutationId),
      "final observation barrier projected",
    );
    report.oldFactProjected = await receipt(delayed.mutationId);
    report.leafAfterResume = (await storage.getLanes()).find((lane) => lane.lane === "main").leafId;
    const entry = await storage.getEntry(delayed.operation.entry.id);
    report.oldMessageBecameChildOfNewMessage = entry?.parentId === current.operation.entry.id;
    report.counterexample = report.leafAfterResume !== report.leafBeforeResume;
    report.authorityStillNew =
      (
        await database
          .selectFrom("session_leases")
          .select("fencing_token")
          .where("session_id", "=", session.sessionId)
          .executeTakeFirstOrThrow()
      ).fencing_token === "2";
    report.expected = "resuming an expired publisher does not change the recovered branch";
    report.scope =
      "real SIGSTOP/SIGCONT, full-schema PostgreSQL and R3 Kafka; fixture-driven authority handoff, no model or Cube";
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => {});
    }
    await channels?.close().catch(() => {});
    await consumer?.close();
    await bus.close();
    await admin.deleteGroups({ groups: [groupId] });
    await admin.deleteTopics({ topics: [topic] });
    await admin.close();
    await database.destroy();
  }
  console.log(JSON.stringify(report));
}
