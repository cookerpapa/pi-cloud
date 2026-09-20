import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type SupervisorHeartbeatAckMessage,
  type SupervisorHeartbeatMessage,
  type SupervisorRegisteredMessage,
} from "@pi-cloud/protocol";
import WebSocket, { type RawData } from "ws";
import { PINNED_PI_CODING_AGENT_VERSION } from "./pi-turn-runtime.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_PENDING_FRAMES = 16;

export interface SupervisorHeartbeatRuntime {
  createHeartbeat(
    identity: { supervisorId: string; bootId: string; connectionId: string },
    acceptingAssignments?: boolean,
  ): SupervisorHeartbeatMessage;
  applyHeartbeatAcknowledgement(
    heartbeat: SupervisorHeartbeatMessage,
    acknowledgement: SupervisorHeartbeatAckMessage,
  ): unknown;
}

export interface SupervisorControlRuntime extends SupervisorHeartbeatRuntime {
  revokeAllAssignments(): unknown;
}

export type SupervisorWebSocketRegistration = {
  supervisorId: string;
  bootId: string;
  sandboxId: string;
  supervisorVersion?: string;
  piPackageName?: string;
  piVersion?: string;
  supportedProtocolVersions?: readonly number[];
  capabilities?: readonly string[];
  maxConcurrentSessions: number;
};

export type SupervisorWebSocketClientOptions = {
  url: string;
  authorizationHeader: string;
  registration: SupervisorWebSocketRegistration;
  runtime: SupervisorControlRuntime;
  clock?: () => Date;
  idGenerator?: () => string;
  connectTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxPayloadBytes?: number;
  maxPendingFrames?: number;
  maxBufferedSendBytes?: number;
  /**
   * A retryable Control Channel break is not an execution-ownership loss when
   * the Run renews its PostgreSQL lease through the Worker execution path.
   * Standalone clients keep the historical fail-closed default; the
   * reconnecting production client explicitly suspends transport revocation.
   */
  revokeRuntimeOnRetryableDisconnect?: boolean;
};

export type SupervisorWebSocketClientClose = {
  initiatedByClient: boolean;
  code: number;
  reason: string;
  retryable: boolean;
  failureCode?: string;
};

export class SupervisorWebSocketClientError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SupervisorWebSocketClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

type ClientState = "idle" | "connecting" | "registered" | "failing" | "stopping" | "closed";

type PendingHeartbeat = {
  message: SupervisorHeartbeatMessage;
  timeout: NodeJS.Timeout;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value;
}

function nonEmpty(value: string, name: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be empty`);
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("supervisor WebSocket client clock must return a valid Date");
  }
  return value;
}

function websocketUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password) {
    throw new TypeError("supervisor WebSocket URL must use ws/wss without embedded credentials");
  }
  if (url.hash) throw new TypeError("supervisor WebSocket URL must not contain a fragment");
  if (url.search) throw new TypeError("supervisor WebSocket URL must not contain a query");
  return url.toString();
}

function textFrame(data: RawData): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function retryableWebSocketClose(code: number): boolean {
  return (
    code === 1_001 ||
    code === 1_006 ||
    code === 1_011 ||
    code === 1_012 ||
    code === 1_013 ||
    code === 4_002
  );
}

export class SupervisorWebSocketClient {
  readonly #url: string;
  readonly #authorizationHeader: string;
  readonly #registration: Required<SupervisorWebSocketRegistration>;
  readonly #runtime: SupervisorControlRuntime;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #connectTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #maxPayloadBytes: number;
  readonly #maxPendingFrames: number;
  readonly #maxBufferedSendBytes: number;
  readonly #revokeRuntimeOnRetryableDisconnect: boolean;
  readonly #closedPromise: Promise<SupervisorWebSocketClientClose>;
  readonly #resolveClosed: (value: SupervisorWebSocketClientClose) => void;
  #state: ClientState = "idle";
  #socket: WebSocket | undefined;
  #registered: SupervisorRegisteredMessage | undefined;
  #startResolve: ((message: SupervisorRegisteredMessage) => void) | undefined;
  #startReject: ((error: SupervisorWebSocketClientError) => void) | undefined;
  #connectTimer: NodeJS.Timeout | undefined;
  #heartbeatTimer: NodeJS.Timeout | undefined;
  #pendingHeartbeat: PendingHeartbeat | undefined;
  #heartbeatRefreshRequested = false;
  #frameProcessing: Promise<void> = Promise.resolve();
  #pendingFrames = 0;
  #acceptingAssignments = true;
  #initiatedClose = false;
  #failureCode: string | undefined;
  #failureRetryable: boolean | undefined;
  #closedSettled = false;
  #runtimeRevoked = false;

  constructor(options: SupervisorWebSocketClientOptions) {
    this.#url = websocketUrl(options.url);
    if (
      options.authorizationHeader.trim().length === 0 ||
      options.authorizationHeader.length > 4_103 ||
      /[\r\n]/.test(options.authorizationHeader)
    ) {
      throw new TypeError("authorizationHeader must be a bounded non-empty value");
    }
    this.#authorizationHeader = options.authorizationHeader;
    this.#registration = {
      supervisorId: nonEmpty(options.registration.supervisorId, "registration.supervisorId"),
      bootId: requireUuid(options.registration.bootId, "registration.bootId"),
      sandboxId: requireUuid(options.registration.sandboxId, "registration.sandboxId"),
      supervisorVersion: nonEmpty(
        options.registration.supervisorVersion ?? "0.1.0",
        "registration.supervisorVersion",
      ),
      piPackageName: nonEmpty(
        options.registration.piPackageName ?? "@earendil-works/pi-coding-agent",
        "registration.piPackageName",
      ),
      piVersion: nonEmpty(
        options.registration.piVersion ?? PINNED_PI_CODING_AGENT_VERSION,
        "registration.piVersion",
      ),
      supportedProtocolVersions: [...(options.registration.supportedProtocolVersions ?? [1])],
      capabilities: [...(options.registration.capabilities ?? ["pi.sdk"])],
      maxConcurrentSessions: positiveInteger(
        options.registration.maxConcurrentSessions,
        "registration.maxConcurrentSessions",
      ),
    };
    this.#runtime = options.runtime;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#connectTimeoutMs = positiveInteger(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      "connectTimeoutMs",
    );
    this.#closeTimeoutMs = positiveInteger(
      options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
      "closeTimeoutMs",
    );
    this.#maxPayloadBytes = positiveInteger(
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      "maxPayloadBytes",
    );
    this.#maxPendingFrames = positiveInteger(
      options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FRAMES,
      "maxPendingFrames",
    );
    this.#maxBufferedSendBytes = positiveInteger(
      options.maxBufferedSendBytes ?? this.#maxPayloadBytes,
      "maxBufferedSendBytes",
    );
    this.#revokeRuntimeOnRetryableDisconnect = options.revokeRuntimeOnRetryableDisconnect ?? true;
    let resolveClosed!: (value: SupervisorWebSocketClientClose) => void;
    this.#closedPromise = new Promise((resolvePromise) => {
      resolveClosed = resolvePromise;
    });
    this.#resolveClosed = resolveClosed;
  }

  get state(): ClientState {
    return this.#state;
  }

  get connectionId(): string | undefined {
    return this.#registered?.payload.connectionId;
  }

  setAcceptingAssignments(value: boolean): void {
    if (this.#acceptingAssignments === value) return;
    this.#acceptingAssignments = value;
    if (this.#state !== "registered") return;
    if (this.#pendingHeartbeat !== undefined) {
      this.#heartbeatRefreshRequested = true;
      return;
    }
    if (this.#heartbeatTimer !== undefined) {
      clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = undefined;
    }
    this.#scheduleHeartbeat(0);
  }

  waitUntilClosed(): Promise<SupervisorWebSocketClientClose> {
    return this.#closedPromise;
  }

  async start(): Promise<SupervisorRegisteredMessage> {
    if (this.#state !== "idle") {
      throw new SupervisorWebSocketClientError(
        "invalid_client_state",
        "Supervisor WebSocket client was already started",
        false,
      );
    }
    this.#state = "connecting";
    const started = new Promise<SupervisorRegisteredMessage>((resolvePromise, rejectPromise) => {
      this.#startResolve = resolvePromise;
      this.#startReject = rejectPromise;
    });
    const socket = new WebSocket(this.#url, {
      headers: { authorization: this.#authorizationHeader },
      handshakeTimeout: this.#connectTimeoutMs,
      maxPayload: this.#maxPayloadBytes,
      perMessageDeflate: false,
    });
    this.#socket = socket;
    this.#connectTimer = setTimeout(() => {
      this.#fail("registration_timeout", "Supervisor registration timed out", true);
    }, this.#connectTimeoutMs);
    this.#connectTimer.unref();

    socket.once("open", () => {
      void this.#send(this.#registrationMessage()).catch(() => {
        this.#fail("registration_send_failed", "Supervisor registration send failed", true);
      });
    });
    socket.on("message", (data, isBinary) => {
      this.#enqueueFrame(data, isBinary);
    });
    socket.once("error", () => {
      this.#fail("websocket_transport_failed", "Supervisor WebSocket transport failed", true);
    });
    socket.once("unexpected-response", (_request, response) => {
      const statusCode = response.statusCode ?? 0;
      response.resume();
      if (statusCode === 401 || statusCode === 403) {
        this.#fail(
          "supervisor_authentication_rejected",
          "Supervisor WebSocket authentication was rejected",
          false,
        );
        return;
      }
      this.#fail(
        "websocket_handshake_rejected",
        "Supervisor WebSocket handshake was rejected",
        statusCode === 429 || statusCode >= 500,
      );
    });
    socket.once("close", (code, reason) => {
      this.#finishClose(code, reason.toString("utf8"));
    });
    return started;
  }

  async stop(): Promise<SupervisorWebSocketClientClose> {
    if (this.#state === "idle") {
      this.#initiatedClose = true;
      this.#revokeRuntime();
      this.#state = "closed";
      this.#settleClosed({
        initiatedByClient: true,
        code: 1_000,
        reason: "not started",
        retryable: false,
      });
      return this.#closedPromise;
    }
    if (this.#state === "closed" || this.#state === "failing") return this.#closedPromise;
    this.#initiatedClose = true;
    this.#startReject?.(
      new SupervisorWebSocketClientError(
        "supervisor_client_stopped",
        "Supervisor WebSocket client was stopped",
        false,
      ),
    );
    this.#startResolve = undefined;
    this.#startReject = undefined;
    this.#state = "stopping";
    this.#clearTimers();
    this.#revokeRuntime();
    const socket = this.#socket;
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.close(1_000, "client shutdown");
      const forceTimer = setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      }, this.#closeTimeoutMs);
      forceTimer.unref();
    } else if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    } else {
      this.#finishClose(1_000, "client shutdown");
    }
    return this.#closedPromise;
  }

  #registrationMessage() {
    const parsed = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: requireUuid(this.#idGenerator(), "generated registration messageId"),
      sentAt: validDate(this.#clock).toISOString(),
      type: "supervisor.register",
      payload: {
        supervisorId: this.#registration.supervisorId,
        bootId: this.#registration.bootId,
        sandboxId: this.#registration.sandboxId,
        supervisorVersion: this.#registration.supervisorVersion,
        pi: {
          packageName: this.#registration.piPackageName,
          version: this.#registration.piVersion,
        },
        supportedProtocolVersions: this.#registration.supportedProtocolVersions,
        capabilities: this.#registration.capabilities,
        acceptingAssignments: this.#acceptingAssignments,
        maxConcurrentSessions: this.#registration.maxConcurrentSessions,
      },
    });
    if (parsed.type !== "supervisor.register") {
      throw new SupervisorWebSocketClientError(
        "registration_invariant",
        "Constructed supervisor registration is invalid",
        false,
      );
    }
    return parsed;
  }

  #enqueueFrame(data: RawData, isBinary: boolean): void {
    if (this.#state === "closed" || this.#state === "failing" || this.#state === "stopping") return;
    this.#pendingFrames += 1;
    if (this.#pendingFrames > this.#maxPendingFrames) {
      this.#pendingFrames -= 1;
      this.#fail("frame_queue_overloaded", "Supervisor client frame queue overloaded", true);
      return;
    }
    this.#frameProcessing = this.#frameProcessing
      .then(async () => {
        if (this.#state !== "closed" && this.#state !== "failing" && this.#state !== "stopping") {
          await this.#processFrame(data, isBinary);
        }
      })
      .catch((error: unknown) => {
        this.#handleProcessingError(error);
      })
      .finally(() => {
        this.#pendingFrames -= 1;
      });
  }

  async #processFrame(data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      throw new SupervisorWebSocketClientError(
        "binary_frame",
        "Supervisor server sent a binary frame",
        false,
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(textFrame(data));
    } catch {
      throw new SupervisorWebSocketClientError(
        "invalid_server_json",
        "Supervisor server sent invalid JSON",
        false,
      );
    }
    let message;
    try {
      message = parseControlToSupervisorMessage(value);
    } catch {
      throw new SupervisorWebSocketClientError(
        "invalid_server_message",
        "Supervisor server sent an invalid message",
        false,
      );
    }

    if (this.#state === "connecting") {
      if (
        message.type !== "supervisor.registered" ||
        message.payload.supervisorId !== this.#registration.supervisorId ||
        message.payload.bootId !== this.#registration.bootId
      ) {
        throw new SupervisorWebSocketClientError(
          "registration_ack_mismatch",
          "Supervisor registration acknowledgement did not match",
          false,
        );
      }
      this.#registered = message;
      this.#state = "registered";
      if (this.#connectTimer !== undefined) {
        clearTimeout(this.#connectTimer);
        this.#connectTimer = undefined;
      }
      this.#startResolve?.(message);
      this.#startResolve = undefined;
      this.#startReject = undefined;
      this.#scheduleHeartbeat(0);
      return;
    }

    if (this.#state !== "registered") return;
    if (message.type === "supervisor.heartbeat.ack") {
      this.#acceptHeartbeatAcknowledgement(message);
      return;
    }
    throw new SupervisorWebSocketClientError(
      "unexpected_server_message",
      "Supervisor server message was unexpected",
      false,
    );
  }

  #acceptHeartbeatAcknowledgement(message: SupervisorHeartbeatAckMessage): void {
    const pending = this.#pendingHeartbeat;
    if (
      pending === undefined ||
      message.payload.acknowledgedMessageId !== pending.message.messageId
    ) {
      throw new SupervisorWebSocketClientError(
        "unexpected_heartbeat_ack",
        "Supervisor heartbeat acknowledgement was unexpected",
        false,
      );
    }
    clearTimeout(pending.timeout);
    this.#pendingHeartbeat = undefined;
    try {
      this.#runtime.applyHeartbeatAcknowledgement(pending.message, message);
    } catch {
      throw new SupervisorWebSocketClientError(
        "heartbeat_ack_rejected",
        "Supervisor heartbeat acknowledgement was rejected",
        false,
      );
    }
    const refreshImmediately = this.#heartbeatRefreshRequested;
    this.#heartbeatRefreshRequested = false;
    this.#scheduleHeartbeat(refreshImmediately ? 0 : this.#registered!.payload.heartbeatIntervalMs);
  }

  #scheduleHeartbeat(delayMs: number): void {
    if (this.#state !== "registered") return;
    if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = setTimeout(() => {
      this.#heartbeatTimer = undefined;
      void this.#sendHeartbeat();
    }, delayMs);
    this.#heartbeatTimer.unref();
  }

  async #sendHeartbeat(): Promise<void> {
    if (this.#state !== "registered" || this.#registered === undefined) return;
    if (this.#pendingHeartbeat !== undefined) {
      this.#fail("heartbeat_overlap", "Supervisor heartbeat overlapped", false);
      return;
    }
    let message: SupervisorHeartbeatMessage;
    try {
      message = this.#runtime.createHeartbeat(
        {
          supervisorId: this.#registration.supervisorId,
          bootId: this.#registration.bootId,
          connectionId: this.#registered.payload.connectionId,
        },
        this.#acceptingAssignments,
      );
    } catch {
      this.#fail("heartbeat_build_failed", "Supervisor heartbeat could not be built", false);
      return;
    }
    // Heartbeats are serialized and the next interval starts only after this ACK.
    // Giving the database-backed control plane merely one heartbeat interval to
    // reply makes healthy connections flap under short-lived write contention.
    // Keep enough time for one subsequent heartbeat before the durable liveness
    // deadline instead.
    const acknowledgementTimeoutMs = Math.max(
      1,
      this.#registered.payload.heartbeatTimeoutMs - this.#registered.payload.heartbeatIntervalMs,
    );
    const timeout = setTimeout(() => {
      this.#fail("heartbeat_ack_timeout", "Supervisor heartbeat acknowledgement timed out", true);
    }, acknowledgementTimeoutMs);
    timeout.unref();
    this.#pendingHeartbeat = { message, timeout };
    try {
      await this.#send(message);
    } catch {
      this.#fail("heartbeat_send_failed", "Supervisor heartbeat send failed", true);
    }
  }

  async #send(value: unknown): Promise<void> {
    const socket = this.#socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new SupervisorWebSocketClientError(
        "websocket_not_open",
        "Supervisor WebSocket is not open",
        true,
      );
    }
    const payload = JSON.stringify(value);
    const bytes = Buffer.byteLength(payload, "utf8");
    if (
      bytes > this.#maxPayloadBytes ||
      bytes > this.#maxBufferedSendBytes ||
      socket.bufferedAmount + bytes > this.#maxBufferedSendBytes
    ) {
      throw new SupervisorWebSocketClientError(
        "send_buffer_overloaded",
        "Supervisor WebSocket send buffer is overloaded",
        true,
      );
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      socket.send(payload, (error) => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  }

  #handleProcessingError(error: unknown): void {
    if (error instanceof SupervisorWebSocketClientError) {
      this.#fail(error.code, error.message, error.retryable);
      return;
    }
    this.#fail(
      "message_processing_failed",
      "Supervisor server message could not be processed",
      false,
    );
  }

  #fail(code: string, safeMessage: string, retryable: boolean): void {
    if (this.#state === "closed" || this.#state === "failing" || this.#state === "stopping") return;
    this.#failureCode = code;
    this.#failureRetryable = retryable;
    const error = new SupervisorWebSocketClientError(code, safeMessage, retryable);
    this.#startReject?.(error);
    this.#startResolve = undefined;
    this.#startReject = undefined;
    this.#state = "failing";
    this.#clearTimers();
    if (!retryable || this.#revokeRuntimeOnRetryableDisconnect) {
      this.#revokeRuntime();
    }
    const socket = this.#socket;
    if (socket !== undefined && socket.readyState === WebSocket.OPEN) {
      socket.close(retryable ? 1_011 : 1_002, "supervisor client failed");
    } else if (socket !== undefined && socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    } else {
      this.#finishClose(retryable ? 1_011 : 1_002, "supervisor client failed");
    }
  }

  #finishClose(code: number, reason: string): void {
    if (this.#state === "closed") return;
    const retryable =
      !this.#initiatedClose && (this.#failureRetryable ?? retryableWebSocketClose(code));
    if (this.#state === "connecting" && this.#startReject !== undefined) {
      this.#startReject(
        new SupervisorWebSocketClientError(
          this.#failureCode ?? "registration_connection_closed",
          "Supervisor connection closed before registration",
          retryable,
        ),
      );
      this.#startResolve = undefined;
      this.#startReject = undefined;
    }
    this.#clearTimers();
    if (this.#initiatedClose || !retryable || this.#revokeRuntimeOnRetryableDisconnect) {
      this.#revokeRuntime();
    }
    this.#state = "closed";
    this.#settleClosed({
      initiatedByClient: this.#initiatedClose,
      code,
      reason: reason.slice(0, 123),
      retryable,
      ...(this.#failureCode === undefined ? {} : { failureCode: this.#failureCode }),
    });
  }

  #revokeRuntime(): void {
    if (this.#runtimeRevoked) return;
    this.#runtimeRevoked = true;
    this.#runtime.revokeAllAssignments();
  }

  #clearTimers(): void {
    if (this.#connectTimer !== undefined) clearTimeout(this.#connectTimer);
    if (this.#heartbeatTimer !== undefined) clearTimeout(this.#heartbeatTimer);
    if (this.#pendingHeartbeat !== undefined) clearTimeout(this.#pendingHeartbeat.timeout);
    this.#connectTimer = undefined;
    this.#heartbeatTimer = undefined;
    this.#pendingHeartbeat = undefined;
    this.#heartbeatRefreshRequested = false;
  }

  #settleClosed(value: SupervisorWebSocketClientClose): void {
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    this.#resolveClosed(value);
  }
}
