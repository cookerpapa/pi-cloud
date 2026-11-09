import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  parseExecutionReference,
  type ToolEnvironmentRequest,
  type ExecutionEvidence,
} from "@pi-cloud/protocol";
import type { ToolEnvironmentCoordinator } from "./tool-environment-coordinator.ts";
import type { SandboxBinding } from "./sandbox-bindings.ts";
import { SandboxControlError } from "./sandbox-provider.ts";
import { executionTargetId } from "./sandbox-execution.ts";

/** Fault-only readiness. The resource owner, not this waiter, decides whether
 * an old allocation is absent and may be replaced. No Tool is executed here. */
export class EnvironmentRecovery {
  constructor(
    readonly options: {
      database: Kysely<Database>;
      environments: Pick<ToolEnvironmentCoordinator, "ensure">;
      owner(sessionId: string): (() => boolean) | undefined;
      probe(binding: SandboxBinding): Promise<void>;
    },
  ) {}

  async recover(
    environment: ToolEnvironmentRequest,
    signal: AbortSignal,
  ): Promise<ExecutionEvidence> {
    const a = environment.assignment;
    const identity = parseExecutionReference(a.executionReference);
    const current = this.options.owner(environment.piSessionId);
    if (!current)
      throw new SandboxControlError(
        "environment_owner_pending",
        "Execution owner is reconnecting",
        true,
      );
    const assertAllowed = async () => {
      signal.throwIfAborted();
      const {
        rows: [row],
      } = await sql<{ alive: boolean; desired_state: string | null }>`
        select (l.tool_bindings_closed_at is null and e.accepting_effects
          and e.valid_until>clock_timestamp()) as alive, d.desired_state
        from active_execution_scopes e join session_leases l on l.lease_id=e.lease_id
        join workspaces w on w.tenant_id=e.tenant_id and w.id=${a.workspaceId}::uuid
        left join development_environments d on d.tenant_id=w.tenant_id and d.workspace_id=w.id
        where e.tenant_id=${a.tenantId}::uuid and e.pi_session_id=${environment.piSessionId}
          and e.lease_id=${identity.leaseId}::uuid and e.fencing_token=${identity.fencingToken}
          and e.run_id=${identity.runId}::uuid`.execute(this.options.database);
      if (!row?.alive || !current())
        throw new SandboxControlError(
          "environment_recovery_revoked",
          "Run ownership or workspace admission closed",
          false,
        );
      if (
        environment.executionMode === "development_environment" &&
        row.desired_state !== "running"
      )
        throw new SandboxControlError(
          "environment_paused",
          "The development machine was paused by its owner",
          false,
        );
    };
    await assertAllowed();
    const binding = await this.options.environments.ensure(
      {
        tenantId: a.tenantId,
        sessionId: a.sessionId,
        turnId: a.turnId,
        runId: identity.runId,
        writerId: identity.leaseId,
        fencingToken: identity.fencingToken,
        piSessionId: environment.piSessionId,
      },
      environment,
      current,
      signal,
    );
    try {
      await this.options.probe(binding);
    } catch (cause) {
      throw new SandboxControlError(
        "tool_environment_pending",
        "Waiting for verified execution readiness",
        true,
        cause,
      );
    }
    await assertAllowed();
    return {
      bindingId: binding.bindingId,
      targetId: executionTargetId(binding.descriptor.target),
      bootId: binding.descriptor.target.bootId,
      observedAt: Date.now(),
      continuityId: binding.snapshot.physicalActivationId,
      continuity: binding.snapshot.continuity ?? "cold_restore",
    };
  }
}
