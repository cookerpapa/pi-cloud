import type {
  ProviderHostedActivity,
  ProviderHostedTranscriptItem,
} from "@pi-cloud/sandbox-supervisor";

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
  #searching = false;

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
    this.#complete(outcome);
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
      this.#start();
      return;
    }
    if (value.type === "response.web_search_call.completed") {
      this.#complete("completed");
      return;
    }
    if (value.type === "response.web_search_call.failed") {
      this.#complete("failed");
      return;
    }
    if (value.type === "response.output_item.added") {
      if (isRecord(value.item) && value.item.type === "web_search_call") this.#start();
      return;
    }
    if (value.type === "response.output_item.done") {
      if (!isRecord(value.item) || value.item.type !== "web_search_call") return;
      this.#start();
      this.#complete(value.item.status === "failed" ? "failed" : "completed");
      return;
    }
    if (value.type === "response.output_text.delta") {
      this.#complete("completed");
      return;
    }
    if (value.type === "response.completed" || value.type === "response.incomplete") {
      if (isRecord(value.response) && Array.isArray(value.response.output)) {
        const output = value.response.output.filter(isRecord);
        if (output.some((item) => item.type === "web_search_call")) {
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
      this.#complete("completed");
      return;
    }
    if (value.type === "response.failed" || value.type === "error") {
      this.#complete("failed");
    }
  }

  #start(): void {
    if (this.#searching) return;
    this.#searching = true;
    this.#emit({ phase: "started", toolName: "web_search" });
  }

  #complete(outcome: "completed" | "failed"): void {
    if (!this.#searching) return;
    this.#searching = false;
    this.#emit({ phase: "completed", toolName: "web_search", outcome });
  }
}
