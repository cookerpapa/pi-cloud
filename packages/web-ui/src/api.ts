import {
  parseSessionSchedule,
  parseSessionScheduleList,
  parseScheduleDeletion,
  type ScheduleChange,
} from "@pi-cloud/protocol";
import {
  parseExecutionTargetList,
  parseSessionExecutionTarget,
  type ConversationHistoryQuery,
  parseConversationSearchResult,
  type ConversationSearchResult,
} from "@pi-cloud/protocol";
import {
  parseConversationUsageResource,
  parseConversationCompactResource,
  type ConversationUsageResource,
  type ConversationCompactResource,
} from "@pi-cloud/protocol";
import { blobContentDigest } from "./upload-digest.ts";
import {
  parseUserUpload,
  type UserUpload,
  parseInputQueueResource,
  parseQueuedInputActionResult,
  type InputQueueResource,
  type QueuedInputAction,
  type QueuedInputActionResult,
  parseReturnedInputsResource,
  type ReturnedInputsResource,
  parseAcceptedTurnCancellationResource,
  parseAcceptedConversationInputResource,
  parseAuthSessionResource,
  parseAuthenticationConfigurationResource,
  parseConversationDetailResource,
  parseConversationListResource,
  parseConversationTreeResource,
  parseConversationForkResource,
  parseConversationPruneResource,
  parseControlPlaneApiError,
  parseModelConfigurationResource,
  parseModelCatalogResource,
  parseSessionModelResource,
  parseCubeProxyConfigurationResource,
  parseLogoutResource,
  parseProjectResource,
  parseRunResource,
  parseSessionResource,
  parseTenantIdentityResource,
  parseTenantRegistrationResource,
  parseWorkspaceDirectoryResource,
  parseWorkspaceDeletionResource,
  parseDevelopmentEnvironmentListResource,
  parseDevelopmentEnvironmentResource,
  parseDevelopmentEnvironmentDirectoryResource,
  parseWorkspaceListResource,
  parseConversationWorkspaceBindingResource,
  parseSshAccessTicketResource,
  parseSourceControlIssueJobListResource,
  parseSourceControlIssueJobResource,
  parseSourceControlIssueGitCredentialResource,
  parseCodeHostConnectionListResource,
  type ConversationDetailResource,
  type AuthSessionResource,
  type AuthenticationConfigurationResource,
  type ConversationListResource,
  type ConversationTreeResource,
  type ConversationTreeView,
  type ConversationForkResource,
  type ConversationPruneResource,
  type AcceptedTurnCancellationResource,
  type AcceptedConversationInputResource,
  type ProjectResource,
  type RunResource,
  type ProviderModelSelection,
  type SessionModelSelection,
  type ModelConfigurationResource,
  type ModelCatalogResource,
  type SessionModelResource,
  type CubeProxyConfigurationResource,
  type LogoutResource,
  type ExecutionMode,
  type SessionResource,
  type TenantIdentityResource,
  type TenantRegistrationResource,
  type TurnThinkingLevel,
  type WorkspaceDirectoryResource,
  type WorkspaceDeletionResource,
  type DevelopmentEnvironmentAction,
  type DevelopmentEnvironmentListResource,
  type DevelopmentEnvironmentResource,
  type DevelopmentEnvironmentDirectoryResource,
  type WorkspaceListResource,
  type WorkspaceSourceRequest,
  type ConversationWorkspaceBindingResource,
  type SshAccessTicketResource,
  type SourceControlIssueJobListResource,
  type SourceControlIssueJobResource,
  type StartSourceControlIssueJobRequest,
  type SourceControlIssueGitCredentialResource,
  type CodeHostConnectionListResource,
  type ConnectCodeHostRequest,
  type DisconnectCodeHostRequest,
} from "@pi-cloud/protocol";

export class PiCloudApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PiCloudApiError";
    this.status = status;
    this.code = code;
  }
}

type FetchImplementation = typeof fetch;

async function responseJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new PiCloudApiError(
      response.status,
      "invalid_response",
      "Control plane returned a non-JSON response",
    );
  }
}

async function request(
  fetchImplementation: FetchImplementation,
  path: string,
  init: RequestInit,
  authorizationToken?: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers).entries()),
        ...(authorizationToken === undefined
          ? {}
          : { authorization: `Bearer ${authorizationToken}` }),
      },
    });
  } catch {
    throw new PiCloudApiError(0, "network_error", "Control plane is unreachable");
  }
  if (response.status === 204) return null;
  const body = await responseJson(response);
  if (!response.ok) {
    try {
      const parsed = parseControlPlaneApiError(body);
      throw new PiCloudApiError(response.status, parsed.error.code, parsed.error.message);
    } catch (error: unknown) {
      if (error instanceof PiCloudApiError) throw error;
      throw new PiCloudApiError(
        response.status,
        "invalid_error_response",
        `Control plane rejected the request with HTTP ${String(response.status)}`,
      );
    }
  }
  return body;
}

async function requestBytes(
  fetchImplementation: FetchImplementation,
  path: string,
  authorizationToken?: string,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let response: Response;
  try {
    response = await fetchImplementation(path, {
      method: "GET",
      signal: signal ?? null,
      credentials: "same-origin",
      ...(authorizationToken === undefined
        ? {}
        : { headers: { authorization: `Bearer ${authorizationToken}` } }),
    });
  } catch {
    throw new PiCloudApiError(0, "network_error", "Control plane is unreachable");
  }
  if (!response.ok) {
    const body = await responseJson(response);
    try {
      const parsed = parseControlPlaneApiError(body);
      throw new PiCloudApiError(response.status, parsed.error.code, parsed.error.message);
    } catch (error: unknown) {
      if (error instanceof PiCloudApiError) throw error;
      throw new PiCloudApiError(
        response.status,
        "invalid_error_response",
        `Control plane rejected the request with HTTP ${String(response.status)}`,
      );
    }
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
  };
}

function jsonRequest(
  body: unknown,
  idempotencyKey?: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE" = "POST",
): RequestInit {
  return {
    method,
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify(body),
  };
}

export class PiCloudApi {
  readonly #fetch: FetchImplementation;
  readonly #authorizationToken: string | undefined;

  constructor(
    fetchImplementation: FetchImplementation = globalThis.fetch.bind(globalThis),
    authorizationToken?: string,
  ) {
    this.#fetch = fetchImplementation;
    if (
      authorizationToken !== undefined &&
      (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(authorizationToken) ||
        /[\r\n]/.test(authorizationToken))
    ) {
      throw new TypeError("authorizationToken is invalid");
    }
    this.#authorizationToken = authorizationToken;
  }

  async getAuthenticationConfiguration(): Promise<AuthenticationConfigurationResource> {
    return parseAuthenticationConfigurationResource(
      await request(this.#fetch, "/v1/auth/providers", { method: "GET" }),
    );
  }

  async getIdentity(): Promise<TenantIdentityResource> {
    return parseTenantIdentityResource(
      await request(this.#fetch, "/v1/identity", { method: "GET" }, this.#authorizationToken),
    );
  }

  async registerAccount(
    username: string,
    displayName: string,
    password: string,
  ): Promise<AuthSessionResource> {
    return parseAuthSessionResource(
      await request(
        this.#fetch,
        "/v1/auth/register",
        jsonRequest({ username, displayName, password }),
      ),
    );
  }

  async loginAccount(username: string, password: string): Promise<AuthSessionResource> {
    return parseAuthSessionResource(
      await request(this.#fetch, "/v1/auth/login", jsonRequest({ username, password })),
    );
  }

  async logout(): Promise<LogoutResource> {
    return parseLogoutResource(await request(this.#fetch, "/v1/auth/logout", jsonRequest({})));
  }

  async getModelConfiguration(): Promise<ModelConfigurationResource> {
    return parseModelConfigurationResource(
      await request(
        this.#fetch,
        "/v1/model-configuration",
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async replaceModelConfiguration(
    selection: ProviderModelSelection,
  ): Promise<ModelConfigurationResource> {
    return parseModelConfigurationResource(
      await request(
        this.#fetch,
        "/v1/model-configuration",
        jsonRequest(selection, undefined, "PUT"),
        this.#authorizationToken,
      ),
    );
  }

  async getModelCatalog(): Promise<ModelCatalogResource> {
    return parseModelCatalogResource(
      await request(this.#fetch, "/v1/models", { method: "GET" }, this.#authorizationToken),
    );
  }

  async getSessionModel(sessionId: string): Promise<SessionModelResource> {
    return parseSessionModelResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/model`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  /** Used by diagnostic/acceptance clients, not as a second browser stream poll. */
  async getRun(runId: string): Promise<RunResource> {
    return parseRunResource(
      await request(
        this.#fetch,
        `/v1/runs/${encodeURIComponent(runId)}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async updateSessionModel(
    sessionId: string,
    selection: SessionModelSelection,
  ): Promise<SessionModelResource> {
    return parseSessionModelResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/model`,
        jsonRequest(selection, undefined, "PUT"),
        this.#authorizationToken,
      ),
    );
  }

  async getCubeProxyConfiguration(): Promise<CubeProxyConfigurationResource> {
    return parseCubeProxyConfigurationResource(
      await request(
        this.#fetch,
        "/v1/platform-settings/cube-proxy",
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async replaceCubeProxyConfiguration(
    enabled: boolean,
    proxyUrl?: string,
  ): Promise<CubeProxyConfigurationResource> {
    return parseCubeProxyConfigurationResource(
      await request(
        this.#fetch,
        "/v1/platform-settings/cube-proxy",
        jsonRequest({ enabled, ...(proxyUrl === undefined ? {} : { proxyUrl }) }, undefined, "PUT"),
        this.#authorizationToken,
      ),
    );
  }

  async registerTenant(
    tenantSlug: string,
    displayName: string,
  ): Promise<TenantRegistrationResource> {
    return parseTenantRegistrationResource(
      await request(this.#fetch, "/v1/registrations", jsonRequest({ tenantSlug, displayName })),
    );
  }

  async listConversations(cursor?: string): Promise<ConversationListResource> {
    return parseConversationListResource(
      await request(
        this.#fetch,
        `/v1/conversations${cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async listWorkspaces(): Promise<WorkspaceListResource> {
    return parseWorkspaceListResource(
      await request(this.#fetch, "/v1/workspaces", { method: "GET" }, this.#authorizationToken),
    );
  }

  async listSourceControlIssueJobs(): Promise<SourceControlIssueJobListResource> {
    return parseSourceControlIssueJobListResource(
      await request(
        this.#fetch,
        "/v1/source-control/issue-jobs",
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async claimSourceControlIssueJob(jobId: string): Promise<SourceControlIssueJobResource> {
    return parseSourceControlIssueJobResource(
      await request(
        this.#fetch,
        `/v1/source-control/issue-jobs/${encodeURIComponent(jobId)}/claims`,
        jsonRequest({}),
        this.#authorizationToken,
      ),
    );
  }

  async unclaimSourceControlIssueJob(jobId: string): Promise<SourceControlIssueJobResource> {
    return parseSourceControlIssueJobResource(
      await request(
        this.#fetch,
        `/v1/source-control/issue-jobs/${encodeURIComponent(jobId)}/claims`,
        { method: "DELETE" },
        this.#authorizationToken,
      ),
    );
  }

  async startSourceControlIssueJob(
    jobId: string,
    input: StartSourceControlIssueJobRequest,
  ): Promise<SourceControlIssueJobResource> {
    return parseSourceControlIssueJobResource(
      await request(
        this.#fetch,
        `/v1/source-control/issue-jobs/${encodeURIComponent(jobId)}/start`,
        jsonRequest(input),
        this.#authorizationToken,
      ),
    );
  }

  async preflightSourceControlIssueGit(
    jobId: string,
    workspaceId: string,
  ): Promise<SourceControlIssueGitCredentialResource> {
    return parseSourceControlIssueGitCredentialResource(
      await request(
        this.#fetch,
        `/v1/source-control/issue-jobs/${encodeURIComponent(jobId)}/git-preflight`,
        jsonRequest({ workspaceId }),
        this.#authorizationToken,
      ),
    );
  }

  async codeHostConnections(workspaceId: string): Promise<CodeHostConnectionListResource> {
    return parseCodeHostConnectionListResource(
      await request(
        this.#fetch,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/code-host-connections`,
        {},
        this.#authorizationToken,
      ),
    );
  }

  async connectCodeHost(
    workspaceId: string,
    input: ConnectCodeHostRequest,
  ): Promise<CodeHostConnectionListResource> {
    return parseCodeHostConnectionListResource(
      await request(
        this.#fetch,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/code-host-connections`,
        jsonRequest(input),
        this.#authorizationToken,
      ),
    );
  }

  async disconnectCodeHost(
    workspaceId: string,
    input: DisconnectCodeHostRequest,
  ): Promise<CodeHostConnectionListResource> {
    return parseCodeHostConnectionListResource(
      await request(
        this.#fetch,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}/code-host-connections`,
        jsonRequest(input, undefined, "DELETE"),
        this.#authorizationToken,
      ),
    );
  }

  async deleteWorkspace(
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceDeletionResource> {
    return parseWorkspaceDeletionResource(
      await request(
        this.#fetch,
        `/v1/workspaces/${encodeURIComponent(workspaceId)}`,
        {
          method: "DELETE",
          headers: { "idempotency-key": idempotencyKey },
        },
        this.#authorizationToken,
      ),
    );
  }

  async listDevelopmentEnvironments(): Promise<DevelopmentEnvironmentListResource> {
    return parseDevelopmentEnvironmentListResource(
      await request(
        this.#fetch,
        "/v1/development-environments",
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async createDevelopmentEnvironment(
    name: string,
    profileKey: import("@pi-cloud/protocol").DevelopmentEnvironmentProfileKey,
    idempotencyKey: string,
  ): Promise<DevelopmentEnvironmentResource> {
    return parseDevelopmentEnvironmentResource(
      await request(
        this.#fetch,
        "/v1/development-environments",
        jsonRequest({ name, profileKey }, idempotencyKey),
        this.#authorizationToken,
      ),
    );
  }

  async developmentEnvironmentAction(
    environmentId: string,
    action: DevelopmentEnvironmentAction,
    idempotencyKey: string,
  ): Promise<DevelopmentEnvironmentResource> {
    return parseDevelopmentEnvironmentResource(
      await request(
        this.#fetch,
        `/v1/development-environments/${encodeURIComponent(environmentId)}/actions`,
        jsonRequest({ action }, idempotencyKey),
        this.#authorizationToken,
      ),
    );
  }

  async listDevelopmentEnvironmentDirectory(
    environmentId: string,
    path: string,
  ): Promise<DevelopmentEnvironmentDirectoryResource> {
    return parseDevelopmentEnvironmentDirectoryResource(
      await request(
        this.#fetch,
        `/v1/development-environments/${encodeURIComponent(environmentId)}/directory?path=${encodeURIComponent(path)}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async createDevelopmentEnvironmentDirectory(
    environmentId: string,
    path: string,
    name: string,
  ): Promise<DevelopmentEnvironmentDirectoryResource> {
    return parseDevelopmentEnvironmentDirectoryResource(
      await request(
        this.#fetch,
        `/v1/development-environments/${encodeURIComponent(environmentId)}/directory`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, name }),
        },
        this.#authorizationToken,
      ),
    );
  }

  async deleteConversation(sessionId: string): Promise<void> {
    await request(
      this.#fetch,
      `/v1/conversations/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
      this.#authorizationToken,
    );
  }

  async rebindConversationWorkspace(
    sessionId: string,
    workspaceId: string,
    idempotencyKey: string,
    workingDirectory?: string,
  ): Promise<ConversationWorkspaceBindingResource> {
    return parseConversationWorkspaceBindingResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/workspace`,
        jsonRequest(
          { workspaceId, ...(workingDirectory === undefined ? {} : { workingDirectory }) },
          idempotencyKey,
          "PUT",
        ),
        this.#authorizationToken,
      ),
    );
  }

  async issueSshAccessTicket(sessionId: string): Promise<SshAccessTicketResource> {
    return parseSshAccessTicketResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/ssh-tickets`,
        jsonRequest({}),
        this.#authorizationToken,
      ),
    );
  }

  async getConversationUsage(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<ConversationUsageResource> {
    return parseConversationUsageResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/usage`,
        { method: "GET", ...(signal ? { signal } : {}) },
        this.#authorizationToken,
      ),
    );
  }
  async compactConversation(
    sessionId: string,
    instructions: string,
    key: string,
  ): Promise<ConversationCompactResource> {
    return parseConversationCompactResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/compact`,
        jsonRequest(instructions ? { instructions } : {}, key),
        this.#authorizationToken,
      ),
    );
  }
  async getCompaction(
    sessionId: string,
    commandId?: string,
    signal?: AbortSignal,
  ): Promise<ConversationCompactResource | null> {
    const value = await request(
      this.#fetch,
      `/v1/conversations/${encodeURIComponent(sessionId)}/compact${commandId ? "/" + encodeURIComponent(commandId) : ""}`,
      { method: "GET", ...(signal ? { signal } : {}) },
      this.#authorizationToken,
    );
    return value === null ? null : parseConversationCompactResource(value);
  }

  async getConversation(
    sessionId: string,
    query: ConversationHistoryQuery = {},
    signal?: AbortSignal,
  ): Promise<ConversationDetailResource> {
    return parseConversationDetailResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}?${new URLSearchParams(Object.entries(query).filter((pair): pair is [string, string] => typeof pair[1] === "string"))}`,
        { method: "GET", ...(signal ? { signal } : {}) },
        this.#authorizationToken,
      ),
    );
  }

  async searchConversation(
    sessionId: string,
    text: string,
    before?: string,
    signal?: AbortSignal,
  ): Promise<ConversationSearchResult> {
    const params = new URLSearchParams({ q: text, ...(before ? { before } : {}) });
    return parseConversationSearchResult(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/search?${params}`,
        { method: "GET", ...(signal ? { signal } : {}) },
        this.#authorizationToken,
      ),
    );
  }
  conversationExportUrl(sessionId: string): string {
    return `/v1/conversations/${encodeURIComponent(sessionId)}/export`;
  }
  async listSchedules(sessionId: string, cursor?: string, signal?: AbortSignal) {
    return parseSessionScheduleList(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/schedules${cursor ? "?cursor=" + encodeURIComponent(cursor) : ""}`,
        { method: "GET", ...(signal ? { signal } : {}) },
        this.#authorizationToken,
      ),
    );
  }
  async getSchedule(sessionId: string, id: string, signal?: AbortSignal) {
    return parseSessionSchedule(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/schedules/${encodeURIComponent(id)}`,
        { method: "GET", ...(signal ? { signal } : {}) },
        this.#authorizationToken,
      ),
    );
  }
  async changeSchedule(sessionId: string, id: string, input: ScheduleChange) {
    return parseSessionSchedule(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/schedules/${encodeURIComponent(id)}`,
        jsonRequest(input, undefined, "PATCH"),
        this.#authorizationToken,
      ),
    );
  }
  async deleteSchedule(sessionId: string, id: string, revision: string) {
    return parseScheduleDeletion(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/schedules/${encodeURIComponent(id)}`,
        jsonRequest({ revision }, undefined, "DELETE"),
        this.#authorizationToken,
      ),
    );
  }

  async listExecutionTargets() {
    return parseExecutionTargetList(
      await request(
        this.#fetch,
        "/v1/execution-targets",
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }
  async getSessionExecutionTarget(id: string) {
    return parseSessionExecutionTarget(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(id)}/execution-target`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }
  async bindExecutionTarget(id: string, targetId: string | null, revision: string) {
    return parseSessionExecutionTarget(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(id)}/execution-target`,
        jsonRequest({ targetId, revision }, undefined, "PUT"),
        this.#authorizationToken,
      ),
    );
  }
  readExecutionTargetScreen(id: string, signal?: AbortSignal) {
    return requestBytes(
      this.#fetch,
      `/v1/execution-targets/${encodeURIComponent(id)}/screen`,
      this.#authorizationToken,
      signal,
    );
  }

  async getConversationTree(
    sessionId: string,
    view: ConversationTreeView,
    navigation: { branchSessionId?: string; beforeEntryId?: string } = {},
  ): Promise<ConversationTreeResource> {
    return parseConversationTreeResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/tree?${new URLSearchParams({ view, ...navigation })}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async forkConversation(
    sessionId: string,
    turnId: string,
    entryId: string,
    title: string | undefined,
    idempotencyKey: string,
  ): Promise<ConversationForkResource> {
    return parseConversationForkResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/forks`,
        jsonRequest({ turnId, entryId, ...(title === undefined ? {} : { title }) }, idempotencyKey),
        this.#authorizationToken,
      ),
    );
  }

  async pruneConversation(
    sessionId: string,
    turnId: string,
    entryId: string,
    idempotencyKey: string,
  ): Promise<ConversationPruneResource> {
    return parseConversationPruneResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/prunes`,
        jsonRequest({ turnId, entryId }, idempotencyKey),
        this.#authorizationToken,
      ),
    );
  }

  async listWorkspaceDirectory(sessionId: string, path = ""): Promise<WorkspaceDirectoryResource> {
    const query = path.length === 0 ? "" : `?path=${encodeURIComponent(path)}`;
    return parseWorkspaceDirectoryResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/directory${query}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  readWorkspaceFile(
    sessionId: string,
    path: string,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    return requestBytes(
      this.#fetch,
      `/v1/sessions/${encodeURIComponent(sessionId)}/workspace/file?path=${encodeURIComponent(path)}`,
      this.#authorizationToken,
    );
  }

  async createProject(
    name: string,
    source: WorkspaceSourceRequest = { kind: "empty" },
  ): Promise<ProjectResource> {
    return parseProjectResource(
      await request(
        this.#fetch,
        "/v1/projects",
        jsonRequest({ name, source }),
        this.#authorizationToken,
      ),
    );
  }

  async createSession(
    projectId: string,
    workspaceId: string,
    title: string,
    executionMode: ExecutionMode,
    sandboxProfileKey:
      import("@pi-cloud/protocol").DevelopmentEnvironmentProfileKey | undefined = executionMode ===
    "development_environment"
      ? undefined
      : "standard",
    workingDirectory = executionMode === "development_environment" ? "/home/user" : "/workspace",
    model?: SessionModelSelection,
  ): Promise<SessionResource> {
    return parseSessionResource(
      await request(
        this.#fetch,
        `/v1/projects/${encodeURIComponent(projectId)}/sessions`,
        jsonRequest({
          workspaceId,
          title,
          ...(model === undefined ? {} : { model }),
          executionMode,
          ...(sandboxProfileKey === undefined ? {} : { sandboxProfileKey }),
          workingDirectory,
        }),
        this.#authorizationToken,
      ),
    );
  }

  async uploadWorkspaceFile(
    sessionId: string,
    id: string,
    file: Blob,
    name: string,
    signal?: AbortSignal,
  ): Promise<UserUpload> {
    return parseUserUpload(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/uploads/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-digest": await blobContentDigest(file, signal),
          },
          body: file,
          signal: signal ?? null,
        },
        this.#authorizationToken,
      ),
    );
  }

  async removeDraftUpload(upload: UserUpload): Promise<void> {
    await request(
      this.#fetch,
      `/v1/sessions/${encodeURIComponent(upload.sessionId)}/uploads/${encodeURIComponent(upload.id)}`,
      { method: "DELETE" },
      this.#authorizationToken,
    );
  }

  readInputImage(
    upload: UserUpload,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; contentType: string }> {
    return requestBytes(
      this.#fetch,
      `/v1/sessions/${encodeURIComponent(upload.sessionId)}/images/${encodeURIComponent(upload.image!.id)}`,
      this.#authorizationToken,
      signal,
    );
  }

  async acceptTurn(
    sessionId: string,
    prompt: string,
    idempotencyKey: string,
    thinkingLevel?: TurnThinkingLevel,
    uploadIds?: string[],
    whenBusy?: "follow_up" | "steer",
  ): Promise<AcceptedConversationInputResource> {
    return parseAcceptedConversationInputResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
        jsonRequest(
          {
            prompt,
            ...(uploadIds?.length ? { uploadIds } : {}),
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
            ...(whenBusy === undefined ? {} : { whenBusy }),
          },
          idempotencyKey,
        ),
        this.#authorizationToken,
      ),
    );
  }

  async getInputQueue(
    sessionId: string,
    signal?: AbortSignal,
    page?: { afterPosition: number; revision: string },
  ): Promise<InputQueueResource> {
    const query = page
      ? `?${new URLSearchParams({ afterPosition: String(page.afterPosition), revision: page.revision })}`
      : "";
    return parseInputQueueResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/queued-inputs${query}`,
        {
          method: "GET",
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        },
        this.#authorizationToken,
      ),
    );
  }

  async mutateQueuedInput(
    sessionId: string,
    inputId: string,
    action: QueuedInputAction,
    idempotencyKey: string,
  ): Promise<QueuedInputActionResult> {
    return parseQueuedInputActionResult(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/queued-inputs/${encodeURIComponent(inputId)}/actions`,
        { ...jsonRequest(action, idempotencyKey), signal: AbortSignal.timeout(10_000) },
        this.#authorizationToken,
      ),
    );
  }

  async getReturnedInputs(
    sessionId: string,
    signal?: AbortSignal,
    page: { requestId?: string; afterPosition?: number } = {},
  ): Promise<ReturnedInputsResource> {
    const params = new URLSearchParams();
    if (page.requestId) params.set("requestId", page.requestId);
    if (page.afterPosition) params.set("afterPosition", String(page.afterPosition));
    const query = params.size ? `?${params.toString()}` : "";
    return parseReturnedInputsResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/returned-inputs${query}`,
        {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        },
        this.#authorizationToken,
      ),
    );
  }

  async acknowledgeReturnedInputs(
    sessionId: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await request(
      this.#fetch,
      `/v1/sessions/${encodeURIComponent(sessionId)}/returned-inputs/acknowledgements`,
      {
        ...jsonRequest({ requestId }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
          : AbortSignal.timeout(10_000),
      },
      this.#authorizationToken,
    );
  }

  async cancelTurn(
    sessionId: string,
    turnId: string,
    idempotencyKey: string,
    gracePeriodMs = 2_000,
  ): Promise<AcceptedTurnCancellationResource> {
    return parseAcceptedTurnCancellationResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancellations`,
        jsonRequest({ gracePeriodMs }, idempotencyKey),
        this.#authorizationToken,
      ),
    );
  }
}

export function newIdempotencyKey(
  prefix:
    | "turn"
    | "compact"
    | "cancel"
    | "steer"
    | "delete"
    | "retry"
    | "fork"
    | "prune"
    | "environment"
    | "workspace-rebind",
): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}
