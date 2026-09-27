/** The full record includes native history and its bounded display event. */
export const MAX_EXECUTION_FACT_BYTES = 900 * 1024;
// Budget JSON-encoded text, not JS characters or the larger transport envelope.
export const MAX_SUBAGENT_RESULT_BYTES = 256 * 1024;
export const SUBAGENT_RESULT_TOO_LARGE =
  "subagent_result_too_large: Returned text exceeds the 256 KiB JSON-encoded result limit. " +
  "Execution may already have produced side effects; inspect them before retrying. " +
  "Write large data explicitly to the Workspace and return a summary or file path.";

const utf8 = new TextEncoder();

/** Preserve the Tool's existing string/JSON representation without truncation. */
export function serializeSubagentResult(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (typeof text !== "string") throw new Error("Subagent result must be JSON serializable");
  if (utf8.encode(JSON.stringify(text)).byteLength > MAX_SUBAGENT_RESULT_BYTES)
    throw new Error(SUBAGENT_RESULT_TOO_LARGE);
  return text;
}
