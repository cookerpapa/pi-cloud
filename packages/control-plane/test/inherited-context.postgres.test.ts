import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { appendNativeFixture } from "./fixtures/durable-native.ts";
import { MAX_INHERITED_CONTEXT_ENTRIES, parseConversationDetailResource } from "@pi-cloud/protocol";

import { PostgresSubagentJobProvider } from "@pi-cloud/subagent-control";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { createTestWorker } from "./admit-test-execution.ts";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;
beforeAll(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0, maxConnections: 4 });
  await socket.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 4,
  });
  await runMigrations(database, "up");
});
afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await pglite?.close();
});

it.each([true, false])(
  "opens a child with 10,001 parent messages (compacted=%s)",
  async (compacted) => {
    const tenant = await createPrivateTenant(database, {
      slug: `inherited-${crypto.randomUUID()}`,
      ownerDisplayName: "Preview",
    });
    const store = new ControlPlaneStore({ database, ...tenant });
    const project = await store.createProject({ name: "Preview", source: { kind: "empty" } });
    const parent = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Parent",
      "elastic",
    );
    const session = await database
      .selectFrom("sessions")
      .select("pi_session_id")
      .where("id", "=", parent.sessionId)
      .executeTakeFirstOrThrow();
    const entries: Record<string, unknown>[] = [];
    for (let n = 1; n <= 10001; n++)
      entries.push({
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: compacted && n === 10001 ? "Retained question" : `old ${n}`,
            timestamp: n,
          },
        ],
      });
    if (compacted)
      entries.push({
        kind: "pi.compaction",
        head: 10002,
        data: { reason: "threshold" },
        model: [{ role: "user", content: "Earlier work is summarized", timestamp: 10002 }],
      });
    let anchor: string | null = null;
    for (let at = 0; at < entries.length; at += 500) {
      const added = await appendNativeFixture(
        database,
        { tenantId: tenant.tenantId, sessionId: session.pi_session_id },
        entries.slice(at, at + 500),
      );
      anchor = String(added.at(-1)!.id);
    }
    const accepted = await store.acceptTurn(parent.sessionId, "parent-task", {
      prompt: "Delegate a short task",
    });
    const worker = await createTestWorker(database);
    const entered = Promise.withResolvers<string>(),
      finished = Promise.withResolvers<void>();
    const execution = worker
      .executor({
        execute: async (_request, _lifecycle, admission) => {
          entered.resolve(admission.executionReference);
          await finished.promise;
          return { stopReason: "stop" };
        },
      })
      .dispatchRun(accepted.runId);
    void execution.catch(entered.reject);
    try {
      const reference = await entered.promise;
      const provider = new PostgresSubagentJobProvider({
        database,
        nativeConversations: {
          childAnchor: async () => anchor,
          createChildConversation: async () => {
            throw new Error("Creation is deferred in this read fixture");
          },
        },
      });
      const child = await provider.start(
        {
          tenantId: tenant.tenantId,
          parentSessionId: parent.sessionId,
          parentRunId: accepted.runId,
          parentExecutionReference: reference,
          parentToolCallId: "task:2",
          workflowRunId: "preview",
          stepIndex: 0,
          agentName: "preview",
          prompt: "Inspect",
          contextMode: "branch",
          sandboxMode: "none",
          contextAnchor: anchor,
        },
        true,
      );
      const detail = parseConversationDetailResource(
        await store.getConversation(child.childSessionId),
      );
      if (compacted) {
        expect(detail.inheritedContextSummary).toMatchObject({
          entryId: "10003",
          text: "Earlier work is summarized",
        });
        expect(detail.inheritedMessages).toMatchObject([
          { entryId: "10002", messageIndex: 0, text: "Retained question" },
        ]);
        expect(detail.inheritedMessagesTruncated).toBeUndefined();
      } else {
        expect(detail.inheritedMessages).toHaveLength(MAX_INHERITED_CONTEXT_ENTRIES);
        expect(detail.inheritedMessages.at(-1)?.text).toBe("old 10001");
        expect(detail.inheritedMessagesTruncated).toBe(true);
      }
      expect(detail.turns).toEqual([]);
      const count = await sql<{ count: string }>`select count(*) as count from pi_durable_records
        where tenant_id=${tenant.tenantId}::uuid and session_id=${session.pi_session_id} and kind='entry'`.execute(
        database,
      );
      expect(Number(count.rows[0]!.count)).toBe(entries.length);
    } finally {
      finished.resolve();
      await execution;
    }
  },
  120000,
);
