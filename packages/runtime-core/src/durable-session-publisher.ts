import type { PiCloudMetrics } from "@pi-cloud/observability";
import { randomUUID } from "node:crypto";
import {
  parseExecutionReference,
  PublicationNotSentError,
  durableToolIntent,
  durableControlIntent,
  durableControlRecovery,
  DurableCommitIndex,
  isControlToolCommand,
  isExecutorToolCommand,
  isNamedToolCommand,
  parseDurableDisplayDescription,
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

/** One physical Session's native commit and its effects share its direct Kafka
 * publication. Cloud grants stay outside the SDK; image bytes stay outside Kafka. */
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
          const resolve = (reference: string, conversationId?: number): AcceptedFactScope => {
            const channel = this.options.channels.resolve(reference, conversationId);
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
          const index = new DurableCommitIndex(publication.commit);
          const tools: DurableToolDispatch[] = publication.tools.map(({ taskId, command }) => {
            const sourceTask = index.task(taskId);
            const identity = resolve(
              command.executionReference,
              isNamedToolCommand(command)
                ? command.conversationId
                : (sourceTask?.conversationId as number | undefined),
            );
            if (isExecutorToolCommand(command)) {
              const intent = durableToolIntent(publication.commit, taskId, index);
              if (
                command.toolCallId !== `task:${taskId}` ||
                command.nativeCallId !== intent.callId ||
                !isDeepStrictEqual(command.arguments, intent.arguments) ||
                sourceTask?.conversationId !== command.conversationId
              )
                throw new Error("Executor Tool intent changed");
              return {
                target: "executor",
                operationId: command.operationId,
                bindingId: command.bindingId,
                taskId,
                conversationId: command.conversationId,
                toolName: command.toolName,
                scope: identity,
                replyTopic: this.options.replyTopic,
              };
            }
            if (isControlToolCommand(command)) {
              let recovery;
              if (command.recovery) {
                if (command.recovery.documentId === undefined)
                  throw new Error("Control recovery has no native document");
                recovery = { ...command.recovery, documentId: command.recovery.documentId };
                durableControlRecovery(
                  publication.commit,
                  { taskId, operationId: command.operationId, recovery },
                  index,
                );
              } else {
                const intent = durableControlIntent(
                  publication.commit,
                  { ...command, taskId },
                  index,
                );
                if (
                  command.nativeCallId !== intent.callId ||
                  !isDeepStrictEqual(command.arguments, intent.arguments)
                )
                  throw new Error("Control Tool intent changed");
              }
              if (command.toolCallId !== `task:${taskId}`)
                throw new Error("Control Tool task changed");
              return {
                target: "control",
                operationId: command.operationId,
                taskId,
                conversationId: command.conversationId,
                toolName: command.toolName,
                contextAnchor: command.contextAnchor,
                ...(recovery ? { recovery } : {}),
                ...(command.bindingId ? { bindingId: command.bindingId } : {}),
                ...(command.sourceDocumentId ? { sourceDocumentId: command.sourceDocumentId } : {}),
                ...(command.replyMode ? { replyMode: command.replyMode } : {}),
                ...(command.workflowKey ? { workflowKey: command.workflowKey } : {}),
                scope: identity,
                replyTopic: this.options.replyTopic,
              };
            }
            const intent = durableToolIntent(publication.commit, taskId, index);
            if (
              command.toolCallId !== `task:${taskId}` ||
              command.request.toolCallId !== intent.callId ||
              !(command.request.operation === "tool.execute"
                ? isDeepStrictEqual(command.request.args, intent.arguments)
                : command.request.script === intent.arguments.script)
            )
              throw new Error("Remote Tool intent changed");
            const request =
              command.request.operation === "tool.execute"
                ? (({ args: _args, toolCallId: _callId, ...rest }) => rest)(command.request)
                : (({ script: _script, toolCallId: _callId, ...rest }) => rest)(command.request);
            return {
              target: "cube",
              occurredAt: command.occurredAt,
              ...(command.traceContext ? { traceContext: command.traceContext } : {}),
              request,
              taskId,
              scope: identity,
              replyTopic: this.options.replyTopic,
            };
          });
          const cancellations: AcceptedToolCancellation[] = publication.cancellations.map(
            (command) => ({
              kind: "tool_cancel",
              scope: resolve(command.executionReference, command.conversationId),
              request: {
                activationId: command.activationId,
                operationId: command.operationId,
                ...(command.target ? { target: command.target } : {}),
              },
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
            ...(publication.inputQueueSessions?.length
              ? { inputQueueSessions: publication.inputQueueSessions }
              : {}),
            tools,
            cancellations,
            display: publication.display.map(
              ({ executionReference, conversationId, events, coveredThrough }) => {
                const target = resolve(executionReference, conversationId);
                for (const text of events) {
                  parseDurableDisplayDescription(text);
                  if (
                    text.event.sessionId !== target.sessionId ||
                    text.event.turnId !== target.turnId
                  )
                    throw new Error("Native display belongs to another Run");
                }
                return {
                  scope: target,
                  events,
                  ...(coveredThrough === undefined ? {} : { coveredThrough }),
                };
              },
            ),
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
