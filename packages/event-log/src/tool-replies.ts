import kafkaNative from "@confluentinc/kafka-javascript";
import {
  parsePackedToolResultPayload,
  parseToolExecutionFailure,
  ToolExecutionFailure,
  type ToolExecutionFailureData,
  MAX_TOOL_RESPONSE_BYTES,
  type ToolResultPayload,
  type ToolReplyWait,
  type ImagePacked,
  validateImageReferencePayload,
  parseExecutionProbeReply,
  type ExecutionProbeReply,
  type ExecutionEvidence,
  parseExecutionEvidence,
} from "@pi-cloud/protocol";
import { KafkaLogConsumer } from "./kafka-log-consumer.ts";

const { KafkaJS } = kafkaNative;
export const TOOL_REPLY_TOPIC_PREFIX = "pi-cloud.tool-replies.v3.";
const PREFIX = TOOL_REPLY_TOPIC_PREFIX;
export const TOOL_REPLY_TOPIC_PATTERN =
  /^pi-cloud\.tool-replies\.v3\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Transport redelivery starts when a result is published, not when the Tool
// begins. A multi-hour native child wait has no Bash execution timeout.
export const TOOL_REPLY_RETENTION_MS = 2 * 60 * 60_000 + 60_000;
export function toolReplyTopic(bootId: string): string {
  if (!TOOL_REPLY_TOPIC_PATTERN.test(`${PREFIX}${bootId}`))
    throw new Error("Invalid Worker boot identity");
  return `${PREFIX}${bootId}`;
}
type ReplyIdentity = { operationId: string; sequence: 1 };
export type ToolReply = ReplyIdentity &
  (
    | {
        kind: "tool_result";
        result: ImagePacked<ToolResultPayload>;
        execution?: ExecutionEvidence;
      }
    | {
        kind: "execution_failure";
        toolCallId: string;
        toolName: string;
        failure: ToolExecutionFailureData;
      }
  );
export type WorkerReply = ToolReply | ExecutionProbeReply;

export function parseWorkerReply(value: string | Buffer): WorkerReply {
  const valueObject = JSON.parse(value.toString());
  if (valueObject?.kind === "execution_probe") return parseExecutionProbeReply(valueObject);
  const reply = valueObject as ToolReply;
  if (!reply || typeof reply.operationId !== "string" || !reply.operationId || reply.sequence !== 1)
    throw new Error("Invalid Tool reply identity");
  if (reply.kind === "execution_failure") {
    if (
      typeof reply.toolCallId !== "string" ||
      !reply.toolCallId ||
      typeof reply.toolName !== "string" ||
      !reply.toolName ||
      "event" in reply ||
      "result" in reply ||
      "execution" in reply
    )
      throw new Error("Invalid Tool failure identity");
    return { ...reply, failure: parseToolExecutionFailure(reply.failure) };
  }
  if (reply.kind !== "tool_result" || "event" in reply || "failure" in reply)
    throw new Error("Invalid Tool reply kind");
  validateImageReferencePayload(reply.result);
  if (reply.execution) parseExecutionEvidence(reply.execution);
  return {
    ...reply,
    result: parsePackedToolResultPayload(reply.result),
  };
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
  async publish(topic: string, reply: WorkerReply): Promise<void> {
    if (!TOOL_REPLY_TOPIC_PATTERN.test(topic)) throw new Error("Invalid Tool reply destination");
    const value = Buffer.from(JSON.stringify(reply));
    parseWorkerReply(value);
    if (this.#bytes + value.byteLength > 16 * 1024 * 1024)
      throw new Error("Tool reply producer capacity exhausted");
    this.#bytes += value.byteLength;
    try {
      await this.#producer.send({
        topic,
        messages: [
          {
            key: reply.kind === "execution_probe" ? reply.probeId : reply.operationId,
            value,
            partition: 0,
          },
        ],
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
  toolCallId: string;
  toolName: string;
  resolve(result: ImagePacked<ToolResultPayload>): void;
  reject(error: unknown): void;
  cleanup(): void;
  settleExecution(): void;
};

/** One boot-local mailbox for all slots. A new Worker never resumes old promises. */
export class ToolReplyMailbox {
  readonly #pending = new Map<string, Pending>();
  readonly #probes = new Map<
    string,
    { resolve(value: ExecutionProbeReply): void; reject(error: unknown): void; cleanup(): void }
  >();
  onExecutionEvidence: ((operationId: string, evidence: ExecutionEvidence) => void) | undefined;
  waitProbe(probeId: string, bindingId: string, signal: AbortSignal): Promise<ExecutionProbeReply> {
    signal.throwIfAborted();
    const key = `${probeId}:${bindingId}`;
    if (this.#probes.size >= 1024 || this.#probes.has(key))
      throw new Error("Probe mailbox capacity exhausted");
    const promise = new Promise<ExecutionProbeReply>((resolve, reject) => {
      const abort = () => {
        this.#probes.delete(key);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      this.#probes.set(key, {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", abort),
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    void promise.catch(() => {});
    return promise;
  }
  wait(
    operationId: string,
    toolCallId: string,
    toolName: string,
    signal: AbortSignal,
  ): ToolReplyWait<ImagePacked<ToolResultPayload>> {
    signal.throwIfAborted();
    if (this.#pending.has(operationId)) throw new Error("Tool operation already waiting");
    let settled = false;
    const promise = new Promise<ImagePacked<ToolResultPayload>>((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(operationId);
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      this.#pending.set(operationId, {
        toolCallId,
        toolName,
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", abort),
        settleExecution: () => {
          settled = true;
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    void promise.catch(() => {}); // cancellation may precede publication completion
    return { result: promise, executionSettled: () => settled };
  }
  accept(reply: WorkerReply): void {
    if (reply.kind === "execution_probe") {
      for (const bindingId of reply.bindingIds) {
        const key = `${reply.probeId}:${bindingId}`,
          pending = this.#probes.get(key);
        if (!pending) continue;
        this.#probes.delete(key);
        pending.cleanup();
        pending.resolve(reply);
      }
      return;
    }
    const pending = this.#pending.get(reply.operationId);
    if (!pending) return;
    const identity = reply.kind === "tool_result" ? reply.result : reply;
    if (
      identity?.toolCallId !== pending.toolCallId ||
      identity?.toolName !== pending.toolName ||
      reply.sequence !== 1 ||
      (reply.kind !== "execution_failure" && reply.kind !== "tool_result")
    ) {
      this.#finish(reply.operationId, pending, new Error("Tool reply identity/order changed"));
      return;
    }
    if (reply.kind === "execution_failure") {
      try {
        const failure = new ToolExecutionFailure(parseToolExecutionFailure(reply.failure));
        if (failure.effect === "not_started") pending.settleExecution();
        this.#finish(reply.operationId, pending, failure);
      } catch (error) {
        this.#finish(reply.operationId, pending, error);
      }
      return;
    }
    this.#pending.delete(reply.operationId);
    pending.cleanup();
    try {
      parsePackedToolResultPayload(reply.result);
    } catch {
      pending.reject(
        new ToolExecutionFailure({
          code: "tool_reply_protocol_error",
          effect: "unknown",
          message:
            "Tool completion did not match the final reply protocol; inspect effects before repeating it.",
        }),
      );
      return;
    }
    pending.settleExecution();
    pending.resolve(reply.result);
    if (reply.execution) {
      try {
        this.onExecutionEvidence?.(reply.operationId, reply.execution);
      } catch {
        /* Observations cannot fail a Tool. */
      }
    }
  }
  #finish(id: string, pending: Pending, error: unknown) {
    this.#pending.delete(id);
    pending.cleanup();
    pending.reject(error);
  }
  close(): void {
    for (const [id, pending] of this.#probes) {
      this.#probes.delete(id);
      pending.cleanup();
      pending.reject(new Error("Probe Worker stopped"));
    }
    for (const [id, pending] of this.#pending)
      this.#finish(id, pending, new Error("Tool reply Worker stopped; outcome UNKNOWN"));
  }
  get size(): number {
    return this.#pending.size;
  }
}

export class KafkaToolReplyMailbox extends ToolReplyMailbox {
  readonly topic: string;
  readonly #consumer: KafkaLogConsumer<WorkerReply>;
  readonly #admin;
  /** Current local assignment/consumer state, never a network health probe. */
  get ready(): boolean {
    try {
      this.#consumer.checkHealth();
      return true;
    } catch {
      return false;
    }
  }
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
      resumeFromMemory: true,
      decode: parseWorkerReply,
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
