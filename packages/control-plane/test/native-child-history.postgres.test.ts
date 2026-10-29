import { replacePrunedHistory } from "../src/conversation-history-retention.ts";
import { expect, it } from "vitest";
import { sql } from "kysely";
import { PostgresSubagentConversations } from "@pi-cloud/subagent-control/subagent-conversations";
import { readDurableEntries } from "@pi-cloud/pi-session-postgres/durable";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { ConversationTreeService } from "../src/conversation-tree-service.ts";
import { ConversationDeletionService } from "../src/conversation-deletion-service.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { settleHistoryTurn } from "../../runtime-core/src/presentation-settlement.ts";

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
    await f.database
      .updateTable("subagent_conversations")
      .set({
        output_display_seq: "1",
        output_display_native_seq: String((await f.projection.head()).seq),
      })
      .where("id", "=", child.executionId)
      .execute();
    const previousChild = await f.store.getConversation(child.childSessionId);
    const replacement = await f.database
      .transaction()
      .execute((tx) => replacePrunedHistory(tx, f.scope.tenantId, f.scope.piSessionId));
    const { PostgresDurableCommitProjector } =
      await import("../../runtime-core/src/postgres-durable-commit-projector.ts");
    const replay = await new PostgresDurableCommitProjector(f.database).project(
      {
        kind: "durable_commit",
        factId: crypto.randomUUID(),
        scope: f.scope,
        occurredAt: new Date().toISOString(),
        commit: { seq: 1, nextId: 2, writes: [{ type: "conversation", value: { id: 1 } }] },
        origins: [],
        tools: [],
        cancellations: [],
        display: [],
      },
      { topic: "child-history", partition: 0, offset: 0n },
    );
    expect(replay).toEqual({ events: [], covers: [] });
    expect(
      (
        await sql`select 1 from pi_durable_commits where tenant_id=${f.scope.tenantId}::uuid and session_id=${f.scope.piSessionId}`.execute(
          f.database,
        )
      ).rows,
    ).toHaveLength(0);
    const retainedChild = await f.store.getConversation(child.childSessionId);
    expect(retainedChild.turns.map((t) => [t.prompt, t.state])).toEqual(
      previousChild.turns.map((t) => [t.prompt, t.state]),
    );
    expect(
      retainedChild.turns
        .flatMap((t) => t.transcript?.items ?? [])
        .filter((i) => i.kind === "text")
        .map((i) => i.text),
    ).toEqual(["CHILD-HISTORY-PRESERVED"]);
    const answer = (
      await sql<{ id: string }>`select id::text from pi_durable_records
      where tenant_id=${f.scope.tenantId}::uuid and session_id=${replacement}
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
      conversationId: Number(
        (
          await f.database
            .selectFrom("sessions")
            .select("pi_conversation_id")
            .where("id", "=", fork.session.sessionId)
            .executeTakeFirstOrThrow()
        ).pi_conversation_id,
      ),
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
        .where("id", "=", replacement)
        .execute(),
    ).toHaveLength(1);
    expect(
      await f.database.selectFrom("subagent_conversations").select("id").execute(),
    ).toHaveLength(1);

    await deletion.delete(f.scope.tenantId, f.scope.sessionId);
    expect(await f.database.selectFrom("subagent_conversations").select("id").execute()).toEqual(
      [],
    );
    expect(await f.database.selectFrom("runs").select("id").execute()).toEqual([]);
  } finally {
    await f.close();
  }
}, 60000);

it("prunes a child created after the selected answer within the same root Run", async () => {
  const f = await nativeSubagentFixture();
  try {
    const { fauxAssistantMessage } = await import("@earendil-works/pi-ai/providers/faux");
    const before = f.allocateId();
    await f.append([
      {
        type: "entry",
        value: {
          id: before,
          conversationId: 1,
          kind: "pi.assistant",
          model: [fauxAssistantMessage("KEEP THIS ANSWER")],
        },
      },
    ]);
    const call = await f.command({ task: "Discard the later child" });
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
      prompt: "Discard the later child",
      contextMode: "fresh",
      contextAnchor: null,
      sandboxMode: "none",
    });
    await f.settle(child.executionId, "completed");
    await f.finishCall(call);
    await f.append([
      {
        type: "entry",
        value: {
          id: f.allocateId(),
          conversationId: 1,
          kind: "pi.assistant",
          model: [fauxAssistantMessage("LATER ANSWER")],
        },
      },
    ]);
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
    const result = await new ConversationTreeService({ database: f.database }).prune(
      f.scope.tenantId,
      f.scope.sessionId,
      crypto.randomUUID(),
      { turnId: f.scope.turnId, entryId: String(before) },
    );
    expect(result.prunedSessionCount).toBe(1);
    const childRow = await f.database
      .selectFrom("sessions")
      .select(["pruned_at", "pi_conversation_id"])
      .where("id", "=", child.childSessionId)
      .executeTakeFirstOrThrow();
    expect(childRow.pruned_at).not.toBeNull();
    expect(childRow.pi_conversation_id).toBeNull();
  } finally {
    await f.close();
  }
}, 60000);

it("freezes a child Fork while the original child accepts another input in the same family", async () => {
  const f = await nativeSubagentFixture();
  try {
    const call = await f.command({ task: "First child input" });
    const jobs = new PostgresSubagentConversations({ database: f.database, native: f.native });
    const child = await jobs.start({
      id: call.operationId,
      tenantId: f.scope.tenantId,
      rootRunId: f.scope.runId,
      parentSessionId: f.scope.sessionId,
      parentTurnId: f.scope.turnId,
      executionReference: f.reference,
      parentToolCallId: `task:${call.taskId}`,
      source: { sequence: call.nativeSequence, taskId: call.taskId },
      prompt: "First child input",
      contextMode: "fresh",
      contextAnchor: null,
      sandboxMode: "none",
    });
    await f.settle(child.executionId, "completed", "FIRST CHILD ANSWER");
    await f.finishCall(call);
    await f.database
      .updateTable("subagent_conversations")
      .set({
        output_display_seq: "1",
        output_display_native_seq: String((await f.projection.head()).seq),
      })
      .where("id", "=", child.executionId)
      .execute();
    const current = f.children.get(child.executionId)!;
    const entries = await readDurableEntries(f.database, {
      tenantId: f.scope.tenantId,
      sessionId: f.scope.piSessionId,
      conversationId: current.conversationId,
      limit: 10,
    });
    const service = new ConversationTreeService({ database: f.database });
    const fork = await service.fork(f.scope.tenantId, child.childSessionId, crypto.randomUUID(), {
      turnId: child.childTurnId,
      entryId: String(entries[0]!.entry.id),
    });
    const frozen = JSON.stringify(await f.store.getConversation(fork.session.sessionId));
    const userId = f.allocateId(),
      inputId = f.allocateId(),
      taskId = f.allocateId();
    const task = {
      id: taskId,
      conversationId: current.conversationId,
      kind: "pi.generation",
      version: 1,
      input: {},
      background: false,
      abortRequested: false,
    };
    const input = {
      id: inputId,
      conversationId: current.conversationId,
      type: "input",
      requestId: "second-child-input",
      entry: userId,
    };
    await f.append(
      [
        {
          type: "entry",
          value: {
            id: userId,
            conversationId: current.conversationId,
            kind: "pi.user",
            model: [{ role: "user", content: "SECOND CHILD QUESTION", timestamp: Date.now() }],
          },
        },
        { type: "submission", value: { ...input, status: "placed" } },
        {
          type: "task",
          value: { ...task, state: { status: "running", checkpoint: { phase: "request" } } },
        },
      ],
      current.request.view,
    );
    expect((await jobs.status(f.scope.tenantId, child.executionId)).state).toBe("running");
    expect((await f.store.getConversation(child.childSessionId)).turns[0]?.state).toBe("running");
    expect(JSON.stringify(await f.store.getConversation(fork.session.sessionId))).toBe(frozen);
    const answerId = f.allocateId();
    await f.append(
      [
        {
          type: "entry",
          value: {
            id: answerId,
            conversationId: current.conversationId,
            kind: "pi.assistant",
            model: [fauxAssistantMessage("SECOND CHILD ANSWER")],
          },
        },
        { type: "submission", value: { ...input, status: "done", answer: answerId } },
        {
          type: "task",
          value: {
            ...task,
            state: { status: "terminal", outcome: { status: "completed", value: null } },
          },
        },
      ],
      current.request.view,
    );
    await f.database
      .updateTable("subagent_conversations")
      .set({
        output_display_seq: "2",
        output_display_native_seq: String((await f.projection.head()).seq),
      })
      .where("id", "=", child.executionId)
      .execute();
    await f.database
      .transaction()
      .execute((tx) =>
        settleHistoryTurn(tx, f.scope.tenantId, child.childSessionId, child.childTurnId),
      );
    expect(JSON.stringify(await f.store.getConversation(child.childSessionId))).toContain(
      "SECOND CHILD ANSWER",
    );
    expect(JSON.stringify(await f.store.getConversation(fork.session.sessionId))).toBe(frozen);
  } finally {
    await f.close();
  }
}, 60000);
