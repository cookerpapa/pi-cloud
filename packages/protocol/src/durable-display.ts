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
  texts: readonly DurableTextDescription[];
  coveredThrough?: number;
}>;

const integer = (n: unknown, minimum = 0): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= minimum;

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
