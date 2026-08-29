import type { Database, SourceControlIssueJobState } from "@pi-cloud/database";
import type {
  CreateProjectRequest,
  ProjectResource,
  SourceControlConfigurationResource,
  SourceControlInstallLinkResource,
  SourceControlIssueJobListResource,
} from "@pi-cloud/protocol";
import { ToolBrokerClient } from "@pi-cloud/tool-broker/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ControlPlaneStore } from "./control-plane-store.ts";
import { GitHubAppClient, GitHubAppClientError } from "./github-app-client.ts";
import type { TenantRequestIdentity } from "./tenant-identity.ts";

const INSTALL_STATE_TTL_MS = 10 * 60_000;
const TRUSTED_ISSUE_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export class SourceControlServiceError extends Error {
  readonly code:
    | "source_control_unavailable"
    | "source_control_not_found"
    | "source_control_conflict"
    | "source_control_authorization_denied"
    | "source_control_webhook_invalid"
    | "source_control_operation_failed";
  readonly retryable: boolean;

  constructor(code: SourceControlServiceError["code"], message: string, retryable = false) {
    super(message);
    this.name = "SourceControlServiceError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type GitHubAppRuntime = Readonly<{
  appSlug: string;
  client: GitHubAppClient;
  issueLabel: string;
}>;

type ConnectedRepository = Readonly<{
  id: string;
  tenant_id: string;
  provider_repository_id: string;
  clone_url: string;
  default_branch: string;
  full_name: string;
  provider_installation_id: string;
}>;

type GitHubWebhookInput = Readonly<{
  deliveryId: string | undefined;
  eventName: string | undefined;
  signature: string | undefined;
  rawBody: Uint8Array;
}>;

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new SourceControlServiceError(
      "source_control_operation_failed",
      "Source-control timestamp was invalid",
    );
  }
  return date.toISOString();
}

function stateDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decimalId(value: unknown): string | undefined {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && /^[1-9][0-9]{0,30}$/.test(text) ? text : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string" || value.length < 1) return undefined;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximum) return value;
  return bytes
    .subarray(0, maximum)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}

function issueJobResource(row: {
  id: string;
  repository_id: string;
  repository_full_name: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  state: SourceControlIssueJobState;
  session_id: string | null;
  run_id: string | null;
  pull_request_url: string | null;
  failure_message: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}) {
  return {
    jobId: row.id,
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name,
    issueNumber: row.issue_number,
    issueTitle: row.issue_title,
    issueUrl: row.issue_url,
    state: row.state,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.pull_request_url === null ? {} : { pullRequestUrl: row.pull_request_url }),
    ...(row.failure_message === null ? {} : { failure: row.failure_message }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  } as const;
}

export class SourceControlService {
  readonly #database: Kysely<Database>;
  readonly #github: GitHubAppRuntime | undefined;
  readonly #materializerToken: string;
  readonly #allowInsecureInternalHttp: boolean;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: {
    database: Kysely<Database>;
    github?: GitHubAppRuntime;
    materializerToken?: string;
    allowInsecureInternalHttp?: boolean;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.#database = options.database;
    this.#github = options.github;
    this.#materializerToken =
      options.materializerToken ?? "source-control-disabled-materializer-token-000000000000000";
    this.#allowInsecureInternalHttp = options.allowInsecureInternalHttp ?? false;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  get configured(): boolean {
    return this.#github !== undefined;
  }

  async configuration(
    identity: TenantRequestIdentity,
  ): Promise<SourceControlConfigurationResource> {
    const installations = await this.#database
      .selectFrom("source_control_installations")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("state", "!=", "deleted")
      .orderBy("account_login", "asc")
      .execute();
    const repositories = await this.#database
      .selectFrom("source_control_repositories")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .orderBy("full_name", "asc")
      .execute();
    return {
      githubConfigured: this.configured,
      installations: installations.map((installation) => ({
        installationId: installation.id,
        provider: "github",
        accountLogin: installation.account_login,
        accountType: installation.account_type,
        repositorySelection: installation.repository_selection,
        state: installation.state,
        installedAt: iso(installation.installed_at),
        updatedAt: iso(installation.updated_at),
        repositories: repositories
          .filter((repository) => repository.installation_id === installation.id)
          .map((repository) => ({
            repositoryId: repository.id,
            installationId: installation.id,
            provider: "github" as const,
            fullName: repository.full_name,
            private: repository.private,
            defaultBranch: repository.default_branch,
            state: repository.state,
          })),
      })),
    };
  }

  async beginGitHubInstall(
    identity: TenantRequestIdentity,
  ): Promise<SourceControlInstallLinkResource> {
    const github = this.#requireGitHub();
    if (identity.role === "viewer") {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "Viewer accounts cannot connect source repositories",
      );
    }
    const state = randomBytes(32).toString("base64url");
    const now = this.#clock();
    const expiresAt = new Date(now.valueOf() + INSTALL_STATE_TTL_MS);
    await this.#database
      .deleteFrom("source_control_installation_requests")
      .where("expires_at", "<", new Date(now.valueOf() - 24 * 60 * 60_000))
      .execute();
    await this.#database
      .insertInto("source_control_installation_requests")
      .values({
        state_sha256: stateDigest(state),
        tenant_id: identity.tenantId,
        user_id: identity.userId,
        provider: "github",
        expires_at: expiresAt,
        consumed_at: null,
        created_at: now,
      })
      .executeTakeFirstOrThrow();
    return {
      provider: "github",
      url: `https://github.com/apps/${encodeURIComponent(github.appSlug)}/installations/new?state=${encodeURIComponent(state)}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async completeGitHubInstall(
    identity: TenantRequestIdentity,
    state: string,
    installationId: string,
  ): Promise<SourceControlConfigurationResource> {
    const github = this.#requireGitHub();
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[1-9][0-9]{0,30}$/.test(installationId)) {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "GitHub installation callback is invalid",
      );
    }
    const request = await this.#database
      .selectFrom("source_control_installation_requests")
      .selectAll()
      .where("state_sha256", "=", stateDigest(state))
      .executeTakeFirst();
    const now = this.#clock();
    if (
      request === undefined ||
      request.tenant_id !== identity.tenantId ||
      request.user_id !== identity.userId ||
      request.consumed_at !== null ||
      new Date(request.expires_at) <= now
    ) {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "GitHub installation request expired or was already used",
      );
    }
    let installation;
    let repositories;
    try {
      [installation, repositories] = await Promise.all([
        github.client.installation(installationId),
        github.client.repositories(installationId),
      ]);
    } catch (error: unknown) {
      throw this.#githubFailure(error);
    }
    await this.#database.transaction().execute(async (transaction) => {
      const locked = await transaction
        .selectFrom("source_control_installation_requests")
        .selectAll()
        .where("state_sha256", "=", stateDigest(state))
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        locked.tenant_id !== identity.tenantId ||
        locked.user_id !== identity.userId ||
        locked.consumed_at !== null ||
        new Date(locked.expires_at) <= now
      ) {
        throw new SourceControlServiceError(
          "source_control_authorization_denied",
          "GitHub installation request expired or was already used",
        );
      }
      await this.#upsertInstallation(transaction, identity, installation, repositories, now);
      await transaction
        .updateTable("source_control_installation_requests")
        .set({ consumed_at: now })
        .where("state_sha256", "=", locked.state_sha256)
        .executeTakeFirstOrThrow();
    });
    return this.configuration(identity);
  }

  async refreshInstallation(
    identity: TenantRequestIdentity,
    installationId: string,
  ): Promise<void> {
    const github = this.#requireGitHub();
    const row = await this.#database
      .selectFrom("source_control_installations")
      .selectAll()
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", installationId)
      .where("state", "!=", "deleted")
      .executeTakeFirst();
    if (row === undefined) {
      throw new SourceControlServiceError(
        "source_control_not_found",
        "GitHub installation was not found",
      );
    }
    try {
      const [installation, repositories] = await Promise.all([
        github.client.installation(row.provider_installation_id),
        github.client.repositories(row.provider_installation_id),
      ]);
      await this.#database
        .transaction()
        .execute((transaction) =>
          this.#upsertInstallation(
            transaction,
            identity,
            installation,
            repositories,
            this.#clock(),
          ),
        );
    } catch (error: unknown) {
      throw this.#githubFailure(error);
    }
  }

  async createRepositoryProject(
    identity: TenantRequestIdentity,
    store: ControlPlaneStore,
    request: CreateProjectRequest & { source: { kind: "github"; repositoryId: string } },
    branchName?: string,
  ): Promise<ProjectResource> {
    const repository = await this.#repository(identity.tenantId, request.source.repositoryId);
    const project = await store.createProject(request);
    const branch = branchName ?? `picloud/workspace-${project.workspaceId.slice(0, 12)}`;
    try {
      const baseSha = await this.#checkout(repository, project.workspaceId, branch);
      await this.#database
        .updateTable("workspace_source_repositories")
        .set({
          base_sha: baseSha,
          checkout_state: "ready",
          failure_code: null,
          updated_at: this.#clock(),
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("workspace_id", "=", project.workspaceId)
        .where("checkout_state", "=", "provisioning")
        .executeTakeFirstOrThrow();
      return {
        ...project,
        source: {
          kind: "github",
          status: "ready",
          repositoryId: repository.id,
          fullName: repository.full_name,
          baseRef: repository.default_branch,
          baseSha,
        },
      };
    } catch (error: unknown) {
      await this.#database
        .updateTable("workspace_source_repositories")
        .set({
          checkout_state: "failed",
          failure_code: error instanceof GitHubAppClientError ? error.code : "checkout_failed",
          updated_at: this.#clock(),
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("workspace_id", "=", project.workspaceId)
        .execute();
      await store
        .deleteWorkspace(project.workspaceId, `source-checkout-failed-${project.workspaceId}`)
        .catch(() => undefined);
      throw error instanceof SourceControlServiceError ? error : this.#githubFailure(error);
    }
  }

  async listIssueJobs(identity: TenantRequestIdentity): Promise<SourceControlIssueJobListResource> {
    const rows = await this.#database
      .selectFrom("source_control_issue_jobs as job")
      .innerJoin("source_control_repositories as repository", (join) =>
        join
          .onRef("repository.tenant_id", "=", "job.tenant_id")
          .onRef("repository.id", "=", "job.repository_id"),
      )
      .selectAll("job")
      .select("repository.full_name as repository_full_name")
      .where("job.tenant_id", "=", identity.tenantId)
      .orderBy("job.created_at", "desc")
      .limit(100)
      .execute();
    return { jobs: rows.map(issueJobResource) };
  }

  async acceptGitHubWebhook(
    input: GitHubWebhookInput,
  ): Promise<{ accepted: boolean; replayed: boolean }> {
    try {
      return await this.#acceptGitHubWebhook(input);
    } catch (error: unknown) {
      if (
        input.deliveryId === undefined ||
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "23505"
      ) {
        throw error;
      }
      const payloadSha256 = createHash("sha256").update(input.rawBody).digest("hex");
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const existing = await this.#database
          .selectFrom("source_control_webhook_deliveries")
          .select(["payload_sha256", "state"])
          .where("provider", "=", "github")
          .where("delivery_id", "=", input.deliveryId)
          .executeTakeFirst();
        if (existing !== undefined) {
          if (existing.payload_sha256 !== payloadSha256) {
            throw new SourceControlServiceError(
              "source_control_webhook_invalid",
              "GitHub delivery identity was reused for another payload",
            );
          }
          return { accepted: existing.state === "accepted", replayed: true };
        }
        await delay(10 * (attempt + 1));
      }
      throw error;
    }
  }

  async #acceptGitHubWebhook(
    input: GitHubWebhookInput,
  ): Promise<{ accepted: boolean; replayed: boolean }> {
    const github = this.#requireGitHub();
    if (
      input.deliveryId === undefined ||
      input.eventName === undefined ||
      input.deliveryId.length > 128 ||
      input.eventName.length > 64 ||
      !github.client.verifyWebhook(input.rawBody, input.signature)
    ) {
      throw new SourceControlServiceError(
        "source_control_webhook_invalid",
        "GitHub Webhook signature or identity is invalid",
      );
    }
    const payloadSha256 = createHash("sha256").update(input.rawBody).digest("hex");
    await this.#database
      .deleteFrom("source_control_webhook_deliveries")
      .where("issue_job_id", "is", null)
      .where("settled_at", "<", new Date(this.#clock().valueOf() - 30 * 24 * 60 * 60_000))
      .execute();
    const existing = await this.#database
      .selectFrom("source_control_webhook_deliveries")
      .select(["payload_sha256", "state"])
      .where("provider", "=", "github")
      .where("delivery_id", "=", input.deliveryId)
      .executeTakeFirst();
    if (existing !== undefined) {
      if (existing.payload_sha256 !== payloadSha256) {
        throw new SourceControlServiceError(
          "source_control_webhook_invalid",
          "GitHub delivery identity was reused for another payload",
        );
      }
      return { accepted: existing.state === "accepted", replayed: true };
    }
    let payload: Record<string, unknown>;
    try {
      payload = record(JSON.parse(Buffer.from(input.rawBody).toString("utf8")))!;
    } catch {
      throw new SourceControlServiceError(
        "source_control_webhook_invalid",
        "GitHub Webhook payload is invalid",
      );
    }
    if (payload === undefined) {
      throw new SourceControlServiceError(
        "source_control_webhook_invalid",
        "GitHub Webhook payload is invalid",
      );
    }
    const action = typeof payload.action === "string" ? payload.action.slice(0, 64) : null;
    const providerInstallationId = decimalId(record(payload.installation)?.id);
    const providerRepositoryId = decimalId(record(payload.repository)?.id);
    const installation =
      providerInstallationId === undefined
        ? undefined
        : await this.#database
            .selectFrom("source_control_installations")
            .selectAll()
            .where("provider", "=", "github")
            .where("provider_installation_id", "=", providerInstallationId)
            .executeTakeFirst();
    const repository =
      installation === undefined ||
      installation.state !== "active" ||
      providerRepositoryId === undefined
        ? undefined
        : await this.#database
            .selectFrom("source_control_repositories")
            .selectAll()
            .where("tenant_id", "=", installation.tenant_id)
            .where("provider", "=", "github")
            .where("provider_repository_id", "=", providerRepositoryId)
            .where("state", "=", "active")
            .executeTakeFirst();
    const trigger = this.#issueTrigger(input.eventName, payload, github.issueLabel);
    const now = this.#clock();
    if (installation !== undefined && input.eventName === "installation") {
      const nextState =
        action === "deleted"
          ? "deleted"
          : action === "suspend"
            ? "suspended"
            : action === "unsuspend"
              ? "active"
              : undefined;
      if (nextState !== undefined) {
        await this.#database.transaction().execute(async (transaction) => {
          await transaction
            .updateTable("source_control_installations")
            .set({
              state: nextState,
              suspended_at: nextState === "suspended" ? now : null,
              updated_at: now,
            })
            .where("id", "=", installation.id)
            .executeTakeFirstOrThrow();
          if (nextState === "deleted") {
            await transaction
              .updateTable("source_control_repositories")
              .set({ state: "removed", updated_at: now })
              .where("installation_id", "=", installation.id)
              .execute();
          }
          await transaction
            .insertInto("source_control_webhook_deliveries")
            .values({
              provider: "github",
              delivery_id: input.deliveryId!,
              event_name: input.eventName!,
              action,
              payload_sha256: payloadSha256,
              installation_id: installation.id,
              repository_id: null,
              state: "completed",
              issue_job_id: null,
              failure_code: null,
              received_at: now,
              settled_at: now,
            })
            .executeTakeFirstOrThrow();
        });
        return { accepted: false, replayed: false };
      }
    }
    if (installation === undefined || repository === undefined || trigger === undefined) {
      await this.#database
        .insertInto("source_control_webhook_deliveries")
        .values({
          provider: "github",
          delivery_id: input.deliveryId,
          event_name: input.eventName,
          action,
          payload_sha256: payloadSha256,
          installation_id: installation?.id ?? null,
          repository_id: repository?.id ?? null,
          state: "ignored",
          issue_job_id: null,
          failure_code: null,
          received_at: now,
          settled_at: now,
        })
        .executeTakeFirstOrThrow();
      return { accepted: false, replayed: false };
    }
    const previous = await this.#database
      .selectFrom("source_control_issue_jobs")
      .select("id")
      .where("repository_id", "=", repository.id)
      .where("issue_number", "=", trigger.issueNumber)
      .where("state", "in", [
        "received",
        "provisioning",
        "queued",
        "running",
        "publishing",
        "completed",
      ])
      .limit(1)
      .executeTakeFirst();
    if (previous !== undefined) {
      await this.#database
        .insertInto("source_control_webhook_deliveries")
        .values({
          provider: "github",
          delivery_id: input.deliveryId,
          event_name: input.eventName,
          action,
          payload_sha256: payloadSha256,
          installation_id: installation.id,
          repository_id: repository.id,
          state: "ignored",
          issue_job_id: null,
          failure_code: null,
          received_at: now,
          settled_at: now,
        })
        .executeTakeFirstOrThrow();
      return { accepted: false, replayed: false };
    }
    const jobId = this.#idGenerator();
    const branchName = `picloud/issue-${String(trigger.issueNumber)}-${jobId.slice(0, 8)}`;
    let accepted = true;
    await this.#database.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${repository.id}:${String(trigger.issueNumber)}`}, 0))`.execute(
        transaction,
      );
      const concurrent = await transaction
        .selectFrom("source_control_issue_jobs")
        .select("id")
        .where("repository_id", "=", repository.id)
        .where("issue_number", "=", trigger.issueNumber)
        .where("state", "in", [
          "received",
          "provisioning",
          "queued",
          "running",
          "publishing",
          "completed",
        ])
        .limit(1)
        .executeTakeFirst();
      if (concurrent !== undefined) {
        accepted = false;
        await transaction
          .insertInto("source_control_webhook_deliveries")
          .values({
            provider: "github",
            delivery_id: input.deliveryId!,
            event_name: input.eventName!,
            action,
            payload_sha256: payloadSha256,
            installation_id: installation.id,
            repository_id: repository.id,
            state: "ignored",
            issue_job_id: null,
            failure_code: null,
            received_at: now,
            settled_at: now,
          })
          .executeTakeFirstOrThrow();
        return;
      }
      await transaction
        .insertInto("source_control_webhook_deliveries")
        .values({
          provider: "github",
          delivery_id: input.deliveryId!,
          event_name: input.eventName!,
          action,
          payload_sha256: payloadSha256,
          installation_id: installation.id,
          repository_id: repository.id,
          state: "accepted",
          issue_job_id: null,
          failure_code: null,
          received_at: now,
          settled_at: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("source_control_issue_jobs")
        .values({
          id: jobId,
          tenant_id: installation.tenant_id,
          provider: "github",
          webhook_delivery_id: input.deliveryId!,
          repository_id: repository.id,
          issue_number: trigger.issueNumber,
          issue_title: trigger.title,
          issue_body: trigger.body,
          issue_url: trigger.url,
          trigger_kind: trigger.kind,
          trigger_actor: trigger.actor,
          state: "received",
          project_id: null,
          workspace_id: null,
          session_id: null,
          run_id: null,
          branch_name: branchName,
          commit_sha: null,
          pull_request_number: null,
          pull_request_url: null,
          issue_comment_id: null,
          owner_id: null,
          lease_expires_at: null,
          failure_code: null,
          failure_message: null,
          available_at: now,
          created_at: now,
          updated_at: now,
          settled_at: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("source_control_webhook_deliveries")
        .set({ issue_job_id: jobId })
        .where("provider", "=", "github")
        .where("delivery_id", "=", input.deliveryId!)
        .executeTakeFirstOrThrow();
    });
    return { accepted, replayed: false };
  }

  async checkoutIssueWorkspace(input: {
    tenantId: string;
    repositoryId: string;
    workspaceId: string;
    branchName: string;
  }): Promise<string> {
    const repository = await this.#repository(input.tenantId, input.repositoryId);
    return this.#checkout(repository, input.workspaceId, input.branchName);
  }

  async publishIssueWorkspace(input: {
    tenantId: string;
    repositoryId: string;
    workspaceId: string;
    branchName: string;
    commitMessage: string;
  }): Promise<{ changed: boolean; commitSha?: string }> {
    const github = this.#requireGitHub();
    const repository = await this.#repository(input.tenantId, input.repositoryId);
    const token = await github.client.installationToken(
      repository.provider_installation_id,
      repository.provider_repository_id,
      { contents: "write" },
    );
    const client = this.#toolBroker(
      await this.#workspaceToolBroker(input.tenantId, input.workspaceId),
    );
    const response = await client.publishSource({
      sourceControlProtocolVersion: 1,
      type: "source_control.workspace_publish",
      requestId: this.#idGenerator(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      repositoryId: repository.id,
      providerInstallationId: repository.provider_installation_id,
      providerRepositoryId: repository.provider_repository_id,
      cloneUrl: repository.clone_url,
      baseRef: repository.default_branch,
      branchName: input.branchName,
      commitMessage: input.commitMessage,
      authorName: "PiCloud Agent",
      authorEmail: "picloud-agent@users.noreply.github.com",
      accessToken: token.token,
    });
    return response.changed
      ? { changed: true, commitSha: response.commitSha! }
      : { changed: false };
  }

  githubClient(): GitHubAppClient {
    return this.#requireGitHub().client;
  }

  async repositoryForJob(repositoryId: string) {
    return this.#database
      .selectFrom("source_control_repositories as repository")
      .innerJoin("source_control_installations as installation", (join) =>
        join
          .onRef("installation.tenant_id", "=", "repository.tenant_id")
          .onRef("installation.id", "=", "repository.installation_id"),
      )
      .select([
        "repository.id",
        "repository.tenant_id",
        "repository.owner",
        "repository.name",
        "repository.full_name",
        "repository.default_branch",
        "repository.provider_repository_id",
        "installation.provider_installation_id",
      ])
      .where("repository.id", "=", repositoryId)
      .where("repository.state", "=", "active")
      .where("installation.state", "=", "active")
      .executeTakeFirst();
  }

  async #checkout(
    repository: ConnectedRepository,
    workspaceId: string,
    branchName: string,
  ): Promise<string> {
    const github = this.#requireGitHub();
    let token;
    try {
      token = await github.client.installationToken(
        repository.provider_installation_id,
        repository.provider_repository_id,
        { contents: "read" },
      );
    } catch (error: unknown) {
      throw this.#githubFailure(error);
    }
    const response = await this.#toolBroker(
      await this.#workspaceToolBroker(repository.tenant_id, workspaceId),
    ).checkoutSource({
      sourceControlProtocolVersion: 1,
      type: "source_control.workspace_checkout",
      requestId: this.#idGenerator(),
      tenantId: repository.tenant_id,
      workspaceId,
      repositoryId: repository.id,
      providerInstallationId: repository.provider_installation_id,
      providerRepositoryId: repository.provider_repository_id,
      cloneUrl: repository.clone_url,
      baseRef: repository.default_branch,
      branchName,
      accessToken: token.token,
    });
    return response.baseSha;
  }

  async #repository(tenantId: string, repositoryId: string) {
    const row = await this.#database
      .selectFrom("source_control_repositories as repository")
      .innerJoin("source_control_installations as installation", (join) =>
        join
          .onRef("installation.tenant_id", "=", "repository.tenant_id")
          .onRef("installation.id", "=", "repository.installation_id"),
      )
      .select([
        "repository.id",
        "repository.tenant_id",
        "repository.provider_repository_id",
        "repository.clone_url",
        "repository.default_branch",
        "repository.full_name",
        "installation.provider_installation_id",
      ])
      .where("repository.tenant_id", "=", tenantId)
      .where("repository.id", "=", repositoryId)
      .where("repository.state", "=", "active")
      .where("installation.state", "=", "active")
      .executeTakeFirst();
    if (row === undefined) {
      throw new SourceControlServiceError(
        "source_control_not_found",
        "Connected source repository was not found",
      );
    }
    return row;
  }

  async #workspaceToolBroker(tenantId: string, workspaceId: string): Promise<string> {
    const activationOwner = await this.#database
      .selectFrom("tool_broker_activations")
      .select("owner_base_url as toolBrokerBaseUrl")
      .where("tenant_id", "=", tenantId)
      .where("workspace_id", "=", workspaceId)
      .where("state", "in", ["reserved", "materializing", "active", "warm", "cleaning", "unknown"])
      .orderBy("updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (activationOwner !== undefined) return activationOwner.toolBrokerBaseUrl;
    const terminalOwner = await this.#database
      .selectFrom("workspace_terminal_sessions")
      .select("owner_base_url as toolBrokerBaseUrl")
      .where("tenant_id", "=", tenantId)
      .where("workspace_id", "=", workspaceId)
      .where("state", "in", ["reserved", "materializing", "active", "cleaning", "unknown"])
      .orderBy("updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (terminalOwner !== undefined) return terminalOwner.toolBrokerBaseUrl;
    const route = await this.#database
      .selectFrom("workspaces as workspace")
      .innerJoin("sandbox_domains as domain", "domain.id", "workspace.sandbox_domain_id")
      .select("domain.tool_broker_base_url as toolBrokerBaseUrl")
      .where("workspace.tenant_id", "=", tenantId)
      .where("workspace.id", "=", workspaceId)
      .where("workspace.deleted_at", "is", null)
      .executeTakeFirst();
    if (route === undefined) {
      throw new SourceControlServiceError(
        "source_control_not_found",
        "Workspace source-control route was not found",
      );
    }
    return route.toolBrokerBaseUrl;
  }

  #toolBroker(baseUrl: string): ToolBrokerClient {
    return new ToolBrokerClient({
      baseUrl,
      serviceToken: this.#materializerToken,
      allowInsecureHttp: this.#allowInsecureInternalHttp,
      requestTimeoutMs: 10 * 60_000,
    });
  }

  async #upsertInstallation(
    transaction: Transaction<Database>,
    identity: TenantRequestIdentity,
    installation: Awaited<ReturnType<GitHubAppClient["installation"]>>,
    repositories: Awaited<ReturnType<GitHubAppClient["repositories"]>>,
    now: Date,
  ): Promise<void> {
    const existing = await transaction
      .selectFrom("source_control_installations")
      .select(["id", "tenant_id"])
      .where("provider", "=", "github")
      .where("provider_installation_id", "=", installation.id)
      .forUpdate()
      .executeTakeFirst();
    if (existing !== undefined && existing.tenant_id !== identity.tenantId) {
      throw new SourceControlServiceError(
        "source_control_conflict",
        "GitHub installation is already connected to another tenant",
      );
    }
    const id = existing?.id ?? this.#idGenerator();
    await transaction
      .insertInto("source_control_installations")
      .values({
        id,
        tenant_id: identity.tenantId,
        connected_by_user_id: identity.userId,
        provider: "github",
        provider_installation_id: installation.id,
        account_id: installation.account.id,
        account_login: installation.account.login,
        account_type: installation.account.type,
        repository_selection: installation.repositorySelection,
        state: installation.suspendedAt === undefined ? "active" : "suspended",
        suspended_at: installation.suspendedAt ?? null,
        installed_at: now,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          connected_by_user_id: identity.userId,
          account_id: installation.account.id,
          account_login: installation.account.login,
          account_type: installation.account.type,
          repository_selection: installation.repositorySelection,
          state: installation.suspendedAt === undefined ? "active" : "suspended",
          suspended_at: installation.suspendedAt ?? null,
          updated_at: now,
        }),
      )
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("source_control_repositories")
      .set({ state: "removed", updated_at: now })
      .where("installation_id", "=", id)
      .execute();
    for (const repository of repositories) {
      const existingRepository = await transaction
        .selectFrom("source_control_repositories")
        .select(["id", "tenant_id"])
        .where("provider", "=", "github")
        .where("provider_repository_id", "=", repository.id)
        .executeTakeFirst();
      if (existingRepository !== undefined && existingRepository.tenant_id !== identity.tenantId) {
        throw new SourceControlServiceError(
          "source_control_conflict",
          "GitHub repository is already connected to another tenant",
        );
      }
      await transaction
        .insertInto("source_control_repositories")
        .values({
          id: existingRepository?.id ?? this.#idGenerator(),
          tenant_id: identity.tenantId,
          installation_id: id,
          provider: "github",
          provider_repository_id: repository.id,
          owner: repository.owner,
          name: repository.name,
          full_name: repository.fullName,
          private: repository.private,
          default_branch: repository.defaultBranch,
          clone_url: repository.cloneUrl,
          state: "active",
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            installation_id: id,
            owner: repository.owner,
            name: repository.name,
            full_name: repository.fullName,
            private: repository.private,
            default_branch: repository.defaultBranch,
            clone_url: repository.cloneUrl,
            state: "active",
            updated_at: now,
          }),
        )
        .executeTakeFirstOrThrow();
    }
  }

  #issueTrigger(eventName: string, payload: Record<string, unknown>, issueLabel: string) {
    const issue = record(payload.issue);
    const repository = record(payload.repository);
    const sender = record(payload.sender);
    const action = payload.action;
    if (issue === undefined || repository === undefined || sender === undefined) return undefined;
    if (record(issue.pull_request) !== undefined) return undefined;
    const issueNumber = Number(issue.number);
    const title = boundedText(issue.title, 512);
    const body = typeof issue.body === "string" ? (boundedText(issue.body, 90_000) ?? "") : "";
    const url = boundedText(issue.html_url, 2_048);
    const actor = boundedText(sender.login, 255);
    if (
      !Number.isSafeInteger(issueNumber) ||
      issueNumber < 1 ||
      title === undefined ||
      url === undefined ||
      actor === undefined
    ) {
      return undefined;
    }
    if (
      eventName === "issues" &&
      action === "labeled" &&
      boundedText(record(payload.label)?.name, 255)?.toLowerCase() === issueLabel.toLowerCase()
    ) {
      return { kind: "label" as const, issueNumber, title, body, url, actor };
    }
    const comment = record(payload.comment);
    if (
      eventName === "issue_comment" &&
      action === "created" &&
      comment?.body === "/picloud solve" &&
      typeof comment.author_association === "string" &&
      TRUSTED_ISSUE_ASSOCIATIONS.has(comment.author_association)
    ) {
      return { kind: "comment" as const, issueNumber, title, body, url, actor };
    }
    return undefined;
  }

  #requireGitHub(): GitHubAppRuntime {
    if (this.#github === undefined) {
      throw new SourceControlServiceError(
        "source_control_unavailable",
        "GitHub App integration is not configured",
      );
    }
    return this.#github;
  }

  #githubFailure(error: unknown): SourceControlServiceError {
    if (error instanceof SourceControlServiceError) return error;
    if (error instanceof GitHubAppClientError) {
      return new SourceControlServiceError(
        "source_control_operation_failed",
        error.message,
        error.retryable,
      );
    }
    return new SourceControlServiceError(
      "source_control_operation_failed",
      "Source-control operation failed",
      true,
    );
  }
}
