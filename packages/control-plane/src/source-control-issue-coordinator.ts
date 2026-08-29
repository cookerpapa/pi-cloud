import type { Database, SourceControlIssueJobState } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { ControlPlaneStore, ControlPlaneStoreError } from "./control-plane-store.ts";
import { GitHubAppClientError } from "./github-app-client.ts";
import { SourceControlService, SourceControlServiceError } from "./source-control-service.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

const POLL_INTERVAL_MS = 2_000;
const JOB_LEASE_MS = 2 * 60_000;
const JOB_HEARTBEAT_MS = 30_000;
const MAXIMUM_ATTEMPTS = 8;

type ClaimedJob = Awaited<ReturnType<SourceControlIssueCoordinator["claimNext"]>>;

function safeFailure(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof SourceControlServiceError || error instanceof GitHubAppClientError) {
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
  readonly #publicOrigin: string;
  readonly #clock: () => Date;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #closed = false;

  constructor(options: {
    database: Kysely<Database>;
    sourceControl: SourceControlService;
    instanceId: string;
    environmentImageRevision: string;
    publicOrigin: string;
    clock?: () => Date;
  }) {
    this.#database = options.database;
    this.#sourceControl = options.sourceControl;
    this.#instanceId = options.instanceId;
    this.#environmentImageRevision = options.environmentImageRevision;
    const origin = new URL(options.publicOrigin);
    if (
      (origin.protocol !== "http:" && origin.protocol !== "https:") ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new TypeError("Issue automation public origin is invalid");
    }
    this.#publicOrigin = origin.toString();
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
        .where("state", "not in", ["completed", "failed", "cancelled"])
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
        .where("state", "not in", ["completed", "failed", "cancelled"])
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
    if (job.state === "publishing") {
      await this.#publish(job);
      return;
    }
    throw new SourceControlServiceError(
      "source_control_operation_failed",
      "Issue automation state is invalid",
    );
  }

  async #provision(job: NonNullable<ClaimedJob>): Promise<void> {
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
        .innerJoin("workspace_source_repositories as source", (join) =>
          join
            .onRef("source.tenant_id", "=", "workspace.tenant_id")
            .onRef("source.workspace_id", "=", "workspace.id"),
        )
        .select([
          "project.id as projectId",
          "workspace.id as workspaceId",
          "source.checkout_state as checkoutState",
        ])
        .where("project.tenant_id", "=", job.tenant_id)
        .where("project.name", "=", projectName)
        .where("project.deleted_at", "is", null)
        .where("source.repository_id", "=", job.repository_id)
        .executeTakeFirst();
      if (existing !== undefined) {
        projectId = existing.projectId;
        workspaceId = existing.workspaceId;
        if (existing.checkoutState !== "ready") {
          const baseSha = await this.#sourceControl.checkoutIssueWorkspace({
            tenantId: job.tenant_id,
            repositoryId: job.repository_id,
            workspaceId,
            branchName: job.branch_name,
          });
          await this.#markCheckoutReady(job.tenant_id, workspaceId, baseSha);
        }
      } else {
        const created = await this.#sourceControl.createRepositoryProject(
          identity,
          store,
          {
            name: projectName,
            source: { kind: "github", repositoryId: job.repository_id },
          },
          job.branch_name,
        );
        projectId = created.projectId;
        workspaceId = created.workspaceId;
      }
      await this.#updateOwned(job.id, {
        state: "provisioning",
        project_id: projectId,
        workspace_id: workspaceId,
      });
    }

    const sessionTitle = `#${String(job.issue_number)} ${job.issue_title}`.slice(0, 256);
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
          await store.createSession(projectId, workspaceId, sessionTitle, "elastic", {
            sandboxProfileKey: "standard",
            workingDirectory: "/workspace",
            ownerUserId: identity.userId,
          })
        ).sessionId;
      await this.#updateOwned(job.id, { state: "provisioning", session_id: sessionId });
    }

    const prompt = [
      `Resolve GitHub Issue #${String(job.issue_number)} in ${repository.full_name}.`,
      "Inspect the repository, implement the smallest complete fix, and run relevant tests.",
      "PiCloud keeps Git metadata outside the sandbox; edit and test files without invoking git commands.",
      "Do not publish, push, or create a pull request; PiCloud will handle delivery after this Run settles.",
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
      await this.#updateOwned(job.id, {
        state: "publishing",
        owner_id: null,
        lease_expires_at: null,
        available_at: this.#clock(),
      });
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

  async #publish(job: NonNullable<ClaimedJob>): Promise<void> {
    if (job.workspace_id === null || job.session_id === null) {
      throw new SourceControlServiceError(
        "source_control_operation_failed",
        "Issue automation Workspace is missing",
      );
    }
    const repository = await this.#sourceControl.repositoryForJob(job.repository_id);
    if (repository === undefined) {
      throw new SourceControlServiceError(
        "source_control_not_found",
        "Issue repository was not found",
      );
    }
    const published =
      job.commit_sha === null
        ? await this.#sourceControl.publishIssueWorkspace({
            tenantId: job.tenant_id,
            repositoryId: job.repository_id,
            workspaceId: job.workspace_id,
            branchName: job.branch_name,
            commitMessage: `Fix #${String(job.issue_number)}: ${job.issue_title}`.slice(0, 1_024),
          })
        : { changed: true as const, commitSha: job.commit_sha };
    if (published.commitSha !== undefined && job.commit_sha === null) {
      await this.#updateOwned(job.id, { state: "publishing", commit_sha: published.commitSha });
    }
    let pullRequest =
      job.pull_request_number === null || job.pull_request_url === null
        ? await this.#sourceControl.githubClient().findPullRequest({
            installationId: repository.provider_installation_id,
            repositoryId: repository.provider_repository_id,
            owner: repository.owner,
            repository: repository.name,
            head: job.branch_name,
          })
        : { number: job.pull_request_number, url: job.pull_request_url };
    if (published.changed && pullRequest === undefined) {
      pullRequest = await this.#sourceControl.githubClient().createPullRequest({
        installationId: repository.provider_installation_id,
        repositoryId: repository.provider_repository_id,
        owner: repository.owner,
        repository: repository.name,
        title: `Fix #${String(job.issue_number)}: ${job.issue_title}`.slice(0, 256),
        body: [
          `Fixes #${String(job.issue_number)}`,
          "",
          "Implemented and tested by PiCloud.",
          `[Open the PiCloud session](${new URL(`?session=${job.session_id}`, this.#publicOrigin).toString()})`,
        ].join("\n"),
        head: job.branch_name,
        base: repository.default_branch,
      });
      await this.#updateOwned(job.id, {
        state: "publishing",
        pull_request_number: pullRequest.number,
        pull_request_url: pullRequest.url,
      });
    }
    const marker = `<!-- picloud-issue-job:${job.id} -->`;
    let comment =
      job.issue_comment_id === null
        ? await this.#sourceControl.githubClient().findIssueComment({
            installationId: repository.provider_installation_id,
            repositoryId: repository.provider_repository_id,
            owner: repository.owner,
            repository: repository.name,
            issueNumber: job.issue_number,
            marker,
          })
        : { id: job.issue_comment_id };
    if (comment === undefined) {
      comment = await this.#sourceControl.githubClient().createIssueComment({
        installationId: repository.provider_installation_id,
        repositoryId: repository.provider_repository_id,
        owner: repository.owner,
        repository: repository.name,
        issueNumber: job.issue_number,
        body: [
          marker,
          published.changed && pullRequest !== undefined
            ? `PiCloud completed the task and opened ${pullRequest.url}.`
            : "PiCloud completed the task; the Workspace contained no repository changes.",
          `[Open the PiCloud session](${new URL(`?session=${job.session_id}`, this.#publicOrigin).toString()})`,
        ].join("\n\n"),
      });
    }
    const now = this.#clock();
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("source_control_issue_jobs")
        .set({
          state: "completed",
          issue_comment_id: comment!.id,
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
        .where("provider", "=", "github")
        .where("delivery_id", "=", job.webhook_delivery_id)
        .executeTakeFirstOrThrow();
    });
  }

  async #fail(
    job: NonNullable<ClaimedJob>,
    failure: { code: string; message: string; retryable: boolean },
  ): Promise<void> {
    const now = this.#clock();
    let issueCommentId = job.issue_comment_id;
    if (issueCommentId === null) {
      try {
        const repository = await this.#sourceControl.repositoryForJob(job.repository_id);
        if (repository !== undefined) {
          const marker = `<!-- picloud-issue-job:${job.id} -->`;
          const existing = await this.#sourceControl.githubClient().findIssueComment({
            installationId: repository.provider_installation_id,
            repositoryId: repository.provider_repository_id,
            owner: repository.owner,
            repository: repository.name,
            issueNumber: job.issue_number,
            marker,
          });
          issueCommentId =
            existing?.id ??
            (
              await this.#sourceControl.githubClient().createIssueComment({
                installationId: repository.provider_installation_id,
                repositoryId: repository.provider_repository_id,
                owner: repository.owner,
                repository: repository.name,
                issueNumber: job.issue_number,
                body: [
                  marker,
                  `PiCloud could not complete this task: ${failure.message.slice(0, 512)}`,
                  ...(job.session_id === null
                    ? []
                    : [
                        `[Open the PiCloud session](${new URL(`?session=${job.session_id}`, this.#publicOrigin).toString()})`,
                      ]),
                ].join("\n\n"),
              })
            ).id;
        }
      } catch {
        // The terminal database state remains authoritative if GitHub is down.
      }
    }
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("source_control_issue_jobs")
        .set({
          state: "failed",
          failure_code: failure.code.slice(0, 128),
          failure_message: failure.message.slice(0, 1_024),
          issue_comment_id: issueCommentId,
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
        .where("provider", "=", "github")
        .where("delivery_id", "=", job.webhook_delivery_id)
        .execute();
    });
  }

  async #identity(job: NonNullable<ClaimedJob>): Promise<TenantRequestIdentity> {
    const row = await this.#database
      .selectFrom("source_control_repositories as repository")
      .innerJoin("source_control_installations as installation", (join) =>
        join
          .onRef("installation.tenant_id", "=", "repository.tenant_id")
          .onRef("installation.id", "=", "repository.installation_id"),
      )
      .innerJoin("tenants as tenant", "tenant.id", "repository.tenant_id")
      .innerJoin("users as user_row", (join) =>
        join
          .onRef("user_row.tenant_id", "=", "installation.tenant_id")
          .onRef("user_row.id", "=", "installation.connected_by_user_id"),
      )
      .innerJoin("user_password_credentials as credential", (join) =>
        join
          .onRef("credential.tenant_id", "=", "user_row.tenant_id")
          .onRef("credential.user_id", "=", "user_row.id"),
      )
      .innerJoin("tenant_runtime_policies as policy", "policy.tenant_id", "tenant.id")
      .select([
        "tenant.id as tenantId",
        "tenant.slug as tenantSlug",
        "user_row.id as userId",
        "user_row.display_name as displayName",
        "credential.username",
        "credential.role",
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
      username: row.username,
      displayName: row.displayName,
      role: row.role,
      defaultModelProfileId: row.defaultModelProfileId,
    };
  }

  async #markCheckoutReady(tenantId: string, workspaceId: string, baseSha: string): Promise<void> {
    await this.#database
      .updateTable("workspace_source_repositories")
      .set({
        checkout_state: "ready",
        base_sha: baseSha,
        failure_code: null,
        updated_at: this.#clock(),
      })
      .where("tenant_id", "=", tenantId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirstOrThrow();
  }

  async #updateOwned(
    jobId: string,
    values: Partial<{
      state: SourceControlIssueJobState;
      project_id: string;
      workspace_id: string;
      session_id: string;
      run_id: string;
      commit_sha: string;
      pull_request_number: number;
      pull_request_url: string;
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
