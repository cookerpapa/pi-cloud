import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createDatabase } from "@pi-cloud/database";
import type { ConversationWorkView } from "@pi-cloud/protocol";
import { PostgresDurableSessionHost } from "@pi-cloud/pi-session-postgres/durable";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";

it("revokes an owner while its cold head is still blocked and preserves the recovery classification", async () => {
  const f = await nativeSubagentFixture();
  const reads = createDatabase({
    connectionString: f.url,
    maxConnections: 1,
    readTimeoutMs: 10_000,
  });
  const host = new PostgresDurableSessionHost({ database: reads, leaseDatabase: f.database });
  const held = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const locker = f.database.transaction().execute(async (tx) => {
    await sql`lock table pi_durable_commits in access exclusive mode`.execute(tx);
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const opening = host.open({
    binding: {
      tenantId: f.scope.tenantId,
      piSessionId: f.scope.piSessionId,
      conversationId: 1,
      sessionId: f.scope.sessionId,
      turnId: f.scope.turnId,
      runId: f.scope.runId,
      executionReference: f.reference,
      writerId: f.scope.writerId,
    },
    publish: async () => {
      throw Error("No publication during cold open");
    },
  });
  const rejected = expect(opening).rejects.toMatchObject({
    code: "session_lease_revoked",
    retryable: true,
  });
  try {
    await vi.waitFor(async () => {
      expect(
        (
          await sql<{
            n: number;
          }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%pi_durable_commits%'`.execute(
            f.database,
          )
        ).rows[0]!.n,
      ).toBe(1);
    });
    await f.database
      .updateTable("session_leases")
      .set({ writer_failed_at: new Date() })
      .where("lease_id", "=", f.scope.writerId)
      .execute();
    await rejected;
    expect(host.hasExecution(f.reference)).toBe(false);
    await vi.waitFor(
      async () => {
        expect(
          (
            await sql<{
              n: number;
            }>`select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%pi_durable_commits%'`.execute(
              f.database,
            )
          ).rows[0]!.n,
        ).toBe(0);
      },
      { timeout: 3_000 },
    );
  } finally {
    release.resolve();
    await locker;
    await rejected;
    await host.close();
    await reads.destroy();
    await f.close();
  }
}, 30_000);

it("does not turn an incomplete cold checkpoint into a recoverable lease error during cleanup", async () => {
  const f = await nativeSubagentFixture();
  const host = new PostgresDurableSessionHost({ database: f.database });
  try {
    await f.projection.apply(
      {
        seq: 2 as never,
        nextId: 3,
        writes: [
          {
            type: "document.create",
            record: {
              id: 2 as never,
              kind: "pi.live",
              scope: { kind: "conversation", conversationId: 1 as never },
              history: "latest",
              fork: "initial",
            },
            content: { kind: "base", version: 1, value: {} },
          },
        ],
      },
      [],
      { topic: "owned-incomplete", partition: 0, offset: 2n },
    );
    await f.projection.apply(
      {
        seq: 3 as never,
        nextId: 3,
        writes: [
          {
            type: "document.change",
            id: 2 as never,
            content: { kind: "base", version: 1, value: { generation: { attempt: 1 } } },
          },
        ],
      },
      [],
      { topic: "owned-incomplete", partition: 0, offset: 3n },
    );
    const error = await host
      .open({
        binding: {
          tenantId: f.scope.tenantId,
          piSessionId: f.scope.piSessionId,
          conversationId: 1,
          sessionId: f.scope.sessionId,
          turnId: f.scope.turnId,
          runId: f.scope.runId,
          executionReference: f.reference,
          writerId: f.scope.writerId,
        },
        publish: async () => {},
      })
      .then(
        () => undefined,
        (error) => error,
      );
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("ordered Kafka recovery");
    expect(error.code).toBeUndefined();
    expect(host.hasExecution(f.reference)).toBe(false);
  } finally {
    await host.close();
    await f.close();
  }
}, 30_000);

it("batches active native child metadata without loading original prompts and retains exact view identity", async () => {
  const f = await nativeSubagentFixture();
  const queries: string[] = [];
  const measured = f.database.withPlugin({
    transformQuery({ node, queryId }) {
      queries.push(f.database.getExecutor().compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const host = new PostgresDurableSessionHost({ database: measured, leaseDatabase: f.database });
  const views: { conversationId: number; view: ConversationWorkView }[] = [];
  let selected: typeof views = [];
  try {
    const parent = await f.database
      .selectFrom("sessions")
      .selectAll()
      .where("id", "=", f.scope.sessionId)
      .executeTakeFirstOrThrow();
    for (let i = 0; i < 257; i++) {
      const view: ConversationWorkView = {
        id: randomUUID(),
        sessionId: randomUUID(),
        turnId: randomUUID(),
        parentConversationId: 1,
        ownerTaskId: i + 2,
        contextAnchor: null,
        workingDirectory: "/workspace",
        computeSessionId: null,
        toolCapabilities: [],
        agentSystemPrompt: "",
        source: { sequence: 1, taskId: i + 2 },
      };
      views.push({ conversationId: i + 1000, view });
    }
    await f.database
      .insertInto("sessions")
      .values(
        views.map(({ conversationId, view }) => ({
          ...parent,
          id: view.sessionId,
          pi_conversation_id: String(conversationId),
          session_kind: "subagent" as const,
          title: "Owned child view",
          tool_capabilities: sql<unknown[]>`'[]'::jsonb`,
          next_event_seq: "4",
        })),
      )
      .execute();
    await f.database
      .insertInto("subagent_conversations")
      .values(
        views.map(({ view }) => ({
          id: view.id,
          tenant_id: f.scope.tenantId,
          root_run_id: f.scope.runId,
          root_session_id: f.scope.sessionId,
          parent_session_id: f.scope.sessionId,
          parent_turn_id: f.scope.turnId,
          parent_tool_call_id: "task:" + view.ownerTaskId,
          parent_execution_id: null,
          depth: 1,
          source_sequence: "1",
          source_record_id: String(view.source.taskId),
          source_kind: "task" as const,
          request_sha256: "a".repeat(64),
          child_session_id: view.sessionId,
          child_turn_id: view.turnId,
          agent_name: "fixture",
          context_mode: "fresh" as const,
          sandbox_mode: "shared" as const,
          output_display_seq: "8",
        })),
      )
      .execute();
    const handle = await host.open({
      binding: {
        tenantId: f.scope.tenantId,
        piSessionId: f.scope.piSessionId,
        conversationId: 1,
        sessionId: f.scope.sessionId,
        turnId: f.scope.turnId,
        runId: f.scope.runId,
        executionReference: f.reference,
        writerId: f.scope.writerId,
      },
      publish: async () => {},
    });
    // This isolates cloud metadata. Native state/receipt restoration is exercised
    // with the real Harness in the child reattachment and family timing fixtures.
    await handle.runtime(async () => ({
      close: async () => {},
      activeConversationViews: async () => selected,
    }));
    for (const n of [0, 1, 8, 32, 128, 129, 257]) {
      selected = views.slice(0, n);
      queries.length = 0;
      const restored = await host.activeConversations(f.reference);
      expect(restored).toEqual(selected.map((entry) => ({ ...entry, nextEventSeq: 9 })));
      expect(queries.filter((q) => q.includes("subagent_conversations"))).toHaveLength(
        Math.ceil(n / 128),
      );
      expect(queries.some((q) => q.includes("pi_durable_log"))).toBe(false);
    }
    selected = views.slice(0, 1);
    // A lost control reply can leave the view's native ID unpublished. The
    // already-persisted native view is sufficient; it must not resubmit input.
    await f.database
      .updateTable("sessions")
      .set({ pi_conversation_id: null })
      .where("id", "=", selected[0]!.view.sessionId)
      .execute();
    expect(await host.activeConversations(f.reference)).toHaveLength(1);
    selected = [{ ...selected[0]!, view: { ...selected[0]!.view, turnId: randomUUID() } }];
    await expect(host.activeConversations(f.reference)).rejects.toThrow("missing or changed");
    await handle.close();
  } finally {
    await host.close();
    await f.close();
  }
}, 30_000);
