/** Shared public/Worker prompt character limit. Delegated tasks also reserve
 * space for all three native startup copies inside one execution fact.
 */
export const MAX_AGENT_INPUT_CHARACTERS = 100_000;
export const MAX_SUBAGENT_TASK_JSON_BYTES = 256 * 1024;

const utf8 = new TextEncoder();
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
