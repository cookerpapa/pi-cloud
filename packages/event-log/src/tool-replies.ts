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
  parseToolReplyRecovery,
  type PendingToolReplyRecovery,
  type ToolReplyRecovery,
  parseEnvironmentChanged,
  type EnvironmentChanged,
} from "@pi-cloud/protocol";
import { createHash, randomUUID } from "node:crypto";
import { KafkaLogConsumer } from "./kafka-log-consumer.ts";

const { KafkaJS } = kafkaNative;
export const TOOL_REPLY_TOPIC_PREFIX = "pi-cloud.tool-replies.v4.";
const PREFIX = TOOL_REPLY_TOPIC_PREFIX;
export const TOOL_REPLY_TOPIC_PATTERN =
  /^pi-cloud\.tool-replies\.v4\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
export type WorkerReply = ToolReply | ExecutionProbeReply | EnvironmentChanged;

export function parseWorkerReply(value: string | Buffer): WorkerReply {
  const valueObject = JSON.parse(value.toString());
  if (valueObject?.kind === "environment_changed") return parseEnvironmentChanged(valueObject);
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
            key:
              reply.kind === "execution_probe"
                ? reply.probeId
                : reply.kind === "environment_changed"
                  ? reply.changeId
                  : reply.operationId,
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
  observeExecution(value: ExecutionEvidence): void;
};

/** In-memory callbacks for owned operations. A replacement reconstructs these
 * from native pending tasks before reading the original reply log. */
export class ToolReplyMailbox {
  readonly #pending = new Map<string, Pending>();
  readonly #probes = new Map<
    string,
    { resolve(value: ExecutionProbeReply): void; reject(error: unknown): void; cleanup(): void }
  >();
  onExecutionEvidence: ((operationId: string, evidence: ExecutionEvidence) => void) | undefined;
  onEnvironmentChange: ((change: EnvironmentChanged) => Promise<void> | void) | undefined;
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
    let evidence: ExecutionEvidence | undefined;
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
        observeExecution: (value) => {
          evidence = Object.freeze({ ...value });
        },
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    void promise.catch(() => {}); // cancellation may precede publication completion
    return { result: promise, executionSettled: () => settled, executionEvidence: () => evidence };
  }
  accept(reply: WorkerReply): void | Promise<void> {
    if (reply.kind === "environment_changed") return this.onEnvironmentChange?.(reply);
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
    if (reply.execution) pending.observeExecution(reply.execution);
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
  readonly #restored = new Map<
    string,
    {
      reference: ToolReplyRecovery;
      wait: ToolReplyWait<ImagePacked<ToolResultPayload>>;
      controller: AbortController;
      dispose(): void;
      startDeadline(): void;
    }
  >();
  readonly #replayConsumers = new Set<KafkaLogConsumer<WorkerReply>>();
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
  async replyPosition(): Promise<{ topic: string; partition: 0; offset: string }> {
    const offsets = await this.#consumer.captureEndOffsets();
    if (offsets[0] === undefined) throw new Error("Reply partition is unavailable");
    return { topic: this.topic, partition: 0, offset: offsets[0].toString() };
  }

  /** Restore the callbacks before replay, so results arriving before Harness
   * resume resolve the original waits rather than becoming unknown mailbox data. */
  async restore(
    references: readonly PendingToolReplyRecovery[],
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    if (!references.length) return;
    const operationIds = references.map((r) => r.operationId);
    const releaseScope = () => {
      for (const id of operationIds) {
        const pending = this.#restored.get(id);
        pending?.dispose();
        pending?.controller.abort(signal.reason);
        this.#restored.delete(id);
      }
    };
    signal.addEventListener("abort", releaseScope, { once: true });
    const grouped = new Map<string, { floor: bigint; operations: string[] }>();
    for (const original of references) {
      signal.throwIfAborted();
      const reference = parseToolReplyRecovery(original.reply);
      if (this.#restored.has(original.operationId))
        throw new Error("Tool recovery registered twice");
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const abort = () => {
        controller.abort(signal.reason);
        this.#restored.delete(original.operationId);
      };
      signal.addEventListener("abort", abort, { once: true });
      const wait = super.wait(
        original.operationId,
        reference.toolCallId,
        reference.toolName,
        controller.signal,
      );
      const dispose = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const completed = () => {
        settled = true;
        dispose();
      };
      void wait.result.then(completed, completed);
      // Start the deadline after historical catch-up below. A result already
      // committed to Kafka wins over a timer that elapsed while no Worker ran.
      const group = grouped.get(reference.topic) ?? {
        floor: BigInt(reference.offset),
        operations: [],
      };
      if (BigInt(reference.offset) < group.floor) group.floor = BigInt(reference.offset);
      group.operations.push(original.operationId);
      grouped.set(reference.topic, group);
      this.#restored.set(original.operationId, {
        reference,
        wait,
        controller,
        dispose,
        startDeadline: () => {
          if (settled) return;
          const expire = () =>
            controller.abort(
              new ToolExecutionFailure({
                code: "tool_reply_timeout",
                effect: "unknown",
                message:
                  "The original Tool reply deadline elapsed; the command was not executed again.",
              }),
            );
          const remaining = reference.deadlineAt - Date.now();
          if (remaining <= 0) expire();
          else {
            timer = setTimeout(expire, remaining);
            timer.unref();
          }
        },
      });
    }
    for (const [topic, group] of grouped) {
      const ids = new Set(group.operations);
      const groupId = `tool-restore-${this.options.bootId}-${createHash("sha256").update(topic).digest("hex").slice(0, 16)}-${randomUUID()}`;
      const consumer = new KafkaLogConsumer<WorkerReply>({
        brokers: this.options.brokers,
        clientId: `tool-restore-${this.options.bootId}`,
        groupId,
        topic,
        commitMessages: false,
        replayOffsets: async (bounds) =>
          new Map(
            bounds.map((b) => [
              b.partition,
              b.partition !== 0 || group.floor < b.low || group.floor > b.high
                ? new Error("Required Tool replies are outside Kafka retention")
                : group.floor,
            ]),
          ),
        decode: parseWorkerReply,
        handler: async ({ fact }) => {
          if ("operationId" in fact && ids.has(fact.operationId)) await this.accept(fact);
        },
      });
      this.#replayConsumers.add(consumer);
      let closed: Promise<void> | undefined;
      const close = () => {
        closed ??= consumer
          .close()
          .then(async () => {
            // Cleanup is also retried by safe retention after this boot retires.
            await this.#admin.deleteGroups([groupId]);
          })
          .catch(() => {})
          .finally(() => this.#replayConsumers.delete(consumer));
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        await consumer.start();
        await consumer.waitForPartition(0);
        for (const id of ids) this.#restored.get(id)?.startDeadline();
        const waits = group.operations.map((id) => this.#restored.get(id)?.wait.result);
        void Promise.allSettled(waits).then(() => {
          signal.removeEventListener("abort", close);
          close();
        });
      } catch (cause) {
        for (const id of ids)
          this.#restored.get(id)?.controller.abort(
            new ToolExecutionFailure(
              {
                code: "tool_handoff_unconfirmed",
                effect: "unknown",
                message:
                  "Original Tool reply recovery is unavailable; inspect effects before repeating it.",
              },
              { cause },
            ),
          );
        signal.removeEventListener("abort", close);
        close();
      }
    }
  }

  resumeWait(
    operationId: string,
    reference: ToolReplyRecovery,
    signal: AbortSignal,
  ): ToolReplyWait<ImagePacked<ToolResultPayload>> {
    const restored = this.#restored.get(operationId);
    if (
      !restored ||
      JSON.stringify(restored.reference) !== JSON.stringify(parseToolReplyRecovery(reference))
    )
      throw new Error("Original Tool reply waiter is unavailable or changed");
    this.#restored.delete(operationId);
    const abort = () => restored.controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void restored.wait.result.then(
      () => signal.removeEventListener("abort", abort),
      () => signal.removeEventListener("abort", abort),
    );
    return restored.wait;
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
            // PG native-task references and the existing safe-retention worker
            // own deletion; broker age alone cannot discard pending results.
            { name: "retention.ms", value: "-1" },
            { name: "retention.bytes", value: "-1" },
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
    for (const pending of this.#restored.values()) {
      pending.dispose();
      pending.controller.abort(new Error("Reply owner stopped"));
    }
    this.#restored.clear();
    await Promise.allSettled([...this.#replayConsumers].map((consumer) => consumer.close()));
    this.#replayConsumers.clear();
    super.close();
    await this.#consumer.close();
    try {
      // A replacement may still need this boot's results. The PG-backed
      // retention pass deletes it after all canonical waits have settled.
      const groups = await this.#admin.listGroups();
      const groupId = `tool-reply-${this.options.bootId}`;
      if (groups.groups.some((group) => group.groupId === groupId))
        await this.#admin.deleteGroups([groupId]);
    } finally {
      await this.#admin.disconnect();
    }
  }
}
