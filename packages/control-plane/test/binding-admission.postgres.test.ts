import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { PostgresSandboxBindings } from "../../sandbox-control/src/sandbox-bindings.ts";
import { SessionControlOutbox } from "../../runtime-core/src/session-control-outbox.ts";
import type {
  SandboxBindingSnapshot,
  SandboxExecutionDescriptor,
} from "../../sandbox-control/src/sandbox-execution.ts";

it("rejects late registration after writer closure and waits for application, not publication, before physical retirement", async () => {
  const f = await nativeSubagentFixture();
  try {
    const owner = randomUUID(),
      physical = randomUUID(),
      binding = randomUUID();
    const domain = (
      await f.database
        .selectFrom("workspaces")
        .select("sandbox_domain_id")
        .where("id", "=", f.project.workspaceId)
        .executeTakeFirstOrThrow()
    ).sandbox_domain_id;
    await f.database
      .insertInto("sandbox_control_instances")
      .values({
        instance_id: owner,
        sandbox_domain_id: domain,
        owner_base_url: "http://fixture.invalid",
        state: "ready",
        lease_expires_at: new Date(Date.now() + 60000),
        last_heartbeat_at: new Date(),
      })
      .execute();
    const assignment = {
      tenantId: f.scope.tenantId,
      projectId: f.project.projectId,
      workspaceId: f.project.workspaceId,
      sessionId: f.scope.sessionId,
      turnId: f.scope.turnId,
      runId: f.scope.runId,
      supervisorId: "fixture",
      bootId: randomUUID(),
      sandboxId: randomUUID(),
      executionReference: f.reference,
    };
    await f.database
      .insertInto("workspace_runtimes")
      .values({
        workspace_runtime_id: physical,
        tenant_id: f.scope.tenantId,
        project_id: f.project.projectId,
        workspace_id: f.project.workspaceId,
        sandbox_domain_id: domain,
        owner_instance_id: owner,
        owner_base_url: "http://fixture.invalid",
        supervisor_id: assignment.supervisorId,
        boot_id: assignment.bootId,
        sandbox_id: assignment.sandboxId,
        run_id: f.scope.runId,
        session_id: f.scope.sessionId,
        turn_id: f.scope.turnId,
        lease_id: f.scope.writerId,
        fencing_token: "1",
        turn_context_sha256: "a".repeat(64),
        execution_context_sha256: "b".repeat(64),
        environment_sha256: "c".repeat(64),
        runtime_id: null,
        runtime_name: null,
        state: "allocated",
        failure_code: null,
      })
      .execute();
    const outbox = new SessionControlOutbox(f.database, {
      publishControl: async (change) => ({ factId: change.factId, durable: true }),
    });
    const bindings = new PostgresSandboxBindings(
      f.database,
      domain,
      owner,
      "http://fixture.invalid",
      (ids) => outbox.flushEntities("sandbox_binding", ids),
      (ids) => outbox.confirmBindingClosures(ids, 10),
    );
    const descriptor: SandboxExecutionDescriptor = {
      version: 2,
      target: {
        apiUrl: "http://cube.test",
        sandboxId: "a".repeat(32),
        nodeId: "node",
        bootId: randomUUID(),
      },
      attachment: { activationId: binding, toolRoot: "/workspace" },
    };
    const snapshot: SandboxBindingSnapshot = {
      assignment,
      physicalActivationId: physical,
      turnContextSha256: "a".repeat(64),
      executionContextSha256: "b".repeat(64),
      allowedTools: ["bash"],
      sandboxProfileKey: "standard",
    };
    await bindings.register(binding, descriptor, snapshot);
    expect(await f.store.getConversationEnvironment(f.scope.sessionId)).toMatchObject({
      workspaceId: f.project.workspaceId,
      binding: { bindingId: binding, allocationId: physical, admission: "open" },
    });
    await bindings.closeWriter(f.scope);
    expect((await f.store.getConversationEnvironment(f.scope.sessionId)).binding?.admission).toBe(
      "closing",
    );
    await expect(bindings.register(randomUUID(), descriptor, snapshot)).rejects.toThrow(
      "Writer retired",
    );
    const lease = await f.database
      .selectFrom("session_leases")
      .select("tool_bindings_closed_at")
      .where("lease_id", "=", f.scope.writerId)
      .executeTakeFirstOrThrow();
    expect(lease.tool_bindings_closed_at).not.toBeNull();
    await expect(bindings.confirmPhysicalClosure(physical)).rejects.toThrow("pending");
    await f.database
      .updateTable("outbox")
      .set({ applied_at: new Date() })
      .where("aggregate_id", "=", binding)
      .execute();
    await bindings.confirmPhysicalClosure(physical);
  } finally {
    await f.close();
  }
});
