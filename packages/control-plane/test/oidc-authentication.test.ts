import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { OidcAuthenticationService } from "../src/oidc-authentication.ts";
import { WebAuthenticationService } from "../src/web-authentication.ts";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;
let providerServer: Server;
let issuer: string;
let nonce = "";
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

beforeAll(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 2,
  });
  await runMigrations(database, "up");
  const keys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  providerServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", issuer);
    if (url.pathname === "/.well-known/openid-configuration") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          issuer,
          authorization_endpoint: `${issuer}/oauth/authorize`,
          token_endpoint: `${issuer}/oauth/token`,
          userinfo_endpoint: `${issuer}/oauth/userinfo`,
          jwks_uri: `${issuer}/oauth/discovery/keys`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "profile", "email", "read_user"],
        }),
      );
      return;
    }
    if (url.pathname === "/oauth/discovery/keys") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: "test-key", use: "sig" }] }));
      return;
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      const now = Math.floor(Date.now() / 1_000);
      const idToken = await new SignJWT({ nonce })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuer(issuer)
        .setAudience("pi-cloud-test")
        .setSubject("gitlab-user-42")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(privateKey);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          access_token: "oidc-access-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: idToken,
          scope: "openid profile email read_user",
        }),
      );
      return;
    }
    if (url.pathname === "/api/v4/user") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: 42, username: "gitlab-user", name: "GitLab User" }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });
  await new Promise<void>((resolvePromise) =>
    providerServer.listen(0, "127.0.0.1", resolvePromise),
  );
  issuer = `http://127.0.0.1:${String((providerServer.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => providerServer.close(() => resolvePromise()));
  await database.destroy();
  await socket.stop();
  await pglite.close();
});

describe("OIDC Web authentication", () => {
  it("maps one GitLab subject to one internal user and issues a PiCloud session", async () => {
    const tenant = await createPrivateTenant(database, {
      slug: "oidc-enterprise",
      ownerDisplayName: "OIDC Administrator",
    });
    const webAuthentication = new WebAuthenticationService({
      database,
      enabled: false,
      maximumTenants: 10,
      tenantQuotas: { maximumProjects: 10, maximumSessions: 100 },
    });
    const service = new OidcAuthenticationService({
      database,
      webAuthentication,
      publicOrigin: "http://picloud.local/",
      providers: [
        {
          key: "gitlab",
          label: "Company GitLab",
          issuer,
          clientId: "pi-cloud-test",
          clientSecret: "oidc-test-client-secret",
          tenantId: tenant.tenantId,
          defaultRole: "member",
          kind: "gitlab",
          allowInsecureHttp: true,
        },
      ],
    });
    expect(service.configuration()).toMatchObject({
      local: { login: true, registration: false },
      oidc: [{ providerKey: "gitlab", label: "Company GitLab" }],
    });
    const authorization = await service.begin("gitlab");
    const state = authorization.searchParams.get("state")!;
    nonce = authorization.searchParams.get("nonce")!;
    const issued = await service.complete(
      "gitlab",
      `/v1/auth/oidc/gitlab/callback?code=test-code&state=${encodeURIComponent(state)}`,
    );
    expect(issued.resource.identity).toMatchObject({
      tenantId: tenant.tenantId,
      username: "gitlab-user",
      displayName: "GitLab User",
      role: "member",
      authenticationKind: "oidc",
      externalIdentity: {
        providerKey: "gitlab",
        issuer,
        providerUserId: "42",
      },
    });
    await expect(webAuthentication.authenticate(issued.token)).resolves.toMatchObject({
      userId: issued.resource.identity.userId,
      authenticationKind: "oidc",
      externalIdentity: { providerUserId: "42", username: "gitlab-user" },
    });
    const persistedIdentity = await database
      .selectFrom("external_identities")
      .selectAll()
      .where("user_id", "=", issued.resource.identity.userId)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(persistedIdentity)).not.toContain("oidc-access-token");
    await expect(
      service.complete(
        "gitlab",
        `/v1/auth/oidc/gitlab/callback?code=test-code&state=${encodeURIComponent(state)}`,
      ),
    ).rejects.toMatchObject({ code: "oidc_request_invalid" });
  });
});
