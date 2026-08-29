import type {
  Database,
  SourceControlInstallationTable,
  SourceControlIssueJobState,
  SourceControlProvider,
  SourceControlRepositoryTable,
} from "@pi-cloud/database";
import type {
  ConnectGitLabProjectRequest,
  CreateProjectRequest,
  ProjectResource,
  SourceControlConfigurationResource,
  SourceControlInstallLinkResource,
  SourceControlIssueJobListResource,
  SourceControlIssueJobResource,
  StartSourceControlIssueJobRequest,
} from "@pi-cloud/protocol";
import { ToolBrokerClient } from "@pi-cloud/tool-broker/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import type { ControlPlaneStore } from "./control-plane-store.ts";
import { GitHubAppClient, GitHubAppClientError } from "./github-app-client.ts";
import {
  GitLabProjectClient,
  GitLabProjectClientError,
  canonicalGitLabBaseUrl,
} from "./gitlab-project-client.ts";
import { SourceControlCredentialVault } from "./source-control-credential-vault.ts";
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

export type GitLabProjectRuntime = Readonly<{
  vault: SourceControlCredentialVault;
  webhookUrl: string;
  publicOrigin: string;
  issueLabel: string;
  internalBaseUrl?: string;
  fetch?: typeof fetch;
}>;

function internalGitLabCloneUrl(cloneUrl: string, internalBaseUrl: string | undefined): string {
  if (internalBaseUrl === undefined) return cloneUrl;
  const source = new URL(cloneUrl);
  const target = new URL(internalBaseUrl);
  target.pathname = source.pathname;
  target.search = source.search;
  return target.toString();
}

type ConnectedRepository = Readonly<{
  id: string;
  installation_id: string;
  tenant_id: string;
  provider_repository_id: string;
  clone_url: string;
  default_branch: string;
  full_name: string;
  provider_installation_id: string;
  provider: "github" | "gitlab";
  provider_base_url: string;
}>;

type GitHubWebhookInput = Readonly<{
  deliveryId: string | undefined;
  eventName: string | undefined;
  signature: string | undefined;
  rawBody: Uint8Array;
}>;

type GitLabWebhookInput = Readonly<{
  deliveryId: string | undefined;
  eventName: string | undefined;
  instance: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: Uint8Array;
}>;

type IssueTrigger = Readonly<{
  kind: "label" | "comment";
  issueNumber: number;
  title: string;
  body: string;
  url: string;
  actor: string;
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

function issueJobResource(
  row: {
    id: string;
    repository_id: string;
    repository_full_name: string;
    issue_number: number;
    issue_title: string;
    issue_url: string;
    state: SourceControlIssueJobState;
    session_id: string | null;
    run_id: string | null;
    change_request_url: string | null;
    failure_message: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  },
  claims: readonly {
    userId: string;
    username: string;
    displayName: string;
    claimedAt: Date | string;
  }[],
  identity: TenantRequestIdentity,
  claimEligible: boolean,
) {
  return {
    jobId: row.id,
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name,
    issueNumber: row.issue_number,
    issueTitle: row.issue_title,
    issueUrl: row.issue_url,
    state: row.state,
    claimEligible,
    claimedByCurrentUser: claims.some((claim) => claim.userId === identity.userId),
    claims: claims.map((claim) => ({
      userId: claim.userId,
      username: claim.username,
      displayName: claim.displayName,
      claimedAt: iso(claim.claimedAt),
    })),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.run_id === null ? {} : { runId: row.run_id }),
    ...(row.change_request_url === null ? {} : { changeRequestUrl: row.change_request_url }),
    ...(row.failure_message === null ? {} : { failure: row.failure_message }),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  } as const;
}

export class SourceControlService {
  readonly #database: Kysely<Database>;
  readonly #github: GitHubAppRuntime | undefined;
  readonly #gitlab: GitLabProjectRuntime | undefined;
  readonly #materializerToken: string;
  readonly #allowInsecureInternalHttp: boolean;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;

  constructor(options: {
    database: Kysely<Database>;
    github?: GitHubAppRuntime;
    gitlab?: GitLabProjectRuntime;
    materializerToken?: string;
    allowInsecureInternalHttp?: boolean;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.#database = options.database;
    this.#github = options.github;
    this.#gitlab = options.gitlab;
    this.#materializerToken =
      options.materializerToken ?? "source-control-disabled-materializer-token-000000000000000";
    this.#allowInsecureInternalHttp = options.allowInsecureInternalHttp ?? false;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  get configured(): boolean {
    return this.#github !== undefined || this.#gitlab !== undefined;
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
      githubConfigured: this.#github !== undefined,
      gitlabConfigured: this.#gitlab !== undefined,
      installations: installations.map((installation) => ({
        installationId: installation.id,
        provider: installation.provider,
        providerBaseUrl: installation.provider_base_url,
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
            provider: repository.provider,
            providerBaseUrl: repository.provider_base_url,
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

  async connectGitLabProject(
    identity: TenantRequestIdentity,
    request: ConnectGitLabProjectRequest,
  ): Promise<SourceControlConfigurationResource> {
    const gitlab = this.#requireGitLab();
    if (identity.role === "viewer") {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "Viewer accounts cannot connect source repositories",
      );
    }
    const baseUrl = canonicalGitLabBaseUrl(request.baseUrl);
    const client = new GitLabProjectClient({
      baseUrl: gitlab.internalBaseUrl ?? baseUrl,
      publicBaseUrl: baseUrl,
      accessToken: request.accessToken,
      ...(gitlab.fetch === undefined ? {} : { fetch: gitlab.fetch }),
    });
    let project;
    try {
      project = await client.project(request.project);
    } catch (error: unknown) {
      throw this.#providerFailure(error);
    }
    const existing = await this.#database
      .selectFrom("source_control_installations")
      .select(["id", "tenant_id"])
      .where("provider", "=", "gitlab")
      .where("provider_base_url", "=", baseUrl)
      .where("provider_installation_id", "=", project.id)
      .executeTakeFirst();
    if (existing !== undefined && existing.tenant_id !== identity.tenantId) {
      throw new SourceControlServiceError(
        "source_control_conflict",
        "GitLab project is already connected to another tenant",
      );
    }
    const installationId = existing?.id ?? this.#idGenerator();
    const credentialVersion =
      (
        await this.#database
          .selectFrom("source_control_credentials")
          .select("version")
          .where("installation_id", "=", installationId)
          .executeTakeFirst()
      )?.version ?? 0;
    const version = credentialVersion + 1;
    const signingToken = `whsec_${randomBytes(32).toString("base64")}`;
    try {
      await client.ensureWebhook({
        projectId: project.id,
        url: gitlab.webhookUrl,
        signingToken,
      });
    } catch (error: unknown) {
      throw this.#providerFailure(error);
    }
    const sealed = gitlab.vault.seal(
      { tenantId: identity.tenantId, installationId, provider: "gitlab", version },
      { accessToken: request.accessToken, webhookSigningToken: signingToken },
    );
    const now = this.#clock();
    const cloneUrl = internalGitLabCloneUrl(project.cloneUrl, gitlab.internalBaseUrl);
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("source_control_installations")
        .values({
          id: installationId,
          tenant_id: identity.tenantId,
          connected_by_user_id: identity.userId,
          provider: "gitlab",
          provider_base_url: baseUrl,
          provider_installation_id: project.id,
          account_id: project.namespaceId,
          account_login: project.namespace,
          account_type: project.namespaceKind,
          repository_selection: "selected",
          state: "active",
          suspended_at: null,
          installed_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            connected_by_user_id: identity.userId,
            account_id: project.namespaceId,
            account_login: project.namespace,
            account_type: project.namespaceKind,
            state: "active",
            suspended_at: null,
            updated_at: now,
          }),
        )
        .executeTakeFirstOrThrow();
      const existingRepository = await transaction
        .selectFrom("source_control_repositories")
        .select("id")
        .where("provider", "=", "gitlab")
        .where("provider_base_url", "=", baseUrl)
        .where("provider_repository_id", "=", project.id)
        .executeTakeFirst();
      await transaction
        .insertInto("source_control_repositories")
        .values({
          id: existingRepository?.id ?? this.#idGenerator(),
          tenant_id: identity.tenantId,
          installation_id: installationId,
          provider: "gitlab",
          provider_base_url: baseUrl,
          provider_repository_id: project.id,
          owner: project.namespace,
          name: project.name,
          full_name: project.fullName,
          private: project.private,
          default_branch: project.defaultBranch,
          clone_url: cloneUrl,
          state: "active",
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            installation_id: installationId,
            owner: project.namespace,
            name: project.name,
            full_name: project.fullName,
            private: project.private,
            default_branch: project.defaultBranch,
            clone_url: cloneUrl,
            state: "active",
            updated_at: now,
          }),
        )
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("source_control_credentials")
        .values({
          tenant_id: identity.tenantId,
          installation_id: installationId,
          provider: "gitlab",
          version,
          key_version: sealed.keyVersion,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
          auth_tag: sealed.authTag,
          secret_sha256: sealed.secretSha256,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          conflict.column("installation_id").doUpdateSet({
            version,
            key_version: sealed.keyVersion,
            nonce: sealed.nonce,
            ciphertext: sealed.ciphertext,
            auth_tag: sealed.authTag,
            secret_sha256: sealed.secretSha256,
            updated_at: now,
          }),
        )
        .executeTakeFirstOrThrow();
    });
    return this.configuration(identity);
  }

  async refreshInstallation(
    identity: TenantRequestIdentity,
    installationId: string,
  ): Promise<void> {
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
        "Source-control connection was not found",
      );
    }
    if (row.provider === "gitlab") {
      const { client, credential } = await this.#gitlabClient(row);
      try {
        const project = await client.project(row.provider_installation_id);
        await client.ensureWebhook({
          projectId: project.id,
          url: this.#requireGitLab().webhookUrl,
          signingToken: credential.webhookSigningToken,
        });
        await this.#database.transaction().execute(async (transaction) => {
          await transaction
            .updateTable("source_control_installations")
            .set({
              account_id: project.namespaceId,
              account_login: project.namespace,
              account_type: project.namespaceKind,
              state: "active",
              suspended_at: null,
              updated_at: this.#clock(),
            })
            .where("tenant_id", "=", identity.tenantId)
            .where("id", "=", row.id)
            .executeTakeFirstOrThrow();
          await transaction
            .updateTable("source_control_repositories")
            .set({
              owner: project.namespace,
              name: project.name,
              full_name: project.fullName,
              private: project.private,
              default_branch: project.defaultBranch,
              clone_url: project.cloneUrl,
              state: "active",
              updated_at: this.#clock(),
            })
            .where("tenant_id", "=", identity.tenantId)
            .where("installation_id", "=", row.id)
            .where("provider_repository_id", "=", project.id)
            .executeTakeFirstOrThrow();
        });
        return;
      } catch (error: unknown) {
        throw this.#providerFailure(error);
      }
    }
    const github = this.#requireGitHub();
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
    request: CreateProjectRequest & {
      source: { kind: "source_control"; repositoryId: string };
    },
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
          kind: "source_control",
          status: "ready",
          repositoryId: repository.id,
          provider: repository.provider,
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
          failure_code:
            error instanceof GitHubAppClientError || error instanceof GitLabProjectClientError
              ? error.code
              : "checkout_failed",
          updated_at: this.#clock(),
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("workspace_id", "=", project.workspaceId)
        .execute();
      await store
        .deleteWorkspace(project.workspaceId, `source-checkout-failed-${project.workspaceId}`)
        .catch(() => undefined);
      throw error instanceof SourceControlServiceError ? error : this.#providerFailure(error);
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
      .select([
        "repository.full_name as repository_full_name",
        "repository.provider as repository_provider",
        "repository.provider_base_url as repository_provider_base_url",
      ])
      .where("job.tenant_id", "=", identity.tenantId)
      .orderBy("job.created_at", "desc")
      .limit(100)
      .execute();
    const claims =
      rows.length === 0
        ? []
        : await this.#database
            .selectFrom("source_control_issue_claims as claim")
            .innerJoin("external_identities as external", (join) =>
              join
                .onRef("external.tenant_id", "=", "claim.tenant_id")
                .onRef("external.id", "=", "claim.external_identity_id"),
            )
            .innerJoin("users as user_row", (join) =>
              join
                .onRef("user_row.tenant_id", "=", "claim.tenant_id")
                .onRef("user_row.id", "=", "claim.user_id"),
            )
            .select([
              "claim.issue_job_id as issueJobId",
              "claim.user_id as userId",
              "claim.claimed_at as claimedAt",
              "external.username",
              "user_row.display_name as displayName",
            ])
            .where(
              "claim.issue_job_id",
              "in",
              rows.map((row) => row.id),
            )
            .orderBy("claim.claimed_at", "asc")
            .execute();
    return {
      jobs: rows.map((row) =>
        issueJobResource(
          row,
          claims.filter((claim) => claim.issueJobId === row.id),
          identity,
          identity.externalIdentity?.providerKey === "gitlab" &&
            row.repository_provider === "gitlab" &&
            identity.externalIdentity.issuer === row.repository_provider_base_url,
        ),
      ),
    };
  }

  async claimIssueJob(
    identity: TenantRequestIdentity,
    jobId: string,
  ): Promise<SourceControlIssueJobResource> {
    const context = await this.#assertGitLabClaimIdentity(identity, jobId);
    const now = this.#clock();
    await this.#database.transaction().execute(async (transaction) => {
      const job = await transaction
        .selectFrom("source_control_issue_jobs")
        .select("state")
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", jobId)
        .forUpdate()
        .executeTakeFirst();
      if (job?.state !== "awaiting_claim") {
        throw new SourceControlServiceError(
          "source_control_conflict",
          "Issue request is no longer awaiting claims",
        );
      }
      await transaction
        .insertInto("source_control_issue_claims")
        .values({
          tenant_id: identity.tenantId,
          issue_job_id: jobId,
          user_id: identity.userId,
          external_identity_id: context.externalIdentityId,
          claimed_at: now,
        })
        .onConflict((conflict) => conflict.columns(["issue_job_id", "user_id"]).doNothing())
        .execute();
      await transaction
        .updateTable("source_control_issue_jobs")
        .set({ claim_sync_pending: true, updated_at: now })
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow();
    });
    return this.#issueJob(identity, jobId);
  }

  async unclaimIssueJob(
    identity: TenantRequestIdentity,
    jobId: string,
  ): Promise<SourceControlIssueJobResource> {
    if (identity.externalIdentity?.providerKey !== "gitlab") {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "GitLab login is required to cancel an Issue claim",
      );
    }
    const now = this.#clock();
    await this.#database.transaction().execute(async (transaction) => {
      const job = await transaction
        .selectFrom("source_control_issue_jobs")
        .select("state")
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", jobId)
        .forUpdate()
        .executeTakeFirst();
      if (job === undefined) {
        throw new SourceControlServiceError(
          "source_control_not_found",
          "Issue request was not found",
        );
      }
      if (job.state !== "awaiting_claim") {
        throw new SourceControlServiceError(
          "source_control_conflict",
          "Issue request is no longer awaiting claims",
        );
      }
      await transaction
        .deleteFrom("source_control_issue_claims")
        .where("tenant_id", "=", identity.tenantId)
        .where("issue_job_id", "=", jobId)
        .where("user_id", "=", identity.userId)
        .execute();
      await transaction
        .updateTable("source_control_issue_jobs")
        .set({ claim_sync_pending: true, updated_at: now })
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow();
    });
    return this.#issueJob(identity, jobId);
  }

  async startIssueJob(
    identity: TenantRequestIdentity,
    jobId: string,
    request: StartSourceControlIssueJobRequest,
  ): Promise<SourceControlIssueJobResource> {
    await this.#assertGitLabClaimIdentity(identity, jobId);
    const now = this.#clock();
    await this.#database.transaction().execute(async (transaction) => {
      const job = await transaction
        .selectFrom("source_control_issue_jobs")
        .select("state")
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", jobId)
        .forUpdate()
        .executeTakeFirst();
      if (job?.state !== "awaiting_claim") {
        throw new SourceControlServiceError(
          "source_control_conflict",
          "Issue request has already started or settled",
        );
      }
      const claim = await transaction
        .selectFrom("source_control_issue_claims")
        .select("user_id")
        .where("issue_job_id", "=", jobId)
        .where("tenant_id", "=", identity.tenantId)
        .where("user_id", "=", identity.userId)
        .executeTakeFirst();
      if (claim === undefined) {
        throw new SourceControlServiceError(
          "source_control_authorization_denied",
          "Claim the Issue before starting its Agent",
        );
      }
      let projectId: string | null = null;
      let workspaceId: string | null = null;
      let profileKey: "starter" | "standard" | "performance" | null = null;
      let developmentEnvironmentId: string | null = null;
      let workingDirectory = "/workspace";
      if (request.executionMode === "elastic") {
        profileKey = request.sandboxProfileKey;
      } else {
        if (
          !request.workingDirectory.startsWith("/home/user/") ||
          request.workingDirectory.endsWith("/") ||
          request.workingDirectory
            .slice("/home/user/".length)
            .split("/")
            .some((segment) => segment.length === 0 || segment === "." || segment === "..")
        ) {
          throw new SourceControlServiceError(
            "source_control_conflict",
            "Choose an Issue work directory inside the cloud development machine home directory",
          );
        }
        const environment = await transaction
          .selectFrom("development_environments")
          .select(["id", "project_id", "workspace_id", "profile_key", "state"])
          .where("tenant_id", "=", identity.tenantId)
          .where("id", "=", request.developmentEnvironmentId)
          .where("owner_user_id", "=", identity.userId)
          .forUpdate()
          .executeTakeFirst();
        if (environment === undefined || environment.state !== "running") {
          throw new SourceControlServiceError(
            "source_control_conflict",
            "Selected cloud development machine is not running or is not owned by this user",
          );
        }
        projectId = environment.project_id;
        workspaceId = environment.workspace_id;
        developmentEnvironmentId = environment.id;
        workingDirectory = request.workingDirectory;
        if (
          environment.profile_key !== "starter" &&
          environment.profile_key !== "standard" &&
          environment.profile_key !== "performance"
        ) {
          throw new SourceControlServiceError(
            "source_control_operation_failed",
            "Cloud development machine profile is invalid",
          );
        }
        profileKey = environment.profile_key;
      }
      await transaction
        .updateTable("source_control_issue_jobs")
        .set({
          state: "received",
          started_by_user_id: identity.userId,
          execution_mode: request.executionMode,
          sandbox_profile_key: profileKey,
          development_environment_id: developmentEnvironmentId,
          working_directory: workingDirectory,
          project_id: projectId,
          workspace_id: workspaceId,
          available_at: now,
          settled_at: null,
          failure_code: null,
          failure_message: null,
          updated_at: now,
          claim_sync_pending: true,
        })
        .where("id", "=", jobId)
        .executeTakeFirstOrThrow();
    });
    return this.#issueJob(identity, jobId);
  }

  async reconcileNextClaimSync(): Promise<boolean> {
    const jobId = await this.#database.transaction().execute(async (transaction) => {
      const pending = await transaction
        .selectFrom("source_control_issue_jobs")
        .select("id")
        .where("provider", "=", "gitlab")
        .where("claim_sync_pending", "=", true)
        .orderBy("updated_at", "asc")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (pending === undefined) return undefined;
      await transaction
        .updateTable("source_control_issue_jobs")
        .set({ claim_sync_pending: false })
        .where("id", "=", pending.id)
        .executeTakeFirstOrThrow();
      return pending.id;
    });
    if (jobId === undefined) return false;
    try {
      await this.#syncGitLabIssueClaims(jobId);
    } catch (error: unknown) {
      await this.#database
        .updateTable("source_control_issue_jobs")
        .set({ claim_sync_pending: true, updated_at: this.#clock() })
        .where("id", "=", jobId)
        .execute()
        .catch(() => undefined);
      throw error;
    }
    return true;
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

  async acceptGitLabWebhook(
    input: GitLabWebhookInput,
  ): Promise<{ accepted: boolean; replayed: boolean }> {
    const gitlab = this.#requireGitLab();
    if (
      input.deliveryId === undefined ||
      input.eventName === undefined ||
      input.instance === undefined ||
      input.deliveryId.length > 96 ||
      input.eventName.length > 64
    ) {
      throw new SourceControlServiceError(
        "source_control_webhook_invalid",
        "GitLab Webhook identity is invalid",
      );
    }
    let baseUrl: string;
    let payload: Record<string, unknown>;
    try {
      baseUrl = canonicalGitLabBaseUrl(input.instance);
      payload = record(JSON.parse(Buffer.from(input.rawBody).toString("utf8")))!;
    } catch {
      throw new SourceControlServiceError(
        "source_control_webhook_invalid",
        "GitLab Webhook payload is invalid",
      );
    }
    const providerRepositoryId = decimalId(record(payload.project)?.id);
    if (payload === undefined || providerRepositoryId === undefined) {
      throw new SourceControlServiceError(
        "source_control_webhook_invalid",
        "GitLab Webhook project identity is invalid",
      );
    }
    const repository = await this.#database
      .selectFrom("source_control_repositories")
      .selectAll()
      .where("provider", "=", "gitlab")
      .where("provider_base_url", "=", baseUrl)
      .where("provider_repository_id", "=", providerRepositoryId)
      .where("state", "=", "active")
      .executeTakeFirst();
    if (repository === undefined) {
      throw new SourceControlServiceError(
        "source_control_webhook_invalid",
        "GitLab Webhook project is not connected",
      );
    }
    const installation = await this.#database
      .selectFrom("source_control_installations")
      .selectAll()
      .where("tenant_id", "=", repository.tenant_id)
      .where("id", "=", repository.installation_id)
      .where("provider", "=", "gitlab")
      .where("state", "=", "active")
      .executeTakeFirst();
    if (installation === undefined) {
      throw new SourceControlServiceError(
        "source_control_webhook_invalid",
        "GitLab Webhook connection is unavailable",
      );
    }
    const { client, credential } = await this.#gitlabClient(installation);
    if (
      !GitLabProjectClient.verifyWebhook({
        signingToken: credential.webhookSigningToken,
        messageId: input.deliveryId,
        timestamp: input.timestamp,
        signature: input.signature,
        rawBody: input.rawBody,
      })
    ) {
      throw new SourceControlServiceError(
        "source_control_webhook_invalid",
        "GitLab Webhook signature is invalid",
      );
    }
    const deliveryId = `${createHash("sha256").update(baseUrl).digest("hex").slice(0, 16)}:${input.deliveryId}`;
    const payloadSha256 = createHash("sha256").update(input.rawBody).digest("hex");
    const existing = await this.#database
      .selectFrom("source_control_webhook_deliveries")
      .select(["payload_sha256", "state"])
      .where("provider", "=", "gitlab")
      .where("delivery_id", "=", deliveryId)
      .executeTakeFirst();
    if (existing !== undefined) {
      if (existing.payload_sha256 !== payloadSha256) {
        throw new SourceControlServiceError(
          "source_control_webhook_invalid",
          "GitLab delivery identity was reused for another payload",
        );
      }
      return { accepted: existing.state === "accepted", replayed: true };
    }
    let trigger = this.#gitlabIssueTrigger(input.eventName, payload, gitlab.issueLabel);
    if (trigger?.kind === "comment") {
      const actorId = decimalId(record(payload.user)?.id);
      const level =
        actorId === undefined
          ? undefined
          : await client.memberAccessLevel(repository.provider_repository_id, actorId);
      if (level === undefined || level < 30) trigger = undefined;
    }
    try {
      return await this.#acceptIssueTrigger({
        provider: "gitlab",
        deliveryId,
        eventName: input.eventName,
        action: boundedText(record(payload.object_attributes)?.action, 64) ?? null,
        payloadSha256,
        installation,
        repository,
        trigger,
        now: this.#clock(),
      });
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "23505"
      ) {
        throw error;
      }
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const concurrent = await this.#database
          .selectFrom("source_control_webhook_deliveries")
          .select(["payload_sha256", "state"])
          .where("provider", "=", "gitlab")
          .where("delivery_id", "=", deliveryId)
          .executeTakeFirst();
        if (concurrent !== undefined) {
          if (concurrent.payload_sha256 !== payloadSha256) {
            throw new SourceControlServiceError(
              "source_control_webhook_invalid",
              "GitLab delivery identity was reused for another payload",
            );
          }
          return { accepted: concurrent.state === "accepted", replayed: true };
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
    return this.#acceptIssueTrigger({
      provider: "github",
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      action,
      payloadSha256,
      installation,
      repository,
      trigger,
      now,
    });
  }

  async #acceptIssueTrigger(input: {
    provider: SourceControlProvider;
    deliveryId: string;
    eventName: string;
    action: string | null;
    payloadSha256: string;
    installation: Selectable<SourceControlInstallationTable> | undefined;
    repository: Selectable<SourceControlRepositoryTable> | undefined;
    trigger: IssueTrigger | undefined;
    now: Date;
  }): Promise<{ accepted: boolean; replayed: boolean }> {
    if (
      input.installation === undefined ||
      input.repository === undefined ||
      input.trigger === undefined
    ) {
      await this.#database
        .insertInto("source_control_webhook_deliveries")
        .values({
          provider: input.provider,
          delivery_id: input.deliveryId,
          event_name: input.eventName,
          action: input.action,
          payload_sha256: input.payloadSha256,
          installation_id: input.installation?.id ?? null,
          repository_id: input.repository?.id ?? null,
          state: "ignored",
          issue_job_id: null,
          failure_code: null,
          received_at: input.now,
          settled_at: input.now,
        })
        .executeTakeFirstOrThrow();
      return { accepted: false, replayed: false };
    }
    const installation = input.installation;
    const repository = input.repository;
    const trigger = input.trigger;
    const previous = await this.#database
      .selectFrom("source_control_issue_jobs")
      .select("id")
      .where("repository_id", "=", repository.id)
      .where("issue_number", "=", trigger.issueNumber)
      .where("state", "in", [
        "awaiting_claim",
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
          provider: input.provider,
          delivery_id: input.deliveryId,
          event_name: input.eventName,
          action: input.action,
          payload_sha256: input.payloadSha256,
          installation_id: installation.id,
          repository_id: repository.id,
          state: "ignored",
          issue_job_id: null,
          failure_code: null,
          received_at: input.now,
          settled_at: input.now,
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
          "awaiting_claim",
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
            provider: input.provider,
            delivery_id: input.deliveryId,
            event_name: input.eventName,
            action: input.action,
            payload_sha256: input.payloadSha256,
            installation_id: installation.id,
            repository_id: repository.id,
            state: "ignored",
            issue_job_id: null,
            failure_code: null,
            received_at: input.now,
            settled_at: input.now,
          })
          .executeTakeFirstOrThrow();
        return;
      }
      await transaction
        .insertInto("source_control_webhook_deliveries")
        .values({
          provider: input.provider,
          delivery_id: input.deliveryId,
          event_name: input.eventName,
          action: input.action,
          payload_sha256: input.payloadSha256,
          installation_id: installation.id,
          repository_id: repository.id,
          state: "accepted",
          issue_job_id: null,
          failure_code: null,
          received_at: input.now,
          settled_at: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("source_control_issue_jobs")
        .values({
          id: jobId,
          tenant_id: installation.tenant_id,
          provider: input.provider,
          webhook_delivery_id: input.deliveryId,
          repository_id: repository.id,
          issue_number: trigger.issueNumber,
          issue_title: trigger.title,
          issue_body: trigger.body,
          issue_url: trigger.url,
          trigger_kind: trigger.kind,
          trigger_actor: trigger.actor,
          state: input.provider === "gitlab" ? "awaiting_claim" : "received",
          project_id: null,
          workspace_id: null,
          session_id: null,
          run_id: null,
          branch_name: branchName,
          commit_sha: null,
          change_request_number: null,
          change_request_url: null,
          issue_comment_id: null,
          owner_id: null,
          lease_expires_at: null,
          claim_sync_pending: input.provider === "gitlab",
          started_by_user_id:
            input.provider === "github" ? installation.connected_by_user_id : null,
          execution_mode: input.provider === "github" ? "elastic" : null,
          sandbox_profile_key: input.provider === "github" ? "standard" : null,
          development_environment_id: null,
          working_directory: input.provider === "github" ? "/workspace" : null,
          failure_code: null,
          failure_message: null,
          available_at: input.now,
          created_at: input.now,
          updated_at: input.now,
          settled_at: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("source_control_webhook_deliveries")
        .set({ issue_job_id: jobId })
        .where("provider", "=", input.provider)
        .where("delivery_id", "=", input.deliveryId)
        .executeTakeFirstOrThrow();
    });
    return { accepted, replayed: false };
  }

  async checkoutIssueWorkspace(input: {
    tenantId: string;
    repositoryId: string;
    workspaceId: string;
    branchName: string;
    workTreePath: string;
  }): Promise<string> {
    const repository = await this.#repository(input.tenantId, input.repositoryId);
    return this.#checkout(repository, input.workspaceId, input.branchName, input.workTreePath);
  }

  async publishIssueWorkspace(input: {
    tenantId: string;
    repositoryId: string;
    workspaceId: string;
    branchName: string;
    workTreePath: string;
    commitMessage: string;
  }): Promise<{ changed: boolean; commitSha?: string }> {
    const repository = await this.#repository(input.tenantId, input.repositoryId);
    const accessToken = await this.#repositoryAccessToken(repository, "write");
    const client = this.#toolBroker(
      await this.#workspaceToolBroker(input.tenantId, input.workspaceId),
    );
    const response = await client.publishSource({
      sourceControlProtocolVersion: 3,
      type: "source_control.workspace_publish",
      requestId: this.#idGenerator(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      repositoryId: repository.id,
      provider: repository.provider,
      providerInstallationId: repository.provider_installation_id,
      providerRepositoryId: repository.provider_repository_id,
      cloneUrl: repository.clone_url,
      baseRef: repository.default_branch,
      branchName: input.branchName,
      workTreePath: input.workTreePath,
      commitMessage: input.commitMessage,
      authorName: "PiCloud Agent",
      authorEmail: "picloud-agent@users.noreply.local",
      accessToken,
    });
    return response.changed
      ? { changed: true, commitSha: response.commitSha! }
      : { changed: false };
  }

  async findChangeRequest(input: {
    repositoryId: string;
    sourceBranch: string;
  }): Promise<{ number: number; url: string } | undefined> {
    const repository = await this.repositoryForJob(input.repositoryId);
    if (repository === undefined) return undefined;
    if (repository.provider === "github") {
      return this.#requireGitHub().client.findPullRequest({
        installationId: repository.provider_installation_id,
        repositoryId: repository.provider_repository_id,
        owner: repository.owner,
        repository: repository.name,
        head: input.sourceBranch,
      });
    }
    return (
      await this.#gitlabClientByInternalInstallation(
        repository.tenant_id,
        repository.installation_id,
      )
    ).client.findMergeRequest({
      projectId: repository.provider_repository_id,
      sourceBranch: input.sourceBranch,
    });
  }

  async createChangeRequest(input: {
    repositoryId: string;
    issueNumber: number;
    issueTitle: string;
    sourceBranch: string;
    description: string;
  }): Promise<{ number: number; url: string }> {
    const repository = await this.repositoryForJob(input.repositoryId);
    if (repository === undefined) {
      throw new SourceControlServiceError(
        "source_control_not_found",
        "Issue source repository is no longer connected",
      );
    }
    if (repository.provider === "github") {
      return this.#requireGitHub().client.createPullRequest({
        installationId: repository.provider_installation_id,
        repositoryId: repository.provider_repository_id,
        owner: repository.owner,
        repository: repository.name,
        title: `Resolve #${String(input.issueNumber)}: ${input.issueTitle}`.slice(0, 256),
        body: input.description,
        head: input.sourceBranch,
        base: repository.default_branch,
      });
    }
    return (
      await this.#gitlabClientByInternalInstallation(
        repository.tenant_id,
        repository.installation_id,
      )
    ).client.createMergeRequest({
      projectId: repository.provider_repository_id,
      title: `Resolve #${String(input.issueNumber)}: ${input.issueTitle}`.slice(0, 256),
      description: input.description,
      sourceBranch: input.sourceBranch,
      targetBranch: repository.default_branch,
    });
  }

  async findIssueDeliveryComment(input: {
    repositoryId: string;
    issueNumber: number;
    marker: string;
  }): Promise<{ id: string } | undefined> {
    const repository = await this.repositoryForJob(input.repositoryId);
    if (repository === undefined) return undefined;
    if (repository.provider === "github") {
      return this.#requireGitHub().client.findIssueComment({
        installationId: repository.provider_installation_id,
        repositoryId: repository.provider_repository_id,
        owner: repository.owner,
        repository: repository.name,
        issueNumber: input.issueNumber,
        marker: input.marker,
      });
    }
    return (
      await this.#gitlabClientByInternalInstallation(
        repository.tenant_id,
        repository.installation_id,
      )
    ).client.findIssueNote({
      projectId: repository.provider_repository_id,
      issueNumber: input.issueNumber,
      marker: input.marker,
    });
  }

  async createIssueDeliveryComment(input: {
    repositoryId: string;
    issueNumber: number;
    body: string;
  }): Promise<{ id: string }> {
    const repository = await this.repositoryForJob(input.repositoryId);
    if (repository === undefined) {
      throw new SourceControlServiceError(
        "source_control_not_found",
        "Issue source repository is no longer connected",
      );
    }
    if (repository.provider === "github") {
      return this.#requireGitHub().client.createIssueComment({
        installationId: repository.provider_installation_id,
        repositoryId: repository.provider_repository_id,
        owner: repository.owner,
        repository: repository.name,
        issueNumber: input.issueNumber,
        body: input.body,
      });
    }
    return (
      await this.#gitlabClientByInternalInstallation(
        repository.tenant_id,
        repository.installation_id,
      )
    ).client.createIssueNote({
      projectId: repository.provider_repository_id,
      issueNumber: input.issueNumber,
      body: input.body,
    });
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
        "repository.provider",
        "repository.provider_base_url",
        "repository.installation_id",
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
    workTreePath = ".",
  ): Promise<string> {
    const accessToken = await this.#repositoryAccessToken(repository, "read");
    const response = await this.#toolBroker(
      await this.#workspaceToolBroker(repository.tenant_id, workspaceId),
    ).checkoutSource({
      sourceControlProtocolVersion: 3,
      type: "source_control.workspace_checkout",
      requestId: this.#idGenerator(),
      tenantId: repository.tenant_id,
      workspaceId,
      repositoryId: repository.id,
      provider: repository.provider,
      providerInstallationId: repository.provider_installation_id,
      providerRepositoryId: repository.provider_repository_id,
      cloneUrl: repository.clone_url,
      baseRef: repository.default_branch,
      branchName,
      workTreePath,
      accessToken,
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
        "repository.installation_id",
        "repository.provider",
        "repository.provider_base_url",
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

  async #repositoryAccessToken(
    repository: ConnectedRepository,
    access: "read" | "write",
  ): Promise<string> {
    if (repository.provider === "github") {
      try {
        return (
          await this.#requireGitHub().client.installationToken(
            repository.provider_installation_id,
            repository.provider_repository_id,
            { contents: access },
          )
        ).token;
      } catch (error: unknown) {
        throw this.#providerFailure(error);
      }
    }
    const installation = await this.#database
      .selectFrom("source_control_installations")
      .selectAll()
      .where("tenant_id", "=", repository.tenant_id)
      .where("id", "=", repository.installation_id)
      .where("provider", "=", "gitlab")
      .where("state", "=", "active")
      .executeTakeFirst();
    if (installation === undefined) {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "GitLab project connection is unavailable",
      );
    }
    return (await this.#gitlabClient(installation)).credential.accessToken;
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
      .where("provider_base_url", "=", "https://github.com")
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
        provider_base_url: "https://github.com",
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
        .where("provider_base_url", "=", "https://github.com")
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
          provider_base_url: "https://github.com",
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

  #gitlabIssueTrigger(
    eventName: string,
    payload: Record<string, unknown>,
    issueLabel: string,
  ): IssueTrigger | undefined {
    const attributes = record(payload.object_attributes);
    const user = record(payload.user);
    const actor = boundedText(user?.username, 255);
    if (attributes === undefined || actor === undefined) return undefined;
    if (eventName === "Issue Hook") {
      const issueNumber = Number(attributes.iid);
      const title = boundedText(attributes.title, 512);
      const body =
        typeof attributes.description === "string"
          ? (boundedText(attributes.description, 90_000) ?? "")
          : "";
      const url = boundedText(attributes.url, 2_048);
      const labelsChange = record(record(payload.changes)?.labels);
      const previous = Array.isArray(labelsChange?.previous) ? labelsChange.previous : [];
      const current = Array.isArray(labelsChange?.current) ? labelsChange.current : [];
      const initial = Array.isArray(payload.labels) ? payload.labels : [];
      const hasLabel = (values: unknown[]): boolean =>
        values.some(
          (value) =>
            boundedText(record(value)?.title, 255)?.toLowerCase() === issueLabel.toLowerCase(),
        );
      if (
        ((attributes.action === "update" && !hasLabel(previous) && hasLabel(current)) ||
          (attributes.action === "open" && hasLabel(initial))) &&
        Number.isSafeInteger(issueNumber) &&
        issueNumber > 0 &&
        title !== undefined &&
        url !== undefined
      ) {
        return { kind: "label", issueNumber, title, body, url, actor };
      }
      return undefined;
    }
    if (
      eventName === "Note Hook" &&
      attributes.action === "create" &&
      attributes.noteable_type === "Issue" &&
      attributes.note === "/picloud solve"
    ) {
      const issue = record(payload.issue);
      const issueNumber = Number(issue?.iid);
      const title = boundedText(issue?.title, 512);
      const body =
        typeof issue?.description === "string"
          ? (boundedText(issue.description, 90_000) ?? "")
          : "";
      const url = boundedText(issue?.url, 2_048);
      if (
        Number.isSafeInteger(issueNumber) &&
        issueNumber > 0 &&
        title !== undefined &&
        url !== undefined
      ) {
        return { kind: "comment", issueNumber, title, body, url, actor };
      }
    }
    return undefined;
  }

  async #gitlabClient(installation: Selectable<SourceControlInstallationTable>): Promise<{
    client: GitLabProjectClient;
    credential: import("./source-control-credential-vault.ts").GitLabProjectCredential;
  }> {
    const runtime = this.#requireGitLab();
    const sealed = await this.#database
      .selectFrom("source_control_credentials")
      .select([
        "version",
        "key_version as keyVersion",
        "nonce",
        "ciphertext",
        "auth_tag as authTag",
        "secret_sha256 as secretSha256",
      ])
      .where("tenant_id", "=", installation.tenant_id)
      .where("installation_id", "=", installation.id)
      .where("provider", "=", "gitlab")
      .executeTakeFirst();
    if (sealed === undefined) {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "GitLab project credential is unavailable",
      );
    }
    let credential;
    try {
      credential = runtime.vault.open(
        {
          tenantId: installation.tenant_id,
          installationId: installation.id,
          provider: "gitlab",
          version: sealed.version,
        },
        sealed,
      );
    } catch {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "GitLab project credential is unavailable",
      );
    }
    return {
      credential,
      client: new GitLabProjectClient({
        baseUrl: runtime.internalBaseUrl ?? installation.provider_base_url,
        publicBaseUrl: installation.provider_base_url,
        accessToken: credential.accessToken,
        ...(runtime.fetch === undefined ? {} : { fetch: runtime.fetch }),
      }),
    };
  }

  async #gitlabClientByInternalInstallation(tenantId: string, installationId: string) {
    const installation = await this.#database
      .selectFrom("source_control_installations")
      .selectAll()
      .where("tenant_id", "=", tenantId)
      .where("id", "=", installationId)
      .where("provider", "=", "gitlab")
      .where("state", "=", "active")
      .executeTakeFirst();
    if (installation === undefined) {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "GitLab project connection is unavailable",
      );
    }
    return this.#gitlabClient(installation);
  }

  async #assertGitLabClaimIdentity(
    identity: TenantRequestIdentity,
    jobId: string,
  ): Promise<{
    externalIdentityId: string;
  }> {
    const external = identity.externalIdentity;
    if (identity.authenticationKind !== "oidc" || external?.providerKey !== "gitlab") {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "Sign in with GitLab to claim this Issue",
      );
    }
    const context = await this.#database
      .selectFrom("source_control_issue_jobs as job")
      .innerJoin("source_control_repositories as repository", (join) =>
        join
          .onRef("repository.tenant_id", "=", "job.tenant_id")
          .onRef("repository.id", "=", "job.repository_id"),
      )
      .select([
        "repository.provider",
        "repository.provider_base_url as providerBaseUrl",
        "repository.provider_repository_id as providerRepositoryId",
        "repository.installation_id as installationId",
      ])
      .where("job.tenant_id", "=", identity.tenantId)
      .where("job.id", "=", jobId)
      .executeTakeFirst();
    if (context === undefined) {
      throw new SourceControlServiceError(
        "source_control_not_found",
        "Issue request was not found",
      );
    }
    if (
      context.provider !== "gitlab" ||
      external.issuer !== context.providerBaseUrl ||
      !/^[1-9][0-9]{0,30}$/.test(external.providerUserId)
    ) {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "GitLab identity does not belong to this project's instance",
      );
    }
    const { client } = await this.#gitlabClientByInternalInstallation(
      identity.tenantId,
      context.installationId,
    );
    const level = await client.memberAccessLevel(
      context.providerRepositoryId,
      external.providerUserId,
    );
    if (level === undefined || level < 30) {
      throw new SourceControlServiceError(
        "source_control_authorization_denied",
        "GitLab Developer access is required to claim this Issue",
      );
    }
    return { externalIdentityId: external.id };
  }

  async #issueJob(
    identity: TenantRequestIdentity,
    jobId: string,
  ): Promise<SourceControlIssueJobResource> {
    const job = (await this.listIssueJobs(identity)).jobs.find(
      (candidate) => candidate.jobId === jobId,
    );
    if (job === undefined) {
      throw new SourceControlServiceError(
        "source_control_not_found",
        "Issue request was not found",
      );
    }
    return job;
  }

  async #syncGitLabIssueClaims(jobId: string): Promise<void> {
    const job = await this.#database
      .selectFrom("source_control_issue_jobs as job")
      .innerJoin("source_control_repositories as repository", (join) =>
        join
          .onRef("repository.tenant_id", "=", "job.tenant_id")
          .onRef("repository.id", "=", "job.repository_id"),
      )
      .select([
        "job.id",
        "job.tenant_id as tenantId",
        "job.issue_number as issueNumber",
        "job.state",
        "repository.installation_id as installationId",
        "repository.provider_repository_id as providerRepositoryId",
      ])
      .where("job.id", "=", jobId)
      .where("job.provider", "=", "gitlab")
      .executeTakeFirst();
    if (job === undefined) return;
    const claims = await this.#database
      .selectFrom("source_control_issue_claims as claim")
      .innerJoin("external_identities as external", (join) =>
        join
          .onRef("external.tenant_id", "=", "claim.tenant_id")
          .onRef("external.id", "=", "claim.external_identity_id"),
      )
      .select(["external.username", "claim.claimed_at as claimedAt"])
      .where("claim.issue_job_id", "=", jobId)
      .orderBy("claim.claimed_at", "asc")
      .execute();
    const marker = `<!-- picloud-claims:${jobId} -->`;
    const body = [
      marker,
      "### PiCloud 处理意向",
      "",
      ...(claims.length === 0
        ? ["当前没有员工认领。"]
        : claims.map((claim) => `- @${claim.username} · ${iso(claim.claimedAt)}`)),
      "",
      job.state === "awaiting_claim" ? "状态：等待开始" : `状态：${job.state}`,
      `[在 PiCloud 中查看](${new URL("/?resource=source-control", this.#requireGitLab().publicOrigin).toString()})`,
    ].join("\n");
    const { client } = await this.#gitlabClientByInternalInstallation(
      job.tenantId,
      job.installationId,
    );
    const existing = await client.findIssueNote({
      projectId: job.providerRepositoryId,
      issueNumber: job.issueNumber,
      marker,
    });
    if (existing === undefined) {
      await client.createIssueNote({
        projectId: job.providerRepositoryId,
        issueNumber: job.issueNumber,
        body,
      });
    } else {
      await client.updateIssueNote({
        projectId: job.providerRepositoryId,
        issueNumber: job.issueNumber,
        noteId: existing.id,
        body,
      });
    }
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

  #requireGitLab(): GitLabProjectRuntime {
    if (this.#gitlab === undefined) {
      throw new SourceControlServiceError(
        "source_control_unavailable",
        "GitLab project integration is not configured",
      );
    }
    return this.#gitlab;
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

  #providerFailure(error: unknown): SourceControlServiceError {
    if (error instanceof SourceControlServiceError) return error;
    if (error instanceof GitLabProjectClientError) {
      return new SourceControlServiceError(
        "source_control_operation_failed",
        error.message,
        error.retryable,
      );
    }
    return this.#githubFailure(error);
  }
}
