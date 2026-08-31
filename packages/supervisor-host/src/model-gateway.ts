import {
  MODEL_SAMPLING_ATTEMPT_HEADER,
  MODEL_STEP_SEQUENCE_HEADER,
  MODEL_STEP_SHA256_HEADER,
  parseExecutionLease,
  parseModelSamplingIdentity,
  type ExecuteTurnCommandMessage,
  type ModelSamplingIdentity,
} from "@pi-cloud/protocol";
import type { TrustedModelRuntimeLease } from "@pi-cloud/sandbox-supervisor";
import { parseTraceCarrier, withSpan, type PiCloudMetrics } from "@pi-cloud/observability";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { zstdDecompressSync } from "node:zlib";

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const CODEX_RESPONSES_PATH = "/codex/responses";
const PROVIDER_RESPONSES_PATH = "/v1/responses";
const MAX_REQUEST_BYTES = 8 * 1_024 * 1_024;
const MAX_DECOMPRESSED_REQUEST_BYTES = 32 * 1_024 * 1_024;
const MAX_RESPONSE_BYTES = 64 * 1_024 * 1_024;

type SupportedModel =
  | Readonly<{
      provider: "deepseek";
      modelId: "deepseek-v4-flash" | "deepseek-v4-pro";
      api: "openai-completions";
      requestPath: typeof CHAT_COMPLETIONS_PATH;
      providerPath: typeof CHAT_COMPLETIONS_PATH;
      baseUrlPath: "/v1";
      contextWindow: number;
      maxTokens: number;
    }>
  | Readonly<{
      provider: "openai-codex";
      modelId: "gpt-5.6-luna" | "gpt-5.6-terra" | "gpt-5.6-sol";
      api: "openai-codex-responses";
      requestPath: typeof CODEX_RESPONSES_PATH;
      providerPath: typeof PROVIDER_RESPONSES_PATH;
      baseUrlPath: "";
      contextWindow: number;
      maxTokens: number;
    }>;

type ActiveCapabilityFields = {
  tokenDigest: string;
  tenantId: string;
  sessionId: string;
  turnId: string;
  runId: string;
  attemptId: string;
  modelProfileId: string;
  expiresAt: number;
  maximumRequestsPerRun: number;
  requestsStarted: number;
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
  capabilityTtlMs?: number;
  maximumRequestsPerTurn?: number;
  upstreamRequestTimeoutMs?: number;
  piRequestTimeoutMs?: number;
  piTurnTimeoutMs?: number;
  fetchImplementation?: typeof fetch;
  clock?: () => Date;
  randomBytes?: (size: number) => Buffer;
  metrics?: PiCloudMetrics;
};

export class TenantModelGatewayError extends Error {
  readonly code:
    | "gateway_not_started"
    | "gateway_already_started"
    | "unsupported_model"
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

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TenantModelGatewayError(
      "invalid_gateway_configuration",
      "Model Gateway clock returned an invalid date",
    );
  }
  return value;
}

function bearerCapability(value: string | undefined): string | undefined {
  return value === undefined
    ? undefined
    : /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43})$/.exec(value)?.[1];
}

function capabilityToken(signature: Buffer, sessionId: string, expiresAt: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", pcmg: 1 }), "utf8").toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "pi-cloud-provider-gateway",
      },
      sid: sessionId,
      exp: Math.floor(expiresAt / 1_000),
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

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new SafeGatewayHttpError(413, "request_too_large", "Model request is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseBody(bytes: Buffer, contentEncoding: string | undefined): Record<string, unknown> {
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

async function writeChunk(response: ServerResponse, chunk: Uint8Array): Promise<void> {
  if (!response.write(chunk)) await once(response, "drain");
}

function supportedModel(provider: string, modelId: string): SupportedModel | undefined {
  if (
    provider === "deepseek" &&
    (modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro")
  ) {
    return {
      provider,
      modelId,
      api: "openai-completions",
      requestPath: CHAT_COMPLETIONS_PATH,
      providerPath: CHAT_COMPLETIONS_PATH,
      baseUrlPath: "/v1",
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
  }
  if (
    provider === "openai-codex" &&
    (modelId === "gpt-5.6-luna" || modelId === "gpt-5.6-terra" || modelId === "gpt-5.6-sol")
  ) {
    return {
      provider,
      modelId,
      api: "openai-codex-responses",
      requestPath: CODEX_RESPONSES_PATH,
      providerPath: PROVIDER_RESPONSES_PATH,
      baseUrlPath: "",
      contextWindow: 272_000,
      maxTokens: 65_536,
    };
  }
  return undefined;
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
  readonly #capabilityTtlMs: number;
  readonly #maximumRequestsPerTurn: number;
  readonly #upstreamRequestTimeoutMs: number;
  readonly #piRequestTimeoutMs: number;
  readonly #piTurnTimeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #clock: () => Date;
  readonly #randomBytes: (size: number) => Buffer;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #server: Server;
  readonly #capabilities = new Map<string, ActiveCapability>();
  #started = false;
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
    this.#capabilityTtlMs = positiveInteger(
      options.capabilityTtlMs ?? 10 * 60_000,
      "capabilityTtlMs",
      60 * 60_000,
    );
    this.#maximumRequestsPerTurn = positiveInteger(
      options.maximumRequestsPerTurn ?? 128,
      "maximumRequestsPerTurn",
      256,
    );
    this.#upstreamRequestTimeoutMs = positiveInteger(
      options.upstreamRequestTimeoutMs ?? 120_000,
      "upstreamRequestTimeoutMs",
      300_000,
    );
    this.#piRequestTimeoutMs = positiveInteger(
      options.piRequestTimeoutMs ?? 150_000,
      "piRequestTimeoutMs",
      300_000,
    );
    this.#piTurnTimeoutMs = positiveInteger(
      options.piTurnTimeoutMs ?? 10 * 60_000,
      "piTurnTimeoutMs",
      15 * 60_000,
    );
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#clock = options.clock ?? (() => new Date());
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
                "pi_cloud.attempt.id": active.attemptId,
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
        () =>
          this.#observe(active, response.statusCode < 400 ? "completed" : "rejected", startedAt),
        (error: unknown) => {
          this.#observe(active, "failed", startedAt);
          if (error instanceof SafeGatewayHttpError) {
            sendJson(response, error.status, {
              error: { code: error.code, message: error.message },
            });
            return;
          }
          sendJson(response, 502, {
            error: { code: "model_gateway_error", message: "Model Gateway request failed" },
          });
        },
      );
    });
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

  issue(command: ExecuteTurnCommandMessage): TrustedModelRuntimeLease {
    if (!this.#started) {
      throw new TenantModelGatewayError("gateway_not_started", "Model Gateway is not listening");
    }
    const model = supportedModel(command.payload.model.provider, command.payload.model.modelId);
    if (model === undefined) {
      throw new TenantModelGatewayError("unsupported_model", "Accepted model is unsupported");
    }
    const random = this.#randomBytes(32);
    if (!Buffer.isBuffer(random) || random.length !== 32) {
      throw new TenantModelGatewayError(
        "invalid_gateway_configuration",
        "Model Gateway capability generation failed",
      );
    }
    const expiresAt = validDate(this.#clock).valueOf() + this.#capabilityTtlMs;
    const capability = capabilityToken(random, command.payload.sessionId, expiresAt);
    const digest = capabilityDigest(capability);
    if (this.#capabilities.has(digest)) {
      throw new TenantModelGatewayError(
        "invalid_gateway_configuration",
        "Model Gateway capability collision occurred",
      );
    }
    const active: ActiveCapability = {
      ...model,
      tokenDigest: digest,
      tenantId: command.payload.tenantId,
      sessionId: command.payload.sessionId,
      turnId: command.payload.turnId,
      runId: command.payload.runId,
      attemptId: parseExecutionLease(command.payload.executionLease).attemptId,
      modelProfileId: command.payload.model.profileId,
      expiresAt,
      maximumRequestsPerRun: Math.min(
        this.#maximumRequestsPerTurn,
        command.payload.budgets?.maximumModelRequests ?? this.#maximumRequestsPerTurn,
      ),
      requestsStarted: 0,
      revoked: false,
      requestControllers: new Set(),
    };
    this.#capabilities.set(digest, active);
    let released = false;
    const runtime =
      active.provider === "deepseek"
        ? ({
            kind: "openai_compatible_gateway",
            provider: active.provider,
            modelId: active.modelId,
            baseUrl: `${this.#advertisedBaseUrl}/v1`,
            api: "openai-completions",
            capability,
            reasoning: true,
            contextWindow: active.contextWindow,
            maxTokens: active.maxTokens,
            requestTimeoutMs: this.#piRequestTimeoutMs,
            turnTimeoutMs: this.#piTurnTimeoutMs,
          } as const)
        : ({
            kind: "openai_compatible_gateway",
            provider: active.provider,
            modelId: active.modelId,
            baseUrl: this.#advertisedBaseUrl,
            api: "openai-codex-responses",
            capability,
            reasoning: true,
            contextWindow: active.contextWindow,
            maxTokens: active.maxTokens,
            requestTimeoutMs: this.#piRequestTimeoutMs,
            turnTimeoutMs: this.#piTurnTimeoutMs,
          } as const);
    return {
      runtime,
      release: () => {
        if (released) return;
        released = true;
        this.#revoke(active);
      },
    };
  }

  async checkProviderHealth(): Promise<void> {
    const response = await this.#fetch(`${this.#providerGatewayBaseUrl}/healthz`, {
      method: "HEAD",
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error("Provider Gateway is unavailable");
  }

  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? "/", "http://model-gateway.invalid").pathname;
    if (request.method === "GET" && path === "/health/live") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST") {
      throw new SafeGatewayHttpError(404, "route_not_found", "Model Gateway route not found");
    }
    const token = bearerCapability(request.headers.authorization);
    const active =
      token === undefined ? undefined : this.#capabilities.get(capabilityDigest(token));
    const now = validDate(this.#clock).valueOf();
    if (active === undefined || active.revoked || active.expiresAt <= now) {
      if (active !== undefined && active.expiresAt <= now) this.#revoke(active);
      throw new SafeGatewayHttpError(
        401,
        "invalid_capability",
        "Model Gateway capability is invalid",
      );
    }
    if (path !== active.requestPath) {
      throw new SafeGatewayHttpError(
        403,
        "model_protocol_mismatch",
        "Model request protocol does not match its Turn capability",
      );
    }
    samplingIdentity(request);
    if (active.requestsStarted >= active.maximumRequestsPerRun) {
      throw new SafeGatewayHttpError(
        429,
        "model_request_limit_exceeded",
        "Model request limit was exceeded",
      );
    }
    const requestBytes = await readBody(request);
    const body = parseBody(requestBytes, request.headers["content-encoding"]);
    if (body.model !== active.modelId) {
      throw new SafeGatewayHttpError(
        403,
        "model_binding_mismatch",
        "Model request does not match its Turn capability",
      );
    }
    if (body.stream !== true) {
      throw new SafeGatewayHttpError(
        400,
        "streaming_required",
        "Model Gateway requires a streaming request",
      );
    }
    active.requestsStarted += 1;

    const controller = new AbortController();
    let timedOut = false;
    let disconnected = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#upstreamRequestTimeoutMs);
    timeout.unref();
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
    try {
      const upstream = await this.#fetch(`${this.#providerGatewayBaseUrl}${active.providerPath}`, {
        method: "POST",
        headers: upstreamHeaders(request, active, this.#providerGatewayApiKey),
        body: new Uint8Array(requestBytes),
        signal: controller.signal,
      });
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
        response.end();
        return;
      }
      let responseBytes = 0;
      for await (const rawChunk of upstream.body) {
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
        await writeChunk(response, chunk);
      }
      response.end();
    } catch (error: unknown) {
      if (error instanceof SafeGatewayHttpError) throw error;
      throw new SafeGatewayHttpError(
        timedOut ? 504 : 502,
        disconnected
          ? "downstream_disconnected"
          : timedOut
            ? "provider_gateway_timeout"
            : "provider_gateway_unavailable",
        timedOut ? "Provider Gateway timed out" : "Provider Gateway request failed",
      );
    } finally {
      clearTimeout(timeout);
      request.off("aborted", abortOnRequest);
      response.off("close", abortOnResponse);
      active.requestControllers.delete(controller);
    }
  }

  #observe(
    active: ActiveCapability | undefined,
    outcome: "completed" | "rejected" | "failed",
    startedAt: number,
  ): void {
    if (active === undefined) return;
    this.#metrics?.modelDuration.observe(
      { provider: active.provider, model: active.modelId, outcome },
      (performance.now() - startedAt) / 1_000,
    );
  }

  #revoke(active: ActiveCapability): void {
    if (active.revoked) return;
    active.revoked = true;
    for (const controller of active.requestControllers) controller.abort();
    active.requestControllers.clear();
    this.#capabilities.delete(active.tokenDigest);
  }

  async #close(): Promise<void> {
    for (const active of [...this.#capabilities.values()]) this.#revoke(active);
    if (!this.#started) return;
    this.#started = false;
    this.#server.close();
    await once(this.#server, "close");
  }
}
