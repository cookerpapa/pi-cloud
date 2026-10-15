import { DurableTextPresentation } from "../../sandbox-supervisor/src/durable/text-presentation.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createPiCloudEventFactory } from "@pi-cloud/protocol";
import { createModels } from "@earendil-works/pi-ai/models";
import { beforeAll, afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { Harness, createRegistry, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PostgresDurableSessionHost } from "@pi-cloud/pi-session-postgres/durable";
import { DurableSessionPublisher } from "@pi-cloud/runtime-core/durable-session-publisher";
import type {
  AcceptedFactWriter,
  AcceptedDurableCommitFact,
  AcceptedWorkFinishedFact,
  AcceptedExecutionSealFact,
} from "@pi-cloud/runtime-core/accepted-fact";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import { parseExecutionReference } from "@pi-cloud/protocol";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { createTestWorker } from "./admit-test-execution.ts";
let db: Kysely<Database>, admin: Pool, name: string;
beforeAll(async () => {
  const url = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!;
  admin = new Pool({ connectionString: url, max: 1 });
  name = `native_host_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`create database "${name}"`);
  const endpoint = new URL(url);
  endpoint.pathname = `/${name}`;
  db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 5 });
  await runMigrations(db, "up");
}, 60000);
afterAll(async () => {
  await db?.destroy();
  if (admin) {
    await admin.query(`drop database "${name}"`);
    await admin.end();
  }
});

it("shares one root grant across Conversation views, closes concurrent handles once, and cold restores", async () => {
  const tenant = await createPrivateTenant(db, {
    slug: "native-host",
    ownerDisplayName: "Host fixture",
  });
  const control = new ControlPlaneStore({ database: db, ...tenant });
  const project = await control.createProject({ name: "Family", source: { kind: "empty" } });
  await db
    .updateTable("environment_versions")
    .set({ state: "validated", validated_at: new Date() })
    .where("id", "=", project.environment.environmentVersionId)
    .execute();
  const parent = await control.createSession(
    project.projectId,
    project.workspaceId,
    "Parent",
    "elastic",
  );
  const child = await control.createSession(
    project.projectId,
    project.workspaceId,
    "Child",
    "elastic",
  );
  const input = await control.acceptTurn(parent.sessionId, "parent", { prompt: "storage fixture" });
  const childTurn = crypto.randomUUID();
  await db
    .updateTable("sessions")
    .set({ pi_session_id: parent.sessionId, session_kind: "subagent" })
    .where("id", "=", child.sessionId)
    .execute();
  // Resource/view admission is covered by the Subagent contracts. This data-only
  // host fixture isolates native storage ACK, view identity and handle lifetime.
  await db
    .insertInto("subagent_conversations")
    .values({
      id: crypto.randomUUID(),
      tenant_id: tenant.tenantId,
      root_run_id: input.runId,
      root_session_id: parent.sessionId,
      parent_session_id: parent.sessionId,
      parent_turn_id: input.turnId,
      parent_tool_call_id: "task:1",
      parent_execution_id: null,
      depth: 1,
      source_sequence: "1",
      source_record_id: "1",
      source_kind: "task",
      request_sha256: "a".repeat(64),
      child_session_id: child.sessionId,
      child_turn_id: childTurn,
      agent_name: "fixture",
      context_mode: "fresh",
      sandbox_mode: "shared",
    })
    .execute();
  const worker = await createTestWorker(db),
    host = new PostgresDurableSessionHost({ database: db });
  const channels = new Map<string, AcceptedFactWriter>();
  const facts: Array<AcceptedDurableCommitFact | AcceptedWorkFinishedFact> = [];
  const publisher = new DurableSessionPublisher({
    replyTopic: "unused",
    channels: {
      resolve: (reference, conversationId = 1) => channels.get(`${reference}:${conversationId}`),
      checkHealth: async () => {},
    },
  });
  let constructors = 0,
    closures = 0,
    childConversation = 0,
    cold = false;
  const backend = worker.executor({
    finish: async (fact) => {
      facts.push(fact);
    },
    execute: async (request, _life, admission) => {
      const reference = admission!.executionReference,
        writerId = parseExecutionReference(reference).leaseId;
      const open = async (conversationId: number, sessionId: string, turnId: string) => {
        const publication = {
          scope: {
            ...admission!.publication.scope,
            sessionId,
            turnId,
            piConversationId: conversationId,
          },
        };
        channels.set(`${reference}:${conversationId}`, {
          publication,
          commitNative: async (fact) => {
            facts.push(fact);
          },

        });
        const handle = await host.open({
          binding: {
            tenantId: tenant.tenantId,
            piSessionId: parent.sessionId,
            sessionId,
            turnId,
            runId: request.runId,
            conversationId,
            executionReference: reference,
            writerId,
          },
          publish: (value) => publisher.scoped(reference).publish(value),
        });
        const text = new DurableTextPresentation({ conversationId });
        const factory = createPiCloudEventFactory({ sessionId, turnId, agentId: "fixture" });
        handle.prepareDisplay((commit, documents) => text.prepare(commit, documents, factory));
        return handle;
      };
      const root = await open(1, parent.sessionId, request.turnId);
      const runtime = await root.runtime(async () => {
        constructors++;
        const session = await Harness.open(
          root.storage,
          { models: createModels(), registry: createRegistry() },
          BACKGROUND_CONTEXT,
        );
        await session.root(BACKGROUND_CONTEXT);
        return {
          session,
          close: async () => {
            closures++;
            await session.close(BACKGROUND_CONTEXT);
          },
        };
      });
      if (cold) {
        const own = await root.storage.scanEntries(
          { conversationId: 1 as ConversationId },
          20,
          undefined,
          BACKGROUND_CONTEXT,
        );
        const delegated = await root.storage.scanEntries(
          { conversationId: childConversation as ConversationId },
          20,
          undefined,
          BACKGROUND_CONTEXT,
        );
        expect(own.items.map((entry) => entry.data)).toEqual(["parent"]);
        expect(delegated.items.map((entry) => entry.data)).toEqual(["child"]);
        await root.close();
        return { stopReason: "stop" };
      }
      childConversation = (
        await runtime.session.createConversation(
          { ownership: { kind: "ownerless" } },
          BACKGROUND_CONTEXT,
        )
      ).id;
      await db
        .updateTable("sessions")
        .set({ pi_conversation_id: String(childConversation) })
        .where("id", "=", child.sessionId)
        .execute();
      const leaf = await open(childConversation, child.sessionId, childTurn);
      expect(
        await leaf.runtime(async () => {
          throw new Error("Second Harness must not be constructed");
        }),
      ).toBe(runtime);
      for (const [conversationId, value] of [
        [1, "parent"],
        [childConversation, "child"],
      ] as const)
        await runtime.session.commit(
          (tx) =>
            tx.appendEntry(conversationId as ConversationId, {
              kind: "pi.assistant",
              data: value,
              model: [fauxAssistantMessage(value)],
            }),
          BACKGROUND_CONTEXT,
        );
      expect(constructors).toBe(1);
      await Promise.all([root.close(), leaf.close()]);
      expect(closures).toBe(1);
      expect(host.hasExecution(reference)).toBe(false);
      return { stopReason: "stop" };
    },
  });
  try {
    expect((await backend.dispatchRun(input.runId)).status).toBe("completed");
    expect(
      await db.selectFrom("runs").select("id").where("tenant_id", "=", tenant.tenantId).execute(),
    ).toHaveLength(1);
    const projector = new ExecutionStreamProjector(db);
    let offset = 0n;
    const shown = [];
    for (const fact of facts) {
      const result = await projector.project({
        fact,
        topic: "native-host",
        partition: 0,
        offset: offset++,
      });
      shown.push(...(result?.events ?? []));
    }
    expect(
      shown.filter((event) => event.sessionId === parent.sessionId).map((event) => event.payload),
    ).toMatchObject([{ text: "parent" }]);
    expect(
      shown.filter((event) => event.sessionId === child.sessionId).map((event) => event.payload),
    ).toMatchObject([{ text: "child" }]);
    const replay = new ExecutionStreamProjector(db);
    for (const [index, fact] of facts.entries())
      expect(
        (await replay.project({ fact, topic: "native-host", partition: 0, offset: BigInt(index) }))
          ?.events ?? [],
      ).toEqual([]);
    const seals = await db
      .selectFrom("outbox")
      .select("payload")
      .where("tenant_id", "=", tenant.tenantId)
      .where("aggregate_type", "=", "session_terminal_event")
      .orderBy("created_at")
      .execute();
    for (const seal of seals)
      await projector.project({
        fact: seal.payload as unknown as AcceptedExecutionSealFact,
        topic: "native-host",
        partition: 0,
        offset: offset++,
      });
    cold = true;
    const next = await control.acceptTurn(parent.sessionId, "cold", {
      prompt: "read persisted history",
    });
    expect((await backend.dispatchRun(next.runId)).status).toBe("completed");
    expect(constructors).toBe(2);
  } finally {
    await host.close();
    await publisher.close();
  }
}, 30_000);

it("rebuilds live display from Kafka, skips covered document refs after cold replay, and serializes publication", async () => {
  const tenant = await createPrivateTenant(db, {
    slug: `text-${crypto.randomUUID()}`,
    ownerDisplayName: "Display",
  });
  const control = new ControlPlaneStore({ database: db, ...tenant });
  const project = await control.createProject({ name: "Display", source: { kind: "empty" } });
  await db
    .updateTable("environment_versions")
    .set({ state: "validated", validated_at: new Date() })
    .where("id", "=", project.environment.environmentVersionId)
    .execute();
  const session = await control.createSession(
    project.projectId,
    project.workspaceId,
    "Text",
    "elastic",
  );
  const input = await control.acceptTurn(session.sessionId, "text", { prompt: "text" });
  const worker = await createTestWorker(db),
    host = new PostgresDurableSessionHost({ database: db });
  const facts: AcceptedDurableCommitFact[] = [],
    order: string[] = [];
  let failure: unknown;
  const backend = worker.executor({
    execute: async (_request, _life, admission) => {
      const {
        leaseId: _lease,
        piConversationId: _conversation,
        ...scope
      } = admission!.publication.scope;
      const projected = new ExecutionStreamProjector(db);
      const blocked = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>();
      let hold = false;
      const handle = await host.open({
        binding: {
          tenantId: tenant.tenantId,
          piSessionId: session.sessionId,
          conversationId: 1,
          sessionId: session.sessionId,
          turnId: input.turnId,
          runId: input.runId,
          executionReference: admission!.executionReference,
          writerId: scope.writerId,
        },
        publish: async (publication) => {
          if (hold) {
            entered.resolve();
            await blocked.promise;
          }
          order.push("native");
          facts.push({
            commit: publication.commit,
            origins: publication.origins,
            tools: [],
            cancellations: [],
            display: publication.display.map(({ executionReference: _ref, ...description }) => ({
              scope,
              ...description,
            })),
            kind: "durable_commit",
            scope,
            factId: crypto.randomUUID(),
            occurredAt: new Date().toISOString(),
          });
        },
      });
      let f = createPiCloudEventFactory({
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        agentId: "root",
      });
      const text = new DurableTextPresentation({ conversationId: 1 });
      handle.prepareDisplay((commit, documents) => {
        const candidate = createPiCloudEventFactory(
          { sessionId: scope.sessionId, turnId: scope.turnId, agentId: "root" },
          { initialSequence: f.currentSequence() },
        );
        const prepared = text.prepare(commit, documents, candidate);
        return {
          ...prepared,
          confirmed: () => {
            prepared.confirmed();
            f = candidate;
          },
        };
      });
      const ctx = BACKGROUND_CONTEXT,
        storage = handle.storage;
      try {
        const conversation = 1 as ConversationId,
          id = await storage.mintId<import("@earendil-works/pi-durable").DocumentId>();
        await storage.commit(
          [
            { type: "conversation", value: { id: conversation } },
            {
              type: "document.create",
              record: {
                id,
                kind: "pi.live",
                scope: { kind: "conversation", conversationId: conversation },
                history: "latest",
                fork: "initial",
              },
              content: { kind: "base", version: 1, value: {} },
            },
          ],
          ctx,
        );
        // Delay the native ACK (including e.g. attachment upload), queue a later
        // ordinary display write, and ensure its sequence is minted after ACK.
        hold = true;
        const value = {
          run: { taskId: 3, inputs: [] },
          generation: {
            attempt: 1,
            message: fauxAssistantMessage("你好🌍", { stopReason: "pending" }),
          },
        };
        const pending = storage.commit(
          [
            {
              type: "document.change",
              id,
              content: { kind: "base", version: 1, value: value as never },
            },
          ],
          ctx,
        );
        await entered.promise;
        const ordinary = handle.serializePublication(async () => {
          order.push(
            `ordinary:${f.next({ type: "assistant.text.delta", payload: { text: "fixture" } }).seq}`,
          );
        });
        expect(order).toEqual(["native"]);
        hold = false;
        blocked.resolve();
        await pending;
        await ordinary;
        expect(order).toEqual(["native", "native", "ordinary:2"]);
        const records = () =>
          facts.map((fact, n) => ({
            fact,
            topic: "text-fixture",
            partition: 0,
            offset: BigInt(n),
          }));
        const first = [];
        for (const record of records())
          first.push(...((await projected.project(record))?.events ?? []));
        expect(first.map((event) => event.payload)).toMatchObject([{ text: "你好🌍" }]);
        const fresh = new ExecutionStreamProjector(db),
          rebuilt = [];
        for (const record of records())
          rebuilt.push(...((await fresh.project(record))?.events ?? []));
        expect(rebuilt).toEqual(first);
        const bodies =
          await sql`select body from pi_durable_log where tenant_id=${tenant.tenantId}::uuid`.execute(
            db,
          );
        expect(JSON.stringify(bodies)).not.toContain("你好");
        const entry = await storage.mintId<import("@earendil-works/pi-durable").EntryId>();
        await storage.commit(
          [
            {
              type: "entry",
              value: {
                id: entry,
                kind: "pi.assistant",
                conversationId: conversation,
                model: [fauxAssistantMessage("你好🌍")],
              },
            },
            { type: "document.change", id, content: { kind: "base", version: 1, value: {} } },
          ],
          ctx,
        );
        const settled = await projected.project(records().at(-1)!);
        expect(settled?.events?.[0]?.payload).toMatchObject({
          text: "你好🌍",
          replace: true,
          settledMessageId: `entry:${entry}:0`,
        });
        const row = await db
          .selectFrom("runs")
          .select(["output_display_seq", "output_display_native_seq"])
          .where("id", "=", input.runId)
          .executeTakeFirstOrThrow();
        expect(row).toEqual({ output_display_seq: "3", output_display_native_seq: "3" });
        const replay = new ExecutionStreamProjector(db);
        for (const record of records()) expect((await replay.project(record))?.events).toEqual([]);
        return { stopReason: "stop", lastEventSeq: f.currentSequence() };
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        blocked.resolve();
        await handle.close();
      }
    },
  });
  try {
    const result = await backend.dispatchRun(input.runId);
    if (failure) throw failure;
    expect(result.status).toBe("completed");
  } finally {
    await host.close();
  }
}, 30000);
