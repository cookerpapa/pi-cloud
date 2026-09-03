import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import type { ProviderHostedWebSearchAction } from "@pi-cloud/protocol";
import type { ProviderHostedTranscript } from "./agent-turn-runtime.ts";

type JsonRecord = Record<string, unknown>;

export type ProviderHostedToolCallContent = Readonly<{
  type: "providerHostedToolCall";
  toolName: "web_search";
  nativeItem: Readonly<JsonRecord>;
  action?: ProviderHostedWebSearchAction;
  previousItemId?: string;
  nextItemId?: string;
}>;

type ProviderAnnotatedTextContent = Readonly<{
  type: "text";
  text: string;
  textSignature?: string;
  providerAnnotations?: readonly Readonly<JsonRecord>[];
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, maximumLength);
}

function publicSearchUrl(value: unknown): string | undefined {
  const url = boundedText(value, 16_384);
  return url?.replace(/#ws_call_id=[A-Za-z0-9._-]+$/u, "");
}

export function normalizeProviderHostedWebSearchAction(
  value: unknown,
): ProviderHostedWebSearchAction | undefined {
  const action = isRecord(value) && isRecord(value.action) ? value.action : value;
  if (!isRecord(action)) return undefined;
  if (action.type === "open_page") {
    const url = publicSearchUrl(action.url);
    return url === undefined ? undefined : { type: "open_page", url };
  }
  if (action.type === "find_in_page") {
    const url = publicSearchUrl(action.url);
    const pattern = boundedText(action.pattern, 4_096);
    return url === undefined && pattern === undefined
      ? undefined
      : {
          type: "find_in_page",
          ...(url === undefined ? {} : { url }),
          ...(pattern === undefined ? {} : { pattern }),
        };
  }
  if (action.type !== "search" && action.query === undefined && action.queries === undefined) {
    return undefined;
  }
  const candidates = [
    ...(Array.isArray(action.queries) ? action.queries : []),
    ...(action.query === undefined ? [] : [action.query]),
  ];
  const queries = [
    ...new Set(
      candidates
        .map((query) => boundedText(query, 4_096))
        .filter((query): query is string => query !== undefined && !/^ws_call_id=/u.test(query)),
    ),
  ].slice(0, 16);
  return queries.length === 0 ? undefined : { type: "search", queries };
}

function contentItemId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "toolCall" && typeof value.id === "string") {
    return value.id.split("|")[1];
  }
  const signature = value.type === "text" ? value.textSignature : value.thinkingSignature;
  if (typeof signature !== "string" || !signature.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(signature) as unknown;
    return isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function isHostedToolBlock(value: unknown): value is ProviderHostedToolCallContent {
  return (
    isRecord(value) &&
    value.type === "providerHostedToolCall" &&
    value.toolName === "web_search" &&
    isRecord(value.nativeItem)
  );
}

function nearestItemId(
  items: ProviderHostedTranscript["items"],
  start: number,
  direction: -1 | 1,
): string | undefined {
  for (let index = start + direction; index >= 0 && index < items.length; index += direction) {
    const id = items[index]?.id;
    if (typeof id === "string" && items[index]?.type !== "web_search_call") return id;
  }
  return undefined;
}

/**
 * Adds Provider-native Hosted Tool items to the exact Pi assistant message
 * produced by the same Responses request. The Agent Loop still sees only
 * ordinary `toolCall` blocks as locally executable Tools.
 */
export function applyProviderHostedTranscript(
  message: AssistantMessage,
  transcript: ProviderHostedTranscript,
): void {
  if (
    message.provider !== transcript.provider ||
    message.api !== transcript.api ||
    message.model !== transcript.modelId
  ) {
    return;
  }

  const original = message.content as unknown[];
  const byId = new Map<string, unknown>();
  for (const block of original) {
    const id = contentItemId(block);
    if (id !== undefined) byId.set(id, block);
  }
  const existingHostedById = new Map<string, ProviderHostedToolCallContent>();
  for (const block of original.filter(isHostedToolBlock)) {
    if (typeof block.nativeItem.id === "string") {
      existingHostedById.set(block.nativeItem.id, block);
    }
  }
  const ordered: unknown[] = [];
  const used = new Set<unknown>();

  for (let index = 0; index < transcript.items.length; index += 1) {
    const item = transcript.items[index]!;
    if (item.type === "web_search_call" && item.nativeItem !== undefined) {
      const nativeId = item.nativeItem.id;
      const existing = typeof nativeId === "string" ? existingHostedById.get(nativeId) : undefined;
      if (existing !== undefined) {
        ordered.push(existing);
        used.add(existing);
        continue;
      }
      const previousItemId = nearestItemId(transcript.items, index, -1);
      const nextItemId = nearestItemId(transcript.items, index, 1);
      const action = normalizeProviderHostedWebSearchAction(item.nativeItem);
      ordered.push({
        type: "providerHostedToolCall",
        toolName: "web_search",
        nativeItem: item.nativeItem,
        ...(action === undefined ? {} : { action }),
        ...(previousItemId === undefined ? {} : { previousItemId }),
        ...(nextItemId === undefined ? {} : { nextItemId }),
      } satisfies ProviderHostedToolCallContent);
      continue;
    }
    if (item.id === undefined) continue;
    const block = byId.get(item.id);
    if (block === undefined) continue;
    if (item.type === "message" && item.annotations !== undefined && isRecord(block)) {
      block.providerAnnotations = item.annotations;
    }
    ordered.push(block);
    used.add(block);
  }

  for (const block of original) {
    if (!used.has(block)) ordered.push(block);
  }
  original.splice(0, original.length, ...ordered);
}

function inputItems(payload: unknown): JsonRecord[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.input)) return undefined;
  return payload.input.every(isRecord) ? payload.input : undefined;
}

function findInputItem(items: readonly JsonRecord[], id: string): number {
  return items.findIndex((item) => item.id === id);
}

function replayAnnotations(items: JsonRecord[], block: ProviderAnnotatedTextContent): void {
  if (block.providerAnnotations === undefined || block.providerAnnotations.length === 0) return;
  const id = contentItemId(block);
  if (id === undefined) return;
  const item = items.find((candidate) => candidate.id === id && candidate.type === "message");
  if (item === undefined || !Array.isArray(item.content)) return;
  const outputText = item.content.find(
    (candidate): candidate is JsonRecord => isRecord(candidate) && candidate.type === "output_text",
  );
  if (outputText !== undefined) outputText.annotations = block.providerAnnotations;
}

function insertHostedItem(items: JsonRecord[], block: ProviderHostedToolCallContent): void {
  const nativeId = block.nativeItem.id;
  if (typeof nativeId === "string" && findInputItem(items, nativeId) >= 0) return;
  const nextIndex = block.nextItemId === undefined ? -1 : findInputItem(items, block.nextItemId);
  if (nextIndex >= 0) {
    items.splice(nextIndex, 0, { ...block.nativeItem });
    return;
  }
  const previousIndex =
    block.previousItemId === undefined ? -1 : findInputItem(items, block.previousItemId);
  if (previousIndex >= 0) items.splice(previousIndex + 1, 0, { ...block.nativeItem });
}

/** Replays native IDs only to the exact Provider/API/model that issued them. */
export function replayProviderHostedTranscripts(
  payload: unknown,
  context: Context,
  model: Model<Api>,
): unknown {
  const items = inputItems(payload);
  if (items === undefined) return payload;
  for (const message of context.messages) {
    if (
      message.role !== "assistant" ||
      message.provider !== model.provider ||
      message.api !== model.api ||
      message.model !== model.id
    ) {
      continue;
    }
    for (const block of message.content as unknown[]) {
      if (isHostedToolBlock(block)) insertHostedItem(items, block);
      else if (isRecord(block) && block.type === "text") {
        replayAnnotations(items, block as ProviderAnnotatedTextContent);
      }
    }
  }
  return payload;
}
