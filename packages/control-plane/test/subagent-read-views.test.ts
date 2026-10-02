import { expect, it, vi } from "vitest";
import { SubagentReadViews } from "../src/subagent-read-views.ts";
import {
  SubagentPendingCommands,
  type SubagentCommandRow,
} from "../src/subagent-pending-commands.ts";

it("shares warm lookups and rejects late cache installation after a family change", async () => {
  const views = new SubagentReadViews(),
    first = Promise.withResolvers<string>();
  const load = vi.fn(() => first.promise);
  const a = views.read("family", "status", load),
    b = views.read("family", "status", load);
  await Promise.resolve();
  expect(load).toHaveBeenCalledOnce();
  views.invalidate("family");
  const current = vi.fn(async () => "completed");
  expect(await views.read("family", "status", current)).toBe("completed");
  first.resolve("running");
  await Promise.all([a, b]);
  for (let i = 0; i < 100; i++)
    expect(await views.read("family", "status", current)).toBe("completed");
  expect(current).toHaveBeenCalledOnce();
  views.reset();
  await views.read("family", "status", current);
  expect(current).toHaveBeenCalledTimes(2);
});

it("does not retain failed or over-budget values and isolates Session families", async () => {
  const views = new SubagentReadViews(2, 16);
  const failure = vi.fn(async () => {
    throw new Error("read unavailable");
  });
  await expect(views.read("one", "key", failure)).rejects.toThrow("unavailable");
  const load = vi.fn(async () => "x".repeat(100));
  await views.read("one", "key", load);
  await views.read("one", "key", load);
  expect(load).toHaveBeenCalledTimes(2);
  expect(await views.read("two", "key", async () => "other")).toBe("other");
});

function row(): SubagentCommandRow {
  return {
    id: "command",
    ordinal: "1",
    revision: "1",
    tenant_id: "tenant",
    run_id: "run",
    partition: 0,
    command: { scope: { piSessionId: "physical" }, request: { task: "x".repeat(1000) } },
    child_execution_id: null,
    supervisor_request_id: null,
    target_session_id: null,
    input_run_id: null,
    input_consumed_at: null,
    response: null,
    delivered_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

it("keeps bounded references when bodies are evicted and retires only consumed input", () => {
  const pending = new SubagentPendingCommands(2, 64),
    initial = row();
  pending.remember(initial);
  expect(pending.row(initial.id)).toBeUndefined();
  expect(pending.get(initial.id)?.responsePending).toBe(true);
  const accepted = {
    ...initial,
    revision: "2",
    delivered_at: new Date(),
    target_session_id: "receiver",
    input_run_id: "receiver-run",
    response: { result: { state: "accepted" } },
  };
  pending.remember(accepted);
  expect(pending.get(initial.id)).toMatchObject({ responsePending: false, inputPending: true });
  pending.remember({ ...accepted, revision: "3", input_consumed_at: new Date() });
  expect(pending.get(initial.id)).toBeUndefined();
  pending.remember(initial);
  expect(pending.get(initial.id)).toBeUndefined();
});

it("reports reference pressure without turning an untracked durable command into success", () => {
  const pending = new SubagentPendingCommands(1),
    first = row();
  expect(pending.remember(first)).toBe(true);
  expect(pending.remember({ ...first, id: "next", ordinal: "2" })).toBe(false);
  expect(pending.overflow).toBe(true);
  expect(pending.size).toBe(1);
});
