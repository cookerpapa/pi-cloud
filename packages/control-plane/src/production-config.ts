import { resourceLimit } from "@pi-cloud/domain";
import { parseUuidPathParameter } from "@pi-cloud/protocol";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { loadProducerCapacity } from "@pi-cloud/runtime-core/kafka-accepted-fact";

const MAX_SECRET_BYTES = 16 * 1_024;

export type ProductionControlPlaneEnvironment = Readonly<Record<string, string | undefined>>;

export type ProductionBootstrapConfig = {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  apiCredentialId: string;
  credentialBindingId: string;
  modelProfileId: string;
  modelProfileName: string;
  maximumProjects: number | null;
  maximumSessions: number | null;
  sandboxDomains: readonly ProductionSandboxDomainConfig[];
};

type ProductionSandboxDomainConfig = {
  id: string;
  displayName: string;
  state: "active" | "draining" | "disabled";
  sandboxControlBaseUrl: string;
  workspaceStorageKey: string;
  maximumActiveSandboxes: number | null;
};

function sandboxDomains(value: string): readonly ProductionSandboxDomainConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("PI_CLOUD_SANDBOX_DOMAINS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 64) {
    throw new TypeError("PI_CLOUD_SANDBOX_DOMAINS_JSON must contain 1 to 64 Domains");
  }
  const domains = parsed.map((entry, index): ProductionSandboxDomainConfig => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError(`Sandbox Domain ${String(index)} must be an object`);
    }
    const domain = entry as Record<string, unknown>;
    if (
      typeof domain.id !== "string" ||
      !/^sandbox-domain-[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/u.test(domain.id)
    ) {
      throw new TypeError(`Sandbox Domain ${String(index)} has an invalid ID`);
    }
    if (
      typeof domain.displayName !== "string" ||
      domain.displayName.length < 1 ||
      domain.displayName.length > 128
    ) {
      throw new TypeError(`Sandbox Domain ${domain.id} has an invalid display name`);
    }
    if (domain.state !== "active" && domain.state !== "draining" && domain.state !== "disabled") {
      throw new TypeError(`Sandbox Domain ${domain.id} has an invalid state`);
    }
    if (
      typeof domain.sandboxControlBaseUrl !== "string" ||
      !/^https?:\/\/[^\s]+$/u.test(domain.sandboxControlBaseUrl) ||
      domain.sandboxControlBaseUrl.length > 2_048
    ) {
      throw new TypeError(`Sandbox Domain ${domain.id} has an invalid Sandbox control URL`);
    }
    if (
      typeof domain.workspaceStorageKey !== "string" ||
      !/^[A-Za-z0-9._/-]{1,128}$/u.test(domain.workspaceStorageKey)
    ) {
      throw new TypeError(`Sandbox Domain ${domain.id} has an invalid Workspace storage key`);
    }
    const maximumActiveSandboxes = resourceLimit(
      domain.maximumActiveSandboxes,
      `Sandbox Domain ${domain.id} capacity`,
    );
    return {
      id: domain.id,
      displayName: domain.displayName,
      state: domain.state,
      sandboxControlBaseUrl: domain.sandboxControlBaseUrl,
      workspaceStorageKey: domain.workspaceStorageKey,
      maximumActiveSandboxes,
    };
  });
  if (new Set(domains.map((domain) => domain.id)).size !== domains.length) {
    throw new TypeError("Sandbox Domain IDs must be unique");
  }
  return domains;
}

function required(environment: ProductionControlPlaneEnvironment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`Required production configuration ${name} is missing`);
  }
  return value;
}

function bounded(value: string, name: string, maximum = 256): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function boundedList(value: string, name: string, maximumItems = 64): string[] {
  const values = value.split(",");
  if (
    values.length < 1 ||
    values.length > maximumItems ||
    values.some((entry) => entry.trim() !== entry || entry.length < 1)
  ) {
    throw new TypeError(`${name} must contain bounded comma-separated values without whitespace`);
  }
  const normalized = values.map((entry) => bounded(entry, name, 512));
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${name} must contain unique values`);
  }
  return normalized;
}

function booleanValue(environment: ProductionControlPlaneEnvironment, name: string): boolean {
  const value = environment[name];
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be either true or false`);
}

function integerValue(
  environment: ProductionControlPlaneEnvironment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = environment[name];
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return parsed;
}

function managementUrl(value: string, allowInsecure: boolean): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TypeError("Supervisor management URL is invalid");
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new TypeError("Plain HTTP Supervisor management requires explicit opt-in");
  }
  return parsed.toString();
}

function managementUrls(value: string, allowInsecure: boolean): string[] {
  const values = value.split(",");
  if (values.length < 1 || values.length > 256 || values.some((entry) => entry.trim() !== entry)) {
    throw new TypeError(
      "PI_CLOUD_SANDBOX_CONTROL_URLS must contain 1-256 comma-separated URLs without whitespace",
    );
  }
  const parsed = values.map((entry) => managementUrl(entry, allowInsecure));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError("PI_CLOUD_SANDBOX_CONTROL_URLS must contain unique URLs");
  }
  return parsed;
}

function gitlabWebhookUrl(value: string, allowInsecure: boolean): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/v1/source-control/gitlab/webhook"
  ) {
    throw new TypeError("PI_CLOUD_GITLAB_WEBHOOK_URL is invalid");
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new TypeError("Plain HTTP GitLab Webhook URL requires explicit opt-in");
  }
  return parsed.toString();
}

function managementUrlTemplates(value: string, allowInsecure: boolean): string[] {
  const values = value.split(",");
  if (values.length < 1 || values.length > 64 || values.some((entry) => entry.trim() !== entry)) {
    throw new TypeError(
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES must contain 1-64 comma-separated templates without whitespace",
    );
  }
  const parsed = values.map((entry) => managementUrlTemplate(entry, allowInsecure));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES must contain unique templates",
    );
  }
  return parsed;
}

function managementUrlTemplate(value: string, allowInsecure: boolean): string {
  if (value.split("{supervisorId}").length !== 2) {
    throw new TypeError(
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATE must contain {supervisorId} exactly once",
    );
  }
  managementUrl(value.replace("{supervisorId}", "pi-worker-validation"), allowInsecure);
  return value;
}

function supervisorIdPrefixValue(value: string): string {
  if (!/^[a-z0-9](?:[-a-z0-9]{0,62})-$/.test(value)) {
    throw new TypeError(
      "PI_CLOUD_SUPERVISOR_ID_PREFIX must be a lowercase DNS-label prefix ending in a hyphen",
    );
  }
  return value;
}

async function readSecretFile(path: string, name: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError(`${name}_FILE must be an absolute path`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o137) !== 0 ||
      ((metadata.mode & 0o040) !== 0 &&
        ![process.getegid?.(), ...(process.getgroups?.() ?? [])].includes(metadata.gid)) ||
      metadata.size < 1 ||
      metadata.size > MAX_SECRET_BYTES
    ) {
      throw new TypeError(`${name}_FILE is not a private bounded regular file`);
    }
    const value = (await handle.readFile("utf8")).replace(/\r?\n$/, "");
    if (value.length < 1 || value.length > MAX_SECRET_BYTES || /[\r\n\0]/.test(value)) {
      throw new TypeError(`${name}_FILE contains an invalid secret`);
    }
    return value;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function secret(
  environment: ProductionControlPlaneEnvironment,
  name: string,
  allowInline: boolean,
): Promise<string> {
  const file = environment[`${name}_FILE`];
  const inline = environment[name];
  if (file !== undefined && inline !== undefined) {
    throw new TypeError(`${name} and ${name}_FILE cannot both be configured`);
  }
  if (file !== undefined) return readSecretFile(file, name);
  if (allowInline && inline !== undefined && inline.length > 0) return inline;
  throw new TypeError(`Required secret file ${name}_FILE is missing`);
}

async function privatePem(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError("PI_CLOUD_GITHUB_APP_PRIVATE_KEY_FILE must be an absolute path");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o137) !== 0 ||
      ((metadata.mode & 0o040) !== 0 &&
        ![process.getegid?.(), ...(process.getgroups?.() ?? [])].includes(metadata.gid)) ||
      metadata.size > 64 * 1_024
    ) {
      throw new TypeError("GitHub App private key file is invalid");
    }
    const value = await handle.readFile("utf8");
    if (
      !value.startsWith("-----BEGIN ") ||
      !value.includes("PRIVATE KEY-----") ||
      !value.trimEnd().endsWith("-----")
    ) {
      throw new TypeError("GitHub App private key file is invalid");
    }
    return value;
  } finally {
    await handle.close();
  }
}

/** The tool host needs neither user-login configuration nor VM management credentials. */
export async function loadToolHostConfig(
  environment: ProductionControlPlaneEnvironment = process.env,
) {
  const inline = booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS");
  const enabled: unknown =
    environment.PI_CLOUD_CONTROL_TOOLS_ENABLED === undefined
      ? undefined
      : JSON.parse(environment.PI_CLOUD_CONTROL_TOOLS_ENABLED);
  if (
    enabled !== undefined &&
    (!Array.isArray(enabled) ||
      enabled.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)) ||
      new Set(enabled).size !== enabled.length)
  )
    throw new Error("Invalid enabled Tool names");
  return {
    databaseUrl: await loadProductionDatabaseUrl(environment),
    kafkaBrokers: boundedList(
      required(environment, "PI_CLOUD_KAFKA_BROKERS"),
      "PI_CLOUD_KAFKA_BROKERS",
    ),
    kafkaReplicas: integerValue(environment, "PI_CLOUD_KAFKA_REPLICAS", 3, 1, 5),
    supervisorManagementToken: await secret(
      environment,
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN",
      inline,
    ),
    sandboxControlToken: await readSecretFile(
      required(environment, "PI_CLOUD_SANDBOX_CONTROL_TOKEN_FILE"),
      "PI_CLOUD_SANDBOX_CONTROL_TOKEN",
    ),
    host: bounded(environment.HOST ?? "127.0.0.1", "HOST"),
    environmentImageRevision: bounded(
      required(environment, "PI_CLOUD_IMAGE_REVISION"),
      "PI_CLOUD_IMAGE_REVISION",
      128,
    ),
    subagentTreePolicy: {
      maximumDepth: resourceLimit(
        environment.PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH,
        "PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH",
      ),
    },
    ...(enabled ? { enabledControlTools: enabled as string[] } : {}),
    ...(environment.PI_CLOUD_IMAGE_GENERATION_MODEL
      ? {
          imageGeneration: {
            model: bounded(
              environment.PI_CLOUD_IMAGE_GENERATION_MODEL,
              "PI_CLOUD_IMAGE_GENERATION_MODEL",
              200,
            ),
            baseUrl: managementUrl(required(environment, "PI_CLOUD_IMAGE_GENERATION_URL"), true),
            apiKey: await secret(environment, "PI_CLOUD_IMAGE_GENERATION_API_KEY", inline),
          },
        }
      : {}),
  };
}

async function loadSharedRoleConfig(environment: ProductionControlPlaneEnvironment) {
  const inline = booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS");
  const databaseUrl = await loadProductionDatabaseUrl(environment);
  return {
    databaseUrl,
    databaseNotificationUrl:
      environment.DATABASE_NOTIFICATION_URL !== undefined ||
      environment.DATABASE_NOTIFICATION_URL_FILE !== undefined
        ? await secret(environment, "DATABASE_NOTIFICATION_URL", inline)
        : databaseUrl,
    supervisorManagementToken: await secret(
      environment,
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN",
      inline,
    ),
    allowInsecureInternalHttp: booleanValue(environment, "PI_CLOUD_ALLOW_INSECURE_INTERNAL_HTTP"),
    host: bounded(environment.HOST ?? "127.0.0.1", "HOST"),
    port: integerValue(environment, "PORT", 3000, 1, 65535),
  };
}

function loadKafkaCatalogConfig(environment: ProductionControlPlaneEnvironment) {
  return {
    kafkaBrokers: boundedList(
      required(environment, "PI_CLOUD_KAFKA_BROKERS"),
      "PI_CLOUD_KAFKA_BROKERS",
    ),
    kafkaReplicas: integerValue(environment, "PI_CLOUD_KAFKA_REPLICAS", 3, 1, 5),
  };
}

function modelSourceTenant(environment: ProductionControlPlaneEnvironment) {
  return parseUuidPathParameter(
    required(environment, "PI_CLOUD_PLATFORM_MODEL_SOURCE_TENANT_ID"),
    "PI_CLOUD_PLATFORM_MODEL_SOURCE_TENANT_ID",
  );
}
function operatorTenant(environment: ProductionControlPlaneEnvironment) {
  return parseUuidPathParameter(
    environment.PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID || modelSourceTenant(environment),
    "PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID",
  );
}
function imageRevision(environment: ProductionControlPlaneEnvironment) {
  return bounded(required(environment, "PI_CLOUD_IMAGE_REVISION"), "PI_CLOUD_IMAGE_REVISION", 128);
}
function subagentPolicy(environment: ProductionControlPlaneEnvironment) {
  return {
    maximumDepth: resourceLimit(
      environment.PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH,
      "PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH",
    ),
    maximumNodes: resourceLimit(
      environment.PI_CLOUD_SUBAGENT_MAXIMUM_NODES,
      "PI_CLOUD_SUBAGENT_MAXIMUM_NODES",
    ),
  };
}
async function workspaceAccess(environment: ProductionControlPlaneEnvironment) {
  const inline = booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS");
  return {
    workspaceServiceToken: await secret(environment, "PI_CLOUD_WORKSPACE_SERVICE_TOKEN", inline),
    workspaceTerminalToken: await secret(environment, "PI_CLOUD_WORKSPACE_TERMINAL_TOKEN", inline),
  };
}

async function loadSourceControlConfig(environment: ProductionControlPlaneEnvironment) {
  const inline = booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS");
  const allowHttp = booleanValue(environment, "PI_CLOUD_ALLOW_INSECURE_INTERNAL_HTTP");
  const fields = [
    environment.PI_CLOUD_GITHUB_APP_ID,
    environment.PI_CLOUD_GITHUB_APP_PRIVATE_KEY_FILE,
    environment.PI_CLOUD_GITHUB_WEBHOOK_SECRET_FILE,
  ];
  const github = fields.some((value) => value !== undefined && value.length > 0);
  if (github && fields.some((value) => value === undefined || value.length === 0))
    throw new TypeError("GitHub App configuration must provide ID, private key and Webhook secret");
  const gitlab = booleanValue(environment, "PI_CLOUD_GITLAB_ENABLED");
  const publicOrigin = gitlab
    ? managementUrl(
        environment.PI_CLOUD_PUBLIC_ORIGIN_BASE_URL ??
          required(environment, "PI_CLOUD_PREVIEW_ORIGIN_BASE_URL"),
        true,
      )
    : undefined;
  return {
    ...(github
      ? {
          githubApp: {
            appId: bounded(
              required(environment, "PI_CLOUD_GITHUB_APP_ID"),
              "PI_CLOUD_GITHUB_APP_ID",
              31,
            ),
            privateKeyPem: await privatePem(
              required(environment, "PI_CLOUD_GITHUB_APP_PRIVATE_KEY_FILE"),
            ),
            webhookSecret: await secret(environment, "PI_CLOUD_GITHUB_WEBHOOK_SECRET", inline),
            issueLabel: bounded(
              environment.PI_CLOUD_GITHUB_ISSUE_LABEL ?? "picloud",
              "PI_CLOUD_GITHUB_ISSUE_LABEL",
              50,
            ),
          },
        }
      : {}),
    ...(gitlab
      ? {
          gitlabProject: {
            publicOrigin: publicOrigin!,
            credentialMasterKey: await secret(
              environment,
              "PI_CLOUD_SOURCE_CONTROL_CREDENTIAL_MASTER_KEY",
              inline,
            ),
            webhookUrl: gitlabWebhookUrl(
              environment.PI_CLOUD_GITLAB_WEBHOOK_URL ??
                new URL("v1/source-control/gitlab/webhook", publicOrigin).toString(),
              true,
            ),
            issueLabel: bounded(
              environment.PI_CLOUD_GITLAB_ISSUE_LABEL ?? "picloud",
              "PI_CLOUD_GITLAB_ISSUE_LABEL",
              50,
            ),
            ...(environment.PI_CLOUD_GITLAB_INTERNAL_BASE_URL
              ? {
                  internalBaseUrl: managementUrl(
                    environment.PI_CLOUD_GITLAB_INTERNAL_BASE_URL,
                    allowHttp,
                  ),
                }
              : {}),
            ...(environment.PI_CLOUD_GITLAB_WORKSPACE_BASE_URL
              ? {
                  workspaceBaseUrl: managementUrl(
                    environment.PI_CLOUD_GITLAB_WORKSPACE_BASE_URL,
                    allowHttp,
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

export type SourceControlRuntimeConfig = Awaited<ReturnType<typeof loadSourceControlConfig>> & {
  workspaceServiceToken: string;
  allowInsecureInternalHttp: boolean;
};

export async function loadSessionApiConfig(
  environment: ProductionControlPlaneEnvironment = process.env,
) {
  const shared = await loadSharedRoleConfig(environment);
  return {
    ...shared,
    ...loadKafkaCatalogConfig(environment),
    ...(await workspaceAccess(environment)),
    ...(await loadSourceControlConfig(environment)),
    cubeEgressConfigToken: await secret(
      environment,
      "PI_CLOUD_CUBE_EGRESS_CONFIG_TOKEN",
      booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS"),
    ),
    sandboxControlBaseUrls: managementUrls(
      required(environment, "PI_CLOUD_SANDBOX_CONTROL_URLS"),
      shared.allowInsecureInternalHttp,
    ),
    platformModelSourceTenantId: modelSourceTenant(environment),
    platformOperatorTenantId: operatorTenant(environment),
    environmentImageRevision: imageRevision(environment),
    subagentTreePolicy: subagentPolicy(environment),
    previewPublicOriginBaseUrl: managementUrl(
      required(environment, "PI_CLOUD_PREVIEW_ORIGIN_BASE_URL"),
      true,
    ),
    previewPort: integerValue(environment, "PI_CLOUD_PREVIEW_PORT", 3001, 1, 65535),
    sshGatewayEnabled: booleanValue(environment, "PI_CLOUD_SSH_GATEWAY_ENABLED"),
    sshAdvertisedHost: bounded(
      environment.PI_CLOUD_SSH_ADVERTISED_HOST ?? "127.0.0.1",
      "PI_CLOUD_SSH_ADVERTISED_HOST",
      253,
    ),
    sshAdvertisedPort: integerValue(environment, "PI_CLOUD_SSH_ADVERTISED_PORT", 2222, 1, 65535),
    sshTicketTtlMs: integerValue(
      environment,
      "PI_CLOUD_SSH_TICKET_TTL_MS",
      24 * 60 * 60_000,
      60_000,
      24 * 60 * 60_000,
    ),
    webSessionCookieSecure: booleanValue(environment, "PI_CLOUD_WEB_SESSION_COOKIE_SECURE"),
    webSessionTtlMs: integerValue(
      environment,
      "PI_CLOUD_WEB_SESSION_TTL_MS",
      30 * 24 * 60 * 60_000,
      60_000,
      365 * 24 * 60 * 60_000,
    ),
    publicRegistration: {
      enabled: booleanValue(environment, "PI_CLOUD_PUBLIC_REGISTRATION_ENABLED"),
      maximumTenants: resourceLimit(
        environment.PI_CLOUD_PUBLIC_REGISTRATION_MAXIMUM_TENANTS,
        "PI_CLOUD_PUBLIC_REGISTRATION_MAXIMUM_TENANTS",
      ),
      tenantQuotas: {
        maximumProjects: resourceLimit(
          environment.PI_CLOUD_PUBLIC_TENANT_MAXIMUM_PROJECTS,
          "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_PROJECTS",
        ),
        maximumSessions: resourceLimit(
          environment.PI_CLOUD_PUBLIC_TENANT_MAXIMUM_SESSIONS,
          "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_SESSIONS",
        ),
      },
    },
  };
}

export async function loadSessionRuntimeConfig(
  environment: ProductionControlPlaneEnvironment = process.env,
) {
  const shared = await loadSharedRoleConfig(environment);
  const inline = booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS");
  return {
    ...shared,
    ...loadKafkaCatalogConfig(environment),
    platformOperatorTenantId: operatorTenant(environment),
    cubeEgressConfigToken: await secret(environment, "PI_CLOUD_CUBE_EGRESS_CONFIG_TOKEN", inline),
    sandboxControlBaseUrls: managementUrls(
      required(environment, "PI_CLOUD_SANDBOX_CONTROL_URLS"),
      shared.allowInsecureInternalHttp,
    ),
    projectorAdvertisedBaseUrl: managementUrl(
      environment.PI_CLOUD_PROJECTOR_ADVERTISED_URL ??
        `http://${required(environment, "POD_IP").includes(":") ? `[${environment.POD_IP}]` : environment.POD_IP}:${environment.PORT ?? "3000"}`,
      true,
    ),
    kafkaPartitions: integerValue(environment, "PI_CLOUD_KAFKA_PARTITIONS", 32, 1, 1024),
    producerCapacity: loadProducerCapacity(environment),
    acceptedFactRetentionMs: integerValue(
      environment,
      "PI_CLOUD_ACCEPTED_FACT_RETENTION_MS",
      2 * 60 * 60_000,
      60 * 60_000,
      7 * 24 * 60 * 60_000,
    ),
    supervisorEnrollmentToken: await secret(
      environment,
      "PI_CLOUD_SUPERVISOR_ENROLLMENT_TOKEN",
      inline,
    ),
    supervisorIdPrefix: supervisorIdPrefixValue(
      required(environment, "PI_CLOUD_SUPERVISOR_ID_PREFIX"),
    ),
    supervisorMaximumCapacity: resourceLimit(
      environment.PI_CLOUD_SUPERVISOR_MAXIMUM_CAPACITY,
      "PI_CLOUD_SUPERVISOR_MAXIMUM_CAPACITY",
    ),
    supervisorManagementBaseUrlTemplates: managementUrlTemplates(
      required(environment, "PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES"),
      shared.allowInsecureInternalHttp,
    ),
    subagentTreePolicy: subagentPolicy(environment),
  };
}

export async function loadResourceManagementConfig(
  environment: ProductionControlPlaneEnvironment = process.env,
) {
  return {
    ...(await loadSharedRoleConfig(environment)),
    ...(await workspaceAccess(environment)),
    ...(await loadSourceControlConfig(environment)),
    environmentImageRevision: imageRevision(environment),
  };
}

export type SessionApiConfig = Awaited<ReturnType<typeof loadSessionApiConfig>>;
export type SessionRuntimeConfig = Awaited<ReturnType<typeof loadSessionRuntimeConfig>>;
export type ResourceManagementConfig = Awaited<ReturnType<typeof loadResourceManagementConfig>>;

export async function loadProductionDatabaseUrl(
  environment: ProductionControlPlaneEnvironment = process.env,
): Promise<string> {
  return secret(
    environment,
    "DATABASE_URL",
    booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS"),
  );
}

export async function loadProductionApiToken(
  environment: ProductionControlPlaneEnvironment = process.env,
): Promise<string> {
  return secret(
    environment,
    "PI_CLOUD_API_TOKEN",
    booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS"),
  );
}

export function loadProductionBootstrapConfig(
  environment: ProductionControlPlaneEnvironment = process.env,
): ProductionBootstrapConfig {
  const userId = parseUuidPathParameter(
    required(environment, "PI_CLOUD_USER_ID"),
    "PI_CLOUD_USER_ID",
  );
  return {
    tenantId: parseUuidPathParameter(
      required(environment, "PI_CLOUD_TENANT_ID"),
      "PI_CLOUD_TENANT_ID",
    ),
    tenantSlug: bounded(environment.PI_CLOUD_TENANT_SLUG ?? "pi-cloud", "PI_CLOUD_TENANT_SLUG"),
    userId,
    apiCredentialId: parseUuidPathParameter(
      required(environment, "PI_CLOUD_API_CREDENTIAL_ID"),
      "PI_CLOUD_API_CREDENTIAL_ID",
    ),
    credentialBindingId: parseUuidPathParameter(
      required(environment, "PI_CLOUD_CREDENTIAL_BINDING_ID"),
      "PI_CLOUD_CREDENTIAL_BINDING_ID",
    ),
    modelProfileId: parseUuidPathParameter(
      required(environment, "PI_CLOUD_DEFAULT_MODEL_PROFILE_ID"),
      "PI_CLOUD_DEFAULT_MODEL_PROFILE_ID",
    ),
    modelProfileName: bounded(
      environment.PI_CLOUD_MODEL_PROFILE_NAME ?? "deterministic-java-repair",
      "PI_CLOUD_MODEL_PROFILE_NAME",
    ),
    maximumProjects: resourceLimit(
      environment.PI_CLOUD_TENANT_MAXIMUM_PROJECTS,
      "PI_CLOUD_TENANT_MAXIMUM_PROJECTS",
    ),
    maximumSessions: resourceLimit(
      environment.PI_CLOUD_TENANT_MAXIMUM_SESSIONS,
      "PI_CLOUD_TENANT_MAXIMUM_SESSIONS",
    ),
    sandboxDomains: sandboxDomains(required(environment, "PI_CLOUD_SANDBOX_DOMAINS_JSON")),
  };
}
