import { describe, expect, it } from "vitest";
import { MAX_SUBAGENT_RESULT_BYTES, serializeSubagentResult } from "../src/tool-result-budget.ts";

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
    "counts UTF-8 and JSON escaping at the boundary: %j",
    (unit) => {
      const encodedUnitBytes = Buffer.byteLength(JSON.stringify(unit)) - 2;
      const text = unit.repeat(Math.floor((MAX_SUBAGENT_RESULT_BYTES - 2) / encodedUnitBytes));
      expect(serializeSubagentResult(text)).toBe(text);
      expect(() => serializeSubagentResult(text + unit)).toThrow("subagent_result_too_large");
    },
  );
  it("counts structured JSON again as the text inside the native Tool result", () => {
    const value = { selected: '\\"'.repeat(40_000) };
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(MAX_SUBAGENT_RESULT_BYTES);
    expect(() => serializeSubagentResult(value)).toThrow("subagent_result_too_large");
  });
});
