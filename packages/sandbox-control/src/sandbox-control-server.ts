import { Readable } from "node:stream";
import {
  SANDBOX_CONTROL_DEVELOPMENT_ENVIRONMENT_PATH,
  SANDBOX_CONTROL_DEVELOPMENT_ENVIRONMENT_TERMINAL_PATH,
  MAX_WORKSPACE_TERMINAL_FRAME_BYTES,
  SANDBOX_CONTROL_TERMINAL_PATH,
  parseWorkspaceTerminalClientFrame,
  parseWorkspaceTerminalOpenRequest,
  parseDevelopmentEnvironmentBrokerRequest,
  parseDevelopmentEnvironmentTerminalOpenRequest,
  parseSandboxControlRequest,
  parseSandboxControlListWorkspaceDirectoryRequest,
  parseSandboxControlReadWorkspaceFileRequest,
  parseSupervisorManagementRequest,
  parseSourceControlWorkspaceCredentialRequest,
  SANDBOX_CONTROL_SANDBOX_PREVIEW_PATH,
  PREVIEW_SCOPE_HEADER,
  PREVIEW_FAILURE_HEADER,
  PREVIEW_ACCESS_TTL_MS,
  parseSandboxPreviewConnection,
  type InternalServiceError,
  type SupervisorManagementResponse,
  RUNTIME_EXECUTION_EVIDENCE_PATH,
} from "@pi-cloud/protocol";
import fastifyWebsocket from "@fastify/websocket";
import { parseTraceCarrier, withSpan, type PiCloudMetrics } from "@pi-cloud/observability";
import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import { TOOL_WORKFLOW_PATH } from "./workflow-channels.ts";
import {
  SANDBOX_CONTROL_INVENTORY_PATH,
  SANDBOX_CONTROL_LIVE_PATH,
  SANDBOX_CONTROL_WORKSPACE_BROWSER_PATH,
  SANDBOX_CONTROL_READY_PATH,
  SANDBOX_CONTROL_SERVICE_PATH,
  SANDBOX_CONTROL_SOURCE_CONTROL_PATH,
} from "./sandbox-control-client.ts";
import { SandboxControlError } from "./sandbox-provider.ts";
import { WorkspaceVolumeGatewayError } from "./workspace-volume-gateway-contract.ts";
import { parseUploadIdentity, parseWorkspaceUploadRequest } from "@pi-cloud/protocol";
import { SANDBOX_CONTROL_WORKSPACE_UPLOAD_PATH } from "./sandbox-control-client.ts";
import { SandboxOwnerRedirectError, type SandboxController } from "./sandbox-controller.ts";
import { WORKFLOW_LOG_DELIVERY_PATH, type ToolLogDelivery } from "./tool-command-dispatcher.ts";

const DEFAULT_BODY_LIMIT = 5 * 1_024 * 1_024;
const DEFAULT_TERMINAL_SEND_BUFFER_BYTES = 1 * 1_024 * 1_024;
const MAXIMUM_TERMINAL_PENDING_INPUT_BYTES = 1 * 1_024 * 1_024;
const MAXIMUM_TERMINAL_PENDING_INPUT_FRAMES = 128;
export { SANDBOX_CONTROL_TERMINAL_PATH };

export type SandboxControlServerOptions = {
  host: string;
  port: number;
  serviceToken: string;
  workspaceServiceToken?: string;
  terminalToken?: string;
  broker: SandboxControlBackend;
  logDelivery?: {
    instanceId: string;
    token: string;
    receive(delivery: ToolLogDelivery): void | Promise<void>;
    checkHealth(): void;
  };
  bodyLimit?: number;
  metrics?: PiCloudMetrics;
};

export type SandboxControlBackend = Pick<
  SandboxController,
  | "checkHealth"
  | "create"
  | "refreshServices"
  | "release"
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
      SandboxController,
      | "attachWorkflow"
      | "openTerminal"
      | "provisionDevelopmentEnvironment"
      | "developmentEnvironmentLifecycle"
      | "observeDevelopmentEnvironment"
      | "browseDevelopmentEnvironment"
      | "openDevelopmentEnvironmentTerminal"
      | "openPreviewConnection"
      | "authorizeSourceCredential"
      | "preflightSourceCredential"
      | "listSourceCredentials"
      | "disconnectSourceCredential"
      | "uploadWorkspaceFile"
      | "prepareWorkspaceUpload"
      | "prepareInputImages"
      | "recordRuntimeEvidence"
    >
  >;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function validServiceToken(value: string): string {
  if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(value)) {
    throw new TypeError("Sandbox control service token is invalid");
  }
  return value;
}

function bearer(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 4_103) return undefined;
  return /^Bearer ([A-Za-z0-9._~+/=-]{32,4096})$/.exec(value)?.[1];
}

function safeFailure(error: unknown): SandboxControlError {
  if (error instanceof SandboxControlError) return error;
  if (error instanceof WorkspaceVolumeGatewayError)
    return new SandboxControlError(error.code, error.message, error.retryable);
  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    typeof error.name === "string" &&
    /ProtocolError$/.test(error.name)
  ) {
    return new SandboxControlError(
      "tool_broker_protocol_error",
      "Sandbox control request failed validation",
      false,
    );
  }
  return new SandboxControlError("tool_broker_failed", "Sandbox control operation failed", true);
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
      const normalized = text
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/Bearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
        .replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)[^\s,;"']+/gi, "$1[redacted]")
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
        .trim();
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

function reportFailure(event: string, failure: SandboxControlError, error: unknown): void {
  process.stderr.write(
    `${JSON.stringify({
      level: "error",
      service: "pi-cloud-sandbox-control",
      event,
      publicCode: failure.code,
      retryable: failure.retryable,
      diagnostic: safeDiagnostic(error),
    })}\n`,
  );
}

export class SandboxControlServer {
  readonly #host: string;
  readonly #port: number;
  readonly #serviceDigest: Buffer;
  readonly #workspaceServiceDigest: Buffer | undefined;
  readonly #terminalDigest: Buffer | undefined;
  readonly #broker: SandboxControlBackend;
  readonly #logDelivery: SandboxControlServerOptions["logDelivery"];
  readonly #deliveryDigest: Buffer | undefined;
  readonly #server: FastifyInstance;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #capacityMetrics: NodeJS.Timeout;
  #address: string | undefined;
  #ready = false;
  readonly #previewConnections = new Set<import("node:stream").Duplex>();
  readonly #previewOpens = new Set<Promise<void>>();

  constructor(options: SandboxControlServerOptions) {
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
    this.#logDelivery = options.logDelivery;
    this.#deliveryDigest =
      options.logDelivery && digest(validServiceToken(options.logDelivery.token));
    this.#metrics = options.metrics;
    this.#server = Fastify({
      logger: false,
      bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
      requestTimeout: 0,
      keepAliveTimeout: 5_000,
    });
    // Let @fastify/websocket's onRequest mark upgrades before rejecting them.
    // Its onResponse then owns closing a refused upgrade's detached socket.
    this.#server.addHook("preValidation", async (request, reply) => {
      if (!this.#ready && request.url !== SANDBOX_CONTROL_LIVE_PATH)
        await reply.code(503).send({ error: "sandbox_control_unavailable" });
    });
    this.#server.register(fastifyWebsocket, {
      options: {
        maxPayload: Math.max(MAX_WORKSPACE_TERMINAL_FRAME_BYTES * 2, 5 * 1024 * 1024),
        perMessageDeflate: false,
      },
    });
    this.#capacityMetrics = setInterval(() => this.#recordCapacityMetrics(), 1_000);
    this.#capacityMetrics.unref();
    this.#installRoutes();
    this.#server.server.on("connect", (request, socket, head) => {
      socket.on("error", () => socket.destroy());
      const connectionAbort = new AbortController();
      let stream: import("node:stream").Duplex | undefined;
      let timer: NodeJS.Timeout | undefined;
      this.#previewConnections.add(socket);
      socket.once("close", () => {
        connectionAbort.abort(new Error("Preview caller disconnected"));
        clearTimeout(timer);
        this.#previewConnections.delete(socket);
        stream?.destroy();
      });
      let scopeAccepted = false;
      const opening = Promise.resolve()
        .then(async () => {
          if (request.url !== SANDBOX_CONTROL_SANDBOX_PREVIEW_PATH || !this.#ready) {
            socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
            return;
          }
          if (!this.#terminalAuthorized(request.headers.authorization)) {
            socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            return;
          }
          const raw = request.headers[PREVIEW_SCOPE_HEADER];
          if (typeof raw !== "string" || raw.length > 4096)
            throw new Error("Invalid preview scope");
          const scope = parseSandboxPreviewConnection(
            JSON.parse(Buffer.from(raw, "base64url").toString()),
          );
          const lifetime = scope.expiresAt - Date.now();
          if (lifetime <= 0 || lifetime > PREVIEW_ACCESS_TTL_MS)
            throw new Error("Expired preview scope");
          scopeAccepted = true;
          timer = setTimeout(() => socket.destroy(), Math.max(1, lifetime));
          timer.unref();
          stream = await this.#broker.openPreviewConnection!(scope, connectionAbort.signal);
          if (!this.#ready || socket.destroyed || scope.expiresAt <= Date.now()) {
            stream.destroy();
            if (!socket.destroyed)
              socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            return;
          }
          stream.once("error", () => socket.destroy());
          stream.once("close", () => {
            if (stream!.readableEnded) socket.end();
            else socket.destroy();
          });
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) stream.write(head);
          socket.pipe(stream);
          stream.pipe(socket);
        })
        .catch((error: unknown) => {
          if (!this.#ready || socket.destroyed) return;
          if (error instanceof SandboxOwnerRedirectError) {
            socket.end(
              `HTTP/1.1 307 Temporary Redirect\r\nLocation: ${error.ownerBaseUrl}\r\nConnection: close\r\n\r\n`,
            );
          } else if (!scopeAccepted) {
            socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          } else {
            const applicationUnavailable =
              error instanceof SandboxControlError &&
              error.code === "sandbox_application_unavailable";
            const code = applicationUnavailable
              ? "sandbox_application_unavailable"
              : "sandbox_execution_unavailable";
            reportFailure("preview_connection_failed", safeFailure(error), error);
            socket.end(
              `HTTP/1.1 ${applicationUnavailable ? "502 Bad Gateway" : "503 Service Unavailable"}\r\n${PREVIEW_FAILURE_HEADER}: ${code}\r\nConnection: close\r\n\r\n`,
            );
          }
        })
        .finally(() => this.#previewOpens.delete(opening));
      this.#previewOpens.add(opening);
    });
  }

  get address(): string | undefined {
    return this.#address;
  }

  async listen(): Promise<string> {
    if (this.#address !== undefined) throw new Error("Sandbox control is already listening");
    await this.#broker.checkHealth();
    // Publication recovery needs reachable control listeners. Its readiness
    // belongs to /health/ready, not the act of binding this listener.
    this.#recordCapacityMetrics();
    this.#address = await this.#server.listen({ host: this.#host, port: this.#port });
    this.#ready = true;
    return this.#address;
  }

  async close(): Promise<void> {
    this.#ready = false;
    for (const connection of this.#previewConnections) connection.destroy();
    clearInterval(this.#capacityMetrics);
    const errors: unknown[] = [];
    try {
      await this.#broker.close();
    } catch (error) {
      errors.push(error);
    }
    await Promise.allSettled([...this.#previewOpens]);
    this.#address = undefined;
    try {
      await this.#server.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1)
      throw new AggregateError(errors, "Sandbox control and HTTP shutdown failed", {
        cause: errors[0],
      });
  }

  #recordCapacityMetrics(): void {
    const labels = { provider: this.#broker.providerId };
    this.#metrics?.sandboxActive.set(labels, this.#broker.activeCount);
    this.#metrics?.sandboxAdmissionActive.set(labels, this.#broker.admittedCount);
    this.#metrics?.sandboxAdmissionLimit.set(
      labels,
      this.#broker.maximumActiveSandboxes ?? Infinity,
    );
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
    run: () => Promise<T>;
  }): Promise<T> {
    const parent = parseTraceCarrier({
      traceparent: options.request.headers.traceparent,
      tracestate: options.request.headers.tracestate,
    });
    const startedAt = performance.now();
    return withSpan({
      serviceName: "pi-cloud-sandbox-control",
      name: options.spanName,
      ...(parent === undefined ? {} : { parent }),
      attributes: { "pi_cloud.sandbox.operation": options.operation },
      run: async () => {
        try {
          const result = await options.run();
          const duration = (performance.now() - startedAt) / 1_000;
          this.#metrics?.sandboxDuration.observe(
            { operation: options.operation, outcome: "completed" },
            duration,
          );
          return result;
        } catch (error: unknown) {
          const duration = (performance.now() - startedAt) / 1_000;
          this.#metrics?.sandboxDuration.observe(
            { operation: options.operation, outcome: "failed" },
            duration,
          );
          throw error;
        }
      },
    });
  }

  #installRoutes(): void {
    // Register after the websocket plugin has installed its route hook.
    this.#server.register(async (scope) => {
      scope.get(TOOL_WORKFLOW_PATH, { websocket: true }, (socket, request) => {
        const query = request.query as { activationId?: string; operationId?: string };
        const lease = bearer(request.headers.authorization);
        if (!lease || !query.activationId || !query.operationId || !this.#broker.attachWorkflow) {
          socket.close(1008, "Invalid workflow attachment");
          return;
        }
        const controller = new AbortController();
        let attached:
          Awaited<ReturnType<NonNullable<SandboxControlBackend["attachWorkflow"]>>> | undefined;
        const send = (frame: unknown) => {
          if (socket.readyState !== 1) return;
          if (socket.bufferedAmount > DEFAULT_TERMINAL_SEND_BUFFER_BYTES) {
            socket.close(1013, "Workflow reader is too slow");
            return;
          }
          socket.send(JSON.stringify(frame));
        };
        const fail = (error: unknown) => {
          send({
            type: "error",
            message: error instanceof Error ? error.message : "Workflow channel failed",
          });
          socket.close(1011);
          controller.abort();
        };
        socket.on("close", () => {
          controller.abort();
          attached?.close();
        });
        socket.on("error", () => {
          controller.abort();
          attached?.close();
        });
        socket.on("message", (data: RawData) => {
          try {
            if (!attached) throw new Error("Workflow is not attached");
            attached.respond(JSON.parse(data.toString()));
          } catch (error) {
            fail(error);
          }
        });
        void this.#broker
          .attachWorkflow(query.activationId, query.operationId, lease, send, controller.signal)
          .then((channel) => {
            attached = channel;
            if (controller.signal.aborted) channel.close();
          })
          .catch((error) => {
            if (!controller.signal.aborted) fail(error);
          });
      });
    });
    this.#server.post(
      RUNTIME_EXECUTION_EVIDENCE_PATH,
      { bodyLimit: 1024 },
      async (request, reply) => {
        const credential = bearer(request.headers.authorization);
        if (
          !this.#deliveryDigest ||
          !credential ||
          !timingSafeEqual(digest(credential), this.#deliveryDigest)
        )
          return reply.code(401).send();
        const value = request.body as
          { tenantId?: unknown; targetId?: unknown; observedAt?: unknown } | undefined;
        if (
          !value ||
          typeof value.tenantId !== "string" ||
          !value.tenantId.length ||
          value.tenantId.length > 128 ||
          typeof value.targetId !== "string" ||
          !/^[0-9a-f]{64}$/.test(value.targetId) ||
          typeof value.observedAt !== "number" ||
          !Number.isSafeInteger(value.observedAt) ||
          value.observedAt < 0 ||
          Object.keys(value).length !== 3
        )
          return reply.code(400).send();
        this.#broker.recordRuntimeEvidence?.(value.tenantId, value.targetId, value.observedAt);
        return reply.code(204).send();
      },
    );
    this.#server.post(WORKFLOW_LOG_DELIVERY_PATH, async (request, reply) => {
      const credential = bearer(request.headers.authorization);
      if (
        !this.#logDelivery ||
        !this.#deliveryDigest ||
        !credential ||
        !timingSafeEqual(digest(credential), this.#deliveryDigest)
      ) {
        await reply.code(401).send();
        return;
      }
      const delivery = request.body as ToolLogDelivery;
      if (delivery.instanceId !== this.#logDelivery.instanceId) {
        await reply.code(410).send();
        return;
      }
      try {
        // Commands acknowledge local admission; closure joins the active
        // workflow channel before confirming that its scope is closed.
        await this.#logDelivery.receive(delivery);
        await reply.code(204).send();
      } catch (error) {
        await this.#failure(reply, error);
      }
    });
    this.#server.get(SANDBOX_CONTROL_LIVE_PATH, async (_request, reply) => {
      await reply.code(200).send({ status: "ok" });
    });
    this.#server.get(SANDBOX_CONTROL_READY_PATH, async (_request, reply) => {
      let healthy = this.#ready;
      if (healthy) {
        try {
          await this.#broker.checkHealth();
          this.#logDelivery?.checkHealth();
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
        scope.get(SANDBOX_CONTROL_TERMINAL_PATH, { websocket: true }, (socket) => {
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
        scope.post(SANDBOX_CONTROL_DEVELOPMENT_ENVIRONMENT_PATH, async (request, reply) => {
          try {
            const message = parseDevelopmentEnvironmentBrokerRequest(request.body);
            await reply
              .code(200)
              .send(
                message.type === "development_environment.provision"
                  ? await this.#broker.provisionDevelopmentEnvironment!(message)
                  : message.type === "development_environment.lifecycle"
                    ? await this.#broker.developmentEnvironmentLifecycle!(message)
                    : message.type === "development_environment.observe"
                      ? await this.#broker.observeDevelopmentEnvironment!(message)
                      : await this.#broker.browseDevelopmentEnvironment!(message),
              );
          } catch (error: unknown) {
            if (error instanceof SandboxOwnerRedirectError) {
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
          SANDBOX_CONTROL_DEVELOPMENT_ENVIRONMENT_TERMINAL_PATH,
          { websocket: true },
          (socket) => this.#acceptTerminalSocket(socket, true),
        );
      });
    }

    this.#server.post(SANDBOX_CONTROL_SERVICE_PATH, async (request, reply) => {
      if (!this.#authorized(request.headers.authorization)) {
        await reply.code(401).send({
          error: {
            code: "invalid_tool_broker_credential",
            message: "Sandbox control request is not authorized",
            retryable: false,
          },
        } satisfies InternalServiceError);
        return;
      }
      try {
        const message = parseSandboxControlRequest(request.body);
        if (message.type === "tool_sandbox.create") {
          const cancellation = new AbortController();
          const disconnected = () => {
            if (!reply.raw.writableFinished)
              cancellation.abort(new Error("Binding request disconnected"));
          };
          reply.raw.once("close", disconnected);
          let reserved;
          try {
            reserved = await this.#observed({
              request,
              spanName: "sandbox.reserve",
              operation: "reserve",
              run: () => this.#broker.create(message, cancellation.signal),
            });
          } catch (error: unknown) {
            if (!(error instanceof SandboxOwnerRedirectError)) throw error;
            await reply.code(200).send({
              toolBrokerProtocolVersion: 1,
              type: "tool_sandbox.owner_redirect",
              requestId: message.requestId,
              ownerBaseUrl: error.ownerBaseUrl,
            });
            return;
          } finally {
            reply.raw.removeListener("close", disconnected);
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
        if (message.type === "tool_sandbox.prepare_input_images") {
          if (!this.#broker.prepareInputImages)
            throw new SandboxControlError(
              "input_images_unavailable",
              "Input image preparation is unavailable",
              false,
            );
          const abort = new AbortController();
          const closed = () => {
            if (!reply.raw.writableEnded)
              abort.abort(new Error("Input preparation caller disconnected"));
          };
          reply.raw.on("close", closed);
          try {
            await reply
              .code(200)
              .send(await this.#broker.prepareInputImages(message, abort.signal));
          } finally {
            reply.raw.removeListener("close", closed);
          }
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
        if (message.type === "tool_sandbox.release") {
          const released = await this.#observed({
            request,
            spanName: "sandbox.release",
            operation: "release",
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
        message satisfies never;
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });

    this.#server.addContentTypeParser("application/octet-stream", (_request, body, done) =>
      done(null, body),
    );
    this.#server.addHook("onRequest", async (request, reply) => {
      if (
        request.url.split("?", 1)[0] === SANDBOX_CONTROL_WORKSPACE_UPLOAD_PATH &&
        !this.#workspaceServiceAuthorized(request.headers.authorization)
      )
        return reply.code(401).send({ error: { code: "unauthorized", retryable: false } });
    });
    // Resolve ownership before streaming. A consumed stream is never replayed
    // automatically when the owner changes; the caller retries its upload ID.
    this.#server.head(SANDBOX_CONTROL_WORKSPACE_UPLOAD_PATH, async (request, reply) => {
      try {
        const header = request.headers["x-pi-cloud-upload"];
        if (
          typeof header !== "string" ||
          header.length > 12000 ||
          !this.#broker.prepareWorkspaceUpload
        )
          throw new Error("Invalid upload preflight");
        await this.#broker.prepareWorkspaceUpload(
          parseWorkspaceUploadRequest(JSON.parse(Buffer.from(header, "base64url").toString())),
        );
        return reply.code(204).send();
      } catch (error) {
        if (error instanceof SandboxOwnerRedirectError)
          return reply.code(307).header("location", error.ownerBaseUrl).send();
        return this.#failure(reply, error);
      }
    });
    this.#server.post(SANDBOX_CONTROL_WORKSPACE_UPLOAD_PATH, async (request, reply) => {
      const abort = new AbortController();
      const closed = () => {
        if (!reply.raw.writableEnded) abort.abort(new Error("Upload caller disconnected"));
      };
      reply.raw.on("close", closed);
      try {
        const header = request.headers["x-pi-cloud-upload"];
        if (
          typeof header !== "string" ||
          header.length > 12000 ||
          !(request.body instanceof Readable)
        )
          throw new Error("Invalid Workspace upload body");
        if (!this.#broker.uploadWorkspaceFile)
          throw new SandboxControlError(
            "workspace_upload_unavailable",
            "Workspace upload is unavailable",
            false,
          );
        const input = parseWorkspaceUploadRequest(
          JSON.parse(Buffer.from(header, "base64url").toString()),
        );
        const identity = parseUploadIdentity(
          request.headers["content-length"],
          request.headers["content-digest"],
        );
        if (input.sha256 !== identity.sha256 || input.byteLength !== identity.byteLength)
          throw new Error("Upload identity changed");
        return await this.#broker.uploadWorkspaceFile(input, request.body, abort.signal);
      } catch (error) {
        if (error instanceof SandboxOwnerRedirectError)
          return reply.code(307).header("location", error.ownerBaseUrl).send();
        return this.#failure(reply, error);
      } finally {
        reply.raw.removeListener("close", closed);
      }
    });

    this.#server.post(SANDBOX_CONTROL_WORKSPACE_BROWSER_PATH, async (request, reply) => {
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
          ? parseSandboxControlListWorkspaceDirectoryRequest(request.body)
          : parseSandboxControlReadWorkspaceFileRequest(request.body);
        if (message.type === "workspace.list_directory") {
          await reply.code(200).send(
            await this.#observed({
              request,
              spanName: "workspace.list_directory",
              operation: "list_directory",
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
            run: () => this.#broker.readWorkspaceFile(message),
          }),
        );
      } catch (error: unknown) {
        if (error instanceof SandboxOwnerRedirectError) {
          await reply.code(307).header("location", error.ownerBaseUrl).send();
          return;
        }
        await this.#failure(reply, error);
      }
    });

    this.#server.post(SANDBOX_CONTROL_SOURCE_CONTROL_PATH, async (request, reply) => {
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
              run: async () => {
                if (message.type === "source_control.workspace_credential_authorize") {
                  const authorize = this.#broker.authorizeSourceCredential;
                  if (authorize === undefined) {
                    throw new SandboxControlError(
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
                    throw new SandboxControlError(
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
                    throw new SandboxControlError(
                      "source_control_credential_unavailable",
                      "Source-control credential listing is unavailable",
                      false,
                    );
                  }
                  return list.call(this.#broker, message);
                }
                const disconnect = this.#broker.disconnectSourceCredential;
                if (disconnect === undefined) {
                  throw new SandboxControlError(
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
        throw new SandboxControlError(
          "source_control_request_invalid",
          "Source-control Workspace request is invalid",
          false,
        );
      } catch (error: unknown) {
        await this.#failure(reply, error);
      }
    });

    this.#server.post(SANDBOX_CONTROL_INVENTORY_PATH, async (request, reply) => {
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
          throw new SandboxControlError(
            "unsupported_tool_broker_operation",
            "Sandbox control does not own the Runner process",
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
    let connection:
      Awaited<ReturnType<NonNullable<SandboxControlBackend["openTerminal"]>>> | undefined;
    let closed = false;
    let initialized = false;
    let processing = Promise.resolve();
    let pendingInputBytes = 0;
    let pendingInputFrames = 0;
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
      // Preserve an already-sent close frame; ws bounds its closing handshake.
      if (socket.readyState === socket.OPEN) socket.close(1_000, "terminal closed");
    };
    const fail = async (error: unknown): Promise<void> => {
      if (error instanceof SandboxOwnerRedirectError) {
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
      if (closed) return;
      const bytes = Array.isArray(data)
        ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
        : data.byteLength;
      // Keep reading control frames so a disconnect can cancel a blocked input.
      // Bound this serial queue instead of pausing the entire WebSocket transport.
      if (
        pendingInputBytes + bytes > MAXIMUM_TERMINAL_PENDING_INPUT_BYTES ||
        pendingInputFrames >= MAXIMUM_TERMINAL_PENDING_INPUT_FRAMES
      ) {
        socket.close(1009, "terminal input buffer overloaded");
        void close();
        return;
      }
      pendingInputBytes += bytes;
      pendingInputFrames += 1;
      processing = processing
        .then(async () => {
          if (closed) return;
          const raw =
            data instanceof ArrayBuffer
              ? Buffer.from(data).toString("utf8")
              : Array.isArray(data)
                ? Buffer.concat(data).toString("utf8")
                : data.toString("utf8");
          const parsed = JSON.parse(raw) as unknown;
          if (!initialized) {
            initialized = true;
            let opened: Awaited<ReturnType<NonNullable<SandboxControlBackend["openTerminal"]>>>;
            if (developmentEnvironment) {
              const open = parseDevelopmentEnvironmentTerminalOpenRequest(parsed);
              const openTerminal = this.#broker.openDevelopmentEnvironmentTerminal;
              if (openTerminal === undefined) {
                throw new SandboxControlError(
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
                throw new SandboxControlError(
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
            throw new SandboxControlError(
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
        .catch((error: unknown) => fail(error))
        .finally(() => {
          pendingInputBytes -= bytes;
          pendingInputFrames -= 1;
        });
    });
    socket.once("close", () => void close());
    socket.once("error", () => void close());
  }
}
