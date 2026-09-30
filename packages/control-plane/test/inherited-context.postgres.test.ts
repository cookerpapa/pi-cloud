import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { projectNativeSessionAppend } from "@pi-cloud/pi-session-postgres";
import { MAX_INHERITED_CONTEXT_ENTRIES, parseConversationDetailResource } from "@pi-cloud/protocol";
import type { StoredPiCommittedItem } from "@pi-cloud/protocol/native-session";
import { PostgresSubagentJobProvider } from "@pi-cloud/subagent-control";
import type { Kysely } from "kysely";
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
    const items: StoredPiCommittedItem[] = [];
    let anchor: string | null = null;
    for (let i = 1; i <= 10_001; i++) {
      const id = `old-${i}`;
      items.push({
        kind: "entry",
        lane: "main",
        turnId: null,
        entry: {
          id,
          parentId: anchor,
          seq: i,
          timestamp: i,
          type: "message",
          message: { role: "user", content: `old ${i}`, timestamp: i },
        },
      });
      anchor = id;
    }
    if (compacted) {
      items.push({
        kind: "entry",
        lane: "main",
        turnId: null,
        entry: {
          id: "compact",
          parentId: anchor,
          seq: 10_002,
          timestamp: 10_002,
          type: "compaction",
          summary: "Earlier work is summarized",
          tokensBefore: 50_000,
          retainedTail: [{ role: "user", content: "Retained question", timestamp: 10_001 }],
        },
      });
      anchor = "compact";
    }
    // Seed historical native rows directly; this is not one oversized Kafka fact.
    await database.transaction().execute((tx) =>
      projectNativeSessionAppend(tx, {
        tenantId: tenant.tenantId,
        sessionId: session.pi_session_id,
        appendId: crypto.randomUUID(),
        items,
      }),
    );
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
        nativeLanes: {
          childAnchor: () => anchor,
          createChildLane: async () => {},
        },
      });
      const child = await provider.start(
        {
          tenantId: tenant.tenantId,
          parentSessionId: parent.sessionId,
          parentRunId: accepted.runId,
          parentExecutionReference: reference,
          parentToolCallId: "preview",
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
          entryId: "compact",
          text: "Earlier work is summarized",
        });
        expect(detail.inheritedMessages).toMatchObject([
          { entryId: "compact", messageIndex: 0, text: "Retained question" },
        ]);
        expect(detail.inheritedMessagesTruncated).toBeUndefined();
      } else {
        expect(detail.inheritedMessages).toHaveLength(MAX_INHERITED_CONTEXT_ENTRIES);
        expect(detail.inheritedMessages.at(-1)?.text).toBe("old 10001");
        expect(detail.inheritedMessagesTruncated).toBe(true);
      }
      expect(detail.turns).toEqual([]);
      const count = await database
        .selectFrom("pi_session_log")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", tenant.tenantId)
        .where("session_id", "=", session.pi_session_id)
        .executeTakeFirstOrThrow();
      expect(Number(count.count)).toBe(items.length);
    } finally {
      finished.resolve();
      await execution;
    }
  },
);
