import { parsePiCloudEvent, type PiCloudEvent } from "./event-envelope.ts";
import type { DurableSessionCommit } from "./durable-session.ts";

type TextEvent = Extract<PiCloudEvent, { type: "assistant.text.delta" }>;
export type DurableTextDescription = Readonly<{
  event: Omit<TextEvent, "payload"> & { payload: Omit<TextEvent["payload"], "text"> };
  source:
    | Readonly<{ kind: "empty" }>
    | Readonly<{
        kind: "write";
        ordinal: number;
        path: readonly (string | number)[];
        start: number;
        end: number;
      }>
    | Readonly<{
        kind: "document";
        id: number;
        path: readonly (string | number)[];
        start: number;
        end: number;
      }>;
}>;

/** Runner-created metadata; all content is read from the same native projection. */
export type DurableDisplayPreparation = Readonly<{
  executionReference: string;
  conversationId: number;
  events: readonly DurableDisplayDescription[];
  coveredThrough?: number;
}>;

type ToolStartedEvent = Extract<PiCloudEvent, { type: "tool.started" }>;
type ToolCompletedEvent = Extract<PiCloudEvent, { type: "tool.completed" }>;
export type DurableToolStartDescription = Readonly<{
  event: Omit<ToolStartedEvent, "payload"> & {
    payload: Omit<ToolStartedEvent["payload"], "input">;
  };
  source: Readonly<{ kind: "write"; ordinal: number; path: readonly (string | number)[] }>;
}>;
export type DurableToolEndDescription = Readonly<{
  event: Omit<ToolCompletedEvent, "payload"> & {
    payload: Omit<ToolCompletedEvent["payload"], "output">;
  };
  output:
    | Readonly<{ kind: "missing" }>
    | Readonly<{
        kind: "parts";
        parts: readonly (
          | Extract<DurableTextDescription["source"], { kind: "write" }>
          | { kind: "image"; mimeType: string }
        )[];
        maximumBytes: number;
        details?: Readonly<{ kind: "write"; ordinal: number; path: readonly (string | number)[] }>;
      }>;
}>;
export type DurableDisplayDescription =
  DurableTextDescription | DurableToolStartDescription | DurableToolEndDescription;

const integer = (n: unknown, minimum = 0): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= minimum;

function writeSource(value: unknown, ranged: boolean): void {
  const s = value as Record<string, unknown> | undefined;
  if (
    !s ||
    s.kind !== "write" ||
    !integer(s.ordinal) ||
    !Array.isArray(s.path) ||
    s.path.length > 64 ||
    s.path.some((p) => typeof p !== "string" && !integer(p)) ||
    (ranged && (!integer(s.start) || !integer(s.end) || s.end < s.start))
  )
    throw new Error("Invalid native display write reference");
}

export function parseDurableDisplayDescription(value: unknown): DurableDisplayDescription {
  const description = value as DurableDisplayDescription;
  if (description?.event?.type === "assistant.text.delta")
    return parseDurableTextDescription(value);
  if (description?.event?.type === "tool.started" && "source" in description) {
    if ("input" in description.event.payload) throw new Error("Tool display must not copy input");
    parsePiCloudEvent({
      ...description.event,
      payload: { ...description.event.payload, input: {} },
    });
    writeSource(description.source, false);
    return description;
  }
  if (description?.event?.type === "tool.completed" && "output" in description) {
    if ("output" in description.event.payload) throw new Error("Tool display must not copy output");
    parsePiCloudEvent({
      ...description.event,
      payload: { ...description.event.payload, output: "" },
    });
    const output = description.output;
    if (output?.kind === "missing") return description;
    if (
      output?.kind !== "parts" ||
      !integer(output.maximumBytes, 1) ||
      !Array.isArray(output.parts)
    )
      throw new Error("Invalid Tool output description");
    for (const part of output.parts) {
      if (part.kind === "image") {
        if (typeof part.mimeType !== "string" || !part.mimeType || part.mimeType.length > 256)
          throw new Error("Invalid Tool image description");
      } else writeSource(part, true);
    }
    if (output.details !== undefined) writeSource(output.details, false);
    return description;
  }
  throw new Error("Invalid native display description");
}

function selectedValue(
  commit: DurableSessionCommit,
  source: { ordinal: number; path: readonly (string | number)[] },
): unknown {
  let value: unknown = commit.writes[source.ordinal];
  for (const key of source.path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      throw new Error("Native display source path is missing");
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

export function resolveDurableDisplay(
  commit: DurableSessionCommit,
  description: DurableDisplayDescription,
  currentDocument: (id: number) => unknown,
): PiCloudEvent {
  if (description.event.type === "assistant.text.delta")
    return resolveDurableText(commit, description as DurableTextDescription, currentDocument);
  parseDurableDisplayDescription(description);
  const tool = description as DurableToolStartDescription | DurableToolEndDescription;
  if ("source" in tool) {
    const input = selectedValue(commit, tool.source);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Tool display input is not its native argument object");
    return parsePiCloudEvent({ ...tool.event, payload: { ...tool.event.payload, input } });
  }
  let output = "Tool task ended without a result";
  if (tool.output.kind === "parts") {
    output = tool.output.parts
      .map((part) => {
        if (part.kind === "image") return `[Image: ${part.mimeType}]`;
        const value = selectedValue(commit, part);
        if (typeof value !== "string" || part.end > value.length)
          throw new Error("Tool display output range is invalid");
        return value.slice(part.start, part.end);
      })
      .join("\n");
    const bytes = new TextEncoder().encode(output);
    if (bytes.byteLength > tool.output.maximumBytes)
      output =
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(
          bytes.subarray(0, tool.output.maximumBytes),
        ) + "\n[Display truncated]";
  }
  let details: unknown;
  if (tool.output.kind === "parts" && tool.output.details !== undefined) {
    const selected = selectedValue(commit, tool.output.details);
    const encoded = JSON.stringify(selected);
    if (encoded === undefined) throw new Error("Tool display metadata is not JSON data");
    if (new TextEncoder().encode(encoded).byteLength <= tool.output.maximumBytes)
      details = selected;
    else output += "\n[Tool display metadata omitted: size limit exceeded]";
  }
  return parsePiCloudEvent({
    ...tool.event,
    payload: {
      ...tool.event.payload,
      output: {
        content: [{ type: "text", text: output }],
        ...(details === undefined ? {} : { details }),
      },
    },
  });
}

export function parseDurableTextDescription(value: unknown): DurableTextDescription {
  const v = value as DurableTextDescription;
  if (!v?.event?.payload || v.event.type !== "assistant.text.delta" || "text" in v.event.payload)
    throw new Error("Native display must reference text, not carry a copied body");
  parsePiCloudEvent({ ...v.event, payload: { ...v.event.payload, text: "" } });
  const s = v.source;
  if (s?.kind === "empty") return v;
  if (
    !s ||
    !["write", "document"].includes(s.kind) ||
    !integer(s.start) ||
    !integer(s.end) ||
    s.end < s.start ||
    !Array.isArray(s.path) ||
    s.path.length > 64 ||
    s.path.some((part) => typeof part !== "string" && !integer(part)) ||
    (s.kind === "write" ? !integer(s.ordinal) : !integer(s.id, 1))
  )
    throw new Error("Invalid native display reference");
  return v;
}

export function resolveDurableText(
  commit: DurableSessionCommit,
  description: DurableTextDescription,
  currentDocument: (id: number) => unknown,
): TextEvent {
  const { event, source } = parseDurableTextDescription(description);
  let text = "";
  if (source.kind !== "empty") {
    let value: unknown;
    if (source.kind === "write") value = commit.writes[source.ordinal];
    else {
      if (
        !commit.writes.some(
          (write) =>
            (write.type === "document.change" && write.id === source.id) ||
            (write.type === "document.create" &&
              (write.record as { id?: unknown } | undefined)?.id === source.id),
        )
      )
        throw new Error("Display document is not part of its native commit");
      value = currentDocument(source.id);
    }
    for (const part of source.path) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, part))
        throw new Error("Native display source path is missing");
      value = (value as Record<string | number, unknown>)[part];
    }
    if (typeof value !== "string" || source.end > value.length)
      throw new Error("Native display source/range is invalid");
    text = value.slice(source.start, source.end);
  }
  return parsePiCloudEvent({ ...event, payload: { ...event.payload, text } }) as TextEvent;
}
