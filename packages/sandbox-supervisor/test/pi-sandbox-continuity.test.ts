import {
  buildSessionContext,
  InMemorySessionStorage,
  Session,
  convertToLlm,
} from "@earendil-works/pi-agent-core";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  PI_SANDBOX_RESET_CUSTOM_TYPE,
  PI_WORKSPACE_CHANGED_CUSTOM_TYPE,
  PI_WORLD_STATE_ENTRY_PROJECTORS,
  PiSessionWorldStateController,
} from "../src/index.ts";

const FIRST_ACTIVATION = "10000000-0000-4000-8000-000000000001";
const SECOND_ACTIVATION = "20000000-0000-4000-8000-000000000002";
const ENVIRONMENT_SHA256 = "a".repeat(64);
const TOOL_POLICY_SHA256 = "b".repeat(64);
const FIRST_WORKSPACE_SHA256 = "e".repeat(64);
const SECOND_WORKSPACE_SHA256 = "f".repeat(64);

function continuity(
  continuityId: string,
  kind: "cold_restore" | "warm_reuse",
  workspaceBindingSha256 = FIRST_WORKSPACE_SHA256,
) {
  return {
    continuityId,
    continuity: kind,
    environmentSha256: ENVIRONMENT_SHA256,
    workspaceBindingSha256,
    committedWorkspaceRevision: null,
    toolPolicySha256: TOOL_POLICY_SHA256,
  } as const;
}

describe("PostgreSQL Pi runtime world-state harness", () => {
  it("publishes a reset after the Tool result, yielding only one native Responses output", async () => {
    const session = new Session(
      new InMemorySessionStorage({ id: "tool-pair-boundary", createdAt: Date.now() }),
    );
    const first = await PiSessionWorldStateController.create(
      session,
      "main",
      continuity(FIRST_ACTIVATION, "warm_reuse"),
    );
    await first.capture();
    const changed = await PiSessionWorldStateController.create(
      session,
      "main",
      continuity("attempt-placeholder", "cold_restore"),
    );
    await changed.capture();
    const model: Model<"openai-responses"> = {
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
    };
    await session.appendMessage({
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        { type: "toolCall", id: "call_test|fc_test", name: "read", arguments: { path: "a.py" } },
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
    });
    await changed.recordActive({ continuityId: SECOND_ACTIVATION, continuity: "cold_restore" });
    expect(
      (await session.findEntriesOnBranch()).filter(
        (e) => e.type === "custom" && e.customType === PI_SANDBOX_RESET_CUSTOM_TYPE,
      ),
    ).toHaveLength(0);
    await session.appendMessage({
      role: "toolResult",
      toolCallId: "call_test|fc_test",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 2,
    });
    await changed.capture();
    const messages = convertToLlm(
      buildSessionContext(await session.findEntriesOnBranch({ order: "oldestFirst" }), {
        entryProjectors: PI_WORLD_STATE_ENTRY_PROJECTORS,
      }).messages,
    );
    const wire = convertResponsesMessages(model, { messages }, new Set(["deepseek"]));
    expect(wire.filter((item) => item.type === "function_call_output")).toEqual([
      { type: "function_call_output", call_id: "call_test", output: "file contents" },
    ]);
    expect(JSON.stringify(wire)).not.toContain("No result");
    expect(JSON.stringify(wire)).toContain("sandbox_reset");
  });
  it("persists one Workspace-change fact across Worker replacement", async () => {
    const session = new Session(
      new InMemorySessionStorage({ id: "workspace-change-session", createdAt: Date.now() }),
    );
    const first = await PiSessionWorldStateController.create(
      session,
      "main",
      continuity(FIRST_ACTIVATION, "cold_restore"),
    );
    await first.capture();

    const second = await PiSessionWorldStateController.create(
      session,
      "main",
      continuity(SECOND_ACTIVATION, "cold_restore", SECOND_WORKSPACE_SHA256),
    );
    const changed = await second.capture();
    const replacementWorker = await PiSessionWorldStateController.create(
      session,
      "main",
      continuity(SECOND_ACTIVATION, "cold_restore", SECOND_WORKSPACE_SHA256),
    );
    expect((await replacementWorker.capture()).modelMessages).toHaveLength(0);

    const entries = await session.findEntriesOnBranch();
    expect(
      entries.filter(
        (entry) => entry.type === "custom" && entry.customType === PI_WORKSPACE_CHANGED_CUSTOM_TYPE,
      ),
    ).toHaveLength(1);
    expect(changed.modelMessages).toHaveLength(1);
    const context = JSON.stringify(
      buildSessionContext(entries, { entryProjectors: PI_WORLD_STATE_ENTRY_PROJECTORS }).messages,
    );
    expect(context).toContain("<workspace_changed>");
    expect(context).not.toContain(SECOND_WORKSPACE_SHA256);
  });

  it("does not report a reset when a new Lease reuses the same physical runtime", async () => {
    const session = new Session(
      new InMemorySessionStorage({ id: "persistent-runtime-session", createdAt: Date.now() }),
    );
    const first = await PiSessionWorldStateController.create(
      session,
      "main",
      continuity(FIRST_ACTIVATION, "warm_reuse"),
    );
    await first.capture();
    await first.recordActive();

    const nextRun = await PiSessionWorldStateController.create(
      session,
      "main",
      continuity(FIRST_ACTIVATION, "warm_reuse"),
    );
    expect((await nextRun.capture()).modelMessages).toHaveLength(0);
    expect(
      (await session.findEntriesOnBranch()).filter(
        (entry) => entry.type === "custom" && entry.customType === PI_SANDBOX_RESET_CUSTOM_TYPE,
      ),
    ).toHaveLength(0);
  });

  it("records execution World State only on the selected Agent lane", async () => {
    const session = new Session(
      new InMemorySessionStorage({ id: "lane-world-state-session", createdAt: Date.now() }),
    );
    await session.createLane("child", null);
    const child = await PiSessionWorldStateController.create(
      session,
      "child",
      continuity(FIRST_ACTIVATION, "cold_restore"),
    );
    await child.capture();

    expect(await session.view("main").findEntriesOnBranch()).toEqual([]);
    expect(
      (await session.view("child").findEntriesOnBranch()).filter(
        (entry) => entry.type === "custom" && entry.customType === "pi-cloud.runtime_world_state",
      ),
    ).toHaveLength(1);
  });

  it("does not mistake temporary disconnection for a reset, but records a new Guest exactly once", async () => {
    const session = new Session(
      new InMemorySessionStorage({ id: "guest-reconnection", createdAt: Date.now() }),
    );
    const first = await PiSessionWorldStateController.create(
      session,
      "main",
      continuity(FIRST_ACTIVATION, "warm_reuse"),
    );
    await first.capture();
    await first.recordUnavailable();
    expect((await first.capture()).modelMessages).toHaveLength(0);
    const reconnected = await PiSessionWorldStateController.create(
      session,
      "main",
      continuity(FIRST_ACTIVATION, "warm_reuse"),
    );
    expect((await reconnected.capture()).modelMessages).toHaveLength(0);
    await reconnected.recordUnavailable();
    const replacement = await PiSessionWorldStateController.create(
      session,
      "main",
      continuity(SECOND_ACTIVATION, "cold_restore"),
    );
    expect((await replacement.capture()).modelMessages).toHaveLength(0);
    await replacement.recordActive();
    await replacement.capture();
    const nextRun = await PiSessionWorldStateController.create(
      session,
      "main",
      continuity(SECOND_ACTIVATION, "warm_reuse"),
    );
    expect((await nextRun.capture()).modelMessages).toHaveLength(0);
    expect(
      (await session.findEntriesOnBranch()).filter(
        (entry) => entry.type === "custom" && entry.customType === PI_SANDBOX_RESET_CUSTOM_TYPE,
      ),
    ).toHaveLength(1);
  });
});
