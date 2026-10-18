/** The full record includes native history and its bounded display event. */
export const MAX_EXECUTION_FACT_BYTES = 900 * 1024;
// Pinned Pi Durable defaults, measured on the text returned to the Harness.
// Native upgrade tests cover bytes, LF counting and the trailing-newline boundary.
export const MAX_SUBAGENT_RESULT_BYTES = 50 * 1024;
export const MAX_SUBAGENT_RESULT_LINES = 2000;
export const SUBAGENT_RESULT_TOO_LARGE =
  "subagent_result_too_large: Returned text exceeds 50 KiB or 2000 lines. " +
  "Execution may already have produced side effects; inspect them before retrying. " +
  "Write large data explicitly to the Workspace and return a summary or file path.";

const utf8 = new TextEncoder();

export function assertSubagentResultBudget(value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) throw new Error("Subagent result must be JSON serializable");
  if (utf8.encode(text).byteLength > MAX_SUBAGENT_RESULT_BYTES)
    throw new Error(SUBAGENT_RESULT_TOO_LARGE);
  let lines = text === "" || text.endsWith("\n") ? 0 : 1;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
    if (++lines > MAX_SUBAGENT_RESULT_LINES) throw new Error(SUBAGENT_RESULT_TOO_LARGE);
}

/** Preserve the Tool's existing string/JSON representation without truncation. */
export function serializeSubagentResult(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (typeof text !== "string") throw new Error("Subagent result must be JSON serializable");
  assertSubagentResultBudget(text);
  return text;
}
