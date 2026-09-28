import type { PiSessionAppendPublisher } from "@pi-cloud/protocol/native-session";
import { PublicationNotSentError } from "@pi-cloud/protocol/native-session";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import { encodeSessionImages, type ImageAttachmentCodec } from "@pi-cloud/session-attachments";
import type { ActiveExecutionLogResolver, CandidatePiSessionAppendFact } from "./accepted-fact.ts";

export type PiSessionAppendScope = CandidatePiSessionAppendFact["scope"];

/** The Harness append boundary ends at Kafka replication ACK. There is no
 * PG receipt map, polling loop, second payload copy or per-Step read barrier. */
export class NativeSessionLogPublisher {
  readonly #channels: ActiveExecutionLogResolver;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #images: ImageAttachmentCodec | undefined;
  #closed = false;
  constructor(options: {
    channels: ActiveExecutionLogResolver;
    metrics?: PiCloudMetrics;
    images?: ImageAttachmentCodec;
    toolReplyTopic?: string;
  }) {
    this.#channels = options.channels;
    this.#metrics = options.metrics;
    this.#images = options.images;
    this.#toolReplyTopic = options.toolReplyTopic;
  }
  readonly #toolReplyTopic: string | undefined;
  scoped(scope: PiSessionAppendScope): PiSessionAppendPublisher {
    return {
      publish: async (items, events = [], publication) => {
        if (this.#closed)
          throw new PublicationNotSentError("Pi Session append publisher is closed");
        const channel = this.#channels.resolve(scope.executionReference);
        if (!channel) throw new PublicationNotSentError("Pi Session Fact Stream is unavailable");
        const mutationId = crypto.randomUUID();
        const preparing = performance.now();
        let stored;
        try {
          stored = await encodeSessionImages(
            this.#images,
            { tenantId: scope.tenantId, runId: scope.runId },
            items,
          );
          if (publication?.signal?.aborted)
            throw new PublicationNotSentError("Native Session append cancelled before enqueue", {
              cause: publication.signal.reason,
            });
          if (publication?.toolCommand && !this.#toolReplyTopic)
            throw new Error("Tool invocation reply topic is unavailable");
        } catch (error) {
          if (error instanceof PublicationNotSentError) throw error;
          throw new PublicationNotSentError("Native Session append preparation failed", {
            cause: error,
          });
        } finally {
          this.#metrics?.observeSessionMutation(
            "attachment_prepare",
            performance.now() - preparing,
          );
        }
        const publishing = performance.now();
        try {
          const ack = await channel.mutate({
            schemaVersion: 1,
            mutationId,
            scope,
            items: stored,
            events,
            occurredAt: new Date().toISOString(),
            ...(publication?.toolCommand
              ? {
                  toolCommand: { ...publication.toolCommand, replyTopic: this.#toolReplyTopic! },
                }
              : {}),
          });
          if (ack.mutationId !== mutationId || !ack.accepted)
            throw new Error("Pi Session append identity changed");
        } finally {
          this.#metrics?.observeSessionMutation("kafka_publish", performance.now() - publishing);
        }
      },
    };
  }
  async checkHealth() {
    if (this.#closed) throw new Error("Pi Session append publisher is closed");
    await this.#channels.checkHealth();
  }
  async close() {
    this.#closed = true;
  }
}
