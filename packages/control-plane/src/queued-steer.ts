import type { Database } from "@pi-cloud/database";
import { sql, type Transaction } from "kysely";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

/** Caller holds the Session row; NOWAIT avoids inversion with Run settlement. */
export async function lockSteerTarget(
  tx: Transaction<Database>,
  tenantId: string,
  sessionId: string,
  turnId: string,
) {
  const target = await tx
    .selectFrom("runs as r")
    .innerJoin("active_execution_scopes as a", "a.run_id", "r.id")
    .innerJoin("turns as target_turn", "target_turn.id", "r.turn_id")
    .select([
      "r.id",
      "r.turn_id",
      "r.project_id",
      "r.workspace_id",
      "r.sandbox_id",
      "r.environment_version_id",
      "r.working_directory",
      "r.compute_session_id",
      "r.sandbox_profile_key",
      "r.agent_revision_id",
      "r.agent_system_prompt",
      "r.tool_capability_snapshot",
      "target_turn.model_profile_id",
      "target_turn.provider",
      "target_turn.model_id",
      "target_turn.thinking_level",
      "target_turn.service_tier",
      "target_turn.credential_binding_id",
      "target_turn.credential_binding_version",
    ])
    .where("r.tenant_id", "=", tenantId)
    .where("r.session_id", "=", sessionId)
    .where("r.turn_id", "=", turnId)
    .where("r.state", "=", "running")
    .where("target_turn.state", "=", "running")
    .forNoKeyUpdate(["r", "target_turn"])
    .noWait()
    .executeTakeFirst();
  if (!target?.sandbox_id)
    throw new ControlPlaneStoreError("conflict", "The target Run no longer accepts Steer input");
  return { ...target, sandbox_id: target.sandbox_id };
}

/** Persist one held source using the same contract for both human Steer paths. */
export async function holdQueuedSteer(
  tx: Transaction<Database>,
  input: {
    controlId: string;
    tenantId: string;
    sessionId: string;
    targetRunId: string;
    targetTurnId: string;
    sourceRunId: string;
    sourceTurnId: string;
    idempotencyKey: string;
    requestSha256: string;
    queueOrder: number;
    projectId: string;
    workspaceId: string;
    sandboxId: string;
    piSessionId: string;
  },
): Promise<void> {
  await tx
    .insertInto("turn_control_requests")
    .values({
      id: input.controlId,
      tenant_id: input.tenantId,
      session_id: input.sessionId,
      turn_id: input.targetTurnId,
      target_run_id: input.targetRunId,
      idempotency_key: input.idempotencyKey,
      kind: "queue",
      state: "pending",
      request_sha256: input.requestSha256,
      payload: {
        action: "steer",
        sourceRunId: input.sourceRunId,
        sourceTurnId: input.sourceTurnId,
        queueOrder: input.queueOrder,
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        sandboxId: input.sandboxId,
        piSessionId: input.piSessionId,
      },
      attempts: 0,
      available_at: sql`clock_timestamp()`,
      dispatched_at: null,
      acknowledged_at: null,
      completed_at: null,
      failure_code: null,
    })
    .execute();
  await tx
    .updateTable("runs")
    .set({
      queued_steer_id: input.controlId,
      ready_at: null,
      row_version: sql`row_version+1`,
      updated_at: sql`clock_timestamp()`,
    })
    .where("id", "=", input.sourceRunId)
    .where("tenant_id", "=", input.tenantId)
    .execute();
}
