import type {
  AgentEvent,
  EntryRecord,
  TaskRecord,
  SnapshotEvent,
} from "@earendil-works/pi-durable";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type {
  PiCloudEventBody,
  ModelSamplingIdentity,
  AssistantMessagePhase,
} from "@pi-cloud/protocol";

/** Converts committed native view events to PiCloud's display protocol. Native
 * history stays authoritative; source observations never become model entries. */
export class DurableRunEvents {
  #sampling: ModelSamplingIdentity | undefined;
  readonly #samplingQueue: ModelSamplingIdentity[] = [];
  #message = "";
  #ordinal = 0;
  #responseId: string | undefined;
  #timestamp: number | undefined;
  readonly #blocks = new Map<number, { text: string; phase?: AssistantMessagePhase }>();
  readonly #compactions = new Map<number, "manual" | "threshold" | "overflow">();
  #entryThrough = 0;
  #assistantEntry: EntryRecord | undefined;
  lastAssistant: AssistantMessage | undefined;
  constructor(
    readonly options: {
      writerId: string;
      emit(body: PiCloudEventBody): Promise<void>;
      toolId(
        callId: string,
        assistant?: EntryRecord,
        result?: EntryRecord,
      ): Promise<string> | string;
      phase?(responseId: string, index: number): AssistantMessagePhase | undefined;
      maximumToolOutputBytes: number;
      retryAttempts: number;
      task(
        id: number,
      ): Promise<
        | TaskRecord<
            import("@earendil-works/chord").JsonValue,
            import("@earendil-works/chord").JsonValue,
            unknown
          >
        | undefined
      >;
    },
  ) {}
  baseline(snapshot: SnapshotEvent): void {
    this.#entryThrough = Math.max(0, ...snapshot.entries.map((entry) => entry.id));
    this.#assistantEntry = snapshot.entries.findLast((entry) =>
      entry.model?.some((message) => message.role === "assistant"),
    );
    this.lastAssistant = snapshot.entries
      .flatMap((entry) => entry.model ?? [])
      .findLast((message) => message.role === "assistant");
  }
  async samplingStarted(identity: ModelSamplingIdentity): Promise<void> {
    this.#samplingQueue.push(identity);
    await this.options.emit({ type: "model.sampling.started", payload: identity });
  }
  #phase(block: TextContent, index: number): AssistantMessagePhase | undefined {
    if (block.textSignature?.startsWith("{")) {
      try {
        const signature = JSON.parse(block.textSignature);
        if (signature.v === 1 && ["commentary", "final_answer"].includes(signature.phase))
          return signature.phase;
      } catch {
        /* Provider signatures can be opaque strings. */
      }
    }
    return this.#responseId ? this.options.phase?.(this.#responseId, index) : undefined;
  }
  async #text(index: number, text: string, phase?: AssistantMessagePhase): Promise<void> {
    const old = this.#blocks.get(index),
      previous = old?.text ?? "";
    this.#blocks.set(index, { text, ...(phase ? { phase } : {}) });
    if (text === previous && old?.phase === phase) return;
    const replacing = !text.startsWith(previous) || (old !== undefined && old.phase !== phase);
    const delta = replacing ? text : text.slice(previous.length);
    if (!delta && !replacing) return;
    await this.options.emit({
      type: "assistant.text.delta",
      payload: {
        messageId: `${this.#message}:${index}`,
        text: delta,
        ...(replacing ? { replace: true } : {}),
        ...(phase ? { phase } : {}),
      },
    });
  }
  async #messageStart(message: AssistantMessage, advance = false): Promise<void> {
    if (advance) this.#sampling = this.#samplingQueue.shift();
    if (advance || this.#timestamp !== message.timestamp || !this.#message) {
      this.#message = message.responseId ?? `${this.options.writerId}:${++this.#ordinal}`;
      this.#blocks.clear();
    }
    this.#timestamp = message.timestamp;
    this.#responseId = message.responseId;
    for (const [index, block] of message.content.entries())
      if (block.type === "text") await this.#text(index, block.text, this.#phase(block, index));
  }
  async consume(events: readonly AgentEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type === "snapshot") {
        // Overflow snapshots replace dropped frames. Reconcile complete entries
        // before the current partial; never replay the pre-attachment history.
        for (const entry of event.entries)
          if (entry.id > this.#entryThrough) {
            await this.consume([{ type: "message_end", entry }]);
          }
        if (event.generation?.message) await this.#messageStart(event.generation.message);
      } else if (event.type === "message_start" && event.message.role === "assistant") {
        await this.#messageStart(event.message, true);
      } else if (event.type === "message_update") {
        for (const change of event.changes) {
          if (change.type === "text_delta") {
            const before = this.#blocks.get(change.contentIndex);
            await this.#text(
              change.contentIndex,
              (before?.text ?? "") + change.delta,
              before?.phase,
            );
          } else if (
            (change.type === "text_start" || change.type === "block") &&
            change.block.type === "text"
          ) {
            await this.#text(
              change.contentIndex,
              change.block.text,
              this.#phase(change.block, change.contentIndex),
            );
          } else if (change.type === "message") {
            for (const [index, block] of change.message.content.entries())
              if (block.type === "text")
                await this.#text(index, block.text, this.#phase(block, index));
          }
        }
      } else if (event.type === "message_end") {
        this.#entryThrough = Math.max(this.#entryThrough, event.entry.id);
        for (const message of event.entry.model ?? []) {
          if (message.role !== "assistant") continue;
          this.lastAssistant = message;
          this.#assistantEntry = event.entry;
          this.#responseId ??= message.responseId;
          if (
            !this.#message ||
            this.#timestamp !== message.timestamp ||
            (message.responseId && this.#responseId && message.responseId !== this.#responseId)
          ) {
            await this.#messageStart(message);
          } else {
            for (const [index, block] of message.content.entries())
              if (block.type === "text")
                await this.#text(index, block.text, this.#phase(block, index));
          }
          if (
            this.#sampling &&
            message.stopReason !== "pending" &&
            message.stopReason !== "deferred"
          ) {
            await this.options.emit({
              type: "model.sampling.completed",
              payload: {
                ...this.#sampling,
                outcome:
                  message.stopReason === "error"
                    ? "failed"
                    : message.stopReason === "aborted"
                      ? "aborted"
                      : "completed",
                stopReason: message.stopReason,
              },
            });
          }
        }
      } else if (event.type === "tool_execution_start") {
        await this.options.emit({
          type: "tool.started",
          payload: {
            toolCallId: await this.options.toolId(event.toolCallId, this.#assistantEntry),
            toolName: event.toolName,
            input: event.args,
            ...(this.#sampling ?? {}),
          },
        });
      } else if (event.type === "tool_execution_end") {
        const result = event.entry?.model?.find((message) => message.role === "toolResult");
        const text =
          result?.content
            .map((part) => (part.type === "text" ? part.text : `[Image: ${part.mimeType}]`))
            .join("\n") ?? "Tool task ended without a result";
        const output =
          Buffer.byteLength(text) <= this.options.maximumToolOutputBytes
            ? text
            : Buffer.from(text).subarray(0, this.options.maximumToolOutputBytes).toString("utf8") +
              "\n[Display truncated]";
        await this.options.emit({
          type: "tool.completed",
          payload: {
            toolCallId: await this.options.toolId(
              event.toolCallId,
              this.#assistantEntry,
              event.entry,
            ),
            outcome: !result || result.isError ? "failed" : "completed",
            output,
            ...(this.#sampling ?? {}),
          },
        });
      } else if (event.type === "compaction_start") {
        this.#compactions.set(event.taskId, event.reason);
        await this.options.emit({
          type: "context.compaction.started",
          payload: { reason: event.reason },
        });
      } else if (event.type === "compaction_end") {
        this.#compactions.delete(event.taskId);
        const task = await this.options.task(event.taskId);
        const outcome = task?.state.status === "terminal" ? task.state.outcome : undefined;
        await this.options.emit({
          type: "context.compaction.completed",
          payload: {
            reason: event.reason,
            status:
              outcome?.status === "completed"
                ? "completed"
                : outcome?.status === "aborted"
                  ? "aborted"
                  : "failed",
            willRetry: outcome?.status === "completed" && event.reason === "overflow",
          },
        });
      } else if (event.type === "auto_retry_start" && this.#sampling) {
        await this.options.emit({
          type: "model.sampling.retry.scheduled",
          payload: {
            stepSequence: this.#sampling.stepSequence,
            stepSha256: this.#sampling.stepSha256,
            completedSamplingAttempt: Math.max(1, event.attempt - 1),
            nextSamplingAttempt: event.attempt,
            maximumSamplingAttempts: this.options.retryAttempts,
            delayMs: Math.max(0, Math.min(300000, event.at - Date.now())),
          },
        });
      }
    }
  }
}
