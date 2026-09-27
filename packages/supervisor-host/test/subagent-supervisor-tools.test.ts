import { expect, it, vi } from "vitest";
import { MAX_SUBAGENT_RESULT_BYTES } from "@pi-cloud/protocol";
import {
  createCloudContactSupervisorTool,
  createCloudSubagentSupervisorTool,
} from "../src/tools/subagent-supervisor-tools.ts";

it.each(["contact", "supervisor"] as const)(
  "bounds the entire %s result, including repeated details",
  async (kind) => {
    const request = vi.fn(async () => ({
      output: "x".repeat(MAX_SUBAGENT_RESULT_BYTES / 2),
      replyMessage: "x".repeat(MAX_SUBAGENT_RESULT_BYTES / 2),
    }));
    const run = () =>
      kind === "contact"
        ? createCloudContactSupervisorTool(request).execute("call", {
            reason: "need_decision",
            message: "inspect",
          })
        : createCloudSubagentSupervisorTool(request).execute("call", {
            action: "wait",
            replyTo: "child",
          });
    await expect(run()).rejects.toThrow("subagent_result_too_large");
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it("keeps ordinary supervisor output and metadata intact", async () => {
  const result = { output: "completed", executionId: "child", state: "completed" };
  await expect(
    createCloudSubagentSupervisorTool(async () => result).execute("call", {
      action: "wait",
      replyTo: "child",
    }),
  ).resolves.toEqual({
    content: [{ type: "text", text: "completed" }],
    details: result,
  });
});
