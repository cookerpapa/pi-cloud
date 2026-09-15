import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  MAX_TOOL_COMMAND_BYTES,
  CloudToolCapabilitySnapshotSchema,
  type CloudToolCapabilitySnapshot,
  type SubagentControlRequest,
} from "@pi-cloud/protocol";

export type SubagentTask = {
  key: string;
  task: string;
  context?: "fresh" | "branch";
  sandbox?: "shared" | "ephemeral";
  cwd?: string;
  tools?: CloudToolCapabilitySnapshot;
};

export interface CloudSubagentToolRuntime {
  run(
    toolCallId: string,
    task: SubagentTask,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  control(
    toolCallId: string,
    request: Exclude<SubagentControlRequest, { action: "start" }>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
  workflow(
    toolCallId: string,
    script: string,
    signal?: AbortSignal,
    onUpdate?: (result: AgentToolResult<unknown>) => void,
  ): Promise<unknown>;
}

const context = Type.Union([Type.Literal("fresh"), Type.Literal("branch")]);
const sandbox = Type.Union([Type.Literal("shared"), Type.Literal("ephemeral")]);
const cwd = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: "^/[^\\u0000-\\u001f\\u007f]*$",
});
const actions = Type.Union([
  Type.Object(
    {
      action: Type.Literal("run"),
      task: Type.String({ minLength: 1 }),
      context: Type.Optional(context),
      sandbox: Type.Optional(sandbox),
      cwd: Type.Optional(cwd),
      tools: Type.Optional(CloudToolCapabilitySnapshotSchema),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("workflow"),
      script: Type.String({ minLength: 1, maxLength: MAX_TOOL_COMMAND_BYTES }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Union([Type.Literal("status"), Type.Literal("wait"), Type.Literal("cancel")]),
      target: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("send"),
      target: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1 }),
      delivery: Type.Union([
        Type.Literal("notify"),
        Type.Literal("steer"),
        Type.Literal("follow_up"),
      ]),
    },
    { additionalProperties: false },
  ),
]);
// Providers expect a top-level object schema. Pi's preparation hook enforces
// the action-specific contract before any durable execution intent is written.
const schema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("run"),
      Type.Literal("workflow"),
      Type.Literal("status"),
      Type.Literal("wait"),
      Type.Literal("cancel"),
      Type.Literal("send"),
    ]),
    task: Type.Optional(Type.String({ minLength: 1 })),
    script: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TOOL_COMMAND_BYTES })),
    context: Type.Optional(context),
    sandbox: Type.Optional(sandbox),
    cwd: Type.Optional(cwd),
    tools: Type.Optional(CloudToolCapabilitySnapshotSchema),
    target: Type.Optional(Type.String({ minLength: 1 })),
    message: Type.Optional(Type.String({ minLength: 1 })),
    delivery: Type.Optional(
      Type.Union([Type.Literal("notify"), Type.Literal("steer"), Type.Literal("follow_up")]),
    ),
  },
  { additionalProperties: false },
);
function argumentsForAction(value: unknown): Static<typeof actions> {
  if (!Value.Check(actions, value))
    throw new Error("Invalid subagent arguments for the selected action");
  return value;
}
export function validateSubagentTask(value: SubagentTask): void {
  const { key, ...task } = value;
  if (typeof key !== "string" || !key || "action" in task)
    throw new Error("Invalid Subagent task key");
  argumentsForAction({ action: "run", ...task });
}
export function validateSubagentControl(
  value: unknown,
): Extract<Static<typeof actions>, { target: string }> {
  const request = argumentsForAction(value);
  if (!("target" in request)) throw new Error("Expected a Subagent control request");
  return request;
}

/** Pi Tool semantics, with no local child process, fake Session or script eval. */
export function createCloudSubagentTool(
  runtime: CloudSubagentToolRuntime,
): AgentTool<typeof schema> {
  return {
    name: "subagent",
    label: "Subagent",
    parameters: schema,
    prepareArguments: argumentsForAction,
    description: [
      "Delegate a concrete task to another Pi Agent. No persona/profile is required.",
      "run waits for one child; fresh starts with the task only, branch inherits a frozen parent context.",
      "All children share the parent's persistent files. sandbox=shared reuses the parent's compute (default); sandbox=ephemeral lazily allocates separate temporary compute on the same Volume, without copying files.",
      "Ephemeral compute shares /workspace for elastic Workspaces or /home/user for cloud development machines; other system-disk directories are not copied.",
      "cwd selects an existing absolute working directory and defaults to the parent's directory. Missing or inaccessible directories fail; no directory is created and no fallback is used.",
      "For independent code branches, first use bash to create a Git worktree, then pass its absolute path as cwd. Inspect uncommitted changes first: a Git worktree starts from a commit and does not automatically inherit them. Do not commit, stash or discard user changes without authorization. You manage review, merge and worktree cleanup; VM expiry does not delete these files.",
      "For JavaScript orchestration use workflow with an explicit return value. The script runs in Cube, not in the trusted Agent host.",
      "Script API: await runs.run(key, {task, context?, sandbox?, cwd?, tools?}); await runs.all([{key,task,...},...]);",
      "An optional tools allowlist can narrow the child's file/shell Tools; [] disables them without removing hosted search or delegation.",
      "runs.run returns {executionId,state,output,...}; runs.all returns results in input order. Return the selected result; logs are not the result.",
      "The script also has runs.status(target), runs.wait(target), runs.cancel(target), runs.send(target,message,delivery), console and emit.",
      "Use a returned executionId or a workflow key as target. notify does not wake an idle Agent; steer targets the current task; follow_up queues later work.",
      "Do not send inherited 'start a subagent' instructions as the child's actual task. Do not replay uncertain external effects.",
    ].join(" "),
    async execute(toolCallId, raw, signal, onUpdate) {
      const args = argumentsForAction(raw);
      let result: unknown;
      if (args.action === "run") {
        result = await runtime.run(
          toolCallId,
          {
            key: "task",
            task: args.task,
            ...(args.context ? { context: args.context } : {}),
            ...(args.sandbox ? { sandbox: args.sandbox } : {}),
            ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
            ...(args.tools ? { tools: args.tools } : {}),
          },
          signal,
        );
        const child = result as Record<string, unknown>;
        if (["failed", "cancelled", "unknown"].includes(String(child.state)))
          throw new Error(
            `${child.state === "unknown" ? "subagent_result_unknown" : "subagent_failed"}: ${String(child.failureMessage ?? child.state)}`,
          );
      } else if (args.action === "workflow") {
        result = await runtime.workflow(toolCallId, args.script, signal, onUpdate);
      } else result = await runtime.control(toolCallId, args, signal);
      const text = typeof result === "string" ? result : JSON.stringify(result ?? null);
      return { content: [{ type: "text", text }], details: { action: args.action } };
    },
  };
}
