import type { PiCloudMetrics } from "@pi-cloud/observability";
import { randomUUID } from "node:crypto";
import {
  parseExecutionReference,
  PublicationNotSentError,
  durableToolIntent,
  type DurableCommitPublication,
  type DurableCommitPublisher,
  type AcceptedToolCancellation,
} from "@pi-cloud/protocol";
import { encodeSessionImages, type ImageAttachmentCodec } from "@pi-cloud/session-attachments";
import type {
  AcceptedDurableCommitFact,
  ActiveExecutionLogResolver,
  AcceptedFactScope,
  DurableToolDispatch,
} from "./accepted-fact.ts";
import { isDeepStrictEqual } from "node:util";

/** One physical Session's native commit and its effects share the existing
 * ingress. Cloud grants remain outside the SDK; image bytes stay outside Kafka. */
export class DurableSessionPublisher {
  #closed = false;
  constructor(
    readonly options: {
      channels: ActiveExecutionLogResolver;
      images?: ImageAttachmentCodec;
      metrics?: PiCloudMetrics;
      replyTopic: string;
    },
  ) {}
  checkHealth(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Native publisher is closed"));
    return this.options.channels.checkHealth();
  }
  async close(): Promise<void> {
    this.#closed = true;
  }
  #timing(stage: "attachment_prepare" | "kafka_publish", started: number): void {
    try {
      this.options.metrics?.observeSessionMutation(stage, performance.now() - started);
    } catch {
      /* Observation cannot change ACK semantics. */
    }
  }
  scoped(executionReference: string): DurableCommitPublisher {
    return {
      publish: async (publication: DurableCommitPublication) => {
        if (this.#closed) throw new PublicationNotSentError("Native publisher is closed");
        const anchor = this.options.channels.resolve(executionReference);
        if (!anchor) throw new PublicationNotSentError("Native publication anchor is unavailable");
        const { leaseId: _lease, piConversationId: _lane, ...scope } = anchor.publication.scope;
        let fact: AcceptedDurableCommitFact;
        const preparing = performance.now();
        try {
          const resolve = (reference: string): AcceptedFactScope => {
            const channel = this.options.channels.resolve(reference);
            if (!channel) throw new Error("Tool execution grant is unavailable");
            const {
              leaseId,
              piConversationId: _conversation,
              ...identity
            } = channel.publication.scope;
            const token = parseExecutionReference(reference);
            if (
              identity.tenantId !== scope.tenantId ||
              identity.piSessionId !== scope.piSessionId ||
              identity.writerId !== scope.writerId ||
              identity.fencingToken !== scope.fencingToken ||
              token.runId !== identity.runId ||
              token.leaseId !== leaseId ||
              token.fencingToken !== identity.fencingToken
            )
              throw new Error("Native effect belongs to another Session owner");
            return identity;
          };
          const tools: DurableToolDispatch[] = publication.tools.map(({ taskId, command }) => {
            const identity = resolve(command.executionReference),
              intent = durableToolIntent(publication.commit, taskId);
            if (
              command.toolCallId !== `task:${taskId}` ||
              command.request.operation !== "tool.execute" ||
              command.request.toolCallId !== intent.callId ||
              !isDeepStrictEqual(command.request.args, intent.arguments)
            )
              throw new Error("Remote Tool intent changed");
            const { args: _args, toolCallId: _callId, ...request } = command.request;
            return {
              toolCallId: command.toolCallId,
              occurredAt: command.occurredAt,
              ...(command.traceContext ? { traceContext: command.traceContext } : {}),
              request,
              taskId,
              factId: command.request.operationId,
              scope: { ...identity, leaseId: identity.writerId },
              replyTopic: this.options.replyTopic,
            };
          });
          const cancellations: AcceptedToolCancellation[] = publication.cancellations.map(
            (command) => ({
              kind: "tool_cancel",
              factId: randomUUID(),
              scope: resolve(command.executionReference),
              request: { activationId: command.activationId, operationId: command.operationId },
              occurredAt: command.occurredAt,
            }),
          );
          const commit = await encodeSessionImages(
            this.options.images,
            { tenantId: scope.tenantId, runId: scope.runId },
            publication.commit,
          );
          fact = {
            kind: "durable_commit",
            factId: randomUUID(),
            scope,
            commit,
            origins: publication.origins,
            tools,
            cancellations,
            events: publication.events,
            occurredAt: new Date().toISOString(),
          };
        } catch (error) {
          throw new PublicationNotSentError("Native commit preparation failed", { cause: error });
        } finally {
          this.#timing("attachment_prepare", preparing);
        }
        const publishing = performance.now();
        try {
          await anchor.commitNative(fact);
        } finally {
          this.#timing("kafka_publish", publishing);
        }
      },
    };
  }
}
