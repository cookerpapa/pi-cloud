import type { Database } from "@pi-cloud/database";
import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";
import { PiTurnError } from "@pi-cloud/sandbox-supervisor";
import { createWorkspaceSeed } from "@pi-cloud/workspace-runtime";
import type { Kysely } from "kysely";

export type PostgresWorkspaceSeedResolverOptions = {
  database: Kysely<Database>;
};

export class WorkspaceSeedError extends PiTurnError {
  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(code, safeMessage, retryable);
    this.name = "WorkspaceSeedError";
  }
}

export class PostgresWorkspaceSeedResolver {
  readonly #database: Kysely<Database>;

  constructor(options: PostgresWorkspaceSeedResolverOptions) {
    this.#database = options.database;
  }

  async resolve(
    command: ExecuteTurnCommandMessage,
    signal: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    if (signal.aborted) {
      throw new WorkspaceSeedError(
        "workspace_seed_cancelled",
        "Workspace setup was cancelled",
        true,
      );
    }
    const workspace = await this.#database
      .selectFrom("workspaces as workspace")
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "workspace.tenant_id")
          .onRef("run.project_id", "=", "workspace.project_id")
          .onRef("run.workspace_id", "=", "workspace.id"),
      )
      .select("workspace.seed_kind as seedKind")
      .where("workspace.deleted_at", "is", null)
      .where("workspace.tenant_id", "=", command.payload.tenantId)
      .where("workspace.project_id", "=", command.payload.projectId)
      .where("workspace.id", "=", command.payload.workspaceId)
      .where("run.id", "=", command.payload.runId)
      .executeTakeFirst();
    if (workspace === undefined) {
      throw new WorkspaceSeedError(
        "workspace_source_unavailable",
        "Workspace setup is unavailable",
        false,
      );
    }
    return workspace.seedKind === "sample_java" ? undefined : createWorkspaceSeed([]);
  }
}
