import type { ProviderHostedActivity } from "@pi-cloud/sandbox-supervisor";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Observes only coarse Hosted Tool lifecycle facts while leaving the Provider
 * byte stream untouched. Search queries, results and Provider IDs never leave
 * the Model Gateway through this path.
 */
export class ResponsesHostedActivityObserver {
  readonly #emit: (activity: ProviderHostedActivity) => void;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #eventData: string[] = [];
  #searching = false;

  constructor(emit: (activity: ProviderHostedActivity) => void) {
    this.#emit = emit;
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
    if (value.type === "response.completed") {
      this.#complete("completed");
      return;
    }
    if (
      value.type === "response.incomplete" ||
      value.type === "response.failed" ||
      value.type === "error"
    ) {
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
