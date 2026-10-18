import { expect, it } from "vitest";
import { MAX_SUBAGENT_RESULT_BYTES } from "@pi-cloud/protocol";
import { supervisorToolResult } from "../src/control-tool-results.ts";

it.each(["contact", "supervisor"] as const)(
  "bounds %s text and remaining metadata independently",
  (kind) => {
    expect(() =>
      supervisorToolResult(kind, {
        output: "x".repeat(MAX_SUBAGENT_RESULT_BYTES + 1),
        replyMessage: "x".repeat(MAX_SUBAGENT_RESULT_BYTES + 1),
      }),
    ).toThrow("subagent_result_too_large");
    expect(() =>
      supervisorToolResult(kind, {
        output: "ok",
        replyMessage: "ok",
        evidence: "x".repeat(MAX_SUBAGENT_RESULT_BYTES),
      }),
    ).toThrow("subagent_result_too_large");
    const text = "x".repeat(MAX_SUBAGENT_RESULT_BYTES);
    expect(
      supervisorToolResult(kind, { output: text, replyMessage: text, executionId: "child" }),
    ).toEqual({ content: [{ type: "text", text }], details: { executionId: "child" } });
  },
);
it("preserves ordinary supervisor content and metadata", () => {
  const value = { output: "completed", executionId: "child", state: "completed" };
  expect(supervisorToolResult("supervisor", value)).toEqual({
    content: [{ type: "text", text: "completed" }],
    details: { executionId: "child", state: "completed" },
  });
});
it("rejects multiline text before native truncation can remove the final decision", () => {
  expect(() => supervisorToolResult("supervisor", { output: "line\n".repeat(2001) })).toThrow(
    "subagent_result_too_large",
  );
});
