import { uploadHttp, readUploadReceipt } from "./upload-http.ts";
import {
  TOOL_WORKFLOW_PATH,
  parseInternalServiceError,
  parseSandboxControlListWorkspaceDirectoryResponse,
  parseSandboxControlReadWorkspaceFileResponse,
  parseSandboxControlResponse,
  parseSupervisorManagementResponse,
  parseSourceControlWorkspaceCredentialResponse,
  parseSourceControlWorkspaceCredentialDisconnectResponse,
  parseSourceControlWorkspaceCredentialListResponse,
  type SandboxControlRequest,
  type SandboxControlResponse,
  type SandboxControlListWorkspaceDirectoryRequest,
  type SandboxControlListWorkspaceDirectoryResponse,
  type SandboxControlReadWorkspaceFileRequest,
  type SandboxControlReadWorkspaceFileResponse,
  type SupervisorManagementRequest,
  type SupervisorManagementResponse,
  type SupervisorRuntimeAssignment,
  type ToolSandboxAssignment,
  type ToolSandboxCreateRequest,
  type ToolSandboxCreateResponse,
  type ToolSandboxReleaseResponse,
  type SourceControlWorkspaceCredentialAuthorizeRequest,
  type SourceControlWorkspaceCredentialDisconnectRequest,
  type SourceControlWorkspaceCredentialDisconnectResponse,
  type SourceControlWorkspaceCredentialListRequest,
  type SourceControlWorkspaceCredentialListResponse,
  type SourceControlWorkspaceCredentialPreflightRequest,
  type SourceControlWorkspaceCredentialResponse,
} from "@pi-cloud/protocol";
import { activeTraceCarrier } from "@pi-cloud/observability";
import { randomUUID } from "node:crypto";
import { Agent, fetch as internalFetch, type Response } from "undici";
import { uploadRelativePath, type WorkspaceUploadRequest } from "@pi-cloud/protocol";
import type { WorkspaceUploadReceipt } from "./workspace-volume-gateway-contract.ts";

// Broker routes may be Pod IPs; they must not traverse the provider egress proxy.
const internalDispatcher = new Agent();

export const SANDBOX_CONTROL_SERVICE_PATH = "/internal/v1/sandbox-control";
export const SANDBOX_CONTROL_INVENTORY_PATH = "/internal/v1/sandbox-inventory";
export const SANDBOX_CONTROL_WORKSPACE_BROWSER_PATH = "/internal/v1/workspace-browser";
export const SANDBOX_CONTROL_WORKSPACE_UPLOAD_PATH = "/internal/v1/workspace-upload";
export const SANDBOX_CONTROL_SOURCE_CONTROL_PATH = "/internal/v1/source-control";
export const SANDBOX_CONTROL_LIVE_PATH = "/health/live";
export const SANDBOX_CONTROL_READY_PATH = "/health/ready";

const MAX_RESPONSE_BYTES = 4 * 1_024 * 1_024;

export class SandboxControlClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SandboxControlClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type SandboxControlClientOptions = {
  baseUrl: string;
  serviceToken: string;
  allowInsecureHttp?: boolean;
  requestTimeoutMs?: number;
  idGenerator?: () => string;
};

function baseUrl(value: string, allowInsecure: boolean): URL {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    (parsed.protocol === "http:" && !allowInsecure)
  ) {
    throw new TypeError("Sandbox control base URL is invalid");
  }
  return parsed;
}

function token(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
    throw new TypeError("Sandbox control service token is invalid");
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 900_000) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new SandboxControlClientError(
      "tool_broker_protocol_error",
      "Sandbox control response was outside its byte limit",
      false,
    );
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new SandboxControlClientError(
      "tool_broker_protocol_error",
      "Sandbox control returned malformed JSON",
      false,
    );
  }
}

export class SandboxControlClient {
  readonly #baseUrl: URL;
  readonly #serviceToken: string;
  readonly #allowInsecureHttp: boolean;
  readonly #requestTimeoutMs: number;
  readonly #idGenerator: () => string;

  constructor(options: SandboxControlClientOptions) {
    this.#baseUrl = baseUrl(options.baseUrl, options.allowInsecureHttp ?? false);
    this.#serviceToken = token(options.serviceToken);
    this.#allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 300_000,
      "requestTimeoutMs",
    );
    this.#idGenerator = options.idGenerator ?? randomUUID;
  }

  get workflowUrl(): string {
    return new URL(TOOL_WORKFLOW_PATH, this.#baseUrl).toString();
  }

  workflowUrlFor(_activationId: string): string {
    return this.workflowUrl;
  }

  async checkHealth(): Promise<void> {
    let response: Response;
    try {
      response = await internalFetch(new URL(SANDBOX_CONTROL_READY_PATH, this.#baseUrl), {
        dispatcher: internalDispatcher,
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(this.#requestTimeoutMs, 10_000)),
      });
    } catch {
      throw new SandboxControlClientError(
        "tool_broker_unavailable",
        "Sandbox control is unavailable",
        true,
      );
    }
    await response.body?.cancel();
    if (!response.ok) {
      throw new SandboxControlClientError(
        "tool_broker_unavailable",
        "Sandbox control is not ready",
        true,
      );
    }
  }

  async create(
    request: ToolSandboxCreateRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxCreateResponse> {
    return this.#create(request, new Set(), signal);
  }

  async #create(
    request: ToolSandboxCreateRequest,
    visited: Set<string>,
    signal?: AbortSignal,
  ): Promise<ToolSandboxCreateResponse> {
    const current = this.#baseUrl.toString();
    if (visited.has(current) || visited.size >= 3) {
      throw new SandboxControlClientError(
        "tool_broker_redirect_loop",
        "Sandbox control owner redirect did not converge",
        false,
      );
    }
    visited.add(current);
    const response = await this.#service(request, signal);
    if (response.type === "tool_sandbox.owner_redirect") {
      const owner = new SandboxControlClient({
        baseUrl: response.ownerBaseUrl,
        serviceToken: this.#serviceToken,
        allowInsecureHttp: this.#allowInsecureHttp,
        requestTimeoutMs: this.#requestTimeoutMs,
        idGenerator: this.#idGenerator,
      });
      return owner.#create(request, visited, signal);
    }
    if (response.type !== "tool_sandbox.reserved" || response.requestId !== request.requestId) {
      throw new SandboxControlClientError(
        "tool_broker_protocol_error",
        "Sandbox control create response did not match",
        false,
      );
    }
    return response;
  }

  async preparePackage(
    request: Extract<SandboxControlRequest, { type: "tool_sandbox.prepare_package" }>,
    signal?: AbortSignal,
  ) {
    const response = await this.#service(request, signal);
    if (
      response.type !== "tool_sandbox.package_prepared" ||
      response.requestId !== request.requestId ||
      response.activationId !== request.activationId
    )
      throw new SandboxControlClientError(
        "package_preparation_invalid",
        "Package response identity changed",
        false,
      );
    return response;
  }

  async imageIo(
    request: Extract<
      import("@pi-cloud/protocol").SandboxControlRequest,
      { type: "tool_sandbox.image_io" }
    >,
    signal?: AbortSignal,
  ) {
    const response = await this.#service(request, signal);
    if (
      response.type !== "tool_sandbox.image_io_result" ||
      response.requestId !== request.requestId ||
      response.activationId !== request.activationId
    )
      throw new SandboxControlClientError(
        "tool_image_io_invalid",
        "Tool image response identity changed",
        false,
      );
    return response;
  }

  async prepareInputImages(
    activationId: string,
    assignment: ToolSandboxAssignment,
    images: import("@pi-cloud/protocol").ImageAttachmentReference[],
    signal?: AbortSignal,
  ) {
    const requestId = this.#idGenerator();
    const response = await this.#service(
      {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.prepare_input_images",
        requestId,
        activationId,
        assignment,
        images,
      },
      signal,
    );
    if (
      response.type !== "tool_sandbox.input_images_prepared" ||
      response.requestId !== requestId ||
      response.activationId !== activationId ||
      response.images.length !== images.length ||
      response.images.some((item, index) => item.sourceId !== images[index]!.id)
    )
      throw new SandboxControlClientError(
        "tool_broker_protocol_error",
        "Prepared input image identity changed",
        false,
      );
    return response.images;
  }

  async refreshServices(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    const requestId = this.#idGenerator();
    const response = await this.#service({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.refresh_services",
      requestId,
      activationId,
      assignment,
    });
    if (
      response.type !== "tool_sandbox.services_refreshed" ||
      response.requestId !== requestId ||
      response.activationId !== activationId
    ) {
      throw new SandboxControlClientError(
        "tool_broker_protocol_error",
        "Service discovery response did not match",
        false,
      );
    }
  }

  async release(
    activationId: string,
    assignment: ToolSandboxAssignment,
    disposition: { kind: "detach" | "keep_warm" | "destroy"; cancelOutstanding?: true },
  ): Promise<ToolSandboxReleaseResponse> {
    const requestId = this.#idGenerator();
    const response = await this.#service({
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.release",
      requestId,
      activationId,
      assignment,
      disposition: disposition.kind,
      ...(disposition.cancelOutstanding ? { cancelOutstanding: true } : {}),
    });
    if (
      response.type !== "tool_sandbox.released" ||
      response.requestId !== requestId ||
      response.activationId !== activationId
    ) {
      throw new SandboxControlClientError(
        "tool_broker_protocol_error",
        "Sandbox control release response did not match",
        false,
      );
    }
    return response;
  }

  async listWorkspaceDirectory(
    request: SandboxControlListWorkspaceDirectoryRequest,
    signal?: AbortSignal,
  ): Promise<SandboxControlListWorkspaceDirectoryResponse> {
    const response = parseSandboxControlListWorkspaceDirectoryResponse(
      await this.#request(
        SANDBOX_CONTROL_WORKSPACE_BROWSER_PATH,
        this.#serviceToken,
        request,
        signal,
      ),
    );
    if (
      response.requestId !== request.requestId ||
      response.tenantId !== request.tenantId ||
      response.workspaceId !== request.workspaceId ||
      response.path !== request.path
    ) {
      throw new SandboxControlClientError(
        "tool_broker_protocol_error",
        "Workspace directory response identity did not match",
        false,
      );
    }
    return response;
  }

  async uploadWorkspaceFile(
    request: WorkspaceUploadRequest,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<WorkspaceUploadReceipt> {
    let owner: SandboxControlClient = this;
    for (let redirects = 0; ; redirects++) {
      const response = await internalFetch(
        new URL(SANDBOX_CONTROL_WORKSPACE_UPLOAD_PATH, owner.#baseUrl),
        {
          dispatcher: internalDispatcher,
          redirect: "manual",
          method: "HEAD",
          headers: {
            authorization: `Bearer ${this.#serviceToken}`,
            "x-pi-cloud-upload": Buffer.from(JSON.stringify(request)).toString("base64url"),
          },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(this.#requestTimeoutMs)])
            : AbortSignal.timeout(this.#requestTimeoutMs),
        },
      );
      await response.body?.cancel();
      if (response.status === 307 && response.headers.get("location")) {
        if (redirects >= 3) throw new Error("Workspace owner routing did not converge");
        owner = new SandboxControlClient({
          baseUrl: response.headers.get("location")!,
          serviceToken: this.#serviceToken,
          allowInsecureHttp: this.#allowInsecureHttp,
          requestTimeoutMs: this.#requestTimeoutMs,
        });
        continue;
      }
      if (!response.ok)
        throw new SandboxControlClientError(
          "workspace_upload_failed",
          "Workspace upload preflight failed",
          response.status >= 500,
        );
      break;
    }
    return uploadHttp({
      url: new URL(SANDBOX_CONTROL_WORKSPACE_UPLOAD_PATH, owner.#baseUrl),
      token: this.#serviceToken,
      metadata: request,
      chunks,
      ...(signal ? { signal } : {}),
      receiptTimeoutMs: this.#requestTimeoutMs,
      read: async (response) => {
        if (!response.ok) {
          await response.body?.cancel();
          throw new SandboxControlClientError(
            "workspace_upload_failed",
            "Workspace upload failed; retry its identity",
            response.status >= 500 || response.status === 307,
          );
        }
        const receipt = (await readUploadReceipt(response)) as WorkspaceUploadReceipt;
        if (
          receipt.sha256 !== request.sha256 ||
          receipt.byteLength !== request.byteLength ||
          receipt.relativePath !== uploadRelativePath(request.uploadId, request.name)
        )
          throw new Error("Workspace upload receipt changed identity");
        return receipt;
      },
    });
  }

  async readWorkspaceFile(
    request: SandboxControlReadWorkspaceFileRequest,
    signal?: AbortSignal,
  ): Promise<SandboxControlReadWorkspaceFileResponse> {
    const response = parseSandboxControlReadWorkspaceFileResponse(
      await this.#request(
        SANDBOX_CONTROL_WORKSPACE_BROWSER_PATH,
        this.#serviceToken,
        request,
        signal,
      ),
    );
    if (
      response.requestId !== request.requestId ||
      response.tenantId !== request.tenantId ||
      response.workspaceId !== request.workspaceId ||
      response.path !== request.path
    ) {
      throw new SandboxControlClientError(
        "tool_broker_protocol_error",
        "Workspace file response identity did not match",
        false,
      );
    }
    return response;
  }

  async authorizeSourceCredential(
    request: SourceControlWorkspaceCredentialAuthorizeRequest,
    signal?: AbortSignal,
  ): Promise<SourceControlWorkspaceCredentialResponse> {
    return this.#sourceCredential(request, signal);
  }

  async preflightSourceCredential(
    request: SourceControlWorkspaceCredentialPreflightRequest,
    signal?: AbortSignal,
  ): Promise<SourceControlWorkspaceCredentialResponse> {
    return this.#sourceCredential(request, signal);
  }

  async #sourceCredential(
    request:
      | SourceControlWorkspaceCredentialAuthorizeRequest
      | SourceControlWorkspaceCredentialPreflightRequest,
    signal?: AbortSignal,
  ): Promise<SourceControlWorkspaceCredentialResponse> {
    const response = parseSourceControlWorkspaceCredentialResponse(
      await this.#request(SANDBOX_CONTROL_SOURCE_CONTROL_PATH, this.#serviceToken, request, signal),
    );
    if (
      response.requestId !== request.requestId ||
      response.workspaceId !== request.workspaceId ||
      response.origin !== request.origin
    ) {
      throw new SandboxControlClientError(
        "tool_broker_protocol_error",
        "Source-control credential response identity did not match",
        false,
      );
    }
    return response;
  }

  async listSourceCredentials(
    request: SourceControlWorkspaceCredentialListRequest,
    signal?: AbortSignal,
  ): Promise<SourceControlWorkspaceCredentialListResponse> {
    const response = parseSourceControlWorkspaceCredentialListResponse(
      await this.#request(SANDBOX_CONTROL_SOURCE_CONTROL_PATH, this.#serviceToken, request, signal),
    );
    if (response.requestId !== request.requestId || response.workspaceId !== request.workspaceId) {
      throw new SandboxControlClientError(
        "tool_broker_protocol_error",
        "Source-control credential list identity did not match",
        false,
      );
    }
    return response;
  }

  async disconnectSourceCredential(
    request: SourceControlWorkspaceCredentialDisconnectRequest,
    signal?: AbortSignal,
  ): Promise<SourceControlWorkspaceCredentialDisconnectResponse> {
    const response = parseSourceControlWorkspaceCredentialDisconnectResponse(
      await this.#request(SANDBOX_CONTROL_SOURCE_CONTROL_PATH, this.#serviceToken, request, signal),
    );
    if (
      response.requestId !== request.requestId ||
      response.workspaceId !== request.workspaceId ||
      response.origin !== request.origin ||
      response.provider !== request.provider
    ) {
      throw new SandboxControlClientError(
        "tool_broker_protocol_error",
        "Source-control credential disconnect identity did not match",
        false,
      );
    }
    return response;
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    const requestId = this.#idGenerator();
    const response = await this.#inventory({
      protocolVersion: 1,
      type: "assignments.list",
      requestId,
      sandboxId,
    });
    if (
      response.type !== "assignments.listed" ||
      response.requestId !== requestId ||
      response.sandboxId !== sandboxId
    ) {
      throw new SandboxControlClientError(
        "tool_broker_protocol_error",
        "Sandbox inventory response did not match",
        false,
      );
    }
    return response.assignments;
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#assignmentMutation("assignment.terminate_and_confirm", assignment);
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#assignmentMutation("assignment.confirm_absent", assignment);
  }

  async #assignmentMutation(
    type: "assignment.terminate_and_confirm" | "assignment.confirm_absent",
    assignment: SupervisorRuntimeAssignment,
  ): Promise<void> {
    const requestId = this.#idGenerator();
    const response = await this.#inventory({
      protocolVersion: 1,
      type,
      requestId,
      sandboxId: assignment.sandboxId,
      assignment,
    });
    if (
      response.type !== "assignment.absent" ||
      response.requestId !== requestId ||
      response.sandboxId !== assignment.sandboxId ||
      response.containerId !== assignment.containerId
    ) {
      throw new SandboxControlClientError(
        "tool_broker_protocol_error",
        "Sandbox inventory mutation response did not match",
        false,
      );
    }
  }

  async #service(
    request: SandboxControlRequest,
    signal?: AbortSignal,
  ): Promise<SandboxControlResponse> {
    return parseSandboxControlResponse(
      await this.#request(SANDBOX_CONTROL_SERVICE_PATH, this.#serviceToken, request, signal),
    );
  }

  async #inventory(request: SupervisorManagementRequest): Promise<SupervisorManagementResponse> {
    return parseSupervisorManagementResponse(
      await this.#request(SANDBOX_CONTROL_INVENTORY_PATH, this.#serviceToken, request),
    );
  }

  async #request(
    path: string,
    bearer: string,
    body: unknown,
    signal?: AbortSignal,
    redirects = 0,
  ): Promise<unknown> {
    const action = body as { type?: string; disposition?: string };
    const closingScope = action.type === "tool_sandbox.release" && action.disposition !== "destroy";
    const timeoutSignal = AbortSignal.timeout(
      closingScope ? Math.min(30_000, this.#requestTimeoutMs) : this.#requestTimeoutMs,
    );
    const combinedSignal =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    let response: Response;
    try {
      const trace = activeTraceCarrier();
      response = await internalFetch(new URL(path, this.#baseUrl), {
        dispatcher: internalDispatcher,
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          ...(trace === undefined ? {} : { traceparent: trace.traceparent }),
          ...(trace?.tracestate === undefined ? {} : { tracestate: trace.tracestate }),
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
        redirect: "manual",
      });
    } catch {
      throw new SandboxControlClientError(
        "tool_broker_unavailable",
        "Sandbox control request failed",
        true,
      );
    }
    if (
      path === SANDBOX_CONTROL_WORKSPACE_BROWSER_PATH &&
      response.status === 307 &&
      response.headers.get("location")
    ) {
      await response.body?.cancel();
      if (redirects >= 3)
        throw new SandboxControlClientError(
          "tool_broker_redirect_loop",
          "Workspace owner routing did not converge",
          false,
        );
      const owner = new SandboxControlClient({
        baseUrl: response.headers.get("location")!,
        serviceToken: this.#serviceToken,
        allowInsecureHttp: this.#allowInsecureHttp,
        requestTimeoutMs: this.#requestTimeoutMs,
      });
      return owner.#request(path, bearer, body, signal, redirects + 1);
    }
    const value = await boundedJson(response);
    if (!response.ok) {
      try {
        const failure = parseInternalServiceError(value).error;
        throw new SandboxControlClientError(failure.code, failure.message, failure.retryable);
      } catch (error: unknown) {
        if (error instanceof SandboxControlClientError) throw error;
        throw new SandboxControlClientError(
          "tool_broker_protocol_error",
          "Sandbox control returned an invalid failure",
          false,
        );
      }
    }
    return value;
  }
}

export type ReplicatedSandboxControlClientOptions = Omit<SandboxControlClientOptions, "baseUrl"> & {
  baseUrls: readonly string[];
};

/**
 * Balances new reservations across Sandbox-Domain Sandbox control replicas. The durable
 * owner returned by create controls the complete Tool binding. Follow-up Tool
 * calls never fail over to another replica because doing so could replay an
 * ambiguous side effect. A warm owner can redirect a later create request back
 * to itself through the Sandbox control owner directory.
 */
export class ReplicatedSandboxControlClient {
  readonly #clients: readonly SandboxControlClient[];
  readonly #ownerClients = new Map<string, SandboxControlClient>();
  readonly #toolBindingOwners = new Map<
    string,
    Readonly<{ client: SandboxControlClient; holders: Set<string> }>
  >();
  readonly #serviceToken: string;
  readonly #allowInsecureHttp: boolean;
  readonly #requestTimeoutMs: number;
  readonly #idGenerator: () => string;
  #nextClient = 0;

  constructor(options: ReplicatedSandboxControlClientOptions) {
    if (options.baseUrls.length < 1 || options.baseUrls.length > 256) {
      throw new TypeError("Sandbox control replica URL list must contain 1-256 entries");
    }
    if (new Set(options.baseUrls).size !== options.baseUrls.length) {
      throw new TypeError("Sandbox control replica URLs must be unique");
    }
    this.#serviceToken = token(options.serviceToken);
    this.#allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 300_000,
      "requestTimeoutMs",
    );
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#clients = options.baseUrls.map((replicaUrl) => {
      const client = new SandboxControlClient({ ...options, baseUrl: replicaUrl });
      this.#ownerClients.set(new URL(replicaUrl).toString(), client);
      return client;
    });
  }

  workflowUrlFor(activationId: string): string {
    return this.#ownedClient(activationId).workflowUrlFor(activationId);
  }

  async checkHealth(): Promise<void> {
    const results = await Promise.allSettled(this.#clients.map((client) => client.checkHealth()));
    if (results.some((result) => result.status === "fulfilled")) return;
    const failure = results[0];
    if (failure?.status === "rejected" && failure.reason instanceof Error) throw failure.reason;
    throw new SandboxControlClientError(
      "tool_broker_unavailable",
      "Sandbox control replica set is unavailable",
      true,
    );
  }

  async create(
    request: ToolSandboxCreateRequest,
    signal?: AbortSignal,
  ): Promise<ToolSandboxCreateResponse> {
    const client = this.#clients[this.#nextClient % this.#clients.length]!;
    this.#nextClient += 1;
    const response = await client.create(request, signal);
    this.#rememberToolBindingOwner(
      response.activationId,
      response.ownerBaseUrl,
      request.assignment,
    );
    return response;
  }

  prepareInputImages(
    activationId: string,
    assignment: ToolSandboxAssignment,
    images: import("@pi-cloud/protocol").ImageAttachmentReference[],
    signal?: AbortSignal,
  ) {
    return this.#ownedClient(activationId).prepareInputImages(
      activationId,
      assignment,
      images,
      signal,
    );
  }

  refreshServices(activationId: string, assignment: ToolSandboxAssignment): Promise<void> {
    return this.#ownedClient(activationId).refreshServices(activationId, assignment);
  }

  async release(
    activationId: string,
    assignment: ToolSandboxAssignment,
    disposition: { kind: "detach" | "keep_warm" | "destroy"; cancelOutstanding?: true },
  ): Promise<ToolSandboxReleaseResponse> {
    try {
      if (disposition.kind === "destroy")
        return await this.#ownedClient(activationId).release(activationId, assignment, disposition);
      return await this.#closeThroughReplica(activationId, (client) =>
        client.release(activationId, assignment, disposition),
      );
    } finally {
      this.#forgetToolBindingOwner(activationId, assignment);
    }
  }

  listWorkspaceDirectory(
    request: SandboxControlListWorkspaceDirectoryRequest,
    signal?: AbortSignal,
  ): Promise<SandboxControlListWorkspaceDirectoryResponse> {
    return this.#nextReplica().listWorkspaceDirectory(request, signal);
  }

  uploadWorkspaceFile(
    request: WorkspaceUploadRequest,
    chunks: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<WorkspaceUploadReceipt> {
    return this.#nextReplica().uploadWorkspaceFile(request, chunks, signal);
  }

  readWorkspaceFile(
    request: SandboxControlReadWorkspaceFileRequest,
    signal?: AbortSignal,
  ): Promise<SandboxControlReadWorkspaceFileResponse> {
    return this.#nextReplica().readWorkspaceFile(request, signal);
  }

  authorizeSourceCredential(
    request: SourceControlWorkspaceCredentialAuthorizeRequest,
    signal?: AbortSignal,
  ): Promise<SourceControlWorkspaceCredentialResponse> {
    return this.#nextReplica().authorizeSourceCredential(request, signal);
  }

  preflightSourceCredential(
    request: SourceControlWorkspaceCredentialPreflightRequest,
    signal?: AbortSignal,
  ): Promise<SourceControlWorkspaceCredentialResponse> {
    return this.#nextReplica().preflightSourceCredential(request, signal);
  }

  listSourceCredentials(
    request: SourceControlWorkspaceCredentialListRequest,
    signal?: AbortSignal,
  ): Promise<SourceControlWorkspaceCredentialListResponse> {
    return this.#nextReplica().listSourceCredentials(request, signal);
  }

  disconnectSourceCredential(
    request: SourceControlWorkspaceCredentialDisconnectRequest,
    signal?: AbortSignal,
  ): Promise<SourceControlWorkspaceCredentialDisconnectResponse> {
    return this.#nextReplica().disconnectSourceCredential(request, signal);
  }

  async listAssignments(sandboxId: string): Promise<readonly SupervisorRuntimeAssignment[]> {
    const assignments = await Promise.all(
      this.#clients.map((client) => client.listAssignments(sandboxId)),
    );
    const unique = new Map<string, SupervisorRuntimeAssignment>();
    for (const assignment of assignments.flat()) {
      unique.set(`${assignment.containerId}\0${assignment.executionReference}`, assignment);
    }
    return [...unique.values()];
  }

  async terminateAndConfirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#allReplicas((client) => client.terminateAndConfirmAbsent(assignment));
  }

  async confirmAbsent(assignment: SupervisorRuntimeAssignment): Promise<void> {
    await this.#allReplicas((client) => client.confirmAbsent(assignment));
  }

  async #closeThroughReplica<T>(
    activationId: string,
    operation: (client: SandboxControlClient) => Promise<T>,
  ): Promise<T> {
    // Only idempotent scope closure retries through the stable entrypoint after
    // a controller Pod is replaced. Fixed Tool commands never use this client.
    let failure: unknown;
    for (const client of new Set([this.#ownedClient(activationId), ...this.#clients])) {
      try {
        return await operation(client);
      } catch (error) {
        if (!(error instanceof SandboxControlClientError) || !error.retryable) throw error;
        failure = error;
      }
    }
    throw failure;
  }

  #ownedClient(activationId: string): SandboxControlClient {
    const owner = this.#toolBindingOwners.get(activationId);
    if (owner !== undefined) return owner.client;
    throw new SandboxControlClientError(
      "tool_broker_owner_unknown",
      "Tool binding owner is unavailable",
      false,
    );
  }

  #rememberToolBindingOwner(
    activationId: string,
    ownerBaseUrl: string,
    assignment: ToolSandboxAssignment,
  ): void {
    const client = this.#ownerClient(ownerBaseUrl);
    const holder = this.#toolBindingHolder(assignment);
    const existing = this.#toolBindingOwners.get(activationId);
    if (existing !== undefined) {
      if (existing.client !== client) {
        throw new SandboxControlClientError(
          "tool_broker_owner_changed",
          "Tool binding owner changed during a concurrent binding",
          false,
        );
      }
      existing.holders.add(holder);
      return;
    }
    this.#toolBindingOwners.set(activationId, { client, holders: new Set([holder]) });
  }

  #forgetToolBindingOwner(activationId: string, assignment: ToolSandboxAssignment): void {
    const owner = this.#toolBindingOwners.get(activationId);
    if (owner === undefined) return;
    owner.holders.delete(this.#toolBindingHolder(assignment));
    if (owner.holders.size === 0) this.#toolBindingOwners.delete(activationId);
  }

  #toolBindingHolder(assignment: ToolSandboxAssignment): string {
    return [
      assignment.tenantId,
      assignment.workspaceId,
      assignment.sessionId,
      assignment.executionReference,
    ].join("\0");
  }

  #ownerClient(ownerBaseUrl: string): SandboxControlClient {
    const key = new URL(ownerBaseUrl).toString();
    const existing = this.#ownerClients.get(key);
    if (existing !== undefined) return existing;
    const client = new SandboxControlClient({
      baseUrl: key,
      serviceToken: this.#serviceToken,
      allowInsecureHttp: this.#allowInsecureHttp,
      requestTimeoutMs: this.#requestTimeoutMs,
      idGenerator: this.#idGenerator,
    });
    this.#ownerClients.set(key, client);
    return client;
  }

  #nextReplica(): SandboxControlClient {
    const client = this.#clients[this.#nextClient % this.#clients.length]!;
    this.#nextClient += 1;
    return client;
  }

  async #allReplicas(operation: (client: SandboxControlClient) => Promise<void>): Promise<void> {
    const results = await Promise.allSettled(this.#clients.map(operation));
    if (results.some((result) => result.status === "fulfilled")) return;
    const first = results[0];
    if (first?.status === "rejected") throw first.reason;
    throw new SandboxControlClientError(
      "tool_broker_unavailable",
      "Sandbox control replica operation failed",
      true,
    );
  }
}
