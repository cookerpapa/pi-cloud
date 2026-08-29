import type { Database, TenantApiCredentialRole } from "@pi-cloud/database";
import type { AuthenticationConfigurationResource } from "@pi-cloud/protocol";
import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import * as oidc from "openid-client";
import type { TenantRequestIdentity } from "./tenant-identity.ts";
import { WebAuthenticationService, type IssuedWebSession } from "./web-authentication.ts";

const REQUEST_TTL_MS = 10 * 60_000;

export type OidcIdentityProvider = Readonly<{
  key: string;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  tenantId: string;
  defaultRole: Exclude<TenantApiCredentialRole, "owner">;
  kind: "gitlab";
  allowInsecureHttp?: boolean;
  fetch?: typeof fetch;
}>;

export class OidcAuthenticationError extends Error {
  readonly code:
    | "oidc_provider_unavailable"
    | "oidc_request_invalid"
    | "oidc_identity_invalid"
    | "oidc_tenant_unavailable";

  constructor(code: OidcAuthenticationError["code"], message: string) {
    super(message);
    this.name = "OidcAuthenticationError";
    this.code = code;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalIssuer(value: string, allowInsecure: boolean): string {
  const issuer = new URL(value);
  if (
    (issuer.protocol !== "https:" && issuer.protocol !== "http:") ||
    issuer.username ||
    issuer.password ||
    issuer.pathname !== "/" ||
    issuer.search ||
    issuer.hash ||
    (issuer.protocol === "http:" && !allowInsecure)
  ) {
    throw new TypeError("OIDC issuer is invalid");
  }
  return issuer.origin;
}

function providerKey(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(value)) throw new TypeError("OIDC provider key is invalid");
  return value;
}

function bounded(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new OidcAuthenticationError("oidc_identity_invalid", `${label} is invalid`);
  }
  return value;
}

function profileRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OidcAuthenticationError("oidc_identity_invalid", "OIDC profile is invalid");
  }
  return value as Record<string, unknown>;
}

export class OidcAuthenticationService {
  readonly #database: Kysely<Database>;
  readonly #webAuthentication: WebAuthenticationService;
  readonly #providers: Map<string, OidcIdentityProvider>;
  readonly #publicOrigin: string;
  readonly #clock: () => Date;
  readonly #id: () => string;
  readonly #configurations = new Map<string, Promise<oidc.Configuration>>();

  constructor(options: {
    database: Kysely<Database>;
    webAuthentication: WebAuthenticationService;
    providers?: readonly OidcIdentityProvider[];
    publicOrigin: string;
    clock?: () => Date;
    idGenerator?: () => string;
  }) {
    this.#database = options.database;
    this.#webAuthentication = options.webAuthentication;
    const origin = new URL(options.publicOrigin);
    if (
      (origin.protocol !== "https:" && origin.protocol !== "http:") ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash
    ) {
      throw new TypeError("OIDC public origin is invalid");
    }
    this.#publicOrigin = origin.origin;
    this.#clock = options.clock ?? (() => new Date());
    this.#id = options.idGenerator ?? randomUUID;
    const providers = (options.providers ?? []).map((candidate): OidcIdentityProvider => ({
      ...candidate,
      key: providerKey(candidate.key),
      issuer: canonicalIssuer(candidate.issuer, candidate.allowInsecureHttp ?? false),
    }));
    if (new Set(providers.map((provider) => provider.key)).size !== providers.length) {
      throw new TypeError("OIDC provider keys must be unique");
    }
    this.#providers = new Map(providers.map((provider) => [provider.key, provider]));
  }

  configuration(): AuthenticationConfigurationResource {
    return {
      local: {
        login: this.#webAuthentication.localLoginEnabled,
        registration: this.#webAuthentication.registrationEnabled,
      },
      oidc: [...this.#providers.values()].map((provider) => ({
        providerKey: provider.key,
        label: provider.label,
        loginPath: `/v1/auth/oidc/${provider.key}`,
      })),
    };
  }

  async begin(key: string): Promise<URL> {
    const provider = this.#provider(key);
    const configuration = await this.#configuration(provider);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const redirectUri = this.#redirectUri(provider.key);
    const now = this.#now();
    await this.#database
      .deleteFrom("oidc_authentication_requests")
      .where("expires_at", "<", new Date(now.valueOf() - 24 * 60 * 60_000))
      .execute();
    await this.#database
      .insertInto("oidc_authentication_requests")
      .values({
        state_sha256: digest(state),
        provider_key: provider.key,
        code_verifier: codeVerifier,
        nonce,
        redirect_uri: redirectUri,
        expires_at: new Date(now.valueOf() + REQUEST_TTL_MS),
        consumed_at: null,
        created_at: now,
      })
      .executeTakeFirstOrThrow();
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile email read_user",
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
  }

  async complete(key: string, callbackPath: string): Promise<IssuedWebSession> {
    const provider = this.#provider(key);
    const callbackUrl = new URL(callbackPath, this.#publicOrigin);
    const state = callbackUrl.searchParams.get("state");
    if (state === null || state.length < 32 || state.length > 256) {
      throw new OidcAuthenticationError("oidc_request_invalid", "OIDC login request is invalid");
    }
    const now = this.#now();
    const request = await this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("oidc_authentication_requests")
        .selectAll()
        .where("state_sha256", "=", digest(state))
        .forUpdate()
        .executeTakeFirst();
      if (
        row === undefined ||
        row.provider_key !== provider.key ||
        row.consumed_at !== null ||
        new Date(row.expires_at) <= now ||
        row.redirect_uri !== this.#redirectUri(provider.key)
      ) {
        throw new OidcAuthenticationError("oidc_request_invalid", "OIDC login request expired");
      }
      await transaction
        .updateTable("oidc_authentication_requests")
        .set({ consumed_at: now })
        .where("state_sha256", "=", row.state_sha256)
        .executeTakeFirstOrThrow();
      return row;
    });
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(await this.#configuration(provider), callbackUrl, {
        pkceCodeVerifier: request.code_verifier,
        expectedState: state,
        expectedNonce: request.nonce,
        idTokenExpected: true,
      });
    } catch {
      throw new OidcAuthenticationError(
        "oidc_provider_unavailable",
        "OIDC login could not be completed",
      );
    }
    const claims = tokens.claims();
    const subject = bounded(claims?.sub, "OIDC subject", 512);
    const profile = await this.#gitlabProfile(provider, tokens.access_token);
    const identity = await this.#upsertIdentity(provider, {
      subject,
      providerUserId: bounded(
        typeof profile.id === "number" ? String(profile.id) : profile.id,
        "GitLab user ID",
        128,
      ),
      username: bounded(profile.username, "GitLab username", 255),
      displayName: bounded(profile.name, "GitLab display name", 256),
    });
    return this.#webAuthentication.issueOidc(identity);
  }

  #provider(key: string): OidcIdentityProvider {
    const provider = this.#providers.get(key);
    if (provider === undefined) {
      throw new OidcAuthenticationError("oidc_request_invalid", "OIDC provider is unavailable");
    }
    return provider;
  }

  #configuration(provider: OidcIdentityProvider): Promise<oidc.Configuration> {
    let configuration = this.#configurations.get(provider.key);
    if (configuration === undefined) {
      const discoveryOptions: oidc.DiscoveryRequestOptions = {};
      if (provider.fetch !== undefined) {
        discoveryOptions[oidc.customFetch] = (url, options) =>
          provider.fetch!(url, options as unknown as RequestInit);
      }
      if (provider.allowInsecureHttp) discoveryOptions.execute = [oidc.allowInsecureRequests];
      configuration = oidc
        .discovery(
          new URL(provider.issuer),
          provider.clientId,
          provider.clientSecret,
          undefined,
          discoveryOptions,
        )
        .catch(() => {
          this.#configurations.delete(provider.key);
          throw new OidcAuthenticationError(
            "oidc_provider_unavailable",
            "OIDC provider metadata is unavailable",
          );
        });
      this.#configurations.set(provider.key, configuration);
    }
    return configuration;
  }

  async #gitlabProfile(
    provider: OidcIdentityProvider,
    accessToken: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await (provider.fetch ?? globalThis.fetch)(
        new URL("/api/v4/user", provider.issuer),
        {
          headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw new OidcAuthenticationError(
        "oidc_provider_unavailable",
        "GitLab identity endpoint is unavailable",
      );
    }
    if (!response.ok) {
      throw new OidcAuthenticationError(
        "oidc_identity_invalid",
        "GitLab identity could not be verified",
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > 64 * 1_024) {
      throw new OidcAuthenticationError("oidc_identity_invalid", "GitLab profile is too large");
    }
    try {
      return profileRecord(JSON.parse(bytes.toString("utf8")) as unknown);
    } catch {
      throw new OidcAuthenticationError("oidc_identity_invalid", "GitLab profile is invalid");
    }
  }

  async #upsertIdentity(
    provider: OidcIdentityProvider,
    profile: {
      subject: string;
      providerUserId: string;
      username: string;
      displayName: string;
    },
  ): Promise<TenantRequestIdentity> {
    const now = this.#now();
    return this.#database.transaction().execute(async (transaction) => {
      const tenant = await transaction
        .selectFrom("tenants as tenant")
        .innerJoin("tenant_runtime_policies as policy", "policy.tenant_id", "tenant.id")
        .select([
          "tenant.id",
          "tenant.slug",
          "policy.default_model_profile_id as defaultModelProfileId",
          "policy.enabled",
        ])
        .where("tenant.id", "=", provider.tenantId)
        .forUpdate("tenant")
        .executeTakeFirst();
      if (tenant === undefined || !tenant.enabled) {
        throw new OidcAuthenticationError("oidc_tenant_unavailable", "OIDC tenant is unavailable");
      }
      const existing = await transaction
        .selectFrom("external_identities")
        .select(["id", "user_id"])
        .where("provider_key", "=", provider.key)
        .where("issuer", "=", provider.issuer)
        .where("subject", "=", profile.subject)
        .forUpdate()
        .executeTakeFirst();
      const userId = existing?.user_id ?? this.#id();
      const externalIdentityId = existing?.id ?? this.#id();
      if (existing === undefined) {
        await transaction
          .insertInto("users")
          .values({
            id: userId,
            tenant_id: provider.tenantId,
            display_name: profile.displayName,
            created_at: now,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("external_identities")
          .values({
            id: externalIdentityId,
            tenant_id: provider.tenantId,
            user_id: userId,
            provider_key: provider.key,
            issuer: provider.issuer,
            subject: profile.subject,
            provider_user_id: profile.providerUserId,
            username: profile.username,
            display_name: profile.displayName,
            last_authenticated_at: now,
            created_at: now,
            updated_at: now,
          })
          .executeTakeFirstOrThrow();
      } else {
        await transaction
          .updateTable("users")
          .set({ display_name: profile.displayName })
          .where("tenant_id", "=", provider.tenantId)
          .where("id", "=", userId)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("external_identities")
          .set({
            provider_user_id: profile.providerUserId,
            username: profile.username,
            display_name: profile.displayName,
            last_authenticated_at: now,
            updated_at: now,
          })
          .where("id", "=", externalIdentityId)
          .executeTakeFirstOrThrow();
      }
      return {
        credentialId: `oidc:${externalIdentityId}`,
        tenantId: provider.tenantId,
        tenantSlug: tenant.slug,
        userId,
        username: profile.username,
        displayName: profile.displayName,
        role: provider.defaultRole,
        defaultModelProfileId: tenant.defaultModelProfileId,
        authenticationKind: "oidc",
        externalIdentity: {
          id: externalIdentityId,
          providerKey: provider.key,
          issuer: provider.issuer,
          subject: profile.subject,
          providerUserId: profile.providerUserId,
          username: profile.username,
        },
      };
    });
  }

  #redirectUri(providerKey: string): string {
    return new URL(`/v1/auth/oidc/${providerKey}/callback`, this.#publicOrigin).toString();
  }

  #now(): Date {
    const value = this.#clock();
    if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
      throw new TypeError("OIDC clock returned an invalid value");
    }
    return value;
  }
}
