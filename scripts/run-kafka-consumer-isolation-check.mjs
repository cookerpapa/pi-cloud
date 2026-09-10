import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";

if (process.env.PI_CLOUD_LIVE_KAFKA_CONSUMER_CHECK !== "1")
  throw new Error("Set PI_CLOUD_LIVE_KAFKA_CONSUMER_CHECK=1 for isolated Kafka acceptance");
if (process.argv[2] !== "inside") {
  const exec = promisify(execFile);
  const container = `pi-cloud-consumer-check-${randomUUID()}`;
  try {
    const result = await exec(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        container,
        "--network",
        "pi-cloud-production_event-log",
        "--memory",
        "1g",
        "--cpus",
        "2",
        "-v",
        `${process.cwd()}:/app:ro`,
        "-w",
        "/app",
        "-e",
        "PI_CLOUD_LIVE_KAFKA_CONSUMER_CHECK=1",
        "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
        "node",
        "--import",
        "tsx",
        "scripts/run-kafka-consumer-isolation-check.mjs",
        "inside",
      ],
      { timeout: 180000, maxBuffer: 4 * 1024 * 1024 },
    );
    const report = JSON.parse(
      result.stdout
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith('{"format"')),
    );
    await writeFile(
      "docs/reports/kafka-consumer-isolation-latest.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(JSON.stringify(report));
  } finally {
    await exec("docker", ["rm", "-f", container]).catch(() => {});
  }
} else {
  const { Admin } = await import("@platformatic/kafka");
  const { default: native } = await import("@confluentinc/kafka-javascript");
  const { KafkaAcceptedFactBus, kafkaProducerLane } =
    await import("../packages/runtime-core/src/kafka-accepted-fact.ts");
  const { KafkaAcceptedFactConsumer } =
    await import("../packages/runtime-core/src/kafka-accepted-fact-consumer.ts");
  const brokers = ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"],
    topic = `pi-cloud.consumer-check.${randomUUID()}`;
  const groupId = `consumer-check-${randomUUID()}`;
  const bus = new KafkaAcceptedFactBus({
    brokers,
    topic,
    partitions: 2,
    replicas: 3,
    retentionMs: 3600000,
    clientId: randomUUID(),
  });
  const admin = new Admin({ bootstrapBrokers: brokers, clientId: randomUUID() });
  const offsetsAdmin = new native.KafkaJS.Kafka({
    kafkaJS: { brokers, clientId: randomUUID(), logLevel: native.KafkaJS.logLevel.NOTHING },
  }).admin();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, label) => {
    const deadline = Date.now() + 45000;
    while (!(await fn())) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await sleep(20);
    }
  };
  const sessions = [0, 1].map((part) => {
    let id;
    do {
      id = randomUUID();
    } while (kafkaProducerLane(id, 2) !== part);
    return id;
  });
  const scope = (part) => ({
    tenantId: randomUUID(),
    sessionId: sessions[part],
    piSessionId: sessions[part],
    writerId: randomUUID(),
    runId: randomUUID(),
    turnId: randomUUID(),
    attemptId: randomUUID(),
    fencingToken: 1,
  });
  const scopes = [scope(0), scope(1)];
  const fact = (part, seq) => {
    const id = randomUUID(),
      now = new Date().toISOString();
    return {
      kind: "agent_event",
      factId: id,
      scope: scopes[part],
      occurredAt: now,
      event: {
        schemaVersion: 1,
        eventId: id,
        sessionId: sessions[part],
        turnId: scopes[part].turnId,
        agentId: "root",
        seq,
        type: "assistant.text.delta",
        payload: { text: "x" },
        occurredAt: now,
      },
    };
  };
  let consumer,
    peer,
    unblock = false;
  const seen = [new Set(), new Set()];
  try {
    await bus.start();
    await offsetsAdmin.connect();
    consumer = new KafkaAcceptedFactConsumer({
      brokers,
      topic,
      groupId,
      clientId: randomUUID(),
      handler: async (record) => {
        if (record.partition === 0 && !unblock) throw new Error("controlled partition stall");
        seen[record.partition].add(record.fact.event.seq);
      },
    });
    await consumer.start();
    await wait(() => {
      try {
        consumer.checkHealth();
        return true;
      } catch {
        return false;
      }
    }, "consumer ready");
    await Promise.all(Array.from({ length: 513 }, (_, i) => bus.append(fact(0, i + 1))));
    const started = performance.now();
    await bus.append(fact(1, 1));
    await wait(() => seen[1].size === 1, "unrelated partition progress");
    const otherPartitionMs = performance.now() - started;
    assert.equal(seen[0].size, 0);
    unblock = true;
    await wait(() => seen[0].size === 513, "paused partition catches up");
    peer = new KafkaAcceptedFactConsumer({
      brokers,
      topic,
      groupId,
      clientId: randomUUID(),
      handler: async (record) => {
        seen[record.partition].add(record.fact.event.seq);
      },
    });
    await peer.start();
    await wait(() => {
      try {
        peer.checkHealth();
        return true;
      } catch {
        return false;
      }
    }, "peer assigned");
    await bus.append(fact(0, 514));
    await bus.append(fact(1, 2));
    await wait(() => seen[0].has(514) && seen[1].has(2), "progress after group rebalance");
    const ends = await consumer.captureEndOffsets();
    await wait(async () => {
      const saved = await offsetsAdmin.fetchOffsets({ groupId, topics: [topic] });
      return (
        saved[0]?.partitions.length === 2 &&
        saved[0].partitions.every((p) => BigInt(p.offset) === ends[p.partition])
      );
    }, "completed delivery offsets committed");
    await peer.close();
    peer = undefined;
    await consumer.close();
    consumer = undefined;
    const replayed = [];
    consumer = new KafkaAcceptedFactConsumer({
      brokers,
      topic,
      groupId,
      clientId: randomUUID(),
      groupRecovery: true,
      replayOffsets: async (bounds) => new Map(bounds.map((b) => [b.partition, b.high - 1n])),
      handler: async (record) => {
        replayed.push(record);
      },
    });
    await consumer.start();
    await consumer.waitUntilInitialReplay(ends);
    assert.equal(replayed.length, 2);
    await consumer.close();
    consumer = undefined;
    // Simulate PG commit followed by a failed external delivery. The PG floor
    // alone would skip this record; completed group delivery must keep it live.
    await bus.append(fact(0, 515));
    let failedDelivery = false;
    consumer = new KafkaAcceptedFactConsumer({
      brokers,
      topic,
      groupId,
      clientId: randomUUID(),
      groupRecovery: true,
      replayOffsets: async (bounds) => new Map(bounds.map((b) => [b.partition, b.high])),
      handler: async () => {
        failedDelivery = true;
        throw new Error("PG projected but owner delivery did not complete");
      },
    });
    await consumer.start();
    await wait(() => failedDelivery, "post-projection delivery failure");
    await consumer.close();
    consumer = undefined;
    const redelivered = [];
    consumer = new KafkaAcceptedFactConsumer({
      brokers,
      topic,
      groupId,
      clientId: randomUUID(),
      groupRecovery: true,
      replayOffsets: async (bounds) => new Map(bounds.map((b) => [b.partition, b.high])),
      handler: async (record) => {
        redelivered.push(record.fact.event.seq);
      },
    });
    const recoveredEnds = await consumer.captureEndOffsets();
    await consumer.start();
    await consumer.waitUntilInitialReplay(recoveredEnds);
    assert.deepEqual(redelivered, [515]);
    console.log(
      JSON.stringify({
        format: "pi-cloud.consumer-isolation.v2",
        checkedAt: new Date().toISOString(),
        passed: true,
        heldPartitionRecords: 513,
        otherPartitionMs,
        allHeldRecordsRecovered: true,
        recoveryRecordsRead: replayed.length,
        projectionFloorReplayedDespiteCommittedGroup: true,
        incompleteDeliveryReplayedDespiteProjectedFloor: true,
        consumerRebalance: true,
      }),
    );
  } finally {
    unblock = true;
    await peer?.close();
    await consumer?.close();
    await bus.close();
    await offsetsAdmin.disconnect();
    await admin.deleteGroups({ groups: [groupId] }).catch(() => {});
    await admin.deleteTopics({ topics: [topic] });
    await admin.close();
  }
}
