import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import { sql, type Kysely, type Selectable } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  WORKSPACE_TRANSFER_TTL_MS,
  parseCreateWorkspaceFileTransfer,
  parseWorkspaceFileTransferRequest,
  parseWorkspaceFileTransferSnapshot,
  uploadRelativePath,
  type WorkspaceFileTransfer,
  type WorkspaceFileTransferRequest,
  type WorkspaceFileTransferSnapshot,
} from "@pi-cloud/protocol";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
import { operationalLog } from "@pi-cloud/observability";

type Row = Selectable<Database["workspace_file_transfers"]>;
export interface WorkspaceFileTransferPort {
  workspaceFileTransfer(
    request: WorkspaceFileTransferRequest,
    chunks?: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileTransferSnapshot>;
}
export type WorkspaceTransferActor = {
  tenantId: string;
  userId: string;
  sessionId: string;
  uploadId: string;
};
const unavailable = () =>
  new ControlPlaneStoreError("not_found", "Workspace upload is unavailable");
const conflict = (message: string) => new ControlPlaneStoreError("conflict", message);

/** Admission metadata only. The receiver owns bytes, progress and publication. */
export class WorkspaceFileTransferService {
  #timer: ReturnType<typeof setInterval> | undefined;
  #maintenance: Promise<void> | undefined;
  readonly #shutdown = new AbortController();
  constructor(
    readonly database: Kysely<Database>,
    readonly transport?: WorkspaceFileTransferPort,
  ) {}

  onModuleInit() {
    if (!this.transport) return;
    this.#timer = setInterval(() => {
      void this.reap().catch(() =>
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "warn",
          event: "workspace_transfer.cleanup_unavailable",
        }),
      );
    }, 60_000);
    this.#timer.unref();
  }
  async onModuleDestroy() {
    clearInterval(this.#timer);
    this.#shutdown.abort();
    await this.#maintenance?.catch(() => undefined);
  }

  async create(
    actor: WorkspaceTransferActor,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileTransfer> {
    let input: ReturnType<typeof parseCreateWorkspaceFileTransfer>;
    try {
      input = parseCreateWorkspaceFileTransfer(value);
    } catch {
      throw new ControlPlaneStoreError(
        "invalid_request",
        "Invalid Workspace file identity or destination",
      );
    }
    const row = await this.database.transaction().execute(async (tx) => {
      const session = await tx
        .selectFrom("sessions as s")
        .innerJoin("workspaces as w", (join) =>
          join.onRef("w.id", "=", "s.workspace_id").onRef("w.tenant_id", "=", "s.tenant_id"),
        )
        .select([
          "s.workspace_id",
          "s.working_directory",
          "s.execution_mode",
          "s.development_environment_id",
          "s.created_by_user_id",
        ])
        .where("s.id", "=", actor.sessionId)
        .where("s.tenant_id", "=", actor.tenantId)
        .where("s.session_kind", "=", "conversation")
        .where("s.pruned_at", "is", null)
        .where("w.deleted_at", "is", null)
        .forNoKeyUpdate("s")
        .forShare("w")
        .executeTakeFirst();
      if (
        !session ||
        session.workspace_id !== input.workspaceId ||
        session.working_directory !== input.workingDirectory
      )
        throw conflict("The selected Workspace or directory changed");
      if (
        session.execution_mode === "development_environment" &&
        (!session.development_environment_id || session.created_by_user_id !== actor.userId)
      )
        throw unavailable();
      const relativePath =
        input.directory === undefined
          ? uploadRelativePath(actor.uploadId, input.name)
          : input.directory
            ? `${input.directory}/${input.name}`
            : input.name;
      const existing = await tx
        .selectFrom("workspace_file_transfers")
        .selectAll()
        .where("id", "=", actor.uploadId)
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        if (
          existing.tenant_id !== actor.tenantId ||
          existing.actor_user_id !== actor.userId ||
          existing.session_id !== actor.sessionId ||
          existing.workspace_id !== input.workspaceId ||
          existing.working_directory !== input.workingDirectory ||
          existing.relative_path !== relativePath ||
          existing.development_environment_id !== session.development_environment_id ||
          existing.sha256 !== input.sha256 ||
          Number(existing.byte_length) !== input.byteLength ||
          existing.name !== input.name
        )
          throw conflict("Upload identity was used for a different file or destination");
        if (existing.state === "cancelled" || new Date(existing.expires_at).valueOf() <= Date.now())
          throw conflict("Workspace upload was cancelled or expired; select the file again");
        return existing;
      }
      return tx
        .insertInto("workspace_file_transfers")
        .values({
          id: actor.uploadId,
          tenant_id: actor.tenantId,
          session_id: actor.sessionId,
          workspace_id: input.workspaceId,
          actor_user_id: actor.userId,
          working_directory: input.workingDirectory,
          development_environment_id: session.development_environment_id,
          name: input.name,
          relative_path: relativePath,
          create_parents: input.directory === undefined,
          byte_length: input.byteLength,
          sha256: input.sha256,
          claim_token: randomUUID(),
          state: "uploading",
          cleanup_confirmed_at: null,
          expires_at: sql`clock_timestamp() + ${WORKSPACE_TRANSFER_TTL_MS} * interval '1 millisecond'`,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    if (row.state === "ready")
      return this.#resource(row, {
        state: "ready",
        offset: Number(row.byte_length),
        relativePath: row.relative_path,
      });
    return this.#execute(row, "create", undefined, undefined, signal);
  }

  async status(actor: WorkspaceTransferActor, signal?: AbortSignal) {
    const row = await this.#admit(actor, true);
    if (row.state !== "uploading")
      return this.#resource(row, {
        state: row.state,
        offset: row.state === "ready" ? Number(row.byte_length) : 0,
        relativePath: row.relative_path,
      });
    return this.#execute(row, "status", undefined, undefined, signal);
  }

  async append(
    actor: WorkspaceTransferActor,
    offset: number,
    length: number,
    chunks: Readable,
    signal?: AbortSignal,
  ) {
    const row = await this.#admit(actor, true);
    if (row.state !== "uploading") throw conflict("Workspace upload no longer accepts bytes");
    return this.#execute(row, "append", { offset, chunkLength: length }, chunks, signal);
  }

  async cancel(actor: WorkspaceTransferActor, signal?: AbortSignal) {
    const row = await this.database
      .updateTable("workspace_file_transfers")
      .set({ state: "cancelled" })
      .where("id", "=", actor.uploadId)
      .where("tenant_id", "=", actor.tenantId)
      .where("session_id", "=", actor.sessionId)
      .where("actor_user_id", "=", actor.userId)
      .where("state", "!=", "ready")
      .returningAll()
      .executeTakeFirst();
    if (!row) return this.status(actor, signal);
    return this.#execute(row, "cancel", undefined, undefined, signal);
  }

  async #admit(actor: WorkspaceTransferActor, renew: boolean): Promise<Row> {
    return this.database.transaction().execute(async (tx) => {
      const session = await tx
        .selectFrom("sessions as s")
        .innerJoin("workspaces as w", (join) =>
          join.onRef("w.id", "=", "s.workspace_id").onRef("w.tenant_id", "=", "s.tenant_id"),
        )
        .select(["s.workspace_id", "s.working_directory", "s.development_environment_id"])
        .where("s.tenant_id", "=", actor.tenantId)
        .where("s.id", "=", actor.sessionId)
        .where("s.pruned_at", "is", null)
        .where("w.deleted_at", "is", null)
        .forShare("s")
        .forShare("w")
        .executeTakeFirst();
      if (!session) throw unavailable();
      const row = await tx
        .selectFrom("workspace_file_transfers")
        .selectAll()
        .where("id", "=", actor.uploadId)
        .where("tenant_id", "=", actor.tenantId)
        .where("session_id", "=", actor.sessionId)
        .where("actor_user_id", "=", actor.userId)
        .where("expires_at", ">", sql<Date>`clock_timestamp()`)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw unavailable();
      if (
        row.workspace_id !== session.workspace_id ||
        row.working_directory !== session.working_directory ||
        row.development_environment_id !== session.development_environment_id
      )
        throw conflict("The upload belongs to the previous Workspace or directory");
      if (renew && row.state === "uploading")
        return tx
          .updateTable("workspace_file_transfers")
          .set({
            expires_at: sql`clock_timestamp() + ${WORKSPACE_TRANSFER_TTL_MS} * interval '1 millisecond'`,
          })
          .where("id", "=", row.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      return row;
    });
  }

  async #execute(
    row: Row,
    action: WorkspaceFileTransferRequest["action"],
    append?: { offset: number; chunkLength: number },
    chunks?: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileTransfer> {
    if (!this.transport)
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Workspace file transfers are unavailable",
      );
    const machine = row.development_environment_id
      ? {
          environmentId: row.development_environment_id,
          userId: row.actor_user_id,
          directory: row.working_directory,
        }
      : undefined;
    if (
      !machine &&
      row.working_directory !== "/workspace" &&
      !row.working_directory.startsWith("/workspace/")
    )
      throw conflict("Workspace root is invalid");
    const request = parseWorkspaceFileTransferRequest({
      fileTransferProtocolVersion: 1,
      type: "workspace.file_transfer",
      requestId: randomUUID(),
      uploadId: row.id,
      claimToken: row.claim_token,
      tenantId: row.tenant_id,
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      rootPath: machine ? "" : row.working_directory.slice("/workspace/".length),
      name: row.name,
      relativePath: row.relative_path,
      createParents: row.create_parents,
      sha256: row.sha256,
      byteLength: Number(row.byte_length),
      expiresAt: new Date(row.expires_at).toISOString(),
      action,
      ...append,
      ...(machine ? { machine } : {}),
    });
    const active = signal
      ? AbortSignal.any([signal, this.#shutdown.signal])
      : this.#shutdown.signal;
    const result = parseWorkspaceFileTransferSnapshot(
      await this.transport.workspaceFileTransfer(request, chunks, active),
    );
    if (
      result.relativePath !== row.relative_path ||
      result.offset > Number(row.byte_length) ||
      (result.state === "ready" && result.offset !== Number(row.byte_length))
    )
      throw new Error("Workspace transfer receipt changed identity");
    if (result.state === "ready" || result.state === "cancelled")
      await this.database
        .updateTable("workspace_file_transfers")
        .set({
          state: result.state,
          ...(result.state === "cancelled"
            ? { cleanup_confirmed_at: sql<Date>`clock_timestamp()` }
            : {}),
        })
        .where("id", "=", row.id)
        .where("claim_token", "=", row.claim_token)
        .execute();
    return this.#resource(row, result);
  }

  #resource(row: Row, result: WorkspaceFileTransferSnapshot): WorkspaceFileTransfer {
    return {
      id: row.id,
      sessionId: row.session_id,
      workspaceId: row.workspace_id,
      name: row.name,
      path: posix.join(row.working_directory, row.relative_path),
      byteLength: Number(row.byte_length),
      sha256: row.sha256,
      state: result.state,
      offset: result.offset,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  reap(): Promise<void> {
    return (this.#maintenance ??= this.#reap().finally(() => {
      this.#maintenance = undefined;
    }));
  }
  async #reap() {
    if (!this.transport || this.#shutdown.signal.aborted) return;
    const rows = await this.database
      .selectFrom("workspace_file_transfers")
      .selectAll()
      .where("expires_at", "<=", sql<Date>`clock_timestamp()`)
      .orderBy("expires_at")
      .limit(16)
      .execute();
    for (const row of rows) {
      if (this.#shutdown.signal.aborted) return;
      if (row.state !== "ready" && !row.cleanup_confirmed_at) {
        const cancelled = await this.database
          .updateTable("workspace_file_transfers")
          .set({ state: "cancelled" })
          .where("id", "=", row.id)
          .where("expires_at", "<=", sql<Date>`clock_timestamp()`)
          .where("state", "!=", "ready")
          .returningAll()
          .executeTakeFirst();
        if (!cancelled) continue;
        try {
          await this.#execute(cancelled, "cancel");
        } catch {
          // Admission is already revoked. Back off this cleanup target so a
          // paused/lost machine cannot starve other expired transfer records.
          await this.database
            .updateTable("workspace_file_transfers")
            .set({ expires_at: sql`clock_timestamp() + interval '5 minutes'` })
            .where("id", "=", row.id)
            .where("state", "=", "cancelled")
            .execute();
          operationalLog({
            service: "pi-cloud-control-plane",
            level: "warn",
            event: "workspace_transfer.cleanup_deferred",
            attributes: { transferId: row.id },
          });
          continue;
        }
      }
      await this.database
        .deleteFrom("workspace_file_transfers")
        .where("id", "=", row.id)
        .where("expires_at", "<=", sql<Date>`clock_timestamp()`)
        .where((eb) =>
          eb.or([eb("state", "=", "ready"), eb("cleanup_confirmed_at", "is not", null)]),
        )
        .execute();
    }
  }
}
