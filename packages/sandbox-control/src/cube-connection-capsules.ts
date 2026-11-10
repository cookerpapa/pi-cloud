import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { CubePersistentCapsuleCodec } from "./cube-persistent-capsule.ts";
import type { CubeExecutionTarget, CubeSandboxInstance } from "./cubesandbox-runtime-client.ts";

export type CubeConnectionTarget = Pick<CubeExecutionTarget, "apiUrl" | "sandboxId" | "nodeId">;
type CapsuleRow = { id: string; tenant_id: string; workspace_id: string; runtime_capsule: string };

/** Retained private connection data, not resource adoption or a lease check. */
export function connectionFromCapsule(
  codec: CubePersistentCapsuleCodec,
  row: CapsuleRow,
  target: CubeConnectionTarget,
): CubeSandboxInstance | undefined {
  const value = codec.open(row.runtime_capsule);
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as {
    version?: number;
    handle?: {
      activationId?: string;
      runtimeName?: string;
      assignment?: { tenantId?: string; workspaceId?: string };
    };
    executionTarget?: CubeExecutionTarget;
    instance?: CubeSandboxInstance;
  };
  const instance = raw.instance,
    physical = raw.executionTarget,
    handle = raw.handle;
  if (
    raw.version !== 2 ||
    !instance ||
    !physical ||
    !handle ||
    handle.activationId !== row.id ||
    handle.assignment?.tenantId !== row.tenant_id ||
    handle.assignment.workspaceId !== row.workspace_id ||
    handle.runtimeName !== target.sandboxId ||
    physical.apiUrl !== target.apiUrl ||
    physical.sandboxId !== target.sandboxId ||
    physical.nodeId !== target.nodeId ||
    instance.sandboxId !== target.sandboxId ||
    instance.nodeId !== target.nodeId ||
    typeof instance.trafficAccessToken !== "string" ||
    instance.trafficAccessToken.length < 16
  )
    return undefined;
  return instance;
}

export function cubeConnectionResolver(database: Kysely<Database>, key: Uint8Array) {
  const codec = new CubePersistentCapsuleCodec(key);
  return async (target: CubeConnectionTarget): Promise<CubeSandboxInstance | undefined> => {
    // Native ids are scoped by the encrypted API/node identity below. Closed but
    // not yet retired resources may still need their original cancellation path.
    const { rows } = await sql<CapsuleRow>`
      select workspace_runtime_id as id, tenant_id, workspace_id, runtime_capsule
        from workspace_runtimes where runtime_name=${target.sandboxId} and runtime_capsule is not null
      union all
      select allocation_id as id, tenant_id, workspace_id, runtime_capsule
        from development_environments where runtime_name=${target.sandboxId} and runtime_capsule is not null
      limit 8`.execute(database);
    for (const row of rows) {
      const connection = connectionFromCapsule(codec, row, target);
      if (connection) return connection;
    }
    return undefined;
  };
}
