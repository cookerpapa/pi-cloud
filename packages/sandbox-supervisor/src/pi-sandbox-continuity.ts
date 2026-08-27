import { createHash } from "node:crypto";
import type {
  AgentMessage,
  CustomEntryContextMessageProjector,
  Session,
} from "@earendil-works/pi-agent-core";
import type { CloudStepWorldState } from "./cloud-context.ts";

export const PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE = "pi-cloud.runtime_world_state";
export const PI_SANDBOX_RESET_CUSTOM_TYPE = "pi-cloud.sandbox_reset";
export const PI_WORKSPACE_CHANGED_CUSTOM_TYPE = "pi-cloud.workspace_changed";
export const PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE = "pi-cloud.environment_changed";
export const PI_TOOL_POLICY_CHANGED_CUSTOM_TYPE = "pi-cloud.tool_policy_changed";

export const PI_SANDBOX_RESET_MESSAGE = [
  "<sandbox_reset>",
  "The previous sandbox is no longer available. The committed workspace is preserved, but running processes and in-memory environment state were not carried forward.",
  "</sandbox_reset>",
].join("\n");

export const PI_WORKSPACE_CHANGED_MESSAGE = [
  "<workspace_changed>",
  "The previous workspace is not available to the current tool environment. The current /workspace is a different workspace; files, dependencies, Git state, running processes and in-memory environment state from the previous workspace are not present here.",
  "</workspace_changed>",
].join("\n");

export const PI_ENVIRONMENT_CHANGED_MESSAGE = [
  "<environment_changed>",
  "The execution environment available to tools differs from the previous model step.",
  "</environment_changed>",
].join("\n");

export const PI_TOOL_POLICY_CHANGED_MESSAGE = [
  "<tool_policy_changed>",
  "The available tools or their network policy differ from the previous model step.",
  "</tool_policy_changed>",
].join("\n");

export type PiRuntimeWorldState = Readonly<{
  schemaVersion: 3;
  sandbox: Readonly<{
    status: "inactive" | "active" | "unavailable";
    continuityId: string | null;
  }>;
  environmentSha256: string;
  workspaceBindingSha256: string;
  committedWorkspaceRevision: string | null;
  toolPolicySha256: string;
}>;

export type PiSandboxContinuity = Readonly<{
  continuityId: string;
  continuity: "cold_restore" | "warm_reuse";
  environmentSha256: string;
  workspaceBindingSha256: string;
  committedWorkspaceRevision: string | null;
  toolPolicySha256: string;
}>;

export type PiWorldStateModelMessage = Readonly<{
  customType:
    | typeof PI_SANDBOX_RESET_CUSTOM_TYPE
    | typeof PI_WORKSPACE_CHANGED_CUSTOM_TYPE
    | typeof PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE
    | typeof PI_TOOL_POLICY_CHANGED_CUSTOM_TYPE;
  content: string;
  display: false;
  details: Readonly<{ schemaVersion: 1; changeSha256: string }>;
}>;

function sha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function runtimeWorldState(entry: {
  type: string;
  customType?: string;
  data?: unknown;
}): PiRuntimeWorldState | undefined {
  if (entry.type !== "custom" || entry.customType !== PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE) {
    return undefined;
  }
  const data = entry.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const candidate = data as Record<string, unknown>;
  const sandbox = candidate.sandbox;
  if (typeof sandbox !== "object" || sandbox === null || Array.isArray(sandbox)) return undefined;
  const sandboxCandidate = sandbox as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 3 ||
    (sandboxCandidate.status !== "inactive" &&
      sandboxCandidate.status !== "active" &&
      sandboxCandidate.status !== "unavailable") ||
    (sandboxCandidate.continuityId !== null && typeof sandboxCandidate.continuityId !== "string") ||
    !sha256(candidate.environmentSha256) ||
    !sha256(candidate.workspaceBindingSha256) ||
    (candidate.committedWorkspaceRevision !== null &&
      !sha256(candidate.committedWorkspaceRevision)) ||
    !sha256(candidate.toolPolicySha256)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 3,
    sandbox: {
      status: sandboxCandidate.status,
      continuityId: sandboxCandidate.continuityId,
    },
    environmentSha256: candidate.environmentSha256,
    workspaceBindingSha256: candidate.workspaceBindingSha256,
    committedWorkspaceRevision: candidate.committedWorkspaceRevision,
    toolPolicySha256: candidate.toolPolicySha256,
  };
}

function sameState(left: PiRuntimeWorldState, right: PiRuntimeWorldState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function modelMessage(
  customType: PiWorldStateModelMessage["customType"],
  previous: PiRuntimeWorldState,
  current: PiRuntimeWorldState,
): PiWorldStateModelMessage {
  const details = {
    schemaVersion: 1,
    changeSha256: createHash("sha256")
      .update(JSON.stringify({ customType, previous, current }), "utf8")
      .digest("hex"),
  } as const;
  if (customType === PI_SANDBOX_RESET_CUSTOM_TYPE) {
    return { customType, content: PI_SANDBOX_RESET_MESSAGE, display: false, details };
  }
  if (customType === PI_WORKSPACE_CHANGED_CUSTOM_TYPE) {
    return { customType, content: PI_WORKSPACE_CHANGED_MESSAGE, display: false, details };
  }
  if (customType === PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE) {
    return { customType, content: PI_ENVIRONMENT_CHANGED_MESSAGE, display: false, details };
  }
  return { customType, content: PI_TOOL_POLICY_CHANGED_MESSAGE, display: false, details };
}

function customWorldStateProjector(entry: {
  customType: string;
  data?: unknown;
  timestamp: number;
}): AgentMessage[] | undefined {
  if (
    entry.customType !== PI_SANDBOX_RESET_CUSTOM_TYPE &&
    entry.customType !== PI_WORKSPACE_CHANGED_CUSTOM_TYPE &&
    entry.customType !== PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE &&
    entry.customType !== PI_TOOL_POLICY_CHANGED_CUSTOM_TYPE
  ) {
    return undefined;
  }
  const data = entry.data;
  if (!isModelMessageData(data)) return undefined;
  return [
    {
      role: "custom",
      customType: entry.customType,
      content: data.content,
      display: false,
      details: data.details,
      timestamp: entry.timestamp,
    } as AgentMessage,
  ];
}

function isModelMessageData(
  value: unknown,
): value is Pick<PiWorldStateModelMessage, "content" | "details"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.content === "string" &&
    typeof candidate.details === "object" &&
    candidate.details !== null
  );
}

export const PI_WORLD_STATE_ENTRY_PROJECTORS: Readonly<
  Record<string, CustomEntryContextMessageProjector>
> = Object.freeze({
  [PI_SANDBOX_RESET_CUSTOM_TYPE]: customWorldStateProjector,
  [PI_WORKSPACE_CHANGED_CUSTOM_TYPE]: customWorldStateProjector,
  [PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE]: customWorldStateProjector,
  [PI_TOOL_POLICY_CHANGED_CUSTOM_TYPE]: customWorldStateProjector,
});

/** PostgreSQL SessionStorage variant used by the cloud-native Pi runtime. */
export class PiSessionWorldStateController {
  readonly #session: Session;
  readonly #continuity: PiSandboxContinuity;
  readonly #messagesAppendedDuringRun: PiWorldStateModelMessage[] = [];
  #status: PiRuntimeWorldState["sandbox"]["status"];
  #previous: PiRuntimeWorldState | undefined;

  private constructor(
    session: Session,
    continuity: PiSandboxContinuity,
    previous: PiRuntimeWorldState | undefined,
  ) {
    this.#session = session;
    this.#continuity = continuity;
    this.#status = continuity.continuity === "warm_reuse" ? "active" : "inactive";
    this.#previous = previous;
  }

  static async create(
    session: Session,
    continuity: PiSandboxContinuity,
  ): Promise<PiSessionWorldStateController> {
    const [latest] = await session.view("main").findEntriesOnBranch({
      type: "custom",
      customType: PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE,
      order: "newestFirst",
      limit: 1,
    });
    return new PiSessionWorldStateController(
      session,
      continuity,
      latest === undefined ? undefined : runtimeWorldState(latest),
    );
  }

  async capture(): Promise<
    Readonly<{
      worldState: CloudStepWorldState;
      modelMessages: readonly PiWorldStateModelMessage[];
    }>
  > {
    const state = await this.#reconcile();
    return {
      worldState: {
        sandbox: {
          status: state.sandbox.status,
          continuitySha256:
            state.sandbox.continuityId === null
              ? null
              : createHash("sha256").update(state.sandbox.continuityId, "utf8").digest("hex"),
        },
        environmentSha256: state.environmentSha256,
        workspaceBindingSha256: state.workspaceBindingSha256,
        committedWorkspaceRevision: state.committedWorkspaceRevision,
        toolPolicySha256: state.toolPolicySha256,
      },
      modelMessages: [...this.#messagesAppendedDuringRun],
    };
  }

  async recordActive(): Promise<void> {
    this.#status = "active";
    await this.#reconcile();
  }

  async recordUnavailable(): Promise<void> {
    this.#status = "unavailable";
    await this.#reconcile();
  }

  #current(): PiRuntimeWorldState {
    return {
      schemaVersion: 3,
      sandbox: {
        status: this.#status,
        continuityId: this.#status === "inactive" ? null : this.#continuity.continuityId,
      },
      environmentSha256: this.#continuity.environmentSha256,
      workspaceBindingSha256: this.#continuity.workspaceBindingSha256,
      committedWorkspaceRevision: this.#continuity.committedWorkspaceRevision,
      toolPolicySha256: this.#continuity.toolPolicySha256,
    };
  }

  async #reconcile(): Promise<PiRuntimeWorldState> {
    const current = this.#current();
    const previous = this.#previous;
    if (previous !== undefined && sameState(previous, current)) return current;

    const material: PiWorldStateModelMessage["customType"][] = [];
    const workspaceChanged =
      previous !== undefined && previous.workspaceBindingSha256 !== current.workspaceBindingSha256;
    if (
      !workspaceChanged &&
      previous?.sandbox.status === "active" &&
      (current.sandbox.status !== "active" ||
        previous.sandbox.continuityId !== current.sandbox.continuityId)
    ) {
      material.push(PI_SANDBOX_RESET_CUSTOM_TYPE);
    }
    if (workspaceChanged) material.push(PI_WORKSPACE_CHANGED_CUSTOM_TYPE);
    if (previous !== undefined && previous.environmentSha256 !== current.environmentSha256) {
      material.push(PI_ENVIRONMENT_CHANGED_CUSTOM_TYPE);
    }
    if (previous !== undefined && previous.toolPolicySha256 !== current.toolPolicySha256) {
      material.push(PI_TOOL_POLICY_CHANGED_CUSTOM_TYPE);
    }
    for (const customType of material) {
      const message = modelMessage(customType, previous!, current);
      await this.#session.appendCustomEntry(customType, {
        content: message.content,
        details: message.details,
      });
      this.#messagesAppendedDuringRun.push(message);
    }
    await this.#session.appendCustomEntry(PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE, current);
    this.#previous = current;
    return current;
  }
}
