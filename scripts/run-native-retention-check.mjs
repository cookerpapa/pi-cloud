import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

if (process.env.PI_CLOUD_NATIVE_RETENTION_CHECK !== "1")
  throw new Error("Opt in to private Kafka retention acceptance");
if (process.argv[2] !== "inside") {
  const exec = promisify(execFile),
    name = `pi-cloud-native-gc-${randomUUID()}`;
  try {
    const result = await exec(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "pi-cloud-production_event-log",
        "--cpus",
        "1",
        "--memory",
        "1g",
        "-v",
        `${process.cwd()}:/app:ro`,
        "-w",
        "/app",
        "-e",
        "PI_CLOUD_NATIVE_RETENTION_CHECK",
        "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
        "node",
        "--import",
        "tsx",
        "scripts/run-native-retention-check.mjs",
        "inside",
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
    await writeFile(
      "docs/reports/native-retention-acceptance-latest.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  } finally {
    await exec("docker", ["rm", "-f", name]).catch(() => {});
  }
} else {
  const { Admin } = await import("@platformatic/kafka"),
    { PGlite } = await import("@electric-sql/pglite"),
    { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const { createDatabase } = await import("@pi-cloud/database"),
    { sql } = await import("kysely");
  const { KafkaAcceptedFactBus } =
      await import("../packages/runtime-core/src/kafka-accepted-fact.ts"),
    { KafkaSafeRetention } = await import("../packages/runtime-core/src/kafka-safe-retention.ts");
  const brokers = ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"],
    topic = `pi-cloud.native-gc.${randomUUID()}`;
  const pg = await PGlite.create(),
    socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  const db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  const admin = new Admin({ bootstrapBrokers: brokers, clientId: randomUUID() });
  const bus = new KafkaAcceptedFactBus({
    brokers,
    topic,
    partitions: 1,
    replicas: 3,
    retentionMs: 1000,
    clientId: randomUUID(),
  });
  const gc = new KafkaSafeRetention({
    database: db,
    brokers,
    topic,
    clientId: randomUUID(),
    graceMs: 1000,
  });
  let destroyed = false;
  try {
    await sql`create table accepted_fact_projection_offsets(topic text,partition integer,next_offset bigint); create table run_attempts(output_first_topic text,output_first_partition integer,output_first_offset bigint,output_sealed_at timestamptz)`.execute(
      db,
    );
    await bus.start();
    gc.start(1);
    const sessionId = randomUUID(),
      turnId = randomUUID(),
      attemptId = randomUUID();
    const append = async (seq) => {
      const id = randomUUID(),
        at = new Date().toISOString();
      await bus.append({
        kind: "agent_event",
        factId: id,
        scope: {
          tenantId: sessionId,
          sessionId,
          piSessionId: sessionId,
          runId: turnId,
          turnId,
          attemptId,
          writerId: attemptId,
          fencingToken: 1,
        },
        occurredAt: at,
        event: {
          schemaVersion: 1,
          eventId: id,
          sessionId,
          turnId,
          agentId: "root",
          seq,
          occurredAt: at,
          type: "assistant.text.delta",
          payload: { text: "retention fixture" },
        },
      });
    };
    const low = async () => {
      const result = await admin.listOffsets({
        topics: [{ name: topic, partitions: [{ partitionIndex: 0, timestamp: -2n }] }],
      });
      return result[0].partitions[0].offset;
    };
    for (let n = 1; n <= 20; n++) await append(n);
    await new Promise((r) => setTimeout(r, 1200));
    await gc.sweep();
    assert.equal(await low(), 0n);
    await sql`insert into accepted_fact_projection_offsets values(${topic},0,20)`.execute(db);
    await sql`insert into run_attempts values(${topic},0,5,null)`.execute(db);
    await gc.sweep();
    assert.equal(await low(), 5n);
    await sql`update run_attempts set output_sealed_at=now()`.execute(db);
    await append(21);
    await sql`update accepted_fact_projection_offsets set next_offset=21`.execute(db);
    await gc.sweep();
    assert.equal(await low(), 20n);
    await db.destroy();
    destroyed = true;
    await new Promise((r) => setTimeout(r, 1200));
    await assert.rejects(gc.sweep());
    assert.equal(await low(), 20n);
    console.log(
      JSON.stringify({
        format: "pi-cloud.native-retention.v1",
        checkedAt: new Date().toISOString(),
        accepted: true,
        scope:
          "real R3 Kafka producer/admin deletion with socket-backed PGlite progress fixtures; no model calls",
        noCheckpointRetainsAll: true,
        unsealedPrefixPreserved: true,
        gracePreservesRecent: true,
        databaseFailureStopsDeletion: true,
        lowWatermarks: [0, 5, 20, 20],
      }),
    );
  } finally {
    await gc.close();
    await bus.close();
    await admin.deleteTopics({ topics: [topic] }).catch(() => {});
    await admin.close();
    if (!destroyed) await db.destroy();
    await socket.stop();
    await pg.close();
  }
}
