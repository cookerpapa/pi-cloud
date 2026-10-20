import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";
import {
  normalizeProviderHostedWebSearchAction,
  type AssistantMessagePhase,
} from "@pi-cloud/protocol";
import type { ProviderHostedActivity } from "../agent-turn-runtime.ts";
import { hostedSearchContent } from "../provider-hosted-transcript.ts";

type RecordValue = Record<string, unknown>;
type Progress = Extract<AssistantMessageEvent, { partial: AssistantMessage }>;
type Content = AssistantMessage["content"][number];
type Kind = "text" | "thinking" | "toolCall" | "hosted";
type Item = {
  id?: string;
  kind: Kind;
  position: number;
  nativeIndex?: number;
  phase?: AssistantMessagePhase;
  annotations?: RecordValue[];
  content: Content;
  announced?: boolean;
};
const record = (v: unknown): v is RecordValue =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const phase = (v: unknown): AssistantMessagePhase | undefined =>
  v === "commentary" || v === "final_answer" ? v : undefined;
function kind(v: unknown): Kind | undefined {
  if (v === "message") return "text";
  if (v === "reasoning") return "thinking";
  if (v === "function_call" || v === "custom_tool_call") return "toolCall";
  if (v === "web_search_call") return "hosted";
  return undefined;
}
function itemId(block: Content): string | undefined {
  if (block.type === "toolCall") return block.id.split("|")[1];
  const signature = block.type === "text" ? block.textSignature : block.thinkingSignature;
  if (!signature?.startsWith("{")) return undefined;
  try {
    const value: unknown = JSON.parse(signature);
    return record(value) && typeof value.id === "string" ? value.id : undefined;
  } catch {
    return undefined;
  }
}

/** One admitted model request. Pi parses bytes; this adapter consumes its public
 * parsed events and preserves stable native progress slots. No Storage writes. */
export class ProviderResponse {
  readonly startedAt = performance.now();
  readonly timing: Partial<
    Record<"firstFrameMs" | "firstTextMs" | "firstToolMs" | "firstSearchMs", number>
  > = {};
  readonly #items: Item[] = [];
  readonly #byId = new Map<string, Item>();
  readonly #native = new Map<number, Item>();
  readonly #searches = new Map<string, { completed: boolean; action?: unknown }>();
  readonly #activityIds = new Map<string, string>();
  readonly #anonymousPrefix = crypto.randomUUID();
  #anonymous: string | undefined;
  #anonymousCount = 0;
  #started = false;
  #closed = false;
  transientFailure = false;
  #base: AssistantMessage;

  constructor(
    readonly model: Model<Api>,
    readonly publish: (event: AssistantMessageEvent) => void,
    readonly activity?: (value: ProviderHostedActivity) => void,
  ) {
    this.#base = {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      timestamp: Date.now(),
      content: [],
      stopReason: "pending",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
  }

  #item(id: string | undefined, type: Kind): Item {
    const old = id === undefined ? undefined : this.#byId.get(id);
    if (old) return old;
    const item: Item = {
      ...(id ? { id } : {}),
      kind: type,
      position: this.#items.length,
      content: { type: "text", text: "" },
    };
    this.#items.push(item);
    if (id) this.#byId.set(id, item);
    return item;
  }

  #observeItem(raw: RecordValue, completed: boolean): void {
    const type = kind(raw.type);
    if (!type || typeof raw.id !== "string" || !raw.id.length) return;
    const item = this.#item(raw.id, type);
    if (item.kind !== type) return; // Native parsing owns invalid provider protocol.
    if (type === "text") {
      // DeepSeek can revise an early final phase at completion. Until then its
      // route deliberately leaves phase unknown, preserving the existing policy.
      const nextPhase = phase(raw.phase);
      if (nextPhase && (completed || this.model.provider === "openai-codex"))
        item.phase = nextPhase;
      if (Array.isArray(raw.content)) {
        const annotations = raw.content
          .filter(record)
          .flatMap((c) => (Array.isArray(c.annotations) ? c.annotations.filter(record) : []));
        if (annotations.length) item.annotations = structuredClone(annotations);
      }
    }
    if (type !== "hosted") return;
    this.#start(raw.id);
    if (
      !completed ||
      (raw.status !== undefined && !["completed", "failed"].includes(String(raw.status)))
    )
      return;
    const native = structuredClone({ ...raw, status: raw.status ?? "completed" });
    item.content = hostedSearchContent(native, item.content);
    this.#complete(
      raw.id,
      native.status === "failed" ? "failed" : "completed",
      normalizeProviderHostedWebSearchAction(native),
    );
    this.#announce(item);
  }

  observe(value: unknown): void {
    if (this.#closed || !record(value) || typeof value.type !== "string") return;
    this.timing.firstFrameMs ??= performance.now() - this.startedAt;
    if (value.type === "error" || value.type === "response.failed") {
      const error = record(value.error)
        ? value.error
        : record(value.response) && record(value.response.error)
          ? value.response.error
          : value;
      const code = typeof error.code === "string" ? error.code : error.type;
      this.transientFailure = [
        "server_error",
        "internal_error",
        "internal_server_error",
        "service_unavailable",
        "temporarily_unavailable",
        "overloaded",
        "rate_limit_exceeded",
      ].includes(String(code));
    }
    if (
      value.type === "response.output_text.delta" &&
      typeof value.delta === "string" &&
      value.delta.length
    )
      this.timing.firstTextMs ??= performance.now() - this.startedAt;
    if (
      value.type === "response.output_item.added" &&
      record(value.item) &&
      ["function_call", "custom_tool_call"].includes(String(value.item.type))
    )
      this.timing.firstToolMs ??= performance.now() - this.startedAt;
    if (
      value.type === "response.created" &&
      record(value.response) &&
      typeof value.response.id === "string"
    )
      this.#base.responseId = value.response.id;
    if (
      (value.type === "response.output_item.added" || value.type === "response.output_item.done") &&
      record(value.item)
    )
      this.#observeItem(value.item, value.type === "response.output_item.done");
    if (
      value.type === "response.output_text.annotation.added" &&
      record(value.annotation) &&
      typeof value.item_id === "string"
    ) {
      const item = this.#byId.get(value.item_id);
      if (item) {
        const annotations = item.annotations ?? [];
        if (!annotations.some((a) => JSON.stringify(a) === JSON.stringify(value.annotation)))
          item.annotations = [...annotations, structuredClone(value.annotation)];
      }
    }
    if (
      [
        "response.web_search_call.in_progress",
        "response.web_search_call.searching",
        "response.web_search_call.completed",
      ].includes(value.type)
    )
      this.#start(value.item_id);
    if (value.type === "response.web_search_call.failed") this.#complete(value.item_id, "failed");
    if (
      ["response.completed", "response.incomplete", "response.done"].includes(value.type) &&
      record(value.response)
    ) {
      if (Array.isArray(value.response.output))
        for (const item of value.response.output.filter(record)) this.#observeItem(item, true);
    }
  }

  #announce(item: Item): void {
    if (
      !this.#started ||
      item.announced ||
      !item.content ||
      !("providerHostedTool" in item.content)
    )
      return;
    item.announced = true;
    // A completed hosted item has no model-generated text. An empty native text
    // slot carries its metadata through Pi's ordinary partial/abort commits.
    this.publish({
      type: "text_start",
      contentIndex: item.position,
      partial: this.#snapshot(false),
    });
    this.publish({
      type: "text_end",
      contentIndex: item.position,
      content: "",
      partial: this.#snapshot(false),
    });
  }

  #sync(message: AssistantMessage, includeCalls = false): void {
    this.#base = {
      ...message,
      ...(message.responseId || !this.#base.responseId
        ? {}
        : { responseId: this.#base.responseId }),
      content: [],
    };
    message.content.forEach((block, index) => {
      let item = this.#native.get(index);
      if (!item) {
        const id = itemId(block);
        item =
          (id ? this.#byId.get(id) : undefined) ??
          this.#items.find((i) => i.kind === block.type && i.nativeIndex === undefined) ??
          this.#item(id, block.type);
        item.nativeIndex = index;
        this.#native.set(index, item);
      }
      // Text/signature strings are immutable. Copy their small block, not the
      // entire growing response on every token. Draft Tool arguments never
      // need a retained copy; only successful terminal calls are detached once.
      item.content =
        block.type === "toolCall"
          ? includeCalls
            ? structuredClone(block)
            : { type: "text", text: "" }
          : { ...block };
      if (item.content.type === "text") {
        if (item.kind === "text" && !item.content.textSignature && item.id)
          item.content.textSignature = JSON.stringify({
            v: 1,
            id: item.id,
            ...(item.phase ? { phase: item.phase } : {}),
          });
        else if (item.phase && item.content.textSignature?.startsWith("{")) {
          try {
            const signature: unknown = JSON.parse(item.content.textSignature);
            if (record(signature) && signature.v === 1 && signature.phase === undefined)
              item.content.textSignature = JSON.stringify({ ...signature, phase: item.phase });
          } catch {
            /* Preserve opaque provider signatures. */
          }
        }
        if (item.annotations?.length)
          Object.assign(item.content, { providerAnnotations: item.annotations });
      }
    });
  }

  #snapshot(complete: boolean): AssistantMessage {
    return {
      ...this.#base,
      content: this.#items.map((item) =>
        !complete && item.content.type === "toolCall"
          ? { type: "text", text: "" }
          : { ...item.content },
      ),
      usage: { ...this.#base.usage, cost: { ...this.#base.usage.cost } },
    };
  }

  progress(event: Progress): void {
    if (this.#closed) return;
    this.#sync(event.partial);
    if (event.type === "start") {
      this.#started = true;
      this.publish({ type: "start", partial: this.#snapshot(false) });
      for (const item of this.#items) this.#announce(item);
      return;
    }
    if (
      event.type === "toolcall_start" ||
      event.type === "toolcall_delta" ||
      event.type === "toolcall_end"
    )
      return;
    const item = this.#native.get(event.contentIndex);
    if (!item) throw new Error("Model progress has no content identity");
    this.publish({ ...event, contentIndex: item.position, partial: this.#snapshot(false) });
  }

  result(message: AssistantMessage): AssistantMessage {
    this.#sync(message, message.stopReason === "stop" || message.stopReason === "toolUse");
    const result = this.#snapshot(
      message.stopReason === "stop" || message.stopReason === "toolUse",
    );
    this.close(
      message.stopReason === "stop" || message.stopReason === "toolUse" ? "completed" : "failed",
    );
    return result;
  }

  failure(reason: "error" | "aborted", message: string): AssistantMessage {
    this.#base = { ...this.#base, stopReason: reason, errorMessage: message };
    const result = this.#snapshot(false);
    this.close("failed");
    return result;
  }

  close(outcome: "completed" | "failed"): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, search] of this.#searches) if (!search.completed) this.#complete(id, outcome);
  }

  #id(candidate: unknown): string {
    const id =
      typeof candidate === "string" && candidate.length > 0 && candidate.length <= 256
        ? candidate
        : undefined;
    if (id) {
      const old = this.#activityIds.get(id);
      if (old) return old;
      if (this.#anonymous && !this.#searches.get(this.#anonymous)?.completed) {
        this.#activityIds.set(id, this.#anonymous);
        const result = this.#anonymous;
        this.#anonymous = undefined;
        return result;
      }
      this.#activityIds.set(id, id);
      return id;
    }
    if (this.#anonymous && !this.#searches.get(this.#anonymous)?.completed) return this.#anonymous;
    return (this.#anonymous = `web-search-${this.#anonymousPrefix}-${++this.#anonymousCount}`);
  }
  #emit(value: ProviderHostedActivity): void {
    try {
      this.activity?.(value);
    } catch {
      /* Display cannot change model semantics. */
    }
  }
  #start(candidate: unknown): string {
    this.timing.firstSearchMs ??= performance.now() - this.startedAt;
    const id = this.#id(candidate);
    if (!this.#searches.has(id)) {
      this.#searches.set(id, { completed: false });
      this.#emit({ phase: "started", toolName: "web_search", activityId: id });
    }
    return id;
  }
  #complete(
    candidate: unknown,
    outcome: "completed" | "failed",
    action?: Extract<ProviderHostedActivity, { phase: "completed" }>["action"],
  ): void {
    const id = this.#start(candidate),
      prior = this.#searches.get(id)!;
    if (prior.completed && (action === undefined || prior.action !== undefined)) return;
    this.#searches.set(id, { completed: true, ...(action ? { action } : {}) });
    this.#emit({
      phase: "completed",
      toolName: "web_search",
      activityId: id,
      outcome,
      ...(action ? { action } : {}),
    });
  }
}

export function providerTextPhase(block: TextContent): AssistantMessagePhase | undefined {
  if (block.textSignature?.startsWith("{")) {
    try {
      const value: unknown = JSON.parse(block.textSignature);
      if (record(value) && value.v === 1 && phase(value.phase)) return phase(value.phase);
    } catch {
      /* Opaque provider signature. */
    }
  }
  return undefined;
}
