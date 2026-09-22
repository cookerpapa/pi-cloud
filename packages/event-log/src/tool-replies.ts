import kafkaNative from "@confluentinc/kafka-javascript";
import {
  parseNativeToolEvent,
  MAX_TOOL_EXECUTION_TIMEOUT_MS,
  MAX_TOOL_RESPONSE_BYTES,
  type NativeToolEnd,
  type NativeToolEvent,
  type NativeToolUpdate,
} from "@pi-cloud/protocol";
import { KafkaLogConsumer } from "./kafka-log-consumer.ts";

const { KafkaJS } = kafkaNative;
export const TOOL_REPLY_TOPIC_PREFIX = "pi-cloud.tool-replies.v1.";
const PREFIX = TOOL_REPLY_TOPIC_PREFIX;
export const TOOL_REPLY_TOPIC_PATTERN =
  /^pi-cloud\.tool-replies\.v1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TOOL_REPLY_RETENTION_MS = 2 * (MAX_TOOL_EXECUTION_TIMEOUT_MS + 30_000);
export function toolReplyTopic(bootId: string): string {
  if (!TOOL_REPLY_TOPIC_PATTERN.test(`${PREFIX}${bootId}`))
    throw new Error("Invalid Worker boot identity");
  return `${PREFIX}${bootId}`;
}
export type ToolReply = { operationId: string; sequence: number; event: NativeToolEvent };

function parseReply(value: string | Buffer): ToolReply {
  const reply = JSON.parse(value.toString()) as ToolReply;
  if (
    typeof reply.operationId !== "string" ||
    !Number.isSafeInteger(reply.sequence) ||
    reply.sequence < 1
  )
    throw new Error("Invalid Tool reply identity");
  return { ...reply, event: parseNativeToolEvent(reply.event) };
}

export class KafkaToolReplyPublisher {
  readonly #producer;
  #bytes = 0;
  constructor(brokers: readonly string[], clientId: string) {
    const kafka = new KafkaJS.Kafka({
      kafkaJS: { brokers: [...brokers], clientId, logLevel: KafkaJS.logLevel.NOTHING },
    });
    this.#producer = kafka.producer({
      kafkaJS: { idempotent: true, acks: -1 },
      "allow.auto.create.topics": false,
      "delivery.timeout.ms": 30000,
      "message.max.bytes": MAX_TOOL_RESPONSE_BYTES,
    });
  }
  start(): Promise<void> {
    return this.#producer.connect();
  }
  async publish(topic: string, reply: ToolReply): Promise<void> {
    if (!TOOL_REPLY_TOPIC_PATTERN.test(topic)) throw new Error("Invalid Tool reply destination");
    const value = Buffer.from(JSON.stringify(reply));
    if (this.#bytes + value.byteLength > 16 * 1024 * 1024)
      throw new Error("Tool reply producer capacity exhausted");
    this.#bytes += value.byteLength;
    try {
      await this.#producer.send({
        topic,
        messages: [{ key: reply.operationId, value, partition: 0 }],
      });
    } finally {
      this.#bytes -= value.byteLength;
    }
  }
  close(): Promise<void> {
    return this.#producer.disconnect();
  }
}

type Pending = {
  sequence: number;
  toolCallId: string;
  toolName: string;
  update: ((event: NativeToolUpdate) => void) | undefined;
  resolve(event: NativeToolEnd): void;
  reject(error: unknown): void;
  cleanup(): void;
};

/** One boot-local mailbox for all slots. A new Worker never resumes old promises. */
export class ToolReplyMailbox {
  readonly #pending = new Map<string, Pending>();
  wait(
    operationId: string,
    toolCallId: string,
    toolName: string,
    signal: AbortSignal,
    update?: (event: NativeToolUpdate) => void,
  ) {
    signal.throwIfAborted();
    if (this.#pending.has(operationId)) throw new Error("Tool operation already waiting");
    const promise = new Promise<NativeToolEnd>((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(operationId);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      this.#pending.set(operationId, {
        sequence: 0,
        toolCallId,
        toolName,
        update,
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", abort),
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    void promise.catch(() => {}); // cancellation may precede publication completion
    return promise;
  }
  accept(reply: ToolReply): void {
    const pending = this.#pending.get(reply.operationId);
    if (!pending || reply.sequence <= pending.sequence) return;
    if (
      reply.event.toolCallId !== pending.toolCallId ||
      reply.event.toolName !== pending.toolName ||
      reply.sequence !== pending.sequence + 1
    ) {
      this.#finish(reply.operationId, pending, new Error("Tool reply identity/order changed"));
      return;
    }
    pending.sequence = reply.sequence;
    if (reply.event.type === "tool_execution_update") {
      try {
        pending.update?.(reply.event);
      } catch (error) {
        this.#finish(reply.operationId, pending, error);
      }
    } else {
      this.#pending.delete(reply.operationId);
      pending.cleanup();
      pending.resolve(reply.event);
    }
  }
  #finish(id: string, pending: Pending, error: unknown) {
    this.#pending.delete(id);
    pending.cleanup();
    pending.reject(error);
  }
  close(): void {
    for (const [id, pending] of this.#pending)
      this.#finish(id, pending, new Error("Tool reply Worker stopped; outcome UNKNOWN"));
  }
  get size(): number {
    return this.#pending.size;
  }
}

export class KafkaToolReplyMailbox extends ToolReplyMailbox {
  readonly topic: string;
  readonly #consumer: KafkaLogConsumer<ToolReply>;
  readonly #admin;
  constructor(readonly options: { brokers: readonly string[]; bootId: string; replicas: number }) {
    super();
    this.topic = toolReplyTopic(options.bootId);
    const kafka = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: [...options.brokers],
        clientId: `tool-reply-admin-${options.bootId}`,
        logLevel: KafkaJS.logLevel.NOTHING,
      },
    });
    this.#admin = kafka.admin();
    this.#consumer = new KafkaLogConsumer({
      brokers: options.brokers,
      clientId: `tool-reply-${options.bootId}`,
      groupId: `tool-reply-${options.bootId}`,
      topic: this.topic,
      commitMessages: false,
      decode: parseReply,
      handler: async ({ fact }) => this.accept(fact),
    });
  }
  async start(): Promise<void> {
    await this.#admin.connect();
    await this.#admin.createTopics({
      topics: [
        {
          topic: this.topic,
          numPartitions: 1,
          replicationFactor: this.options.replicas,
          configEntries: [
            { name: "retention.ms", value: String(TOOL_REPLY_RETENTION_MS) },
            { name: "min.insync.replicas", value: String(Math.max(1, this.options.replicas - 1)) },
            { name: "cleanup.policy", value: "delete" },
            { name: "max.message.bytes", value: String(MAX_TOOL_RESPONSE_BYTES) },
            { name: "segment.ms", value: "60000" },
          ],
        },
      ],
    });
    await this.#consumer.start();
    await this.#consumer.waitUntilAssigned();
  }
  async shutdown(): Promise<void> {
    super.close();
    await this.#consumer.close();
    try {
      await this.#admin.deleteTopics({ topics: [this.topic] });
      const groups = await this.#admin.listGroups();
      const groupId = `tool-reply-${this.options.bootId}`;
      if (groups.groups.some((group) => group.groupId === groupId))
        await this.#admin.deleteGroups([groupId]);
    } finally {
      await this.#admin.disconnect();
    }
  }
}
