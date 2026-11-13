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

import {
  parseInputQueueResource,
  parseQueuedInputActionResult,
  type InputQueueResource,
  type QueuedInputAction,
  type QueuedInputActionResult,
  parseReturnedInputsResource,
  type ReturnedInputsResource,
  parseAcceptedTurnCancellationResource,
  parseAcceptedConversationInputResource,
  parseConversationDetailResource,
  parseConversationListResource,
  parseConversationTreeResource,
  parseConversationForkResource,
  parseConversationPruneResource,
  parseModelCatalogResource,
  parseSessionModelResource,
  parseRunResource,
  parseSessionResource,
  parseTenantIdentityResource,
  parseConversationWorkspaceBindingResource,
  type ConversationDetailResource,
  type ConversationListResource,
  type ConversationTreeResource,
  type ConversationTreeView,
  type ConversationForkResource,
  type ConversationPruneResource,
  type AcceptedTurnCancellationResource,
  type AcceptedConversationInputResource,
  type RunResource,
  type SessionModelSelection,
  type ModelCatalogResource,
  type SessionModelResource,
  type ExecutionMode,
  type SessionResource,
  type TenantIdentityResource,
  type TurnThinkingLevel,
  type ConversationWorkspaceBindingResource,
} from "@pi-cloud/protocol";
import { request, requestBytes, jsonRequest, type FetchImplementation } from "./http.ts";
import { streamSessionEvents, type StreamSessionEventsOptions } from "./sse.ts";
export class SessionApi {
  readonly #fetch: FetchImplementation;
  readonly #authorizationToken: string | undefined;
  constructor(
    fetchImplementation: FetchImplementation = globalThis.fetch.bind(globalThis),
    authorizationToken?: string,
    baseUrl?: string,
  ) {
    if (baseUrl !== undefined && !["http:", "https:"].includes(new URL(baseUrl).protocol))
      throw new TypeError("Invalid Session API origin");
    this.#fetch =
      baseUrl === undefined
        ? fetchImplementation
        : (input, init) =>
            fetchImplementation(typeof input === "string" ? new URL(input, baseUrl) : input, init);
    if (
      authorizationToken !== undefined &&
      (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(authorizationToken) ||
        /[\r\n]/.test(authorizationToken))
    ) {
      throw new TypeError("authorizationToken is invalid");
    }
    this.#authorizationToken = authorizationToken;
  }
  async getIdentity(): Promise<TenantIdentityResource> {
    return parseTenantIdentityResource(
      await request(this.#fetch, "/v1/identity", { method: "GET" }, this.#authorizationToken),
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
  async inputReceipt(
    sessionId: string,
    key: string,
  ): Promise<{ status: "accepted" | "unconfirmed" }> {
    const value = (await request(
      this.#fetch,
      `/v1/sessions/${encodeURIComponent(sessionId)}/input-receipt?key=${encodeURIComponent(key)}`,
      { method: "GET" },
      this.#authorizationToken,
    )) as { status?: unknown };
    if (value.status !== "accepted" && value.status !== "unconfirmed")
      throw new Error("Invalid input receipt");
    return { status: value.status };
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
  streamSession(
    options: Omit<StreamSessionEventsOptions, "fetchImplementation" | "authorizationToken">,
  ) {
    return streamSessionEvents({
      ...options,
      fetchImplementation: this.#fetch,
      ...(this.#authorizationToken ? { authorizationToken: this.#authorizationToken } : {}),
    });
  }
}
