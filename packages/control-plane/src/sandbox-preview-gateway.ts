import type { Database } from "@pi-cloud/database";
import {
  PREVIEW_ACCESS_TTL_MS,
  parseSandboxPreviewConnection,
  parseUuidPathParameter,
  type SandboxPreviewTarget,
  type SandboxPreviewConnectionRequest,
} from "@pi-cloud/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { createProxyServer } from "httpxy";
import { tenantRequestIdentity } from "./tenant-identity.ts";
import { previewConnectionAgent } from "./preview-connect.ts";

export const CONVERSATION_PREVIEW_PATH = "/v1/conversations/:sessionId/preview/:port/*";
export const DEVELOPMENT_ENVIRONMENT_PREVIEW_PATH =
  "/v1/development-environments/:environmentId/preview/:port/*";
export const PREVIEW_COOKIE = "pi_cloud_preview";
export const PREVIEW_BOOTSTRAP_PATH = "/__pi_cloud_preview_auth";
export type SandboxPreviewGatewayOptions = Readonly<{
  database: Kysely<Database>;
  previewToken: string;
  publicOriginBaseUrl: string;
  allowInsecureInternalHttp: boolean;
  listenHost?: string;
  listenPort?: number;
}>;

export function previewOriginHostname(
  secret: string,
  baseHostname: string,
  target: SandboxPreviewTarget,
  port: number,
  workspaceId: string,
): string {
  const id = target.kind === "conversation" ? target.sessionId : target.environmentId;
  const hash = createHmac("sha256", secret)
    .update([target.kind, id, String(port), workspaceId].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `p-${hash}.${baseHostname}`;
}
export function issuePreviewAccessToken(
  secret: string,
  scope: Omit<SandboxPreviewConnectionRequest, "expiresAt">,
  now = Date.now(),
): string {
  const payload = Buffer.from(
    JSON.stringify({ ...scope, expiresAt: now + PREVIEW_ACCESS_TTL_MS }),
  ).toString("base64url");
  return `pcpa_${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function verifyPreviewAccessToken(
  secret: string,
  token: string,
  now = Date.now(),
): SandboxPreviewConnectionRequest | undefined {
  const match = /^pcpa_([A-Za-z0-9_-]{32,2048})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) return undefined;
  const signature = Buffer.from(match[2]!, "base64url");
  const expected = createHmac("sha256", secret).update(match[1]!).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
    return undefined;
  try {
    const scope = parseSandboxPreviewConnection(
      JSON.parse(Buffer.from(match[1]!, "base64url").toString()),
    );
    return scope.expiresAt > now && scope.expiresAt <= now + PREVIEW_ACCESS_TTL_MS
      ? scope
      : undefined;
  } catch {
    return undefined;
  }
}
export function previewCookie(token: string, expiresAt: number, secure: boolean): string {
  return `${PREVIEW_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${new Date(expiresAt).toUTCString()}${secure ? "; Secure" : ""}`;
}
export function stripPreviewCookie(header: string | undefined): string | undefined {
  const value = header
    ?.split(";")
    .filter((part) => ![PREVIEW_COOKIE, "pi_cloud_session"].includes(part.trim().split("=")[0]!))
    .join(";")
    .trim();
  return value || undefined;
}
export function previewSecurityHeaders(origin: string): Record<string, string> {
  const websocket = new URL(origin);
  websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
  return {
    "content-security-policy": `sandbox allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:; style-src 'self' 'unsafe-inline' https:; font-src 'self' data: https:; img-src 'self' data: blob: https:; connect-src 'self' ${websocket.origin}; form-action 'self'; base-uri 'self'; frame-ancestors 'none'`,
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}
function applicationPath(value: string): string {
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\r\n]/.test(value)
  )
    throw new Error("Invalid application path");
  return value;
}
function fail(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(message);
}

export class SandboxPreviewGateway {
  readonly #database: Kysely<Database>;
  readonly #previewToken: string;
  readonly #publicOriginBaseUrl: URL;
  readonly #allowInsecureInternalHttp: boolean;
  readonly #options: SandboxPreviewGatewayOptions;
  readonly #sockets = new Set<Socket>();
  readonly #origins = new WeakMap<IncomingMessage, string>();
  readonly #proxy = createProxyServer({
    xfwd: true,
    changeOrigin: true,
    prependPath: false,
    cookieDomainRewrite: "",
    proxyTimeout: 0,
  });
  readonly #server = createServer((request, response) => {
    void this.#serve(request, response);
  });
  #installed = false;

  constructor(options: SandboxPreviewGatewayOptions) {
    this.#options = options;
    this.#database = options.database;
    this.#previewToken = options.previewToken;
    this.#publicOriginBaseUrl = new URL(options.publicOriginBaseUrl);
    this.#allowInsecureInternalHttp = options.allowInsecureInternalHttp;
    if (
      !["http:", "https:"].includes(this.#publicOriginBaseUrl.protocol) ||
      this.#publicOriginBaseUrl.username ||
      this.#publicOriginBaseUrl.password
    )
      throw new Error("Invalid preview origin");
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.once("close", () => this.#sockets.delete(socket));
    });
    this.#server.on("upgrade", (request, socket, head) => {
      void this.#upgrade(request, socket as Socket, head);
    });
    this.#proxy.on("proxyRes", (response, request) => {
      const origin = this.#origins.get(request);
      if (origin) Object.assign(response.headers, previewSecurityHeaders(origin));
      const cookies = response.headers["set-cookie"];
      if (cookies)
        response.headers["set-cookie"] = cookies
          .filter(
            (cookie) =>
              ![PREVIEW_COOKIE, "pi_cloud_session"].includes(cookie.split("=")[0]!.trim()),
          )
          .map((cookie) => cookie.replace(/;\s*domain=[^;]*/gi, ""));
    });
  }
  get address(): string | undefined {
    const address = this.#server.address();
    return address && typeof address !== "string" ? `http://127.0.0.1:${address.port}` : undefined;
  }
  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("Preview gateway already installed");
    this.#installed = true;
    fastify.get(CONVERSATION_PREVIEW_PATH, (request, reply) =>
      this.#bootstrap(request, reply, "conversation"),
    );
    fastify.get(DEVELOPMENT_ENVIRONMENT_PREVIEW_PATH, (request, reply) =>
      this.#bootstrap(request, reply, "development_environment"),
    );
    fastify.addHook(
      "onReady",
      () =>
        new Promise<void>((resolve, reject) => {
          this.#server.once("error", reject);
          this.#server.listen(
            this.#options.listenPort ?? 0,
            this.#options.listenHost ?? "127.0.0.1",
            () => resolve(),
          );
        }),
    );
    fastify.addHook("onClose", () => this.close());
  }
  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    if (this.#server.listening)
      await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
  async #bootstrap(
    request: FastifyRequest,
    reply: FastifyReply,
    kind: SandboxPreviewTarget["kind"],
  ): Promise<void> {
    const identity = tenantRequestIdentity(request);
    if (!identity) {
      await reply.code(401).send({ error: "authentication_required" });
      return;
    }
    try {
      const params = request.params as Record<string, unknown>;
      const requested: SandboxPreviewTarget =
        kind === "conversation"
          ? { kind, sessionId: parseUuidPathParameter(params.sessionId, "sessionId") }
          : { kind, environmentId: parseUuidPathParameter(params.environmentId, "environmentId") };
      const target =
        requested.kind === "conversation"
          ? await this.#conversationPreviewTarget(identity.tenantId, identity.userId, requested)
          : requested;
      const workspaceId = await this.#workspaceBinding(identity.tenantId, identity.userId, target);
      const scope = {
        tenantId: identity.tenantId,
        userId: identity.userId,
        target,
        workspaceId,
        port: Number(params.port),
      };
      const token = issuePreviewAccessToken(this.#previewToken, scope);
      if (!verifyPreviewAccessToken(this.#previewToken, token))
        throw new Error("Invalid preview port");
      const next = new URL(this.#publicOriginBaseUrl);
      next.hostname = previewOriginHostname(
        this.#previewToken,
        next.hostname,
        target,
        scope.port,
        workspaceId,
      );
      next.pathname = PREVIEW_BOOTSTRAP_PATH;
      const search = new URL(request.raw.url ?? "/", "http://localhost").search;
      next.searchParams.set("ticket", token);
      next.searchParams.set("path", applicationPath(`/${String(params["*"] ?? "")}${search}`));
      await reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .redirect(next.toString(), 307);
    } catch {
      await reply.code(503).send({
        error: "sandbox_preview_unavailable",
        message: "Sandbox service is not currently reachable",
      });
    }
  }
  #origin(request: IncomingMessage): string {
    const raw = request.headers.host ?? "";
    const expected = new URL(`${this.#publicOriginBaseUrl.protocol}//${raw}/`);
    if (expected.host !== raw || expected.pathname !== "/") throw new Error("Invalid preview host");
    return expected.origin;
  }
  #scope(request: IncomingMessage, ticket?: string): SandboxPreviewConnectionRequest {
    const tokens =
      request.headers.cookie
        ?.split(";")
        .map((v) => v.trim())
        .filter((v) => v.startsWith(PREVIEW_COOKIE + "=")) ?? [];
    const token =
      ticket ?? (tokens.length === 1 ? tokens[0]!.slice(PREVIEW_COOKIE.length + 1) : "");
    const scope = verifyPreviewAccessToken(this.#previewToken, token);
    if (!scope)
      throw new Error("Preview access expired or missing. Reopen the application from PiCloud.");
    const origin = new URL(this.#origin(request));
    if (
      origin.hostname !==
      previewOriginHostname(
        this.#previewToken,
        this.#publicOriginBaseUrl.hostname,
        scope.target,
        scope.port,
        scope.workspaceId,
      )
    )
      throw new Error("Preview origin mismatch");
    if (request.headers.origin && request.headers.origin !== origin.origin)
      throw new Error("Cross-origin preview access rejected");
    return scope;
  }
  async #authorizedOwner(scope: SandboxPreviewConnectionRequest): Promise<string> {
    if (
      (await this.#workspaceBinding(scope.tenantId, scope.userId, scope.target)) !==
      scope.workspaceId
    )
      throw new Error("Preview workspace changed");
    return this.#resolveBaseUrl(scope.tenantId, scope.userId, scope.target);
  }
  #prepare(request: IncomingMessage, scope: SandboxPreviewConnectionRequest): void {
    const origin = this.#origin(request);
    this.#origins.set(request, origin);
    const cookie = stripPreviewCookie(request.headers.cookie);
    for (const key of Object.keys(request.headers)) {
      if (
        key.startsWith("x-pi-cloud-") ||
        key.startsWith("x-forwarded-") ||
        key.startsWith("cube-") ||
        key.startsWith("e2b-") ||
        key === "forwarded"
      )
        delete request.headers[key];
    }
    if (cookie) request.headers.cookie = cookie;
    else delete request.headers.cookie;
    request.headers["x-forwarded-host"] = new URL(origin).host;
    request.headers["x-forwarded-proto"] = this.#publicOriginBaseUrl.protocol.slice(0, -1);
    if (request.headers.origin) request.headers.origin = `http://localhost:${scope.port}`;
  }
  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(applicationPath(request.url ?? "/"), this.#origin(request));
      if (url.pathname === PREVIEW_BOOTSTRAP_PATH) {
        if (request.method !== "GET") {
          fail(response, 405, "Method not allowed");
          return;
        }
        const ticket = url.searchParams.get("ticket") ?? "";
        const scope = this.#scope(request, ticket);
        await this.#authorizedOwner(scope);
        response.writeHead(303, {
          "set-cookie": previewCookie(
            ticket,
            scope.expiresAt,
            this.#publicOriginBaseUrl.protocol === "https:",
          ),
          location: applicationPath(url.searchParams.get("path") ?? "/"),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        });
        response.end();
        return;
      }
      let scope: SandboxPreviewConnectionRequest;
      try {
        scope = this.#scope(request);
      } catch {
        fail(
          response,
          401,
          "Preview access expired or invalid. Reopen the application from PiCloud.",
        );
        return;
      }
      const owner = await this.#authorizedOwner(scope);
      const agent = previewConnectionAgent(
        owner,
        this.#previewToken,
        scope,
        this.#allowInsecureInternalHttp,
      );
      response.once("close", () => agent.destroy());
      this.#prepare(request, scope);
      await this.#proxy.web(request, response, {
        target: `http://localhost:${scope.port}`,
        agent,
        autoRewrite: true,
        protocolRewrite: this.#publicOriginBaseUrl.protocol.slice(0, -1),
      });
    } catch {
      fail(response, 502, "Sandbox application is not reachable");
    }
  }
  async #upgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    socket.on("error", () => socket.destroy());
    try {
      applicationPath(request.url ?? "/");
      const scope = this.#scope(request);
      const owner = await this.#authorizedOwner(scope);
      const agent = previewConnectionAgent(
        owner,
        this.#previewToken,
        scope,
        this.#allowInsecureInternalHttp,
      );
      socket.once("close", () => agent.destroy());
      this.#prepare(request, scope);
      await this.#proxy.ws(
        request,
        socket,
        { target: `http://localhost:${scope.port}`, agent },
        head,
      );
    } catch {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  }
  async #workspaceBinding(
    tenantId: string,
    userId: string,
    target: SandboxPreviewTarget,
  ): Promise<string> {
    const row =
      target.kind === "development_environment"
        ? await this.#database
            .selectFrom("development_environments")
            .select("workspace_id")
            .where("id", "=", target.environmentId)
            .where("tenant_id", "=", tenantId)
            .where("owner_user_id", "=", userId)
            .where("state", "=", "running")
            .executeTakeFirst()
        : await this.#database
            .selectFrom("sessions as s")
            .innerJoin("workspaces as w", "w.id", "s.workspace_id")
            .select("s.workspace_id")
            .where("s.id", "=", target.sessionId)
            .where("s.tenant_id", "=", tenantId)
            .where("s.created_by_user_id", "=", userId)
            .where("s.archived_at", "is", null)
            .where("w.deleted_at", "is", null)
            .executeTakeFirst();
    if (!row) throw new Error("Preview resource unavailable");
    return row.workspace_id;
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
      .where("session_row.execution_mode", "=", "development_environment")
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
      .leftJoin("sandbox_http_services as service", (join) =>
        join
          .onRef("service.tenant_id", "=", "session_row.tenant_id")
          .onRef("service.session_id", "=", "session_row.id")
          .on("service.target_kind", "=", "conversation")
          .on("service.state", "=", "active"),
      )
      .leftJoin("tool_broker_workspace_runtimes as runtime", (join) =>
        join
          .onRef("runtime.tenant_id", "=", "service.tenant_id")
          .onRef("runtime.workspace_id", "=", "service.workspace_id")
          .onRef("runtime.runtime_id", "=", "service.runtime_id")
          .on("runtime.state", "in", ["materializing", "active", "warm", "cleaning"]),
      )
      .select([
        "runtime.owner_base_url as ownerBaseUrl",
        "domain.tool_broker_base_url as fallbackBaseUrl",
      ])
      .where("session_row.tenant_id", "=", tenantId)
      .where("session_row.id", "=", target.sessionId)
      .where("session_row.archived_at", "is", null)
      .orderBy("service.last_seen_at", "desc")
      .executeTakeFirst();
    if (row === undefined) throw new Error("Conversation preview is unavailable");
    return row.ownerBaseUrl ?? row.fallbackBaseUrl;
  }
}
