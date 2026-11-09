import { createHash } from "node:crypto";
import { defineDoc, type Harness, type ConversationId } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SystemMessage } from "@earendil-works/pi-ai";
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
  "The conversation is now attached to a different workspace. The previous workspace is not available to the current tool environment. No files or processes were transferred by this change. Inspect the current working directory and its existing files, dependencies and Git state before continuing; do not assume the new workspace is empty or that previous paths still apply.",
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
  toolPolicySha256: string;
}>;

export type PiSandboxContinuity = Readonly<{
  writerId?: string;
  continuityId: string;
  continuity: "cold_restore" | "warm_reuse";
  environmentSha256: string;
  workspaceBindingSha256: string;
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

function runtimeWorldState(data: unknown): PiRuntimeWorldState | undefined {
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

const WorldState = defineDoc<{ state: JsonValue | null }>({
  kind: PI_RUNTIME_WORLD_STATE_CUSTOM_TYPE,
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "current",
  initial: () => ({ state: null }),
});
const EnvironmentRecovery = defineDoc<{
  pending: { runId: string; bindingId: string; code: string } | null;
}>({
  kind: "pi-cloud.environment_recovery",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ pending: null }),
});
const EnvironmentObservation = defineDoc<{
  observed: { runId: string; writerId: string; continuityId: string } | null;
}>({
  kind: "pi-cloud.environment_observation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ observed: null }),
});
export function worldStateMessage(message: PiWorldStateModelMessage): SystemMessage {
  return {
    role: "system",
    content: message.content,
    sections: { [`pi-cloud-change:${message.details.changeSha256}`]: "" },
    timestamp: Date.now(),
  };
}

/** PostgreSQL SessionStorage variant used by the cloud-native Pi runtime. */
export class PiSessionWorldStateController {
  readonly #session: Harness;
  readonly #conversationId: ConversationId;
  #continuity: PiSandboxContinuity;
  readonly #messagesAppendedDuringRun: PiWorldStateModelMessage[] = [];
  #status: PiRuntimeWorldState["sandbox"]["status"];
  #previous: PiRuntimeWorldState | undefined;
  #localRecovery: { runId: string; bindingId: string; code: string } | undefined;
  #recoveryRevision = 0;

  private constructor(
    session: Harness,
    conversationId: number,
    continuity: PiSandboxContinuity,
    previous: PiRuntimeWorldState | undefined,
  ) {
    this.#session = session;
    this.#conversationId = conversationId as ConversationId;
    this.#continuity = continuity;
    this.#status = continuity.continuity === "warm_reuse" ? "active" : "inactive";
    this.#previous = previous;
  }

  static async create(
    session: Harness,
    conversationId: number,
    continuity: PiSandboxContinuity,
  ): Promise<PiSessionWorldStateController> {
    const state = await session.snapshot(
      WorldState,
      conversationId as ConversationId,
      BACKGROUND_CONTEXT,
    );
    return new PiSessionWorldStateController(
      session,
      conversationId,
      continuity,
      runtimeWorldState(state?.state),
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
        toolPolicySha256: state.toolPolicySha256,
      },
      modelMessages: [...this.#messagesAppendedDuringRun],
    };
  }

  async recordActive(
    continuity?: Pick<PiSandboxContinuity, "continuityId" | "continuity">,
  ): Promise<void> {
    if (continuity !== undefined) this.#continuity = { ...this.#continuity, ...continuity };
    this.#status = "active";
    // Observe now; capture publishes model-visible changes at the next clean
    // sampling/settlement boundary, never inside a Tool call/result pair.
  }

  async recordUnavailable(): Promise<void> {
    this.#status = "unavailable";
  }

  async requireRecovery(runId: string, bindingId: string, code: string): Promise<void> {
    this.#localRecovery = { runId, bindingId, code };
    this.#recoveryRevision++;
    this.#status = "unavailable";
    await this.#session.commit(async (tx) => {
      const value = await tx.doc(EnvironmentRecovery, this.#conversationId);
      if (JSON.stringify(value.pending) !== JSON.stringify({ runId, bindingId, code }))
        value.pending = { runId, bindingId, code };
    }, BACKGROUND_CONTEXT);
  }

  async pendingRecovery(runId: string) {
    const value = await this.#session.snapshot(
      EnvironmentRecovery,
      this.#conversationId,
      BACKGROUND_CONTEXT,
    );
    const observed = (
      await this.#session.snapshot(EnvironmentObservation, this.#conversationId, BACKGROUND_CONTEXT)
    )?.observed;
    const pending = this.#localRecovery?.runId === runId ? this.#localRecovery : value?.pending;
    if (pending?.runId === runId)
      return {
        ...pending,
        revision: this.#recoveryRevision,
        previousContinuityId: observed?.runId === runId ? observed.continuityId : undefined,
      };
    if (observed?.runId === runId && observed.writerId !== this.#continuity.writerId)
      return {
        runId,
        bindingId: "",
        code: "worker_replaced",
        revision: this.#recoveryRevision,
        previousContinuityId: observed.continuityId,
      };
    return undefined;
  }

  /** Before returning a physical Tool result, retain its environment identity.
   * This current-only document adds no model message and no stream history. */
  async recordExecution(
    runId: string,
    evidence: { continuityId?: string },
    writerId = this.#continuity.writerId,
  ): Promise<void> {
    if (!evidence.continuityId || !writerId) return;
    const observed = { runId, writerId, continuityId: evidence.continuityId };
    await this.#session.commit(async (tx) => {
      const value = await tx.doc(EnvironmentObservation, this.#conversationId);
      if (JSON.stringify(value.observed) !== JSON.stringify(observed)) value.observed = observed;
    }, BACKGROUND_CONTEXT);
  }

  async completeRecovery(
    runId: string,
    evidence: Pick<PiSandboxContinuity, "continuityId" | "continuity">,
    previousContinuityId?: string,
    revision = this.#recoveryRevision,
  ): Promise<void> {
    this.#assertRecoveryRevision(revision);
    await this.recordActive(evidence);
    await this.#reconcile(runId, previousContinuityId, revision);
    this.#assertRecoveryRevision(revision);
    this.#localRecovery = undefined;
  }
  #assertRecoveryRevision(revision: number): void {
    if (revision !== this.#recoveryRevision)
      throw Object.assign(new Error("Environment changed during readiness confirmation"), {
        code: "tool_environment_pending",
        retryable: true,
      });
  }

  #current(): PiRuntimeWorldState {
    return {
      schemaVersion: 3,
      sandbox: {
        status: this.#status,
        continuityId:
          this.#status === "inactive"
            ? (this.#previous?.sandbox.continuityId ?? null)
            : this.#continuity.continuityId,
      },
      environmentSha256: this.#continuity.environmentSha256,
      workspaceBindingSha256: this.#continuity.workspaceBindingSha256,
      toolPolicySha256: this.#continuity.toolPolicySha256,
    };
  }

  async #reconcile(
    recoveredRunId?: string,
    previousContinuityId?: string,
    recoveryRevision?: number,
  ): Promise<PiRuntimeWorldState> {
    const current = this.#current();
    const previous =
      previousContinuityId && !this.#previous?.sandbox.continuityId
        ? {
            ...(this.#previous ?? current),
            sandbox: { status: "active" as const, continuityId: previousContinuityId },
          }
        : this.#previous;
    if (!recoveredRunId && previous !== undefined && sameState(previous, current)) return current;

    const material: PiWorldStateModelMessage["customType"][] = [];
    const workspaceChanged =
      previous !== undefined && previous.workspaceBindingSha256 !== current.workspaceBindingSha256;
    if (
      !workspaceChanged &&
      previous?.sandbox.continuityId != null &&
      current.sandbox.status === "active" &&
      previous.sandbox.continuityId !== current.sandbox.continuityId
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
    const messages = material.map((customType) => modelMessage(customType, previous!, current));
    await this.#session.commit(async (tx) => {
      if (recoveryRevision !== undefined) this.#assertRecoveryRevision(recoveryRevision);
      for (const message of messages)
        await tx.appendEntry(this.#conversationId, {
          kind: message.customType,
          model: [worldStateMessage(message)],
          data: { ...message.details },
        });
      (await tx.doc(WorldState, this.#conversationId)).state = JSON.parse(
        JSON.stringify(current),
      ) as JsonValue;
      if (recoveredRunId) {
        const recovery = await tx.doc(EnvironmentRecovery, this.#conversationId);
        if (recovery.pending?.runId === recoveredRunId) recovery.pending = null;
        (await tx.doc(EnvironmentObservation, this.#conversationId)).observed = {
          runId: recoveredRunId,
          writerId: this.#continuity.writerId!,
          continuityId: current.sandbox.continuityId!,
        };
      }
      if (recoveryRevision !== undefined) this.#assertRecoveryRevision(recoveryRevision);
    }, BACKGROUND_CONTEXT);
    this.#messagesAppendedDuringRun.push(...messages);
    this.#previous = current;
    return current;
  }
}
