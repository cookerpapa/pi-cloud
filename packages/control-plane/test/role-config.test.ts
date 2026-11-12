import { expect, it } from "vitest";
import {
  loadResourceManagementConfig,
  loadSessionApiConfig,
  loadSessionRuntimeConfig,
} from "../src/production-config.ts";

const shared = {
  PI_CLOUD_ALLOW_INLINE_SECRETS: "true",
  PI_CLOUD_ALLOW_INSECURE_INTERNAL_HTTP: "true",
  DATABASE_URL: "postgresql://role-test@127.0.0.1:1/unused",
  PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN: "management-" + "m".repeat(48),
};
const workspace = {
  PI_CLOUD_WORKSPACE_SERVICE_TOKEN: "files-" + "f".repeat(48),
  PI_CLOUD_WORKSPACE_TERMINAL_TOKEN: "terminal-" + "t".repeat(48),
  PI_CLOUD_IMAGE_REVISION: "role-test",
};
const execution = {
  PI_CLOUD_KAFKA_BROKERS: "kafka.invalid:9092",
  PI_CLOUD_SANDBOX_CONTROL_URLS: "http://management.invalid:4300",
  PI_CLOUD_CUBE_EGRESS_CONFIG_TOKEN: "egress-" + "e".repeat(48),
  PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID: "40000000-0000-4000-8000-000000000001",
};

it("loads the public API without any Worker enrollment configuration", async () => {
  const config = await loadSessionApiConfig({
    ...shared,
    ...workspace,
    ...execution,
    PI_CLOUD_PLATFORM_MODEL_SOURCE_TENANT_ID: execution.PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID,
    PI_CLOUD_PREVIEW_ORIGIN_BASE_URL: "http://preview.invalid",
    PI_CLOUD_SUPERVISOR_ENROLLMENT_TOKEN_FILE: "/missing/irrelevant-worker-secret",
    PI_CLOUD_SUPERVISOR_ID_PREFIX: "invalid ignored prefix",
    PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES: "invalid ignored URL",
  });
  expect(config.previewPublicOriginBaseUrl).toBe("http://preview.invalid/");
  expect(config).not.toHaveProperty("supervisorEnrollmentToken");
  expect(config).not.toHaveProperty("supervisorIdPrefix");
  expect(config).not.toHaveProperty("producerCapacity");
});

it("loads Session execution without public registration, preview or SCM settings", async () => {
  const config = await loadSessionRuntimeConfig({
    ...shared,
    ...execution,
    PI_CLOUD_PROJECTOR_ADVERTISED_URL: "http://runtime.invalid:3000",
    PI_CLOUD_SUPERVISOR_ENROLLMENT_TOKEN: "enrollment-" + "e".repeat(48),
    PI_CLOUD_SUPERVISOR_ID_PREFIX: "pi-worker-",
    PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES: "http://{supervisorId}:4100",
    PI_CLOUD_PREVIEW_ORIGIN_BASE_URL: "invalid ignored preview",
    PI_CLOUD_PUBLIC_REGISTRATION_ENABLED: "invalid ignored bool",
    PI_CLOUD_GITHUB_APP_ID: "incomplete ignored integration",
    PI_CLOUD_IMAGE_GENERATION_API_KEY_FILE: "/missing/irrelevant-image-secret",
  });
  expect(config.supervisorIdPrefix).toBe("pi-worker-");
  expect(config).not.toHaveProperty("publicRegistration");
  expect(config).not.toHaveProperty("githubApp");
  expect(config).not.toHaveProperty("workspaceTerminalToken");
});

it("loads resource management without Kafka, Worker enrollment or preview configuration", async () => {
  const config = await loadResourceManagementConfig({ ...shared, ...workspace });
  expect(config.environmentImageRevision).toBe("role-test");
  expect(config).not.toHaveProperty("kafkaBrokers");
  expect(config).not.toHaveProperty("supervisorEnrollmentToken");
  expect(config).not.toHaveProperty("previewPublicOriginBaseUrl");
});

it("still rejects missing configuration owned by the selected role", async () => {
  await expect(loadSessionApiConfig({ ...shared, ...workspace })).rejects.toThrow(
    "PI_CLOUD_KAFKA_BROKERS",
  );
  await expect(loadResourceManagementConfig(shared)).rejects.toThrow(
    "PI_CLOUD_WORKSPACE_SERVICE_TOKEN",
  );
});
