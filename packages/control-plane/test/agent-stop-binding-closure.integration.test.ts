import { randomUUID } from "node:crypto";
import { Admin } from "@platformatic/kafka";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import type { ExecutionLogPosition } from "@pi-cloud/protocol";
import type { ExecutionPublication } from "../../runtime-core/src/accepted-fact.ts";
import { SessionProjector } from "../../runtime-core/src/session-projector.ts";
import { SessionControlOutbox } from "../../runtime-core/src/session-control-outbox.ts";
import { PostgresSandboxBindings } from "../../sandbox-control/src/sandbox-bindings.ts";
import { SandboxBindingView } from "../../sandbox-control/src/sandbox-binding-view.ts";
import { ToolCommandDispatcher } from "../../sandbox-control/src/tool-command-dispatcher.ts";
import { PostgresWorkspaceRuntimeStateRepository } from "../../sandbox-control/src/workspace-runtime-state-repository.ts";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { createTestWorker } from "./admit-test-execution.ts";

const postgres = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");
it.skipIf(!postgres || !brokers)(
  "seals after routing revocation without waiting for a Cube process through real PG/Kafka",
  async () => {
    const name = `ordered_cube_${randomUUID().replaceAll("-", "")}`,
      topic = `ordered-cube-${randomUUID()}`;
    const admin = createDatabase({ connectionString: postgres!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const endpoint = new URL(postgres!);
    endpoint.pathname = `/${name}`;
    const database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 8 });
    const kafka = new Admin({ clientId: topic, bootstrapBrokers: brokers! });
    const finish = Promise.withResolvers<void>();
    let projector: SessionProjector | undefined, execution: Promise<unknown> | undefined;
    const ownerId = randomUUID();
    const owner = new PostgresWorkspaceRuntimeStateRepository({
      database,
      instanceId: ownerId,
      sandboxDomainId: "sandbox-domain-0001",
      ownerBaseUrl: "http://127.0.0.1:9",
    });
    try {
      await runMigrations(database, "up");
      await owner.start();
      const tenant = await createPrivateTenant(database, {
        slug: name.replaceAll("_", "-"),
        ownerDisplayName: "Ordered Cube",
      });
      const store = new ControlPlaneStore({ database, ...tenant });
      const project = await store.createProject({
        name: "Ordered Cube",
        source: { kind: "empty" },
      });
      const session = await store.createSession(
        project.projectId,
        project.workspaceId,
        "Ordered Cube",
        "elastic",
      );
      const changes = new SessionControlOutbox(database, {
        publishControl: (change) => projector!.publishControl(change),
      });
      const bindings = new PostgresSandboxBindings(
        database,
        "sandbox-domain-0001",
        ownerId,
        "http://127.0.0.1:9",
        (ids) => changes.flushEntities("sandbox_binding", ids),
      );
      const view = new SandboxBindingView({
        source: bindings,
        partitionCount: 1,
        partitionFor: () => 0,
      });
      const positions: ExecutionLogPosition[] = [];
      const submit = vi.fn(async () => {});
      const dispatcher = new ToolCommandDispatcher({
        routes: view,
        // Cube receives no stop RPC. Run settlement depends only on routing revocation.
        cube: { submitTool: submit },
        workflow: async () => {},
        publishReply: async () => {},
        quarantine: async () => {
          throw new Error("unexpected quarantine");
        },
      });
      projector = new SessionProjector({
        database,
        notificationConnectionString: endpoint.toString(),
        brokers: brokers!,
        topic,
        clientId: topic,
        partitions: 1,
        replicas: 3,
        retentionMs: 600000,
        publicationToken: "fixture-".repeat(8),
        advertisedBaseUrl: "http://127.0.0.1:9",
        toolCommands: dispatcher,
        controlChanges: {
          load: (p, c) => view.load(p, c),
          reset: () => view.reset(),
          prepare: (change, c) => view.prepare(change, c),
          consume: async (change, current, position) => {
            await view.consume(change, current);
            if (change.entity !== "sandbox_binding" || !change.closed) return;
            const route = view.closure(change, current);
            if (!route) return;
            positions.push(position);
            await dispatcher.closeWorkflowBinding(change, route, position, current);
          },
        },
      });
      await projector.start();
      await vi.waitFor(() => expect(projector!.ownsPartition(0)).toBe(true), { timeout: 30000 });
      const accepted = await store.acceptTurn(session.sessionId, "ordered", {
        prompt: "closure fixture",
      });
      const worker = await createTestWorker(database);
      const entered = Promise.withResolvers<{
        publication: ExecutionPublication;
        executionReference: string;
      }>();
      execution = worker
        .executor({
          execute: async (_r, _l, admission) => {
            entered.resolve(admission!);
            await finish.promise;
            return { stopReason: "stop" };
          },
        })
        .dispatchRun(accepted.runId);
      void execution.catch(entered.reject);
      const admission = await entered.promise;
      await projector.openPublication(admission.publication);
      const bindingId = randomUUID();
      const assignment = {
        tenantId: tenant.tenantId,
        projectId: project.projectId,
        workspaceId: project.workspaceId,
        supervisorId: "fixture",
        bootId: randomUUID(),
        sandboxId: randomUUID(),
        sessionId: session.sessionId,
        turnId: accepted.turnId,
        runId: accepted.runId,
        executionReference: admission.executionReference,
      };
      await bindings.register(
        bindingId,
        {
          version: 1,
          target: {
            apiUrl: "http://cube.test",
            sandboxId: "a".repeat(32),
            nodeId: "node",
            bootId: randomUUID(),
          },
          initialization: {} as never,
        },
        {
          assignment,
          physicalActivationId: randomUUID(),
          turnContextSha256: "a".repeat(64),
          executionContextSha256: "b".repeat(64),
          allowedTools: ["bash"],
          sandboxProfileKey: "standard",
        },
      );
      finish.resolve();
      await execution;
      await vi.waitFor(() => expect(positions.length).toBe(1), { timeout: 15000 });
      const run = () =>
        database
          .selectFrom("runs")
          .select(["output_sealed_at", "output_seal_offset"])
          .where("id", "=", accepted.runId)
          .executeTakeFirstOrThrow();
      await vi.waitFor(async () => expect((await run()).output_sealed_at).not.toBeNull(), {
        timeout: 20000,
      });
      expect(positions[0]).toMatchObject({ topic, partition: 0 });
      expect(BigInt(positions[0]!.offset)).toBeGreaterThan(0n);
      expect(BigInt((await run()).output_seal_offset!)).toBeGreaterThan(
        BigInt(positions[0]!.offset),
      );
      expect(submit).not.toHaveBeenCalled();
      await bindings.release(bindingId, assignment);
      process.stdout.write(
        JSON.stringify({
          measurement: "agent_seal_without_cube_stop",
          realPostgresKafka: true,
          closeBeforeSeal: true,
          cubeStopRequired: false,
        }) + "\n",
      );
    } finally {
      finish.resolve();
      await execution?.catch(() => {});
      await projector?.close();
      await owner.close();
      await database.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
      await kafka.deleteTopics({ topics: [topic] });
      await kafka.close();
    }
  },
  90000,
);
