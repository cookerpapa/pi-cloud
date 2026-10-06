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
  #messageOpen = false;
  readonly #blocks = new Map<number, { text: string; phase?: AssistantMessagePhase }>();
  readonly #compactions = new Map<number, "manual" | "threshold" | "overflow">();
  #entryThrough = 0;
  readonly #activeTools = new Set<string>();
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
    // A recovered partial belongs to the previous request. Pi converts it to
    // an aborted Entry before issuing a new request; do not consume the new
    // request's identity when that old message ends.
    this.#messageOpen = snapshot.generation?.message !== undefined;
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
    this.#messageOpen = true;
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
        for (const entry of event.entries) {
          if (entry.id <= this.#entryThrough) continue;
          for (const message of entry.model ?? [])
            if (message.role === "toolResult") {
              await this.consume([
                {
                  type: "tool_execution_end",
                  toolCallId: message.toolCallId,
                  toolName: message.toolName,
                  entry,
                },
              ]);
            }
          await this.consume([{ type: "message_end", entry }]);
        }
        for (const slot of event.tools)
          if (slot.status === "running") {
            const call = this.#assistantEntry?.model
              ?.flatMap((message) => (message.role === "assistant" ? message.content : []))
              .find((part) => part.type === "toolCall" && part.id === slot.callId);
            await this.consume([
              {
                type: "tool_execution_start",
                toolCallId: slot.callId,
                toolName: slot.name,
                args: call?.type === "toolCall" ? JSON.parse(JSON.stringify(call.arguments)) : {},
              },
            ]);
          }
        if (event.generation?.message)
          await this.#messageStart(event.generation.message, !this.#messageOpen);
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
        if (event.entry.id <= this.#entryThrough) continue;
        this.#entryThrough = Math.max(this.#entryThrough, event.entry.id);
        for (const message of event.entry.model ?? []) {
          if (message.role !== "assistant") continue;
          this.lastAssistant = message;
          this.#assistantEntry = event.entry;
          this.#responseId ??= message.responseId;
          // Overflow recovery can supply complete Entries without their start
          // events. Advance once at that boundary, even with equal timestamps.
          await this.#messageStart(message, !this.#messageOpen);
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
          this.#messageOpen = false;
        }
      } else if (event.type === "tool_execution_start") {
        const toolCallId = await this.options.toolId(event.toolCallId, this.#assistantEntry);
        if (this.#activeTools.has(toolCallId)) continue;
        this.#activeTools.add(toolCallId);
        await this.options.emit({
          type: "tool.started",
          payload: {
            toolCallId,
            toolName: event.toolName,
            input: event.args,
            ...(this.#sampling ?? {}),
          },
        });
      } else if (event.type === "tool_execution_end") {
        const toolCallId = await this.options.toolId(
          event.toolCallId,
          this.#assistantEntry,
          event.entry,
        );
        this.#activeTools.delete(toolCallId);
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
            toolCallId,
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
      } else if (event.type === "auto_retry_start") {
        // Native retry progress precedes the completed Entry in the same
        // publication. A terminal-only failure may not have started yet.
        const sampling = this.#messageOpen
          ? this.#sampling
          : (this.#samplingQueue[0] ?? this.#sampling);
        if (!sampling) continue;
        await this.options.emit({
          type: "model.sampling.retry.scheduled",
          payload: {
            stepSequence: sampling.stepSequence,
            stepSha256: sampling.stepSha256,
            completedSamplingAttempt: event.attempt,
            nextSamplingAttempt: event.attempt + 1,
            maximumSamplingAttempts: this.options.retryAttempts,
            delayMs: Math.max(0, Math.min(300000, event.at - Date.now())),
          },
        });
      }
    }
  }
}
