import { KafkaJS } from "@confluentinc/kafka-javascript";
import { createCollector, decodeEvent } from "./workload.mjs";

const { CompressionTypes, Kafka, logLevel } = KafkaJS;

function client(clientId) {
  return new Kafka({
    "bootstrap.servers": "127.0.0.1:19094",
    "client.id": clientId,
    log_level: 0,
  });
}

export class KafkaAdapter {
  name = "kafka";
  acknowledgement = "acks=all, idempotent producer, single broker in this experiment";
  gatewayState = "Session-indexed replay projection or partition scan";
  #topic;
  #producer;
  #admin;
  #consumers = new Set();

  constructor(runId) {
    this.#topic = `pc-stream-${runId}`;
    const kafka = client(`pc-stream-producer-${runId}`);
    this.#producer = kafka.producer({
      "allow.auto.create.topics": false,
      "enable.idempotence": true,
      "max.in.flight.requests.per.connection": 5,
      "request.timeout.ms": 10_000,
      "delivery.timeout.ms": 30_000,
      "linger.ms": 5,
      acks: -1,
      "compression.codec": CompressionTypes.LZ4,
    });
    this.#producer.logger().setLogLevel(logLevel.NOTHING);
    this.#admin = kafka.admin();
  }

  async setup() {
    await this.#admin.connect();
    await this.#admin.createTopics({
      topics: [{ topic: this.#topic, numPartitions: 16, replicationFactor: 1 }],
    });
    await this.#producer.connect();
  }

  async publish(value) {
    await this.#producer.send({
      topic: this.#topic,
      messages: [{ key: value.sessionId, value: JSON.stringify(value) }],
    });
    return { duplicate: false };
  }

  async startProjector(expectedEvents, groupSuffix = "projector") {
    const collector = createCollector(expectedEvents);
    const consumer = client(`pc-stream-${groupSuffix}`).consumer({
      "group.id": `${this.#topic}-${groupSuffix}`,
      "allow.auto.create.topics": false,
      "auto.offset.reset": "earliest",
      "enable.auto.commit": false,
    });
    consumer.logger().setLogLevel(logLevel.NOTHING);
    this.#consumers.add(consumer);
    await consumer.connect();
    await consumer.subscribe({ topics: [this.#topic] });
    const run = consumer
      .run({
        partitionsConsumedConcurrently: 16,
        eachMessage: async ({ message }) => {
          try {
            const value = decodeEvent(message.value);
            collector.observe(value);
          } catch (error) {
            collector.fail(error);
          }
        },
      })
      .catch((error) => collector.fail(error));
    const readyDeadline = Date.now() + 15_000;
    while (consumer.assignment().length === 0) {
      if (Date.now() >= readyDeadline) throw new Error("Kafka projector assignment timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return {
      completion: collector.completion,
      result: () => collector.result(),
      close: async () => {
        await consumer.disconnect().catch(() => undefined);
        await run.catch(() => undefined);
        this.#consumers.delete(consumer);
      },
    };
  }

  async replaySession(sessionId, expectedEvents, suffix = "focused", allowPartial = false) {
    const collector = createCollector(expectedEvents, allowPartial ? 5_000 : 30_000);
    const consumer = client(`pc-stream-${suffix}`).consumer({
      "group.id": `${this.#topic}-${suffix}-${Date.now().toString(36)}`,
      "allow.auto.create.topics": false,
      "auto.offset.reset": "earliest",
      "enable.auto.commit": false,
    });
    consumer.logger().setLogLevel(logLevel.NOTHING);
    await consumer.connect();
    await consumer.subscribe({ topics: [this.#topic] });
    const run = consumer
      .run({
        partitionsConsumedConcurrently: 16,
        eachMessage: async ({ message }) => {
          try {
            const value = decodeEvent(message.value);
            collector.observe(value, value.sessionId === sessionId);
          } catch (error) {
            collector.fail(error);
          }
        },
      })
      .catch((error) => collector.fail(error));
    await collector.completion.catch((error) => {
      if (!allowPartial) throw error;
    });
    const result = collector.result();
    await consumer.disconnect();
    await run.catch(() => undefined);
    return result;
  }

  async close({ removeData = false } = {}) {
    for (const consumer of this.#consumers) await consumer.disconnect().catch(() => undefined);
    this.#consumers.clear();
    await this.#producer.disconnect().catch(() => undefined);
    if (removeData) {
      await this.#admin
        .deleteTopics({ topics: [this.#topic], timeout: 10_000 })
        .catch(() => undefined);
    }
    await this.#admin.disconnect().catch(() => undefined);
  }

  topic() {
    return this.#topic;
  }
}
