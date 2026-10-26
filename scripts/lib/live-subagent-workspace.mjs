import assert from "node:assert/strict";
import { nativeHistory, nativeMessages } from "./native-session-history.mjs";
import { newIdempotencyKey } from "../../packages/web-ui/src/api.ts";

/** Called only inside an owned mixed phone/Linux acceptance Session. */
export async function checkSubagentWorkspace({
  db,
  api,
  tenantId,
  session,
  project,
  until,
  onRun,
}) {
  const reports = [];
  for (const kind of ["none", "ephemeral"]) {
    const task =
      kind === "none"
        ? 'Call subagent exactly once with context:"fresh",workspace:null,task:"Without using tools, reply WORKSPACE_NONE_OK and explain briefly whether you can operate the parent phone or Linux files." Do not call workflow, phone, file or shell tools yourself. When it finishes, reply WORKSPACE_NONE_OK.'
        : 'Call subagent exactly once with context:"fresh",workspace:{compute:"ephemeral",tools:["bash"]},task:"Use bash to write WORKSPACE_SHARED_VOLUME_OK into /workspace/subagent-workspace-marker.txt, then reply EPHEMERAL_LINUX_OK. This is separate Linux compute on a shared Volume, not a phone." After it finishes, use read to read /workspace/subagent-workspace-marker.txt in your own workspace, then reply WORKSPACE_SHARED_VOLUME_OK. Do not call workflow or any phone operation.';
    const run = await api.acceptTurn(
      session.sessionId,
      task,
      newIdempotencyKey("workspace-contract"),
    );
    assert.equal(run.kind, "run");
    onRun(run);
    const done = await until(
      async () => {
        const r = await api.getRun(run.runId);
        return ["completed", "failed", "cancelled", "timed_out"].includes(r.state) ? r : false;
      },
      "Workspace-scoped Subagent",
      600000,
    );
    assert.equal(done.state, "completed", JSON.stringify(done.failure));
    const children = await db
      .selectFrom("subagent_executions as c")
      .innerJoin("sessions as s", "s.id", "c.child_session_id")
      .select([
        "c.id",
        "c.state",
        "c.sandbox_mode",
        "c.child_turn_id",
        "c.child_session_id",
        "s.workspace_id",
        "s.compute_session_id",
        "s.tool_capabilities",
      ])
      .where("c.root_run_id", "=", run.runId)
      .where("c.tenant_id", "=", tenantId)
      .execute();
    assert.equal(children.length, 1);
    const child = children[0];
    assert.equal(child.state, "completed");
    assert.equal(child.sandbox_mode, kind);
    assert.equal(child.workspace_id, project.workspaceId);
    const childMessages = nativeMessages(
      await nativeHistory(db, { tenantId, turnId: child.child_turn_id }),
    );
    const childTools = childMessages.filter((m) => m.role === "toolResult");
    assert(
      !childTools.some((m) =>
        /^(android_|schedule$|preview$|generate_image$|show_image$)/.test(m.toolName),
      ),
    );
    const rootMessages = nativeMessages(await nativeHistory(db, { tenantId, turnId: run.turnId }));
    if (kind === "none") {
      assert.deepEqual(child.tool_capabilities, []);
      assert.equal(child.compute_session_id, null);
      assert.equal(childTools.length, 0);
      assert.equal(
        (
          await db
            .selectFrom("workspace_runtimes")
            .select("workspace_runtime_id")
            .where("workspace_id", "=", project.workspaceId)
            .execute()
        ).length,
        0,
      );
    } else {
      assert.deepEqual(child.tool_capabilities, ["bash"]);
      assert.equal(child.compute_session_id, child.child_session_id);
      assert(childTools.some((m) => m.toolName === "bash" && !m.isError));
      assert(
        rootMessages.some(
          (m) =>
            m.role === "toolResult" &&
            m.toolName === "read" &&
            !m.isError &&
            JSON.stringify(m.content).includes("WORKSPACE_SHARED_VOLUME_OK"),
        ),
      );
    }
    reports.push({
      kind,
      runId: run.runId,
      childId: child.id,
      state: child.state,
      phoneToolsInChild: false,
      sameVolume: true,
      noWorkspaceAllocation: kind === "none",
    });
  }
  return reports;
}
