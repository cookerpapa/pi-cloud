import { describe, expect, it } from "vitest";
import {
  MAX_SUBAGENT_RESULT_BYTES,
  MAX_SUBAGENT_RESULT_LINES,
  serializeSubagentResult,
} from "../src/tool-result-budget.ts";

describe("Subagent return budget", () => {
  it.each(["plain", { selected: "only B", nested: [1, null] }, null, undefined])(
    "preserves the existing text representation of %j",
    (value) => {
      expect(serializeSubagentResult(value)).toBe(
        typeof value === "string" ? value : JSON.stringify(value ?? null),
      );
    },
  );
  it.each(["x", "中", "\u0000", '"', "\\", "😀"])(
    "counts native UTF-8 text bytes at the boundary: %j",
    (unit) => {
      const encodedUnitBytes = Buffer.byteLength(unit);
      const text = unit.repeat(Math.floor(MAX_SUBAGENT_RESULT_BYTES / encodedUnitBytes));
      expect(serializeSubagentResult(text)).toBe(text);
      expect(() => serializeSubagentResult(text + unit)).toThrow("subagent_result_too_large");
    },
  );
  it("counts the actual structured result text without counting transport escapes twice", () => {
    const value = { selected: '\\"'.repeat(9000) };
    const text = JSON.stringify(value);
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_SUBAGENT_RESULT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(text))).toBeGreaterThan(MAX_SUBAGENT_RESULT_BYTES);
    expect(serializeSubagentResult(value)).toBe(text);
  });
  it.each(["\n", "a\n", "中\r\n"])(
    "matches native line limits, including a trailing LF: %j",
    (unit) => {
      const text = unit.repeat(MAX_SUBAGENT_RESULT_LINES);
      expect(serializeSubagentResult(text)).toBe(text);
      expect(serializeSubagentResult(text.slice(0, -1))).toBe(text.slice(0, -1));
      expect(() => serializeSubagentResult(text + "last")).toThrow("subagent_result_too_large");
      expect(() => serializeSubagentResult(text + unit)).toThrow("subagent_result_too_large");
    },
  );
});
