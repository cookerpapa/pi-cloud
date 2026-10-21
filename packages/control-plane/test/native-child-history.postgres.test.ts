import { expect, it } from "vitest";
import { sql } from "kysely";
import { PostgresSubagentConversations } from "@pi-cloud/subagent-control/subagent-conversations";
import { readDurableEntries } from "@pi-cloud/pi-session-postgres/durable";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { ConversationTreeService } from "../src/conversation-tree-service.ts";
import { ConversationDeletionService } from "../src/conversation-deletion-service.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";

it("shows child progress metadata in human focus without requiring a child history binding", async () => {
  const f = await nativeSubagentFixture();
  try {
    const call = await f.command({ task: "Child is preparing" });
    const child = await new PostgresSubagentConversations({
      database: f.database,
      native: f.native,
    }).start({
      id: call.operationId,
      tenantId: f.scope.tenantId,
      rootRunId: f.scope.runId,
      parentSessionId: f.scope.sessionId,
      parentTurnId: f.scope.turnId,
      executionReference: f.reference,
      parentToolCallId: `task:${call.taskId}`,
      source: { sequence: call.nativeSequence, taskId: call.taskId },
      prompt: "Child is preparing",
      contextMode: "fresh",
      contextAnchor: null,
      sandboxMode: "none",
    });
    await f.database
      .updateTable("sessions")
      .set({ pi_conversation_id: null })
      .where("id", "=", child.childSessionId)
      .execute();
    const tree = await new ConversationTreeService({ database: f.database }).tree(
      f.scope.tenantId,
      f.scope.sessionId,
      "focus",
    );
    expect(tree.branches.map((branch) => branch.sessionId)).toEqual([f.scope.sessionId]);
    expect(tree.delegatedSessions).toMatchObject([
      {
        sessionId: child.childSessionId,
        parentSessionId: f.scope.sessionId,
        parentTurnId: f.scope.turnId,
        parentToolCallId: `task:${call.taskId}`,
        turnId: child.childTurnId,
      },
    ]);
  } finally {
    await f.close();
  }
}, 60000);

it("forks native child history and preserves parent-owned deletion boundaries without a child Run", async () => {
  const f = await nativeSubagentFixture();
  try {
    const call = await f.command({ task: "Read this child history" });
    const child = await new PostgresSubagentConversations({
      database: f.database,
      native: f.native,
    }).start({
      id: call.operationId,
      tenantId: f.scope.tenantId,
      rootRunId: f.scope.runId,
      parentSessionId: f.scope.sessionId,
      parentTurnId: f.scope.turnId,
      executionReference: f.reference,
      parentToolCallId: `task:${call.taskId}`,
      source: { sequence: call.nativeSequence, taskId: call.taskId },
      prompt: "Read this child history",
      contextMode: "fresh",
      contextAnchor: null,
      sandboxMode: "none",
    });
    await f.settle(child.executionId, "completed", "CHILD-HISTORY-PRESERVED");
    await f.finishCall(call);
    await new ExecutionStreamProjector(f.database).project({
      fact: {
        kind: "work_finished",
        factId: crypto.randomUUID(),
        scope: f.scope,
        agentId: "root",
        baseSequence: 0,
        nativeSequence: (await f.projection.head()).seq,
        terminal: { type: "turn.completed", payload: { stopReason: "stop" } },

        occurredAt: new Date().toISOString(),
      },
      topic: "child-history",
      partition: 0,
      offset: 100n,
    });
    const answer = (
      await sql<{ id: string }>`select id::text from pi_durable_records
      where tenant_id=${f.scope.tenantId}::uuid and session_id=${f.scope.piSessionId}
        and kind='entry' and fields->>'turn'=${child.childTurnId} and fields->>'role'='assistant'`.execute(
        f.database,
      )
    ).rows[0]!;
    const fork = await new ConversationTreeService({ database: f.database }).fork(
      f.scope.tenantId,
      child.childSessionId,
      crypto.randomUUID(),
      {
        turnId: child.childTurnId,
        entryId: answer.id,
      },
    );
    const entries = await readDurableEntries(f.database, {
      tenantId: f.scope.tenantId,
      sessionId: fork.session.sessionId,
      conversationId: 1,
      limit: 100,
    });
    expect(JSON.stringify(entries)).toContain("CHILD-HISTORY-PRESERVED");
    const deletion = new ConversationDeletionService({ database: f.database });
    await expect(deletion.delete(f.scope.tenantId, child.childSessionId)).rejects.toThrow(
      "with their parent",
    );
    await deletion.delete(f.scope.tenantId, fork.session.sessionId);
    expect(await f.database.selectFrom("runs").select("id").execute()).toEqual([
      { id: f.scope.runId },
    ]);
    expect(
      await f.database
        .selectFrom("pi_sessions")
        .select("id")
        .where("id", "=", f.scope.piSessionId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await f.database.selectFrom("subagent_conversations").select("id").execute(),
    ).toHaveLength(1);
    expect((await f.projection.head()).seq).toBeGreaterThan(1);
    await deletion.delete(f.scope.tenantId, f.scope.sessionId);
    expect(await f.database.selectFrom("subagent_conversations").select("id").execute()).toEqual(
      [],
    );
    expect(await f.database.selectFrom("runs").select("id").execute()).toEqual([]);
  } finally {
    await f.close();
  }
}, 60000);
