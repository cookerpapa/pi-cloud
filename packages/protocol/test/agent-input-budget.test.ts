import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_INPUT_CHARACTERS,
  MAX_SUBAGENT_TASK_JSON_BYTES,
  assertSubagentTaskInputBudget,
  parseAcceptTurnRequest,
  parseCreateTurnSteerRequest,
  assertUserInputBudget,
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

describe("human input native publication budget", () => {
  it("preserves the full ordinary CJK character limit and rejects escaped text before acceptance", () => {
    expect(parseAcceptTurnRequest({ prompt: "汉".repeat(100000) }).prompt).toHaveLength(100000);
    const prompt = "fixture:" + "\u0001".repeat(99992);
    expect(() => parseAcceptTurnRequest({ prompt })).toThrow("native log byte budget");
    expect(() => parseCreateTurnSteerRequest({ text: prompt })).toThrow("native log byte budget");
  });
  it.each(["\u0000", "\uD800", "\uDC00"])("rejects unsupported PG input %j", (prompt) => {
    expect(() => parseAcceptTurnRequest({ prompt })).toThrow("valid Unicode");
  });
  it("budgets attachment metadata and references rather than original image bytes", () => {
    const file = {
      id: "10000000-0000-4000-8000-000000000001",
      sessionId: "10000000-0000-4000-8000-000000000002",
      workspaceId: "10000000-0000-4000-8000-000000000003",
      name: "picture.png",
      path: "/workspace/uploads/picture.png",
      mimeType: "image/png",
      byteLength: 1000000000,
      sha256: "a".repeat(64),
      image: {
        id: "10000000-0000-4000-8000-000000000004",
        mimeType: "image/png" as const,
        byteLength: 1000000000,
        sha256: "a".repeat(64),
      },
    };
    expect(() =>
      assertUserInputBudget(
        "",
        Array.from({ length: 20 }, () => file),
      ),
    ).not.toThrow();
    expect(() =>
      assertUserInputBudget(
        "",
        Array.from({ length: 200 }, () => ({ ...file, path: "/" + "汉".repeat(1000) })),
      ),
    ).toThrow("native log byte budget");
  });
});
