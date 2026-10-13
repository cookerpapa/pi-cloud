import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { MAX_AGENT_INPUT_CHARACTERS, assertSubagentTaskInputBudget } from "./agent-input-budget.ts";
import { MAX_TOOL_COMMAND_BYTES } from "./tool-sandbox.ts";
import {
  CloudToolCapabilitySnapshotSchema,
  type CloudToolCapabilitySnapshot,
} from "./tool-capabilities.ts";

export type SubagentTask = {
  key: string;
  task: string;
  context?: "fresh" | "branch";
  sandbox?: "shared" | "ephemeral";
  cwd?: string;
  tools?: CloudToolCapabilitySnapshot;
};

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
      task: Type.String({ minLength: 1, maxLength: MAX_AGENT_INPUT_CHARACTERS }),
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
export const SubagentToolSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("run"),
      Type.Literal("workflow"),
      Type.Literal("status"),
      Type.Literal("wait"),
      Type.Literal("cancel"),
      Type.Literal("send"),
    ]),
    task: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_AGENT_INPUT_CHARACTERS })),
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
export function prepareSubagentArguments(value: unknown): Static<typeof actions> {
  if (!Value.Check(actions, value))
    throw new Error("Invalid subagent arguments for the selected action");
  if (value.action === "run") assertSubagentTaskInputBudget(value.task);
  return value;
}
export function validateSubagentTask(value: SubagentTask): void {
  const { key, ...task } = value;
  if (typeof key !== "string" || !key || "action" in task)
    throw new Error("Invalid Subagent task key");
  prepareSubagentArguments({ action: "run", ...task });
}
export function validateSubagentControl(
  value: unknown,
): Extract<Static<typeof actions>, { target: string }> {
  const request = prepareSubagentArguments(value);
  if (!("target" in request)) throw new Error("Expected a Subagent control request");
  return request;
}

export type ControlToolName = "subagent" | "contact_supervisor" | "subagent_supervisor" | "preview";
export type ControlToolDefinition = {
  name: ControlToolName;
  description: string;
  parameters: TSchema;
  prepareArguments?(value: unknown): unknown;
  requiresEnvironment?: true;
  availability?: "child" | "delegation";
  inheritedContext?(args: Record<string, unknown>): boolean;
  workflowScript?(args: Record<string, unknown>): string | undefined;
};

const subagent: ControlToolDefinition = {
  name: "subagent",
  parameters: SubagentToolSchema,
  prepareArguments: prepareSubagentArguments,
  availability: "delegation",
  inheritedContext: (args) => args.context === "branch",
  workflowScript: (args) => (args.action === "workflow" ? String(args.script) : undefined),
  description: [
    "Delegate a concrete task to another Pi Agent. No persona/profile is required.",
    "Task text is limited to 100,000 characters and 256 KiB after JSON encoding. Use shared context or Workspace paths for larger input.",
    "run waits for one child; fresh starts with the task only, branch inherits a frozen parent context.",
    "All children share the parent's persistent files. sandbox=shared reuses the parent's compute (default); sandbox=ephemeral lazily allocates separate temporary compute on the same Volume, without copying files.",
    "Ephemeral compute shares /workspace for elastic Workspaces or /home/user for cloud development machines; other system-disk directories are not copied.",
    "cwd selects an existing absolute working directory and defaults to the parent's directory. Missing or inaccessible directories fail; no directory is created and no fallback is used.",
    "For independent code branches, first use bash to create a Git worktree, then pass its absolute path as cwd. Inspect uncommitted changes first: a Git worktree starts from a commit and does not automatically inherit them. Do not commit, stash or discard user changes without authorization. You manage review, merge and worktree cleanup; VM expiry does not delete these files.",
    "For JavaScript orchestration use workflow with an explicit return value. The script runs in Cube, not in the trusted Agent host.",
    "Script API: await runs.run(key, {task, context?, sandbox?, cwd?, tools?}); await runs.all([{key,task,...},...]);",
    "An optional tools allowlist can narrow the child's file/shell Tools; [] disables them without removing hosted search or delegation.",
    "runs.run returns {executionId,state,output,...}; runs.all returns results in input order. Return the selected result; logs are not the result.",
    "Returned text is limited to 256 KiB after JSON encoding. Write larger data explicitly to a Workspace file and return a summary or path. A result-size error does not undo completed effects; inspect before retrying.",
    "The script also has runs.status(target), runs.wait(target), runs.cancel(target), runs.send(target,message,delivery), console and emit.",
    "Use a returned executionId or a workflow key as target. notify does not wake an idle Agent; steer targets the current task; follow_up queues later work.",
    "Do not send inherited 'start a subagent' instructions as the child's actual task. Do not replay uncertain external effects.",
  ].join(" "),
};
const contactSchema = Type.Object(
  {
    reason: Type.Union([
      Type.Literal("progress_update"),
      Type.Literal("need_decision"),
      Type.Literal("interview_request"),
    ]),
    message: Type.String({ minLength: 1 }),
    interview: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
const supervisorSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("pending"), Type.Literal("reply"), Type.Literal("wait")]),
    replyTo: Type.Optional(Type.String()),
    message: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const PreviewToolSchema = Type.Object(
  {
    port: Type.Integer({ minimum: 1_024, maximum: 65_535 }),
    path: Type.Optional(
      Type.String({ minLength: 1, maxLength: 2_048, pattern: "^/[^\\u0000-\\u001f\\u007f ]*$" }),
    ),
  },
  { additionalProperties: false },
);

/** Frozen code-owned catalogue; handlers never import the Pi Runner. */
export function controlToolDefinitions(): readonly ControlToolDefinition[] {
  return [
    subagent,
    {
      name: "contact_supervisor",
      availability: "child",
      description:
        "Send a durable progress update or request a decision from the parent Agent. A decision request waits for its reply.",
      parameters: contactSchema,
    },
    {
      name: "subagent_supervisor",
      description:
        "Inspect pending Child requests, reply, and wait for the Child result. This does not start another Child.",
      parameters: supervisorSchema,
    },
    {
      name: "preview",
      requiresEnvironment: true,
      description:
        "Publish a verified HTTP service already listening inside the current Sandbox as an authenticated PiCloud application link. This Tool does not start or restart the server.",
      parameters: PreviewToolSchema,
    },
  ];
}
export function isControlToolName(value: unknown): value is ControlToolName {
  return ["subagent", "contact_supervisor", "subagent_supervisor", "preview"].includes(
    String(value),
  );
}
