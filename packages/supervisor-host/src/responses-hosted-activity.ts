import type {
  ProviderHostedActivity,
  ProviderHostedTranscriptItem,
} from "@pi-cloud/sandbox-supervisor";
import { normalizeProviderHostedWebSearchAction } from "@pi-cloud/sandbox-supervisor";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Leaves the Provider byte stream untouched. Public progress receives only
 * coarse lifecycle facts; the separate trusted callback receives completed
 * native items for the issuing Pi message.
 */
export class ResponsesHostedActivityObserver {
  readonly #emit: (activity: ProviderHostedActivity) => void;
  readonly #emitTranscript: (items: readonly ProviderHostedTranscriptItem[]) => void;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #eventData: string[] = [];
  readonly #nativeActivityIds = new Map<string, string>();
  readonly #searches = new Map<
    string,
    {
      completed: boolean;
      action?: NonNullable<Extract<ProviderHostedActivity, { phase: "completed" }>["action"]>;
    }
  >();
  #anonymousActivityId: string | undefined;
  #nextActivity = 0;

  constructor(
    emit: (activity: ProviderHostedActivity) => void,
    emitTranscript: (items: readonly ProviderHostedTranscriptItem[]) => void = () => undefined,
  ) {
    this.#emit = emit;
    this.#emitTranscript = emitTranscript;
  }

  push(chunk: Uint8Array): void {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    this.#drainLines(false);
  }

  finish(outcome: "completed" | "failed"): void {
    this.#buffer += this.#decoder.decode();
    this.#drainLines(true);
    this.#completeActive(outcome);
  }

  #drainLines(final: boolean): void {
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "");
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#acceptLine(line);
      newline = this.#buffer.indexOf("\n");
    }
    if (!final) return;
    if (this.#buffer.length > 0) this.#acceptLine(this.#buffer.replace(/\r$/, ""));
    this.#buffer = "";
    this.#flushEvent();
  }

  #acceptLine(line: string): void {
    if (line.length === 0) {
      this.#flushEvent();
      return;
    }
    if (line.startsWith("data:")) this.#eventData.push(line.slice(5).trimStart());
  }

  #flushEvent(): void {
    if (this.#eventData.length === 0) return;
    const data = this.#eventData.join("\n").trim();
    this.#eventData = [];
    if (data.length === 0 || data === "[DONE]") return;
    let value: unknown;
    try {
      value = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    if (!isRecord(value) || typeof value.type !== "string") return;

    if (
      value.type === "response.web_search_call.in_progress" ||
      value.type === "response.web_search_call.searching"
    ) {
      this.#start(value.item_id);
      return;
    }
    if (value.type === "response.web_search_call.completed") {
      this.#start(value.item_id);
      return;
    }
    if (value.type === "response.web_search_call.failed") {
      this.#complete(value.item_id, "failed");
      return;
    }
    if (value.type === "response.output_item.added") {
      if (isRecord(value.item) && value.item.type === "web_search_call") {
        this.#start(value.item.id);
      }
      return;
    }
    if (value.type === "response.output_item.done") {
      if (!isRecord(value.item) || value.item.type !== "web_search_call") return;
      this.#start(value.item.id);
      this.#complete(
        value.item.id,
        value.item.status === "failed" ? "failed" : "completed",
        normalizeProviderHostedWebSearchAction(value.item),
      );
      return;
    }
    if (value.type === "response.completed" || value.type === "response.incomplete") {
      if (isRecord(value.response) && Array.isArray(value.response.output)) {
        const output = value.response.output.filter(isRecord);
        if (output.some((item) => item.type === "web_search_call")) {
          for (const item of output.filter((item) => item.type === "web_search_call")) {
            this.#start(item.id);
            this.#complete(
              item.id,
              item.status === "failed" ? "failed" : "completed",
              normalizeProviderHostedWebSearchAction(item),
            );
          }
          this.#emitTranscript(
            output.map((item, outputIndex) => {
              const annotations =
                item.type === "message" && Array.isArray(item.content)
                  ? item.content
                      .filter(isRecord)
                      .flatMap((content) =>
                        Array.isArray(content.annotations)
                          ? content.annotations.filter(isRecord)
                          : [],
                      )
                  : [];
              return {
                outputIndex,
                type: typeof item.type === "string" ? item.type : "unknown",
                ...(typeof item.id === "string" ? { id: item.id } : {}),
                ...(item.type === "web_search_call" ? { nativeItem: item } : {}),
                ...(annotations.length === 0 ? {} : { annotations }),
              };
            }),
          );
        }
      }
      this.#completeActive("completed");
      return;
    }
    if (value.type === "response.failed" || value.type === "error") {
      this.#completeActive("failed");
    }
  }

  #activityId(candidate: unknown): string {
    const nativeId =
      typeof candidate === "string" && candidate.length > 0 && candidate.length <= 256
        ? candidate
        : undefined;
    if (nativeId !== undefined) {
      const known = this.#nativeActivityIds.get(nativeId);
      if (known !== undefined) return known;
      const anonymous = this.#anonymousActivityId;
      if (anonymous !== undefined && this.#searches.get(anonymous)?.completed === false) {
        this.#nativeActivityIds.set(nativeId, anonymous);
        this.#anonymousActivityId = undefined;
        return anonymous;
      }
      this.#nativeActivityIds.set(nativeId, nativeId);
      return nativeId;
    }
    if (
      this.#anonymousActivityId !== undefined &&
      this.#searches.get(this.#anonymousActivityId)?.completed === false
    ) {
      return this.#anonymousActivityId;
    }
    this.#nextActivity += 1;
    this.#anonymousActivityId = `web-search-${String(this.#nextActivity)}`;
    return this.#anonymousActivityId;
  }

  #start(candidate?: unknown): string {
    const activityId = this.#activityId(candidate);
    if (this.#searches.has(activityId)) return activityId;
    this.#searches.set(activityId, { completed: false });
    this.#emit({ phase: "started", toolName: "web_search", activityId });
    return activityId;
  }

  #complete(
    candidate: unknown,
    outcome: "completed" | "failed",
    action?: NonNullable<Extract<ProviderHostedActivity, { phase: "completed" }>["action"]>,
  ): void {
    const activityId = this.#start(candidate);
    const current = this.#searches.get(activityId)!;
    if (current.completed && (action === undefined || current.action !== undefined)) return;
    this.#searches.set(activityId, {
      completed: true,
      ...(action === undefined ? {} : { action }),
    });
    if (this.#anonymousActivityId === activityId) this.#anonymousActivityId = undefined;
    this.#emit({
      phase: "completed",
      toolName: "web_search",
      activityId,
      outcome,
      ...(action === undefined ? {} : { action }),
    });
  }

  #completeActive(outcome: "completed" | "failed"): void {
    for (const [activityId, state] of this.#searches) {
      if (!state.completed) this.#complete(activityId, outcome);
    }
  }
}
