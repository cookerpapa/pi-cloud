import { MAX_EXECUTION_FACT_BYTES } from "./tool-result-budget.ts";
import { inputWithUploads, type UserUpload } from "./user-upload.ts";

/** Shared public/Worker prompt character limit. Delegated tasks also reserve
 * space for all three native startup copies inside one execution fact.
 */
export const MAX_AGENT_INPUT_CHARACTERS = 100_000;
export const MAX_SUBAGENT_TASK_JSON_BYTES = 256 * 1024;

const utf8 = new TextEncoder();
// Scope, parent/Entry IDs, native stamps and the atomic startup envelope. Images
// are packed references, never base64. This preserves 100,000 CJK characters.
const INPUT_ENVELOPE_BYTES = 8 * 1024;
export const MAX_INPUT_IMAGE_HINT_BYTES = 1024;
const PACKED_IMAGE_BYTES = utf8.encode(
  JSON.stringify({
    type: "pi_cloud_image_v1",
    attachment: {
      id: "f".repeat(36),
      sha256: "f".repeat(64),
      byteLength: Number.MAX_SAFE_INTEGER,
      mimeType: "image/webp",
    },
  }),
).byteLength;

export function assertUserInputText(text: string): void {
  if (typeof text !== "string" || /[\u0000\uD800-\uDFFF]/u.test(text))
    throw new Error("Input must be valid Unicode text without NUL characters");
  if (text.length > MAX_AGENT_INPUT_CHARACTERS)
    throw new Error("Input exceeds the 100,000-character limit");
}

/** Check the actual composed text; preparation hints get their own byte budget. */
export function assertPreparedUserInputBudget(
  text: string,
  images = 0,
  reservedHintBytes = 0,
): void {
  const contentBytes = utf8.encode(JSON.stringify(text)).byteLength;
  if (
    3 * (contentBytes + reservedHintBytes + images * (PACKED_IMAGE_BYTES + 1)) +
      INPUT_ENVELOPE_BYTES >
    MAX_EXECUTION_FACT_BYTES
  )
    throw new Error(
      "Input and attachment metadata exceed the native log byte budget; use a Workspace file for large text",
    );
}

export function assertUserInputBudget(text: string, uploads: readonly UserUpload[] = []): void {
  assertUserInputText(text);
  const images = uploads.filter((file) => file.image).length;
  const described = inputWithUploads(text, uploads);
  // Reserve the final joined image hints in JSON bytes, not raw JS characters.
  assertPreparedUserInputBudget(described, images, images * MAX_INPUT_IMAGE_HINT_BYTES);
}

export function assertSubagentTaskInputBudget(text: string): void {
  if (typeof text !== "string" || text.trim().length === 0)
    throw new Error("Subagent task must contain a non-whitespace character");
  if (/[\u0000\uD800-\uDFFF]/u.test(text))
    throw new Error("Subagent task must be valid Unicode text without NUL characters");
  if (
    text.length > MAX_AGENT_INPUT_CHARACTERS ||
    utf8.encode(JSON.stringify(text)).byteLength > MAX_SUBAGENT_TASK_JSON_BYTES
  )
    throw new Error(
      "subagent_input_too_large: Task text exceeds 100,000 characters or 256 KiB after JSON encoding. " +
        "Use inherited context or a Workspace file path instead of embedding large input.",
    );
}
