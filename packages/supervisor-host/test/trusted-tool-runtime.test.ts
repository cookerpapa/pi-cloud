import { nativeToolApi } from "./tool-api.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Database } from "@pi-cloud/database";
import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";
import { PostgresTrustedToolRuntime } from "../src/tools/trusted-tool-runtime.ts";
import { SubagentControlClient, withToolInvocation } from "@pi-cloud/sandbox-supervisor";

function rootSessionDatabase(): Kysely<Database> {
  return {
    selectFrom() {
      throw new Error("Root tool setup must reuse claimed metadata without querying PG");
    },
  } as unknown as Kysely<Database>;
}

const command = {
  payload: {
    sessionKind: "conversation",
    tenantId: "tenant-1",
    sessionId: "session-1",
    runId: "run-1",
    executionReference: "unused-until-tool-execution",
    model: {
      provider: "deepseek",
      modelId: "deepseek-v4-flash",
      thinkingLevel: "off",
    },
  },
} as unknown as ExecuteTurnCommandMessage;

describe("PostgresTrustedToolRuntime", () => {
  it("deduplicates a workflow key within one invocation, not across reused provider IDs", async () => {
    const starts: string[] = [];
    const runtime = new PostgresTrustedToolRuntime({
      database: rootSessionDatabase(),
      nativeConversations: {
        childAnchor: async () => null,
        createChildConversation: async () => 2,
      },
      control: {
        async request(input: Parameters<SubagentControlClient["request"]>[0]) {
          input.onPublished?.();
          if (input.request.action === "start") {
            starts.push(input.toolCallId);
            return { executionId: input.toolCallId };
          }
          return { state: "completed", output: input.toolCallId };
        },
      } as unknown as SubagentControlClient,
    });
    const bindings = await runtime.create({ command, refreshServices: async () => {} });
    const tool = bindings.find(({ tool }) => tool.name === "subagent")!.tool;
    const invoke = (id: string, task: string) =>
      withToolInvocation({ id, nativeToolCallId: "provider-reused" }, () =>
        tool.execute({ action: "run", task }, nativeToolApi("provider-reused"), BACKGROUND_CONTEXT),
      );
    const first = await invoke("result-one", "first task");
    expect(await invoke("result-one", "first task")).toEqual(first);
    const second = await invoke("result-two", "second task");
    expect(second).not.toEqual(first);
    expect(starts).toEqual(["result-one", "result-two"]);
  });

  it("exposes root-session Tools with explicit non-Sandbox execution planes", async () => {
    const runtime = new PostgresTrustedToolRuntime({
      database: rootSessionDatabase(),
      control: new SubagentControlClient(() => undefined),
      nativeConversations: {
        childAnchor() {
          throw new Error("unused");
        },
        async createChildConversation() {
          throw new Error("unused");
        },
      },
    });
    const tools = await runtime.create({
      command,
      refreshServices: async () => undefined,
    });

    expect(
      tools
        .filter((binding) => binding.offered !== false)
        .map(({ executionPlane, tool }) => [tool.name, executionPlane]),
    ).toEqual([
      ["preview", "platform"],
      ["subagent", "orchestration"],
      ["subagent_supervisor", "orchestration"],
    ]);
    expect(tools.some(({ executionPlane }) => executionPlane === "integration")).toBe(false);
  });
});
