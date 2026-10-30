import { resourceLimit } from "@pi-cloud/domain";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  MAX_TOOL_EXECUTION_TIMEOUT_MS,
  DEFAULT_MODEL_REQUEST_MAX_BYTES,
  DEFAULT_MODEL_UPLOAD_MAX_BYTES,
} from "@pi-cloud/protocol";
import {
  loadProducerCapacity,
  type ProducerCapacity,
} from "@pi-cloud/runtime-core/kafka-accepted-fact";

const MAX_SECRET_BYTES = 16 * 1_024;
const REMOTE_TOOL_TRANSPORT_MARGIN_MS = 60_000;

export type SupervisorHostEnvironment = Readonly<Record<string, string | undefined>>;

export type SupervisorHostConfig = {
  supervisorId: string;
  controlPlaneBaseUrl: string;
  supervisorWebSocketUrl: string;
  allowInsecureInternalHttp: boolean;
  enrollmentToken: string;
  managementToken: string;
  sandboxControlServiceToken: string;
  providerGatewayBaseUrl: string;
  providerGatewayApiKey: string;
  databaseUrl: string;
  databaseNotificationUrl: string;
  kafka: { brokers: readonly string[]; partitions: number; replicas: number };
  producerCapacity: ProducerCapacity;
  managementHost: string;
  managementPort: number;
  managementAdvertisedBaseUrl: string;
  maxConcurrentSessions: number | null;
  databaseMaxConnections: number;
  subagentMaximumDepth: number | null;
  subagentMaximumNodes: number | null;
  modelConcurrency: number | null;
  familyModelConcurrency: number | null;
  sandboxControlBaseUrls: readonly string[];
  sandboxControlRequestTimeoutMs: number;
  trustedWorkspaceDirectory: string;
  bootStateDirectory: string;
  modelGatewayHost: string;
  modelGatewayPort: number;
  modelGatewayAdvertisedBaseUrl: string;
  modelGatewayMaximumRequestsPerTurn: number | null;
  modelRequestMaxBytes: number;
  modelUploadMaxBytes: number;
  modelConnectTimeoutMs: number;
  modelEventIdleTimeoutMs: number;
  workerDrainGraceMs: number;
  workerRetirementTimeoutMs: number;
};

function required(environment: SupervisorHostEnvironment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`Required Supervisor host configuration ${name} is missing`);
  }
  return value;
}

function bounded(value: string, name: string, maximum = 4_096): string {
  if (value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function booleanValue(environment: SupervisorHostEnvironment, name: string): boolean {
  const value = environment[name];
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`${name} must be either true or false`);
}

function integerValue(
  environment: SupervisorHostEnvironment,
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

function baseUrl(value: string, allowInsecure: boolean): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TypeError("PI_CLOUD_CONTROL_PLANE_URL is invalid");
  }
  if (parsed.protocol === "http:" && !allowInsecure) {
    throw new TypeError("Plain HTTP control-plane access requires explicit opt-in");
  }
  return parsed.toString();
}

function websocketUrl(controlPlaneBaseUrl: string, explicit: string | undefined): string {
  const parsed = new URL(explicit ?? controlPlaneBaseUrl);
  if (explicit === undefined) {
    parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    parsed.pathname = "/internal/v1/supervisor";
  }
  if (
    (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new TypeError("PI_CLOUD_SUPERVISOR_WEBSOCKET_URL is invalid");
  }
  return parsed.toString();
}

function modelGatewayBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "")
  ) {
    throw new TypeError("PI_CLOUD_MODEL_GATEWAY_ADVERTISED_URL is invalid");
  }
  return parsed.toString();
}

function internalServiceBaseUrl(value: string, allowInsecure: boolean, name: string): string {
  const parsed = new URL(value);
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    (parsed.protocol === "http:" && !allowInsecure)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return parsed.toString();
}

function internalServiceBaseUrls(value: string, allowInsecure: boolean, name: string): string[] {
  const values = value.split(",");
  if (values.length < 1 || values.length > 256 || values.some((entry) => entry.trim() !== entry)) {
    throw new TypeError(`${name} must contain 1-256 comma-separated URLs without whitespace`);
  }
  const parsed = values.map((entry) => internalServiceBaseUrl(entry, allowInsecure, name));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(`${name} must contain unique URLs`);
  }
  return parsed;
}

async function readSecretFile(path: string, name: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new TypeError(`${name}_FILE must be an absolute path`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const effectiveUserId = process.geteuid?.();
    const effectiveGroups = new Set([process.getegid?.(), ...(process.getgroups?.() ?? [])]);
    const readableByOwner =
      effectiveUserId !== undefined &&
      metadata.uid === effectiveUserId &&
      (metadata.mode & 0o400) !== 0;
    const readableByPrivateGroup =
      effectiveGroups.has(metadata.gid) && (metadata.mode & 0o040) !== 0;
    if (
      !metadata.isFile() ||
      (metadata.mode & 0o137) !== 0 ||
      (!readableByOwner && !readableByPrivateGroup) ||
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
  environment: SupervisorHostEnvironment,
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

async function optionalSecret(
  environment: SupervisorHostEnvironment,
  name: string,
  allowInline: boolean,
): Promise<string | undefined> {
  if (environment[`${name}_FILE`] === undefined && environment[name] === undefined)
    return undefined;
  return secret(environment, name, allowInline);
}

export async function loadSupervisorHostConfig(
  environment: SupervisorHostEnvironment = process.env,
): Promise<SupervisorHostConfig> {
  for (const name of ["PI_CLOUD_PI_TURN_TIMEOUT_MS", "PI_CLOUD_MODEL_GATEWAY_CAPABILITY_TTL_MS"])
    if (environment[name] !== undefined)
      throw new TypeError(`${name} was removed; Agent work follows execution ownership`);
  const allowInsecureInternalHttp = booleanValue(
    environment,
    "PI_CLOUD_ALLOW_INSECURE_INTERNAL_HTTP",
  );
  const allowInlineSecrets = booleanValue(environment, "PI_CLOUD_ALLOW_INLINE_SECRETS");
  const controlPlaneBaseUrl = baseUrl(
    required(environment, "PI_CLOUD_CONTROL_PLANE_URL"),
    allowInsecureInternalHttp,
  );
  const sandboxControlRequestTimeoutMs = integerValue(
    environment,
    "PI_CLOUD_SANDBOX_CONTROL_REQUEST_TIMEOUT_MS",
    MAX_TOOL_EXECUTION_TIMEOUT_MS + REMOTE_TOOL_TRANSPORT_MARGIN_MS,
    1_000,
    900_000,
  );
  const workerDrainGraceMs = integerValue(
    environment,
    "PI_CLOUD_WORKER_DRAIN_GRACE_MS",
    30_000,
    1,
    300_000,
  );
  const workerRetirementTimeoutMs = integerValue(
    environment,
    "PI_CLOUD_WORKER_RETIREMENT_TIMEOUT_MS",
    660_000,
    1_000,
    1_200_000,
  );
  const modelConnectTimeoutMs = integerValue(
    environment,
    "PI_CLOUD_MODEL_CONNECT_TIMEOUT_MS",
    15_000,
    1_000,
    300_000,
  );
  const modelEventIdleTimeoutMs = integerValue(
    environment,
    "PI_CLOUD_MODEL_EVENT_IDLE_TIMEOUT_MS",
    300_000,
    1_000,
    900_000,
  );
  if (modelConnectTimeoutMs >= modelEventIdleTimeoutMs)
    throw new TypeError("Model event timeout must outlive connection establishment");
  for (const name of [
    "PI_CLOUD_MODEL_GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS",
    "PI_CLOUD_MODEL_GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS",
    "PI_CLOUD_PI_MODEL_REQUEST_TIMEOUT_MS",
  ])
    if (environment[name] !== undefined)
      throw new TypeError(
        `${name} was removed; configure model connection and event inactivity budgets`,
      );
  if (
    sandboxControlRequestTimeoutMs <
    MAX_TOOL_EXECUTION_TIMEOUT_MS + REMOTE_TOOL_TRANSPORT_MARGIN_MS
  ) {
    throw new TypeError(
      "Sandbox control timeout must outlive the maximum Tool execution and transport margin",
    );
  }
  if (workerRetirementTimeoutMs < sandboxControlRequestTimeoutMs + 300_000)
    throw new TypeError("Worker retirement timeout must cover operation cleanup and settlement");
  const subagentMaximumNodes = resourceLimit(
    environment.PI_CLOUD_SUBAGENT_MAXIMUM_NODES,
    "PI_CLOUD_SUBAGENT_MAXIMUM_NODES",
  );
  if (environment.PI_CLOUD_SUBAGENT_MAXIMUM_CONCURRENT !== undefined)
    throw new TypeError(
      "PI_CLOUD_SUBAGENT_MAXIMUM_CONCURRENT was removed; configure Worker/Session model concurrency instead",
    );
  const modelConcurrency = resourceLimit(
    environment.PI_CLOUD_WORKER_MODEL_CONCURRENCY,
    "PI_CLOUD_WORKER_MODEL_CONCURRENCY",
  );
  const familyModelConcurrency = resourceLimit(
    environment.PI_CLOUD_SESSION_MODEL_CONCURRENCY,
    "PI_CLOUD_SESSION_MODEL_CONCURRENCY",
  );
  const databaseUrl = await secret(environment, "DATABASE_URL", allowInlineSecrets);
  const databaseNotificationUrl =
    (await optionalSecret(environment, "DATABASE_NOTIFICATION_URL", allowInlineSecrets)) ??
    databaseUrl;
  const maxConcurrentSessions = resourceLimit(
    environment.PI_CLOUD_SUPERVISOR_CAPACITY,
    "PI_CLOUD_SUPERVISOR_CAPACITY",
  );
  const databaseMaxConnections = integerValue(
    environment,
    "PI_CLOUD_SUPERVISOR_DATABASE_MAX_CONNECTIONS",
    4,
    2,
    64,
  );
  return {
    supervisorId: bounded(
      required(environment, "PI_CLOUD_SUPERVISOR_ID"),
      "PI_CLOUD_SUPERVISOR_ID",
      256,
    ),
    controlPlaneBaseUrl,
    supervisorWebSocketUrl: websocketUrl(
      controlPlaneBaseUrl,
      environment.PI_CLOUD_SUPERVISOR_WEBSOCKET_URL,
    ),
    allowInsecureInternalHttp,
    enrollmentToken: await secret(
      environment,
      "PI_CLOUD_SUPERVISOR_ENROLLMENT_TOKEN",
      allowInlineSecrets,
    ),
    managementToken: await secret(
      environment,
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN",
      allowInlineSecrets,
    ),
    sandboxControlServiceToken: await secret(
      environment,
      "PI_CLOUD_SANDBOX_CONTROL_TOKEN",
      allowInlineSecrets,
    ),
    providerGatewayBaseUrl: internalServiceBaseUrl(
      required(environment, "PI_CLOUD_PROVIDER_GATEWAY_URL"),
      allowInsecureInternalHttp,
      "PI_CLOUD_PROVIDER_GATEWAY_URL",
    ),
    providerGatewayApiKey: await secret(
      environment,
      "PI_CLOUD_PROVIDER_GATEWAY_API_KEY",
      allowInlineSecrets,
    ),
    databaseUrl,
    databaseNotificationUrl,
    producerCapacity: loadProducerCapacity(environment),
    kafka: {
      brokers: required(environment, "PI_CLOUD_KAFKA_BROKERS")
        .split(",")
        .map((s) => s.trim()),
      partitions: integerValue(environment, "PI_CLOUD_KAFKA_PARTITIONS", 32, 1, 1024),
      replicas: integerValue(environment, "PI_CLOUD_KAFKA_REPLICAS", 3, 1, 5),
    },
    managementHost: bounded(
      environment.PI_CLOUD_SUPERVISOR_MANAGEMENT_HOST ?? "127.0.0.1",
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_HOST",
      256,
    ),
    managementPort: integerValue(
      environment,
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_PORT",
      4100,
      1,
      65_535,
    ),
    managementAdvertisedBaseUrl: internalServiceBaseUrl(
      required(environment, "PI_CLOUD_SUPERVISOR_MANAGEMENT_ADVERTISED_URL"),
      allowInsecureInternalHttp,
      "PI_CLOUD_SUPERVISOR_MANAGEMENT_ADVERTISED_URL",
    ),
    maxConcurrentSessions,
    databaseMaxConnections,
    subagentMaximumDepth: resourceLimit(
      environment.PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH,
      "PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH",
    ),
    subagentMaximumNodes,
    modelConcurrency,
    familyModelConcurrency,
    sandboxControlBaseUrls: internalServiceBaseUrls(
      required(environment, "PI_CLOUD_SANDBOX_CONTROL_URLS"),
      allowInsecureInternalHttp,
      "PI_CLOUD_SANDBOX_CONTROL_URLS",
    ),
    sandboxControlRequestTimeoutMs,
    trustedWorkspaceDirectory: required(environment, "PI_CLOUD_TRUSTED_WORKSPACE_DIRECTORY"),
    bootStateDirectory: required(environment, "PI_CLOUD_BOOT_STATE_DIRECTORY"),
    modelGatewayHost: bounded(
      environment.PI_CLOUD_MODEL_GATEWAY_HOST ?? "127.0.0.1",
      "PI_CLOUD_MODEL_GATEWAY_HOST",
      256,
    ),
    modelGatewayPort: integerValue(environment, "PI_CLOUD_MODEL_GATEWAY_PORT", 4_200, 1, 65_535),
    modelGatewayAdvertisedBaseUrl: modelGatewayBaseUrl(
      required(environment, "PI_CLOUD_MODEL_GATEWAY_ADVERTISED_URL"),
    ),
    modelGatewayMaximumRequestsPerTurn: resourceLimit(
      environment.PI_CLOUD_MODEL_GATEWAY_MAXIMUM_REQUESTS_PER_TURN,
      "PI_CLOUD_MODEL_GATEWAY_MAXIMUM_REQUESTS_PER_TURN",
    ),
    modelConnectTimeoutMs,
    modelEventIdleTimeoutMs,
    modelRequestMaxBytes: integerValue(
      environment,
      "PI_CLOUD_MODEL_REQUEST_MAX_BYTES",
      DEFAULT_MODEL_REQUEST_MAX_BYTES,
      1024 * 1024,
      1024 * 1024 * 1024,
    ),
    modelUploadMaxBytes: integerValue(
      environment,
      "PI_CLOUD_MODEL_UPLOAD_MAX_BYTES",
      DEFAULT_MODEL_UPLOAD_MAX_BYTES,
      1024 * 1024,
      4 * 1024 * 1024 * 1024,
    ),
    workerDrainGraceMs,
    workerRetirementTimeoutMs,
  };
}
