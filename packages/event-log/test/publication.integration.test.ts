import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import native from "@confluentinc/kafka-javascript";
import { expect, it } from "vitest";
import { KafkaLogConsumer } from "../src/kafka-log-consumer.ts";
import type { KafkaPublicationWriter } from "../src/kafka-publication-writer.ts";

const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Publication acceptance deadline exceeded");
    await delay(20);
  }
}
async function fixture() {
  const topic = `publication-acceptance-${randomUUID()}`;
  const kafka = new native.KafkaJS.Kafka({
    kafkaJS: { brokers: brokers!, logLevel: native.KafkaJS.logLevel.NOTHING },
  });
  const admin = kafka.admin();
  await admin.connect();
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
  const consumers: KafkaLogConsumer<{ id: string }>[] = [];
  const writers: KafkaPublicationWriter[] = [];
  const seen: string[] = [];
  const effects: string[] = [];
  function reader(clientId: string) {
    let writer: KafkaPublicationWriter | undefined;
    const consumer: KafkaLogConsumer<{ id: string }> = new KafkaLogConsumer({
      brokers: brokers!,
      topic,
      groupId: topic,
      clientId,
      groupRecovery: true,
      orderedEffects: true,
      replayOffsets: async (bounds) => new Map(bounds.map((b) => [b.partition, b.low])),
      decode: (bytes) => JSON.parse(bytes.toString()),
      onAssigned: async (partitions, current) => {
        if (!partitions.includes(0)) return;
        writer = await consumer.openPublicationWriter(0, current);
        writers.push(writer);
      },
      onRevoked: () => {
        void writer?.close().catch(() => {});
      },
      handler: async (record, _current, commit) => {
        seen.push(record.fact.id);
        if (await commit!()) effects.push(record.fact.id);
      },
    });
    consumers.push(consumer);
    return {
      consumer,
      publish: (id: string) =>
        writer!.append({ factId: id, sessionId: "session", value: JSON.stringify({ id }) }),
    };
  }
  return {
    topic,
    kafka,
    seen,
    effects,
    reader,
    async close() {
      await Promise.allSettled(writers.map((w) => w.close()));
      await Promise.allSettled(consumers.map((c) => c.close()));
      await admin.deleteTopics({ topics: [topic] });
      await admin.disconnect();
    },
  };
}

it.skipIf(!brokers)(
  "crosses commit markers and aborted-only tails, and replays text without redispatching effects",
  async () => {
    const f = await fixture();
    const aborter = f.kafka.producer({
      kafkaJS: { transactionalId: `${f.topic}-aborted`, idempotent: true, acks: -1 },
    });
    try {
      const first = f.reader(`${f.topic}-first`);
      await first.consumer.start();
      await first.consumer.waitUntilAssigned(30_000);
      await first.publish("committed");
      await until(() => f.effects.length === 1);
      await first.consumer.waitUntilInitialReplay(await first.consumer.captureEndOffsets(), 10_000);
      await aborter.connect();
      const transaction = await aborter.transaction();
      await transaction.send({
        topic: f.topic,
        messages: [{ partition: 0, key: "session", value: '{"id":"aborted"}' }],
      });
      await transaction.abort();
      await first.consumer.waitUntilInitialReplay(await first.consumer.captureEndOffsets(), 10_000);
      expect(f.seen).toEqual(["committed"]);
      await first.consumer.close();
      const second = f.reader(`${f.topic}-second`);
      await second.consumer.start();
      await second.consumer.waitUntilAssigned(30_000);
      await until(() => f.seen.length === 2);
      await second.publish("new");
      await until(() => f.effects.length === 2);
      expect(f.seen).toEqual(["committed", "committed", "new"]);
      expect(f.effects).toEqual(["committed", "new"]);
    } finally {
      await aborter.disconnect();
      await f.close();
    }
  },
  90_000,
);

it.skipIf(!brokers || process.platform === "win32")(
  "fences a SIGSTOP old publisher before a replacement commits, then rejects its resumed late write",
  async () => {
    const f = await fixture();
    let child: ChildProcess | undefined;
    const messages: string[] = [];
    let stderr = "";
    try {
      child = fork(new URL("./fixtures/publication-owner.mjs", import.meta.url), [], {
        execArgv: ["--import", "tsx"],
        env: {
          ...process.env,
          PI_PUBLICATION_FIXTURE: JSON.stringify({ brokers, topic: f.topic, groupId: f.topic }),
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      child.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("message", (message: { type: string }) => messages.push(message.type));
      await until(() => messages.includes("ready"));
      child.send({ type: "pause-and-publish" });
      await until(() => messages.includes("paused-before-produce"));
      const replacement = f.reader(`${f.topic}-replacement`);
      await replacement.consumer.start();
      await replacement.consumer.waitUntilAssigned(40_000);
      await replacement.publish("replacement");
      await until(() => f.effects.includes("replacement"));
      child.kill("SIGCONT");
      await until(() => messages.includes("rejected") || messages.includes("unexpected-commit"));
      expect(messages).not.toContain("unexpected-commit");
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child = undefined;
      await replacement.consumer.waitUntilAssigned(30_000);
      await replacement.consumer.waitUntilInitialReplay(
        await replacement.consumer.captureEndOffsets(),
        30_000,
      );
      expect(f.seen.length).toBeGreaterThan(0);
      expect(f.seen.every((id) => id === "replacement")).toBe(true);
      expect(f.effects).toEqual(["replacement"]);
    } catch (error) {
      throw new Error(`Old publisher recovery failed: ${stderr.slice(-3000)}`, { cause: error });
    } finally {
      if (child && child.exitCode === null) {
        child.kill("SIGCONT");
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      }
      await f.close();
    }
  },
  100_000,
);
