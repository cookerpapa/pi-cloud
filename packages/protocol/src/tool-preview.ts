import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const TOOL_PREVIEW_MAX_BYTES = 8192;
export const TOOL_PREVIEW_FRAME_BYTES = 64 * 1024;
export const TOOL_PREVIEW_RESET_MS = 5000;
const revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const count = Type.Integer({ minimum: 0, maximum: TOOL_PREVIEW_MAX_BYTES });
const text = Type.String({ maxLength: TOOL_PREVIEW_MAX_BYTES });

export const ToolPreviewUpdateSchema = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("reset"),
      revision,
      text,
      unavailable: Type.Optional(Type.Literal(true)),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      kind: Type.Literal("delta"),
      revision,
      baseRevision: revision,
      dropHead: count,
      keepPrefix: count,
      text,
    },
    { additionalProperties: false },
  ),
]);
export type ToolPreviewUpdate = Static<typeof ToolPreviewUpdateSchema>;
export type ToolPreviewState = Readonly<{ revision: number; text: string; unavailable?: true }>;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const previewBytes = (text: string): number => encoder.encode(text).byteLength;

/** One UTF-8-bounded visible tail, never a slice through a character. */
export function boundedPreviewText(text: string): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= TOOL_PREVIEW_MAX_BYTES) return text;
  let start = bytes.length - TOOL_PREVIEW_MAX_BYTES;
  while ((bytes[start]! & 0xc0) === 0x80) start++;
  return decoder.decode(bytes.subarray(start));
}

export function parseToolPreviewUpdate(value: unknown): ToolPreviewUpdate {
  if (!Value.Check(ToolPreviewUpdateSchema, value)) throw new Error("Invalid Tool preview update");
  const update = value as ToolPreviewUpdate;
  if (
    previewBytes(update.text) > TOOL_PREVIEW_MAX_BYTES ||
    (update.kind === "delta" && update.baseRevision >= update.revision)
  )
    throw new Error("Invalid Tool preview bounds");
  return update;
}

export const GuestToolPreviewSchema = Type.Object(
  {
    type: Type.Literal("worker.preview"),
    operationId: Type.String({ minLength: 1, maxLength: 1024 }),
    toolCallId: Type.String({ minLength: 1, maxLength: 4096 }),
    toolName: Type.String({ minLength: 1, maxLength: 128 }),
    update: ToolPreviewUpdateSchema,
  },
  { additionalProperties: false },
);
export type GuestToolPreview = Static<typeof GuestToolPreviewSchema>;
export function parseGuestToolPreview(value: unknown): GuestToolPreview {
  if (
    !Value.Check(GuestToolPreviewSchema, value) ||
    previewBytes(JSON.stringify(value)) > TOOL_PREVIEW_FRAME_BYTES
  )
    throw new Error("Invalid guest Tool preview");
  const result = value as GuestToolPreview;
  parseToolPreviewUpdate(result.update);
  return result;
}

/** Largest suffix of previous that is a prefix of next, using linear KMP. */
function overlap(previous: readonly string[], next: readonly string[]): number {
  if (!next.length) return 0;
  const prefix = new Array<number>(next.length).fill(0);
  for (let i = 1, j = 0; i < next.length; i++) {
    while (j > 0 && next[i] !== next[j]) j = prefix[j - 1]!;
    if (next[i] === next[j]) j++;
    prefix[i] = j;
  }
  let matched = 0;
  for (const point of previous) {
    while (matched > 0 && (matched === next.length || point !== next[matched]))
      matched = prefix[matched - 1]!;
    if (point === next[matched]) matched++;
  }
  return matched;
}

export function previewUpdate(
  previous: ToolPreviewState | undefined,
  next: ToolPreviewState,
  reset = false,
): ToolPreviewUpdate {
  const full: ToolPreviewUpdate = { kind: "reset", ...next };
  if (reset || !previous || previous.unavailable || next.unavailable) return full;
  const before = Array.from(previous.text),
    after = Array.from(next.text);
  let common = 0;
  while (common < before.length && common < after.length && before[common] === after[common])
    common++;
  const suffix = overlap(before, after);
  const useSuffix = suffix > common;
  const keepPrefix = useSuffix ? suffix : common;
  const delta: ToolPreviewUpdate = {
    kind: "delta",
    revision: next.revision,
    baseRevision: previous.revision,
    dropHead: useSuffix ? before.length - suffix : 0,
    keepPrefix,
    text: after.slice(keepPrefix).join(""),
  };
  return previewBytes(JSON.stringify(delta)) < previewBytes(JSON.stringify(full)) ? delta : full;
}

/** Disposable receiving view. Missing bases invalidate it until a newer reset. */
export class ToolPreviewBuffer {
  #revision = 0;
  #current: ToolPreviewState | undefined;
  get current(): ToolPreviewState | undefined {
    return this.#current;
  }
  accept(update: ToolPreviewUpdate): boolean {
    parseToolPreviewUpdate(update);
    if (update.revision <= this.#revision) return false;
    this.#revision = update.revision;
    if (update.kind === "reset") {
      this.#current = {
        revision: update.revision,
        text: update.text,
        ...(update.unavailable ? { unavailable: true as const } : {}),
      };
      return true;
    }
    const previous = this.#current;
    this.#current = undefined;
    if (!previous || previous.unavailable || previous.revision !== update.baseRevision) return true;
    const before = Array.from(previous.text);
    if (update.dropHead + update.keepPrefix > before.length) return true;
    const text =
      before.slice(update.dropHead, update.dropHead + update.keepPrefix).join("") + update.text;
    if (previewBytes(text) > TOOL_PREVIEW_MAX_BYTES) return true;
    this.#current = { revision: update.revision, text };
    return true;
  }
}

/** Coalesces changes against the last sent base, retaining no observation log. */
export class ToolPreviewChannel {
  readonly #buffer = new ToolPreviewBuffer();
  #sent: ToolPreviewState | undefined;
  #pending = false;
  #reset = false;
  get current(): ToolPreviewState | undefined {
    return this.#buffer.current;
  }
  accept(update: ToolPreviewUpdate): boolean {
    if (!this.#buffer.accept(update)) return false;
    if (!this.current) {
      this.#sent = undefined;
      this.#pending = false;
      return true;
    }
    this.#pending = true;
    this.#reset ||= update.kind === "reset";
    return true;
  }
  resync(): void {
    this.#sent = undefined;
    this.#reset = true;
  }
  take(): ToolPreviewUpdate | undefined {
    const current = this.current;
    if (!this.#pending || !current) return;
    const update = previewUpdate(this.#sent, current, this.#reset);
    this.#sent = current;
    this.#pending = false;
    this.#reset = false;
    return update;
  }
}
