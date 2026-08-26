const MINIMUM_EVENT_RETENTION_MS = 60 * 60_000;
const PI_TURN_TIMEOUT_MS = 10 * 60_000;
const SETTLEMENT_GRACE_MS = 5 * 60_000;

function integer(environment, name, fallback, minimum, maximum) {
  const raw = environment[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${String(minimum)} to ${String(maximum)}`);
  }
  return value;
}

function booleanValue(environment, name, fallback) {
  const value = environment[name] ?? fallback;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

function bounded(environment, name, fallback, pattern, maximum = 256) {
  const value = environment[name] ?? fallback;
  if (value.length < 1 || value.length > maximum || !pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

export function validateProductionRuntimeEnvironment(environment) {
  booleanValue(environment, "PI_CLOUD_PUBLIC_REGISTRATION_ENABLED", "true");
  bounded(environment, "PI_CLOUD_HTTP_BIND_ADDRESS", "127.0.0.1", /^[A-Za-z0-9:._-]+$/u, 128);
  integer(environment, "PI_CLOUD_HTTP_PORT", 8_080, 1, 65_535);
  booleanValue(environment, "PI_CLOUD_WEB_SESSION_COOKIE_SECURE", "false");
  integer(
    environment,
    "PI_CLOUD_WEB_SESSION_TTL_MS",
    30 * 24 * 60 * 60_000,
    60_000,
    365 * 24 * 60 * 60_000,
  );
  const operatorTenantId = environment.PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID ?? "";
  if (
    operatorTenantId !== "" &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operatorTenantId)
  ) {
    throw new Error("PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID must be empty or a UUID");
  }
  integer(environment, "PI_CLOUD_PUBLIC_REGISTRATION_MAXIMUM_TENANTS", 1_000, 2, 1_000_000);
  integer(environment, "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_PROJECTS", 10, 1, 1_000_000);
  integer(environment, "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_SESSIONS", 100, 1, 1_000_000);
  const maximumUnsettledTurns = integer(
    environment,
    "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS",
    10,
    1,
    1_000_000,
  );
  const maximumConcurrentTurns = integer(
    environment,
    "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS",
    4,
    1,
    256,
  );
  integer(environment, "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_ACTIVE_SANDBOXES", 2, 1, 1_000_000);
  integer(environment, "PI_CLOUD_SUPERVISOR_CAPACITY", 2, 1, 16);
  integer(environment, "PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH", 4, 1, 64);
  const subagentNodes = integer(environment, "PI_CLOUD_SUBAGENT_MAXIMUM_NODES", 32, 1, 10_000);
  const subagentConcurrent = integer(
    environment,
    "PI_CLOUD_SUBAGENT_MAXIMUM_CONCURRENT",
    3,
    1,
    1_000,
  );
  if (subagentConcurrent > subagentNodes) {
    throw new Error("Subagent concurrency cannot exceed the Subagent node budget");
  }
  if (maximumConcurrentTurns > maximumUnsettledTurns) {
    throw new Error(
      "PI_CLOUD_PUBLIC_TENANT_MAXIMUM_CONCURRENT_TURNS cannot exceed PI_CLOUD_PUBLIC_TENANT_MAXIMUM_UNSETTLED_TURNS",
    );
  }
  const queueWaitMs = integer(
    environment,
    "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_QUEUE_WAIT_TIMEOUT_MS",
    30_000,
    1_000,
    600_000,
  );
  const volumeRequestMs = integer(
    environment,
    "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_REQUEST_TIMEOUT_MS",
    660_000,
    1_000,
    900_000,
  );
  if (queueWaitMs >= volumeRequestMs) {
    throw new Error("Workspace Volume queue wait must be shorter than its request timeout");
  }

  const eventRetentionMs = integer(
    environment,
    "PI_CLOUD_AGENT_EVENT_RETENTION_MS",
    86_400_000,
    MINIMUM_EVENT_RETENTION_MS,
    30 * 24 * 60 * 60_000,
  );
  integer(environment, "PI_CLOUD_MAXIMUM_HOT_EVENTS_PER_SESSION", 8_192, 512, 1_000_000);
  integer(environment, "PI_CLOUD_EVENT_WRITER_LEASE_MS", 9_000, 3_000, 30_000);
  integer(environment, "PI_CLOUD_EVENT_WRITER_MAXIMUM_ACTIVE", 128, 1, 10_000);
  integer(environment, "PI_CLOUD_JETSTREAM_REPLICAS", 3, 1, 5);
  if (eventRetentionMs < PI_TURN_TIMEOUT_MS + SETTLEMENT_GRACE_MS) {
    throw new Error("JetStream event retention cannot omit a still-recoverable Run");
  }

  const ownershipLeaseMs = integer(
    environment,
    "PI_CLOUD_TOOL_BROKER_OWNERSHIP_LEASE_MS",
    15_000,
    3_000,
    300_000,
  );
  const ownershipHeartbeatMs = integer(
    environment,
    "PI_CLOUD_TOOL_BROKER_OWNERSHIP_HEARTBEAT_MS",
    5_000,
    1_000,
    60_000,
  );
  if (ownershipHeartbeatMs * 2 >= ownershipLeaseMs) {
    throw new Error("Tool Broker heartbeat must leave lease failure margin");
  }
  integer(environment, "PI_CLOUD_MAXIMUM_ACTIVE_TOOL_SANDBOXES", 2, 1, 1_000);
  integer(environment, "PI_CLOUD_MAXIMUM_WARM_SANDBOXES", 4, 1, 1_000);
  integer(environment, "PI_CLOUD_SANDBOX_WARM_TTL_MS", 900_000, 1_000, 24 * 60 * 60_000);
  integer(environment, "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_CONCURRENT_OPERATIONS", 2, 1, 64);
  integer(environment, "PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_MAXIMUM_QUEUED_OPERATIONS", 32, 0, 4_096);
  integer(environment, "PI_CLOUD_WORKSPACE_DELETION_REAPER_INTERVAL_MS", 30_000, 1_000, 3_600_000);
  integer(environment, "PI_CLOUD_WORKSPACE_DELETION_REAPER_BATCH_SIZE", 16, 1, 256);
  booleanValue(environment, "PI_CLOUD_SSH_GATEWAY_ENABLED", "true");
  bounded(environment, "PI_CLOUD_SSH_BIND_ADDRESS", "127.0.0.1", /^[A-Za-z0-9:._-]+$/u, 128);
  integer(environment, "PI_CLOUD_SSH_PORT", 2_222, 1, 65_535);
  bounded(environment, "PI_CLOUD_SSH_ADVERTISED_HOST", "127.0.0.1", /^[A-Za-z0-9:._-]+$/u, 253);
  integer(environment, "PI_CLOUD_SSH_ADVERTISED_PORT", 2_222, 1, 65_535);
  integer(environment, "PI_CLOUD_SSH_TICKET_TTL_MS", 86_400_000, 60_000, 86_400_000);
  integer(environment, "PI_CLOUD_PROMETHEUS_PORT", 9_090, 1, 65_535);
  integer(environment, "PI_CLOUD_ALERTMANAGER_PORT", 9_093, 1, 65_535);
  integer(environment, "PI_CLOUD_GRAFANA_PORT", 3_001, 1, 65_535);
  integer(environment, "PI_CLOUD_JAEGER_PORT", 16_686, 1, 65_535);
}
