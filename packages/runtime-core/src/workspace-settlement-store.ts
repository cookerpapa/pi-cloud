import type { Database } from "@pi-cloud/database";
import type { ExecuteTurnCommandMessage } from "@pi-cloud/protocol";
import {
  MAX_TOOL_OUTPUT_BYTES,
  MAX_WORKSPACE_BLOB_BYTES,
  parseEnvironmentValidationReport,
  parseExecutionLease,
} from "@pi-cloud/protocol";
import {
  type CapturedEnvironmentWorkspaceSettlement,
  type CapturedToolOutput,
  type LoadedWorkspaceSettlement,
  type WorkspaceSettlementStore,
  type SavedWorkspaceSettlement,
  type SavedToolOutputArtifact,
} from "@pi-cloud/sandbox-supervisor/workspace-settlement";
import { PiTurnError } from "@pi-cloud/sandbox-supervisor/pi-turn-runtime";
import { validateWorkspacePayload } from "@pi-cloud/sandbox-supervisor/workspace-seed";
import { createHash, randomUUID } from "node:crypto";
import { lstat, link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { sql, type Kysely, type Transaction } from "kysely";

// Workspace settlement references and archived Tool output are bounded runtime objects.
// runtime objects. Keep one shared guard comfortably above their bounded
// payloads without permitting unbounded reads.
export const MAX_RUNTIME_OBJECT_BYTES = 136 * 1_024 * 1_024;

export interface RuntimeObjectStore {
  put(objectKey: string, bytes: Uint8Array): Promise<void>;
  get(objectKey: string): Promise<Uint8Array>;
  delete(objectKey: string): Promise<void>;
}

export type FileRuntimeObjectStoreOptions = {
  rootDirectory: string;
  idGenerator?: () => string;
};

export type PostgresWorkspaceSettlementStoreOptions = {
  database: Kysely<Database>;
  objectStore: RuntimeObjectStore;
  clock?: () => Date;
  idGenerator?: () => string;
};

type ArtifactReference = {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
};

type SettlementMetadata = {
  reference?: ArtifactReference;
  revision: string;
  workspaceRevision?: string;
};

export class WorkspaceSettlementStoreError extends PiTurnError {
  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(code, safeMessage, retryable);
    this.name = "WorkspaceSettlementStoreError";
  }
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("settlement store clock must return a valid Date");
  }
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeSize(value: string | number | bigint, maximum: number, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new WorkspaceSettlementStoreError(
      "settlement_metadata_invalid",
      `${description} metadata is invalid`,
      false,
    );
  }
  return parsed;
}

function revisionFor(workspaceKey: string): string {
  return createHash("sha256")
    .update("pi-cloud.workspace-settlement-revision.v1\0")
    .update(workspaceKey)
    .digest("hex");
}

export function validateRuntimeObjectKey(value: string): string {
  if (
    value.length < 1 ||
    value.length > 2_048 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new WorkspaceSettlementStoreError(
      "runtime_object_key_invalid",
      "Runtime object key is invalid",
      false,
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !/^[A-Za-z0-9._-]+$/.test(segment),
    )
  ) {
    throw new WorkspaceSettlementStoreError(
      "runtime_object_key_invalid",
      "Runtime object key is invalid",
      false,
    );
  }
  return value;
}

export class FileRuntimeObjectStore implements RuntimeObjectStore {
  readonly #rootDirectory: string;
  readonly #idGenerator: () => string;

  constructor(options: FileRuntimeObjectStoreOptions) {
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async put(objectKey: string, bytes: Uint8Array): Promise<void> {
    const target = this.#target(objectKey);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${this.#idGenerator()}`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporary, target);
      await rm(temporary, { force: true });
    } catch (error: unknown) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const target = this.#target(objectKey);
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new WorkspaceSettlementStoreError(
        "runtime_object_invalid",
        "Runtime object is not a regular file",
        false,
      );
    }
    if (metadata.size < 1 || metadata.size > MAX_RUNTIME_OBJECT_BYTES) {
      throw new WorkspaceSettlementStoreError(
        "runtime_object_invalid",
        "Runtime object is outside its byte limit",
        false,
      );
    }
    return readFile(target);
  }

  async delete(objectKey: string): Promise<void> {
    await rm(this.#target(objectKey), { force: true });
  }

  #target(objectKey: string): string {
    const target = resolve(this.#rootDirectory, validateRuntimeObjectKey(objectKey));
    if (target !== this.#rootDirectory && !target.startsWith(`${this.#rootDirectory}${sep}`)) {
      throw new WorkspaceSettlementStoreError(
        "runtime_object_key_invalid",
        "Runtime object key escaped its store",
        false,
      );
    }
    return target;
  }
}

export class PostgresWorkspaceSettlementStore implements WorkspaceSettlementStore {
  readonly #database: Kysely<Database>;
  readonly #objectStore: RuntimeObjectStore;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: PostgresWorkspaceSettlementStoreOptions) {
    this.#database = options.database;
    this.#objectStore = options.objectStore;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  async load(command: ExecuteTurnCommandMessage): Promise<LoadedWorkspaceSettlement | undefined> {
    const metadata = await this.#database.transaction().execute(async (transaction) => {
      return this.#loadMetadata(transaction, command, validDate(this.#clock));
    });
    if (metadata === undefined) return undefined;

    const reference =
      metadata.reference === undefined
        ? undefined
        : await this.#objectStore.get(metadata.reference.objectKey);
    if (reference !== undefined && metadata.reference !== undefined) {
      this.#verifyObject(
        reference,
        metadata.reference,
        MAX_WORKSPACE_BLOB_BYTES,
        "Workspace settlement",
      );
    }
    if (reference !== undefined) validateWorkspacePayload(reference);

    await this.#database.transaction().execute(async (transaction) => {
      const current = await this.#loadMetadata(transaction, command, validDate(this.#clock));
      if (current?.revision !== metadata.revision) {
        throw new WorkspaceSettlementStoreError(
          "settlement_changed",
          "Workspace settlement changed while it was loading",
          true,
        );
      }
    });
    return {
      revision: metadata.revision,
      ...(reference === undefined ? {} : { reference }),
      ...(metadata.workspaceRevision === undefined
        ? {}
        : { workspaceRevision: metadata.workspaceRevision }),
    };
  }

  async saveToolOutput(
    command: ExecuteTurnCommandMessage,
    output: CapturedToolOutput,
  ): Promise<SavedToolOutputArtifact> {
    if (
      output.toolCallId.length < 1 ||
      output.toolCallId.length > 256 ||
      output.bytes.byteLength < 1 ||
      output.bytes.byteLength > MAX_TOOL_OUTPUT_BYTES
    ) {
      throw new WorkspaceSettlementStoreError(
        "tool_output_invalid",
        "Tool output artifact is outside its identity or byte limit",
        false,
      );
    }
    const artifactId = this.#idGenerator();
    const execution = parseExecutionLease(command.payload.executionLease);
    const digest = sha256(output.bytes);
    const safe = [
      "tool-outputs",
      command.payload.tenantId,
      command.payload.sessionId,
      command.payload.runId,
      execution.attemptId,
    ].map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "-"));
    const objectKey = `${safe.join("/")}/${artifactId}-${digest}.log`;
    validateRuntimeObjectKey(objectKey);
    await this.#objectStore.put(objectKey, output.bytes);
    try {
      await this.#database.transaction().execute(async (transaction) => {
        await this.#assertCurrentSession(transaction, command, validDate(this.#clock), true);
        await transaction
          .insertInto("artifacts")
          .values({
            id: artifactId,
            tenant_id: command.payload.tenantId,
            session_id: command.payload.sessionId,
            turn_id: command.payload.turnId,
            run_id: command.payload.runId,
            kind: "tool_output",
            object_key: objectKey,
            sha256: digest,
            size_bytes: output.bytes.byteLength,
            file_name: `tool-output-${artifactId}.log`,
            media_type: "text/plain; charset=utf-8",
          })
          .executeTakeFirstOrThrow();
      });
    } catch (error: unknown) {
      await this.#objectStore.delete(objectKey).catch(() => undefined);
      throw error;
    }
    return { artifactId, sha256: digest, sizeBytes: output.bytes.byteLength };
  }

  async save(
    command: ExecuteTurnCommandMessage,
    baseRevision: string | null,
    settlement: CapturedEnvironmentWorkspaceSettlement,
  ): Promise<SavedWorkspaceSettlement> {
    const execution = parseExecutionLease(command.payload.executionLease);
    const environment = parseEnvironmentValidationReport(settlement.environment);
    if (
      environment.profileKey !== command.payload.environment.profileKey ||
      environment.profileVersion !== command.payload.environment.profileVersion ||
      environment.imageRevision !== command.payload.environment.imageRevision ||
      environment.specSha256 !== command.payload.environment.specSha256 ||
      environment.recipeSha256 !== command.payload.environment.recipeSha256
    ) {
      throw new WorkspaceSettlementStoreError(
        "environment_validation_mismatch",
        "Tool Sandbox environment evidence did not match the accepted Run",
        false,
      );
    }
    validateWorkspacePayload(settlement.reference);
    const settlementArtifactId = this.#idGenerator();
    const settlementId = this.#idGenerator();
    const environmentValidationId = this.#idGenerator();
    const prefix = [
      "settlements",
      command.payload.tenantId,
      command.payload.sessionId,
      command.payload.turnId,
    ].map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "-"));
    const workspaceReference: ArtifactReference = {
      objectKey: `${prefix.join("/")}/${settlementArtifactId}-${sha256(settlement.reference)}.json`,
      sha256: sha256(settlement.reference),
      sizeBytes: settlement.reference.byteLength,
    };
    validateRuntimeObjectKey(workspaceReference.objectKey);

    try {
      await this.#objectStore.put(workspaceReference.objectKey, settlement.reference);
    } catch (error: unknown) {
      throw error;
    }
    try {
      await this.#database.transaction().execute(async (transaction) => {
        const now = validDate(this.#clock);
        const current = await this.#lockSession(transaction, command, now);
        const settled = await this.#settledMetadata(transaction, command, current);
        const currentRevision = settled?.revision ?? null;
        if (currentRevision !== baseRevision) {
          throw new WorkspaceSettlementStoreError(
            "settlement_conflict",
            "Workspace settlement base revision is stale",
            false,
          );
        }
        const revision = revisionFor(workspaceReference.objectKey);
        await transaction
          .insertInto("artifacts")
          .values({
            id: settlementArtifactId,
            tenant_id: command.payload.tenantId,
            session_id: command.payload.sessionId,
            turn_id: command.payload.turnId,
            run_id: command.payload.runId,
            kind: "workspace_settlement",
            object_key: workspaceReference.objectKey,
            sha256: workspaceReference.sha256,
            size_bytes: workspaceReference.sizeBytes,
            file_name: "workspace-settlement.json",
            media_type: "application/vnd.pi-cloud.workspace-settlement+json",
          })
          .execute();
        await transaction
          .insertInto("environment_validations")
          .values({
            id: environmentValidationId,
            tenant_id: command.payload.tenantId,
            project_id: command.payload.projectId,
            environment_version_id: command.payload.environment.environmentVersionId,
            run_id: command.payload.runId,
            attempt_id: execution.attemptId,
            status: "validated",
            report: environment,
            failure_code: null,
            validated_at: now,
          })
          .executeTakeFirstOrThrow();
        const environmentUpdate = await transaction
          .updateTable("environment_versions")
          .set({
            state: "validated",
            failure_code: null,
            validated_at: now,
            updated_at: now,
          })
          .where("tenant_id", "=", command.payload.tenantId)
          .where("project_id", "=", command.payload.projectId)
          .where("id", "=", command.payload.environment.environmentVersionId)
          .where("profile_key", "=", environment.profileKey)
          .where("profile_version", "=", environment.profileVersion)
          .where("image_revision", "=", environment.imageRevision)
          .where("spec_sha256", "=", environment.specSha256)
          .where("recipe_sha256", "=", environment.recipeSha256)
          .executeTakeFirst();
        if (environmentUpdate.numUpdatedRows !== 1n) {
          throw new WorkspaceSettlementStoreError(
            "environment_validation_mismatch",
            "Project environment changed before validation evidence was committed",
            false,
          );
        }
        const latestSettlement = await transaction
          .selectFrom("workspace_settlements")
          .select(["settlement_number"])
          .where("tenant_id", "=", command.payload.tenantId)
          .where("workspace_id", "=", command.payload.workspaceId)
          .orderBy("settlement_number", "desc")
          .limit(1)
          .executeTakeFirst();
        await transaction
          .insertInto("workspace_settlements")
          .values({
            id: settlementId,
            tenant_id: command.payload.tenantId,
            workspace_id: command.payload.workspaceId,
            session_id: command.payload.sessionId,
            settlement_number: (latestSettlement?.settlement_number ?? 0) + 1,
            parent_settlement_id: current.currentSettlementId,
            source_settlement_id: null,
            origin_kind: "settlement",
            run_id: command.payload.runId,
            attempt_id: execution.attemptId,
            turn_id: command.payload.turnId,
            settlement_artifact_id: settlementArtifactId,
            revision,
            state: "staged",
            settled_at: null,
          })
          .executeTakeFirstOrThrow();
        const updated = await transaction
          .updateTable("sessions")
          .set({
            workspace_settlement_key: workspaceReference.objectKey,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
            last_active_at: now,
          })
          .where("id", "=", command.payload.sessionId)
          .where("tenant_id", "=", command.payload.tenantId)
          .where("row_version", "=", current.rowVersion)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new WorkspaceSettlementStoreError(
            "settlement_conflict",
            "Session changed before its settlement commit",
            true,
          );
        }
      });
    } catch (error: unknown) {
      await Promise.allSettled([this.#objectStore.delete(workspaceReference.objectKey)]);
      throw error;
    }

    return {
      revision: revisionFor(workspaceReference.objectKey),
      workspaceRevision: workspaceReference.sha256,
    };
  }

  async #loadMetadata(
    transaction: Transaction<Database>,
    command: ExecuteTurnCommandMessage,
    now: Date,
  ): Promise<SettlementMetadata | undefined> {
    const session = await this.#assertCurrentSession(transaction, command, now, false);
    return this.#settledMetadata(transaction, command, session);
  }

  async #settledMetadata(
    transaction: Transaction<Database>,
    command: ExecuteTurnCommandMessage,
    session: {
      workspaceKey: string | null;
      rowVersion: string;
      currentSettlementId: string | null;
    },
  ): Promise<SettlementMetadata | undefined> {
    let workspace:
      { object_key: string; sha256: string; size_bytes: string | number | bigint } | undefined;
    if (session.currentSettlementId !== null) {
      workspace = await transaction
        .selectFrom("workspace_settlements as settlement")
        .innerJoin("artifacts as artifact", "artifact.id", "settlement.settlement_artifact_id")
        .select(["artifact.object_key", "artifact.sha256", "artifact.size_bytes"])
        .where("settlement.tenant_id", "=", command.payload.tenantId)
        .where("settlement.workspace_id", "=", command.payload.workspaceId)
        .where("settlement.id", "=", session.currentSettlementId)
        .where("settlement.state", "=", "settled")
        .executeTakeFirst();
      if (workspace === undefined) {
        throw new WorkspaceSettlementStoreError(
          "settlement_metadata_invalid",
          "Current Workspace settlement is missing",
          false,
        );
      }
    } else if (session.workspaceKey !== null) {
      workspace = await transaction
        .selectFrom("artifacts as artifact")
        .innerJoin("session_terminal_events as terminal", (join) =>
          join
            .onRef("terminal.tenant_id", "=", "artifact.tenant_id")
            .onRef("terminal.session_id", "=", "artifact.session_id")
            .onRef("terminal.turn_id", "=", "artifact.turn_id"),
        )
        .select(["artifact.object_key", "artifact.sha256", "artifact.size_bytes"])
        .where("artifact.tenant_id", "=", command.payload.tenantId)
        .where("artifact.session_id", "=", command.payload.sessionId)
        .where("artifact.kind", "=", "workspace_settlement")
        .where("artifact.object_key", "=", session.workspaceKey)
        .where("terminal.type", "=", "turn.completed")
        .executeTakeFirst();
    }
    if (session.currentSettlementId === null && workspace === undefined) {
      workspace = await transaction
        .selectFrom("artifacts as artifact")
        .innerJoin("session_terminal_events as terminal", (join) =>
          join
            .onRef("terminal.tenant_id", "=", "artifact.tenant_id")
            .onRef("terminal.session_id", "=", "artifact.session_id")
            .onRef("terminal.turn_id", "=", "artifact.turn_id"),
        )
        .select(["artifact.object_key", "artifact.sha256", "artifact.size_bytes"])
        .where("artifact.tenant_id", "=", command.payload.tenantId)
        .where("artifact.session_id", "=", command.payload.sessionId)
        .where("artifact.kind", "=", "workspace_settlement")
        .where("terminal.type", "=", "turn.completed")
        .orderBy("terminal.seq", "desc")
        .executeTakeFirst();
    }

    const workspaceReference =
      workspace === undefined
        ? undefined
        : {
            objectKey: workspace.object_key,
            sha256: workspace.sha256,
            sizeBytes: safeSize(
              workspace.size_bytes,
              MAX_WORKSPACE_BLOB_BYTES,
              "Workspace settlement",
            ),
          };
    if (workspaceReference === undefined) return undefined;
    return {
      reference: workspaceReference,
      revision: revisionFor(workspaceReference.objectKey),
      workspaceRevision: workspaceReference.sha256,
    };
  }

  async #lockSession(
    transaction: Transaction<Database>,
    command: ExecuteTurnCommandMessage,
    now: Date,
  ) {
    return this.#assertCurrentSession(transaction, command, now, true);
  }

  async #assertCurrentSession(
    transaction: Transaction<Database>,
    command: ExecuteTurnCommandMessage,
    now: Date,
    lock: boolean,
  ): Promise<{
    workspaceKey: string | null;
    rowVersion: string;
    currentSettlementId: string | null;
  }> {
    const execution = parseExecutionLease(command.payload.executionLease);
    let query = transaction
      .selectFrom("sessions as session_row")
      .innerJoin("session_leases as grant", "grant.session_id", "session_row.id")
      .innerJoin("workspaces as workspace_row", (join) =>
        join
          .onRef("workspace_row.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace_row.id", "=", "session_row.workspace_id"),
      )
      .leftJoin(
        "workspace_settlements as session_head",
        "session_head.id",
        "session_row.current_workspace_settlement_id",
      )
      .leftJoin(
        "artifacts as session_head_artifact",
        "session_head_artifact.id",
        "session_head.settlement_artifact_id",
      )
      .innerJoin("turns as turn_row", (join) =>
        join
          .onRef("turn_row.tenant_id", "=", "session_row.tenant_id")
          .onRef("turn_row.session_id", "=", "session_row.id"),
      )
      .innerJoin("runs as run_row", (join) =>
        join
          .onRef("run_row.tenant_id", "=", "turn_row.tenant_id")
          .onRef("run_row.session_id", "=", "turn_row.session_id")
          .onRef("run_row.turn_id", "=", "turn_row.id"),
      )
      .innerJoin("run_attempts as attempt_row", (join) =>
        join
          .onRef("attempt_row.run_id", "=", "run_row.id")
          .onRef("attempt_row.id", "=", "run_row.current_attempt_id"),
      )
      .select([
        "session_row.tenant_id as tenantId",
        "session_row.project_id as projectId",
        "session_row.workspace_id as workspaceId",
        "session_row.row_version as rowVersion",
        "session_head_artifact.object_key as workspaceKey",
        "session_row.current_workspace_settlement_id as currentSettlementId",
        "session_row.last_fencing_token as sessionExecutionGeneration",
        "session_row.state as sessionState",
        "turn_row.state as turnState",
        "run_row.id as runId",
        "run_row.state as runState",
        "run_row.current_attempt_id as currentAttemptId",
        "attempt_row.id as attemptId",
        "attempt_row.state as attemptState",
        "attempt_row.sandbox_id as attemptSandboxId",
        "attempt_row.lease_id as attemptGrantId",
        "attempt_row.fencing_token as attemptGeneration",
        "grant.lease_id as grantId",
        "grant.attempt_id as executionId",
        "grant.sandbox_id as grantSandboxId",
        "grant.fencing_token as generation",
        "grant.valid_until as validUntil",
      ])
      .where("workspace_row.deleted_at", "is", null)
      .where("session_row.id", "=", command.payload.sessionId)
      .where("turn_row.id", "=", command.payload.turnId)
      .where("run_row.id", "=", command.payload.runId)
      .where("attempt_row.id", "=", execution.attemptId)
      .where("grant.lease_id", "=", execution.leaseId);
    if (lock) query = query.forUpdate(["session_row", "workspace_row"]);
    const row = await query.executeTakeFirst();
    if (
      row === undefined ||
      row.tenantId !== command.payload.tenantId ||
      row.projectId !== command.payload.projectId ||
      row.workspaceId !== command.payload.workspaceId ||
      row.grantId !== execution.leaseId ||
      row.executionId !== execution.attemptId ||
      Number(row.generation) !== execution.fencingToken ||
      Number(row.sessionExecutionGeneration) !== execution.fencingToken ||
      row.sessionState !== "running" ||
      row.turnState !== "running" ||
      row.runId !== command.payload.runId ||
      row.currentAttemptId !== execution.attemptId ||
      row.attemptId !== execution.attemptId ||
      row.attemptGrantId !== execution.leaseId ||
      row.attemptSandboxId !== row.grantSandboxId ||
      Number(row.attemptGeneration) !== execution.fencingToken ||
      (row.runState !== "provisioning" &&
        row.runState !== "restoring" &&
        row.runState !== "running" &&
        row.runState !== "settling") ||
      (row.attemptState !== "provisioning" &&
        row.attemptState !== "restoring" &&
        row.attemptState !== "running" &&
        row.attemptState !== "settling") ||
      new Date(row.validUntil).valueOf() <= now.valueOf()
    ) {
      throw new WorkspaceSettlementStoreError(
        "stale_session_lease",
        "Settlement operation does not own the current ExecutionLease",
        false,
      );
    }
    return {
      workspaceKey: row.workspaceKey,
      rowVersion: row.rowVersion,
      currentSettlementId: row.currentSettlementId,
    };
  }

  #verifyObject(
    bytes: Uint8Array,
    reference: ArtifactReference,
    maxBytes: number,
    description: string,
  ): void {
    if (
      bytes.byteLength !== reference.sizeBytes ||
      bytes.byteLength > maxBytes ||
      sha256(bytes) !== reference.sha256
    ) {
      throw new WorkspaceSettlementStoreError(
        "settlement_corrupt",
        `${description} settlement failed integrity validation`,
        false,
      );
    }
  }
}
