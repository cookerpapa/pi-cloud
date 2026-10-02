/** Characterization probes for the review report. Assertions record the
 * current behavior; they are not acceptance criteria for a future repair. */
import { afterAll, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import Fastify from "fastify";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";

vi.mock("@pi-cloud/event-log", async (original) => ({
  ...(await original<typeof import("@pi-cloud/event-log")>()),
  KafkaLogConsumer: class {
    async start() {}
    async close() {}
    checkHealth() {
      throw new Error("Consumer recovery unavailable");
    }
    ownsPartition() {
      return false;
    }
    async ownerClientId() {
      return undefined;
    }
  },
}));
vi.mock("../packages/runtime-core/src/execution-log-topic.ts", () => ({
  ExecutionLogTopic: class {
    async start() {}
    async close() {}
    async checkHealth() {}
  },
}));
vi.mock("../packages/runtime-core/src/session-outbox-relay.ts", () => ({
  SessionOutboxRelay: class {
    start() {}
    async close() {}
    checkHealth() {}
  },
}));
vi.mock("../packages/runtime-core/src/kafka-safe-retention.ts", () => ({
  KafkaSafeRetention: class {
    start() {}
    async close() {}
    checkHealth() {}
  },
}));
import { SessionProjector } from "../packages/runtime-core/src/session-projector.ts";
import { SessionPublicationService } from "../packages/control-plane/src/session-publication-service.ts";
import { PostgresSandboxBindings } from "../packages/sandbox-control/src/sandbox-bindings.ts";
import { SandboxBindingView } from "../packages/sandbox-control/src/sandbox-binding-view.ts";
import { SubagentController } from "../packages/control-plane/src/subagent-controller.ts";
import { ImageAttachmentCodec } from "../packages/session-attachments/src/codec.ts";
import { SandboxController } from "../packages/sandbox-control/src/sandbox-controller.ts";
import { CUBESANDBOX_TOOL_POLICY } from "../packages/sandbox-control/src/index.ts";
import { InMemoryWorkspaceRuntimeStateRepository } from "../packages/sandbox-control/test/helpers/in-memory-workspace-runtime-state-repository.ts";
import { InMemorySandboxBindings } from "../packages/sandbox-control/test/helpers/in-memory-sandbox-bindings.ts";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "../packages/protocol/src/index.ts";

const evidence: Record<string, unknown> = {};
afterAll(async () => {
  if (process.env.PI_CLOUD_REVIEW_PROBE_OUTPUT)
    await writeFile(
      process.env.PI_CLOUD_REVIEW_PROBE_OUTPUT,
      JSON.stringify(evidence, null, 2) + "\n",
    );
});

it("records ready ingress while its consumer cannot recover or own a partition", async () => {
  const projector = new SessionProjector({
    database: {} as Kysely<Database>,
    notificationConnectionString: "postgresql://unused/test",
    brokers: ["unused"],
    clientId: "review",
    partitions: 2,
    replicas: 3,
    retentionMs: 600000,
    advertisedBaseUrl: "http://127.0.0.1:9",
    publicationToken: "review-token",
    toolCommands: { consume: async () => {} },
  });
  const server = Fastify();
  server.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  new SessionPublicationService("review-token", projector).install(server);
  try {
    await projector.start();
    await expect(projector.checkHealth()).rejects.toThrow("Consumer recovery unavailable");
    const headers = {
      authorization: "Bearer review-token",
      "content-type": "application/octet-stream",
    };
    const health = await server.inject({ url: "/internal/v1/session-publication/health", headers });
    const open = await server.inject({
      method: "POST",
      url: "/internal/v1/session-publication/open",
      headers,
      payload: Buffer.from(JSON.stringify({ scope: { piSessionId: randomUUID() } })),
    });
    expect(health.statusCode).toBe(200);
    expect(open.statusCode).toBe(409);
    expect(open.json().error.reason).toBe("not_owner");
    evidence.readiness = {
      transportAndDatabase: "simulated; actual Projector and HTTP service",
      healthStatus: health.statusCode,
      publicationStatus: open.statusCode,
      reason: open.json().error.reason,
    };
  } finally {
    await server.close();
    await projector.close();
  }
});

it("records that the global binding snapshot fails before filtering an empty owned partition", async () => {
  let limit = 0;
  const chain: any = {
    innerJoin: () => chain,
    select: () => chain,
    limit: (n: number) => {
      limit = n;
      return chain;
    },
    execute: async () =>
      Array.from({ length: 65537 }, () => ({ piSessionId: "belongs-to-partition-zero" })),
  };
  const db = { selectFrom: () => chain } as unknown as Kysely<Database>;
  const source = new PostgresSandboxBindings(
    db,
    randomUUID(),
    randomUUID(),
    "http://fixture",
    async () => {},
  );
  const view = new SandboxBindingView({ source, partitionFor: () => 0 });
  await expect(view.load([1], () => true)).rejects.toThrow("capacity exceeded");
  evidence.bindingBootstrap = {
    rowSource: "simulated SQL results",
    rows: 65537,
    requestedPartitions: [1],
    rowsBelongingToRequestedPartitions: 0,
    globalSqlLimit: limit,
    rejected: true,
  };
});

it("records full-row PG reads for duplicate already-known Subagent command notifications", async () => {
  const tenantId = randomUUID(),
    piSessionId = randomUUID(),
    runId = randomUUID(),
    id = randomUUID();
  const command: any = {
    kind: "subagent_command",
    factId: id,
    scope: { tenantId, piSessionId, runId, sessionId: piSessionId },
    request: { action: "send", target: "main", message: "fixture", delivery: "follow_up" },
  };
  const row: any = {
    id,
    tenant_id: tenantId,
    run_id: runId,
    partition: 0,
    ordinal: "1",
    revision: "9",
    command,
    response: { requestId: id, ok: true, result: { state: "missed" } },
    delivered_at: new Date(),
    input_consumed_at: null,
    target_session_id: null,
  };
  let reads = 0;
  const insert: any = {
    values: () => insert,
    onConflict: () => insert,
    returningAll: () => insert,
    executeTakeFirstOrThrow: async () => row,
  };
  const select: any = {
    selectAll: () => select,
    where: () => select,
    executeTakeFirst: async () => {
      reads++;
      return row;
    },
  };
  const controller = new SubagentController({
    database: { insertInto: () => insert, selectFrom: () => select } as unknown as Kysely<Database>,
    managementToken: "review-token",
    allowInsecureHttp: true,
    ownsPartition: () => true,
  });
  try {
    await controller.consume({ topic: "test", partition: 0, offset: 0n, fact: command });
    for (let i = 0; i < 5; i++)
      await controller.changed(
        {
          kind: "control_change",
          factId: randomUUID(),
          scope: { tenantId, piSessionId },
          entity: "subagent_command",
          entityId: id,
          version: "9",
          occurredAt: new Date().toISOString(),
        },
        () => true,
      );
    expect(reads).toBe(5);
    evidence.subagentEcho = {
      database: "simulated; actual controller",
      knownRevision: "9",
      duplicateNotifications: 5,
      fullRowSelects: reads,
    };
  } finally {
    await controller.close();
  }
});

it("records duplicate immutable-image reads within one decode call", async () => {
  const bytes = Buffer.from("image-byte-fixture"),
    tenantId = randomUUID();
  const get = vi.fn(async () => bytes);
  const codec = new ImageAttachmentCodec({ get, put: vi.fn() });
  const image = {
    type: "pi_cloud_image_v1",
    attachment: {
      id: randomUUID(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
      mimeType: "image/png",
    },
  };
  await codec.unpack({ tenantId }, [image, image] as any);
  expect(get).toHaveBeenCalledTimes(2);
  evidence.imageDecode = {
    references: 2,
    distinctObjects: 1,
    storeGetCalls: 2,
    byteSource: "simulated; no image-model claim",
  };
});

it("keeps resource quarantine committed when close publication fails", async () => {
  const outcomes = [];
  for (const publicationFails of [false, true]) {
    const repository = new InMemoryWorkspaceRuntimeStateRepository(),
      bindings = new InMemorySandboxBindings();
    const tenantId = randomUUID(),
      userId = randomUUID(),
      environmentId = randomUUID();
    const environment = {
      environmentVersionId: randomUUID(),
      versionNumber: 1,
      profileKey: "pi-cloud-fullstack",
      profileVersion: "1",
      imageRevision: "development",
      specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
      recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
      recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
    };
    const destroy = vi.fn(),
      errors: unknown[] = [];
    const provider: any = {
      providerApiVersion: 1,
      providerId: "cubesandbox",
      defaultPolicy: CUBESANDBOX_TOOL_POLICY,
      checkHealth: async () => {},
      pause: async () => {},
      resume: async (handle: any) => handle,
      create: async (spec: any) => ({
        providerApiVersion: 1,
        providerId: "cubesandbox",
        runtimeNodeId: "node-test",
        activationId: spec.activationId,
        runtimeId: randomUUID(),
        runtimeName: "review-vm",
        workspaceRoot: spec.toolRoot,
        assignment: spec.assignment,
        environment: spec.environment,
        environmentValidation: {
          ...spec.environment,
          isolationBoundary: "microvm",
          runtime: "cubesandbox-kvm",
          runAsUser: "1000:1000",
          networkMode: "public_web_proxy_private_denied",
          readOnlyRootFilesystem: false,
          tools: [],
          recipeCommands: [],
        },
      }),
      openTerminal: async () => {
        throw new Error("unused fixture port");
      },
      adoptPersistentCapsule: async () => {
        throw new Error("unused fixture port");
      },
      persistentCapsule: async (handle: any) => ({ handle, capsule: "fixture" }),
      detachPersistent: async () => {},
      executionIdentity: () => environmentId,
      observeRuntimeInventory: async () => new Map(),
      observeRuntime: async () => ({
        runtimeName: "review-vm",
        nodeId: "node-test",
        presence: "present",
        state: "stopped",
      }),
      probeExecution: async () => {},
      inspect: async () => ({ state: "running" }),
      destroy,
      close: async () => {},
    };
    const manager = new SandboxController({
      provider,
      stateRepository: repository,
      bindings,
      ownerBaseUrl: "http://fixture",
      imageRevision: "development",
      onMaintenanceError: (error) => errors.push(error),
    });
    repository.onQuarantine = (id) => bindings.commitPhysicalClosure(id);
    const close = bindings.confirmPhysicalClosure.bind(bindings);
    vi.spyOn(bindings, "confirmPhysicalClosure").mockImplementation(async (id) => {
      await close(id);
      if (publicationFails) throw new Error("Publication unavailable after binding closure commit");
    });
    try {
      await manager.provisionDevelopmentEnvironment({
        developmentEnvironmentProtocolVersion: 1,
        type: "development_environment.provision",
        requestId: randomUUID(),
        environmentId,
        tenantId,
        userId,
        projectId: randomUUID(),
        workspaceId: randomUUID(),
        generation: 1,
        profileKey: "standard",
        environment,
        workspaceSeed: { kind: "empty" },
      } as any);
      // A persisted binding belongs to this existing physical machine. The
      // simulated close commits it closed before losing publication confirmation.
      const bindingId = randomUUID();
      bindings.rows.set(bindingId, {
        bindingId,
        instanceId: "fixture",
        baseUrl: "http://fixture",
        dispatchClosed: false,
        descriptor: {} as any,
        snapshot: { physicalActivationId: environmentId } as any,
      });
      await manager.observeRuntimeHealth();
      const state = await repository.developmentEnvironmentOwner(tenantId, userId, environmentId);
      expect(state.status).toBe("owned");
      outcomes.push({
        publicationFails,
        resourceState: state.status === "owned" ? state.state : null,
        bindingClosed: bindings.rows.get(bindingId)?.dispatchClosed,
        errors: errors.length,
        destroyCalls: destroy.mock.calls.length,
      });
    } finally {
      await manager.close();
    }
  }
  expect(outcomes.map((v) => v.resourceState)).toEqual(["unknown", "unknown"]);
  evidence.quarantine = {
    dependencies:
      "provider, binding publication and PG repository simulated; actual health monitor/controller",
    outcomes,
  };
});
