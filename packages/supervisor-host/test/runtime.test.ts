import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type { AgentTurnScenarioContext } from "@pi-cloud/sandbox-supervisor";
import { AcceptedFactPublisherFailedError } from "@pi-cloud/runtime-core/accepted-fact";
import {
  PostgresSupervisorCredentialAuthorizer,
  SupervisorBootProvisioner,
  SupervisorConnectionManager,
  SupervisorWebSocketGateway,
} from "@pi-cloud/control-plane";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PRODUCTION_CANCELLATION_PROBE_PROMPT,
  resolveProductionSandboxScenario,
  PiWorkerRuntime,
  TenantModelGateway,
  type SupervisorHostConfig,
  type SupervisorToolBroker,
  type SupervisorRunWorker,
  type PostgresPiWorkerOptions,
} from "../src/index.ts";

const CONTROL_PLANE_ID = "90000000-0000-4000-8000-000000000001";
const SUPERVISOR_ID = "supervisor-host-runtime-test";
const ENROLLMENT_TOKEN = `enrollment-${"e".repeat(48)}`;
const MANAGEMENT_TOKEN = `management-${"m".repeat(48)}`;

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;
let connectionString: string;

function runWorker(): SupervisorRunWorker {
  let state: SupervisorRunWorker["state"] = "idle";
  return {
    get state() {
      return state;
    },
    async start() {
      state = "running";
    },
    async stop() {
      state = "stopped";
    },
  };
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: pglite,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 6,
  });
  await socketServer.start();
  connectionString = `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`;
  database = createDatabase({ connectionString, maxConnections: 6 });
  await runMigrations(database, "up");
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

function toolBroker(): SupervisorToolBroker {
  return {
    async refreshServices() {},
    operationResultUrlFor: () => "http://tool-broker.test/internal/v1/tool-operation",
    async checkHealth() {},
    async create() {
      throw new Error("unused");
    },
    async forkWorkspace() {
      throw new Error("unused");
    },
    async release() {
      throw new Error("unused");
    },
    async stop() {},
    async listAssignments() {
      return [];
    },
    async terminateAndConfirmAbsent() {
      throw new Error("No assignments exist");
    },
    async confirmAbsent() {},
  };
}

describe("PiWorkerRuntime", () => {
  it("keeps the production fixture closed while providing a deterministic cancellation probe", () => {
    const context = (text: string) =>
      ({
        command: { payload: { input: { kind: "prompt", text } } },
      }) as AgentTurnScenarioContext;

    expect(resolveProductionSandboxScenario(context("repair the Java fixture"))).toBe(
      "java_repair",
    );
    expect(resolveProductionSandboxScenario(context(PRODUCTION_CANCELLATION_PROBE_PROMPT))).toBe(
      "tool_hold",
    );
  });

  it("provisions a fresh generation, registers after recovery, and never reuses boot identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-cloud-host-runtime-"));
    const server = Fastify({ logger: false });
    server.head("/healthz", async (_request, reply) => reply.code(200).send());
    const provisioner = new SupervisorBootProvisioner({
      database,
      allowedSupervisorIdPrefix: "supervisor-host-runtime-",
      managementBaseUrlTemplates: ["http://{supervisorId}:4100"],
      maximumCapacity: 4,
      enrollmentToken: ENROLLMENT_TOKEN,
    });
    const manager = new SupervisorConnectionManager({
      database,
      controlPlaneInstanceId: CONTROL_PLANE_ID,
      ownerBoundary: { async stopAndConfirm() {} },
      assignmentRetirerFactory: () => ({
        async retireExpiredAssignments() {
          return {
            inspectedRuntimes: 0,
            terminatedRuntimes: 0,
            orphanRuntimes: 0,
            settledAssignments: 0,
            requeuedAssignments: 0,
          };
        },
        async retireSandbox() {
          return {
            inspectedRuntimes: 0,
            terminatedRuntimes: 0,
            orphanRuntimes: 0,
            settledAssignments: 0,
            requeuedAssignments: 0,
            sandboxState: "terminated" as const,
          };
        },
      }),
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 500,
    });
    const gateway = new SupervisorWebSocketGateway({
      manager,
      authorizer: new PostgresSupervisorCredentialAuthorizer({ database }),
    });
    gateway.install(server);
    const address = await server.listen({ host: "127.0.0.1", port: 0 });
    const runWorkerOptions: PostgresPiWorkerOptions[] = [];
    const runWorkerFactory = (options: PostgresPiWorkerOptions): SupervisorRunWorker => {
      runWorkerOptions.push(options);
      return runWorker();
    };
    let toolBrokerHealthy = true;
    let publisherFailure: Error | undefined;
    const runtimeToolBroker: SupervisorToolBroker = {
      ...toolBroker(),
      async checkHealth() {
        if (!toolBrokerHealthy) throw new Error("Tool Broker unavailable");
      },
    };
    const baseConfig: SupervisorHostConfig = {
      supervisorId: SUPERVISOR_ID,
      controlPlaneBaseUrl: address,
      supervisorWebSocketUrl: `${address.replace(/^http/, "ws")}/internal/v1/supervisor`,
      allowInsecureInternalHttp: true,
      enrollmentToken: ENROLLMENT_TOKEN,
      managementToken: MANAGEMENT_TOKEN,
      toolBrokerServiceToken: `tool-broker-${"s".repeat(48)}`,
      providerGatewayBaseUrl: address,
      providerGatewayApiKey: `provider-${"k".repeat(48)}`,
      databaseUrl: connectionString,
      databaseNotificationUrl: connectionString,
      kafka: { brokers: ["unused:9092"], partitions: 32, replicas: 3, retentionMs: 7200000 },
      managementHost: "127.0.0.1",
      managementPort: 0,
      managementAdvertisedBaseUrl: `http://${SUPERVISOR_ID}:4100`,
      maxConcurrentSessions: 4,
      databaseMaxConnections: 6,
      subagentMaximumDepth: 4,
      subagentMaximumNodes: 32,
      modelConcurrency: 4,
      familyModelConcurrency: 4,
      toolBrokerBaseUrls: ["http://tool-broker.test:4300/"],
      toolBrokerRequestTimeoutMs: 300_000,
      trustedWorkspaceDirectory: root,
      bootStateDirectory: join(root, "boot"),
      modelGatewayHost: "127.0.0.1",
      modelGatewayPort: 0,
      modelGatewayAdvertisedBaseUrl: "http://model-gateway.test:4200",
      modelGatewayCapabilityTtlMs: 60_000,
      modelGatewayMaximumRequestsPerTurn: 8,
      modelGatewayUpstreamConnectTimeoutMs: 10_000,
      modelGatewayUpstreamIdleTimeoutMs: 30_000,
      piModelRequestTimeoutMs: 15_000,
      piTurnTimeoutMs: 60_000,
    };
    expect(
      () =>
        new PiWorkerRuntime({
          config: {
            ...baseConfig,
            maxConcurrentSessions: 17,
          },
          database,

          toolBroker: runtimeToolBroker,
          runWorkerFactory,
        }),
    ).toThrow("Pi SDK Worker runtime capacity must be between 1 and 16");
    expect(
      () =>
        new PiWorkerRuntime({
          config: {
            ...baseConfig,
            databaseMaxConnections: 65,
          },
          database,

          toolBroker: runtimeToolBroker,
          runWorkerFactory,
        }),
    ).toThrow("Pi SDK Worker database pool must be between 2 and 64 connections");
    let first: PiWorkerRuntime | undefined;
    let second: PiWorkerRuntime | undefined;
    try {
      first = new PiWorkerRuntime({
        config: baseConfig,
        database,

        toolBroker: runtimeToolBroker,
        runWorkerFactory,
        executionLogs: {
          async open() {
            throw new Error("unused");
          },
          async checkHealth() {
            if (publisherFailure) throw publisherFailure;
          },
        },
        sessionMutationProducer: {
          scoped() {
            return { async publish() {} };
          },
          async checkHealth() {
            if (publisherFailure) throw publisherFailure;
          },
          async close() {},
        },
        provisioningClient: { provision: (request) => provisioner.provision(request) },
      });
      await first.start();
      expect(first.state).toBe("ready");
      const firstIdentity = first.identity!;
      expect(gateway.activeConnectionCount).toBe(1);
      await first.close();
      expect(first.state).toBe("stopped");

      second = new PiWorkerRuntime({
        config: baseConfig,
        database,

        toolBroker: runtimeToolBroker,
        runWorkerFactory,
        executionLogs: {
          async open() {
            throw new Error("unused");
          },
          async checkHealth() {
            if (publisherFailure) throw publisherFailure;
          },
        },
        sessionMutationProducer: {
          scoped() {
            return { async publish() {} };
          },
          async checkHealth() {},
          async close() {},
        },
        provisioningClient: { provision: (request) => provisioner.provision(request) },
      });
      await second.start();
      expect(second.state).toBe("ready");
      const secondIdentity = second.identity!;
      expect(secondIdentity.bootId).not.toBe(firstIdentity.bootId);
      expect(secondIdentity.sandboxId).not.toBe(firstIdentity.sandboxId);

      const oldSandbox = await database
        .selectFrom("sandboxes")
        .select("state")
        .where("id", "=", firstIdentity.sandboxId)
        .executeTakeFirstOrThrow();
      expect(oldSandbox.state).toBe("failed");
      const activeCredential = await database
        .selectFrom("supervisor_boot_credentials")
        .select("boot_id")
        .where("supervisor_id", "=", SUPERVISOR_ID)
        .where("revoked_at", "is", null)
        .executeTakeFirstOrThrow();
      expect(activeCredential.boot_id).toBe(secondIdentity.bootId);
      expect(runWorkerOptions).toHaveLength(2);
      expect(runWorkerOptions.map((options) => options.maximumActiveFamilies)).toEqual([4, 4]);
      expect(runWorkerOptions.map((options) => options.maximumLanesPerFamily)).toEqual([33, 33]);
      expect(runWorkerOptions.map((options) => options.canClaimRuns?.())).toEqual([false, true]);
      await expect(runWorkerOptions[1]?.admitRunClaims?.()).resolves.toBe(true);
      toolBrokerHealthy = false;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_100));
      await expect(runWorkerOptions[1]?.admitRunClaims?.()).resolves.toBe(true);

      const ledger = JSON.parse(await readFile(join(root, "boot", "boot-ledger.json"), "utf8")) as {
        state: { history: Array<{ bootId: string; status: string }> };
      };
      expect(ledger.state.history).toContainEqual(
        expect.objectContaining({ bootId: firstIdentity.bootId, status: "exited" }),
      );

      publisherFailure = new Error("temporary metadata outage");
      await vi.waitFor(
        async () => {
          await expect(runWorkerOptions[1]?.admitRunClaims?.()).resolves.toBe(false);
        },
        { timeout: 2_000, interval: 25 },
      );
      expect(second.state).toBe("ready");
      publisherFailure = undefined;
      await vi.waitFor(
        async () => {
          await expect(runWorkerOptions[1]?.admitRunClaims?.()).resolves.toBe(true);
        },
        { timeout: 2_000, interval: 25 },
      );
      let terminal: string | undefined;
      void second.waitUntilTerminal().then((reason) => {
        terminal = reason;
      });
      publisherFailure = new AcceptedFactPublisherFailedError(
        new Error("producer stream destroyed"),
      );
      await vi.waitFor(() => expect(terminal).toBe("connection_failed"), {
        timeout: 2_000,
        interval: 25,
      });
      expect(second.state).toBe("failed");
      expect(second.terminalFailureCode).toBe("event_publisher_failed");
      publisherFailure = undefined;

      await second.close();
      const gateways: TenantModelGateway[] = [];
      const startGateway = TenantModelGateway.prototype.start;
      const started = vi
        .spyOn(TenantModelGateway.prototype, "start")
        .mockImplementation(async function (this: TenantModelGateway) {
          await startGateway.call(this);
          gateways.push(this);
        });
      const health = vi
        .spyOn(TenantModelGateway.prototype, "checkProviderHealth")
        .mockRejectedValueOnce(new Error("test upstream is unavailable"));
      const failed = new PiWorkerRuntime({
        config: {
          ...baseConfig,
          supervisorId: `${SUPERVISOR_ID}-failed`,
          bootStateDirectory: join(root, "failed-boot"),
        },
        database,
        toolBroker: runtimeToolBroker,
        runWorkerFactory,
        // Startup fails at model health, before any queue/log connection starts.
        provisioningClient: {
          async provision() {
            return { accepted: true } as never;
          },
        },
      });
      try {
        await expect(failed.start()).rejects.toMatchObject({ code: "pi_worker_start_failed" });
        await failed.close();
        expect(gateways).toHaveLength(1);
        expect(() => gateways[0]!.listeningPort).toThrow("not listening");
      } finally {
        started.mockRestore();
        health.mockRestore();
        for (const gateway of gateways) await gateway.close();
      }
    } finally {
      await second?.close().catch(() => undefined);
      await first?.close().catch(() => undefined);
      gateway.shutdown();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
