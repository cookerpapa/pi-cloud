import { PublicationNotSentError } from "@pi-cloud/protocol";
import type { EventPublishMessage, PiCloudEvent, PiCloudEventBody } from "@pi-cloud/protocol";
import type { DurableSessionCommit, DurableRecordOrigin } from "@pi-cloud/protocol";
import type { AcceptedToolCommand, ToolSandboxOperationRequest } from "@pi-cloud/protocol";

export type CandidateFact =
  | Readonly<{ kind: "durable_commit"; fact: AcceptedDurableCommitFact }>
  | Omit<import("@pi-cloud/protocol").PathProbe, "scope">
  | Readonly<{ kind: "agent_event"; publication: EventPublishMessage }>;

export type AcceptedFactScope = Readonly<{
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  fencingToken: number;
  piSessionId: string;
  writerId: string;
}>;

export type AcceptedAgentEventFact = Readonly<{
  kind: "agent_event";
  factId: string;
  scope: AcceptedFactScope;
  event: PiCloudEvent;
  nativeSequence?: number;
  occurredAt: string;
}>;
export type WorkTerminal = Extract<
  PiCloudEventBody,
  { type: "turn.completed" | "turn.failed" | "turn.cancelled" }
>;
/** The native family is idle and all publication handles have drained. This
 * ordinary writer record does not require a PG -> Outbox -> Kafka round trip. */
export type AcceptedWorkFinishedFact = Readonly<{
  kind: "work_finished";
  factId: string;
  scope: AcceptedFactScope;
  agentId: string;
  baseSequence: number;
  nativeSequence: number;
  terminal: WorkTerminal;
  occurredAt: string;
}>;

export type AcceptedDurableCommitFact = Readonly<{
  kind: "durable_commit";
  factId: string;
  scope: AcceptedFactScope;
  commit: DurableSessionCommit;
  origins: readonly DurableRecordOrigin[];
  inputQueueSessions?: readonly string[];
  tools: readonly DurableToolDispatch[];
  cancellations: readonly import("@pi-cloud/protocol").AcceptedToolCancellation[];
  display: readonly Readonly<{
    scope: AcceptedFactScope;
    events: readonly import("@pi-cloud/protocol").DurableDisplayDescription[];
    coveredThrough?: number;
  }>[];
  occurredAt: string;
}>;

export type AcceptedExecutionSealFact = Readonly<{
  kind: "execution_seal";
  factId: string;
  scope: AcceptedFactScope;
  agentId: string;
  baseSequence: number;
  occurredAt: string;
}> &
  (
    | { recover: true; terminal?: never }
    | {
        recover?: false;
        terminal: Extract<
          PiCloudEventBody,
          { type: "turn.completed" | "turn.failed" | "turn.cancelled" }
        >;
      }
  );

export type DurableCubeToolDispatch = Omit<
  AcceptedToolCommand,
  "kind" | "request" | "toolCallId"
> & {
  target: "cube";
  taskId: number;
  request:
    | Omit<
        Extract<ToolSandboxOperationRequest, { operation: "tool.execute" }>,
        "args" | "toolCallId"
      >
    | Omit<
        Extract<ToolSandboxOperationRequest, { operation: "workflow.exec" }>,
        "script" | "toolCallId"
      >;
};
export type DurableControlToolDispatch = import("@pi-cloud/protocol").ControlToolDispatch & {
  scope: AcceptedFactScope;
};
export type DurableToolDispatch = DurableCubeToolDispatch | DurableControlToolDispatch;

export type AcceptedControlToolCommand = DurableControlToolDispatch & {
  kind: "control_tool";
  nativeCallId: string;
  arguments: Record<string, unknown>;
  nativeSequence: number;
};

export type ExecutionPublication = Readonly<{
  scope: AcceptedFactScope & { leaseId: string; piConversationId: number };
}>;
export type AcceptedFact =
  | AcceptedDurableCommitFact
  | import("@pi-cloud/protocol").PathProbe
  | AcceptedAgentEventFact
  | AcceptedWorkFinishedFact
  | AcceptedExecutionSealFact;

/** Session control references share transport/order, but never native history. */
export type SessionLogFact = AcceptedFact | import("@pi-cloud/protocol").SessionControlChange;

export type AcceptedFactReceipt = Readonly<{
  factId: string;
  durable: true;
}>;

export class AcceptedFactCapacityError extends PublicationNotSentError {
  readonly code = "event_capacity_exhausted";
  readonly retryable = true;
  constructor() {
    super("AcceptedFact transport is at capacity; the Fact was not enqueued");
  }
}

export interface AcceptedFactBus {
  publicationFailure?(scope: AcceptedFactScope): unknown;
  publicationAvailability?(): Promise<import("@pi-cloud/protocol").PublicationAvailability>;
  open?(publication: ExecutionPublication, signal?: AbortSignal): Promise<void>;
  forget?(scope: AcceptedFactScope): void | Promise<void>;
  append(fact: AcceptedFact): Promise<AcceptedFactReceipt>;
  checkHealth(): Promise<void>;
}

export interface ActiveExecutionLogResolver {
  resolve(executionReference: string, conversationId?: number): AcceptedFactWriter | undefined;
  checkHealth(): Promise<void>;
}

export interface AcceptedFactWriter {
  readonly publication: ExecutionPublication;
  commitNative(fact: AcceptedDurableCommitFact): Promise<void>;
}
