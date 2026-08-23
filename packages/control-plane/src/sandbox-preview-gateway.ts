import type { Database } from "@pi-cloud/database";
import {
  TOOL_BROKER_SANDBOX_PREVIEW_PATH,
  SANDBOX_PREVIEW_MAXIMUM_PORT,
  SANDBOX_PREVIEW_MINIMUM_PORT,
  SANDBOX_TRUSTED_TOOL_SERVICE_PORT,
  parseSandboxPreviewResponse,
  parseUuidPathParameter,
  type SandboxPreviewRequest,
  type SandboxPreviewTarget,
} from "@pi-cloud/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { tenantRequestIdentity } from "./tenant-identity.ts";

export const CONVERSATION_PREVIEW_PATH = "/v1/conversations/:sessionId/preview/:port/*";
export const DEVELOPMENT_ENVIRONMENT_PREVIEW_PATH =
  "/v1/development-environments/:environmentId/preview/:port/*";

const MAXIMUM_REDIRECTS = 3;
const MAXIMUM_REQUEST_BYTES = 4 * 1_024 * 1_024;
const PREVIEW_ACCESS_SEGMENT = "__pi_cloud_access__";
const PREVIEW_ACCESS_TTL_MS = 15 * 60 * 1_000;
const PREVIEW_ACCESS_PATTERN = /^pcpa_([A-Za-z0-9_-]{32,1024})\.([A-Za-z0-9_-]{43})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATH_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PREVIEW_ACCESS_PATH_PATTERN = new RegExp(
  `^/v1/(?:conversations|development-environments)/${UUID_PATH_SOURCE}/preview/[0-9]{4,5}/${PREVIEW_ACCESS_SEGMENT}/pcpa_[A-Za-z0-9_-]{32,1024}\\.[A-Za-z0-9_-]{43}(?:/|$)`,
  "i",
);

export type SandboxPreviewGatewayOptions = Readonly<{
  database: Kysely<Database>;
  previewToken: string;
  allowInsecureInternalHttp: boolean;
}>;

function previewPort(value: unknown): SandboxPreviewRequest["port"] {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < SANDBOX_PREVIEW_MINIMUM_PORT ||
    parsed > SANDBOX_PREVIEW_MAXIMUM_PORT ||
    parsed === SANDBOX_TRUSTED_TOOL_SERVICE_PORT
  ) {
    throw new Error("Preview port is outside the application port range");
  }
  return parsed as SandboxPreviewRequest["port"];
}

function requestBody(request: FastifyRequest): Buffer | undefined {
  if (request.body === undefined || request.body === null) return undefined;
  const body = Buffer.isBuffer(request.body)
    ? request.body
    : Buffer.from(
        typeof request.body === "string" ? request.body : JSON.stringify(request.body),
        "utf8",
      );
  if (body.byteLength > MAXIMUM_REQUEST_BYTES) throw new Error("Preview request body is too large");
  return body;
}

function requestHeaders(request: FastifyRequest): Readonly<Record<string, string>> {
  const allowed = new Set([
    "accept",
    "accept-language",
    "content-type",
    "if-modified-since",
    "if-none-match",
    "range",
    "user-agent",
  ]);
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(request.headers)) {
    if (!allowed.has(name.toLowerCase()) || typeof raw !== "string") continue;
    headers[name.toLowerCase()] = raw.slice(0, 8_192);
  }
  return Object.freeze(headers);
}

function publicPrefix(target: SandboxPreviewTarget, port: number): string {
  return target.kind === "conversation"
    ? `/v1/conversations/${encodeURIComponent(target.sessionId)}/preview/${String(port)}`
    : `/v1/development-environments/${encodeURIComponent(target.environmentId)}/preview/${String(port)}`;
}

type PreviewAccessClaims = Readonly<{
  tenantId: string;
  userId: string;
  target: SandboxPreviewTarget;
  port: number;
  expiresAt: number;
}>;

function previewAccessPayload(claims: PreviewAccessClaims): string {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      tenantId: claims.tenantId,
      userId: claims.userId,
      targetKind: claims.target.kind,
      targetId:
        claims.target.kind === "conversation"
          ? claims.target.sessionId
          : claims.target.environmentId,
      port: claims.port,
      expiresAt: claims.expiresAt,
    }),
    "utf8",
  ).toString("base64url");
}

export function issuePreviewAccessToken(
  secret: string,
  claims: Omit<PreviewAccessClaims, "expiresAt">,
  now = Date.now(),
): string {
  const payload = previewAccessPayload({ ...claims, expiresAt: now + PREVIEW_ACCESS_TTL_MS });
  const signature = createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
  return `pcpa_${payload}.${signature}`;
}

export function verifyPreviewAccessToken(
  secret: string,
  token: string,
  expectedTarget: SandboxPreviewTarget,
  expectedPort: number,
  now = Date.now(),
): Readonly<{ tenantId: string; userId: string }> | undefined {
  const match = PREVIEW_ACCESS_PATTERN.exec(token);
  if (match === null) return undefined;
  const payload = match[1]!;
  const candidate = Buffer.from(match[2]!, "base64url");
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest();
  if (candidate.byteLength !== expected.byteLength || !timingSafeEqual(candidate, expected)) {
    return undefined;
  }
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const expectedTargetId =
      expectedTarget.kind === "conversation"
        ? expectedTarget.sessionId
        : expectedTarget.environmentId;
    if (
      claims.version !== 1 ||
      typeof claims.tenantId !== "string" ||
      !UUID_PATTERN.test(claims.tenantId) ||
      typeof claims.userId !== "string" ||
      !UUID_PATTERN.test(claims.userId) ||
      claims.targetKind !== expectedTarget.kind ||
      claims.targetId !== expectedTargetId ||
      claims.port !== expectedPort ||
      !Number.isSafeInteger(claims.expiresAt) ||
      (claims.expiresAt as number) <= now ||
      (claims.expiresAt as number) > now + PREVIEW_ACCESS_TTL_MS
    ) {
      return undefined;
    }
    return { tenantId: claims.tenantId, userId: claims.userId };
  } catch {
    return undefined;
  }
}

function previewAccessRoute(
  suffix: string,
): Readonly<{ token: string; upstreamSuffix: string }> | undefined {
  const parts = suffix.split("/");
  if (parts[0] !== PREVIEW_ACCESS_SEGMENT) return undefined;
  return {
    token: parts[1] ?? "",
    upstreamSuffix: parts.slice(2).join("/"),
  };
}

export function isPreviewAccessPath(path: string): boolean {
  return path.length <= 2_048 && PREVIEW_ACCESS_PATH_PATTERN.test(path);
}

export function rewritePreviewHtml(body: Buffer, prefix: string, nonce: string): Buffer {
  if (body.byteLength > 4 * 1_024 * 1_024) return body;
  const html = body.toString("utf8");
  if (!/<(?:html|head)[\s>]/iu.test(html)) return body;
  const base = `<base href="${prefix}/">`;
  const rewritten = html
    .replace(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)([^>]*)>/giu, `<script nonce="${nonce}"$1>`)
    .replace(/<style(?![^>]*\bnonce=)([^>]*)>/giu, `<style nonce="${nonce}"$1>`);
  return Buffer.from(
    /<head[\s>]/iu.test(rewritten)
      ? rewritten.replace(/(<head[^>]*>)/iu, `$1${base}`)
      : `${base}${rewritten}`,
    "utf8",
  );
}

export function previewSecurityHeaders(nonce: string): Readonly<Record<string, string>> {
  return Object.freeze({
    "content-security-policy":
      "sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads; " +
      `default-src 'self' data: blob:; script-src 'self' 'nonce-${nonce}' blob:; ` +
      `style-src 'self' 'nonce-${nonce}' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`,
    // CSP sandbox deliberately gives the application document an opaque
    // origin. Its authenticated CSS/JS therefore cannot satisfy `same-origin`
    // CORP even though their public URLs share the PiCloud host. Cross-site
    // callers still receive 401 because browser auth cookies are SameSite.
    "cross-origin-resource-policy": "cross-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

export class SandboxPreviewGateway {
  readonly #database: Kysely<Database>;
  readonly #previewToken: string;
  readonly #allowInsecureInternalHttp: boolean;
  #installed = false;

  constructor(options: SandboxPreviewGatewayOptions) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/.test(options.previewToken)) {
      throw new TypeError("Sandbox preview gateway token is invalid");
    }
    this.#database = options.database;
    this.#previewToken = options.previewToken;
    this.#allowInsecureInternalHttp = options.allowInsecureInternalHttp;
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("Sandbox preview gateway is already installed");
    this.#installed = true;
    fastify.register(async (scope) => {
      scope.all(CONVERSATION_PREVIEW_PATH, (request, reply) =>
        this.#handle(request, reply, "conversation"),
      );
      scope.all(DEVELOPMENT_ENVIRONMENT_PREVIEW_PATH, (request, reply) =>
        this.#handle(request, reply, "development_environment"),
      );
    });
  }

  async #handle(
    request: FastifyRequest,
    reply: FastifyReply,
    kind: SandboxPreviewTarget["kind"],
  ): Promise<void> {
    const browserIdentity = tenantRequestIdentity(request);
    try {
      const params = request.params as Record<string, unknown>;
      const target: SandboxPreviewTarget =
        kind === "conversation"
          ? {
              kind,
              sessionId: parseUuidPathParameter(params.sessionId, "sessionId"),
            }
          : {
              kind,
              environmentId: parseUuidPathParameter(params.environmentId, "environmentId"),
            };
      const port = previewPort(params.port);
      const rawSuffix = typeof params["*"] === "string" ? params["*"] : "";
      const accessRoute = previewAccessRoute(rawSuffix);
      let tenantId: string;
      let userId: string;
      let accessToken: string;
      let suffix: string;
      if (accessRoute !== undefined) {
        const access = verifyPreviewAccessToken(
          this.#previewToken,
          accessRoute.token,
          target,
          port,
        );
        if (access === undefined) {
          await reply.code(401).send({ error: "preview_access_invalid" });
          return;
        }
        tenantId = access.tenantId;
        userId = access.userId;
        accessToken = accessRoute.token;
        suffix = accessRoute.upstreamSuffix;
      } else {
        if (browserIdentity === undefined) {
          await reply.code(401).send({ error: "authentication_required" });
          return;
        }
        tenantId = browserIdentity.tenantId;
        userId = browserIdentity.userId;
        accessToken = issuePreviewAccessToken(this.#previewToken, {
          tenantId,
          userId,
          target,
          port,
        });
        suffix = rawSuffix;
      }
      const forwardedTarget =
        target.kind === "conversation"
          ? await this.#conversationPreviewTarget(tenantId, userId, target)
          : target;
      const search = new URL(request.raw.url ?? "/", "http://pi-cloud.local").search;
      const method = request.method as SandboxPreviewRequest["method"];
      if (!new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]).has(method)) {
        throw new Error("Preview HTTP method is unsupported");
      }
      const baseUrl = await this.#resolveBaseUrl(tenantId, userId, forwardedTarget);
      const body = requestBody(request);
      const response = await this.#forward(baseUrl, 0, {
        sandboxPreviewProtocolVersion: 1,
        type: "sandbox_preview.request",
        requestId: randomUUID(),
        tenantId,
        userId,
        target: forwardedTarget,
        port,
        method,
        path: `/${suffix}${search}`,
        headers: requestHeaders(request),
        ...(body === undefined ? {} : { body: body.toString("base64") }),
      });
      if (response.type !== "sandbox_preview.response") {
        throw new Error("Preview owner redirect did not resolve");
      }
      const prefix = publicPrefix(target, port);
      const accessPrefix = `${prefix}/${PREVIEW_ACCESS_SEGMENT}/${accessToken}`;
      const previewNonce = randomBytes(18).toString("base64");
      for (const [name, value] of Object.entries(response.headers)) {
        if (name === "content-encoding" || name === "content-length") continue;
        reply.header(
          name,
          name === "location" && value.startsWith("/") ? `${accessPrefix}${value}` : value,
        );
      }
      reply.header("cache-control", "no-store");
      for (const [name, value] of Object.entries(previewSecurityHeaders(previewNonce))) {
        reply.header(name, value);
      }
      let responseBody: Uint8Array = Buffer.from(response.body, "base64");
      if ((response.headers["content-type"] ?? "").toLowerCase().includes("text/html")) {
        responseBody = rewritePreviewHtml(Buffer.from(responseBody), accessPrefix, previewNonce);
      }
      await reply
        .code(response.status)
        .send(method === "HEAD" ? undefined : Buffer.from(responseBody));
    } catch (error: unknown) {
      request.log.warn({ err: error }, "Sandbox preview request failed");
      await reply.code(503).send({
        error: "sandbox_preview_unavailable",
        message: "Sandbox service is not currently reachable",
      });
    }
  }

  async #conversationPreviewTarget(
    tenantId: string,
    userId: string,
    target: Extract<SandboxPreviewTarget, { kind: "conversation" }>,
  ): Promise<SandboxPreviewTarget> {
    const environment = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("development_environments as development", (join) =>
        join
          .onRef("development.tenant_id", "=", "session_row.tenant_id")
          .onRef("development.workspace_id", "=", "session_row.workspace_id"),
      )
      .select("development.id")
      .where("session_row.tenant_id", "=", tenantId)
      .where("session_row.id", "=", target.sessionId)
      .where("session_row.archived_at", "is", null)
      .where("session_row.sandbox_retention_policy", "=", "persistent")
      .where("development.owner_user_id", "=", userId)
      .where("development.state", "=", "running")
      .orderBy("development.updated_at", "desc")
      .executeTakeFirst();
    return environment === undefined
      ? target
      : { kind: "development_environment", environmentId: environment.id };
  }

  async #resolveBaseUrl(
    tenantId: string,
    userId: string,
    target: SandboxPreviewTarget,
  ): Promise<string> {
    if (target.kind === "development_environment") {
      const row = await this.#database
        .selectFrom("development_environments as development")
        .innerJoin("sandbox_domains as domain", "domain.id", "development.sandbox_domain_id")
        .select([
          "development.owner_base_url as ownerBaseUrl",
          "domain.tool_broker_base_url as fallbackBaseUrl",
        ])
        .where("development.tenant_id", "=", tenantId)
        .where("development.owner_user_id", "=", userId)
        .where("development.id", "=", target.environmentId)
        .where("development.state", "=", "running")
        .executeTakeFirst();
      if (row === undefined) throw new Error("Development environment preview is unavailable");
      return row.ownerBaseUrl ?? row.fallbackBaseUrl;
    }
    const row = await this.#database
      .selectFrom("sessions as session_row")
      .innerJoin("workspaces as workspace", (join) =>
        join
          .onRef("workspace.tenant_id", "=", "session_row.tenant_id")
          .onRef("workspace.id", "=", "session_row.workspace_id"),
      )
      .innerJoin("sandbox_domains as domain", "domain.id", "workspace.sandbox_domain_id")
      .leftJoin("tool_broker_activations as activation", (join) =>
        join
          .onRef("activation.tenant_id", "=", "session_row.tenant_id")
          .onRef("activation.session_id", "=", "session_row.id")
          .on("activation.state", "in", ["materializing", "active", "warm", "cleaning"]),
      )
      .select([
        "activation.owner_base_url as ownerBaseUrl",
        "domain.tool_broker_base_url as fallbackBaseUrl",
      ])
      .where("session_row.tenant_id", "=", tenantId)
      .where("session_row.id", "=", target.sessionId)
      .where("session_row.archived_at", "is", null)
      .orderBy("activation.updated_at", "desc")
      .executeTakeFirst();
    if (row === undefined) throw new Error("Conversation preview is unavailable");
    return row.ownerBaseUrl ?? row.fallbackBaseUrl;
  }

  async #forward(
    baseUrl: string,
    redirects: number,
    message: SandboxPreviewRequest,
  ): Promise<ReturnType<typeof parseSandboxPreviewResponse>> {
    if (redirects > MAXIMUM_REDIRECTS) throw new Error("Too many Tool Broker redirects");
    const target = new URL(TOOL_BROKER_SANDBOX_PREVIEW_PATH, baseUrl);
    if (target.protocol === "http:" && !this.#allowInsecureInternalHttp) {
      throw new Error("Insecure Tool Broker preview URL was rejected");
    }
    const response = await fetch(target, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.#previewToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(70_000),
    });
    const parsed = parseSandboxPreviewResponse(await response.json());
    if (parsed.type === "sandbox_preview.owner_redirect") {
      return this.#forward(parsed.ownerBaseUrl, redirects + 1, message);
    }
    return parsed;
  }
}
