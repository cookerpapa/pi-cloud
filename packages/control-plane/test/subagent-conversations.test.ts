import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { sql } from "kysely";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import {
  PostgresSubagentConversations,
  type StartSubagentConversation,
} from "@pi-cloud/subagent-control/subagent-conversations";
import { PostgresSubagentSupervisorChannel } from "@pi-cloud/subagent-control/subagent-supervisor";
import { loadDelegatedSessionSummaries } from "../src/delegated-session-projection.ts";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import { createExecutionReference } from "@pi-cloud/protocol";
import { conversationPrompt } from "@pi-cloud/runtime-core/canonical-pi-conversation";

let f: Awaited<ReturnType<typeof nativeSubagentFixture>>;
beforeAll(async () => {
  f = await nativeSubagentFixture();
}, 60_000);
afterAll(async () => {
  await f?.close();
});
function input(call: AcceptedControlToolCommand): StartSubagentConversation {
  return {
    id: call.operationId,
    tenantId: f.scope.tenantId,
    rootRunId: f.scope.runId,
    parentSessionId: call.scope.sessionId,
    parentTurnId: call.scope.turnId,
    executionReference: f.reference,
    parentToolCallId: `task:${call.taskId}`,
    source: { sequence: call.nativeSequence, taskId: call.taskId },
    prompt: String(call.arguments.task),
    contextMode: "fresh",
    contextAnchor: null,
    sandboxMode: "shared",
  };
}
const provider = () =>
  new PostgresSubagentConversations({ database: f.database, native: f.native });

describe("native Subagent resource and query views", () => {
  it("creates no child Run and waits for completing native ownership before reporting success", async () => {
    const call = await f.command({ task: "Inspect the repository" }),
      jobs = provider();
    const child = await jobs.start(input(call));
    expect(child.state).toBe("running");
    expect(await f.database.selectFrom("runs").select("id").execute()).toHaveLength(1);
    expect(await f.database.selectFrom("session_leases").select("lease_id").execute()).toHaveLength(
      1,
    );
    await f.settle(child.executionId, "completing", "Already produced a final answer");
    expect((await jobs.status(f.scope.tenantId, child.executionId)).state).toBe("running");
    await f.settle(child.executionId, "completed", "Complete subtree result");
    expect(await jobs.result(f.scope.tenantId, child.executionId)).toMatchObject({
      state: "completed",
      output: "Complete subtree result",
    });
    const summary = await loadDelegatedSessionSummaries(f.database, {
      tenantId: f.scope.tenantId,
      parentSessionIds: [f.scope.sessionId],
      maximum: 100,
    });
    expect(summary.items.find((row) => row.executionId === child.executionId)).toMatchObject({
      parentTurnId: f.scope.turnId,
      state: "completed",
    });
    const turn = await f.database
      .selectFrom("conversation_turns")
      .selectAll()
      .where("session_id", "=", child.childSessionId)
      .executeTakeFirstOrThrow();
    expect(turn).toMatchObject({
      id: f.scope.runId,
      turn_id: child.childTurnId,
      state: "completed",
    });
    expect(conversationPrompt(turn.input_text, turn.input_source)).toBe("Inspect the repository");
    const columns = await sql<{
      column_name: string;
    }>`select column_name from information_schema.columns where table_name='subagent_conversations'`.execute(
      f.database,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(
      expect.arrayContaining(["child_run_id"]),
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("prompt");
    expect(columns.rows.map((row) => row.column_name)).not.toContain("state");
  });

  it("reads an opaque child prompt without converting native JSON through PostgreSQL jsonb", async () => {
    const text = "Read the safe task from an opaque native intent",
      call = await f.command({ task: text, diagnostic: "NUL \u0000 and lone surrogate \ud800" });
    const child = await provider().start(input(call));
    const row = await f.database
      .selectFrom("conversation_turns")
      .selectAll()
      .where("turn_id", "=", child.childTurnId)
      .executeTakeFirstOrThrow();
    expect(conversationPrompt(row.input_text, row.input_source)).toBe(text);
  });

  it("retries a lost native admission reply under the same child identity", async () => {
    const call = await f.command({ task: "Retry once" }),
      args = input(call);
    const start = vi.fn(async (request: Parameters<typeof f.native.start>[0]) => {
      const id = await f.native.start(request);
      if (start.mock.calls.length === 1)
        throw Object.assign(new Error("Reply lost"), { retryable: true });
      return id;
    });
    const jobs = new PostgresSubagentConversations({
      database: f.database,
      native: { ...f.native, start },
    });
    await expect(jobs.start(args)).rejects.toThrow("Reply lost");
    const child = await jobs.start(args);
    expect(start).toHaveBeenCalledTimes(2);
    expect(start.mock.calls[0]![0].view).toEqual(start.mock.calls[1]![0].view);
    expect(
      await f.database
        .selectFrom("subagent_conversations")
        .select("id")
        .where("id", "=", child.executionId)
        .execute(),
    ).toHaveLength(1);
    await expect(jobs.start({ ...args, prompt: "Different" })).rejects.toThrow("identity changed");
  });

  it("keeps independent compute, cwd and tool restrictions while sharing root ownership", async () => {
    const call = await f.command({ task: "Independent compute" });
    const validate = vi.fn(async () => {});
    const jobs = new PostgresSubagentConversations({
      database: f.database,
      native: f.native,
      validateDirectory: validate,
    });
    const child = await jobs.start({
      ...input(call),
      sandboxMode: "ephemeral",
      cwd: "/workspace/a",
      requestedToolCapabilities: ["read"],
    });
    const request = f.children.get(child.executionId)!.request;
    expect(request.view).toMatchObject({
      computeSessionId: child.childSessionId,
      workingDirectory: "/workspace/a",
      toolCapabilities: ["read"],
    });
    const nestedCall = await f.command(
      { task: "Nested" },
      {
        sessionId: child.childSessionId,
        turnId: child.childTurnId,
        conversationId: child.conversationId!,
      },
    );
    const nested = await jobs.start(input(nestedCall));
    expect(f.children.get(nested.executionId)!.request.view).toMatchObject({
      parentConversationId: child.conversationId,
      computeSessionId: child.childSessionId,
      toolCapabilities: ["read"],
    });
    expect(await f.database.selectFrom("runs").select("id").execute()).toHaveLength(1);
    expect(validate).toHaveBeenCalledOnce();
  });

  it("rejects stale root authority and an out-of-volume compute directory", async () => {
    const call = await f.command({ task: "Validate admission" });
    await expect(
      provider().start({
        ...input(call),
        executionReference: createExecutionReference(crypto.randomUUID(), f.scope.runId, 1),
      }),
    ).rejects.toThrow("owns this Session");
    await expect(
      provider().start({ ...input(call), sandboxMode: "ephemeral", cwd: "/etc" }),
    ).rejects.toThrow("shared Volume");
  });

  it("routes cancellation through the native owner without creating PG cancellation jobs", async () => {
    const call = await f.command({ task: "Cancel this child" }),
      jobs = provider();
    const child = await jobs.start(input(call));
    expect((await jobs.cancel(f.scope.tenantId, child.executionId, f.reference)).state).toBe(
      "cancelled",
    );
    expect(
      await f.database.selectFrom("turn_control_requests").select("id").execute(),
    ).toHaveLength(0);
    expect(
      (await f.database.selectFrom("runs").select("state").executeTakeFirstOrThrow()).state,
    ).toBe("running");
  });

  it("preserves supervisor request deduplication and reply ownership without child Runs", async () => {
    const call = await f.command({ task: "Needs a decision" }),
      child = await provider().start(input(call));
    const channel = new PostgresSubagentSupervisorChannel(f.database);
    const view = f.children.get(child.executionId)!;
    const contact = await f.command(
      { reason: "need_decision", message: "Which branch?" },
      { ...view.request.view, conversationId: view.conversationId },
      "contact_supervisor",
    );
    const requestId = contact.operationId;
    const request = {
      tenantId: f.scope.tenantId,
      childSessionId: child.childSessionId,
      rootRunId: f.scope.runId,
      taskId: contact.taskId,
      writerId: f.scope.writerId,
      requestId,
      reason: "need_decision" as const,
      message: "Which branch?",
    };
    const results = await Promise.all([channel.contact(request), channel.contact(request)]);
    expect(results[0]).toEqual(results[1]);
    await expect(
      channel.reply({
        tenantId: f.scope.tenantId,
        parentSessionId: child.childSessionId,
        requestId,
        message: "Wrong parent",
      }),
    ).rejects.toThrow();
    const answered = await channel.reply({
      tenantId: f.scope.tenantId,
      parentSessionId: f.scope.sessionId,
      requestId,
      message: "Use main",
    });
    expect(answered.replyMessage).toBe("Use main");
  });
});
