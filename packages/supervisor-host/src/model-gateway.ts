import { Agent, fetch as upstreamFetch } from "undici";
import { resourceLimit, minimumResourceLimit } from "@pi-cloud/domain";
import {
  assertModelAdapter,
  parseModelRuntimeSnapshot,
  type ModelRuntimeSnapshot,
} from "@pi-cloud/protocol";
import {
  MODEL_SAMPLING_ATTEMPT_HEADER,
  MODEL_STEP_SEQUENCE_HEADER,
  MODEL_STEP_SHA256_HEADER,
  parseModelSamplingIdentity,
  type AgentModelRuntime,
  type ExecuteTurnCommandMessage,
  type ModelSamplingIdentity,
} from "@pi-cloud/protocol";
import type { TrustedModelRuntimeLease } from "@pi-cloud/sandbox-supervisor";
import {
  operationalLog,
  parseTraceCarrier,
  withSpan,
  type PiCloudMetrics,
} from "@pi-cloud/observability";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { addAbortSignal } from "node:stream";
import { zstdDecompressSync } from "node:zlib";
import { ModelWebSocketGateway, type ModelSocketGrant } from "./model-websocket-gateway.ts";

const CODEX_RESPONSES_PATH = "/codex/responses";
const PROVIDER_RESPONSES_PATH = "/v1/responses";
const MAX_REQUEST_BYTES = 128 * 1_024 * 1_024;
const MAX_DECOMPRESSED_REQUEST_BYTES = 128 * 1_024 * 1_024;
const MAX_RESPONSE_BYTES = 64 * 1_024 * 1_024;

type SupportedModel =
  | (ModelRuntimeSnapshot & { provider: "deepseek"; modelId: string } & {
      requestPath: typeof PROVIDER_RESPONSES_PATH;
      providerPath: typeof PROVIDER_RESPONSES_PATH;
      baseUrlPath: "/v1";
    })
  | (ModelRuntimeSnapshot & { provider: "openai-codex"; modelId: string } & {
      requestPath: typeof CODEX_RESPONSES_PATH;
      providerPath: typeof PROVIDER_RESPONSES_PATH;
      baseUrlPath: "";
    });

type RootModelBudget = { key: string; holders: number; maximum: number | null; started: number };
type ActiveCapabilityFields = {
  tokenDigest: string;
  tenantId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  modelProfileId: string;
  serviceTier: "fast" | null;
  detachOwner?: () => void;
  budget: RootModelBudget;
  revoked: boolean;
  requestControllers: Set<AbortController>;
};

type ActiveCapability =
  | (Extract<SupportedModel, { provider: "deepseek" }> & ActiveCapabilityFields)
  | (Extract<SupportedModel, { provider: "openai-codex" }> & ActiveCapabilityFields);

export type TenantModelGatewayOptions = {
  host: string;
  port: number;
  advertisedBaseUrl: string;
  providerGatewayBaseUrl: string;
  providerGatewayApiKey: string;
  maximumRequestsPerTurn?: number | null;
  connectTimeoutMs?: number;
  eventIdleTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  randomBytes?: (size: number) => Buffer;
  metrics?: PiCloudMetrics;
};

export class TenantModelGatewayError extends Error {
  readonly code:
    | "gateway_not_started"
    | "gateway_already_started"
    | "unsupported_model"
    | "unsupported_service_tier"
    | "invalid_gateway_configuration";

  constructor(code: TenantModelGatewayError["code"], safeMessage: string) {
    super(safeMessage);
    this.name = "TenantModelGatewayError";
    this.code = code;
  }
}

class SafeGatewayHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, safeMessage: string) {
    super(safeMessage);
    this.name = "SafeGatewayHttpError";
    this.status = status;
    this.code = code;
  }
}

function positiveInteger(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TenantModelGatewayError("invalid_gateway_configuration", `${name} is invalid`);
  }
  return value;
}

function serviceBaseUrl(value: string, name: string, requireHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TenantModelGatewayError("invalid_gateway_configuration", `${name} is invalid`);
  }
  if (
    (requireHttp ? parsed.protocol !== "http:" : !["http:", "https:"].includes(parsed.protocol)) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TenantModelGatewayError("invalid_gateway_configuration", `${name} is invalid`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function providerGatewayApiKey(value: string): string {
  if (value.length < 32 || value.length > 4_096 || /[\r\n\0]/.test(value)) {
    throw new TenantModelGatewayError(
      "invalid_gateway_configuration",
      "Provider Gateway API key is invalid",
    );
  }
  return value;
}

function bearerCapability(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43})$/.exec(value)?.[1];
}

function capabilityToken(signature: Buffer, sessionId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", pcmg: 1 }), "utf8").toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "pi-cloud-provider-gateway",
      },
      sid: sessionId,
    }),
    "utf8",
  ).toString("base64url");
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function samplingIdentity(request: IncomingMessage): ModelSamplingIdentity {
  try {
    return parseModelSamplingIdentity({
      stepSequence: request.headers[MODEL_STEP_SEQUENCE_HEADER],
      stepSha256: request.headers[MODEL_STEP_SHA256_HEADER],
      samplingAttempt: request.headers[MODEL_SAMPLING_ATTEMPT_HEADER],
    });
  } catch {
    throw new SafeGatewayHttpError(
      400,
      "model_sampling_identity_invalid",
      "Model request is missing its Cloud Step identity",
    );
  }
}

function observableSamplingIdentity(request: IncomingMessage): ModelSamplingIdentity | undefined {
  try {
    return samplingIdentity(request);
  } catch {
    return undefined;
  }
}

function capabilityDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendStreamingError(
  response: ServerResponse,
  error: Readonly<{ code: string; message: string }>,
): void {
  if (!response.headersSent) {
    sendJson(response, 502, { error });
    return;
  }
  if (response.writableEnded || response.destroyed) return;
  response.end(
    `data: ${JSON.stringify({ type: "error", code: error.code, message: error.message })}\n\n`,
  );
}

async function readBody(
  request: IncomingMessage,
  reserve: (bytes: number) => void,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new SafeGatewayHttpError(413, "request_too_large", "Model request is too large");
    }
    reserve(chunk.length);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseBody(
  bytes: Buffer,
  contentEncoding: string | undefined,
  reserve: (bytes: number) => void,
): Record<string, unknown> {
  let decoded = bytes;
  if (contentEncoding !== undefined && contentEncoding.trim().length > 0) {
    if (contentEncoding.trim().toLowerCase() !== "zstd") {
      throw new SafeGatewayHttpError(
        415,
        "unsupported_content_encoding",
        "Model request encoding is unsupported",
      );
    }
    try {
      decoded = zstdDecompressSync(bytes, { maxOutputLength: MAX_DECOMPRESSED_REQUEST_BYTES });
    } catch {
      throw new SafeGatewayHttpError(
        400,
        "invalid_request_encoding",
        "Model request encoding is invalid",
      );
    }
  }
  if (decoded.length > MAX_DECOMPRESSED_REQUEST_BYTES) {
    throw new SafeGatewayHttpError(413, "request_too_large", "Model request is too large");
  }
  reserve(Math.max(0, decoded.length - bytes.length));
  let value: unknown;
  try {
    value = JSON.parse(decoded.toString("utf8")) as unknown;
  } catch {
    throw new SafeGatewayHttpError(400, "invalid_request", "Model request must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SafeGatewayHttpError(400, "invalid_request", "Model request must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function writeChunk(
  response: ServerResponse,
  chunk: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  if (!response.write(chunk)) await once(response, "drain", { signal });
}

function supportedModel(
  provider: string,
  modelId: string,
  snapshot: unknown,
): SupportedModel | undefined {
  if (provider !== "deepseek" && provider !== "openai-codex") return undefined;
  const runtime = parseModelRuntimeSnapshot(snapshot);
  assertModelAdapter(provider, runtime);
  const model = { ...runtime, provider, modelId };
  return model.provider === "deepseek"
    ? {
        ...model,
        provider: "deepseek" as const,
        requestPath: PROVIDER_RESPONSES_PATH,
        providerPath: PROVIDER_RESPONSES_PATH,
        baseUrlPath: "/v1",
      }
    : {
        ...model,
        provider: "openai-codex" as const,
        requestPath: CODEX_RESPONSES_PATH,
        providerPath: PROVIDER_RESPONSES_PATH,
        baseUrlPath: "",
      };
}

const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "content-encoding",
  "content-type",
  "openai-beta",
  "originator",
  "session-id",
  "session_id",
  "user-agent",
  "x-client-request-id",
  "x-codex-installation-id",
  "x-codex-turn-metadata",
  "x-session-affinity",
  "x-session-id",
]);

function upstreamHeaders(
  request: IncomingMessage,
  active: ActiveCapability,
  apiKey: string,
): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (!FORWARDED_REQUEST_HEADERS.has(name) || raw === undefined) continue;
    headers.set(name, Array.isArray(raw) ? raw.join(", ") : raw);
  }
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("content-type", "application/json");
  headers.set("session-id", active.sessionId);
  headers.set("x-session-id", active.sessionId);
  return headers;
}

export class TenantModelGateway {
  readonly #host: string;
  readonly #port: number;
  readonly #advertisedBaseUrl: string;
  readonly #providerGatewayBaseUrl: string;
  readonly #providerGatewayApiKey: string;
  readonly #maximumRequestsPerTurn: number | null;
  readonly #eventIdleTimeoutMs: number;
  readonly #dispatcher: Agent | undefined;
  readonly #fetch: typeof fetch;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #server: Server;
  readonly #sockets: ModelWebSocketGateway;
  readonly #capabilities = new Map<string, ActiveCapability>();
  readonly #budgets = new Map<string, RootModelBudget>();
  #started = false;
  #requestBytes = 0;
  #closing: Promise<void> | undefined;

  constructor(options: TenantModelGatewayOptions) {
    this.#host = options.host;
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new TenantModelGatewayError("invalid_gateway_configuration", "port is invalid");
    }
    this.#port = options.port;
    this.#advertisedBaseUrl = serviceBaseUrl(
      options.advertisedBaseUrl,
      "Model Gateway advertised URL",
      true,
    );
    this.#providerGatewayBaseUrl = serviceBaseUrl(
      options.providerGatewayBaseUrl,
      "Provider Gateway URL",
      false,
    );
    this.#providerGatewayApiKey = providerGatewayApiKey(options.providerGatewayApiKey);
    this.#maximumRequestsPerTurn = resourceLimit(
      options.maximumRequestsPerTurn,
      "maximumRequestsPerTurn",
    );
    const connectTimeoutMs = positiveInteger(
      options.connectTimeoutMs ?? 15_000,
      "connectTimeoutMs",
      300_000,
    );
    this.#eventIdleTimeoutMs = positiveInteger(
      options.eventIdleTimeoutMs ?? 300_000,
      "eventIdleTimeoutMs",
      900_000,
    );
    this.#dispatcher = options.fetchImplementation
      ? undefined
      : new Agent({ connect: { timeout: connectTimeoutMs }, headersTimeout: 0, bodyTimeout: 0 });
    this.#fetch =
      options.fetchImplementation ??
      (async (input, init) => {
        const result = await upstreamFetch(String(input), {
          method: init!.method!,
          headers: init!.headers as Record<string, string>,
          body: init!.body as Uint8Array,
          signal: init?.signal ?? null,
          dispatcher: this.#dispatcher!,
        });
        return result as unknown as Response;
      });
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#metrics = options.metrics;
    this.#server = createServer((request, response) => {
      const startedAt = performance.now();
      const token = bearerCapability(request.headers.authorization);
      const active =
        token === undefined ? undefined : this.#capabilities.get(capabilityDigest(token));
      const sampling = observableSamplingIdentity(request);
      const parent = parseTraceCarrier({
        traceparent: request.headers.traceparent,
        tracestate: request.headers.tracestate,
      });
      void withSpan({
        serviceName: "pi-cloud-model-gateway",
        name: "model.request",
        ...(parent === undefined ? {} : { parent }),
        attributes: {
          ...(active === undefined
            ? {}
            : {
                "pi_cloud.run.id": active.runId,
                ...(sampling === undefined
                  ? {}
                  : {
                      "pi_cloud.step.sequence": sampling.stepSequence,
                      "pi_cloud.step.sha256": sampling.stepSha256,
                      "pi_cloud.sampling.attempt": sampling.samplingAttempt,
                    }),
                "gen_ai.system": active.provider,
                "gen_ai.request.model": active.modelId,
              }),
        },
        run: () => this.#handle(request, response),
      }).then(
        () => this.#observe(active, response.statusCode < 400 ? "eof" : "rejected", startedAt),
        (error: unknown) => {
          this.#observe(
            active,
            active?.revoked
              ? "revoked"
              : error instanceof SafeGatewayHttpError && error.code === "downstream_disconnected"
                ? "disconnected"
                : "failed",
            startedAt,
          );
          if (error instanceof SafeGatewayHttpError) {
            if (response.headersSent) {
              if (error.code === "downstream_disconnected") response.destroy();
              else sendStreamingError(response, { code: error.code, message: error.message });
            } else {
              sendJson(response, error.status, {
                error: { code: error.code, message: error.message },
              });
            }
            return;
          }
          sendStreamingError(response, {
            code: "model_gateway_error",
            message: "Model Gateway request failed",
          });
        },
      );
    });
    this.#sockets = new ModelWebSocketGateway(
      (request) => this.#socketGrant(request),
      connectTimeoutMs,
    );
    this.#server.on("upgrade", (request, socket, head) =>
      this.#sockets.upgrade(request, socket, head),
    );
  }

  #socketGrant(request: IncomingMessage): ModelSocketGrant {
    const token = bearerCapability(request.headers.authorization);
    const active = this.#requireCapability(
      token ? this.#capabilities.get(capabilityDigest(token)) : undefined,
    );
    const path = new URL(request.url ?? "/", "http://model-gateway.invalid").pathname;
    if (active.provider !== "openai-codex" || path !== active.requestPath)
      throw new SafeGatewayHttpError(
        403,
        "model_protocol_mismatch",
        "Model transport does not match its capability",
      );
    const controller = new AbortController();
    active.requestControllers.add(controller);
    const url = new URL(`${this.#providerGatewayBaseUrl}${active.providerPath}`);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return {
      upstreamUrl: url.toString(),
      headers: Object.fromEntries(upstreamHeaders(request, active, this.#providerGatewayApiKey)),
      signal: controller.signal,
      admit: (body) => {
        this.#validateModelBody(body, active);
        this.#admit(active, controller.signal);
      },
      reserve: (bytes) => {
        if (this.#requestBytes + bytes > 256 * 1024 * 1024)
          throw new Error("Model upload capacity is exhausted");
        this.#requestBytes += bytes;
        let released = false;
        return () => {
          if (!released) {
            released = true;
            this.#requestBytes -= bytes;
          }
        };
      },
      observe: (sampling, timing) => {
        operationalLog({
          service: "pi-cloud-model-gateway",
          level: "info",
          event: "model.transport.timing",
          attributes: {
            runId: active.runId,
            ...sampling,
            provider: active.provider,
            model: active.modelId,
            ...timing,
          },
        });
        this.#observe(
          active,
          timing.transportCompleted ? "eof" : active.revoked ? "revoked" : "disconnected",
          Number(timing.receivedMonotonicMs),
        );
      },
      release: () => {
        active.requestControllers.delete(controller);
      },
    };
  }

  #validateModelBody(body: Record<string, unknown>, active: ActiveCapability): void {
    if (body.model !== active.modelId)
      throw new SafeGatewayHttpError(
        403,
        "model_binding_mismatch",
        "Model request does not match its Turn capability",
      );
    if (
      (active.serviceTier === "fast" && body.service_tier !== "fast") ||
      (active.serviceTier === null && body.service_tier !== undefined)
    )
      throw new SafeGatewayHttpError(
        403,
        "model_service_tier_mismatch",
        "Model request does not match its Turn service tier",
      );
  }

  #admit(active: ActiveCapability, signal: AbortSignal): void {
    this.#requireCapability(active);
    signal.throwIfAborted();
    if (active.budget.maximum !== null && active.budget.started >= active.budget.maximum)
      throw new SafeGatewayHttpError(
        429,
        "model_request_limit_exceeded",
        "Model request quota exceeded",
      );
    active.budget.started++;
  }

  get listeningPort(): number {
    const address = this.#server.address();
    if (!this.#started || address === null || typeof address === "string") {
      throw new TenantModelGatewayError("gateway_not_started", "Model Gateway is not listening");
    }
    return (address as AddressInfo).port;
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new TenantModelGatewayError(
        "gateway_already_started",
        "Model Gateway has already started",
      );
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const onError = (error: Error): void => rejectPromise(error);
      this.#server.once("error", onError);
      this.#server.listen(this.#port, this.#host, () => {
        this.#server.off("error", onError);
        this.#started = true;
        resolvePromise();
      });
    });
  }

  issue(command: ExecuteTurnCommandMessage, signal?: AbortSignal): TrustedModelRuntimeLease {
    signal?.throwIfAborted();
    if (!this.#started) {
      throw new TenantModelGatewayError("gateway_not_started", "Model Gateway is not listening");
    }
    const model = supportedModel(
      command.payload.model.provider,
      command.payload.model.modelId,
      command.payload.model.runtime,
    );
    if (model === undefined) {
      throw new TenantModelGatewayError("unsupported_model", "Accepted model is unsupported");
    }
    if (command.payload.model.serviceTier === "fast" && !model.fastModeAvailable) {
      throw new TenantModelGatewayError(
        "unsupported_service_tier",
        "Accepted model does not support Fast mode",
      );
    }
    if (!model.thinkingLevels.includes(command.payload.model.thinkingLevel))
      throw new TenantModelGatewayError(
        "unsupported_model",
        "Thinking level is outside the accepted model snapshot",
      );
    const random = this.#randomBytes(32);
    if (!Buffer.isBuffer(random) || random.length !== 32) {
      throw new TenantModelGatewayError(
        "invalid_gateway_configuration",
        "Model Gateway capability generation failed",
      );
    }
    const capability = capabilityToken(random, command.payload.sessionId);
    const digest = capabilityDigest(capability);
    if (this.#capabilities.has(digest)) {
      throw new TenantModelGatewayError(
        "invalid_gateway_configuration",
        "Model Gateway capability collision occurred",
      );
    }
    const key = `${command.payload.tenantId}:${command.payload.runId}`;
    const maximum = minimumResourceLimit(
      this.#maximumRequestsPerTurn,
      command.payload.budgets?.maximumModelRequests ?? null,
    );
    let budget = this.#budgets.get(key);
    if (!budget) {
      budget = {
        key,
        holders: 0,
        maximum,
        started: command.payload.budgets?.consumedModelRequests ?? 0,
      };
      this.#budgets.set(key, budget);
    } else if (budget.maximum !== maximum)
      throw new TenantModelGatewayError(
        "invalid_gateway_configuration",
        "Root work model budget changed",
      );
    budget.holders++;
    const active: ActiveCapability = {
      ...model,
      tokenDigest: digest,
      tenantId: command.payload.tenantId,
      sessionId: command.payload.sessionId,
      turnId: command.payload.turnId,
      runId: command.payload.runId,
      modelProfileId: command.payload.model.profileId,
      serviceTier: command.payload.model.serviceTier,
      budget,
      revoked: false,
      requestControllers: new Set(),
    };
    this.#capabilities.set(digest, active);
    if (signal) {
      const revoke = () => this.#revoke(active);
      signal.addEventListener("abort", revoke, { once: true });
      active.detachOwner = () => signal.removeEventListener("abort", revoke);
    }
    let released = false;
    const runtime: AgentModelRuntime =
      active.provider === "deepseek"
        ? {
            kind: "openai_compatible_gateway",
            provider: active.provider,
            modelId: active.modelId,
            baseUrl: `${this.#advertisedBaseUrl}/v1`,
            api: "openai-responses",
            capability,
            reasoning: true,
            contextWindow: active.contextWindow,
            autoCompactTokenLimit: active.autoCompactTokenLimit,
            maxTokens: active.maxTokens,
            inputModalities: [...active.inputModalities],
            hostedTools: [...active.hostedTools],
            serviceTier: null,
            eventIdleTimeoutMs: this.#eventIdleTimeoutMs,
          }
        : {
            kind: "openai_compatible_gateway",
            provider: active.provider,
            modelId: active.modelId,
            baseUrl: this.#advertisedBaseUrl,
            api: "openai-codex-responses",
            capability,
            reasoning: true,
            contextWindow: active.contextWindow,
            autoCompactTokenLimit: active.autoCompactTokenLimit,
            maxTokens: active.maxTokens,
            inputModalities: [...active.inputModalities],
            hostedTools: [...active.hostedTools],
            serviceTier: active.serviceTier,
            eventIdleTimeoutMs: this.#eventIdleTimeoutMs,
          };
    return {
      runtime,
      release: () => {
        if (released) return;
        released = true;
        this.#revoke(active);
      },
    };
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = performance.now();
    const receivedAtMs = Date.now();
    const path = new URL(request.url ?? "/", "http://model-gateway.invalid").pathname;
    if (request.method === "GET" && path === "/health/live") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST") {
      throw new SafeGatewayHttpError(404, "route_not_found", "Model Gateway route not found");
    }
    const token = bearerCapability(request.headers.authorization);
    const active = this.#requireCapability(
      token === undefined ? undefined : this.#capabilities.get(capabilityDigest(token)),
    );
    if (path !== active.requestPath) {
      throw new SafeGatewayHttpError(
        403,
        "model_protocol_mismatch",
        "Model request protocol does not match its Turn capability",
      );
    }
    const requestSamplingIdentity = samplingIdentity(request);
    const controller = new AbortController();
    let disconnected = false;
    const abortOnRequest = (): void => {
      disconnected = true;
      controller.abort();
    };
    const abortOnResponse = (): void => {
      if (!response.writableEnded) {
        disconnected = true;
        controller.abort();
      }
    };
    request.once("aborted", abortOnRequest);
    response.once("close", abortOnResponse);
    active.requestControllers.add(controller);
    const timing: Record<string, number> = {};
    const elapsed = () => Math.round((performance.now() - startedAt) * 1000) / 1000;
    let upstreamAttempts = 0,
      responseBytes = 0,
      upstreamStatus: number | null = null;
    let transportCompleted = false;
    let reservedBytes = 0;
    const reserve = (bytes: number) => {
      if (this.#requestBytes + bytes > 256 * 1024 * 1024)
        throw new SafeGatewayHttpError(
          429,
          "model_upload_capacity_exhausted",
          "Model upload service unavailable: capacity is exhausted",
        );
      this.#requestBytes += bytes;
      reservedBytes += bytes;
    };
    try {
      // Uploads are in-flight work too: revocation must interrupt them before
      // they can become provider requests. Node removes this hook on stream end.
      addAbortSignal(controller.signal, request);
      const requestBytes = await readBody(request, reserve);
      const body = parseBody(requestBytes, request.headers["content-encoding"], reserve);
      this.#validateModelBody(body, active);
      if (body.stream !== true) {
        throw new SafeGatewayHttpError(
          400,
          "streaming_required",
          "Model Gateway requires a streaming request",
        );
      }
      // No await between the final authority/count check and reservation.
      this.#admit(active, controller.signal);
      timing.requestBytes = requestBytes.length;
      timing.upstreamStartMs = elapsed();
      upstreamAttempts = 1;
      const upstream = await this.#fetch(`${this.#providerGatewayBaseUrl}${active.providerPath}`, {
        method: "POST",
        headers: upstreamHeaders(request, active, this.#providerGatewayApiKey),
        body: new Uint8Array(requestBytes),
        signal: controller.signal,
      });
      timing.upstreamHeadersMs = elapsed();
      upstreamStatus = upstream.status;
      response.writeHead(upstream.status, {
        "cache-control": "no-store",
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
        ...(upstream.headers.get("retry-after") === null
          ? {}
          : { "retry-after": upstream.headers.get("retry-after")! }),
        ...(upstream.headers.get("x-request-id") === null
          ? {}
          : { "x-request-id": upstream.headers.get("x-request-id")! }),
      });
      if (upstream.body === null) {
        transportCompleted = true;
        response.end();
        return;
      }
      for await (const rawChunk of upstream.body) {
        timing.firstByteMs ??= elapsed();
        const chunk = rawChunk instanceof Uint8Array ? rawChunk : new Uint8Array(rawChunk);
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          controller.abort();
          throw new SafeGatewayHttpError(
            502,
            "response_too_large",
            "Model response exceeded the Gateway limit",
          );
        }
        await writeChunk(response, chunk, controller.signal);
      }
      transportCompleted = true;
      response.end();
    } catch (error: unknown) {
      if (error instanceof SafeGatewayHttpError) throw error;
      throw new SafeGatewayHttpError(
        502,
        disconnected ? "downstream_disconnected" : "provider_gateway_unavailable",
        "Model provider connection error",
      );
    } finally {
      this.#requestBytes -= reservedBytes;
      request.off("aborted", abortOnRequest);
      response.off("close", abortOnResponse);
      active.requestControllers.delete(controller);
      operationalLog({
        service: "pi-cloud-model-gateway",
        level: "info",
        event: "model.transport.timing",
        attributes: {
          runId: active.runId,
          stepSequence: requestSamplingIdentity.stepSequence,
          stepSha256: requestSamplingIdentity.stepSha256,
          samplingAttempt: requestSamplingIdentity.samplingAttempt,
          provider: active.provider,
          model: active.modelId,
          transport: "sse",
          receivedAtMs,
          receivedMonotonicMs: startedAt,
          processStartedAtMs: performance.timeOrigin,
          ...timing,
          elapsedMs: elapsed(),
          upstreamAttempts,
          upstreamStatus,
          responseBytes,
          transportCompleted,
        },
      });
    }
  }

  #requireCapability(active: ActiveCapability | undefined): ActiveCapability {
    if (!active || active.revoked || this.#capabilities.get(active.tokenDigest) !== active) {
      throw new SafeGatewayHttpError(
        401,
        "invalid_capability",
        "Model Gateway capability is invalid",
      );
    }
    return active;
  }

  #observe(
    active: ActiveCapability | undefined,
    outcome: "eof" | "rejected" | "failed" | "disconnected" | "revoked",
    startedAt: number,
  ): void {
    if (active === undefined) return;
    this.#metrics?.modelTransportDuration.observe(
      { provider: active.provider, model: active.modelId, outcome },
      (performance.now() - startedAt) / 1_000,
    );
  }

  #revoke(active: ActiveCapability): void {
    if (active.revoked) return;
    active.revoked = true;
    active.detachOwner?.();
    for (const controller of active.requestControllers) controller.abort();
    active.requestControllers.clear();
    this.#capabilities.delete(active.tokenDigest);
    if (--active.budget.holders === 0 && this.#budgets.get(active.budget.key) === active.budget)
      this.#budgets.delete(active.budget.key);
  }

  async #close(): Promise<void> {
    for (const active of [...this.#capabilities.values()]) this.#revoke(active);
    this.#sockets.close();
    if (this.#started) {
      this.#started = false;
      this.#server.close();
      await once(this.#server, "close");
    }
    await this.#dispatcher?.close();
  }
}
