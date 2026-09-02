import type { Database } from "@pi-cloud/database";
import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { PostgresTrustedToolRuntime } from "../src/index.ts";

function rootSessionDatabase(): Kysely<Database> {
  const query = {
    select() {
      return this;
    },
    where() {
      return this;
    },
    async executeTakeFirstOrThrow() {
      return { session_kind: "user" };
    },
  };
  return {
    selectFrom() {
      return query;
    },
  } as unknown as Kysely<Database>;
}

const command = {
  payload: {
    tenantId: "tenant-1",
    sessionId: "session-1",
    runId: "run-1",
    executionLease: "unused-until-tool-execution",
    model: {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "off",
    },
  },
} as unknown as ExecuteTurnCommandMessage;

describe("PostgresTrustedToolRuntime", () => {
  it("exposes root-session Tools with explicit non-Sandbox execution planes", async () => {
    const runtime = new PostgresTrustedToolRuntime({ database: rootSessionDatabase() });
    const tools = await runtime.create({
      command,
      ensureActivation: async () => {
        throw new Error("Tool-free trusted Tools must not activate a Sandbox");
      },
    });

    expect(tools.map(({ executionPlane, tool }) => [tool.name, executionPlane])).toEqual([
      ["preview", "platform"],
      ["subagent", "orchestration"],
      ["subagent_supervisor", "orchestration"],
    ]);
    expect(tools.some(({ executionPlane }) => executionPlane === "integration")).toBe(false);
  });
});
