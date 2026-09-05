import {
  TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_PATH,
  TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_TERMINAL_PATH,
  MAX_WORKSPACE_TERMINAL_FRAME_BYTES,
  TOOL_BROKER_TERMINAL_PATH,
  parseWorkspaceTerminalClientFrame,
  parseWorkspaceTerminalOpenRequest,
  parseDevelopmentEnvironmentBrokerRequest,
  parseDevelopmentEnvironmentTerminalOpenRequest,
  parseToolBrokerRequest,
  parseToolBrokerListWorkspaceDirectoryRequest,
  parseToolBrokerReadWorkspaceFileRequest,
  parseSupervisorManagementRequest,
  parseToolSandboxOperationRequest,
  parseSourceControlWorkspaceCredentialRequest,
  TOOL_BROKER_SANDBOX_PREVIEW_PATH,
  PREVIEW_SCOPE_HEADER,
  PREVIEW_ACCESS_TTL_MS,
  parseSandboxPreviewConnection,
  type InternalServiceError,
  type SupervisorManagementResponse,
} from "@pi-cloud/protocol";
import fastifyWebsocket from "@fastify/websocket";
import { parseTraceCarrier, withSpan, type PiCloudMetrics } from "@pi-cloud/observability";
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import {
  TOOL_BROKER_INVENTORY_PATH,
  TOOL_BROKER_LIVE_PATH,
  TOOL_BROKER_WORKSPACE_BROWSER_PATH,
  TOOL_BROKER_OPERATION_PATH,
  TOOL_BROKER_READY_PATH,
  TOOL_BROKER_SERVICE_PATH,
  TOOL_BROKER_SOURCE_CONTROL_PATH,
} from "./tool-broker-client.ts";
import { ToolBrokerError } from "./sandbox-provider.ts";
import { ToolBrokerOwnerRedirectError, type ToolBroker } from "./tool-broker.ts";

const DEFAULT_BODY_LIMIT = 5 * 1_024 * 1_024;
const DEFAULT_TERMINAL_SEND_BUFFER_BYTES = 1 * 1_024 * 1_024;
export { TOOL_BROKER_TERMINAL_PATH };

export type ToolBrokerServerOptions = {
  host: string;
  port: number;
  serviceToken: string;
  workspaceServiceToken?: string;
  terminalToken?: string;
  broker: ToolBrokerBackend;
  bodyLimit?: number;
  metrics?: PiCloudMetrics;
};

export type ToolBrokerBackend = Pick<
  ToolBroker,
  | "checkHealth"
  | "create"
  | "capture"
  | "refreshServices"
  | "forkWorkspace"
  | "release"
  | "stop"
  | "execute"
  | "listWorkspaceDirectory"
  | "readWorkspaceFile"
  | "listAssignments"
  | "terminateAndConfirmAbsent"
  | "confirmAbsent"
  | "close"
  | "activeCount"
  | "admittedCount"
  | "admissionWaitingCount"
  | "maximumActiveSandboxes"
  | "cleanPrewarmCount"
  | "providerId"
> &
  Partial<
    Pick<
      ToolBroker,
      | "openTerminal"
      | "provisionDevelopmentEnvironment"
      | "developmentEnvironmentLifecycle"
      | "browseDevelopmentEnvironment"
      | "openDevelopmentEnvironmentTerminal"
      | "openPreviewConnection"
      | "authorizeSourceCredential"
      | "preflightSourceCredential"
      | "listSourceCredentials"
      | "disconnectSourceCredential"
    >
  >;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function validServiceToken(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
    throw new TypeError("Tool Broker service token is invalid");
  }
  return value;
}

function bearer(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 4_103) return undefined;
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value)?.[1];
}

function safeFailure(error: unknown): ToolBrokerError {
  if (error instanceof ToolBrokerError) return error;
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    /ProtocolError$/.test(error.name)
  ) {
    return new ToolBrokerError(
      "tool_broker_protocol_error",
      "Tool Broker request failed validation",
      false,
    );
  }
  return new ToolBrokerError("tool_broker_failed", "Tool Broker operation failed", true);
}

function safeDiagnostic(error: unknown): Readonly<{
  name: string;
  message: string;
  cause?: Readonly<{ name: string; message: string }>;
}> {
  const detail = (value: unknown): Readonly<{ name: string; message: string }> => {
    if (!(value instanceof Error)) {
      return { name: "UnknownError", message: "Non-Error failure" };
    }
    const clean = (text: string, fallback: string): string => {
      const normalized = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
      return normalized.length === 0 ? fallback : normalized.slice(0, 1_024);
    };
    return {
      name: clean(value.name, "Error"),
      message: clean(value.message, "Operation failed without a message"),
    };
  };
  const primary = detail(error);
  const cause =
    error instanceof Error && error.cause !== undefined ? detail(error.cause) : undefined;
  return cause === undefined ? primary : { ...primary, cause };
}

function reportFailure(event: string, failure: ToolBrokerError, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "pi-cloud-tool-broker",
      event,
      publicCode: failure.code,
      retryable: failure.retryable,
      diagnostic: safeDiagnostic(error),
    })}\n`,
  );
}

export class ToolBrokerServer {
  readonly #host: string;
  readonly #port: number;
  readonly #serviceDigest: Buffer;
  readonly #workspaceServiceDigest: Buffer | undefined;
  readonly #terminalDigest: Buffer | undefined;
  readonly #broker: ToolBrokerBackend;
  readonly #server: FastifyInstance;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #capacityMetrics: NodeJS.Timeout;
  #address: string | undefined;
  #ready = false;
  readonly #previewConnections = new Set<import("node:stream").Duplex>();

  constructor(options: ToolBrokerServerOptions) {
    if (options.host.trim().length === 0) throw new TypeError("host must not be empty");
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new TypeError("port must be an integer between 0 and 65535");
    }
    this.#host = options.host;
    this.#port = options.port;
    this.#serviceDigest = digest(validServiceToken(options.serviceToken));
    this.#workspaceServiceDigest =
      options.workspaceServiceToken === undefined
        ? undefined
        : digest(validServiceToken(options.workspaceServiceToken));
    this.#terminalDigest =
      options.terminalToken === undefined
        ? undefined
        : digest(validServiceToken(options.terminalToken));
    this.#broker = options.broker;
    this.#metrics = options.metrics;
    this.#server = Fastify({
      logger: false,
      bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
      requestTimeout: 320_000,
      keepAliveTimeout: 5_000,
    });
    this.#server.register(fastifyWebsocket, {
      options: {
        maxPayload: MAX_WORKSPACE_TERMINAL_FRAME_BYTES * 2,
        perMessageDeflate: false,
      },
    });
    this.#capacityMetrics = setInterval(() => this.#recordCapacityMetrics(), 1_000);
    this.#capacityMetrics.unref();
    this.#installRoutes();
    this.#server.server.on("connect", (request, socket, head) => {
      socket.on("error", () => socket.destroy());
      void (async () => {
        if (request.url !== TOOL_BROKER_SANDBOX_PREVIEW_PATH || !this.#ready) {
          socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
          return;
        }
        if (!this.#terminalAuthorized(request.headers.authorization)) {
          socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          return;
        }
        const raw = request.headers[PREVIEW_SCOPE_HEADER];
        if (typeof raw !== "string" || raw.length > 4096) throw new Error("Invalid preview scope");
        const scope = parseSandboxPreviewConnection(
          JSON.parse(Buffer.from(raw, "base64url").toString()),
        );
        const lifetime = scope.expiresAt - Date.now();
        if (lifetime <= 0 || lifetime > PREVIEW_ACCESS_TTL_MS)
          throw new Error("Expired preview scope");
        const stream = await this.#broker.openPreviewConnection!(scope);
        if (socket.destroyed || scope.expiresAt <= Date.now()) {
          stream.destroy();
          if (!socket.destroyed)
            socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          return;
        }
        this.#previewConnections.add(socket);
        const timer = setTimeout(() => socket.destroy(), Math.max(1, scope.expiresAt - Date.now()));
        timer.unref();
        socket.once("close", () => {
          clearTimeout(timer);
          this.#previewConnections.delete(socket);
          stream.destroy();
        });
        stream.once("error", () => socket.destroy());
        stream.once("close", () => {
          if (stream.readableEnded) socket.end();
          else socket.destroy();
        });
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) stream.write(head);
        socket.pipe(stream);
        stream.pipe(socket);
      })().catch((error: unknown) => {
        if (error instanceof ToolBrokerOwnerRedirectError) {
          socket.end(
            `HTTP/1.1 307 Temporary Redirect\r\nLocation: ${error.ownerBaseUrl}\r\nConnection: close\r\n\r\n`,
          );
        } else socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
    });
  }

  get address(): string | undefined {
    return this.#address;
  }

  async listen(): Promise<string> {
    if (this.#address !== undefined) throw new Error("Tool Broker is already listening");
    await this.#broker.checkHealth();
    this.#recordCapacityMetrics();
    this.#address = await this.#server.listen({ host: this.#host, port: this.#port });
    this.#ready = true;
    return this.#address;
  }

  async close(): Promise<void> {
    this.#ready = false;
    for (const connection of this.#previewConnections) connection.destroy();
    clearInterval(this.#capacityMetrics);
    await this.#broker.close();
    if (this.#address !== undefined) {
      this.#address = undefined;
      await this.#server.close();
    }
  }

  #recordCapacityMetrics(): void {
    const labels = { provider: this.#broker.providerId };
    this.#metrics?.sandboxActive.set(labels, this.#broker.activeCount);
    this.#metrics?.sandboxAdmissionActive.set(labels, this.#broker.admittedCount);
    this.#metrics?.sandboxAdmissionLimit.set(labels, this.#broker.maximumActiveSandboxes);
    this.#metrics?.sandboxAdmissionWaiting.set(labels, this.#broker.admissionWaitingCount);
    this.#metrics?.sandboxPrewarm.set(labels, this.#broker.cleanPrewarmCount);
  }

  #authorized(value: string | undefined): boolean {
    const token = bearer(value);
    const candidate = token === undefined ? Buffer.alloc(32) : digest(token);
    return token !== undefined && timingSafeEqual(this.#serviceDigest, candidate);
  }

  #workspaceServiceAuthorized(value: string | undefined): boolean {
    const token = bearer(value);
    const candidate = token === undefined ? Buffer.alloc(32) : digest(token);
    return (
      token !== undefined &&
      this.#workspaceServiceDigest !== undefined &&
      timingSafeEqual(this.#workspaceServiceDigest, candidate)
    );
  }

  #terminalAuthorized(value: string | undefined): boolean {
    const token = bearer(value);
    const candidate = token === undefined ? Buffer.alloc(32) : digest(token);
    return (
      token !== undefined &&
      this.#terminalDigest !== undefined &&
      timingSafeEqual(this.#terminalDigest, candidate)
    );
  }

  async #failure(reply: FastifyReply, error: unknown): Promise<void> {
    const failure = safeFailure(error);
    if (failure.code === "sandbox_domain_capacity_exhausted") {
      this.#metrics?.sandboxAdmissionRejected.inc({ reason: failure.code });
    }

    reportFailure("operation_failed", failure, error);
    await reply.code(failure.retryable ? 503 : 409).send({
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
    } satisfies InternalServiceError);
  }

  #observed<T>(options: {
    request: FastifyRequest;
    spanName: string;
    operation: string;
    kind: "sandbox" | "tool";
    run: () => Promise<T>;
  }): Promise<T> {
    const parent = parseTraceCarrier({
      traceparent: options.request.headers.traceparent,
      tracestate: options.request.headers.tracestate,
    });
    const startedAt = performance.now();
    return withSpan({
      serviceName: "pi-cloud-tool-broker",
      name: options.spanName,
      ...(parent === undefined ? {} : { parent }),
      attributes: { "pi_cloud.sandbox.operation": options.operation },
      run: async () => {
        try {
          const result = await options.run();
          const duration = (performance.now() - startedAt) / 1_000;
          if (options.kind === "sandbox") {
            this.#metrics?.sandboxDuration.observe(
              { operation: options.operation, outcome: "completed" },
              duration,
            );
          } else {
            this.#metrics?.toolDuration.observe(
              { tool: options.operation, outcome: "completed" },
              duration,
            );
          }
          return result;
        } catch (error: unknown) {
          const duration = (performance.now() - startedAt) / 1_000;
          if (options.kind === "sandbox") {
            this.#metrics?.sandboxDuration.observe(
              { operation: options.operation, outcome: "failed" },
              duration,
            );
          } else {
            this.#metrics?.toolDuration.observe(
              { tool: options.operation, outcome: "failed" },
              duration,
            );
          }
          throw error;
        }
      },
    });
  }

  #installRoutes(): void {
    this.#server.get(TOOL_BROKER_LIVE_PATH, async (_request, reply) => {
      await reply.code(200).send({ status: "ok" });
    });
    this.#server.get(TOOL_BROKER_READY_PATH, async (_request, reply) => {
      let healthy = this.#ready;
      if (healthy) {
        try {
          await this.#broker.checkHealth();
        } catch {
          healthy = false;
        }
      }
      this.#metrics?.sandboxPrewarm.set(
        { provider: this.#broker.providerId },
        this.#broker.cleanPrewarmCount,
      );
      await reply.code(healthy ? 200 : 503).send({
        status: healthy ? "ready" : "not_ready",
      });
    });

    if (this.#terminalDigest !== undefined && this.#broker.openTerminal !== undefined) {
      this.#server.register(async (scope) => {
        scope.addHook("preValidation", async (request, reply) => {
          if (!this.#terminalAuthorized(request.headers.authorization)) {
            await reply.code(401).send();
          }
        });
        scope.get(TOOL_BROKER_TERMINAL_PATH, { websocket: true }, (socket) => {
          this.#acceptTerminalSocket(socket);
        });
      });
    }

    if (
      this.#terminalDigest !== undefined &&
      this.#broker.provisionDevelopmentEnvironment !== undefined &&
      this.#broker.developmentEnvironmentLifecycle !== undefined &&
      this.#broker.browseDevelopmentEnvironment !== undefined &&
      this.#broker.openDevelopmentEnvironmentTerminal !== undefined
    ) {
      this.#server.register(async (scope) => {
        scope.addHook("preValidation", async (request, reply) => {
          if (!this.#terminalAuthorized(request.headers.authorization)) {
            await reply.code(401).send();
          }
        });
        scope.post(TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_PATH, async (request, reply) => {
          try {
            const message = parseDevelopmentEnvironmentBrokerRequest(request.body);
            await reply
              .code(200)
              .send(
                message.type === "development_environment.provision"
                  ? await this.#broker.provisionDevelopmentEnvironment!(message)
                  : message.type === "development_environment.lifecycle"
                    ? await this.#broker.developmentEnvironmentLifecycle!(message)
                    : await this.#broker.browseDevelopmentEnvironment!(message),
              );
          } catch (error: unknown) {
            if (error instanceof ToolBrokerOwnerRedirectError) {
              const message = parseDevelopmentEnvironmentBrokerRequest(request.body);
              await reply.code(200).send({
                developmentEnvironmentProtocolVersion: 1,
                type: "development_environment.owner_redirect",
                requestId: message.requestId,
                ownerBaseUrl: error.ownerBaseUrl,
              });
              return;
            }
            await this.#failure(reply, error);
          }
        });
        scope.get(
          TOOL_BROKER_DEVELOPMENT_ENVIRONMENT_TERMINAL_PATH,
          { websocket: true },
          (socket) => this.#acceptTerminalSocket(socket, true),
        );
      });
    }

    this.#server.post(TOOL_BROKER_SERVICE_PATH, async (request, reply) => {
      if (!this.#authorized(request.headers.authorization)) {
        await reply.code(401).send({
          error: {
            code: "invalid_tool_broker_credential",
            message: "Tool Broker request is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        const message = parseToolBrokerRequest(request.body);
        if (message.type === "tool_sandbox.create") {
          let reserved;
          try {
            reserved = await this.#observed({
              request,
              spanName: "sandbox.reserve",
              operation: "reserve",
              kind: "sandbox",
              run: () => this.#broker.create(message),
            });
          } catch (error: unknown) {
            if (!(error instanceof ToolBrokerOwnerRedirectError)) throw error;
            await reply.code(200).send({
              toolBrokerProtocolVersion: 1,
              type: "tool_sandbox.owner_redirect",
              requestId: message.requestId,
              ownerBaseUrl: error.ownerBaseUrl,
            });
            return;
          }
          this.#metrics?.sandboxActive.set(
            { provider: this.#broker.providerId },
            this.#broker.activeCount,
          );
          this.#metrics?.sandboxPrewarm.set(
            { provider: this.#broker.providerId },
            this.#broker.cleanPrewarmCount,
          );
          await reply.code(200).send(reserved);
          return;
        }
        if (message.type === "tool_sandbox.refresh_services") {
          await this.#broker.refreshServices(message.activationId, message.assignment);
          await reply.code(200).send({
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.services_refreshed",
            requestId: message.requestId,
            activationId: message.activationId,
          });
          return;
        }
        if (message.type === "tool_sandbox.capture") {
          await reply.code(200).send(
            await this.#observed({
              request,
              spanName: "sandbox.capture",
              operation: "capture",
              kind: "sandbox",
              run: () =>
                this.#broker.capture(message.activationId, message.assignment, message.requestId),
            }),
          );
          return;
        }
        if (message.type === "tool_sandbox.release") {
          const released = await this.#observed({
            request,
            spanName: "sandbox.release",
            operation: "release",
            kind: "sandbox",
            run: () => this.#broker.release(message),
          });
          this.#metrics?.sandboxActive.set(
            { provider: this.#broker.providerId },
            this.#broker.activeCount,
          );
          this.#metrics?.sandboxPrewarm.set(
            { provider: this.#broker.providerId },
            this.#broker.cleanPrewarmCount,
          );
          await reply.code(200).send(released);
          return;
        }
        if (message.type === "tool_sandbox.stop") {
          await this.#observed({
            request,
            spanName: "sandbox.stop",
            operation: "stop",
            kind: "sandbox",
            run: () => this.#broker.stop(message.activationId, message.assignment),
          });
          this.#metrics?.sandboxActive.set(
            { provider: this.#broker.providerId },
            this.#broker.activeCount,
          );
          this.#metrics?.sandboxPrewarm.set(
            { provider: this.#broker.providerId },
            this.#broker.cleanPrewarmCount,
          );
          await reply.code(200).send({
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.stopped",
            requestId: message.requestId,
            activationId: message.activationId,
          });
          return;
        }
        if (message.type === "workspace.fork") {
          await reply.code(200).send(
            await this.#observed({
              request,
              spanName: "workspace.fork",
              operation: "workspace_fork",
              kind: "sandbox",
              run: () => this.#broker.forkWorkspace(message),
            }),
          );
          return;
        }
        message satisfies never;
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });

    this.#server.post(TOOL_BROKER_WORKSPACE_BROWSER_PATH, async (request, reply) => {
      if (!this.#workspaceServiceAuthorized(request.headers.authorization)) {
        await reply.code(401).send({
          error: {
            code: "invalid_workspace_browser_credential",
            message: "Workspace browser request is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        const list =
          typeof request.body === "object" &&
          request.body !== null &&
          "type" in request.body &&
          request.body.type === "workspace.list_directory";
        const message = list
          ? parseToolBrokerListWorkspaceDirectoryRequest(request.body)
          : parseToolBrokerReadWorkspaceFileRequest(request.body);
        if (message.type === "workspace.list_directory") {
          await reply.code(200).send(
            await this.#observed({
              request,
              spanName: "workspace.list_directory",
              operation: "list_directory",
              kind: "sandbox",
              run: () => this.#broker.listWorkspaceDirectory(message),
            }),
          );
          return;
        }
        await reply.code(200).send(
          await this.#observed({
            request,
            spanName: "workspace.read_file",
            operation: "read_file",
            kind: "sandbox",
            run: () => this.#broker.readWorkspaceFile(message),
          }),
        );
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });

    this.#server.post(TOOL_BROKER_SOURCE_CONTROL_PATH, async (request, reply) => {
      if (!this.#workspaceServiceAuthorized(request.headers.authorization)) {
        await reply.code(401).send({
          error: {
            code: "invalid_source_control_credential",
            message: "Source-control Workspace request is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        if (
          typeof request.body === "object" &&
          request.body !== null &&
          "type" in request.body &&
          (request.body.type === "source_control.workspace_credential_authorize" ||
            request.body.type === "source_control.workspace_credential_preflight" ||
            request.body.type === "source_control.workspace_credential_list" ||
            request.body.type === "source_control.workspace_credential_disconnect")
        ) {
          const message = parseSourceControlWorkspaceCredentialRequest(request.body);
          await reply.code(200).send(
            await this.#observed({
              request,
              spanName: "source_control.credential",
              operation: message.type.replace("source_control.workspace_", "source_"),
              kind: "sandbox",
              run: async () => {
                if (message.type === "source_control.workspace_credential_authorize") {
                  const authorize = this.#broker.authorizeSourceCredential;
                  if (authorize === undefined) {
                    throw new ToolBrokerError(
                      "source_control_credential_unavailable",
                      "Source-control credential authorization is unavailable",
                      false,
                    );
                  }
                  return authorize.call(this.#broker, message);
                }
                if (message.type === "source_control.workspace_credential_preflight") {
                  const preflight = this.#broker.preflightSourceCredential;
                  if (preflight === undefined) {
                    throw new ToolBrokerError(
                      "source_control_credential_unavailable",
                      "Source-control credential preflight is unavailable",
                      false,
                    );
                  }
                  return preflight.call(this.#broker, message);
                }
                if (message.type === "source_control.workspace_credential_list") {
                  const list = this.#broker.listSourceCredentials;
                  if (list === undefined) {
                    throw new ToolBrokerError(
                      "source_control_credential_unavailable",
                      "Source-control credential listing is unavailable",
                      false,
                    );
                  }
                  return list.call(this.#broker, message);
                }
                const disconnect = this.#broker.disconnectSourceCredential;
                if (disconnect === undefined) {
                  throw new ToolBrokerError(
                    "source_control_credential_unavailable",
                    "Source-control credential disconnection is unavailable",
                    false,
                  );
                }
                return disconnect.call(this.#broker, message);
              },
            }),
          );
          return;
        }
        throw new ToolBrokerError(
          "source_control_request_invalid",
          "Source-control Workspace request is invalid",
          false,
        );
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });

    this.#server.post(TOOL_BROKER_OPERATION_PATH, async (request, reply) => {
      const executionLease = bearer(request.headers.authorization);
      if (
        executionLease === undefined ||
        !/^pcel1_[0-9a-f]{32}_[0-9a-f]{32}_[1-9][0-9]{0,15}$/.test(executionLease)
      ) {
        await reply.code(401).send({
          error: {
            code: "invalid_execution_lease",
            message: "Tool Sandbox operation is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        const message = parseToolSandboxOperationRequest(request.body);
        const response = await this.#observed({
          request,
          spanName: `tool.${message.operation}`,
          operation: message.operation,
          kind: "tool",
          // Tool execution is owned by operationId and the Run lease, not by
          // this particular HTTP connection. Explicit stop/cancel revokes it.
          run: () => this.#broker.execute(executionLease, message),
        });
        this.#metrics?.sandboxActive.set(
          { provider: this.#broker.providerId },
          this.#broker.activeCount,
        );
        this.#metrics?.sandboxPrewarm.set(
          { provider: this.#broker.providerId },
          this.#broker.cleanPrewarmCount,
        );
        await reply.code(200).send(response);
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });

    this.#server.post(TOOL_BROKER_INVENTORY_PATH, async (request, reply) => {
      if (!this.#authorized(request.headers.authorization)) {
        await reply.code(401).send({
          error: {
            code: "invalid_tool_broker_credential",
            message: "Sandbox inventory request is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        const message = parseSupervisorManagementRequest(request.body);
        let response: SupervisorManagementResponse;
        if (message.type === "assignments.list") {
          response = {
            protocolVersion: 1,
            type: "assignments.listed",
            requestId: message.requestId,
            sandboxId: message.sandboxId,
            assignments: [...(await this.#broker.listAssignments(message.sandboxId))],
          };
        } else if (message.type === "assignment.terminate_and_confirm") {
          await this.#broker.terminateAndConfirmAbsent(message.assignment);
          response = {
            protocolVersion: 1,
            type: "assignment.absent",
            requestId: message.requestId,
            sandboxId: message.sandboxId,
            containerId: message.assignment.containerId,
          };
        } else if (message.type === "assignment.confirm_absent") {
          await this.#broker.confirmAbsent(message.assignment);
          response = {
            protocolVersion: 1,
            type: "assignment.absent",
            requestId: message.requestId,
            sandboxId: message.sandboxId,
            containerId: message.assignment.containerId,
          };
        } else {
          throw new ToolBrokerError(
            "unsupported_tool_broker_operation",
            "Tool Broker does not own the Runner process",
            false,
          );
        }
        await reply.code(200).send(response);
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });
  }

  #acceptTerminalSocket(socket: WebSocket, developmentEnvironment = false): void {
    let connection: Awaited<ReturnType<NonNullable<ToolBrokerBackend["openTerminal"]>>> | undefined;
    let closed = false;
    let initialized = false;
    let processing = Promise.resolve();
    const send = async (frame: unknown): Promise<void> => {
      if (closed || socket.readyState !== socket.OPEN) return;
      const payload = JSON.stringify(frame);
      const bytes = Buffer.byteLength(payload, "utf8");
      if (
        bytes > DEFAULT_TERMINAL_SEND_BUFFER_BYTES ||
        socket.bufferedAmount + bytes > DEFAULT_TERMINAL_SEND_BUFFER_BYTES
      ) {
        socket.close(4_002, "terminal send buffer overloaded");
        return;
      }
      await new Promise<void>((resolvePromise, rejectPromise) => {
        socket.send(payload, (error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    };
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await connection?.close();
      } catch (error: unknown) {
        reportFailure("workspace_terminal_close_failed", safeFailure(error), error);
      }
      if (socket.readyState === socket.OPEN) socket.close(1_000, "terminal closed");
      else if (socket.readyState !== socket.CLOSED) socket.terminate();
    };
    const fail = async (error: unknown): Promise<void> => {
      if (error instanceof ToolBrokerOwnerRedirectError) {
        await send({
          workspaceTerminalProtocolVersion: 1,
          type: "workspace_terminal.owner_redirect",
          ownerBaseUrl: error.ownerBaseUrl,
        });
      } else {
        const failure = safeFailure(error);
        reportFailure("workspace_terminal_failed", failure, error);
        await send({
          workspaceTerminalProtocolVersion: 1,
          type: "workspace_terminal.error",
          code: failure.code,
          message: failure.message,
          retryable: failure.retryable,
        });
      }
      await close();
    };
    socket.on("message", (data: RawData) => {
      processing = processing
        .then(async () => {
          const raw =
            data instanceof ArrayBuffer
              ? Buffer.from(data).toString("utf8")
              : Array.isArray(data)
                ? Buffer.concat(data).toString("utf8")
                : data.toString("utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (!initialized) {
            initialized = true;
            let opened: Awaited<ReturnType<NonNullable<ToolBrokerBackend["openTerminal"]>>>;
            if (developmentEnvironment) {
              const open = parseDevelopmentEnvironmentTerminalOpenRequest(parsed);
              const openTerminal = this.#broker.openDevelopmentEnvironmentTerminal;
              if (openTerminal === undefined) {
                throw new ToolBrokerError(
                  "development_environment_terminal_unsupported",
                  "Development environment terminal is unavailable",
                  false,
                );
              }
              opened = await openTerminal.call(this.#broker, open);
            } else {
              const open = parseWorkspaceTerminalOpenRequest(parsed);
              const openTerminal = this.#broker.openTerminal;
              if (openTerminal === undefined) {
                throw new ToolBrokerError(
                  "workspace_terminal_unsupported",
                  "Workspace terminal is unavailable",
                  false,
                );
              }
              opened = await openTerminal.call(this.#broker, {
                tenantId: open.tenantId,
                userId: open.userId,
                projectId: open.projectId,
                workspaceId: open.workspaceId,
                sessionId: open.sessionId,
                environment: open.environment,
                workspaceSeed: open.workspaceSeed,
                size: { rows: open.rows, cols: open.cols },
              });
            }
            if (closed) {
              await opened.close().catch(() => undefined);
              return;
            }
            connection = opened;
            await send({
              workspaceTerminalProtocolVersion: 1,
              type: "workspace_terminal.ready",
              terminalId: connection.terminalId,
              pid: connection.pid,
              workspaceRoot: connection.workspaceRoot,
            });
            void (async () => {
              try {
                for await (const chunk of connection!.output) {
                  for (let offset = 0; offset < chunk.byteLength; offset += 48 * 1_024) {
                    await send({
                      workspaceTerminalProtocolVersion: 1,
                      type: "workspace_terminal.output",
                      data: Buffer.from(chunk.subarray(offset, offset + 48 * 1_024)).toString(
                        "base64",
                      ),
                    });
                  }
                }
                await send({
                  workspaceTerminalProtocolVersion: 1,
                  type: "workspace_terminal.exit",
                });
                await close();
              } catch (error: unknown) {
                await fail(error);
              }
            })();
            return;
          }
          if (connection === undefined) {
            throw new ToolBrokerError(
              "workspace_terminal_not_ready",
              "Workspace terminal is still starting",
              true,
            );
          }
          const frame = parseWorkspaceTerminalClientFrame(parsed);
          if (frame.type === "workspace_terminal.input") {
            await connection.sendInput(Buffer.from(frame.data, "base64"));
          } else if (frame.type === "workspace_terminal.resize") {
            await connection.resize({ rows: frame.rows, cols: frame.cols });
          } else if (frame.type === "workspace_terminal.close") {
            await close();
          } else {
            await send({ workspaceTerminalProtocolVersion: 1, type: "workspace_terminal.pong" });
          }
        })
        .catch((error: unknown) => fail(error));
    });
    socket.once("close", () => void close());
    socket.once("error", () => void close());
  }
}
