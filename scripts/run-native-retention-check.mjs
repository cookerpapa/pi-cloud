import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { kafkaEvaluation } from "./lib/kafka-evaluation.mjs";

await kafkaEvaluation("docs/reports/native-retention-acceptance-latest.json", async (brokers) => {
  const { Admin } = await import("@platformatic/kafka"),
    { PGlite } = await import("@electric-sql/pglite"),
    { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const { createDatabase } = await import("@pi-cloud/database"),
    { sql } = await import("kysely");
  const { PublicationHarness } = await import("./lib/publication-harness.ts"),
    { KafkaSafeRetention } = await import("../packages/runtime-core/src/kafka-safe-retention.ts");
  const topic = `pi-cloud.native-gc.${randomUUID()}`;
  const pg = await PGlite.create(),
    socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  const db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  const admin = new Admin({ bootstrapBrokers: brokers, clientId: randomUUID() });
  const bus = new PublicationHarness({
    brokers,
    topic,
    partitions: 1,
    replicas: 3,
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
    await sql`create table accepted_fact_projection_offsets(topic text,partition integer,next_offset bigint); create table runs(output_first_topic text,output_first_partition integer,output_first_offset bigint,output_sealed_at timestamptz)`.execute(
      db,
    );
    await bus.start();
    gc.start(1);
    const sessionId = randomUUID(),
      turnId = randomUUID(),
      runId = randomUUID();
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
          writerId: runId,
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
    const offset = async (timestamp) => {
      const result = await admin.listOffsets({
        topics: [{ name: topic, partitions: [{ partitionIndex: 0, timestamp }] }],
      });
      return result[0].partitions[0].offset;
    };
    const low = () => offset(-2n);
    for (let n = 1; n <= 20; n++) await append(n);
    const oldEnd = await offset(-1n);
    await new Promise((r) => setTimeout(r, 1200));
    await gc.sweep();
    assert.equal(await low(), 0n);
    await sql`insert into accepted_fact_projection_offsets values(${topic},0,${oldEnd})`.execute(
      db,
    );
    await sql`insert into runs values(${topic},0,5,null)`.execute(db);
    await gc.sweep();
    assert.equal(await low(), 5n);
    await sql`update runs set output_sealed_at=now()`.execute(db);
    await append(21);
    await sql`update accepted_fact_projection_offsets set next_offset=${await offset(-1n)}`.execute(
      db,
    );
    await gc.sweep();
    assert.equal(await low(), oldEnd);
    await db.destroy();
    destroyed = true;
    await new Promise((r) => setTimeout(r, 1200));
    await assert.rejects(gc.sweep());
    assert.equal(await low(), oldEnd);
    return {
      format: "pi-cloud.native-retention.v1",
      checkedAt: new Date().toISOString(),
      accepted: true,
      scope:
        "real R3 Kafka producer/admin deletion with socket-backed PGlite progress fixtures; no model calls",
      noCheckpointRetainsAll: true,
      unsealedPrefixPreserved: true,
      gracePreservesRecent: true,
      databaseFailureStopsDeletion: true,
      lowWatermarks: [0, 5, Number(oldEnd), Number(oldEnd)],
    };
  } finally {
    await gc.close();
    await bus.close();
    await admin.deleteTopics({ topics: [topic] }).catch(() => {});
    await admin.close();
    if (!destroyed) await db.destroy();
    await socket.stop();
    await pg.close();
  }
});
