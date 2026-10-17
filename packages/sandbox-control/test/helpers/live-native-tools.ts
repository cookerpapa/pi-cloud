import { KafkaToolReplyMailbox } from "@pi-cloud/event-log";
import {
  MAX_IMAGE_GUEST_RESPONSE_BYTES,
  parseExecutionReference,
  parseNativeToolEvent,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
} from "@pi-cloud/protocol";
import { randomUUID } from "node:crypto";
import {
  OfficialCubeSandboxRuntimeClient,
  type OfficialCubeSandboxRuntimeClientOptions,
} from "../../src/cubesandbox-runtime-client.ts";
import { SandboxControlError } from "../../src/sandbox-provider.ts";
import { InMemorySandboxBindings } from "./in-memory-sandbox-bindings.ts";

/** Live backend contract fixture: native Cube takeover + real Kafka completion.
 * Source-log admission and canonical Pi after-hooks are tested by the Worker gate. */
export async function liveNativeTools(
  runtime: OfficialCubeSandboxRuntimeClientOptions,
  bindings: InMemorySandboxBindings,
) {
  const brokers = process.env.PI_CLOUD_KAFKA_BROKERS?.split(",");
  if (!brokers?.length)
    throw new Error("Live native Tool completion requires PI_CLOUD_KAFKA_BROKERS");
  const client = new OfficialCubeSandboxRuntimeClient(runtime);
  const mailbox = new KafkaToolReplyMailbox({
    brokers,
    bootId: randomUUID(),
    replicas: Number(process.env.PI_CLOUD_KAFKA_REPLICAS ?? "3"),
  });
  try {
    await mailbox.start();
  } catch (error) {
    await mailbox.shutdown().catch(() => {});
    await client.close();
    throw error;
  }
  // The isolated backend fixture provides one source order per physical VM;
  // production obtains it from the committed Session Kafka record.
  const topic = `native-fixture-${randomUUID()}`;
  let offset = 0n;
  const position = () => ({ topic, partition: 0, offset: (++offset).toString() });
  return {
    async executeTool(
      executionReference: string,
      request: ToolSandboxOperationRequest,
      signal?: AbortSignal,
    ): Promise<ToolSandboxOperationResponse> {
      signal?.throwIfAborted();
      const binding = bindings.rows.get(request.activationId);
      if (!binding || binding.snapshot.assignment.executionReference !== executionReference)
        throw new SandboxControlError(
          "stale_session_lease",
          "Test execution binding is closed",
          false,
        );
      if (request.operation !== "tool.execute")
        throw new Error("Live fixture requires a fixed Tool");
      const identity = parseExecutionReference(executionReference),
        assignment = binding.snapshot.assignment;
      const combined = AbortSignal.any([
        AbortSignal.timeout(request.timeoutMs + 15000),
        ...(signal ? [signal] : []),
      ]);
      const result = mailbox.wait(
        request.operationId,
        request.toolCallId,
        request.toolName,
        combined,
      );
      void result.result.catch(() => {});
      const source = position();
      try {
        await client.submitTool(binding.descriptor.target, {
          source,
          operationId: request.operationId,
          executionScopeId: request.activationId,
          writerId: identity.leaseId,
          payload: {
            toolWorkerProtocolVersion: 7,
            type: "worker.operation",
            attachment: binding.descriptor.attachment,
            request,
          },
          completionContext: {
            scope: {
              tenantId: assignment.tenantId,
              sessionId: assignment.sessionId,
              piSessionId: assignment.sessionId,
              turnId: assignment.turnId,
              runId: identity.runId,
              writerId: identity.leaseId,
              leaseId: identity.leaseId,
              fencingToken: identity.fencingToken,
            },
            replyTopic: mailbox.topic,
            toolCallId: request.toolCallId,
            nativeToolCallId: request.toolCallId,
            toolName: request.toolName,
            partition: 0,
          },
          timeoutMs: request.timeoutMs + 5000,
          maximumOutputBytes:
            request.toolName === "read" ? MAX_IMAGE_GUEST_RESPONSE_BYTES : 8 * 1024 * 1024,
        });
        const event = parseNativeToolEvent({
          type: "tool_execution_end",
          ...(await result.result),
        });
        if (event.type !== "tool_execution_end") throw new Error("Native final result missing");
        return {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: request.activationId,
          operationId: request.operationId,
          operation: "tool.execute",
          event,
        };
      } catch (error) {
        if (combined.aborted) {
          throw new SandboxControlError(
            "tool_cancelled",
            "Agent stopped waiting; the command may still be running",
            false,
            error,
          );
        }
        throw error;
      }
    },
    async close() {
      await mailbox.shutdown();
      await client.close();
    },
  };
}
