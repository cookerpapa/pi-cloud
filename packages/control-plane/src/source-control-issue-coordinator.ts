import type { Database, SourceControlIssueJobState } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { ControlPlaneStore, ControlPlaneStoreError } from "./control-plane-store.ts";
import { GitHubAppClientError } from "./github-app-client.ts";
import { GitLabProjectClientError } from "./gitlab-project-client.ts";
import { SourceControlService, SourceControlServiceError } from "./source-control-service.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

const POLL_INTERVAL_MS = 2_000;
const JOB_LEASE_MS = 2 * 60_000;
const JOB_HEARTBEAT_MS = 30_000;
const MAXIMUM_ATTEMPTS = 8;

type ClaimedJob = Awaited<ReturnType<SourceControlIssueCoordinator["claimNext"]>>;

function safeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (
    error instanceof SourceControlServiceError ||
    error instanceof GitHubAppClientError ||
    error instanceof GitLabProjectClientError
  ) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  if (error instanceof ControlPlaneStoreError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === "capacity_exhausted" || error.code === "conflict",
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return {
      code: error.code.slice(0, 128),
      message: error instanceof Error ? error.message.slice(0, 1_024) : "Operation failed",
      retryable: error.retryable,
    };
  }
  return { code: "issue_job_failed", message: "Issue automation failed", retryable: true };
}

export class SourceControlIssueCoordinator {
  readonly #database: Kysely<Database>;
  readonly #sourceControl: SourceControlService;
  readonly #instanceId: string;
  readonly #environmentImageRevision: string;
  readonly #clock: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #closed = false;

  constructor(options: {
    database: Kysely<Database>;
    sourceControl: SourceControlService;
    instanceId: string;
    environmentImageRevision: string;
    clock?: () => Date;
  }) {
    this.#database = options.database;
    this.#sourceControl = options.sourceControl;
    this.#instanceId = options.instanceId;
    this.#environmentImageRevision = options.environmentImageRevision;
    this.#clock = options.clock ?? (() => new Date());
  }

  start(): void {
    if (this.#timer !== undefined || this.#closed) return;
    this.#timer = setInterval(() => void this.#tick(), POLL_INTERVAL_MS);
    this.#timer.unref();
    void this.#tick();
  }

  async reconcileOnce(): Promise<boolean> {
    const job = await this.claimNext();
    if (job === undefined) return false;
    const heartbeat = setInterval(() => {
      const now = this.#clock();
      void this.#database
        .updateTable("source_control_issue_jobs")
        .set({ lease_expires_at: new Date(now.valueOf() + JOB_LEASE_MS), updated_at: now })
        .where("id", "=", job.id)
        .where("owner_id", "=", this.#instanceId)
        .where("state", "in", ["received", "provisioning", "queued", "running"])
        .execute()
        .catch(() => undefined);
    }, JOB_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      await this.#process(job);
    } catch (error: unknown) {
      const failure = safeFailure(error);
      if (failure.retryable && job.attempt_count < MAXIMUM_ATTEMPTS) {
        const delay = Math.min(60_000, 1_000 * 2 ** Math.min(job.attempt_count, 6));
        await this.#database
          .updateTable("source_control_issue_jobs")
          .set({
            owner_id: null,
            lease_expires_at: null,
            attempt_count: sql<number>`${sql.ref("attempt_count")} + 1`,
            available_at: new Date(this.#clock().valueOf() + delay),
            updated_at: this.#clock(),
          })
          .where("id", "=", job.id)
          .where("owner_id", "=", this.#instanceId)
          .execute();
      } else {
        await this.#fail(job, failure);
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    while (this.#running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async claimNext() {
    const now = this.#clock();
    return this.#database.transaction().execute(async (transaction) => {
      const candidate = await transaction
        .selectFrom("source_control_issue_jobs")
        .select("id")
        .where("state", "in", ["received", "provisioning", "queued", "running"])
        .where("available_at", "<=", now)
        .where((expression) =>
          expression.or([
            expression("owner_id", "is", null),
            expression("lease_expires_at", "<=", now),
          ]),
        )
        .orderBy("available_at", "asc")
        .orderBy("created_at", "asc")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (candidate === undefined) return undefined;
      return transaction
        .updateTable("source_control_issue_jobs")
        .set({
          owner_id: this.#instanceId,
          lease_expires_at: new Date(now.valueOf() + JOB_LEASE_MS),
          updated_at: now,
        })
        .where("id", "=", candidate.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  async #tick(): Promise<void> {
    if (this.#closed || this.#running || !this.#sourceControl.configured) return;
    this.#running = true;
    try {
      await this.#sourceControl.reconcileNextClaimSync().catch(() => false);
      await this.reconcileOnce();
    } finally {
      this.#running = false;
    }
  }

  async #process(job: NonNullable<ClaimedJob>): Promise<void> {
    if (job.state === "received" || job.state === "provisioning") {
      await this.#provision(job);
      return;
    }
    if (job.state === "queued" || job.state === "running") {
      await this.#observeRun(job);
      return;
    }
    throw new SourceControlServiceError(
      "source_control_operation_failed",
      "Issue automation state is invalid",
    );
  }

  async #provision(job: NonNullable<ClaimedJob>): Promise<void> {
    if (
      job.execution_mode === null ||
      job.sandbox_profile_key === null ||
      job.working_directory === null ||
      job.started_by_user_id === null
    ) {
      throw new SourceControlServiceError(
        "source_control_operation_failed",
        "Issue execution selection is incomplete",
      );
    }
    const identity = await this.#identity(job);
    const store = new ControlPlaneStore({
      database: this.#database,
      tenantId: identity.tenantId,
      defaultModelProfileId: identity.defaultModelProfileId,
      environmentImageRevision: this.#environmentImageRevision,
    });
    const repository = await this.#sourceControl.repositoryForJob(job.repository_id);
    if (repository === undefined) {
      throw new SourceControlServiceError(
        "source_control_not_found",
        "Issue source repository is no longer connected",
      );
    }
    const projectName = `Issue ${repository.full_name} #${String(job.issue_number)} ${job.id.slice(0, 8)}`;
    let projectId = job.project_id;
    let workspaceId = job.workspace_id;
    if (projectId === null || workspaceId === null) {
      const existing = await this.#database
        .selectFrom("projects as project")
        .innerJoin("workspaces as workspace", (join) =>
          join
            .onRef("workspace.tenant_id", "=", "project.tenant_id")
            .onRef("workspace.project_id", "=", "project.id"),
        )
        .select(["project.id as projectId", "workspace.id as workspaceId"])
        .where("project.tenant_id", "=", job.tenant_id)
        .where("project.name", "=", projectName)
        .where("project.deleted_at", "is", null)
        .executeTakeFirst();
      if (existing !== undefined) {
        projectId = existing.projectId;
        workspaceId = existing.workspaceId;
      } else {
        const created = await store.createProject({ name: projectName, source: { kind: "empty" } });
        projectId = created.projectId;
        workspaceId = created.workspaceId;
      }
      await this.#updateOwned(job.id, {
        state: "provisioning",
        project_id: projectId,
        workspace_id: workspaceId,
      });
    }

    if (repository.provider === "github") {
      const credential = await this.#sourceControl.authorizeAutomationGitCredential(
        job.tenant_id,
        job.repository_id,
        workspaceId!,
        job.execution_mode === "development_environment" ? "/home/user" : "/workspace",
      );
      if (!credential.authorized) {
        throw new SourceControlServiceError(
          "source_control_authorization_denied",
          "Selected environment is not authorized to clone the Issue repository",
        );
      }
    }

    const sessionTitle = job.session_title;
    let sessionId = job.session_id;
    if (sessionId === null) {
      const existing = await this.#database
        .selectFrom("sessions")
        .select("id")
        .where("tenant_id", "=", job.tenant_id)
        .where("workspace_id", "=", workspaceId)
        .where("title", "=", sessionTitle)
        .where("session_kind", "=", "conversation")
        .where("archived_at", "is", null)
        .executeTakeFirst();
      sessionId =
        existing?.id ??
        (
          await store.createSession(projectId, workspaceId, sessionTitle, job.execution_mode, {
            sandboxProfileKey: job.sandbox_profile_key,
            workingDirectory: job.working_directory,
            ownerUserId: identity.userId,
          })
        ).sessionId;
      await this.#updateOwned(job.id, { state: "provisioning", session_id: sessionId });
    }

    const prompt = [
      `Resolve ${repository.provider === "gitlab" ? "GitLab" : "GitHub"} Issue #${String(job.issue_number)} in ${repository.full_name}.`,
      `Repository clone URL: ${await this.#sourceControl.workspaceCloneUrlForJob(job.repository_id)}`,
      `Working directory: ${job.working_directory}`,
      "No repository was cloned by PiCloud. Inspect the selected directory first. Reuse the repository if it is already present; otherwise clone it into a sensibly named child directory with ordinary git clone.",
      `Use ${job.branch_name} as the suggested task branch, then implement the smallest complete fix and run relevant tests.`,
      "Do not commit, push, create a Merge/Pull Request, comment on the Issue, or change its state during this initial Run.",
      "Leave those delivery decisions to a later explicit user instruction in this conversation.",
      "",
      `Issue title: ${job.issue_title}`,
      "Issue body:",
      job.issue_body.length === 0 ? "(empty)" : job.issue_body,
    ].join("\n");
    const accepted = await store.acceptTurn(sessionId, `source-control-issue-job-${job.id}`, {
      prompt,
      thinkingLevel: "off",
    });
    await this.#updateOwned(job.id, {
      state: "queued",
      run_id: accepted.runId,
      owner_id: null,
      lease_expires_at: null,
      available_at: new Date(this.#clock().valueOf() + 2_000),
    });
  }

  async #observeRun(job: NonNullable<ClaimedJob>): Promise<void> {
    if (job.run_id === null) {
      throw new SourceControlServiceError(
        "source_control_operation_failed",
        "Issue automation Run identity is missing",
      );
    }
    const run = await this.#database
      .selectFrom("runs")
      .select(["state", "failure_code", "failure_message"])
      .where("tenant_id", "=", job.tenant_id)
      .where("id", "=", job.run_id)
      .executeTakeFirst();
    if (run === undefined) {
      throw new SourceControlServiceError(
        "source_control_not_found",
        "Issue automation Run was not found",
      );
    }
    if (run.state === "completed") {
      await this.#complete(job);
      return;
    }
    if (["failed", "cancelled", "timed_out", "superseded"].includes(run.state)) {
      await this.#fail(job, {
        code: run.failure_code ?? `run_${run.state}`,
        message: run.failure_message ?? `PiCloud Run ended in state ${run.state}`,
        retryable: false,
      });
      return;
    }
    await this.#updateOwned(job.id, {
      state: run.state === "queued" ? "queued" : "running",
      owner_id: null,
      lease_expires_at: null,
      available_at: new Date(this.#clock().valueOf() + 3_000),
    });
  }

  async #complete(job: NonNullable<ClaimedJob>): Promise<void> {
    const now = this.#clock();
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("source_control_issue_jobs")
        .set({
          state: "completed",
          owner_id: null,
          lease_expires_at: null,
          updated_at: now,
          settled_at: now,
        })
        .where("id", "=", job.id)
        .where("owner_id", "=", this.#instanceId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("source_control_webhook_deliveries")
        .set({ state: "completed", settled_at: now })
        .where("provider", "=", job.provider)
        .where("delivery_id", "=", job.webhook_delivery_id)
        .executeTakeFirstOrThrow();
    });
  }

  async #fail(
    job: NonNullable<ClaimedJob>,
    failure: { code: string; message: string; retryable: boolean },
  ): Promise<void> {
    const now = this.#clock();
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("source_control_issue_jobs")
        .set({
          state: "failed",
          failure_code: failure.code.slice(0, 128),
          failure_message: failure.message.slice(0, 1_024),
          owner_id: null,
          lease_expires_at: null,
          updated_at: now,
          settled_at: now,
        })
        .where("id", "=", job.id)
        .where("owner_id", "=", this.#instanceId)
        .execute();
      await transaction
        .updateTable("source_control_webhook_deliveries")
        .set({ state: "failed", failure_code: failure.code.slice(0, 128), settled_at: now })
        .where("provider", "=", job.provider)
        .where("delivery_id", "=", job.webhook_delivery_id)
        .execute();
    });
  }

  async #identity(job: NonNullable<ClaimedJob>): Promise<TenantRequestIdentity> {
    if (job.started_by_user_id === null) {
      throw new SourceControlServiceError(
        "source_control_operation_failed",
        "Issue starter identity is missing",
      );
    }
    const row = await this.#database
      .selectFrom("source_control_repositories as repository")
      .innerJoin("tenants as tenant", "tenant.id", "repository.tenant_id")
      .innerJoin("users as user_row", (join) =>
        join
          .onRef("user_row.tenant_id", "=", "repository.tenant_id")
          .on("user_row.id", "=", job.started_by_user_id!),
      )
      .leftJoin("user_password_credentials as credential", (join) =>
        join
          .onRef("credential.tenant_id", "=", "user_row.tenant_id")
          .onRef("credential.user_id", "=", "user_row.id"),
      )
      .leftJoin("external_identities as external", (join) =>
        join
          .onRef("external.tenant_id", "=", "user_row.tenant_id")
          .onRef("external.user_id", "=", "user_row.id")
          .on("external.provider_key", "=", "gitlab"),
      )
      .innerJoin("tenant_runtime_policies as policy", "policy.tenant_id", "tenant.id")
      .select([
        "tenant.id as tenantId",
        "tenant.slug as tenantSlug",
        "user_row.id as userId",
        "user_row.display_name as displayName",
        "credential.username as localUsername",
        "credential.role as localRole",
        "external.id as externalIdentityId",
        "external.issuer as externalIssuer",
        "external.subject as externalSubject",
        "external.provider_user_id as externalProviderUserId",
        "external.username as externalUsername",
        "policy.default_model_profile_id as defaultModelProfileId",
      ])
      .where("repository.id", "=", job.repository_id)
      .where("repository.tenant_id", "=", job.tenant_id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new SourceControlServiceError(
        "source_control_not_found",
        "Issue automation tenant identity was not found",
      );
    }
    return {
      credentialId: `source-control-issue-job:${job.id}`,
      tenantId: row.tenantId,
      tenantSlug: row.tenantSlug,
      userId: row.userId,
      ...(row.externalUsername === null
        ? row.localUsername === null
          ? {}
          : { username: row.localUsername }
        : { username: row.externalUsername }),
      displayName: row.displayName,
      role: row.localRole ?? "member",
      defaultModelProfileId: row.defaultModelProfileId,
      authenticationKind: row.externalIdentityId === null ? "system" : "oidc",
      ...(row.externalIdentityId === null ||
      row.externalIssuer === null ||
      row.externalSubject === null ||
      row.externalProviderUserId === null ||
      row.externalUsername === null
        ? {}
        : {
            externalIdentity: {
              id: row.externalIdentityId,
              providerKey: "gitlab",
              issuer: row.externalIssuer,
              subject: row.externalSubject,
              providerUserId: row.externalProviderUserId,
              username: row.externalUsername,
            },
          }),
    };
  }

  async #updateOwned(
    jobId: string,
    values: Partial<{
      state: SourceControlIssueJobState;
      project_id: string;
      workspace_id: string;
      session_id: string;
      run_id: string;
      owner_id: string | null;
      lease_expires_at: Date | null;
      available_at: Date;
    }>,
  ): Promise<void> {
    await this.#database
      .updateTable("source_control_issue_jobs")
      .set({ ...values, updated_at: this.#clock() })
      .where("id", "=", jobId)
      .where("owner_id", "=", this.#instanceId)
      .executeTakeFirstOrThrow();
  }
}
