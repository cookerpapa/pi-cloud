import type { PiCommittedItem } from "@pi-cloud/pi-session-postgres";
import type { EventPublishMessage, PiCloudEvent, PiCloudEventBody } from "@pi-cloud/protocol";
import type {
  AcceptedToolCommand,
  CandidateToolCommand,
  ToolCommandPublisher,
  CandidateSubagentCommand,
  SubagentCommandPublisher,
  SubagentControlRequest,
} from "@pi-cloud/protocol";

export type CandidatePiSessionAppendFact = Readonly<{
  schemaVersion: 1;
  mutationId: string;
  scope: Readonly<{
    tenantId: string;
    sessionId: string;
    piSessionId: string;
    piSessionLane: string;
    writerId: string;
    turnId: string;
    runId: string;
    executionReference: string;
  }>;
  items: readonly PiCommittedItem[];
  events: readonly PiCloudEvent[];
  occurredAt: string;
}>;

export type CandidateFact =
  | Readonly<{ kind: "tool_command"; command: CandidateToolCommand }>
  | Readonly<{ kind: "subagent_command"; command: CandidateSubagentCommand }>
  | Readonly<{ kind: "agent_event"; publication: EventPublishMessage }>
  | Readonly<{ kind: "pi_session_append"; mutation: CandidatePiSessionAppendFact }>;

export type AcceptedFactScope = Readonly<{
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  attemptId: string;
  fencingToken: number;
  piSessionId: string;
  writerId: string;
}>;

export type AcceptedAgentEventFact = Readonly<{
  kind: "agent_event";
  factId: string;
  scope: AcceptedFactScope;
  event: PiCloudEvent;
  occurredAt: string;
}>;

export type AcceptedExecutionSealFact = Readonly<{
  kind: "execution_seal";
  factId: string;
  scope: AcceptedFactScope;
  agentId: string;
  baseSequence: number;
  closesWriter: boolean;
  terminal: Extract<
    PiCloudEventBody,
    { type: "turn.completed" | "turn.failed" | "turn.cancelled" }
  >;
  occurredAt: string;
}>;

export type AcceptedPiSessionAppendFact = Readonly<{
  kind: "pi_session_append";
  factId: string;
  scope: AcceptedFactScope;
  piSession: Readonly<{ id: string; lane: string; writerId: string }>;
  items: readonly PiCommittedItem[];
  events: readonly PiCloudEvent[];
  occurredAt: string;
}>;

export type ExecutionPublication = Readonly<{
  scope: AcceptedFactScope & { leaseId: string; piSessionLane: string };
}>;
export type AcceptedFact =
  | AcceptedToolCommand
  | AcceptedAgentEventFact
  | AcceptedExecutionSealFact
  | AcceptedPiSessionAppendFact
  | AcceptedSubagentCommand;

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

export class AcceptedFactCapacityError extends Error {
  readonly code = "event_capacity_exhausted";
  readonly retryable = true;
  constructor() {
    super("AcceptedFact transport is at capacity; the Fact was not enqueued");
  }
}

export class AcceptedFactPublisherFailedError extends Error {
  readonly code = "event_publisher_failed";
  readonly retryable = false;
  constructor(cause: Error) {
    super("AcceptedFact publisher cannot be reused", { cause });
    this.name = "AcceptedFactPublisherFailedError";
  }
}

export interface AcceptedFactBus {
  append(fact: AcceptedFact): Promise<AcceptedFactReceipt>;
  checkHealth(): Promise<void>;
}

export interface PiSessionLogAppender {
  mutate(
    mutation: CandidatePiSessionAppendFact,
  ): Promise<Readonly<{ mutationId: string; accepted: true }>>;
}

export interface ActiveExecutionLogResolver {
  resolve(executionReference: string): AcceptedFactWriter | undefined;
  checkHealth(): Promise<void>;
}

export interface AcceptedFactWriter
  extends PiSessionLogAppender, ToolCommandPublisher, SubagentCommandPublisher {}
