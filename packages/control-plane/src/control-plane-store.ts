import { createHash, randomUUID } from "node:crypto";
import type { Database } from "@pi-cloud/database";
import {
  DomainModelValidationError,
  PI_CODING_AGENT_REVISION_ID,
  resolveTurnModel,
  type ModelProfile,
  type ModelThinkingLevel,
  type SessionState,
} from "@pi-cloud/domain";
import type {
  AcceptTurnRequest,
  AcceptedTurnCancellationResource,
  AcceptedTurnResource,
  ConversationDetailResource,
  ConversationListResource,
  ConversationWorkspaceBindingResource,
  ConversationTurnState,
  CreateProjectRequest,
  CreateTurnCancellationRequest,
  DevelopmentEnvironmentProfileKey,
  ProjectResource,
  ProjectEnvironmentResource,
  EnvironmentRuntimeSnapshot,
  ModelCatalogResource,
  SessionModelSelection,
  RunResource,
  ExecutionMode,
  SessionResource,
  SessionModelResource,
  WorkspaceSourceResource,
  WorkspaceDeletionResource,
  WorkspaceListResource,
} from "@pi-cloud/protocol";
import {
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
  DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
  canonicalEnvironmentRecipeJson,
  parseEnvironmentRecipe,
  parseEnvironmentValidationReport,
  parseCloudToolCapabilitySnapshot,
} from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { readCanonicalPiTurnTranscripts } from "@pi-cloud/runtime-core/canonical-pi-conversation";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import { loadDelegatedSessionTreeSummaries } from "./delegated-session-projection.ts";
import {
  SUPPORTED_MODEL_CATALOG,
  ensureSelectableModelProfile,
  supportedModel,
  supportedModelSelection,
  supportedSessionModelSelection,
} from "./model-profile-catalog.ts";

export type ControlPlaneStoreOptions = {
  database: Kysely<Database>;
  tenantId: string;
  defaultModelProfileId: string;
  idGenerator?: () => string;
  environmentImageRevision?: string;
  metrics?: PiCloudMetrics;
};

export type ControlPlaneStoreErrorCode =
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "idempotency_conflict"
  | "tenant_quota_exceeded"
  | "capacity_exhausted"
  | "control_plane_misconfigured";

export class ControlPlaneStoreError extends Error {
  readonly code: ControlPlaneStoreErrorCode;

  constructor(code: ControlPlaneStoreErrorCode, message: string) {
    super(message);
    this.name = "ControlPlaneStoreError";
    this.code = code;
  }
}

type AcceptedTurnRow = {
  runId: string;
  mailboxPosition: string;
  turnId: string;
  sessionId: string;
  acceptedAt: Date | string;
  requestSha256: string;
};

type AcceptedTurnCancellationRow = {
  controlRequestId: string;
  targetRunId: string;
  turnId: string;
  sessionId: string;
  acceptedAt: Date | string;
  requestSha256: string;
};

type ConversationLineageNode = {
  sessionId: string;
  parentSessionId: string | null;
  forkTurnId: string | null;
};

type ConversationHistoryRow = {
  originSessionId: string;
  runId: string;
  turnId: string;
  inputKind: string;
  prompt: string | null;
  turnState: ConversationTurnState;
  mailboxPosition: string | null;
  acceptedAt: Date | string;
};

type ModelSnapshotRow = {
  profileId: string;
  provider: string;
  modelId: string;
  defaultThinkingLevel: string;
  allowedThinkingLevels: string[];
  credentialBindingId: string;
  credentialBindingVersion: string;
  profileEnabled: boolean;
  credentialStatus: string;
  credentialProvider: string;
};

type TenantRuntimePolicy = {
  defaultModelProfileId: string;
  maximumProjects: number;
  maximumSessions: number;
};

type AssignedSandboxDomain = {
  id: string;
};

type EnvironmentVersionRow = {
  environmentVersionId: string;
  environmentVersionNumber: number;
  environmentProfileKey: string;
  environmentProfileVersion: string;
  environmentImageRevision: string;
  environmentSpecSha256: string;
  environmentRecipe: unknown;
  environmentRecipeSha256: string;
  environmentState: "pending" | "validated" | "failed";
  environmentActive: boolean;
  environmentCreatedAt: Date | string;
  environmentValidatedAt: Date | string | null;
};

function environmentSnapshot(row: EnvironmentVersionRow): EnvironmentRuntimeSnapshot {
  const recipe = parseEnvironmentRecipe(row.environmentRecipe);
  const recipeSha256 = createHash("sha256")
    .update(canonicalEnvironmentRecipeJson(recipe))
    .digest("hex");
  if (
    row.environmentProfileKey !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY ||
    row.environmentProfileVersion !== DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION ||
    row.environmentSpecSha256 !== DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256 ||
    row.environmentRecipeSha256 !== recipeSha256
  ) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Project environment metadata is invalid",
    );
  }
  return {
    environmentVersionId: row.environmentVersionId,
    versionNumber: row.environmentVersionNumber,
    profileKey: row.environmentProfileKey,
    profileVersion: row.environmentProfileVersion,
    imageRevision: row.environmentImageRevision,
    specSha256: row.environmentSpecSha256,
    recipe,
    recipeSha256: row.environmentRecipeSha256,
  };
}

function workspaceSourceResource(seedKind: string): WorkspaceSourceResource {
  if (seedKind === "empty" || seedKind === "sample_java") {
    return { kind: seedKind, status: "ready" };
  }
  throw new ControlPlaneStoreError("control_plane_misconfigured", "Workspace seed is invalid");
}

function isoTimestamp(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Database returned an invalid timestamp",
    );
  }
  return timestamp.toISOString();
}

function positiveSafeInteger(value: string, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      `${description} must be a positive safe integer`,
    );
  }
  return parsed;
}

function validMachineDirectory(path: string): boolean {
  if (
    path.length < 1 ||
    path.length > 4_096 ||
    !path.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    (path.length > 1 && path.endsWith("/"))
  ) {
    return false;
  }
  return (
    path === "/" ||
    path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

function nonNegativeSafeInteger(value: string | number | bigint, description: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      `${description} must be a non-negative safe integer`,
    );
  }
  return parsed;
}

function isPostgresConstraint(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

const DEFAULT_CANCELLATION_GRACE_PERIOD_MS = 1_000;
const MAX_CONVERSATION_SUMMARIES = 100;
const MAX_DELEGATED_SESSION_SUMMARIES = 500;
const MAX_WORKSPACE_SUMMARIES = 100;
const MAX_CONVERSATION_TURNS = 200;
const MAX_INHERITED_MESSAGES = 10_000;
const TURN_ACCEPTING_SESSION_STATES = new Set<SessionState>([
  "cold",
  "idle",
  "running",
  "cancelling",
]);

function turnRequestFingerprint(request: AcceptTurnRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        inputKind: "prompt",
        prompt: request.prompt,
        thinkingLevel: request.thinkingLevel ?? null,
      }),
    )
    .digest("hex");
}

function cancellationRequestFingerprint(gracePeriodMs: number): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        kind: "turn.cancel",
        reason: "user_request",
        gracePeriodMs,
      }),
    )
    .digest("hex");
}

function parseRequestHash(requestHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(requestHash)) {
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Stored turn command has an invalid request fingerprint",
    );
  }
  return requestHash;
}

function acceptedTurnResource(
  row: AcceptedTurnRow,
  expectedRequestHash: string,
  replayed: boolean,
): AcceptedTurnResource {
  if (parseRequestHash(row.requestSha256) !== expectedRequestHash) {
    throw new ControlPlaneStoreError(
      "idempotency_conflict",
      "Idempotency-Key was already used for a different turn request",
    );
  }
  return {
    runId: row.runId,
    turnId: row.turnId,
    sessionId: row.sessionId,
    mailboxPosition: positiveSafeInteger(row.mailboxPosition, "Mailbox position"),
    state: "queued",
    acceptedAt: isoTimestamp(row.acceptedAt),
    replayed,
  };
}

function acceptedTurnCancellationResource(
  row: AcceptedTurnCancellationRow,
  expectedRequestHash: string,
  replayed: boolean,
): AcceptedTurnCancellationResource {
  if (parseRequestHash(row.requestSha256) !== expectedRequestHash) {
    throw new ControlPlaneStoreError(
      "idempotency_conflict",
      "Idempotency-Key was already used for a different cancellation request",
    );
  }
  return {
    controlRequestId: row.controlRequestId,
    targetRunId: row.targetRunId,
    turnId: row.turnId,
    sessionId: row.sessionId,
    state: "pending",
    acceptedAt: isoTimestamp(row.acceptedAt),
    replayed,
  };
}

export class ControlPlaneStore {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #defaultModelProfileId: string;
  readonly #idGenerator: () => string;
  readonly #environmentImageRevision: string;
  readonly #metrics: PiCloudMetrics | undefined;

  constructor(options: ControlPlaneStoreOptions) {
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#defaultModelProfileId = options.defaultModelProfileId;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#environmentImageRevision = options.environmentImageRevision ?? "development";
    this.#metrics = options.metrics;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(this.#environmentImageRevision)) {
      throw new TypeError("environmentImageRevision is invalid");
    }
  }

  async createProject(input: string | CreateProjectRequest): Promise<ProjectResource> {
    const request: CreateProjectRequest =
      typeof input === "string" ? { name: input, source: { kind: "sample_java" } } : input;
    const source = request.source ?? { kind: "sample_java" as const };
    const projectId = this.#idGenerator();
    const workspaceId = this.#idGenerator();
    const environmentVersionId = this.#idGenerator();
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const policy = await this.#lockTenantPolicy(transaction);
        const projectCount = await transaction
          .selectFrom("projects")
          .select((expression) => expression.fn.countAll<string>().as("count"))
          .where("tenant_id", "=", this.#tenantId)
          .where("deleted_at", "is", null)
          .executeTakeFirstOrThrow();
        if (
          nonNegativeSafeInteger(projectCount.count, "Tenant project count") >=
          policy.maximumProjects
        ) {
          throw new ControlPlaneStoreError(
            "tenant_quota_exceeded",
            "Tenant project quota has been reached",
          );
        }
        const project = await transaction
          .insertInto("projects")
          .values({ id: projectId, tenant_id: this.#tenantId, name: request.name })
          .returning(["id", "name", "created_at"])
          .executeTakeFirstOrThrow();
        const sandboxDomain = await this.#assignSandboxDomain(transaction);
        await transaction
          .insertInto("workspaces")
          .values({
            id: workspaceId,
            tenant_id: this.#tenantId,
            project_id: project.id,
            sandbox_domain_id: sandboxDomain.id,
            seed_kind: source.kind,
          })
          .executeTakeFirstOrThrow();
        const environment = await transaction
          .insertInto("environment_versions")
          .values({
            id: environmentVersionId,
            tenant_id: this.#tenantId,
            project_id: project.id,
            version_number: 1,
            profile_key: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
            profile_version: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
            image_revision: this.#environmentImageRevision,
            spec_sha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
            recipe: sql<Record<string, unknown>>`${JSON.stringify(
              DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
            )}::jsonb`,
            recipe_sha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
            state: "pending",
            active: true,
            validated_at: null,
          })
          .returning(["id", "version_number", "state", "created_at"])
          .executeTakeFirstOrThrow();
        return {
          projectId: project.id,
          workspaceId,
          name: project.name,
          createdAt: isoTimestamp(project.created_at),
          source: workspaceSourceResource(source.kind),
          environment: {
            environmentVersionId: environment.id,
            versionNumber: environment.version_number,
            profileKey: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
            profileVersion: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
            imageRevision: this.#environmentImageRevision,
            specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
            recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
            recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
            state: environment.state,
            active: true,
            createdAt: isoTimestamp(environment.created_at),
          },
        };
      });
    } catch (error) {
      if (isPostgresConstraint(error, "projects_tenant_live_name_unique")) {
        throw new ControlPlaneStoreError("conflict", "A project with this name already exists");
      }
      throw error;
    }
  }

  async #assignSandboxDomain(transaction: Transaction<Database>): Promise<AssignedSandboxDomain> {
    const domain = await transaction
      .selectFrom("sandbox_domains")
      .select(["id", "assigned_workspaces", "maximum_active_sandboxes"])
      .where("state", "=", "active")
      .orderBy(
        sql<number>`(${sql.ref("assigned_workspaces")}::numeric / ${sql.ref("maximum_active_sandboxes")})`,
        "asc",
      )
      .orderBy("id", "asc")
      .limit(1)
      .forUpdate()
      .executeTakeFirst();
    if (domain === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "No active Sandbox Domain is available",
      );
    }
    const updated = await transaction
      .updateTable("sandbox_domains")
      .set({
        assigned_workspaces: sql<string>`${sql.ref("assigned_workspaces")} + 1`,
        updated_at: new Date(),
      })
      .where("id", "=", domain.id)
      .where("state", "=", "active")
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new ControlPlaneStoreError(
        "conflict",
        "Sandbox Domain changed while assigning the Workspace",
      );
    }
    return { id: domain.id };
  }

  async createSession(
    projectId: string,
    workspaceId: string,
    title: string,
    executionMode: ExecutionMode,
    execution: Readonly<{
      sandboxProfileKey?: DevelopmentEnvironmentProfileKey;
      workingDirectory?: string;
      ownerUserId?: string;
      model?: SessionModelSelection;
    }> = {},
  ): Promise<SessionResource> {
    const sessionId = this.#idGenerator();
    const workingDirectory = execution.workingDirectory ?? "/workspace";
    if (!validMachineDirectory(workingDirectory)) {
      throw new ControlPlaneStoreError(
        "invalid_request",
        "Conversation working directory is invalid",
      );
    }
    return this.#database.transaction().execute(async (transaction) => {
      const policy = await this.#lockTenantPolicy(transaction);
      const workspace = await transaction
        .selectFrom("workspaces as workspace")
        .leftJoin(
          "workspace_settlements as current_settlement",
          "current_settlement.id",
          "workspace.current_workspace_settlement_id",
        )
        .leftJoin(
          "artifacts as settlement_artifact",
          "settlement_artifact.id",
          "current_settlement.settlement_artifact_id",
        )
        .leftJoin(
          "runtime_objects as workspace_settlement",
          "workspace_settlement.object_key",
          "settlement_artifact.object_key",
        )
        .select([
          "workspace.id",
          "workspace.project_id",
          "workspace.workspace_kind as workspaceKind",
          "workspace.current_workspace_settlement_id as currentSettlementId",
          "settlement_artifact.object_key as workspaceSettlementKey",
          "workspace_settlement.object_key as durableWorkspaceSettlementKey",
        ])
        .where("workspace.tenant_id", "=", this.#tenantId)
        .where("workspace.project_id", "=", projectId)
        .where("workspace.id", "=", workspaceId)
        .where("workspace.workspace_kind", "in", ["user", "development_environment"])
        .where("workspace.deleted_at", "is", null)
        .forUpdate("workspace")
        .executeTakeFirst();
      if (!workspace) {
        throw new ControlPlaneStoreError("not_found", "Project workspace was not found");
      }
      if (
        (executionMode === "elastic" && workspace.workspaceKind !== "user") ||
        (executionMode === "development_environment" &&
          workspace.workspaceKind !== "development_environment")
      ) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Conversation execution mode does not match the selected storage resource",
        );
      }
      if (
        workspace.currentSettlementId !== null &&
        workspace.durableWorkspaceSettlementKey === null
      ) {
        throw new ControlPlaneStoreError("not_found", "Project workspace was not found");
      }
      const sessionCount = await transaction
        .selectFrom("sessions")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("tenant_id", "=", this.#tenantId)
        .executeTakeFirstOrThrow();
      if (
        nonNegativeSafeInteger(sessionCount.count, "Tenant session count") >= policy.maximumSessions
      ) {
        throw new ControlPlaneStoreError(
          "tenant_quota_exceeded",
          "Tenant session quota has been reached",
        );
      }

      const developmentEnvironment = await transaction
        .selectFrom("development_environments")
        .select(["id", "owner_user_id", "profile_key", "state"])
        .where("tenant_id", "=", this.#tenantId)
        .where("workspace_id", "=", workspace.id)
        .where("state", "!=", "released")
        .orderBy("updated_at", "desc")
        .executeTakeFirst();
      if (executionMode === "development_environment") {
        if (developmentEnvironment === undefined || execution.ownerUserId === undefined) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Cloud development machine is not available",
          );
        }
        if (
          developmentEnvironment.owner_user_id !== execution.ownerUserId ||
          !["running", "paused"].includes(developmentEnvironment.state)
        ) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Cloud development machine is not available to this user",
          );
        }
        if (
          execution.sandboxProfileKey !== undefined &&
          developmentEnvironment.profile_key !== execution.sandboxProfileKey
        ) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Conversation profile does not match its cloud development machine",
          );
        }
      } else if (developmentEnvironment !== undefined) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Elastic conversation cannot use a Workspace attached to a cloud development machine",
        );
      } else if (workingDirectory !== "/workspace") {
        throw new ControlPlaneStoreError(
          "conflict",
          "Elastic conversation working directory must be the Workspace root",
        );
      }
      const environmentProfileKey = developmentEnvironment?.profile_key;
      if (
        environmentProfileKey !== undefined &&
        environmentProfileKey !== "starter" &&
        environmentProfileKey !== "standard" &&
        environmentProfileKey !== "performance"
      ) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Cloud development machine profile is invalid",
        );
      }
      const sandboxProfileKey = environmentProfileKey ?? execution.sandboxProfileKey ?? "standard";

      if (
        execution.model !== undefined &&
        supportedSessionModelSelection(execution.model) === undefined
      ) {
        throw new ControlPlaneStoreError(
          "invalid_request",
          "Session model settings are unsupported",
        );
      }
      const selectedModelProfile =
        execution.model === undefined
          ? undefined
          : await ensureSelectableModelProfile({
              transaction,
              tenantId: this.#tenantId,
              selection: execution.model,
              idGenerator: this.#idGenerator,
              now: new Date(),
            });
      const modelProfileId = selectedModelProfile?.profileId ?? policy.defaultModelProfileId;
      const model = await this.#resolveModelSnapshot(
        transaction,
        modelProfileId,
        execution.model?.thinkingLevel,
        execution.model?.fastMode === true ? "fast" : null,
      );
      const session = await transaction
        .insertInto("sessions")
        .values({
          id: sessionId,
          pi_session_id: sessionId,
          pi_session_lane: "main",
          title,
          tenant_id: this.#tenantId,
          project_id: workspace.project_id,
          workspace_id: workspace.id,
          development_environment_id: developmentEnvironment?.id ?? null,
          desired_model_profile_id: modelProfileId,
          desired_thinking_level: model.thinkingLevel,
          desired_service_tier: model.serviceTier,
          agent_revision_id: PI_CODING_AGENT_REVISION_ID,
          created_by_user_id: execution.ownerUserId ?? null,
          state: "cold",
          execution_mode: executionMode,
          sandbox_profile_key: sandboxProfileKey,
          working_directory: workingDirectory,
          workspace_settlement_key: workspace.workspaceSettlementKey,
          current_workspace_settlement_id: workspace.currentSettlementId,
        })
        .returning([
          "id",
          "title",
          "project_id",
          "workspace_id",
          "development_environment_id",
          "state",
          "execution_mode",
          "sandbox_profile_key",
          "working_directory",
          "created_at",
        ])
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("pi_sessions")
        .values({
          tenant_id: this.#tenantId,
          id: session.id,
          created_at_ms: new Date(session.created_at).valueOf(),
          parent_session_id: null,
          next_seq: 1,
          name: title,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("pi_session_lanes")
        .values({ tenant_id: this.#tenantId, session_id: session.id, lane: "main", leaf_id: null })
        .executeTakeFirstOrThrow();
      return {
        sessionId: session.id,
        title: session.title,
        projectId: session.project_id,
        workspaceId: session.workspace_id,
        ...(session.development_environment_id === null
          ? {}
          : { developmentEnvironmentId: session.development_environment_id }),
        workspaceState: "attached",
        state: "cold",
        executionMode: session.execution_mode,
        sandboxProfileKey: session.sandbox_profile_key,
        workingDirectory: session.working_directory,
        modelProfileId,
        createdAt: isoTimestamp(session.created_at),
      };
    });
  }

  async modelCatalog(): Promise<ModelCatalogResource> {
    const policy = await this.#database
      .selectFrom("tenant_runtime_policies as policy")
      .innerJoin("model_profiles as profile", (join) =>
        join
          .onRef("profile.tenant_id", "=", "policy.tenant_id")
          .onRef("profile.id", "=", "policy.default_model_profile_id"),
      )
      .select(["profile.provider", "profile.model_id as modelId"])
      .where("policy.tenant_id", "=", this.#tenantId)
      .where("policy.enabled", "=", true)
      .executeTakeFirst();
    if (policy === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Tenant model catalog is unavailable",
      );
    }
    const hasConfiguredDefault = SUPPORTED_MODEL_CATALOG.some(
      (model) => model.provider === policy.provider && model.modelId === policy.modelId,
    );
    return {
      models: SUPPORTED_MODEL_CATALOG.map((model, index) => ({
        ...model,
        default:
          (model.provider === policy.provider && model.modelId === policy.modelId) ||
          (!hasConfiguredDefault && index === 0),
      })),
    };
  }

  async getSessionModel(sessionId: string): Promise<SessionModelResource> {
    return this.#sessionModelResource(this.#database, sessionId);
  }

  async updateSessionModel(
    sessionId: string,
    selection: SessionModelSelection,
  ): Promise<SessionModelResource> {
    return this.#database.transaction().execute(async (transaction) => {
      await this.#lockTenantPolicy(transaction);
      const session = await transaction
        .selectFrom("sessions")
        .select(["id", "session_kind as sessionKind"])
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (session === undefined || session.sessionKind !== "conversation") {
        throw new ControlPlaneStoreError("not_found", "Conversation was not found");
      }
      const activeTurn = await transaction
        .selectFrom("turns")
        .select("id")
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sessionId)
        .where("state", "in", ["queued", "running", "cancelling"])
        .limit(1)
        .executeTakeFirst();
      if (activeTurn !== undefined) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Conversation model cannot change while a Run is active",
        );
      }
      if (supportedSessionModelSelection(selection) === undefined) {
        throw new ControlPlaneStoreError(
          "invalid_request",
          "Session model settings are unsupported",
        );
      }
      const profile = await ensureSelectableModelProfile({
        transaction,
        tenantId: this.#tenantId,
        selection,
        idGenerator: this.#idGenerator,
        now: new Date(),
      });
      await transaction
        .updateTable("sessions")
        .set({
          desired_model_profile_id: profile.profileId,
          desired_thinking_level: selection.thinkingLevel,
          desired_service_tier: selection.fastMode ? "fast" : null,
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: new Date(),
        })
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", sessionId)
        .executeTakeFirstOrThrow();
      return this.#sessionModelResource(transaction, sessionId);
    });
  }

  async listWorkspaces(): Promise<WorkspaceListResource> {
    const rows = await this.#database
      .selectFrom("workspaces as workspace")
      .innerJoin("projects as project", (join) =>
        join
          .onRef("project.tenant_id", "=", "workspace.tenant_id")
          .onRef("project.id", "=", "workspace.project_id"),
      )
      .leftJoin(
        "workspace_settlements as current_settlement",
        "current_settlement.id",
        "workspace.current_workspace_settlement_id",
      )
      .leftJoin(
        "artifacts as settlement_artifact",
        "settlement_artifact.id",
        "current_settlement.settlement_artifact_id",
      )
      .leftJoin(
        "runtime_objects as workspace_settlement",
        "workspace_settlement.object_key",
        "settlement_artifact.object_key",
      )
      .leftJoin("sessions as session_row", (join) =>
        join
          .onRef("session_row.tenant_id", "=", "workspace.tenant_id")
          .onRef("session_row.workspace_id", "=", "workspace.id")
          .on("session_row.session_kind", "=", "conversation")
          .on("session_row.archived_at", "is", null),
      )
      .select([
        "workspace.id as workspaceId",
        "workspace.project_id as projectId",
        "project.name as name",
        "project.created_at as createdAt",
      ])
      .select((expression) => [
        expression.fn.count<string>("session_row.id").as("sessionCount"),
        sql<Date>`coalesce(max(${expression.ref("session_row.last_active_at")}), ${expression.ref(
          "project.created_at",
        )})`.as("lastActiveAt"),
      ])
      .where("workspace.tenant_id", "=", this.#tenantId)
      .where("workspace.workspace_kind", "=", "user")
      .where("workspace.deleted_at", "is", null)
      .where((expression) =>
        expression.or([
          expression("workspace.current_workspace_settlement_id", "is", null),
          expression("workspace_settlement.object_key", "is not", null),
        ]),
      )
      .groupBy(["workspace.id", "workspace.project_id", "project.name", "project.created_at"])
      .orderBy("lastActiveAt", "desc")
      .orderBy("workspace.id", "desc")
      .limit(MAX_WORKSPACE_SUMMARIES + 1)
      .execute();
    return {
      workspaces: rows.slice(0, MAX_WORKSPACE_SUMMARIES).map((row) => ({
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        name: row.name,
        sessionCount: nonNegativeSafeInteger(row.sessionCount, "Workspace session count"),
        createdAt: isoTimestamp(row.createdAt),
        lastActiveAt: isoTimestamp(row.lastActiveAt),
      })),
      truncated: rows.length > MAX_WORKSPACE_SUMMARIES,
    };
  }

  async deleteWorkspace(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceDeletionResource> {
    const operationId = this.#idGenerator();
    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const replay = await transaction
          .selectFrom("workspace_delete_operations as operation")
          .innerJoin("workspaces as workspace", (join) =>
            join
              .onRef("workspace.tenant_id", "=", "operation.tenant_id")
              .onRef("workspace.id", "=", "operation.workspace_id"),
          )
          .select([
            "operation.operation_id as operationId",
            "operation.workspace_id as workspaceId",
            "operation.deleted_at as deletedAt",
            "workspace.storage_purged_at as storagePurgedAt",
            "operation.detached_session_count as detachedSessionCount",
          ])
          .where("operation.tenant_id", "=", this.#tenantId)
          .where("operation.workspace_id", "=", workspaceId)
          .where("operation.idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        if (replay !== undefined) {
          return {
            operationId: replay.operationId,
            workspaceId: replay.workspaceId,
            storageState: replay.storagePurgedAt === null ? "pending" : "purged",
            detachedSessionCount: nonNegativeSafeInteger(
              replay.detachedSessionCount,
              "Detached conversation count",
            ),
            replayed: true,
            deletedAt: isoTimestamp(replay.deletedAt),
          };
        }

        const workspace = await transaction
          .selectFrom("workspaces")
          .select(["id", "project_id", "sandbox_domain_id", "deleted_at", "storage_purged_at"])
          .where("tenant_id", "=", this.#tenantId)
          .where("id", "=", workspaceId)
          .where("workspace_kind", "=", "user")
          .forUpdate()
          .executeTakeFirst();
        if (workspace === undefined) {
          throw new ControlPlaneStoreError("not_found", "Workspace was not found");
        }

        let deletedAt = workspace.deleted_at;
        let detachedSessionCount = 0;
        if (deletedAt === null) {
          const activeTurn = await transaction
            .selectFrom("turns as turn")
            .innerJoin("sessions as session_row", (join) =>
              join
                .onRef("session_row.tenant_id", "=", "turn.tenant_id")
                .onRef("session_row.id", "=", "turn.session_id"),
            )
            .select("turn.id")
            .where("turn.tenant_id", "=", this.#tenantId)
            .where("session_row.workspace_id", "=", workspaceId)
            .where("turn.state", "in", ["queued", "running", "cancelling"])
            .limit(1)
            .executeTakeFirst();
          if (activeTurn !== undefined) {
            throw new ControlPlaneStoreError(
              "conflict",
              "Wait for every conversation Run to settle before deleting the Workspace",
            );
          }

          const activeTerminal = await transaction
            .selectFrom("workspace_terminal_sessions")
            .select("terminal_id")
            .where("tenant_id", "=", this.#tenantId)
            .where("workspace_id", "=", workspaceId)
            .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
            .limit(1)
            .executeTakeFirst();
          if (activeTerminal !== undefined) {
            throw new ControlPlaneStoreError(
              "conflict",
              "Close the active Workspace terminal before deleting the Workspace",
            );
          }

          const liveDevelopmentEnvironment = await transaction
            .selectFrom("development_environments")
            .select("id")
            .where("tenant_id", "=", this.#tenantId)
            .where("workspace_id", "=", workspaceId)
            .where("state", "in", [
              "requested",
              "provisioning",
              "running",
              "paused",
              "releasing",
              "unknown",
            ])
            .limit(1)
            .executeTakeFirst();
          if (liveDevelopmentEnvironment !== undefined) {
            throw new ControlPlaneStoreError(
              "conflict",
              "Release the exclusive development environment before deleting the Workspace",
            );
          }

          const activeSubagent = await transaction
            .selectFrom("subagent_executions as execution")
            .innerJoin("sessions as root", (join) =>
              join
                .onRef("root.tenant_id", "=", "execution.tenant_id")
                .onRef("root.id", "=", "execution.root_session_id"),
            )
            .select("execution.id")
            .where("execution.tenant_id", "=", this.#tenantId)
            .where("root.workspace_id", "=", workspaceId)
            .where("execution.state", "in", ["preparing", "queued", "running"])
            .limit(1)
            .executeTakeFirst();
          if (activeSubagent !== undefined) {
            throw new ControlPlaneStoreError(
              "conflict",
              "Wait for delegated work to settle before deleting the Workspace",
            );
          }

          const issueDelivery = await transaction
            .selectFrom("source_control_issue_jobs")
            .select("id")
            .where("tenant_id", "=", this.#tenantId)
            .where("workspace_id", "=", workspaceId)
            .where("state", "not in", ["completed", "failed", "cancelled"])
            .limit(1)
            .executeTakeFirst();
          if (issueDelivery !== undefined) {
            throw new ControlPlaneStoreError(
              "conflict",
              "Wait for Issue delivery to finish before deleting the Workspace",
            );
          }

          const detached = await transaction
            .selectFrom("sessions")
            .select(({ fn }) => fn.countAll<string>().as("count"))
            .where("tenant_id", "=", this.#tenantId)
            .where("workspace_id", "=", workspaceId)
            .where("session_kind", "=", "conversation")
            .where("archived_at", "is", null)
            .executeTakeFirstOrThrow();
          detachedSessionCount = nonNegativeSafeInteger(
            detached.count,
            "Detached conversation count",
          );

          deletedAt = new Date();
          await transaction
            .updateTable("workspaces")
            .set({
              deleted_at: deletedAt,
              updated_at: deletedAt,
              row_version: sql<string>`${sql.ref("row_version")} + 1`,
            })
            .where("tenant_id", "=", this.#tenantId)
            .where("id", "=", workspaceId)
            .where("deleted_at", "is", null)
            .executeTakeFirstOrThrow();
          await transaction
            .updateTable("sandbox_domains")
            .set({
              assigned_workspaces: sql<string>`greatest(${sql.ref("assigned_workspaces")} - 1, 0)`,
              updated_at: deletedAt,
            })
            .where("id", "=", workspace.sandbox_domain_id)
            .executeTakeFirst();

          const remainingWorkspace = await transaction
            .selectFrom("workspaces")
            .select("id")
            .where("tenant_id", "=", this.#tenantId)
            .where("project_id", "=", workspace.project_id)
            .where("deleted_at", "is", null)
            .limit(1)
            .executeTakeFirst();
          if (remainingWorkspace === undefined) {
            await transaction
              .updateTable("projects")
              .set({ deleted_at: deletedAt, updated_at: deletedAt })
              .where("tenant_id", "=", this.#tenantId)
              .where("id", "=", workspace.project_id)
              .where("deleted_at", "is", null)
              .executeTakeFirst();
          }
        }

        await transaction
          .insertInto("workspace_delete_operations")
          .values({
            operation_id: operationId,
            tenant_id: this.#tenantId,
            workspace_id: workspaceId,
            idempotency_key: idempotencyKey,
            deleted_at: deletedAt,
            detached_session_count: detachedSessionCount,
          })
          .executeTakeFirstOrThrow();
        return {
          operationId,
          workspaceId,
          storageState: workspace.storage_purged_at === null ? "pending" : "purged",
          detachedSessionCount,
          replayed: false,
          deletedAt: isoTimestamp(deletedAt),
        };
      });
    } catch (error) {
      if (!isPostgresConstraint(error, "workspace_delete_operations_scope_key_unique")) {
        throw error;
      }
      const replay = await this.#database
        .selectFrom("workspace_delete_operations as operation")
        .innerJoin("workspaces as workspace", (join) =>
          join
            .onRef("workspace.tenant_id", "=", "operation.tenant_id")
            .onRef("workspace.id", "=", "operation.workspace_id"),
        )
        .select([
          "operation.operation_id as operationId",
          "operation.workspace_id as workspaceId",
          "operation.deleted_at as deletedAt",
          "workspace.storage_purged_at as storagePurgedAt",
          "operation.detached_session_count as detachedSessionCount",
        ])
        .where("operation.tenant_id", "=", this.#tenantId)
        .where("operation.workspace_id", "=", workspaceId)
        .where("operation.idempotency_key", "=", idempotencyKey)
        .executeTakeFirstOrThrow();
      return {
        operationId: replay.operationId,
        workspaceId: replay.workspaceId,
        storageState: replay.storagePurgedAt === null ? "pending" : "purged",
        detachedSessionCount: nonNegativeSafeInteger(
          replay.detachedSessionCount,
          "Detached conversation count",
        ),
        replayed: true,
        deletedAt: isoTimestamp(replay.deletedAt),
      };
    }
  }

  async rebindConversationWorkspace(
    sessionId: string,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<ConversationWorkspaceBindingResource> {
    const requestSha256 = createHash("sha256")
      .update("pi-cloud.conversation-workspace-rebind.v1\0", "utf8")
      .update(workspaceId, "utf8")
      .digest("hex");
    const operationId = this.#idGenerator();
    return this.#database.transaction().execute(async (transaction) => {
      const replay = await transaction
        .selectFrom("conversation_workspace_rebind_operations as operation")
        .innerJoin("workspaces as workspace", (join) =>
          join
            .onRef("workspace.tenant_id", "=", "operation.tenant_id")
            .onRef("workspace.id", "=", "operation.to_workspace_id"),
        )
        .innerJoin("projects as project", (join) =>
          join
            .onRef("project.tenant_id", "=", "workspace.tenant_id")
            .onRef("project.id", "=", "workspace.project_id"),
        )
        .select([
          "operation.operation_id as operationId",
          "operation.request_sha256 as requestSha256",
          "operation.session_id as sessionId",
          "operation.to_workspace_id as workspaceId",
          "operation.created_at as boundAt",
          "workspace.project_id as projectId",
          "project.name as workspaceName",
        ])
        .where("operation.tenant_id", "=", this.#tenantId)
        .where("operation.session_id", "=", sessionId)
        .where("operation.idempotency_key", "=", idempotencyKey)
        .executeTakeFirst();
      if (replay !== undefined) {
        if (replay.requestSha256 !== requestSha256) {
          throw new ControlPlaneStoreError(
            "idempotency_conflict",
            "Idempotency-Key was reused for another Workspace binding",
          );
        }
        return {
          operationId: replay.operationId,
          sessionId: replay.sessionId,
          projectId: replay.projectId,
          workspaceId: replay.workspaceId,
          workspaceName: replay.workspaceName,
          workspaceState: "attached",
          replayed: true,
          boundAt: isoTimestamp(replay.boundAt),
        };
      }

      const session = await transaction
        .selectFrom("sessions as session_row")
        .innerJoin("workspaces as current_workspace", (join) =>
          join
            .onRef("current_workspace.tenant_id", "=", "session_row.tenant_id")
            .onRef("current_workspace.id", "=", "session_row.workspace_id"),
        )
        .select([
          "session_row.id",
          "session_row.workspace_id as currentWorkspaceId",
          "session_row.session_kind as sessionKind",
          "session_row.archived_at as archivedAt",
          "current_workspace.deleted_at as workspaceDeletedAt",
        ])
        .where("session_row.tenant_id", "=", this.#tenantId)
        .where("session_row.id", "=", sessionId)
        .forUpdate("session_row")
        .executeTakeFirst();
      if (session === undefined) {
        throw new ControlPlaneStoreError("not_found", "Conversation was not found");
      }
      if (session.sessionKind !== "conversation" || session.archivedAt !== null) {
        throw new ControlPlaneStoreError("conflict", "Conversation cannot change Workspace");
      }
      if (session.workspaceDeletedAt === null) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Conversation Workspace is still available and does not need rebinding",
        );
      }
      const activeTurn = await transaction
        .selectFrom("turns")
        .select("id")
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sessionId)
        .where("state", "in", ["queued", "running", "cancelling"])
        .limit(1)
        .executeTakeFirst();
      if (activeTurn !== undefined) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Wait for the active Run to settle before rebinding the Workspace",
        );
      }
      const target = await transaction
        .selectFrom("workspaces as workspace")
        .innerJoin("projects as project", (join) =>
          join
            .onRef("project.tenant_id", "=", "workspace.tenant_id")
            .onRef("project.id", "=", "workspace.project_id"),
        )
        .select([
          "workspace.id",
          "workspace.project_id as projectId",
          "workspace.current_workspace_settlement_id as currentSettlementId",
          "project.name as workspaceName",
        ])
        .where("workspace.tenant_id", "=", this.#tenantId)
        .where("workspace.id", "=", workspaceId)
        .where("workspace.workspace_kind", "=", "user")
        .where("workspace.deleted_at", "is", null)
        .where("project.deleted_at", "is", null)
        .forUpdate("workspace")
        .executeTakeFirst();
      if (target === undefined) {
        throw new ControlPlaneStoreError("not_found", "Target Workspace was not found");
      }
      const conflictingPersistentSession = await transaction
        .selectFrom("sessions")
        .select("id")
        .where("tenant_id", "=", this.#tenantId)
        .where("workspace_id", "=", workspaceId)
        .where("archived_at", "is", null)
        .where("execution_mode", "=", "development_environment")
        .limit(1)
        .executeTakeFirst();
      if (conflictingPersistentSession !== undefined) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Target Workspace is reserved by an exclusive execution environment",
        );
      }

      const boundAt = new Date();
      await transaction
        .updateTable("sessions")
        .set({
          project_id: target.projectId,
          workspace_id: target.id,
          current_workspace_settlement_id: target.currentSettlementId,
          workspace_settlement_key: null,
          execution_mode: "elastic",
          development_environment_id: null,
          working_directory: "/workspace",
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: boundAt,
        })
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", sessionId)
        .where("workspace_id", "=", session.currentWorkspaceId)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("conversation_workspace_rebind_operations")
        .values({
          operation_id: operationId,
          tenant_id: this.#tenantId,
          session_id: sessionId,
          from_workspace_id: session.currentWorkspaceId,
          to_workspace_id: target.id,
          idempotency_key: idempotencyKey,
          request_sha256: requestSha256,
          created_at: boundAt,
        })
        .executeTakeFirstOrThrow();
      return {
        operationId,
        sessionId,
        projectId: target.projectId,
        workspaceId: target.id,
        workspaceName: target.workspaceName,
        workspaceState: "attached",
        replayed: false,
        boundAt: boundAt.toISOString(),
      };
    });
  }

  async listConversations(): Promise<ConversationListResource> {
    const rows = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("projects as project", (join) =>
        join
          .onRef("project.tenant_id", "=", "session_row.tenant_id")
          .onRef("project.id", "=", "session_row.project_id"),
      )
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace.id", "=", "session_row.workspace_id"),
      )
      .leftJoin("turns as turn", (join) =>
        join
          .onRef("turn.tenant_id", "=", "session_row.tenant_id")
          .onRef("turn.session_id", "=", "session_row.id")
          .on("turn.pruned_at", "is", null),
      )
      .select([
        "session_row.id as sessionId",
        "session_row.title as title",
        "session_row.project_id as projectId",
        "session_row.workspace_id as workspaceId",
        "session_row.development_environment_id as developmentEnvironmentId",
        "session_row.state as state",
        "session_row.execution_mode as executionMode",
        "session_row.sandbox_profile_key as sandboxProfileKey",
        "session_row.working_directory as workingDirectory",
        "session_row.created_at as createdAt",
        "session_row.updated_at as updatedAt",
        "session_row.last_active_at as lastActiveAt",
        "session_row.conversation_parent_session_id as parentSessionId",
        "project.name as workspaceName",
        "workspace.deleted_at as workspaceDeletedAt",
      ])
      .select((expression) => expression.fn.count<string>("turn.id").as("turnCount"))
      .where("session_row.tenant_id", "=", this.#tenantId)
      .where("session_row.session_kind", "=", "conversation")
      .where("session_row.archived_at", "is", null)
      .groupBy([
        "session_row.id",
        "session_row.title",
        "session_row.project_id",
        "session_row.workspace_id",
        "session_row.development_environment_id",
        "session_row.state",
        "session_row.execution_mode",
        "session_row.sandbox_profile_key",
        "session_row.working_directory",
        "session_row.created_at",
        "session_row.updated_at",
        "session_row.last_active_at",
        "session_row.conversation_parent_session_id",
        "project.name",
        "workspace.deleted_at",
      ])
      .orderBy("session_row.last_active_at", "desc")
      .orderBy("session_row.id", "desc")
      .limit(MAX_CONVERSATION_SUMMARIES + 1)
      .execute();
    const visibleRows = rows.slice(0, MAX_CONVERSATION_SUMMARIES);
    const delegated = await loadDelegatedSessionTreeSummaries(this.#database, {
      tenantId: this.#tenantId,
      rootParentSessionIds: visibleRows.map((row) => row.sessionId),
      maximum: MAX_DELEGATED_SESSION_SUMMARIES,
    });
    return {
      conversations: visibleRows.map((row) => ({
        sessionId: row.sessionId,
        title: row.title,
        projectId: row.projectId,
        workspaceId: row.workspaceId,
        ...(row.developmentEnvironmentId === null
          ? {}
          : { developmentEnvironmentId: row.developmentEnvironmentId }),
        workspaceName: row.workspaceName,
        workspaceState: row.workspaceDeletedAt === null ? "attached" : "missing",
        state: row.state,
        executionMode: row.executionMode,
        sandboxProfileKey: row.sandboxProfileKey,
        workingDirectory: row.workingDirectory,
        turnCount: nonNegativeSafeInteger(row.turnCount, "Conversation turn count"),
        createdAt: isoTimestamp(row.createdAt),
        updatedAt: isoTimestamp(row.updatedAt),
        lastActiveAt: isoTimestamp(row.lastActiveAt),
        ...(row.parentSessionId === null ? {} : { parentSessionId: row.parentSessionId }),
      })),
      delegatedSessions: delegated.items,
      truncated: rows.length > MAX_CONVERSATION_SUMMARIES || delegated.truncated,
    };
  }

  async getConversation(sessionId: string): Promise<ConversationDetailResource> {
    return (await this.getConversationView(sessionId)).conversation;
  }

  async getConversationView(sessionId: string): Promise<{
    conversation: ConversationDetailResource;
    canonicalThroughSequence: number;
  }> {
    return this.#database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((transaction) => {
        const reader = new ControlPlaneStore({
          database: transaction,
          tenantId: this.#tenantId,
          defaultModelProfileId: this.#defaultModelProfileId,
          environmentImageRevision: this.#environmentImageRevision,
        });
        return reader.#readConversation(sessionId);
      });
  }

  async #readConversation(sessionId: string): Promise<{
    conversation: ConversationDetailResource;
    canonicalThroughSequence: number;
  }> {
    const conversation = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("projects as project", (join) =>
        join
          .onRef("project.tenant_id", "=", "session_row.tenant_id")
          .onRef("project.id", "=", "session_row.project_id"),
      )
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace.id", "=", "session_row.workspace_id"),
      )
      .select([
        "session_row.id as sessionId",
        "session_row.session_kind as sessionKind",
        "session_row.title as sessionTitle",
        "session_row.project_id as projectId",
        "session_row.workspace_id as workspaceId",
        "session_row.development_environment_id as developmentEnvironmentId",
        "session_row.desired_model_profile_id as modelProfileId",
        "session_row.state as sessionState",
        "session_row.execution_mode as executionMode",
        "session_row.sandbox_profile_key as sandboxProfileKey",
        "session_row.working_directory as workingDirectory",
        "session_row.created_at as sessionCreatedAt",
        "session_row.updated_at as sessionUpdatedAt",
        "session_row.last_active_at as lastActiveAt",
        "session_row.conversation_parent_session_id as parentSessionId",
        "project.name as projectName",
        "project.created_at as projectCreatedAt",
        "workspace.deleted_at as workspaceDeletedAt",
        "workspace.seed_kind as workspaceSeedKind",
        "session_row.next_event_seq as nextEventSequence",
      ])
      .where("session_row.tenant_id", "=", this.#tenantId)
      .where("session_row.id", "=", sessionId)
      .where("session_row.archived_at", "is", null)
      .executeTakeFirst();
    if (conversation === undefined) {
      throw new ControlPlaneStoreError("not_found", "Conversation was not found");
    }

    const lineage =
      conversation.sessionKind === "conversation"
        ? await this.#conversationLineage(sessionId)
        : [{ sessionId, parentSessionId: null, forkTurnId: null }];
    const lineageTurnRows: ConversationHistoryRow[] = [];
    for (let index = 0; index < lineage.length; index += 1) {
      const node = lineage[index]!;
      const child = lineage[index + 1];
      const forkMailboxPosition =
        child?.forkTurnId === null || child?.forkTurnId === undefined
          ? null
          : await this.#database
              .selectFrom("runs")
              .select("mailbox_position")
              .where("tenant_id", "=", this.#tenantId)
              .where("session_id", "=", node.sessionId)
              .where("turn_id", "=", child.forkTurnId)
              .executeTakeFirst();
      if (
        child?.forkTurnId !== null &&
        child?.forkTurnId !== undefined &&
        forkMailboxPosition === undefined
      ) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Conversation fork Turn is missing from its parent Session",
        );
      }
      const newestRows = await this.#database
        .selectFrom("runs as run")
        .innerJoin("turns as turn", (join) =>
          join.onRef("turn.tenant_id", "=", "run.tenant_id").onRef("turn.id", "=", "run.turn_id"),
        )
        .select([
          "run.session_id as originSessionId",
          "run.id as runId",
          "turn.id as turnId",
          "turn.input_kind as inputKind",
          "turn.input_text as prompt",
          "turn.state as turnState",
          "run.mailbox_position as mailboxPosition",
          "run.created_at as acceptedAt",
        ])
        .where("run.tenant_id", "=", this.#tenantId)
        .where("run.session_id", "=", node.sessionId)
        .where("turn.pruned_at", "is", null)
        .where("run.mailbox_position", "is not", null)
        .$if(forkMailboxPosition !== null && forkMailboxPosition !== undefined, (query) =>
          query.where("run.mailbox_position", "<=", forkMailboxPosition!.mailbox_position!),
        )
        .orderBy("run.mailbox_position", "desc")
        .orderBy("run.id", "desc")
        .limit(MAX_CONVERSATION_TURNS + 1)
        .execute();
      lineageTurnRows.push(...newestRows.reverse());
    }
    const historyTruncated = lineageTurnRows.length > MAX_CONVERSATION_TURNS;
    const includedRows = lineageTurnRows.slice(-MAX_CONVERSATION_TURNS);
    const terminalTurnIds = includedRows
      .filter(
        (row) =>
          row.turnState === "completed" ||
          row.turnState === "failed" ||
          row.turnState === "cancelled",
      )
      .map((row) => row.turnId);
    const transcriptByTurnId = await readCanonicalPiTurnTranscripts(this.#database, {
      tenantId: this.#tenantId,
      turnIds: terminalTurnIds,
    });
    const turns = includedRows.map((row) => {
      if (row.inputKind !== "prompt" || row.prompt === null || row.mailboxPosition === null) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Conversation contains an invalid prompt turn",
        );
      }
      return {
        runId: row.runId,
        turnId: row.turnId,
        mailboxPosition: positiveSafeInteger(row.mailboxPosition, "Conversation mailbox position"),
        prompt: row.prompt,
        state: row.turnState,
        ...(transcriptByTurnId.has(row.turnId)
          ? { transcript: transcriptByTurnId.get(row.turnId)! }
          : {}),
        acceptedAt: isoTimestamp(row.acceptedAt),
        originSessionId: row.originSessionId,
      };
    });

    const canonicalThroughSequence =
      nonNegativeSafeInteger(conversation.nextEventSequence, "Conversation next event sequence") -
      1;
    const environment = await this.#loadActiveProjectEnvironment(conversation.projectId);
    const inheritedMessages =
      conversation.sessionKind === "subagent"
        ? await this.#delegatedInheritedMessages(sessionId)
        : [];
    return {
      canonicalThroughSequence,
      conversation: {
        project: {
          projectId: conversation.projectId,
          workspaceId: conversation.workspaceId,
          name: conversation.projectName,
          createdAt: isoTimestamp(conversation.projectCreatedAt),
          source: workspaceSourceResource(conversation.workspaceSeedKind),
          environment,
        },
        session: {
          sessionId: conversation.sessionId,
          title: conversation.sessionTitle,
          projectId: conversation.projectId,
          workspaceId: conversation.workspaceId,
          ...(conversation.developmentEnvironmentId === null
            ? {}
            : { developmentEnvironmentId: conversation.developmentEnvironmentId }),
          workspaceState: conversation.workspaceDeletedAt === null ? "attached" : "missing",
          state: conversation.sessionState,
          executionMode: conversation.executionMode,
          sandboxProfileKey: conversation.sandboxProfileKey,
          workingDirectory: conversation.workingDirectory,
          modelProfileId: conversation.modelProfileId,
          createdAt: isoTimestamp(conversation.sessionCreatedAt),
          updatedAt: isoTimestamp(conversation.sessionUpdatedAt),
          lastActiveAt: isoTimestamp(conversation.lastActiveAt),
          ...(conversation.parentSessionId === null
            ? {}
            : { parentSessionId: conversation.parentSessionId }),
        },
        inheritedMessages,
        turns,
        historyTruncated,
      },
    };
  }

  async #delegatedInheritedMessages(
    sessionId: string,
  ): Promise<ConversationDetailResource["inheritedMessages"]> {
    const execution = await this.#database
      .selectFrom("subagent_executions as execution")
      .innerJoin("sessions as child", (join) =>
        join
          .onRef("child.tenant_id", "=", "execution.tenant_id")
          .onRef("child.id", "=", "execution.child_session_id"),
      )
      .select([
        "execution.context_mode as contextMode",
        "execution.pi_context_base_entry_id as contextBaseEntryId",
        "child.pi_session_id as piSessionId",
      ])
      .where("tenant_id", "=", this.#tenantId)
      .where("child_session_id", "=", sessionId)
      .executeTakeFirst();
    if (execution === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Delegated Session has no execution record",
      );
    }
    if (execution.contextMode !== "branch") return [];
    if (execution.contextBaseEntryId === null) return [];
    const rows = (
      await sql<{ id: string; timestampMs: string; payload: Record<string, unknown> }>`
        with recursive branch as (
          select id, parent_id, seq, type, timestamp_ms, payload
            from pi_session_visible_entries
           where tenant_id = ${this.#tenantId}::uuid
             and session_id = ${execution.piSessionId}
             and id = ${execution.contextBaseEntryId}
          union all
          select parent.id,
                 parent.parent_id,
                 parent.seq,
                 parent.type,
                 parent.timestamp_ms,
                 parent.payload
            from pi_session_visible_entries parent
            join branch child on child.parent_id = parent.id
           where parent.tenant_id = ${this.#tenantId}::uuid
             and parent.session_id = ${execution.piSessionId}
        )
        select id, timestamp_ms as "timestampMs", payload
         from branch
         where type = 'message'
         order by seq asc
         limit ${MAX_INHERITED_MESSAGES + 1}
      `.execute(this.#database)
    ).rows;
    if (rows.length > MAX_INHERITED_MESSAGES) {
      throw new ControlPlaneStoreError("invalid_request", "Inherited conversation is too large");
    }
    return rows.flatMap((row) => {
      const message = row.payload.message;
      if (typeof message !== "object" || message === null || Array.isArray(message)) return [];
      const candidate = message as Record<string, unknown>;
      if (candidate.role !== "user" && candidate.role !== "assistant") return [];
      if (
        candidate.role === "assistant" &&
        (typeof candidate.stopReason !== "string" ||
          ["toolUse", "error", "aborted", "pending"].includes(candidate.stopReason))
      ) {
        return [];
      }
      const text =
        typeof candidate.content === "string"
          ? candidate.content
          : Array.isArray(candidate.content)
            ? candidate.content
                .flatMap((part) => {
                  if (typeof part !== "object" || part === null || Array.isArray(part)) return [];
                  const content = part as Record<string, unknown>;
                  return content.type === "text" && typeof content.text === "string"
                    ? [content.text]
                    : [];
                })
                .join("\n")
            : "";
      if (text.length === 0) return [];
      const createdAt = new Date(Number(row.timestampMs));
      if (Number.isNaN(createdAt.valueOf())) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Inherited Pi message timestamp is invalid",
        );
      }
      return [
        {
          entryId: row.id,
          role: candidate.role,
          text,
          createdAt: createdAt.toISOString(),
        },
      ];
    });
  }

  async #conversationLineage(sessionId: string): Promise<ConversationLineageNode[]> {
    const lineage: ConversationLineageNode[] = [];
    const seen = new Set<string>();
    let cursor: string | null = sessionId;
    while (cursor !== null) {
      if (seen.has(cursor) || lineage.length >= 100) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Conversation lineage is invalid or too deep",
        );
      }
      seen.add(cursor);
      const row = await this.#database
        .selectFrom("sessions")
        .select([
          "id as sessionId",
          "conversation_parent_session_id as parentSessionId",
          "conversation_fork_turn_id as forkTurnId",
        ])
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", cursor)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      if (row === undefined) {
        throw new ControlPlaneStoreError("not_found", "Conversation was not found");
      }
      lineage.push(row);
      cursor = row.parentSessionId;
    }
    return lineage.reverse();
  }

  async getRun(runId: string): Promise<RunResource> {
    return this.#loadRunResource(runId);
  }

  async acceptTurn(
    sessionId: string,
    idempotencyKey: string,
    request: AcceptTurnRequest,
  ): Promise<AcceptedTurnResource> {
    const startedAt = performance.now();
    let outcome = "accepted";
    try {
      const fingerprint = turnRequestFingerprint(request);
      try {
        return await this.#acceptNewTurn(sessionId, idempotencyKey, request, fingerprint);
      } catch (error) {
        if (!isPostgresConstraint(error, "runs_session_idempotency_unique")) {
          throw error;
        }
        const concurrentWinner = await this.#findAcceptedTurn(sessionId, idempotencyKey);
        if (!concurrentWinner) {
          throw new ControlPlaneStoreError(
            "control_plane_misconfigured",
            "Idempotent Run exists without its accepted Turn",
          );
        }
        outcome = "replayed";
        return acceptedTurnResource(concurrentWinner, fingerprint, true);
      }
    } catch (error) {
      outcome = error instanceof ControlPlaneStoreError ? error.code : "failed";
      throw error;
    } finally {
      this.#metrics?.turnAdmissionDuration
        .labels(outcome)
        .observe((performance.now() - startedAt) / 1_000);
    }
  }

  async #loadRunResource(runId: string): Promise<RunResource> {
    const run = await this.#database
      .selectFrom("runs as run")
      .innerJoin("environment_versions as environment", (join) =>
        join
          .onRef("environment.tenant_id", "=", "run.tenant_id")
          .onRef("environment.project_id", "=", "run.project_id")
          .onRef("environment.id", "=", "run.environment_version_id"),
      )
      .selectAll("run")
      .select([
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "environment.state as environmentState",
        "environment.active as environmentActive",
        "environment.created_at as environmentCreatedAt",
        "environment.validated_at as environmentValidatedAt",
      ])
      .where("run.tenant_id", "=", this.#tenantId)
      .where("run.id", "=", runId)
      .executeTakeFirst();
    if (run === undefined) throw new ControlPlaneStoreError("not_found", "Run was not found");

    const attempts = await this.#database
      .selectFrom("run_attempts")
      .selectAll()
      .where("tenant_id", "=", this.#tenantId)
      .where("run_id", "=", run.id)
      .orderBy("attempt_number", "asc")
      .limit(32)
      .execute();
    const transitions = await this.#database
      .selectFrom("run_attempt_transitions")
      .select(["id", "attempt_id", "from_state", "to_state", "reason", "occurred_at"])
      .where("tenant_id", "=", this.#tenantId)
      .where("run_id", "=", run.id)
      .orderBy("occurred_at", "asc")
      .orderBy("id", "asc")
      .execute();
    const optionalTimestamp = (value: Date | string | null): string | undefined =>
      value === null ? undefined : isoTimestamp(value);
    const transitionRank: Record<string, number> = {
      claimed: 1,
      provisioning: 2,
      restoring: 3,
      running: 4,
      settling: 5,
      cancel_requested: 6,
      completed: 7,
      failed: 7,
      cancelled: 7,
      timed_out: 7,
      superseded: 7,
    };
    const failure = (
      code: string | null,
      message: string | null,
      retryable: boolean | null,
    ): { code: string; message?: string; retryable: boolean } | undefined => {
      if (code === null && message === null && retryable === null) return undefined;
      if (code === null || retryable === null) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Run failure metadata is incomplete",
        );
      }
      return { code, ...(message === null ? {} : { message }), retryable };
    };

    return {
      runId: run.id,
      projectId: run.project_id,
      workspaceId: run.workspace_id,
      sessionId: run.session_id,
      turnId: run.turn_id,
      environment: environmentSnapshot(run),
      state: run.state,
      traceId: run.trace_id,
      attemptCount: nonNegativeSafeInteger(run.attempt_count, "Run attempt count"),
      ...(run.current_attempt_id === null ? {} : { currentAttemptId: run.current_attempt_id }),
      ...(run.stop_reason === null ? {} : { stopReason: run.stop_reason }),
      ...(failure(run.failure_code, run.failure_message, run.failure_retryable) === undefined
        ? {}
        : { failure: failure(run.failure_code, run.failure_message, run.failure_retryable)! }),
      queuedAt: isoTimestamp(run.queued_at),
      ...(optionalTimestamp(run.started_at) === undefined
        ? {}
        : { startedAt: optionalTimestamp(run.started_at)! }),
      ...(optionalTimestamp(run.settled_at) === undefined
        ? {}
        : { settledAt: optionalTimestamp(run.settled_at)! }),
      updatedAt: isoTimestamp(run.updated_at),
      attempts: attempts.map((attempt, index) => {
        const attemptFailure = failure(
          attempt.failure_code,
          attempt.failure_message,
          attempt.failure_retryable,
        );
        return {
          attemptId: attempt.id,
          attemptNumber: positiveSafeInteger(String(attempt.attempt_number), "Run attempt number"),
          state: attempt.state,
          projection: attempt.id === run.current_attempt_id ? "canonical" : "superseded",
          ...(attempt.id === run.current_attempt_id || attempts[index + 1] === undefined
            ? {}
            : { supersededByAttemptId: attempts[index + 1]!.id }),
          claimOwnerId: attempt.claim_owner_id,
          claimExpiresAt: isoTimestamp(attempt.claim_expires_at),
          ...(attempt.sandbox_id === null ? {} : { sandboxId: attempt.sandbox_id }),
          ...(attempt.settlement_revision === null
            ? {}
            : { settlementRevision: attempt.settlement_revision }),
          ...(attemptFailure === undefined ? {} : { failure: attemptFailure }),
          claimedAt: isoTimestamp(attempt.claimed_at),
          ...(optionalTimestamp(attempt.provisioning_at) === undefined
            ? {}
            : { provisioningAt: optionalTimestamp(attempt.provisioning_at)! }),
          ...(optionalTimestamp(attempt.restoring_at) === undefined
            ? {}
            : { restoringAt: optionalTimestamp(attempt.restoring_at)! }),
          ...(optionalTimestamp(attempt.running_at) === undefined
            ? {}
            : { runningAt: optionalTimestamp(attempt.running_at)! }),
          ...(optionalTimestamp(attempt.settling_at) === undefined
            ? {}
            : { settlingAt: optionalTimestamp(attempt.settling_at)! }),
          ...(optionalTimestamp(attempt.last_heartbeat_at) === undefined
            ? {}
            : { lastHeartbeatAt: optionalTimestamp(attempt.last_heartbeat_at)! }),
          ...(optionalTimestamp(attempt.settled_at) === undefined
            ? {}
            : { settledAt: optionalTimestamp(attempt.settled_at)! }),
          transitions: transitions
            .filter((transition) => transition.attempt_id === attempt.id)
            .sort((left, right) => {
              const rank = transitionRank[left.to_state]! - transitionRank[right.to_state]!;
              if (rank !== 0) return rank;
              const time =
                new Date(left.occurred_at).valueOf() - new Date(right.occurred_at).valueOf();
              return time !== 0 ? time : left.id.localeCompare(right.id);
            })
            .map((transition) => ({
              fromState: transition.from_state,
              toState: transition.to_state,
              reason: transition.reason,
              occurredAt: isoTimestamp(transition.occurred_at),
            })),
        };
      }),
    };
  }

  async acceptTurnCancellation(
    sessionId: string,
    turnId: string,
    idempotencyKey: string,
    request: CreateTurnCancellationRequest,
  ): Promise<AcceptedTurnCancellationResource> {
    const gracePeriodMs = request.gracePeriodMs ?? DEFAULT_CANCELLATION_GRACE_PERIOD_MS;
    const fingerprint = cancellationRequestFingerprint(gracePeriodMs);
    const existing = await this.#findAcceptedTurnCancellation(sessionId, idempotencyKey);
    if (existing !== undefined) {
      if (existing.turnId !== turnId) {
        throw new ControlPlaneStoreError(
          "idempotency_conflict",
          "Idempotency-Key was already used for a different cancellation request",
        );
      }
      return acceptedTurnCancellationResource(existing, fingerprint, true);
    }
    try {
      return await this.#acceptNewTurnCancellation(
        sessionId,
        turnId,
        idempotencyKey,
        gracePeriodMs,
        fingerprint,
      );
    } catch (error) {
      if (!isPostgresConstraint(error, "turn_control_requests_session_idempotency_unique")) {
        throw error;
      }
      const concurrentWinner = await this.#findAcceptedTurnCancellation(sessionId, idempotencyKey);
      if (concurrentWinner === undefined || concurrentWinner.turnId !== turnId) {
        throw new ControlPlaneStoreError(
          "idempotency_conflict",
          "Idempotency-Key was already used for a different control request",
        );
      }
      return acceptedTurnCancellationResource(concurrentWinner, fingerprint, true);
    }
  }

  async #acceptNewTurn(
    sessionId: string,
    idempotencyKey: string,
    request: AcceptTurnRequest,
    fingerprint: string,
    validation?: { environmentVersionId: string; actorUserId: string },
  ): Promise<AcceptedTurnResource> {
    const turnId = this.#idGenerator();
    const runId = this.#idGenerator();
    return this.#database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("sessions as session_row")
        .leftJoin("runs as replay_run", (join) =>
          join
            .onRef("replay_run.tenant_id", "=", "session_row.tenant_id")
            .onRef("replay_run.session_id", "=", "session_row.id")
            .on("replay_run.idempotency_key", "=", idempotencyKey),
        )
        .select([
          "session_row.id",
          "session_row.project_id",
          "session_row.workspace_id",
          "session_row.desired_model_profile_id",
          "session_row.desired_thinking_level",
          "session_row.desired_service_tier",
          "session_row.agent_revision_id",
          "session_row.session_kind",
          "session_row.state",
          "session_row.execution_mode",
          "session_row.development_environment_id",
          "session_row.working_directory",
          "session_row.sandbox_profile_key",
          "session_row.next_event_seq",
          "session_row.next_mailbox_position",
          "session_row.current_workspace_settlement_id",
          "session_row.workspace_settlement_key",
          "session_row.forked_from_session_id",
          "session_row.tool_capabilities",
          "session_row.archived_at",
          "replay_run.id as replayRunId",
          "replay_run.turn_id as replayTurnId",
          "replay_run.mailbox_position as replayMailboxPosition",
          "replay_run.created_at as replayAcceptedAt",
          "replay_run.request_sha256 as replayRequestSha256",
        ])
        .where("session_row.tenant_id", "=", this.#tenantId)
        .where("session_row.id", "=", sessionId)
        .forUpdate("session_row")
        .executeTakeFirst();
      if (!session) {
        throw new ControlPlaneStoreError("not_found", "Session was not found");
      }
      if (session.session_kind !== "conversation") {
        throw new ControlPlaneStoreError(
          "conflict",
          "Delegated Sessions are read-only from the human conversation API",
        );
      }
      if (session.replayRunId !== null) {
        if (
          session.replayTurnId === null ||
          session.replayMailboxPosition === null ||
          session.replayAcceptedAt === null ||
          session.replayRequestSha256 === null
        ) {
          throw new ControlPlaneStoreError(
            "control_plane_misconfigured",
            "Idempotent Run metadata is incomplete",
          );
        }
        return acceptedTurnResource(
          {
            runId: session.replayRunId,
            turnId: session.replayTurnId,
            sessionId: session.id,
            mailboxPosition: session.replayMailboxPosition,
            acceptedAt: session.replayAcceptedAt,
            requestSha256: session.replayRequestSha256,
          },
          fingerprint,
          true,
        );
      }
      const workspace = await transaction
        .selectFrom("workspaces as workspace")
        .leftJoin(
          "workspace_settlements as current_settlement",
          "current_settlement.id",
          "workspace.current_workspace_settlement_id",
        )
        .leftJoin(
          "artifacts as settlement_artifact",
          "settlement_artifact.id",
          "current_settlement.settlement_artifact_id",
        )
        .select([
          "workspace.current_workspace_settlement_id as currentSettlementId",
          "settlement_artifact.object_key as workspaceSettlementKey",
        ])
        .where("workspace.tenant_id", "=", this.#tenantId)
        .where("workspace.id", "=", session.workspace_id)
        .where("workspace.deleted_at", "is", null)
        .executeTakeFirst();
      if (workspace === undefined) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Conversation Workspace is no longer available; choose a new Workspace to continue",
        );
      }
      if (session.archived_at !== null) {
        throw new ControlPlaneStoreError("conflict", "Archived Session cannot accept turns");
      }
      if (session.execution_mode === "development_environment") {
        if (session.development_environment_id === null) {
          throw new ControlPlaneStoreError(
            "control_plane_misconfigured",
            "Development-machine Session has no environment identity",
          );
        }
        const developmentEnvironment = await transaction
          .selectFrom("development_environments")
          .select("state")
          .where("tenant_id", "=", this.#tenantId)
          .where("id", "=", session.development_environment_id)
          .where("workspace_id", "=", session.workspace_id)
          .executeTakeFirst();
        if (developmentEnvironment?.state !== "running") {
          throw new ControlPlaneStoreError(
            "conflict",
            "Resume the development machine before sending a message",
          );
        }
      }
      const workspaceBaseSettlementId =
        session.forked_from_session_id === null
          ? workspace.currentSettlementId
          : session.current_workspace_settlement_id;
      const workspaceSettlementKey =
        session.forked_from_session_id === null
          ? workspace.workspaceSettlementKey
          : session.workspace_settlement_key;
      if (workspaceSettlementKey !== null) {
        const durableWorkspaceSettlement = await transaction
          .selectFrom("runtime_objects")
          .select("object_key")
          .where("object_key", "=", workspaceSettlementKey)
          .executeTakeFirst();
        if (durableWorkspaceSettlement === undefined) {
          throw new ControlPlaneStoreError(
            "conflict",
            "Workspace settlement is unavailable; create a new Workspace",
          );
        }
      }
      if (!TURN_ACCEPTING_SESSION_STATES.has(session.state)) {
        throw new ControlPlaneStoreError(
          "conflict",
          `Session cannot accept a queued follow-up while it is ${session.state}`,
        );
      }
      const mailboxPosition = positiveSafeInteger(
        session.next_mailbox_position,
        "Next mailbox position",
      );
      const model = await this.#resolveModelSnapshot(
        transaction,
        session.desired_model_profile_id,
        request.thinkingLevel ?? (session.desired_thinking_level as ModelThinkingLevel),
        session.desired_service_tier,
      );
      let toolCapabilities;
      try {
        toolCapabilities = parseCloudToolCapabilitySnapshot(session.tool_capabilities);
      } catch {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Session Tool grant is invalid",
        );
      }
      const environment =
        validation === undefined
          ? await this.#activeEnvironmentForRun(transaction, session.project_id)
          : await this.#environmentVersionForValidation(
              transaction,
              session.project_id,
              validation.environmentVersionId,
            );
      await transaction
        .insertInto("turns")
        .values({
          id: turnId,
          tenant_id: this.#tenantId,
          session_id: session.id,
          state: "queued",
          input_kind: "prompt",
          input_text: request.prompt,
          model_profile_id: model.profileId,
          provider: model.provider,
          model_id: model.modelId,
          thinking_level: model.thinkingLevel,
          service_tier: model.serviceTier,
          credential_binding_id: model.credentialBindingId,
          credential_binding_version: model.credentialBindingVersion,
          stop_reason: null,
          failure_code: null,
          failure_message: null,
          failure_retryable: null,
        })
        .executeTakeFirstOrThrow();

      if (validation !== undefined) {
        const active = await transaction
          .selectFrom("environment_versions")
          .select("id")
          .where("tenant_id", "=", this.#tenantId)
          .where("project_id", "=", session.project_id)
          .where("active", "=", true)
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("environment_operations")
          .values({
            id: this.#idGenerator(),
            tenant_id: this.#tenantId,
            project_id: session.project_id,
            actor_user_id: validation.actorUserId,
            kind: "validate",
            from_environment_version_id: active.id,
            to_environment_version_id: validation.environmentVersionId,
            idempotency_key: idempotencyKey,
            request_fingerprint: fingerprint,
          })
          .executeTakeFirstOrThrow();
      }

      const run = await transaction
        .insertInto("runs")
        .values({
          id: runId,
          trace_id: createHash("sha256")
            .update("pi-cloud.run-trace.v1\0", "utf8")
            .update(runId, "utf8")
            .digest("hex")
            .slice(0, 32),
          tenant_id: this.#tenantId,
          project_id: session.project_id,
          workspace_id: session.workspace_id,
          session_id: session.id,
          turn_id: turnId,
          agent_revision_id: session.agent_revision_id,
          mailbox_position: mailboxPosition,
          request_sha256: fingerprint,
          available_at: sql<Date>`now()`,
          environment_version_id: environment.environmentVersionId,
          working_directory: session.working_directory,
          sandbox_profile_key: session.sandbox_profile_key,
          tool_capability_snapshot: sql<unknown[]>`${JSON.stringify(toolCapabilities)}::jsonb`,
          conversation_base_seq: Math.max(
            0,
            positiveSafeInteger(session.next_event_seq, "Next event sequence") - 1,
          ),
          workspace_base_settlement_id: workspaceBaseSettlementId,
          idempotency_key: idempotencyKey,
          state: "queued",
          current_attempt_id: null,
          attempt_count: 0,
          stop_reason: null,
          failure_code: null,
          failure_message: null,
          failure_retryable: null,
          started_at: null,
          settled_at: null,
        })
        .returning(["id", "created_at", "request_sha256"])
        .executeTakeFirstOrThrow();

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          next_mailbox_position: sql<string>`${sql.ref("next_mailbox_position")} + 1`,
          current_workspace_settlement_id: workspaceBaseSettlementId,
          workspace_settlement_key: workspaceSettlementKey,
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: sql<Date>`now()`,
        })
        .where("tenant_id", "=", this.#tenantId)
        .where("id", "=", session.id)
        .where("next_mailbox_position", "=", String(mailboxPosition))
        .executeTakeFirst();
      if (sessionUpdate.numUpdatedRows !== 1n) {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Session mailbox position could not be advanced",
        );
      }

      return acceptedTurnResource(
        {
          runId: run.id,
          mailboxPosition: String(mailboxPosition),
          turnId,
          sessionId: session.id,
          acceptedAt: run.created_at,
          requestSha256: run.request_sha256,
        },
        fingerprint,
        false,
      );
    });
  }

  async #findAcceptedTurn(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<AcceptedTurnRow | undefined> {
    const row = await this.#database
      .selectFrom("runs as run")
      .innerJoin("turns as turn", "turn.id", "run.turn_id")
      .select([
        "run.id as runId",
        "run.mailbox_position as mailboxPosition",
        "run.created_at as acceptedAt",
        "run.request_sha256 as requestSha256",
        "turn.id as turnId",
        "turn.session_id as sessionId",
      ])
      .where("run.tenant_id", "=", this.#tenantId)
      .where("run.session_id", "=", sessionId)
      .where("run.idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return row;
  }

  async #acceptNewTurnCancellation(
    sessionId: string,
    turnId: string,
    idempotencyKey: string,
    gracePeriodMs: number,
    fingerprint: string,
  ): Promise<AcceptedTurnCancellationResource> {
    const controlRequestId = this.#idGenerator();
    return this.#database.transaction().execute(async (transaction) => {
      const lifecycle = await transaction
        .selectFrom("turns as turn")
        .innerJoin("sessions as session_row", (join) =>
          join
            .onRef("session_row.tenant_id", "=", "turn.tenant_id")
            .onRef("session_row.id", "=", "turn.session_id"),
        )
        .select([
          "turn.id as turnId",
          "turn.state as turnState",
          "session_row.id as sessionId",
          "session_row.state as sessionState",
        ])
        .where("turn.tenant_id", "=", this.#tenantId)
        .where("turn.session_id", "=", sessionId)
        .where("turn.id", "=", turnId)
        .forUpdate(["turn", "session_row"])
        .executeTakeFirst();
      if (lifecycle === undefined) {
        throw new ControlPlaneStoreError("not_found", "Turn was not found");
      }
      const activePair = lifecycle.turnState === "running" && lifecycle.sessionState === "running";
      if (!activePair) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Only an active turn can accept a cancellation request",
        );
      }

      const target = await transaction
        .selectFrom("runs")
        .select(["id", "state"])
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sessionId)
        .where("turn_id", "=", turnId)
        .forUpdate()
        .executeTakeFirst();
      if (
        target === undefined ||
        !["provisioning", "restoring", "running", "settling"].includes(target.state)
      ) {
        throw new ControlPlaneStoreError(
          "conflict",
          "Turn does not have one running Run to cancel",
        );
      }

      const activeCancellation = await transaction
        .selectFrom("turn_control_requests")
        .select("id")
        .where("tenant_id", "=", this.#tenantId)
        .where("session_id", "=", sessionId)
        .where("turn_id", "=", turnId)
        .where("kind", "=", "cancel")
        .where("state", "in", ["pending", "dispatched", "acknowledged"])
        .executeTakeFirst();
      if (activeCancellation !== undefined) {
        throw new ControlPlaneStoreError("conflict", "Turn cancellation is already in progress");
      }

      const controlRequest = await transaction
        .insertInto("turn_control_requests")
        .values({
          id: controlRequestId,
          tenant_id: this.#tenantId,
          session_id: sessionId,
          turn_id: turnId,
          target_run_id: target.id,
          idempotency_key: idempotencyKey,
          kind: "cancel",
          state: "pending",
          request_sha256: fingerprint,
          payload: {
            schemaVersion: 1,
            reason: "user_request",
            gracePeriodMs,
          },
          attempts: 0,
          available_at: sql<Date>`now()`,
          dispatched_at: null,
          acknowledged_at: null,
          completed_at: null,
          failure_code: null,
        })
        .returning(["id", "target_run_id", "created_at", "request_sha256"])
        .executeTakeFirstOrThrow();

      return acceptedTurnCancellationResource(
        {
          controlRequestId: controlRequest.id,
          targetRunId: controlRequest.target_run_id,
          turnId,
          sessionId,
          acceptedAt: controlRequest.created_at,
          requestSha256: controlRequest.request_sha256,
        },
        fingerprint,
        false,
      );
    });
  }

  async #findAcceptedTurnCancellation(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<AcceptedTurnCancellationRow | undefined> {
    return this.#database
      .selectFrom("turn_control_requests as request")
      .innerJoin("turns as turn", "turn.id", "request.turn_id")
      .select([
        "request.id as controlRequestId",
        "request.target_run_id as targetRunId",
        "request.created_at as acceptedAt",
        "request.request_sha256 as requestSha256",
        "turn.id as turnId",
        "turn.session_id as sessionId",
      ])
      .where("request.tenant_id", "=", this.#tenantId)
      .where("request.session_id", "=", sessionId)
      .where("request.idempotency_key", "=", idempotencyKey)
      .where("request.kind", "=", "cancel")
      .executeTakeFirst();
  }

  async #loadActiveProjectEnvironment(projectId: string): Promise<ProjectEnvironmentResource> {
    const row = await this.#database
      .selectFrom("environment_versions as environment")
      .select([
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "environment.state as environmentState",
        "environment.active as environmentActive",
        "environment.created_at as environmentCreatedAt",
        "environment.validated_at as environmentValidatedAt",
      ])
      .where("environment.tenant_id", "=", this.#tenantId)
      .where("environment.project_id", "=", projectId)
      .where("environment.active", "=", true)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Project has no active environment version",
      );
    }
    const snapshot = environmentSnapshot(row);
    const validation = await this.#database
      .selectFrom("environment_validations")
      .select(["report", "validated_at"])
      .where("tenant_id", "=", this.#tenantId)
      .where("project_id", "=", projectId)
      .where("environment_version_id", "=", snapshot.environmentVersionId)
      .where("status", "=", "validated")
      .orderBy("validated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    let latestValidation;
    if (validation?.report !== null && validation?.report !== undefined) {
      try {
        latestValidation = parseEnvironmentValidationReport(validation.report);
      } catch {
        throw new ControlPlaneStoreError(
          "control_plane_misconfigured",
          "Project environment validation evidence is invalid",
        );
      }
    }
    if (row.environmentState === "validated" && latestValidation === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Validated project environment has no evidence",
      );
    }
    return {
      ...snapshot,
      state: row.environmentState,
      active: row.environmentActive,
      createdAt: isoTimestamp(row.environmentCreatedAt),
      ...(row.environmentValidatedAt === null
        ? {}
        : { validatedAt: isoTimestamp(row.environmentValidatedAt) }),
      ...(latestValidation === undefined ? {} : { latestValidation }),
    };
  }

  async #activeEnvironmentForRun(
    transaction: Transaction<Database>,
    projectId: string,
  ): Promise<EnvironmentRuntimeSnapshot> {
    const project = await transaction
      .selectFrom("projects")
      .select("id")
      .where("tenant_id", "=", this.#tenantId)
      .where("id", "=", projectId)
      .forUpdate()
      .executeTakeFirst();
    if (project === undefined) {
      throw new ControlPlaneStoreError("not_found", "Project was not found");
    }
    const active = await transaction
      .selectFrom("environment_versions as environment")
      .select([
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "environment.state as environmentState",
        "environment.active as environmentActive",
        "environment.created_at as environmentCreatedAt",
        "environment.validated_at as environmentValidatedAt",
      ])
      .where("environment.tenant_id", "=", this.#tenantId)
      .where("environment.project_id", "=", projectId)
      .where("environment.active", "=", true)
      .forUpdate()
      .executeTakeFirst();
    if (active === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Project has no active environment version",
      );
    }
    const current = environmentSnapshot(active);
    if (active.environmentState === "failed") {
      throw new ControlPlaneStoreError(
        "conflict",
        "Active environment failed validation and must be rolled back",
      );
    }
    if (current.imageRevision === this.#environmentImageRevision) return current;

    await transaction
      .updateTable("environment_versions")
      .set({ active: false, updated_at: sql<Date>`now()` })
      .where("tenant_id", "=", this.#tenantId)
      .where("project_id", "=", projectId)
      .where("id", "=", current.environmentVersionId)
      .where("active", "=", true)
      .executeTakeFirstOrThrow();
    const created = await transaction
      .insertInto("environment_versions")
      .values({
        id: this.#idGenerator(),
        tenant_id: this.#tenantId,
        project_id: projectId,
        version_number: current.versionNumber + 1,
        profile_key: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_KEY,
        profile_version: DEFAULT_PROJECT_ENVIRONMENT_PROFILE_VERSION,
        image_revision: this.#environmentImageRevision,
        spec_sha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
        recipe: sql<Record<string, unknown>>`${JSON.stringify(current.recipe)}::jsonb`,
        recipe_sha256: current.recipeSha256,
        state: "pending",
        active: true,
        validated_at: null,
      })
      .returning([
        "id as environmentVersionId",
        "version_number as environmentVersionNumber",
        "profile_key as environmentProfileKey",
        "profile_version as environmentProfileVersion",
        "image_revision as environmentImageRevision",
        "spec_sha256 as environmentSpecSha256",
        "recipe as environmentRecipe",
        "recipe_sha256 as environmentRecipeSha256",
        "state as environmentState",
        "active as environmentActive",
        "created_at as environmentCreatedAt",
        "validated_at as environmentValidatedAt",
      ])
      .executeTakeFirstOrThrow();
    return environmentSnapshot(created);
  }

  async #environmentVersionForValidation(
    transaction: Transaction<Database>,
    projectId: string,
    environmentVersionId: string,
  ): Promise<EnvironmentRuntimeSnapshot> {
    const row = await transaction
      .selectFrom("environment_versions as environment")
      .select([
        "environment.id as environmentVersionId",
        "environment.version_number as environmentVersionNumber",
        "environment.profile_key as environmentProfileKey",
        "environment.profile_version as environmentProfileVersion",
        "environment.image_revision as environmentImageRevision",
        "environment.spec_sha256 as environmentSpecSha256",
        "environment.recipe as environmentRecipe",
        "environment.recipe_sha256 as environmentRecipeSha256",
        "environment.state as environmentState",
        "environment.active as environmentActive",
        "environment.created_at as environmentCreatedAt",
        "environment.validated_at as environmentValidatedAt",
      ])
      .where("environment.tenant_id", "=", this.#tenantId)
      .where("environment.project_id", "=", projectId)
      .where("environment.id", "=", environmentVersionId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) {
      throw new ControlPlaneStoreError("not_found", "Environment version was not found");
    }
    if (row.environmentState === "failed") {
      throw new ControlPlaneStoreError("conflict", "Failed environment version cannot be retried");
    }
    const snapshot = environmentSnapshot(row);
    if (snapshot.imageRevision !== this.#environmentImageRevision) {
      throw new ControlPlaneStoreError(
        "conflict",
        "Environment version is not served by the current deployment image",
      );
    }
    return snapshot;
  }

  async #resolveModelSnapshot(
    transaction: Transaction<Database>,
    modelProfileId: string,
    requestedThinkingLevel?: ModelThinkingLevel,
    serviceTier: "fast" | null = null,
  ) {
    const row = (await transaction
      .selectFrom("model_profiles as profile")
      .innerJoin("credential_bindings as credential", (join) =>
        join
          .onRef("credential.tenant_id", "=", "profile.tenant_id")
          .onRef("credential.id", "=", "profile.credential_binding_id")
          .onRef("credential.version", "=", "profile.credential_binding_version"),
      )
      .select([
        "profile.id as profileId",
        "profile.provider as provider",
        "profile.model_id as modelId",
        "profile.default_thinking_level as defaultThinkingLevel",
        "profile.allowed_thinking_levels as allowedThinkingLevels",
        "profile.credential_binding_id as credentialBindingId",
        "profile.credential_binding_version as credentialBindingVersion",
        "profile.enabled as profileEnabled",
        "credential.status as credentialStatus",
        "credential.provider as credentialProvider",
      ])
      .where("profile.tenant_id", "=", this.#tenantId)
      .where("profile.id", "=", modelProfileId)
      .executeTakeFirst()) as ModelSnapshotRow | undefined;

    if (
      !row ||
      !row.profileEnabled ||
      row.credentialStatus !== "active" ||
      row.credentialProvider !== row.provider
    ) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "The configured model profile is unavailable",
      );
    }

    const profile: ModelProfile = {
      profileId: row.profileId,
      provider: row.provider,
      modelId: row.modelId,
      defaultThinkingLevel: row.defaultThinkingLevel as ModelThinkingLevel,
      allowedThinkingLevels: row.allowedThinkingLevels as ModelThinkingLevel[],
      credentialBindingId: row.credentialBindingId,
      credentialBindingVersion: positiveSafeInteger(
        row.credentialBindingVersion,
        "Credential binding version",
      ),
      enabled: row.profileEnabled,
    };
    try {
      const resolved = resolveTurnModel(profile, requestedThinkingLevel);
      const catalogModel = supportedModelSelection(resolved.provider, resolved.modelId);
      const supported = catalogModel === undefined ? undefined : supportedModel(catalogModel);
      if (supported !== undefined && !supported.thinkingLevels.includes(resolved.thinkingLevel)) {
        throw new DomainModelValidationError(
          `Thinking level ${resolved.thinkingLevel} is not supported by ${resolved.modelId}`,
        );
      }
      if (serviceTier === "fast" && supported?.fastModeAvailable !== true) {
        throw new DomainModelValidationError(`Fast mode is not supported by ${resolved.modelId}`);
      }
      return { ...resolved, serviceTier };
    } catch (error) {
      if (error instanceof DomainModelValidationError) {
        throw new ControlPlaneStoreError(
          requestedThinkingLevel === undefined ? "control_plane_misconfigured" : "invalid_request",
          error.message,
        );
      }
      throw error;
    }
  }

  async #sessionModelResource(
    transaction: Kysely<Database>,
    sessionId: string,
  ): Promise<SessionModelResource> {
    const row = await transaction
      .selectFrom("sessions as session")
      .innerJoin("model_profiles as profile", (join) =>
        join
          .onRef("profile.tenant_id", "=", "session.tenant_id")
          .onRef("profile.id", "=", "session.desired_model_profile_id"),
      )
      .innerJoin("credential_bindings as binding", (join) =>
        join
          .onRef("binding.tenant_id", "=", "profile.tenant_id")
          .onRef("binding.id", "=", "profile.credential_binding_id")
          .onRef("binding.version", "=", "profile.credential_binding_version"),
      )
      .select([
        "session.id as sessionId",
        "session.desired_model_profile_id as modelProfileId",
        "session.desired_thinking_level as thinkingLevel",
        "session.desired_service_tier as serviceTier",
        "session.session_kind as sessionKind",
        "profile.provider",
        "profile.model_id as modelId",
        "profile.enabled",
        "binding.status as bindingStatus",
      ])
      .where("session.tenant_id", "=", this.#tenantId)
      .where("session.id", "=", sessionId)
      .executeTakeFirst();
    if (row === undefined || row.sessionKind !== "conversation") {
      throw new ControlPlaneStoreError("not_found", "Conversation was not found");
    }
    const selection = supportedModelSelection(row.provider, row.modelId);
    const catalogModel = selection === undefined ? undefined : supportedModel(selection);
    if (!row.enabled || row.bindingStatus !== "active" || catalogModel === undefined) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Conversation model is unavailable",
      );
    }
    return {
      sessionId: row.sessionId,
      modelProfileId: row.modelProfileId,
      provider: catalogModel.provider,
      modelId: catalogModel.modelId,
      displayName: catalogModel.displayName,
      thinkingLevel: row.thinkingLevel,
      fastMode: row.serviceTier === "fast",
    } as SessionModelResource;
  }

  async #lockTenantPolicy(transaction: Transaction<Database>): Promise<TenantRuntimePolicy> {
    const startedAt = performance.now();
    const policy = await transaction
      .selectFrom("tenant_runtime_policies")
      .select([
        "default_model_profile_id as defaultModelProfileId",
        "enabled",
        "maximum_projects as maximumProjects",
        "maximum_sessions as maximumSessions",
      ])
      .where("tenant_id", "=", this.#tenantId)
      .forUpdate()
      .executeTakeFirst()
      .finally(() => {
        this.#metrics?.tenantAdmissionLockWait.observe((performance.now() - startedAt) / 1_000);
      });
    if (policy === undefined || !policy.enabled) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Tenant runtime policy is unavailable",
      );
    }
    if (policy.defaultModelProfileId !== this.#defaultModelProfileId) {
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Tenant runtime policy changed during request authentication",
      );
    }
    return {
      defaultModelProfileId: policy.defaultModelProfileId,
      maximumProjects: positiveSafeInteger(String(policy.maximumProjects), "Project quota"),
      maximumSessions: positiveSafeInteger(String(policy.maximumSessions), "Session quota"),
    };
  }
}
