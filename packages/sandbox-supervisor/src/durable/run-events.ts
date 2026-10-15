import type {
  AgentEvent,
  EntryRecord,
  TaskRecord,
  SnapshotEvent,
} from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PiCloudEventBody, ModelSamplingIdentity } from "@pi-cloud/protocol";

/** Converts committed native view events to PiCloud's display protocol. Native
 * history stays authoritative; source observations never become model entries. */
export class DurableRunEvents {
  #sampling: ModelSamplingIdentity | undefined;
  readonly #samplingQueue: ModelSamplingIdentity[] = [];
  #messageOpen = false;
  readonly #compactions = new Map<number, "manual" | "threshold" | "overflow">();
  #entryThrough = 0;
  readonly #humanEntries = new Set<number>();
  lastAssistant: AssistantMessage | undefined;
  constructor(
    readonly options: {
      emit(body: PiCloudEventBody): Promise<void>;
      humanInput?(
        entryId: number,
      ): Promise<
        | { inputId: string; text: string; uploads: import("@pi-cloud/protocol").UserUpload[] }
        | undefined
      >;
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
  #messageStart(advance = false): void {
    if (advance) this.#sampling = this.#samplingQueue.shift();
    this.#messageOpen = true;
  }
  async consume(events: readonly AgentEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type === "entry_appended" && event.entry.model?.some((m) => m.role === "user")) {
        await this.#humanEntry(event.entry);
      } else if (event.type === "snapshot") {
        // Overflow snapshots replace dropped frames. Reconcile complete entries
        // before the current partial; never replay the pre-attachment history.
        for (const entry of event.entries) {
          if (entry.id <= this.#entryThrough) continue;
          await this.consume([{ type: "message_end", entry }]);
        }
        if (event.generation?.message) this.#messageStart(!this.#messageOpen);
      } else if (event.type === "message_start" && event.message.role === "assistant") {
        this.#messageStart(true);
      } else if (event.type === "message_end") {
        if (event.entry.id <= this.#entryThrough) continue;
        this.#entryThrough = Math.max(this.#entryThrough, event.entry.id);
        for (const message of event.entry.model ?? []) {
          if (message.role === "user") {
            await this.#humanEntry(event.entry);
            continue;
          }
          if (message.role !== "assistant") continue;
          this.lastAssistant = message;
          // Overflow recovery can supply complete Entries without their start
          // events. Advance once at that boundary, even with equal timestamps.
          this.#messageStart(!this.#messageOpen);
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

  async #humanEntry(entry: EntryRecord): Promise<void> {
    if (this.#humanEntries.has(entry.id)) return;
    const input = await this.options.humanInput?.(entry.id);
    if (!input) return;
    this.#humanEntries.add(entry.id);
    await this.options.emit({
      type: "user.input",
      payload: {
        messageId: `entry:${entry.id}`,
        inputId: input.inputId,
        text: input.text,
        ...(input.uploads.length ? { uploads: input.uploads } : {}),
      },
    });
  }
}
