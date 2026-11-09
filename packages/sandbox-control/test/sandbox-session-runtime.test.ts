import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "@pi-cloud/database";
import { PiCloudMetrics } from "@pi-cloud/observability";
import type { Kysely } from "kysely";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { SandboxControlServer } from "../src/sandbox-control-server.ts";

const calls = vi.hoisted(() => ({
  replyStart: vi.fn(async () => {}),
  replyClose: vi.fn(async () => {}),
  providerClose: vi.fn(async () => {}),
}));
vi.mock("../src/sandbox-control-config.ts", () => ({
  loadSandboxControlConfig: async () => ({
    host: "127.0.0.1",
    port: 0,
    advertisedBaseUrl: "http://127.0.0.1:4300",
    sandboxDomainId: "fixture-domain",
    serviceToken: "fixture-service-token".repeat(4),
    terminalToken: "fixture-terminal-token".repeat(4),
    kafkaBrokers: ["unused:9092"],
    controlPlaneUrl: "http://127.0.0.1:1",
    maximumActiveCommands: 32,
  }),
}));
vi.mock("../src/cube-runtime-transport.ts", () => ({
  createCubeRuntimeTransport: async () => ({
    provider: {
      providerId: "cubesandbox",
      close: calls.providerClose,
      clearExecutionData: vi.fn(),
    },
    client: {},
  }),
}));
vi.mock("@pi-cloud/event-log", async (original) => ({
  ...(await original<typeof import("@pi-cloud/event-log")>()),
  KafkaToolReplyPublisher: class {
    start = calls.replyStart;
    close = calls.replyClose;
    publish = vi.fn();
  },
}));
import { createSandboxSessionRuntime } from "../src/sandbox-session-runtime.ts";

let directory: string;
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await mkdtemp(join(tmpdir(), "session-completion-ca-"));
  const ca = join(directory, "ca.pem");
  await writeFile(ca, "fixture-ca");
  vi.stubEnv("PI_CLOUD_COMPLETION_CA_FILE", ca);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

it("opens its real listener before bootstrap, advertises readiness only after start, and closes cleanly", async () => {
  const listen = vi.spyOn(SandboxControlServer.prototype, "listen");
  const database = {} as Kysely<Database>;
  const runtime = await createSandboxSessionRuntime({
    database,
    publicationDatabase: database,
    instanceId: "fixture-instance",
    managementToken: "fixture-management".repeat(4),
    metrics: new PiCloudMetrics("session-bootstrap-test"),
    publishBindingChanges: async () => {},
    partitionFor: () => 0,
    partitionCount: 1,
    ownerForPartition: async () => undefined,
  });
  try {
    expect(calls.replyStart).toHaveBeenCalledOnce();
    expect(listen).toHaveBeenCalledOnce();
    const address = (await listen.mock.results[0]!.value) as string;
    expect(runtime.ready).toBe(false);
    expect((await fetch(new URL("/health/live", address))).status).toBe(200);
    expect((await fetch(new URL("/health/ready", address))).status).toBe(503);
    await runtime.start();
    expect(runtime.ready).toBe(true);
    expect((await fetch(new URL("/health/ready", address))).status).toBe(200);
  } finally {
    await runtime.close();
  }
  expect(runtime.ready).toBe(false);
  await expect(runtime.start()).rejects.toThrow("closing");
  expect(calls.replyClose).toHaveBeenCalledOnce();
  expect(calls.providerClose).toHaveBeenCalledOnce();
});

it("releases the provider if callback credential loading fails before the listener opens", async () => {
  vi.stubEnv("PI_CLOUD_COMPLETION_CA_FILE", join(directory, "missing.pem"));
  await expect(
    createSandboxSessionRuntime({
      database: {} as Kysely<Database>,
      publicationDatabase: {} as Kysely<Database>,
      instanceId: "fixture-instance",
      managementToken: "fixture-management".repeat(4),
      metrics: new PiCloudMetrics("session-failed-bootstrap-test"),
      publishBindingChanges: async () => {},
      partitionFor: () => 0,
      partitionCount: 1,
      ownerForPartition: async () => undefined,
    }),
  ).rejects.toThrow("ENOENT");
  expect(calls.providerClose).toHaveBeenCalledOnce();
  expect(calls.replyStart).not.toHaveBeenCalled();
});
