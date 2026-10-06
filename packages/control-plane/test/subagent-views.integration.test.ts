import { randomUUID } from "node:crypto";
import { Admin } from "@platformatic/kafka";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import type { SubagentControlResult, SubagentControlRequest } from "@pi-cloud/protocol";
import type {
  AcceptedSubagentCommand,
  ExecutionPublication,
} from "../../runtime-core/src/accepted-fact.ts";
import { SessionProjector } from "../../runtime-core/src/session-projector.ts";
import { SubagentController } from "../src/subagent-controller.ts";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { createTestWorker } from "./admit-test-execution.ts";
import { durableFamilyFixture } from "@pi-cloud/pi-session-postgres/testing";

const postgres = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
const brokers = process.env.PI_CLOUD_KAFKA_INTEGRATION_BROKERS?.split(",");
it.skipIf(!postgres || !brokers)(
  "wakes a waiting Subagent from a PG control change through Kafka without idle scans",
  async () => {
    const name = `subagent_views_${randomUUID().replaceAll("-", "")}`,
      topic = `subagent-views-${randomUUID()}`;
    const admin = createDatabase({ connectionString: postgres!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const endpoint = new URL(postgres!);
    endpoint.pathname = `/${name}`;
    const database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 8 });
    const kafka = new Admin({ clientId: topic, bootstrapBrokers: brokers! });
    const queries: string[] = [],
      replies = new Map<string, SubagentControlResult>();
    const seenChanges = new Set<string>();
    const measured = database.withPlugin({
      transformQuery({ node, queryId }) {
        queries.push(database.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    let projector: SessionProjector | undefined, host: SubagentController | undefined;
    const finish = Promise.withResolvers<void>();
    let execution: Promise<unknown> | undefined;
    let family: Awaited<ReturnType<typeof durableFamilyFixture>> | undefined;
    try {
      await runMigrations(database, "up");
      const tenant = await createPrivateTenant(database, {
        slug: name.replaceAll("_", "-"),
        ownerDisplayName: "Subagent control acceptance",
      });
      const store = new ControlPlaneStore({ database, ...tenant });
      const project = await store.createProject({
        name: "Subagent control views",
        source: { kind: "empty" },
      });
      const session = await store.createSession(
        project.projectId,
        project.workspaceId,
        "Control only",
        "elastic",
      );
      family = await durableFamilyFixture(database, tenant.tenantId, session.sessionId);
      host = new SubagentController({
        database: measured,
        managementToken: "fixture-".repeat(8),
        allowInsecureHttp: true,
        ownsPartition: (partition) => projector?.ownsPartition(partition) === true,
        // The trusted Runner port is simulated; no VM/model execution is claimed.
        deliver: async (_lease, request) => {
          if (request.action === "prepare_conversation")
            return family!.nativeConversations.createChildConversation({
              executionReference: request.executionReference,
              requestId: request.requestId,
              ownerTaskId: request.ownerTaskId,
              at: request.anchor,
            });
          if (request.action === "result")
            replies.set(request.response.requestId, request.response);
        },
      });
      const agent = host;
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
        toolCommands: { consume: async () => {} },
        subagentCommands: agent,
        controlChanges: {
          load: (p, c) => agent.recover(p, c),
          reset: () => agent.reset(),
          prepare: async () => {},
          consume: async (change, c) => {
            await agent.changed(change, c);
            seenChanges.add(change.factId);
          },
        },
      });
      await projector.start();
      await vi.waitFor(() => expect(projector!.ownsPartition(0)).toBe(true), { timeout: 30000 });
      const accepted = await store.acceptTurn(session.sessionId, "parent", {
        prompt: "Controlled metadata fixture",
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
      await family.bind(1, accepted.turnId, admission.executionReference);
      await projector.openPublication(admission.publication);
      const { leaseId: _lease, piConversationId: _lane, ...scope } = admission.publication.scope;
      const workflowId = randomUUID();
      const publish = async (request: SubagentControlRequest) => {
        const command: AcceptedSubagentCommand = {
          kind: "subagent_command",
          factId: randomUUID(),
          scope,
          executionReference: admission.executionReference,
          toolCallId: "task:10000000",
          workflowId,
          request,
          occurredAt: new Date().toISOString(),
        };
        await projector!.appendPublication(command);
        return command;
      };
      const started = await publish({
        action: "start",
        key: "child",
        task: "Metadata child",
        context: "fresh",
        sandbox: "none",
        anchor: null,
      });
      await vi.waitFor(() => expect(replies.has(started.factId)).toBe(true), { timeout: 10000 });
      const child = replies.get(started.factId)!.result!;
      expect(replies.get(started.factId)!.ok).toBe(true);
      const waiting = await publish({ action: "wait", target: "child" });
      await vi.waitFor(
        async () =>
          expect(
            (
              await database
                .selectFrom("subagent_control_commands")
                .select("child_execution_id")
                .where("id", "=", waiting.factId)
                .executeTakeFirst()
            )?.child_execution_id,
          ).toBe(child.executionId),
        { timeout: 10000 },
      );
      await vi.waitFor(
        async () => {
          const changes = await database
            .selectFrom("outbox")
            .select(["id", "published_at"])
            .where("aggregate_type", "=", "session_control_change")
            .execute();
          expect(changes.every((c) => c.published_at !== null && seenChanges.has(c.id))).toBe(true);
        },
        { timeout: 15000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      queries.length = 0;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(queries).toEqual([]);
      expect(replies.has(waiting.factId)).toBe(false);
      // Terminal before Worker admission has no native seal; its PG-originated
      // control change must still invalidate the view and wake the waiter.
      await database
        .updateTable("runs")
        .set({ state: "cancelled", settled_at: new Date() })
        .where("id", "=", child.childRunId as string)
        .execute();
      await vi.waitFor(() => expect(replies.get(waiting.factId)?.result?.state).toBe("cancelled"), {
        timeout: 10000,
      });
      process.stdout.write(
        JSON.stringify({
          measurement: "subagent_ordered_views",
          idleSqlQueries: 0,
          preAdmissionTerminalWokeWaiter: true,
        }) + "\n",
      );
      finish.resolve();
      await execution;
      await vi.waitFor(
        async () =>
          expect(
            (
              await database
                .selectFrom("runs")
                .select("output_sealed_at")
                .where("id", "=", accepted.runId)
                .executeTakeFirst()
            )?.output_sealed_at,
          ).not.toBeNull(),
        { timeout: 10000 },
      );
    } finally {
      finish.resolve();
      await execution?.catch(() => {});
      await projector?.close().catch(() => {});
      await host?.close().catch(() => {});
      await family?.close();
      await database.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
      await kafka.deleteTopics({ topics: [topic] }).catch(() => {});
      await kafka.close();
    }
  },
  90000,
);
