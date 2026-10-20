import type { Api, AssistantMessage, Context, Model, TextContent } from "@earendil-works/pi-ai";
import {
  normalizeProviderHostedWebSearchAction,
  type ProviderHostedWebSearchAction,
} from "@pi-cloud/protocol";

export type ProviderHostedToolCallContent = TextContent &
  Readonly<{
    text: "";
    textSignature: string;
    providerHostedTool: Readonly<{
      toolName: "web_search";
      nativeItem: Readonly<Record<string, unknown>>;
      action?: ProviderHostedWebSearchAction;
    }>;
  }>;
export type ProviderAnnotatedTextContent = TextContent &
  Readonly<{
    providerAnnotations?: readonly Readonly<Record<string, unknown>>[];
  }>;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isHostedToolBlock(value: unknown): value is ProviderHostedToolCallContent {
  return (
    record(value) &&
    value.type === "text" &&
    value.text === "" &&
    typeof value.textSignature === "string" &&
    record(value.providerHostedTool) &&
    value.providerHostedTool.toolName === "web_search" &&
    record(value.providerHostedTool.nativeItem)
  );
}

/** Valid native progress with no invented visible text or local Tool effect. */
export function hostedSearchContent(
  nativeItem: Readonly<Record<string, unknown>>,
  previous?: unknown,
): ProviderHostedToolCallContent {
  const action = normalizeProviderHostedWebSearchAction(nativeItem);
  return {
    type: "text",
    text: "",
    textSignature: isHostedToolBlock(previous)
      ? previous.textSignature
      : JSON.stringify({
          v: 1,
          id: `msg_picloud_hosted_${crypto.randomUUID().replaceAll("-", "")}`,
        }),
    providerHostedTool: {
      toolName: "web_search",
      nativeItem: structuredClone(nativeItem),
      ...(action ? { action } : {}),
    },
  };
}

function sameModel(message: AssistantMessage, model: Model<Api>): boolean {
  return (
    message.provider === model.provider && message.api === model.api && message.model === model.id
  );
}

/** Same-model carriers become provider-native items in onPayload; cross-model
 * context has no synthetic empty message or foreign provider item. */
export function nativeProviderContext(context: Context, model: Model<Api>): Context {
  return {
    ...context,
    messages: context.messages.flatMap((message) => {
      if (message.role !== "assistant" || sameModel(message, model)) return [message];
      const content = message.content.filter((block) => !isHostedToolBlock(block));
      return content.length ? [{ ...message, content }] : [];
    }),
  };
}

function signatureId(value: TextContent): string | undefined {
  if (!value.textSignature?.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(value.textSignature);
    return record(parsed) && typeof parsed.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

/** Pi's ordinary text conversion preserves each owned marker's exact position.
 * Replace it, never forward it as an assistant message to the provider. */
export function replayProviderHostedTranscripts(
  payload: unknown,
  context: Context,
  model: Model<Api>,
): unknown {
  if (!record(payload) || !Array.isArray(payload.input) || !payload.input.every(record))
    return payload;
  const items = payload.input as Record<string, unknown>[];
  for (const message of context.messages) {
    if (message.role !== "assistant" || !sameModel(message, model)) continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      const id = signatureId(block);
      if (!id) continue;
      const index = items.findIndex((item) => item.id === id);
      // Pi may omit an entire message from its normalized model context.
      if (index < 0) continue;
      if (isHostedToolBlock(block)) {
        items[index] = structuredClone(block.providerHostedTool.nativeItem);
      } else {
        const annotated = block as ProviderAnnotatedTextContent;
        const content = items[index]!.content;
        if (!annotated.providerAnnotations?.length || !Array.isArray(content)) continue;
        const text = content.find((item: unknown) => record(item) && item.type === "output_text");
        if (record(text)) text.annotations = structuredClone(annotated.providerAnnotations);
      }
    }
  }
  if (
    items.some(
      (item) =>
        item.type === "message" &&
        typeof item.id === "string" &&
        item.id.startsWith("msg_picloud_hosted_"),
    )
  )
    throw new Error("Completed hosted content has no provider replay item");
  return payload;
}
