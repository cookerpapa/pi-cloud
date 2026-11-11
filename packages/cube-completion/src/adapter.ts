import {
  parseGuestToolPreview,
  parseToolWorkerOutput,
  parseExecutorCompletion,
  type NativeToolEnd,
  type ToolProgressDelivery,
  parseGuestProbeReply,
  type ToolCompletionContext,
  type ProbeCompletionContext,
} from "@pi-cloud/protocol";
import type { WorkerReply } from "@pi-cloud/event-log";
import { encodeSessionImages, type ImageAttachmentCodec } from "@pi-cloud/session-attachments";

export type CompletionPacket = {
  kind: "progress" | "result";
  operationId: string;
  context: ToolCompletionContext | ProbeCompletionContext;
  output?: unknown;
  result?: { output?: unknown };
};

export class CubeCompletionAdapter {
  constructor(
    readonly options: {
      images?: ImageAttachmentCodec;
      publish(topic: string, reply: WorkerReply): Promise<void>;
      progress: { update(value: ToolProgressDelivery): void; forget(id: string): void };
    },
  ) {}

  async accept(packet: CompletionPacket): Promise<void> {
    const context = packet.context;
    const observedAt = Date.now();
    if (context.kind === "execution_probe") {
      if (packet.kind !== "result" || !packet.result)
        throw new Error("Execution probe did not complete");
      const result = parseGuestProbeReply(packet.result.output);
      if (result.probeId !== packet.operationId)
        throw new Error("Execution probe identity changed");
      await this.options.publish(context.replyTopic, {
        kind: "execution_probe",
        probeId: result.probeId,
        guestBootId: result.guestBootId,
        sentAt: context.sentAt,
        bindingIds: context.bindingIds,
        evidence: { ...context.execution, observedAt },
      });
      return;
    }
    if (
      !packet.operationId ||
      !context?.scope?.tenantId ||
      !context.scope.runId ||
      !context.replyTopic ||
      !context.toolCallId ||
      !context.nativeToolCallId ||
      !context.toolName ||
      !Number.isSafeInteger(context.partition)
    )
      throw new Error("Invalid completion context");
    const errorEvent = (code: string, message: string): NativeToolEnd => ({
      type: "tool_execution_end",
      toolCallId: context.nativeToolCallId,
      toolName: context.toolName,
      isError: true,
      result: { content: [{ type: "text", text: `${code}: ${message}` }], details: undefined },
    });
    if (packet.kind === "progress") {
      if (context.kind === "executor_tool") throw new Error("Device progress is not supported");
      const raw = parseGuestToolPreview(packet.output);
      if (
        raw.operationId !== packet.operationId ||
        raw.toolCallId !== context.nativeToolCallId ||
        raw.toolName !== context.toolName
      )
        throw new Error("Progress identity changed");
      this.options.progress.update({
        tenantId: context.scope.tenantId,
        partition: context.partition,
        progress: {
          type: "tool.progress",
          version: 2,
          sessionId: context.scope.sessionId,
          turnId: context.scope.turnId,
          toolCallId: context.toolCallId,
          operationId: packet.operationId,
          update: raw.update,
        },
      });
      return;
    }
    if (packet.kind !== "result" || !packet.result) throw new Error("Missing execution result");
    this.options.progress.forget(packet.operationId);
    const fail = async (
      code: string,
      message: string,
      effect: "not_started" | "unknown" = "unknown",
    ) => {
      await this.options.publish(context.replyTopic, {
        kind: "execution_failure",
        operationId: packet.operationId,
        sequence: 1,
        toolCallId: context.nativeToolCallId,
        toolName: context.toolName,
        failure: { code, message: message.slice(0, 4096), effect },
      });
    };
    let event: NativeToolEnd;
    if (context.kind === "executor_tool") {
      let output: ReturnType<typeof parseExecutorCompletion>;
      try {
        output = parseExecutorCompletion(packet.result.output);
      } catch {
        return fail("executor_reply_protocol_error", "Device completion protocol changed");
      }
      if (output.type === "executor.unknown")
        return fail(
          "executor_result_unknown",
          "The device did not return a confirmed result. The action may have happened; inspect its state before repeating it.",
        );
      event = { type: "tool_execution_end", ...output.result };
    } else {
      let output: ReturnType<typeof parseToolWorkerOutput>;
      try {
        output = parseToolWorkerOutput(packet.result.output);
      } catch {
        await fail(
          "tool_reply_protocol_error",
          "Guest completion did not match the fixed Tool protocol",
        );
        return;
      }
      if (output.type === "worker.failed") {
        await fail(output.code, output.message);
        return;
      }
      if (
        output.type !== "worker.operation_result" ||
        output.response.operationId !== packet.operationId
      )
        return fail("tool_reply_protocol_error", "Guest completion identity changed");
      const response = output.response;
      if (response.type === "tool_sandbox.operation_failed") {
        await fail(response.code, response.message);
        return;
      }
      if (response.operation !== "tool.execute" || response.event.type !== "tool_execution_end")
        return fail(
          "tool_reply_protocol_error",
          "Fixed tool completion requires a native final result",
        );
      event = response.event;
    }
    if (event.toolCallId !== context.nativeToolCallId || event.toolName !== context.toolName)
      return fail("tool_reply_protocol_error", "Native completion identity changed");
    const images = event.result.content.filter((p) => p.type === "image");
    const encoded = await (
      images.length > 1 ||
      (images.length &&
        event.toolName !== (context.kind === "executor_tool" ? "android_observe" : "read"))
        ? Promise.reject(new Error("The declared observation Tool returns at most one image"))
        : encodeSessionImages(
            this.options.images,
            { tenantId: context.scope.tenantId, runId: context.scope.runId },
            event,
          )
    ).catch(() =>
      encodeSessionImages(
        undefined,
        { tenantId: context.scope.tenantId },
        errorEvent(
          "image_attachment_upload_failed",
          "The image could not be stored; no image was added to model context.",
        ),
      ),
    );
    const { type: _nativeType, ...result } = encoded;
    await this.options.publish(context.replyTopic, {
      kind: "tool_result",
      operationId: packet.operationId,
      sequence: 1,
      result,
      ...(context.execution ? { execution: { ...context.execution, observedAt } } : {}),
    });
  }
}
