import { retainPreview } from "./interactive-resource-use.ts";
import type { RuntimeRetention } from "./runtime-retention.ts";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import type { SandboxController } from "./sandbox-controller.ts";
import type { FixedGuestSandboxProvider } from "./fixed-guest-sandbox-provider.ts";
import type { SandboxControlListWorkspaceDirectoryRequest } from "@pi-cloud/protocol";
import { SandboxControlError } from "./sandbox-provider.ts";

/** Human data reads have their own PG authorization, independent of resource-owner liveness. */
export class SessionResourceAccess {
  constructor(
    readonly database: Kysely<Database>,
    readonly provider: Pick<
      FixedGuestSandboxProvider,
      | "openDataCapsule"
      | "listWorkspaceDirectory"
      | "readWorkspaceFile"
      | "listMachineWorkspaceDirectory"
      | "readMachineWorkspaceFile"
      | "openPreviewConnection"
    >,
    readonly retention: RuntimeRetention,
  ) {}
  async #machine(
    request: Pick<
      SandboxControlListWorkspaceDirectoryRequest,
      "tenantId" | "workspaceId" | "machine"
    >,
  ) {
    const machine = request.machine!;
    const row = await this.database
      .selectFrom("development_environments")
      .select(["runtime_capsule", "allocation_id"])
      .where("tenant_id", "=", request.tenantId)
      .where("owner_user_id", "=", machine.userId)
      .where("id", "=", machine.environmentId)
      .where("workspace_id", "=", request.workspaceId)
      .where("state", "=", "ready")
      .where("desired_state", "=", "running")
      .where("allocation_closed", "=", false)
      .executeTakeFirst();
    if (!row?.runtime_capsule)
      throw new SandboxControlError(
        "workspace_browser_unavailable",
        "Machine Workspace is not running or owned by this user",
        false,
      );
    const handle = this.provider.openDataCapsule(row.runtime_capsule);
    if (
      handle.activationId !== row.allocation_id ||
      handle.assignment.workspaceId !== request.workspaceId ||
      handle.assignment.tenantId !== request.tenantId
    )
      throw new Error("Machine data identity changed");
    return handle;
  }
  listWorkspaceDirectory: SandboxController["listWorkspaceDirectory"] = async (request) =>
    request.machine
      ? this.provider.listMachineWorkspaceDirectory(await this.#machine(request), request)
      : this.provider.listWorkspaceDirectory(request);
  readWorkspaceFile: SandboxController["readWorkspaceFile"] = async (request, signal) =>
    request.machine
      ? this.provider.readMachineWorkspaceFile(await this.#machine(request), request)
      : this.provider.readWorkspaceFile(request, signal);
  openPreviewConnection: SandboxController["openPreviewConnection"] = async (request, signal) => {
    let handle;
    if (request.target.kind === "development_environment") {
      handle = await this.#machine({
        tenantId: request.tenantId,
        workspaceId: request.workspaceId,
        machine: {
          environmentId: request.target.environmentId,
          userId: request.userId,
          directory: "/home/user",
        },
      });
    } else {
      const row = await this.database
        .selectFrom("sessions as session")
        .innerJoin("workspaces as workspace", (join) =>
          join
            .onRef("workspace.tenant_id", "=", "session.tenant_id")
            .onRef("workspace.id", "=", "session.workspace_id"),
        )
        .innerJoin("sandbox_http_services as service", (join) =>
          join
            .onRef("service.tenant_id", "=", "session.tenant_id")
            .onRef("service.session_id", "=", "session.id")
            .on("service.target_kind", "=", "conversation")
            .on("service.state", "=", "active")
            .on("service.port", "=", request.port),
        )
        .innerJoin("workspace_runtimes as runtime", (join) =>
          join
            .onRef("runtime.tenant_id", "=", "service.tenant_id")
            .onRef("runtime.workspace_id", "=", "service.workspace_id")
            .onRef("runtime.runtime_id", "=", "service.runtime_id"),
        )
        .select(["runtime.runtime_capsule", "runtime.workspace_runtime_id"])
        .where("session.tenant_id", "=", request.tenantId)
        .where("session.id", "=", request.target.sessionId)
        .where("session.created_by_user_id", "=", request.userId)
        .where("session.pruned_at", "is", null)
        .where("workspace.id", "=", request.workspaceId)
        .where("workspace.deleted_at", "is", null)
        .where("runtime.state", "=", "allocated")
        .where("runtime.allocation_closed", "=", false)
        .orderBy("service.last_seen_at", "desc")
        .executeTakeFirst();
      if (!row?.runtime_capsule)
        throw new SandboxControlError(
          "sandbox_preview_unavailable",
          "Application runtime is unavailable",
          true,
        );
      handle = this.provider.openDataCapsule(row.runtime_capsule);
      if (handle.activationId !== row.workspace_runtime_id)
        throw new Error("Preview data identity changed");
    }
    signal?.throwIfAborted();
    const stream = await this.provider.openPreviewConnection(handle, request.port, signal);
    return request.target.kind === "development_environment"
      ? stream
      : retainPreview(stream, this.retention, {
          kind: "workspace",
          id: handle.activationId,
          tenantId: request.tenantId,
        });
  };
}
