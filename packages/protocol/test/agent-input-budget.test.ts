import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_INPUT_CHARACTERS,
  MAX_SUBAGENT_TASK_JSON_BYTES,
  assertSubagentTaskInputBudget,
  parseAcceptTurnRequest,
} from "../src/index.ts";

describe("delegated task input budget", () => {
  it.each(["\u0000", "\uD800", "\uDC00"])(
    "rejects text unsupported by native PG storage: %j",
    (text) => {
      expect(() => assertSubagentTaskInputBudget(text)).toThrow("valid Unicode text without NUL");
    },
  );
  it.each(["x", "汉", "😀", "\u0001"])("admits the exact encoded boundary for %j", (unit) => {
    const bytes = Buffer.byteLength(JSON.stringify(unit)) - 2;
    const count = Math.min(
      Math.floor(MAX_AGENT_INPUT_CHARACTERS / unit.length),
      Math.floor((MAX_SUBAGENT_TASK_JSON_BYTES - 2) / bytes),
    );
    const text = unit.repeat(count);
    expect(() => assertSubagentTaskInputBudget(text)).not.toThrow();
    expect(parseAcceptTurnRequest({ prompt: text }).prompt).toBe(text);
    expect(() => assertSubagentTaskInputBudget(text + unit)).toThrow("subagent_input_too_large");
  });
  it.each(["", " \n\t"])("rejects an empty task: %j", (text) => {
    expect(() => assertSubagentTaskInputBudget(text)).toThrow("non-whitespace");
  });
});
