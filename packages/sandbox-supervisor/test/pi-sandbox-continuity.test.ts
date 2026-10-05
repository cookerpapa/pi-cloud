import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { Model, Message } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import {
  PiSessionWorldStateController,
  PI_SANDBOX_RESET_CUSTOM_TYPE,
  PI_WORKSPACE_CHANGED_CUSTOM_TYPE,
} from "../src/pi-sandbox-continuity.ts";
const continuity = (
  id: string,
  kind: "warm_reuse" | "cold_restore" = "warm_reuse",
  workspace = "e".repeat(64),
) => ({
  continuityId: id,
  continuity: kind,
  environmentSha256: "a".repeat(64),
  toolPolicySha256: "b".repeat(64),
  workspaceBindingSha256: workspace,
});
async function fixture() {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  return {
    harness,
    root: await harness.root(BACKGROUND_CONTEXT),
    close: () => harness.close(BACKGROUND_CONTEXT),
  };
}
it("appends a reset after the original Tool result and produces exactly one Responses tool output", async () => {
  const f = await fixture();
  try {
    const first = await PiSessionWorldStateController.create(
      f.harness,
      f.root.id,
      continuity("first"),
    );
    await first.capture();
    const changed = await PiSessionWorldStateController.create(
      f.harness,
      f.root.id,
      continuity("second", "cold_restore"),
    );
    await changed.capture();
    const model = {
      id: "test",
      name: "test",
      api: "openai-responses",
      provider: "deepseek",
      baseUrl: "http://invalid",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    } as Model<"openai-responses">;
    await f.root.commit(async (tx) => {
      await tx.appendEntry(f.root.id, {
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            content: [
              {
                type: "toolCall",
                id: "call_test|fc_test",
                name: "read",
                arguments: { path: "a.py" },
              },
            ],
            stopReason: "toolUse",
            timestamp: 1,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        ],
      });
    }, BACKGROUND_CONTEXT);
    await changed.recordActive();
    expect(
      (await f.root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(
        (entry) => entry.kind === PI_SANDBOX_RESET_CUSTOM_TYPE,
      ),
    ).toHaveLength(0);
    await f.root.commit(async (tx) => {
      await tx.appendEntry(f.root.id, {
        kind: "pi.tool-result",
        model: [
          {
            role: "toolResult",
            toolCallId: "call_test|fc_test",
            toolName: "read",
            content: [{ type: "text", text: "file contents" }],
            isError: false,
            timestamp: 2,
          },
        ],
      });
    }, BACKGROUND_CONTEXT);
    await changed.capture();
    const messages = (await f.root.context(BACKGROUND_CONTEXT)).messages as Message[];
    const wire = convertResponsesMessages(
      model,
      { messages } as import("@earendil-works/pi-ai").TranscriptContext,
      new Set(["deepseek"]),
    );
    expect(wire.filter((item) => item.type === "function_call_output")).toEqual([
      { type: "function_call_output", call_id: "call_test", output: "file contents" },
    ]);
    expect(JSON.stringify(wire)).toContain("sandbox_reset");
    expect(JSON.stringify(wire)).not.toContain("No result");
  } finally {
    await f.close();
  }
});
it("persists one workspace-change entry across a replaced controller", async () => {
  const f = await fixture();
  try {
    await (
      await PiSessionWorldStateController.create(f.harness, f.root.id, continuity("first"))
    ).capture();
    await (
      await PiSessionWorldStateController.create(
        f.harness,
        f.root.id,
        continuity("second", "cold_restore", "f".repeat(64)),
      )
    ).capture();
    await (
      await PiSessionWorldStateController.create(
        f.harness,
        f.root.id,
        continuity("third", "cold_restore", "f".repeat(64)),
      )
    ).capture();
    const entries = (await f.root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items;
    expect(entries.filter((entry) => entry.kind === PI_WORKSPACE_CHANGED_CUSTOM_TYPE)).toHaveLength(
      1,
    );
  } finally {
    await f.close();
  }
});
it("does not confuse a new lease or transient disconnection with a replaced physical guest", async () => {
  const f = await fixture();
  try {
    const first = await PiSessionWorldStateController.create(
      f.harness,
      f.root.id,
      continuity("first"),
    );
    await first.capture();
    await first.recordUnavailable();
    await first.capture();
    const same = await PiSessionWorldStateController.create(
      f.harness,
      f.root.id,
      continuity("first"),
    );
    expect((await same.capture()).modelMessages).toHaveLength(0);
    const next = await PiSessionWorldStateController.create(
      f.harness,
      f.root.id,
      continuity("second", "cold_restore"),
    );
    expect((await next.capture()).modelMessages).toHaveLength(0);
    await next.recordActive();
    await next.capture();
    await (
      await PiSessionWorldStateController.create(f.harness, f.root.id, continuity("second"))
    ).capture();
    expect(
      (await f.root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.filter(
        (entry) => entry.kind === PI_SANDBOX_RESET_CUSTOM_TYPE,
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it("isolates world-state documents by native conversation", async () => {
  const f = await fixture();
  try {
    const child = await f.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      BACKGROUND_CONTEXT,
    );
    await (
      await PiSessionWorldStateController.create(f.harness, child.id, continuity("child"))
    ).capture();
    const parent = await PiSessionWorldStateController.create(
      f.harness,
      f.root.id,
      continuity("parent"),
    );
    expect((await parent.capture()).modelMessages).toHaveLength(0);
    expect((await f.root.entries({}, 10, undefined, BACKGROUND_CONTEXT)).items).toEqual([]);
  } finally {
    await f.close();
  }
});
