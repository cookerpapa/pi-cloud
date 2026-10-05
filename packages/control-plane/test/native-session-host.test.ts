import { createModels } from "@earendil-works/pi-ai/models";
import { beforeAll, afterAll, expect, it } from "vitest";
import { Pool } from "pg";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import {
  Harness,
  createRegistry,
  type Session,
  type ConversationId,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PostgresDurableSessionHost } from "@pi-cloud/pi-session-postgres/durable";
import { DurableSessionPublisher } from "@pi-cloud/runtime-core/durable-session-publisher";
import type {
  AcceptedFactWriter,
  AcceptedDurableCommitFact,
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

it("shares one acknowledged native writer with paused PG projection, closes one scope independently, and cold restores", async () => {
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
  const worker = await createTestWorker(db),
    host = new PostgresDurableSessionHost({ database: db });
  const channels = new Map<string, AcceptedFactWriter>(),
    facts: AcceptedDurableCommitFact[] = [];
  const publisher = new DurableSessionPublisher({
    channels: { resolve: (reference) => channels.get(reference), checkHealth: async () => {} },
    replyTopic: "unused",
  });
  let constructors = 0,
    childConversation = 0,
    native: Session | undefined;
  const parentReady = Promise.withResolvers<void>(),
    childReady = Promise.withResolvers<void>();
  const releaseParent = Promise.withResolvers<void>(),
    parentClosed = Promise.withResolvers<void>(),
    releaseChild = Promise.withResolvers<void>();
  let mode: "live" | "cold" = "live";
  const backend = worker.executor({
    execute: async (request, _life, admission) => {
      const writerId = parseExecutionReference(admission!.executionReference).leaseId;
      channels.set(admission!.executionReference, {
        publication: admission!.publication,
        commitNative: async (fact) => {
          facts.push(fact);
        },
        publishSubagentCommand: async () => {},
        publishToolCancellation: async () => {},
        publishToolCommand: async () => {
          throw new Error("Data-only native fixture");
        },
      });
      const handle = await host.open({
        binding: {
          tenantId: tenant.tenantId,
          piSessionId: parent.sessionId,
          sessionId: request.sessionId,
          conversationId: request.piConversationId,
          runId: request.runId,
          turnId: request.turnId,
          executionReference: admission!.executionReference,
          writerId,
        },
        publish: (value) => publisher.scoped(admission!.executionReference).publish(value),
      });
      try {
        const runtime = await handle.runtime(async () => {
          constructors++;
          const session = await Harness.open(
            handle.storage,
            { models: createModels(), registry: createRegistry() },
            BACKGROUND_CONTEXT,
          );
          await session.root(BACKGROUND_CONTEXT);
          return { session, close: () => session.close(BACKGROUND_CONTEXT) };
        });
        if (mode === "cold") {
          const rootEntries = await handle.storage.scanEntries(
            { conversationId: 1 as ConversationId },
            20,
            undefined,
            BACKGROUND_CONTEXT,
          );
          const childEntries = await handle.storage.scanEntries(
            { conversationId: childConversation as ConversationId },
            20,
            undefined,
            BACKGROUND_CONTEXT,
          );
          expect(rootEntries.items.map((entry) => entry.data)).toEqual(["parent"]);
          expect(childEntries.items.map((entry) => entry.data)).toEqual([
            "after parent closed",
            "child",
          ]);
          return { stopReason: "stop" };
        }
        if (request.sessionId === parent.sessionId) {
          native = runtime.session;
          await native.commit(async (tx) => {
            childConversation = (await tx.createConversation({ ownership: { kind: "ownerless" } }))
              .id;
            await tx.appendEntry(1 as ConversationId, { kind: "test", data: "parent" });
          }, BACKGROUND_CONTEXT);
          parentReady.resolve();
          await releaseParent.promise;
        } else {
          expect(runtime.session).toBe(native);
          await runtime.session.commit(async (tx) => {
            await tx.appendEntry(childConversation as ConversationId, {
              kind: "test",
              data: "child",
            });
          }, BACKGROUND_CONTEXT);
          childReady.resolve();
          await parentClosed.promise;
          await runtime.session.commit(async (tx) => {
            await tx.appendEntry(childConversation as ConversationId, {
              kind: "test",
              data: "after parent closed",
            });
          }, BACKGROUND_CONTEXT);
          await releaseChild.promise;
        }
        return { stopReason: "stop" };
      } finally {
        await handle.close();
        if (request.sessionId === parent.sessionId) parentClosed.resolve();
        channels.delete(admission!.executionReference);
      }
    },
  });
  const parentInput = await control.acceptTurn(parent.sessionId, "parent", {
    prompt: "data fixture",
  });
  const parentRun = backend.dispatchRun(parentInput.runId);
  void parentRun.catch(parentReady.reject);
  let childRun: Promise<unknown> | undefined;
  try {
    await parentReady.promise;
    await db
      .updateTable("sessions")
      .set({ pi_session_id: parent.sessionId, pi_conversation_id: String(childConversation) })
      .where("id", "=", child.sessionId)
      .execute();
    const childInput = await control.acceptTurn(child.sessionId, "child", {
      prompt: "child fixture",
    });
    childRun = backend.dispatchRun(childInput.runId);
    void childRun.catch(childReady.reject);
    await childReady.promise;
    expect(constructors).toBe(1);
    releaseParent.resolve();
    await parentRun;
    releaseChild.resolve();
    await childRun;
    const projection = new ExecutionStreamProjector(db);
    let offset = 0n;
    for (const fact of facts)
      await projection.project({ fact, topic: "native-host", partition: 0, offset: offset++ });
    const seals = await db
      .selectFrom("outbox")
      .select("payload")
      .where("tenant_id", "=", tenant.tenantId)
      .where("aggregate_type", "=", "session_terminal_event")
      .orderBy("created_at")
      .execute();
    for (const seal of seals)
      await projection.project({
        fact: seal.payload as unknown as AcceptedExecutionSealFact,
        topic: "native-host",
        partition: 0,
        offset: offset++,
      });
    mode = "cold";
    const next = await control.acceptTurn(parent.sessionId, "cold", {
      prompt: "read existing history",
    });
    expect((await backend.dispatchRun(next.runId)).status).toBe("completed");
    expect(constructors).toBe(2);
  } finally {
    releaseParent.resolve();
    parentClosed.resolve();
    releaseChild.resolve();
    await Promise.allSettled([parentRun, ...(childRun ? [childRun] : [])]);
    await host.close();
    await publisher.close();
  }
}, 30000);
