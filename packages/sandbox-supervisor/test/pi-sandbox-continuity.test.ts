import {
  buildSessionContext,
  InMemorySessionStorage,
  Session,
} from "@earendil-works/pi-agent-core";
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
  it("persists one Workspace-change fact across Worker replacement", async () => {
    const session = new Session(
      new InMemorySessionStorage({ id: "workspace-change-session", createdAt: Date.now() }),
    );
    const first = await PiSessionWorldStateController.create(
      session,
      continuity(FIRST_ACTIVATION, "cold_restore"),
    );
    await first.capture();

    const second = await PiSessionWorldStateController.create(
      session,
      continuity(SECOND_ACTIVATION, "cold_restore", SECOND_WORKSPACE_SHA256),
    );
    const changed = await second.capture();
    const replacementWorker = await PiSessionWorldStateController.create(
      session,
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
      continuity(FIRST_ACTIVATION, "warm_reuse"),
    );
    await first.capture();
    await first.recordActive();

    const nextRun = await PiSessionWorldStateController.create(
      session,
      continuity(FIRST_ACTIVATION, "warm_reuse"),
    );
    expect((await nextRun.capture()).modelMessages).toHaveLength(0);
    expect(
      (await session.findEntriesOnBranch()).filter(
        (entry) => entry.type === "custom" && entry.customType === PI_SANDBOX_RESET_CUSTOM_TYPE,
      ),
    ).toHaveLength(0);
  });
});
