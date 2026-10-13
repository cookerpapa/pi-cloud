import { expect, it } from "vitest";
import { MAX_SUBAGENT_RESULT_BYTES } from "@pi-cloud/protocol";
import { supervisorToolResult } from "../src/control-tool-results.ts";

it.each(["contact", "supervisor"] as const)(
  "bounds the entire %s result including details",
  (kind) => {
    expect(() =>
      supervisorToolResult(kind, {
        output: "x".repeat(MAX_SUBAGENT_RESULT_BYTES / 2),
        replyMessage: "x".repeat(MAX_SUBAGENT_RESULT_BYTES / 2),
      }),
    ).toThrow("subagent_result_too_large");
  },
);
it("preserves ordinary supervisor content and metadata", () => {
  const value = { output: "completed", executionId: "child", state: "completed" };
  expect(supervisorToolResult("supervisor", value)).toEqual({
    content: [{ type: "text", text: "completed" }],
    details: value,
  });
});
