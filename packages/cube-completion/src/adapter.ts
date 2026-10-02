import {
  parseNativeToolEvent,
  parseToolWorkerOutput,
  TOOL_PROGRESS_MAX_CHARACTERS,
  type AcceptedToolCommand,
  type NativeToolEnd,
  type ToolProgressDelivery,
  parseGuestProbeReply,
  type ExecutionEvidence,
} from "@pi-cloud/protocol";
import type { WorkerReply } from "@pi-cloud/event-log";
import { encodeSessionImages, type ImageAttachmentCodec } from "@pi-cloud/session-attachments";

type CompletionContext = {
  kind?: never;
  scope: AcceptedToolCommand["scope"];
  replyTopic: string;
  toolCallId: string;
  nativeToolCallId: string;
  toolName: string;
  partition: number;
  execution?: Omit<ExecutionEvidence, "observedAt">;
};
type ProbeCompletionContext = {
  kind: "execution_probe";
  replyTopic: string;
  sentAt: number;
  bindingIds: string[];
  execution: Omit<ExecutionEvidence, "observedAt">;
};
export type CompletionPacket = {
  id?: string;
  kind: "progress" | "result";
  operationId: string;
  context: CompletionContext | ProbeCompletionContext;
  output?: unknown;
  result?: { output?: unknown; failure?: string; quarantine?: boolean };
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
      if (
        packet.kind !== "result" ||
        !packet.result ||
        packet.result.failure ||
        packet.result.quarantine
      )
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
    let guestCompleted = false;
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
          guestCompleted = true;
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
      ...(guestCompleted && context.execution
        ? { execution: { ...context.execution, observedAt } }
        : {}),
    });
  }
}
