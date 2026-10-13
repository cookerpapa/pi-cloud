import { SUBAGENT_HOST_PATH, type SubagentHostRequest } from "@pi-cloud/protocol";
import { Agent, fetch as internalFetch } from "undici";
import {
  parseInternalServiceError,
  parseSupervisorManagementResponse,
  type SupervisorManagementRequest,
  type SupervisorRuntimeAssignment,
  type NativeInputCommand,
  type NativeInputResult,
} from "@pi-cloud/protocol";
import {
  SandboxAssignmentInventoryError,
  type SandboxAssignmentInventory,
  type SandboxRuntimeAssignment,
} from "@pi-cloud/protocol";
import type {
  SupervisorBootIdentity,
  SupervisorOwnerBoundary,
} from "./supervisor-connection-manager.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MANAGEMENT_PATH = "/internal/v1/supervisor/manage";

export type HttpSupervisorManagementClientOptions = {
  baseUrl: string;
  managementToken: string;
  allowInsecureHttp?: boolean;
  requestTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  idGenerator?: () => string;
};

export type SupervisorManagementClientResolver = (
  identity: SupervisorBootIdentity,
) => Promise<HttpSupervisorManagementClient>;

export class HttpSupervisorManagementError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "HttpSupervisorManagementError";
    this.code = code;
    this.retryable = retryable;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function baseUrl(value: string, allowInsecure: boolean): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TypeError("Supervisor management base URL is invalid");
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new TypeError("Plain HTTP Supervisor management requires explicit opt-in");
  }
  return parsed.toString();
}

function boundedToken(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
    throw new TypeError("managementToken must contain 32-4096 bounded ASCII bytes");
  }
  return value;
}

function protocolAssignment(value: SandboxRuntimeAssignment): SupervisorRuntimeAssignment {
  return {
    containerId: value.runtimeId,
    containerName: value.runtimeName,
    supervisorId: value.supervisorId,
    bootId: value.bootId,
    sandboxId: value.sandboxId,
    runId: value.runId,
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    executionReference: value.executionReference,
  };
}

function runtimeAssignment(value: SupervisorRuntimeAssignment): SandboxRuntimeAssignment {
  return {
    runtimeId: value.containerId,
    runtimeName: value.containerName,
    supervisorId: value.supervisorId,
    bootId: value.bootId,
    sandboxId: value.sandboxId,
    runId: value.runId,
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    turnId: value.turnId,
    executionReference: value.executionReference,
  };
}

export class HttpSupervisorManagementClient {
  readonly #url: string;
  readonly #authorization: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #idGenerator: () => string;

  constructor(options: HttpSupervisorManagementClientOptions) {
    const root = baseUrl(options.baseUrl, options.allowInsecureHttp === true);
    this.#url = new URL(DEFAULT_MANAGEMENT_PATH, root).toString();
    this.#authorization = `Bearer ${boundedToken(options.managementToken)}`;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.#fetch = options.fetchImplementation ?? managementFetch;
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
  }

  requestId(): string {
    return this.#idGenerator();
  }

  async subagent(command: SubagentHostRequest): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(SUBAGENT_HOST_PATH, this.#url), {
        method: "POST",
        redirect: "error",
        headers: { authorization: this.#authorization, "content-type": "application/json" },
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
        body: JSON.stringify(command),
      });
    } catch {
      throw new HttpSupervisorManagementError(
        "subagent_host_unavailable",
        "Subagent Worker delivery is unconfirmed",
        true,
      );
    }
    if (!response.ok) {
      const failure = await response
        .json()
        .then((body) => parseInternalServiceError(body).error)
        .catch(() => undefined);
      throw new HttpSupervisorManagementError(
        failure?.code ?? "subagent_host_rejected",
        failure?.message ?? "Native management rejected the request",
        failure?.retryable ?? response.status >= 500,
      );
    }
    return ((await response.json()) as { result?: unknown }).result;
  }

  async request(message: SupervisorManagementRequest) {
    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
        headers: {
          authorization: this.#authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify(message),
      });
    } catch {
      throw new HttpSupervisorManagementError(
        "supervisor_management_unavailable",
        "Supervisor management service is unavailable",
        true,
      );
    }
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw new HttpSupervisorManagementError(
        "supervisor_management_invalid_response",
        "Supervisor management returned an invalid response",
        // Ingresses return plain text/HTML while the Worker has no Ready
        // endpoint. That is temporary unavailability, not a protocol violation.
        response.status >= 500,
      );
    }
    if (!response.ok) {
      try {
        const failure = parseInternalServiceError(body).error;
        throw new HttpSupervisorManagementError(failure.code, failure.message, failure.retryable);
      } catch (error: unknown) {
        if (error instanceof HttpSupervisorManagementError) throw error;
        throw new HttpSupervisorManagementError(
          "supervisor_management_rejected",
          "Supervisor management rejected the request",
          response.status >= 500,
        );
      }
    }
    try {
      return parseSupervisorManagementResponse(body);
    } catch {
      throw new HttpSupervisorManagementError(
        "supervisor_management_invalid_response",
        "Supervisor management returned an invalid response",
        false,
      );
    }
  }

  async humanInput(command: NativeInputCommand): Promise<NativeInputResult> {
    const requestId = this.requestId();
    const request = {
      protocolVersion: 1 as const,
      type: "native.input" as const,
      requestId,
      command,
    };
    let response;
    try {
      response = await this.request(request);
    } catch (error) {
      if (!(error instanceof HttpSupervisorManagementError) || !error.retryable) throw error;
      // The same native submission/mutation identity is safe after a lost reply.
      response = await this.request(request);
    }
    if (
      response.type !== "native.input.applied" ||
      response.requestId !== requestId ||
      response.result.queue.runId !== command.runId
    )
      throw new HttpSupervisorManagementError(
        "backend_protocol_violation",
        "Native input response did not match",
        false,
      );
    return response.result;
  }
}

export class HttpSupervisorOwnerBoundary implements SupervisorOwnerBoundary {
  readonly #client: HttpSupervisorManagementClient;

  constructor(client: HttpSupervisorManagementClient) {
    this.#client = client;
  }

  async stopAndConfirm(identity: SupervisorBootIdentity): Promise<void> {
    const requestId = this.#client.requestId();
    const response = await this.#client.request({
      protocolVersion: 1,
      type: "owner.stop_and_confirm",
      requestId,
      identity,
    });
    if (
      response.type !== "owner.stopped" ||
      response.requestId !== requestId ||
      response.identity.supervisorId !== identity.supervisorId ||
      response.identity.bootId !== identity.bootId ||
      response.identity.sandboxId !== identity.sandboxId
    ) {
      throw new HttpSupervisorManagementError(
        "owner_stop_response_mismatch",
        "Supervisor owner-stop proof did not match",
        false,
      );
    }
  }
}

export class RoutedHttpSupervisorOwnerBoundary implements SupervisorOwnerBoundary {
  readonly #resolveClient: SupervisorManagementClientResolver;

  constructor(resolveClient: SupervisorManagementClientResolver) {
    this.#resolveClient = resolveClient;
  }

  async stopAndConfirm(identity: SupervisorBootIdentity): Promise<void> {
    await new HttpSupervisorOwnerBoundary(await this.#resolveClient(identity)).stopAndConfirm(
      identity,
    );
  }
}

export class HttpSandboxAssignmentInventory implements SandboxAssignmentInventory {
  readonly #client: HttpSupervisorManagementClient;
  readonly #sandboxId: string;

  constructor(client: HttpSupervisorManagementClient, sandboxId: string) {
    this.#client = client;
    this.#sandboxId = sandboxId;
  }

  async listAssignments(): Promise<readonly SandboxRuntimeAssignment[]> {
    const requestId = this.#client.requestId();
    const response = await this.#client.request({
      protocolVersion: 1,
      type: "assignments.list",
      requestId,
      sandboxId: this.#sandboxId,
    });
    if (
      response.type !== "assignments.listed" ||
      response.requestId !== requestId ||
      response.sandboxId !== this.#sandboxId
    ) {
      throw new SandboxAssignmentInventoryError(
        "remote_inventory_response_mismatch",
        "Remote assignment inventory response did not match",
        false,
      );
    }
    return response.assignments.map(runtimeAssignment);
  }

  async terminateAndConfirmAbsent(assignment: SandboxRuntimeAssignment): Promise<void> {
    if (assignment.sandboxId !== this.#sandboxId) {
      throw new SandboxAssignmentInventoryError(
        "remote_inventory_scope_mismatch",
        "Remote assignment escaped its inventory scope",
        false,
      );
    }
    const requestId = this.#client.requestId();
    const response = await this.#client.request({
      protocolVersion: 1,
      type: "assignment.terminate_and_confirm",
      requestId,
      sandboxId: this.#sandboxId,
      assignment: protocolAssignment(assignment),
    });
    if (
      response.type !== "assignment.absent" ||
      response.requestId !== requestId ||
      response.sandboxId !== this.#sandboxId ||
      response.containerId !== assignment.runtimeId
    ) {
      throw new SandboxAssignmentInventoryError(
        "remote_inventory_response_mismatch",
        "Remote assignment absence proof did not match",
        false,
      );
    }
  }
}

export class RoutedHttpSandboxAssignmentInventory implements SandboxAssignmentInventory {
  readonly #identity: SupervisorBootIdentity;
  readonly #resolveClient: SupervisorManagementClientResolver;

  constructor(resolveClient: SupervisorManagementClientResolver, identity: SupervisorBootIdentity) {
    this.#resolveClient = resolveClient;
    this.#identity = identity;
  }

  async listAssignments(): Promise<readonly SandboxRuntimeAssignment[]> {
    return new HttpSandboxAssignmentInventory(
      await this.#resolveClient(this.#identity),
      this.#identity.sandboxId,
    ).listAssignments();
  }

  async terminateAndConfirmAbsent(assignment: SandboxRuntimeAssignment): Promise<void> {
    await new HttpSandboxAssignmentInventory(
      await this.#resolveClient(this.#identity),
      this.#identity.sandboxId,
    ).terminateAndConfirmAbsent(assignment);
  }
}

// Management uses the private network, never the model egress proxy.
const managementDispatcher = new Agent({ connections: 4 });
const managementFetch: typeof fetch = async (url, init) =>
  (await internalFetch(String(url), { ...init, dispatcher: managementDispatcher } as Parameters<
    typeof internalFetch
  >[1])) as unknown as Response;
