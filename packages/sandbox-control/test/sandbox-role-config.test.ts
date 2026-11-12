import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  loadSandboxControlConfig,
  loadSandboxExecutionConfig,
} from "../src/sandbox-control-config.ts";

it("separates management lifetime settings from Session execution transport settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pma-role-config-"));
  const file = async (name: string, value: string) => {
    const path = join(dir, name);
    await writeFile(path, value, { mode: 0o600 });
    return path;
  };
  try {
    const token = await file("token", "t".repeat(48));
    const common = {
      PI_CLOUD_SANDBOX_DOMAIN_ID: "sandbox-domain-0001",
      PI_CLOUD_SANDBOX_CONTROL_ADVERTISED_URL: "http://runtime.invalid:4300",
      PI_CLOUD_SANDBOX_CONTROL_TOKEN_FILE: token,
      PI_CLOUD_WORKSPACE_TERMINAL_TOKEN_FILE: token,
      PI_CLOUD_CUBE_PERSISTENT_STATE_KEY_FILE: await file(
        "state",
        Buffer.alloc(32, 3).toString("base64url"),
      ),
      PI_CLOUD_IMAGE_REVISION: "role-test",
      PI_CLOUD_CUBESANDBOX_API_URL: "http://cube.invalid",
      PI_CLOUD_CUBESANDBOX_API_KEY_FILE: token,
      PI_CLOUD_CUBESANDBOX_TEMPLATE_ID: "tool",
      PI_CLOUD_CUBESANDBOX_DEVELOPMENT_TEMPLATE_IDS: JSON.stringify({
        starter: "tpl-starter00000000000000000",
        standard: "tpl-standard0000000000000000",
        performance: "tpl-performance0000000000000",
      }),
      PI_CLOUD_CUBESANDBOX_PROXY_NODE_IP: "127.0.0.1",
      PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_URL: "http://files.invalid:4500",
      PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE: token,
    };
    const manager = await loadSandboxControlConfig({
      ...common,
      DATABASE_URL_FILE: await file("database", "postgresql://role-test@127.0.0.1:1/unused"),
      PI_CLOUD_CONTROL_PLANE_URL: "invalid unused transport URL",
    });
    expect(manager.ownershipLeaseMs).toBe(15_000);
    expect(manager).not.toHaveProperty("kafkaBrokers");
    expect(manager).not.toHaveProperty("controlPlaneUrl");
    const execution = await loadSandboxExecutionConfig({
      ...common,
      PI_CLOUD_KAFKA_BROKERS: "kafka.invalid:9092",
      PI_CLOUD_CONTROL_PLANE_URL: "http://runtime.invalid:3000",
      DATABASE_URL_FILE: "/unused/missing-database",
      PI_CLOUD_CUBESANDBOX_API_KEY_FILE: "/unused/missing-native-key",
      PI_CLOUD_CUBESANDBOX_DEVELOPMENT_TEMPLATE_IDS: "invalid unused templates",
      PI_CLOUD_WORKSPACE_VOLUME_GATEWAY_TOKEN_FILE: "/unused/missing-storage-key",
      PI_CLOUD_SANDBOX_CONTROL_OWNERSHIP_LEASE_MS: "invalid unused duration",
      PI_CLOUD_ELASTIC_RETENTION_MS: "invalid unused duration",
    });
    expect(execution.kafkaBrokers).toEqual(["kafka.invalid:9092"]);
    expect(execution).not.toHaveProperty("cubeSandbox");
    expect(execution).not.toHaveProperty("storage");
    expect(execution).not.toHaveProperty("webProxy");
    expect(execution).not.toHaveProperty("ownershipLeaseMs");
    expect(execution).not.toHaveProperty("elasticRetentionMs");
    expect(execution).not.toHaveProperty("databaseNotificationUrl");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
