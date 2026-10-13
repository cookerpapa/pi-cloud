// Isolated real Kafka + PG probes, not an alternate application runtime.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { Pool } from "pg";
import native from "@confluentinc/kafka-javascript";
import { testKafka } from "../../lib/test-kafka.mjs";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { producer, expectFenced, committedRecords } from "./client.mjs";

const execute = promisify(execFile),
  startedAt = new Date().toISOString(),
  cases = [],
  resources = [];
let kafkaFixture, postgresFixture, db, admin;
const phase = (name) => process.stdout.write(`${name}\n`);

async function probe(name, run) {
  const topic = `pi-cloud.native-fencing.${name}.${randomUUID()}`,
    clients = [];
  await admin.createTopics({
    topics: [
      {
        topic,
        numPartitions: 1,
        replicationFactor: 3,
        configEntries: [{ name: "min.insync.replicas", value: "2" }],
      },
    ],
  });
  const context = {
    topic,
    async open(session = "S", initialize = true, suffix = "") {
      const client = await producer(
        kafkaFixture.brokers,
        `${topic}-${session}${suffix}`,
        initialize,
      );
      clients.push(client);
      return client;
    },
    send: (p, id, epoch, session = "S") => p.send(topic, session, { id, epoch, session }),
    async grant(epoch, closed = false) {
      await db.query(
        "insert into research_grants(session_id, epoch, closed) values($1,$2,$3) on conflict(session_id) do update set epoch=excluded.epoch, closed=excluded.closed",
        [topic, epoch, closed],
      );
    },
    async authorized(epoch) {
      const { rows } = await db.query(
        "select epoch,closed from research_grants where session_id=$1",
        [topic],
      );
      return rows.length === 1 && rows[0].epoch === epoch && !rows[0].closed;
    },
  };
  phase(`probe:${name}`);
  try {
    const result = await run(context);
    const observed = await committedRecords(kafkaFixture.brokers, topic);
    assert.deepEqual(
      observed.map((r) => r.id),
      result.expected,
    );
    cases.push({ name, ...result, observed });
  } finally {
    const closed = await Promise.allSettled(clients.map((p) => p.close()));
    assert(
      closed.every((result) => result.status === "fulfilled"),
      "Producer cleanup failed",
    );
    await admin.deleteTopics({ topics: [topic] });
  }
}

async function measureResources(count) {
  const topic = `pi-cloud.native-fencing.resources.${randomUUID()}`;
  await admin.createTopics({
    topics: [{ topic, numPartitions: 1, replicationFactor: 3 }],
  });
  try {
    return await new Promise((resolve, reject) => {
      const child = fork(new URL("./resources.mjs", import.meta.url), [], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let result,
        stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-2000);
      });
      child.on("message", (message) => {
        result = message;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0 || !result || result.error)
          reject(new Error(`Resource probe failed: ${result?.error ?? stderr}`));
        else resolve(result);
      });
      child.send({ brokers: kafkaFixture.brokers, topic, count });
    });
  } finally {
    await admin.deleteTopics({ topics: [topic] });
  }
}

let report;
try {
  phase("start isolated Kafka RF3 and PostgreSQL");
  // Deliberately ignore integration environment overrides: only owned fixtures.
  kafkaFixture = await testKafka({});
  postgresFixture = await testPostgres({});
  db = new Pool({ connectionString: postgresFixture.url, max: 2 });
  await db.query(
    "create table research_grants(session_id text primary key,epoch integer not null,closed boolean not null)",
  );
  admin = new native.KafkaJS.Kafka({
    kafkaJS: { brokers: kafkaFixture.brokers, logLevel: native.KafkaJS.logLevel.NOTHING },
  }).admin();
  await admin.connect();

  await probe("existing-producer", async (f) => {
    await f.grant(7);
    const old = await f.open(),
      other = await f.open("T");
    await f.send(old, "old-before", 7);
    await f.grant(7, true);
    const closer = await f.open();
    await f.send(closer, "seal-7", 7);
    await f.grant(8);
    const next = await f.open();
    assert(await f.authorized(8));
    await f.send(next, "new-8", 8);
    const rejection = await expectFenced(() => f.send(old, "old-late", 7));
    await f.send(other, "other-session-unaffected", 1, "T");
    return { expected: ["old-before", "seal-7", "new-8", "other-session-unaffected"], rejection };
  });

  await probe("epoch-in-id", async (f) => {
    const old = await f.open("S", true, "-epoch-7");
    const next = await f.open("S", true, "-epoch-8");
    await f.send(next, "new-8", 8);
    await f.send(old, "old-7-still-accepted", 7);
    return { expected: ["new-8", "old-7-still-accepted"], unsafeVariant: true };
  });

  await probe("late-init-precheck", async (f) => {
    await f.grant(7);
    const old = await f.open("S", false);
    assert(await f.authorized(7));
    // The old request is suspended AFTER PG validation but BEFORE initialization.
    await f.grant(8);
    const next = await f.open();
    await f.send(next, "new-8", 8);
    await old.initialize();
    await f.send(old, "stale-7-after-new-8", 7);
    const displacedCurrent = await expectFenced(() => f.send(next, "current-8-rejected", 8));
    return { expected: ["new-8", "stale-7-after-new-8"], unsafeVariant: true, displacedCurrent };
  });

  await probe("late-init-postcheck", async (f) => {
    await f.grant(7);
    const old = await f.open("S", false);
    assert(await f.authorized(7));
    await f.grant(8);
    const next = await f.open();
    await f.send(next, "new-8", 8);
    await old.initialize();
    assert.equal(await f.authorized(7), false);
    // Fresh PG validation prevents stale data, but initialization has ALREADY
    // fenced the otherwise-authorized current producer.
    const displacedCurrent = await expectFenced(() => f.send(next, "current-8-displaced", 8));
    const reopened = await f.open();
    assert(await f.authorized(8));
    await f.send(reopened, "new-8-after-reopen", 8);
    return {
      expected: ["new-8", "new-8-after-reopen"],
      staleDataPrevented: true,
      displacedCurrent,
    };
  });

  await probe("closed-without-successor", async (f) => {
    await f.grant(7);
    const old = await f.open("S", false);
    assert(await f.authorized(7));
    await f.grant(7, true);
    const closer = await f.open();
    await f.send(closer, "seal-7", 7);
    await old.initialize();
    assert.equal(await f.authorized(7), false);
    return { expected: ["seal-7"], postInitializationAdmissionRejected: true };
  });

  await probe("closure-after-postcheck", async (f) => {
    await f.grant(7);
    const old = await f.open();
    assert(await f.authorized(7));
    await f.grant(7, true);
    const closer = await f.open();
    await f.send(closer, "seal-7", 7);
    const rejection = await expectFenced(() => f.send(old, "old-after-seal", 7));
    return { expected: ["seal-7"], rejection };
  });

  for (const count of [1, 8, 32]) {
    phase(`resources:${count} active Session producers, fresh Node process`);
    resources.push(await measureResources(count));
  }

  phase("existing ingress: real transactional tail and SIGSTOP fencing tests");
  const regression = await execute(
    process.execPath,
    [
      "node_modules/vitest/vitest.mjs",
      "run",
      "packages/event-log/test/publication.integration.test.ts",
      "--maxWorkers=1",
    ],
    {
      env: { ...process.env, PI_CLOUD_KAFKA_INTEGRATION_BROKERS: kafkaFixture.brokers.join(",") },
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  report = {
    startedAt,
    completedAt: new Date().toISOString(),
    sourceRevision: (await execute("git", ["rev-parse", "HEAD"])).stdout.trim(),
    scope:
      "Owned single-host RF3 Kafka + real PostgreSQL experiment table; primitive races, not a PiCloud runtime migration, model call, or cross-host HA proof",
    kafkaImage:
      "apache/kafka@sha256:3f7b939115cd4872e9cee9369d80bd69712fde55f9902f46d793f64848dedc75",
    clientVersion: "1.10.1",
    librdkafkaVersion: native.librdkafkaVersion,
    cases,
    resources,
    existingIngressTests: { exitCode: 0, output: regression.stdout.trim() },
  };
} finally {
  const failures = [];
  for (const close of [
    () => admin?.disconnect(),
    () => db?.end(),
    () => postgresFixture?.close(),
    () => kafkaFixture?.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "Research fixture cleanup failed");
}
report.cleanup = "All owned Kafka/PG containers and Kafka network removed";
if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
