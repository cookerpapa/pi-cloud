import { PublicationNotSentError } from "@pi-cloud/protocol";
import type { EventPublishMessage, PiCloudEvent, PiCloudEventBody } from "@pi-cloud/protocol";
import type { DurableSessionCommit, DurableRecordOrigin } from "@pi-cloud/protocol";
import type {
  AcceptedToolCommand,
  CandidateToolCommand,
  ToolCommandPublisher,
  CandidateSubagentCommand,
  SubagentCommandPublisher,
  SubagentControlRequest,
  ToolSandboxOperationRequest,
  ToolCancellationPublisher,
} from "@pi-cloud/protocol";

export type CandidateFact =
  | Readonly<{ kind: "durable_commit"; fact: AcceptedDurableCommitFact }>
  | Readonly<{
      kind: "tool_cancel";
      command: import("@pi-cloud/protocol").CandidateToolCancellation;
    }>
  | Omit<import("@pi-cloud/protocol").PathProbe, "scope">
  | Readonly<{ kind: "tool_command"; command: CandidateToolCommand }>
  | Readonly<{ kind: "subagent_command"; command: CandidateSubagentCommand }>
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
    texts: readonly import("@pi-cloud/protocol").DurableTextDescription[];
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
  closesWriter: boolean;
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

export type DurableToolDispatch = Omit<AcceptedToolCommand, "kind" | "request"> & {
  taskId: number;
  request: Omit<
    Extract<ToolSandboxOperationRequest, { operation: "tool.execute" }>,
    "args" | "toolCallId"
  >;
};

export type ExecutionPublication = Readonly<{
  scope: AcceptedFactScope & { leaseId: string; piConversationId: number };
}>;
export type AcceptedFact =
  | AcceptedDurableCommitFact
  | import("@pi-cloud/protocol").AcceptedToolCancellation
  | import("@pi-cloud/protocol").PathProbe
  | AcceptedToolCommand
  | AcceptedAgentEventFact
  | AcceptedExecutionSealFact
  | AcceptedSubagentCommand;

/** Session control references share transport/order, but never native history. */
export type SessionLogFact = AcceptedFact | import("@pi-cloud/protocol").SessionControlChange;

export type AcceptedSubagentCommand = Readonly<{
  kind: "subagent_command";
  factId: string;
  scope: AcceptedFactScope;
  executionReference: string;
  toolCallId: string;
  workflowId: string;
  request: SubagentControlRequest;
  occurredAt: string;
}>;

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
  publicationAvailability?(): Promise<import("@pi-cloud/protocol").PublicationAvailability>;
  open?(publication: ExecutionPublication, signal?: AbortSignal): Promise<void>;
  forget?(runId: string): void;
  append(fact: AcceptedFact): Promise<AcceptedFactReceipt>;
  checkHealth(): Promise<void>;
}

export interface ActiveExecutionLogResolver {
  resolve(executionReference: string): AcceptedFactWriter | undefined;
  checkHealth(): Promise<void>;
}

export interface AcceptedFactWriter
  extends ToolCommandPublisher, SubagentCommandPublisher, ToolCancellationPublisher {
  readonly publication: ExecutionPublication;
  commitNative(fact: AcceptedDurableCommitFact): Promise<void>;
}
