import {
  parseNativeToolEvent,
  parseToolWorkerOutput,
  TOOL_PROGRESS_MAX_CHARACTERS,
  type AcceptedToolCommand,
  type NativeToolEnd,
  type ToolProgressDelivery,
  type ImagePacked,
} from "@pi-cloud/protocol";
import { encodeSessionImages, type ImageAttachmentCodec } from "@pi-cloud/session-attachments";

type CompletionContext = {
  scope: AcceptedToolCommand["scope"];
  replyTopic: string;
  toolCallId: string;
  nativeToolCallId: string;
  toolName: string;
  partition: number;
};
export type CompletionPacket = {
  id?: string;
  kind: "progress" | "result";
  operationId: string;
  context: CompletionContext;
  output?: unknown;
  result?: { output?: unknown; failure?: string; quarantine?: boolean };
};

export class CubeCompletionAdapter {
  constructor(
    readonly options: {
      images?: ImageAttachmentCodec;
      publish(
        topic: string,
        reply: { operationId: string; sequence: 1; event: ImagePacked<NativeToolEnd> },
      ): Promise<void>;
      progress: { update(value: ToolProgressDelivery): void; forget(id: string): void };
    },
  ) {}

  async accept(packet: CompletionPacket): Promise<void> {
    const context = packet.context;
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
      const raw = packet.output as { operationId: string; sequence: number; event: unknown };
      const event = parseNativeToolEvent(raw.event);
      if (
        raw.operationId !== packet.operationId ||
        event.type !== "tool_execution_update" ||
        event.toolCallId !== context.nativeToolCallId ||
        event.toolName !== context.toolName ||
        !Number.isSafeInteger(raw.sequence) ||
        raw.sequence < 1
      )
        throw new Error("Progress identity changed");
      const text = event.partialResult.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n")
        .slice(-TOOL_PROGRESS_MAX_CHARACTERS);
      if (text)
        this.options.progress.update({
          tenantId: context.scope.tenantId,
          partition: context.partition,
          progress: {
            type: "tool.progress",
            sessionId: context.scope.sessionId,
            turnId: context.scope.turnId,
            toolCallId: context.toolCallId,
            operationId: packet.operationId,
            revision: raw.sequence,
            text,
          },
        });
      return;
    }
    if (packet.kind !== "result" || !packet.result) throw new Error("Missing execution result");
    this.options.progress.forget(packet.operationId);
    let event: NativeToolEnd;
    if (packet.result.failure) {
      const code =
        packet.result.quarantine || packet.result.failure === "tool_sandbox_unavailable"
          ? "cubesandbox_tool_unavailable"
          : ["execution_not_started", "read_capacity_timeout", "tool_cancelled"].includes(
                packet.result.failure,
              )
            ? packet.result.failure
            : "cubesandbox_tool_result_unknown";
      event = errorEvent(
        code,
        packet.result.quarantine
          ? "The execution scope could not be stopped; the runtime requires control-plane recovery."
          : "Tool execution did not provide a confirmed result; inspect effects before deciding to repeat it.",
      );
    } else {
      const output = parseToolWorkerOutput(packet.result.output);
      if (output.type === "worker.failed") event = errorEvent(output.code, output.message);
      else {
        if (
          output.type !== "worker.operation_result" ||
          output.response.operationId !== packet.operationId
        )
          throw new Error("Guest completion identity changed");
        const response = output.response;
        if (response.type === "tool_sandbox.operation_failed")
          event = errorEvent(response.code, response.message);
        else {
          if (response.operation !== "tool.execute" || response.event.type !== "tool_execution_end")
            throw new Error("Fixed tool completion requires a native final result");
          event = response.event;
        }
      }
    }
    if (event.toolCallId !== context.nativeToolCallId || event.toolName !== context.toolName)
      throw new Error("Native completion identity changed");
    const images = event.result.content.filter((p) => p.type === "image");
    const encoded = await (
      images.length > 1 || (images.length && event.toolName !== "read")
        ? Promise.reject(new Error("Fixed tools return at most one read image"))
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
    await this.options.publish(context.replyTopic, {
      operationId: packet.operationId,
      sequence: 1,
      event: encoded,
    });
  }
}
