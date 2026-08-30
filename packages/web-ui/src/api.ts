import {
  parseAcceptedTurnCancellationResource,
  parseAcceptedTurnResource,
  parseTurnSteerResource,
  parseAuthSessionResource,
  parseAuthenticationConfigurationResource,
  parseConversationDetailResource,
  parseConversationListResource,
  parseConversationTreeResource,
  parseConversationForkResource,
  parseConversationPruneResource,
  parseControlPlaneApiError,
  parseModelConfigurationResource,
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
  parseWorkspaceOperationResource,
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
  type AcceptedTurnResource,
  type TurnSteerResource,
  type ProjectResource,
  type DeepSeekModelId,
  type ModelConfigurationResource,
  type CubeProxyConfigurationResource,
  type LogoutResource,
  type RunResource,
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
  type WorkspaceOperationResource,
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
): Promise<{ bytes: Uint8Array; contentType: string }> {
  let response: Response;
  try {
    response = await fetchImplementation(path, {
      method: "GET",
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
  method: "POST" | "PUT" | "DELETE" = "POST",
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
    modelId: DeepSeekModelId,
    apiKey: string,
  ): Promise<ModelConfigurationResource> {
    return parseModelConfigurationResource(
      await request(
        this.#fetch,
        "/v1/model-configuration",
        jsonRequest({ provider: "deepseek", modelId, apiKey }, undefined, "PUT"),
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

  async listConversations(): Promise<ConversationListResource> {
    return parseConversationListResource(
      await request(this.#fetch, "/v1/conversations", { method: "GET" }, this.#authorizationToken),
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

  async deleteConversation(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<WorkspaceOperationResource> {
    return parseWorkspaceOperationResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}`,
        {
          method: "DELETE",
          headers: { "idempotency-key": idempotencyKey },
        },
        this.#authorizationToken,
      ),
    );
  }

  async rebindConversationWorkspace(
    sessionId: string,
    workspaceId: string,
    idempotencyKey: string,
  ): Promise<ConversationWorkspaceBindingResource> {
    return parseConversationWorkspaceBindingResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/workspace`,
        jsonRequest({ workspaceId }, idempotencyKey, "PUT"),
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

  async getConversation(sessionId: string): Promise<ConversationDetailResource> {
    return parseConversationDetailResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}`,
        { method: "GET" },
        this.#authorizationToken,
      ),
    );
  }

  async getConversationTree(
    sessionId: string,
    view: ConversationTreeView,
  ): Promise<ConversationTreeResource> {
    return parseConversationTreeResource(
      await request(
        this.#fetch,
        `/v1/conversations/${encodeURIComponent(sessionId)}/tree?view=${encodeURIComponent(view)}`,
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
    sandboxProfileKey: import("@pi-cloud/protocol").DevelopmentEnvironmentProfileKey = "standard",
    workingDirectory = "/workspace",
  ): Promise<SessionResource> {
    return parseSessionResource(
      await request(
        this.#fetch,
        `/v1/projects/${encodeURIComponent(projectId)}/sessions`,
        jsonRequest({
          workspaceId,
          title,
          executionMode,
          sandboxProfileKey,
          workingDirectory,
        }),
        this.#authorizationToken,
      ),
    );
  }

  async acceptTurn(
    sessionId: string,
    prompt: string,
    idempotencyKey: string,
    thinkingLevel?: TurnThinkingLevel,
  ): Promise<AcceptedTurnResource> {
    return parseAcceptedTurnResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/turns`,
        jsonRequest(
          {
            prompt,
            ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
          },
          idempotencyKey,
        ),
        this.#authorizationToken,
      ),
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

  async steerTurn(
    sessionId: string,
    turnId: string,
    text: string,
    idempotencyKey: string,
  ): Promise<TurnSteerResource> {
    return parseTurnSteerResource(
      await request(
        this.#fetch,
        `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/steers`,
        jsonRequest({ text }, idempotencyKey),
        this.#authorizationToken,
      ),
    );
  }
}

export function newIdempotencyKey(
  prefix:
    | "turn"
    | "cancel"
    | "steer"
    | "archive"
    | "delete"
    | "retry"
    | "fork"
    | "prune"
    | "environment"
    | "workspace-rebind",
): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}
