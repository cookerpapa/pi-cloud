// Research-only primitives. No PiCloud production authority or transport is replaced.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import native from "@confluentinc/kafka-javascript";

export const call = (run) =>
  new Promise((resolve, reject) => run((error, value) => (error ? reject(error) : resolve(value))));

export async function producer(brokers, transactionalId, initialize = true) {
  const client = new native.Producer({
    "metadata.broker.list": brokers.join(","),
    "client.id": `native-fencing-${randomUUID()}`,
    "transactional.id": transactionalId,
    "enable.idempotence": true,
    acks: -1,
    "transaction.timeout.ms": 15_000,
    "queue.buffering.max.messages": 4096,
    "queue.buffering.max.kbytes": 65536,
    "linger.ms": 1,
    "retry.backoff.ms": 5,
    "retry.backoff.max.ms": 1000,
    "allow.auto.create.topics": false,
    log_level: 0,
  });
  client.on("event.error", () => {});
  await call((cb) => client.connect({ timeout: 10_000 }, cb));
  client.setPollInterval(10);
  const result = {
    client,
    initialize: () => call((cb) => client.initTransactions(15_000, cb)),
    async send(topic, session, body) {
      await call((cb) => client.beginTransaction(cb));
      client.produce(topic, 0, Buffer.from(JSON.stringify(body)), Buffer.from(session));
      await call((cb) => client.commitTransaction(10_000, cb));
    },
    close: () => call((cb) => client.disconnect(cb)),
  };
  try {
    if (initialize) await result.initialize();
    return result;
  } catch (error) {
    await result.close();
    throw error;
  }
}

export async function expectFenced(operation) {
  try {
    await operation();
  } catch (error) {
    const codes = native.CODES.ERRORS;
    assert(
      [codes.ERR__FENCED, codes.ERR_PRODUCER_FENCED, codes.ERR_INVALID_PRODUCER_EPOCH].includes(
        error.code,
      ),
      `Expected fencing, received ${error.code}: ${error.message}`,
    );
    return { code: error.code, fatal: error.isFatal ?? null, message: error.message };
  }
  throw new Error("Expected old producer to be fenced");
}

export async function committedRecords(brokers, topic) {
  const client = new native.KafkaConsumer({
    "metadata.broker.list": brokers.join(","),
    "group.id": `native-fencing-read-${randomUUID()}`,
    "enable.auto.commit": false,
    "enable.auto.offset.store": false,
    "enable.partition.eof": true,
    "isolation.level": "read_committed",
    "allow.auto.create.topics": false,
    "fetch.wait.max.ms": 25,
    log_level: 0,
  });
  client.on("event.error", () => {});
  let eof = -1;
  client.on("partition.eof", (event) => {
    eof = Math.max(eof, event.offset);
  });
  const records = [];
  try {
    await call((cb) => client.connect({ topic, timeout: 10_000 }, cb));
    const { highOffset } = await call((cb) => client.queryWatermarkOffsets(topic, 0, 10_000, cb));
    client.setDefaultConsumeTimeout(100);
    client.assign([{ topic, partition: 0, offset: 0 }]);
    const deadline = performance.now() + 20_000;
    while (eof < highOffset) {
      assert(performance.now() < deadline, `Committed reader did not reach EOF for ${topic}`);
      const batch = await call((cb) => client.consume(100, cb));
      for (const record of batch) records.push(JSON.parse(record.value.toString()));
    }
    return records;
  } finally {
    await call((cb) => client.disconnect(cb));
  }
}

export async function processResources() {
  const status = await readFile("/proc/self/status", "utf8");
  return {
    rssBytes: process.memoryUsage().rss,
    threads: Number(/^Threads:\s+(\d+)$/m.exec(status)[1]),
    descriptors: (await readdir("/proc/self/fd")).length,
  };
}
