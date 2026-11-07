import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  DEFAULT_WORKSPACE_CAPACITY_GIB,
  workspaceCapacityBytes,
  type WorkspaceCapacitySnapshot,
} from "@pi-cloud/protocol";

export function defaultWorkspaceCapacityBytes(): number {
  return workspaceCapacityBytes(
    Number(process.env.PI_CLOUD_DEFAULT_WORKSPACE_CAPACITY_GIB ?? DEFAULT_WORKSPACE_CAPACITY_GIB),
  );
}
export class WorkspaceCapacityService {
  constructor(readonly database: Kysely<Database>) {}
  async read(
    tenantId: string,
    workspaceId: string,
  ): Promise<WorkspaceCapacitySnapshot | undefined> {
    const row = await this.database
      .selectFrom("workspaces")
      .select(["id", "capacity_bytes", "capacity_revision", "capacity_pending"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", workspaceId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row
      ? {
          workspaceId: row.id,
          capacityBytes: Number(row.capacity_bytes),
          revision: Number(row.capacity_revision),
          pending: row.capacity_pending,
        }
      : undefined;
  }
  async grow(
    tenantId: string,
    workspaceId: string,
    minimumGiB: number,
  ): Promise<WorkspaceCapacitySnapshot | undefined> {
    const bytes = workspaceCapacityBytes(minimumGiB);
    return this.database.transaction().execute(async (tx) => {
      const current = await tx
        .selectFrom("workspaces")
        .select(["id", "capacity_bytes", "capacity_revision", "capacity_pending"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", workspaceId)
        .where("deleted_at", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return undefined;
      // "At least this capacity" is naturally idempotent, including an old
      // acknowledgement retry after another growth already succeeded.
      if (Number(current.capacity_bytes) >= bytes)
        return {
          workspaceId,
          capacityBytes: Number(current.capacity_bytes),
          revision: Number(current.capacity_revision),
          pending: current.capacity_pending,
        };
      const updated = await tx
        .updateTable("workspaces")
        .set({
          capacity_bytes: bytes,
          capacity_revision: sql`capacity_revision+1`,
          capacity_pending: true,
          row_version: sql`row_version+1`,
          updated_at: sql`clock_timestamp()`,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", workspaceId)
        .returning(["capacity_bytes", "capacity_revision"])
        .executeTakeFirstOrThrow();
      return {
        workspaceId,
        capacityBytes: Number(updated.capacity_bytes),
        revision: Number(updated.capacity_revision),
        pending: true,
      };
    });
  }
}
