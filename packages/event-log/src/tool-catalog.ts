import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import kafkaNative from "@confluentinc/kafka-javascript";
import {
  MAX_TOOL_CATALOG_BYTES,
  TOOL_CATALOG_KEY,
  TOOL_CATALOG_TOPIC,
  parseToolCatalogPublication,
  type ControlToolCatalog,
  type ControlToolCatalogSource,
  type ToolCatalogPublication,
} from "@pi-cloud/protocol";
import { KafkaLogConsumer } from "./kafka-log-consumer.ts";

/** One current, code-owned directory; no runnable source or execution authority. */
export class ToolCatalogView implements ControlToolCatalogSource {
  #value: ToolCatalogPublication | undefined;
  readonly #listeners = new Set<() => void>();

  get ready(): boolean {
    return this.#value !== undefined;
  }
  get snapshot(): ToolCatalogPublication | undefined {
    return this.#value;
  }
  read(): ControlToolCatalog {
    if (!this.#value) throw new Error("Tool catalog has not been restored");
    return this.#value.catalog;
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  accept(input: unknown): void {
    const next = parseToolCatalogPublication(input);
    if (
      createHash("sha256").update(JSON.stringify(next.catalog.tools)).digest("hex") !==
      next.catalog.revision
    )
      throw new Error("Tool catalog digest does not match its definitions");
    const old = this.#value;
    if (old && next.generation < old.generation) return;
    if (old?.generation === next.generation) {
      if (!isDeepStrictEqual(old, next))
        throw new Error("Tool catalog generation changed its contents");
      return;
    }
    this.#value = structuredClone(next);
    for (const listener of this.#listeners) listener();
  }
  replayable(name: string): boolean {
    return this.#value?.replayable.includes(name) === true;
  }
}

async function ensureTopic(brokers: readonly string[], replicas: number): Promise<void> {
  const client = new kafkaNative.KafkaJS.Kafka({
    kafkaJS: {
      brokers: [...brokers],
      clientId: "tool-catalog-bootstrap",
      logLevel: kafkaNative.KafkaJS.logLevel.NOTHING,
    },
  });
  const admin = client.admin();
  try {
    await admin.connect();
    await admin.createTopics({
      topics: [
        {
          topic: TOOL_CATALOG_TOPIC,
          numPartitions: 1,
          replicationFactor: replicas,
          configEntries: [
            { name: "cleanup.policy", value: "compact" },
            { name: "retention.ms", value: "-1" },
            { name: "min.insync.replicas", value: String(Math.max(1, replicas - 1)) },
            { name: "max.message.bytes", value: String(MAX_TOOL_CATALOG_BYTES + 4096) },
            { name: "segment.bytes", value: String(16 * 1024 * 1024) },
          ],
        },
      ],
    });
  } finally {
    await admin.disconnect();
  }
}

/** Every boot uses its own group: catalogs are broadcast, not work sharing.
 * Rebuild from retained snapshots; a PG-selected minimum generation is the
 * startup watermark, avoiding transactional control offsets as fake records. */
export class KafkaToolCatalogConsumer {
  readonly view = new ToolCatalogView();
  readonly #consumer: KafkaLogConsumer<ToolCatalogPublication>;
  #closed = false;
  #bootstrapped = false;

  constructor(
    readonly options: {
      brokers: readonly string[];
      replicas: number;
      instanceId: string;
      minimumGeneration(): Promise<number>;
      onSnapshot?(snapshot: ToolCatalogPublication): void;
    },
  ) {
    this.#consumer = new KafkaLogConsumer({
      brokers: options.brokers,
      clientId: `catalog-${options.instanceId}`,
      groupId: `tool-catalog-${options.instanceId}`,
      topic: TOOL_CATALOG_TOPIC,
      commitMessages: false,
      replayOffsets: async (bounds) => new Map(bounds.map((p) => [p.partition, p.low])),
      decode: (body) => {
        if (Buffer.byteLength(body) > MAX_TOOL_CATALOG_BYTES)
          throw new Error("Tool catalog exceeds its transport budget");
        return parseToolCatalogPublication(JSON.parse(body.toString()));
      },
      handler: async ({ fact }, current) => {
        if (current?.() === false) return;
        const prior = this.view.snapshot?.generation;
        this.view.accept(fact);
        if (prior !== this.view.snapshot?.generation) options.onSnapshot?.(this.view.snapshot!);
      },
    });
  }
  get ready(): boolean {
    if (!this.#bootstrapped || this.#closed) return false;
    try {
      this.#consumer.checkHealth();
      return this.view.ready;
    } catch {
      return false;
    }
  }
  async start(timeoutMs = 120_000): Promise<void> {
    await ensureTopic(this.options.brokers, this.options.replicas);
    const minimum = Math.max(1, await this.options.minimumGeneration());
    await this.#consumer.start();
    await this.#consumer.waitUntilAssigned(timeoutMs);
    const until = Date.now() + timeoutMs;
    while (!this.#closed && Date.now() < until) {
      if ((this.view.snapshot?.generation ?? 0) >= minimum) {
        this.#bootstrapped = true;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Tool catalog did not reach the selected startup generation");
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#bootstrapped = false;
    await this.#consumer.close();
    const kafka = new kafkaNative.KafkaJS.Kafka({
      kafkaJS: {
        brokers: [...this.options.brokers],
        clientId: "catalog-retirement",
        logLevel: kafkaNative.KafkaJS.logLevel.NOTHING,
      },
    });
    const admin = kafka.admin();
    try {
      await admin.connect();
      await admin.deleteGroups([`tool-catalog-${this.options.instanceId}`]);
    } catch {
      /* An empty ephemeral group may already have expired. */
    } finally {
      await admin.disconnect();
    }
  }
}

/** Kafka fences overlapping catalog publishers. Selection is checked both
 * before and after producer initialization; unlike Session effects, retrying a
 * complete immutable configuration snapshot is idempotent. */
export class KafkaToolCatalogPublisher {
  #producer: import("@confluentinc/kafka-javascript").Producer | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(
    readonly options: {
      brokers: readonly string[];
      replicas: number;
      instanceId: string;
      authorize(snapshot: ToolCatalogPublication): Promise<boolean>;
    },
  ) {}

  publish(input: ToolCatalogPublication): Promise<void> {
    const snapshot = structuredClone(parseToolCatalogPublication(input));
    const body = Buffer.from(JSON.stringify(snapshot));
    if (body.byteLength > MAX_TOOL_CATALOG_BYTES)
      return Promise.reject(new Error("Tool catalog exceeds its transport budget"));
    const next = this.#tail
      .catch(() => {})
      .then(async () => {
        if (this.#closed || !(await this.options.authorize(snapshot)))
          throw new Error("Tool catalog release is no longer selected");
        try {
          if (!this.#producer) {
            await ensureTopic(this.options.brokers, this.options.replicas);
            const producer = new kafkaNative.Producer({
              "metadata.broker.list": this.options.brokers.join(","),
              "client.id": `catalog-publisher-${this.options.instanceId}`,
              "transactional.id": `${TOOL_CATALOG_TOPIC}-publisher`,
              "enable.idempotence": true,
              acks: -1,
              "allow.auto.create.topics": false,
              "message.max.bytes": MAX_TOOL_CATALOG_BYTES + 4096,
              "transaction.timeout.ms": 15000,
            });
            producer.on("event.error", () => {});
            this.#producer = producer;
            await new Promise<void>((resolve, reject) =>
              producer.connect({}, (error) => (error ? reject(error) : resolve())),
            );
            await new Promise<void>((resolve, reject) =>
              producer.initTransactions(10000, (error) => (error ? reject(error) : resolve())),
            );
            producer.setPollInterval(10);
          }
          if (this.#closed || !(await this.options.authorize(snapshot)))
            throw new Error("Tool catalog selection changed during initialization");
          const producer = this.#producer;
          await new Promise<void>((resolve, reject) =>
            producer.beginTransaction((error) => (error ? reject(error) : resolve())),
          );
          producer.produce(TOOL_CATALOG_TOPIC, 0, body, TOOL_CATALOG_KEY);
          await new Promise<void>((resolve, reject) =>
            producer.commitTransaction(10000, (error) => (error ? reject(error) : resolve())),
          );
        } catch (error) {
          const producer = this.#producer;
          this.#producer = undefined;
          if (producer) await new Promise<void>((resolve) => producer.disconnect(() => resolve()));
          throw error;
        }
      });
    this.#tail = next;
    return next;
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#tail.catch(() => {});
    const producer = this.#producer;
    this.#producer = undefined;
    if (producer) await new Promise<void>((resolve) => producer.disconnect(() => resolve()));
  }
}
