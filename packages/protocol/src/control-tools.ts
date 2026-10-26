import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { MAX_AGENT_INPUT_CHARACTERS, assertSubagentTaskInputBudget } from "./agent-input-budget.ts";
import { MAX_TOOL_COMMAND_BYTES } from "./tool-sandbox.ts";
import { CloudToolNameSchema } from "./tool-capabilities.ts";

const context = Type.Union([Type.Literal("fresh"), Type.Literal("branch")], {
  description:
    "fresh starts from this task; branch inherits a frozen parent conversation. Context does not grant workspace or device access.",
});
const cwd = Type.String({
  minLength: 1,
  maxLength: 4096,
  pattern: "^/[^\\u0000-\\u001f\\u007f]*$",
  description:
    "An existing directory on the Linux workspace Volume. Defaults to the parent's working directory.",
});
export const SubagentWorkspaceSchema = Type.Object(
  {
    compute: Type.Optional(
      Type.Union([Type.Literal("shared"), Type.Literal("ephemeral")], {
        description:
          "Linux compute only: shared (default) reuses parent compute; ephemeral starts independent temporary compute on the same persistent Volume. Files are shared. This never creates or clones a phone.",
      }),
    ),
    cwd: Type.Optional(cwd),
    tools: Type.Optional(
      Type.Array(CloudToolNameSchema, {
        minItems: 1,
        maxItems: 4,
        uniqueItems: true,
        description:
          "Nonempty subset of the parent's Linux file/shell tools. Omit to inherit; use workspace:null to disable workspace access.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type SubagentWorkspace = Static<typeof SubagentWorkspaceSchema>;
export const SubagentToolSchema = Type.Object(
  {
    task: Type.String({ minLength: 1, maxLength: MAX_AGENT_INPUT_CHARACTERS }),
    context: Type.Optional(context),
    workspace: Type.Optional(
      Type.Union([SubagentWorkspaceSchema, Type.Null()], {
        description:
          "Omit to inherit existing Linux workspace access, or use null for no workspace-dependent tools or compute. This does not grant control of phones or other devices.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type SubagentTask = Static<typeof SubagentToolSchema> & { key: string };

/** Root coding Conversations own a Workspace; a child with no file/shell grant
 * has workspace:null. Its ordinary workspace tools must follow the same rule. */
export function hasConversationWorkspace(scope: {
  sessionKind?: "conversation" | "subagent";
  toolCapabilities?: readonly string[];
}): boolean {
  return (
    scope.sessionKind !== "subagent" ||
    scope.toolCapabilities === undefined ||
    scope.toolCapabilities.length > 0
  );
}
const controlActions = Type.Union([
  Type.Object(
    {
      action: Type.Literal("list"),
      cursor: Type.Optional(
        Type.String({
          pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        }),
      ),
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
const SubagentControlSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("status"),
      Type.Literal("wait"),
      Type.Literal("cancel"),
      Type.Literal("send"),
    ]),
    target: Type.Optional(Type.String({ minLength: 1 })),
    cursor: Type.Optional(Type.String()),
    message: Type.Optional(Type.String({ minLength: 1 })),
    delivery: Type.Optional(
      Type.Union([Type.Literal("notify"), Type.Literal("steer"), Type.Literal("follow_up")]),
    ),
  },
  { additionalProperties: false },
);
export function prepareSubagentArguments(value: unknown): Static<typeof SubagentToolSchema> {
  if (!Value.Check(SubagentToolSchema, value)) throw new Error("Invalid delegation arguments");
  assertSubagentTaskInputBudget(value.task);
  return value;
}
export function prepareSubagentControlArguments(value: unknown): Static<typeof controlActions> {
  if (!Value.Check(controlActions, value)) throw new Error("Invalid Subagent control arguments");
  return value;
}
export function validateSubagentTask(value: SubagentTask): void {
  const { key, ...task } = value;
  if (typeof key !== "string" || !key) throw new Error("Invalid Subagent task key");
  prepareSubagentArguments(task);
}
export function validateSubagentControl(
  value: unknown,
): Exclude<Static<typeof controlActions>, { action: "list" }> {
  const request = prepareSubagentControlArguments(value);
  if (!("target" in request)) throw new Error("Expected a Subagent control request");
  return request;
}

export type ControlToolName =
  "subagent" | "subagent_control" | "contact_supervisor" | "subagent_supervisor";
export type InfrastructureToolDefinition = {
  name: ControlToolName | "workflow";
  description: string;
  parameters: TSchema;
  replay?: "safe" | "unsafe";
  prepareArguments?(value: unknown): unknown;
  availability?: "child" | "delegation" | "root";
  inheritedContext?(args: Record<string, unknown>): boolean;
  workflowScript?(args: Record<string, unknown>): string | undefined;
};
const subagent: InfrastructureToolDefinition = {
  name: "subagent",
  replay: "safe",
  parameters: SubagentToolSchema,
  prepareArguments: prepareSubagentArguments,
  availability: "delegation",
  inheritedContext: (args) => args.context === "branch",
  description: [
    "Delegate one concrete task to another Pi Agent and wait for its result or supervisor question.",
    "Recovery continues this same delegation; a new Tool call creates distinct work. Use subagent_control to list, inspect or message existing children.",
    "Task text is limited to 100,000 characters and 256 KiB of JSON. fresh uses the task only; branch inherits a frozen parent context.",
    "workspace only configures Linux working files and compute. Omit it to inherit existing workspace access; null disables all workspace-dependent tools. workspace.compute=shared reuses parent compute; ephemeral lazily creates temporary Linux compute on the same Volume without copying files.",
    "workspace.cwd must already exist. Use a Git worktree for independent code changes and coordinate shared-file edits. Do not commit or discard user changes without permission.",
    "workspace.tools is a nonempty subset of inherited read/write/edit/bash capabilities. Hosted tools and delegation remain independently configured. Children do not inherit phone/device control; this Tool never creates or allocates a second phone.",
    "Results are limited to 50 KiB UTF-8 or 2000 lines. Return a summary/path for larger output; a result-size error does not undo effects.",
  ].join(" "),
};
const subagentControl: InfrastructureToolDefinition = {
  name: "subagent_control",
  replay: "unsafe",
  parameters: SubagentControlSchema,
  prepareArguments: prepareSubagentControlArguments,
  description: [
    "Inspect and manage children of this physical Session. list needs no target and returns execution IDs, task summaries and state; follow nextCursor for more.",
    "Use an executionId from list or delegation as target for status/wait/send/cancel. list includes ended children in the current root work.",
    "send uses notify, steer or follow_up. notify does not wake an idle Agent; steer reaches active work; follow_up queues input.",
    "send may target main or parent. cancel stops current child work. Interrupted management is not automatically replayed; inspect state before repeating it.",
  ].join(" "),
};
const workflow: InfrastructureToolDefinition = {
  name: "workflow",
  replay: "unsafe",
  availability: "delegation",
  parameters: Type.Object(
    { script: Type.String({ minLength: 1, maxLength: MAX_TOOL_COMMAND_BYTES }) },
    { additionalProperties: false },
  ),
  workflowScript: (args) => String(args.script),
  description: [
    "Run a JavaScript orchestration script inside Cube. Return the selected value explicitly; console output is not the result.",
    "Use await runs.run(key,{task,context?,workspace?}) or runs.all([{key,task,...}]); replies contain executionId,state,output.",
    "runs.status(target), runs.wait(target), runs.cancel(target), runs.send(target,message,delivery), console and emit are available.",
    "A target is an executionId or a key within this script. Duplicate keys reuse one child during this invocation.",
    "Interrupted scripts are not automatically rerun. Use subagent_control to inspect existing children before deciding what to do next.",
    "Returned text is limited to 50 KiB UTF-8 or 2000 lines. Store larger output in Workspace and return a summary/path.",
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

/** Frozen code-owned catalogue; handlers never import the Pi Runner. */
export function infrastructureToolDefinitions(): readonly InfrastructureToolDefinition[] {
  return [
    subagent,
    subagentControl,
    workflow,
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
  ];
}
export function isControlToolName(value: unknown): value is ControlToolName {
  return ["subagent", "subagent_control", "contact_supervisor", "subagent_supervisor"].includes(
    String(value),
  );
}
