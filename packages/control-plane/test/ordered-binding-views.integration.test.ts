import { installBinaryBodyParser } from "../src/binary-body-parser.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { sql } from "kysely";
import { Admin } from "@platformatic/kafka";
import { expect, it, vi } from "vitest";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import {
  createExecutionReference,
  parseSessionControlChange,
  SESSION_CONTROL_OUTBOX_TOPIC,
} from "@pi-cloud/protocol";
import { SessionProjector } from "../../runtime-core/src/session-projector.ts";
import { SessionControlOutbox } from "../../runtime-core/src/session-control-outbox.ts";
import { HttpPublicationClient } from "../../runtime-core/src/http-publication-client.ts";
import { PostgresSandboxBindings } from "../../sandbox-control/src/sandbox-bindings.ts";
import { SandboxBindingView } from "../../sandbox-control/src/sandbox-binding-view.ts";
import type { SandboxExecutionDescriptor } from "../../sandbox-control/src/sandbox-execution.ts";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { SessionPublicationService } from "../src/session-publication-service.ts";
import { InputQueueView } from "../src/input-queue-view.ts";
import { readInputQueue } from "../src/input-queue-snapshot.ts";
import { QueuedInputService } from "../src/queued-input-service.ts";

const postgres = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");

it.skipIf(!postgres || !brokers)(
  "projects binding changes through RF3 Kafka, closes before lost ACK and restores without native history",
  async () => {
    const name = `bindings_${randomUUID().replaceAll("-", "")}`,
      topic = `binding-views-${randomUUID()}`;
    const admin = createDatabase({ connectionString: postgres!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const endpoint = new URL(postgres!);
    endpoint.pathname = `/${name}`;
    const database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 8 });
    const kafka = new Admin({ clientId: topic, bootstrapBrokers: brokers! });
    const context = new AsyncLocalStorage<boolean>(),
      queries: string[] = [];
    const measured = database.withPlugin({
      transformQuery({ node, queryId }) {
        if (context.getStore())
          queries.push(database.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const server = Fastify({ logger: false }),
      token = `control-${randomUUID()}`;
    let projector: SessionProjector | undefined, client: HttpPublicationClient | undefined;
    let loseControlAck = false;
    let controlRequests = 0;
    let closedAdmissionGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
    server.addHook("onRequest", (request, _reply, done) => {
      if (request.url.endsWith("/control")) controlRequests++;
      done();
    });
    installBinaryBodyParser(server);
    server.addHook("onSend", (request, reply, payload, done) => {
      if (loseControlAck && request.url.endsWith("/control")) {
        loseControlAck = false;
        reply.raw.destroy();
      }
      done(null, payload);
    });
    new SessionPublicationService(token, {
      publicationAvailability: () => projector!.publicationAvailability(),
      localPublicationAvailability: () => projector!.localPublicationAvailability(),
      publicationPartition: (id) => projector!.publicationPartition(id),
      ownerForPartition: (p) => projector!.ownerForPartition(p),
      acceptSeal: (f) => projector!.acceptSeal(f),
      acceptControl: (f) => projector!.acceptControl(f),
    }).install(server);
    try {
      await runMigrations(database, "up");
      const tenant = await createPrivateTenant(database, {
        slug: name.replaceAll("_", "-"),
        ownerDisplayName: "Binding view acceptance",
      });
      const store = new ControlPlaneStore({ database, ...tenant });
      const project = await store.createProject({
        name: "Binding metadata fixture",
        source: { kind: "empty" },
      });
      const session = await store.createSession(
        project.projectId,
        project.workspaceId,
        "Cold control changes",
        "elastic",
      );
      const run = await store.acceptTurn(session.sessionId, "fixture", {
        prompt: "Metadata only; no execution",
      });
      const workspace = await database
        .selectFrom("workspaces")
        .select("sandbox_domain_id")
        .where("id", "=", project.workspaceId)
        .executeTakeFirstOrThrow();
      const url = await server.listen({ host: "127.0.0.1", port: 0 }),
        owner = randomUUID();
      await database
        .insertInto("sandbox_control_instances")
        .values({
          instance_id: owner,
          sandbox_domain_id: workspace.sandbox_domain_id,
          owner_base_url: url,
          state: "ready",
          lease_expires_at: new Date(Date.now() + 3600000),
          last_heartbeat_at: new Date(),
        })
        .execute();
      client = new HttpPublicationClient({ baseUrl: url, token });
      const outbox = new SessionControlOutbox(measured, client);
      const bindings = new PostgresSandboxBindings(
        measured,
        workspace.sandbox_domain_id,
        owner,
        url,
        (ids) => outbox.flushEntities("sandbox_binding", ids),
      );
      let view: SandboxBindingView;
      let inputView: InputQueueView;
      const create = () => {
        view = new SandboxBindingView({
          source: bindings,
          partitionCount: 1,
          partitionFor: () => 0,
        });
        inputView = new InputQueueView({
          read: (tenant, session) => readInputQueue(measured, tenant, session),
          watched: (tenant, session) =>
            projector?.eventHub.hasSubscribers(tenant, session) === true,
          publish: (tenant, queue) => projector?.eventHub.publishInputQueue(tenant, queue),
          unavailable: (tenant, session) => projector?.eventHub.resyncSession(tenant, session),
        });
        return new SessionProjector({
          database: measured,
          notificationConnectionString: endpoint.toString(),
          brokers: brokers!,
          clientId: topic,
          topic,
          partitions: 1,
          replicas: 3,
          retentionMs: 600000,
          advertisedBaseUrl: url,
          publicationToken: token,
          controlChanges: {
            load: (partitions, current) => view.load(partitions, current),
            reset: () => {
              view.reset();
              inputView.reset();
            },
            prepare: async (change, current) => {
              await view.prepare(change, current);
              if (change.entity === "sandbox_binding" && change.closed)
                await closedAdmissionGate?.promise;
            },
            consume: async (change, current) => {
              await view.consume(change, current);
              await inputView.consume(change, current);
            },
          },
          toolCommands: { consume: async () => {} },
        });
      };
      projector = create();
      await projector.start();
      await vi.waitFor(() => expect(projector!.ownsPartition(0)).toBe(true), { timeout: 30000 });
      const writer = randomUUID(),
        binding = randomUUID();
      const scope = { tenantId: tenant.tenantId, runId: run.runId, writerId: writer };
      const assignment = {
        ...scope,
        sessionId: session.sessionId,
        turnId: run.turnId,
        projectId: project.projectId,
        workspaceId: project.workspaceId,
        supervisorId: randomUUID(),
        sandboxId: randomUUID(),
        bootId: randomUUID(),
        executionReference: createExecutionReference(writer, run.runId, 1),
      };
      // No VM or Agent runs here. This fixture specifically exercises control
      // publication without a native writer; Tool transport has separate tests.
      await bindings.register(
        binding,
        {
          version: 1,
          target: {
            apiUrl: "http://cube.test",
            sandboxId: "fixture",
            nodeId: "node",
            bootId: randomUUID(),
          },
          initialization: {} as SandboxExecutionDescriptor["initialization"],
        },
        {
          assignment,
          physicalActivationId: randomUUID(),
          turnContextSha256: "a".repeat(64),
          executionContextSha256: "b".repeat(64),
          allowedTools: ["bash"],
          sandboxProfileKey: "starter",
        },
      );
      await vi.waitFor(async () => expect(await view!.find(scope)).toHaveLength(1), {
        timeout: 10000,
      });
      const changeRow = await database
        .selectFrom("outbox")
        .select("payload")
        .where("topic", "=", SESSION_CONTROL_OUTBOX_TOPIC)
        .where("aggregate_id", "=", binding)
        .executeTakeFirstOrThrow();
      const change = parseSessionControlChange(changeRow.payload);
      if (change.entity !== "sandbox_binding") throw new Error("Expected binding change");
      await expect(client.publishControl({ ...change, closed: true })).rejects.toThrow();
      expect("append" in client).toBe(false);
      expect((await view!.find(scope))[0]?.dispatchClosed).toBe(false);
      await context.run(true, async () => {
        for (let i = 0; i < 100; i++) expect(await view!.find(scope)).toHaveLength(1);
      });
      expect(queries).toEqual([]);
      const subscription = projector.eventHub.subscribe(tenant.tenantId, session.sessionId);
      const queueService = new QueuedInputService({
        database,
      });
      const initialQueue = await queueService.list(tenant.tenantId, session.sessionId);
      await queueService.mutate(
        tenant.tenantId,
        session.sessionId,
        run.turnId,
        "edit-without-worker",
        {
          action: "edit",
          revision: initialQueue.revision,
          text: "Edited queue from another tab",
        },
      );
      await vi.waitFor(
        () =>
          expect(inputView!.current(tenant.tenantId, session.sessionId)?.items[0]?.text).toBe(
            "Edited queue from another tab",
          ),
        { timeout: 10000 },
      );
      const wake = await subscription.next(1000);
      expect(wake).toMatchObject({
        inputQueue: { items: [{ text: "Edited queue from another tab" }] },
      });
      await context.run(true, async () => {
        for (let i = 0; i < 100; i++)
          expect(inputView!.current(tenant.tenantId, session.sessionId)?.items).toHaveLength(1);
      });
      expect(queries).toEqual([]);
      subscription.close();
      await expect(
        database.transaction().execute(async (tx) => {
          await tx
            .updateTable("sandbox_tool_bindings")
            .set({ dispatch_closed: true })
            .where("binding_id", "=", binding)
            .execute();
          throw new Error("rollback closure");
        }),
      ).rejects.toThrow("rollback closure");
      expect((await bindings.find(scope))[0]?.dispatchClosed).toBe(false);
      expect(
        await database
          .selectFrom("outbox")
          .select("id")
          .where("topic", "=", SESSION_CONTROL_OUTBOX_TOPIC)
          .where(sql<string>`payload->>'entity'`, "=", "sandbox_binding")
          .execute(),
      ).toHaveLength(1);
      loseControlAck = true;
      closedAdmissionGate = Promise.withResolvers<void>();
      const previousRequests = controlRequests;
      const closing = bindings.closeWriter(scope, false);
      void closing.catch(() => {});
      await vi.waitFor(() => expect(controlRequests).toBeGreaterThan(previousRequests), {
        timeout: 10000,
      });
      await vi.waitFor(async () => expect((await view!.find(scope))[0]?.dispatchClosed).toBe(true));
      closedAdmissionGate.resolve();
      await expect(closing).rejects.toThrow();
      expect((await view!.find(scope))[0]?.dispatchClosed).toBe(true);
      await bindings.closeWriter(scope, false);
      await projector.close();
      projector = create();
      await projector.start();
      await vi.waitFor(() => expect(projector!.ownsPartition(0)).toBe(true), { timeout: 30000 });
      expect((await view!.find(scope))[0]?.dispatchClosed).toBe(true);
      await bindings.release(binding, assignment);
      await vi.waitFor(async () => expect(await view!.find(scope)).toEqual([]), {
        timeout: 10000,
      });
      expect((await sql`select 1 from pi_durable_log`.execute(database)).rows).toEqual([]);
      process.stdout.write(
        JSON.stringify({
          measurement: "ordered_binding_view",
          hotReads: 100,
          hotSqlQueries: queries.length,
          lostAckClosure: true,
          restoredClosed: true,
          noNativeHistory: true,
          queuePushedWithoutWorker: true,
        }) + "\n",
      );
    } finally {
      closedAdmissionGate?.resolve();
      await client?.close().catch(() => {});
      await projector?.close().catch(() => {});
      await server.close();
      await database.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
      await kafka.deleteTopics({ topics: [topic] }).catch(() => {});
      await kafka.close();
    }
  },
  90000,
);
