import {
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  jetstream,
  jetstreamManager,
} from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import { createCollector, decodeEvent, encodeEvent } from "./workload.mjs";

export class NatsAdapter {
  name = "nats-jetstream";
  acknowledgement = "JetStream PubAck, file storage, R=1 in this experiment";
  gatewayState = "Filtered ordered consumer per active Session; no replay projection";
  #runId;
  #stream;
  #prefix;
  #connection;
  #js;
  #manager;
  #consumers = new Set();

  constructor(runId) {
    this.#runId = runId;
    this.#stream = `PC_${runId.toUpperCase()}`;
    this.#prefix = `pc.events.${runId}`;
  }

  async setup() {
    await this.#connect();
    await this.#manager.streams.add({
      name: this.#stream,
      subjects: [`${this.#prefix}.>`],
      storage: StorageType.File,
      retention: RetentionPolicy.Limits,
      discard: DiscardPolicy.Old,
      max_age: 60 * 60 * 1_000_000_000,
      max_msgs_per_subject: 8_192,
      num_replicas: 1,
      duplicate_window: 10 * 60 * 1_000_000_000,
    });
  }

  async #connect() {
    this.#connection = await connect({
      servers: "nats://127.0.0.1:14223",
      name: `pc-${this.#runId}`,
    });
    this.#js = jetstream(this.#connection);
    this.#manager = await jetstreamManager(this.#connection);
  }

  subject(sessionId) {
    return `${this.#prefix}.${sessionId}`;
  }

  async publish(value) {
    const ack = await this.#js.publish(this.subject(value.sessionId), encodeEvent(value), {
      msgID: value.eventId,
    });
    return { duplicate: ack.duplicate, streamSequence: ack.seq };
  }

  async #reader(filterSubject, expectedEvents, namePrefix, allowPartial = false) {
    const collector = createCollector(expectedEvents, allowPartial ? 5_000 : 30_000);
    const consumer = await this.#js.consumers.get(this.#stream, {
      name_prefix: namePrefix,
      filter_subjects: filterSubject,
      deliver_policy: DeliverPolicy.All,
      inactive_threshold: 30_000,
    });
    this.#consumers.add(consumer);
    const messages = await consumer.fetch({ max_messages: expectedEvents, expires: 20_000 });
    const run = (async () => {
      try {
        for await (const message of messages) collector.observe(decodeEvent(message.data));
      } catch (error) {
        collector.fail(error);
      }
    })();
    return {
      completion: collector.completion,
      result: () => collector.result(),
      close: async () => {
        await messages.close().catch(() => undefined);
        await run.catch(() => undefined);
        await consumer.delete().catch(() => undefined);
        this.#consumers.delete(consumer);
      },
    };
  }

  startProjector(expectedEvents) {
    return this.#reader(`${this.#prefix}.>`, expectedEvents, "projector");
  }

  async replaySession(sessionId, expectedEvents, suffix = "focused", allowPartial = false) {
    const reader = await this.#reader(
      this.subject(sessionId),
      expectedEvents,
      suffix,
      allowPartial,
    );
    await reader.completion.catch((error) => {
      if (!allowPartial) throw error;
    });
    const result = reader.result();
    await reader.close();
    return result;
  }

  async reconnect() {
    await this.#connection.close().catch(() => undefined);
    await this.#connect();
  }

  async close({ removeData = false } = {}) {
    for (const consumer of this.#consumers) await consumer.delete().catch(() => undefined);
    this.#consumers.clear();
    if (removeData) await this.#manager.streams.delete(this.#stream).catch(() => undefined);
    await this.#connection.close().catch(() => undefined);
  }
}
